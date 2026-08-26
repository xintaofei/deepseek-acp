/**
 * `session/load` —— 恢复一个已持久化的会话并重放历史（US-14）。
 *
 * 重放走的是与实时事件**完全相同**的 `mapEvent`：恢复出来的对话必须和当初
 * 那次逐字一致。另起一套「历史渲染」是两份实现，会以肉眼难察的方式漂移
 * （少一张工具卡片、思考块混进正文）。
 * @module
 */

import { isAbsolute } from 'node:path'
import type { LoadSessionRequest, LoadSessionResponse, SessionUpdate } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams, internalError, methodNotFound } from '../codec/errors.js'
import { modeStateFor } from '../config/modes.js'
import { mapEvent } from '../mapping/updates.js'
import { ToolPresenter } from '../presentation/presenter.js'
import type { SessionRecord } from '../session/table.js'
import { sameWorkspace } from '../session/workspace-path.js'
import { mountSpecs } from './mcp-params.js'
import { commandsUpdate } from './session-commands.js'
import { optionsFor } from './session-config.js'
import { rethrowMissingSession } from './session-missing.js'

/**
 * 校验恢复请求。
 *
 * 与 `session/new` 同样的 cwd / MCP 约束，另加一条：请求里的 `cwd` 必须与
 * 日志里记着的一致。工作区是不可变会话元数据，允许它变意味着可以把 A 项目
 * 的历史恢复进 B 项目的工作区——模型会拿着 A 的文件路径去改 B 的文件。
 */
export function validateRestore(params: RestoreParams): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** `session/load` 与 `session/resume` 共用的请求形状。 */
export interface RestoreParams {
  readonly sessionId: string
  readonly cwd: string
  readonly additionalDirectories?: readonly string[] | undefined
  readonly mcpServers?: LoadSessionRequest['mcpServers']
}

/**
 * 把一个已持久化的会话恢复成活的运行时记录。
 *
 * 这是 `session/load` 与 `session/resume` **唯一**的差别之外的全部：两者都要
 * 建 agent、校验 cwd、登记会话，只有「要不要把历史流回客户端」不同。写成两份
 * 的话，cwd 校验或 seq 分配这类东西迟早只改一边。
 * @param bridge - 运行时
 * @param params - 已校验的请求
 * @param method - 出错信息里用的方法名
 * @returns 已登记进会话表的记录
 */
export async function restoreSession(
  bridge: Bridge,
  params: RestoreParams,
  method: string,
): Promise<SessionRecord> {
  const sessionId = params.sessionId as SessionId
  // seq 在恢复之前分配：MCP 前缀是**连接内**的隔离标识，与会话原先那次是哪个
  // 序号无关——同一个会话在新连接里恢复，拿到的是新连接内的序号。
  const seq = bridge.table.nextSeq()
  // `session/load` 的 `mcpServers` 是必填，`session/resume` 的是可选——缺席等同
  // 于「这次不挂任何 server」，而不是「沿用上次」：MCP 挂载是连接内的，上一条
  // 连接挂过什么，这条连接无从得知。
  const specs = mountSpecs(params.mcpServers ?? [], seq)

  const handle = await bridge.port.sessions.resume({
    sessionId,
    ...(bridge.config.provider !== undefined ? { provider: bridge.config.provider } : {}),
    ...(bridge.config.model !== undefined ? { model: bridge.config.model } : {}),
    mcpServers: specs,
    // 恢复出来的会话与新建的一样要能看见未保存的缓冲区；`session/load` 与
    // `session/resume` 共用这一段，两条路径不会分叉。
    ...(() => {
      const readDelegate = bridge.readDelegate(sessionId)
      return readDelegate === undefined ? {} : { readDelegate }
    })(),
  })

  const settled = async (error: Error): Promise<never> => {
    await handle.dispose()
    throw error
  }

  // 比的是**目录**不是字符串：同一个工作区可以有多种拼写（Windows 8.3 短名、
  // macOS 的 `/var` → `/private/var`），裸相等会让用户加载不了自己的会话。
  // 反向的错更贵，所以 `sameWorkspace` 拿不准时判「不同」。
  if (handle.cwd !== undefined && !(await sameWorkspace(handle.cwd, params.cwd))) {
    return await settled(
      invalidParams(
        `cwd mismatch: session ${sessionId} was created in ${handle.cwd}, request asked for ${params.cwd}`,
      ),
    )
  }
  // 创建与连接关闭可能竞争：期间已关闭就必须释放这个尚未发布的句柄。
  if (bridge.table.closed) {
    return await settled(internalError(`connection closed during ${method}`))
  }

  const cwd = handle.cwd ?? params.cwd
  const presenter = new ToolPresenter(bridge.port.tools, bridge.warn, handle.agent)
  const record: SessionRecord = {
    acpSessionId: sessionId,
    seq,
    handle,
    cwd,
    presenter,
    inflight: undefined,
  }
  bridge.table.add(record)
  return record
}

/**
 * 把一整条事件日志翻成 ACP 更新。
 *
 * 呈现器是新建的、按会话持有的，重放期间恰好按 `tool/call` → `tool/result`
 * 的原始顺序被喂一遍，因此工具卡片的关联在恢复后依然成立。
 * @param events - 日志事件，按 seq 升序
 * @param context - 与实时路径同源的映射上下文
 * @returns 待发送的更新序列
 */
export function replayUpdates(
  events: readonly Parameters<typeof mapEvent>[0][],
  context: Parameters<typeof mapEvent>[1],
): SessionUpdate[] {
  return events.flatMap((event) => mapEvent(event, context))
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 空应答（模式与配置项在 M1-c）
 */
export async function handleLoadSession(
  bridge: Bridge,
  params: LoadSessionRequest,
): Promise<LoadSessionResponse> {
  bridge.assertOpen()
  const catalog = bridge.port.catalog
  if (catalog === undefined) {
    // 组合没挂持久化。理论上不该走到这里（`initialize` 不会 advertise
    // `loadSession`），但客户端可以无视能力声明直接调。
    throw methodNotFound('session/load requires a session-persistence backend')
  }
  validateRestore(params)

  const sessionId = params.sessionId as SessionId
  // 先取历史再恢复：日志读不出来（不存在 / 损坏）时不该留下一个已发布的 agent。
  // 而「不存在」与「损坏」对客户端是两件事，就地分开——见 rethrowMissingSession。
  const events = await catalog
    .events(sessionId)
    .catch(async (error: unknown) => await rethrowMissingSession(bridge, sessionId, error))
  const record = await restoreSession(bridge, params, 'session/load')
  const { presenter, cwd } = record

  const replay = replayUpdates(events, {
    presenter,
    terminal: { enabled: bridge.terminalOutput, cwd },
    replay: true,
    // 恢复的会话同样要显示上下文占用——而且比新会话更需要：一个接着聊的旧会话
    // 正是最可能接近窗口上限的那种。重放会依次产出历史上每一步的用量，客户端
    // 取到的最后一条就是当前占用。
    contextWindow: record.handle.controls.contextWindow,
    // 压缩过的会话在重放时要把那几段也标出来，否则转录里会凭空少掉一大截历史
    // ——被压掉的那些消息不在日志的表面上了，而替换它们的摘要没有 `compaction_*`
    // 更新就只是一条普通的用户消息。
    compaction: bridge.compaction,
  })
  // 命令快照跟在历史后面一起发。这里不需要 `session/new` 那套延后：会话 id 是
  // **客户端自己给的**，它早就认识这个会话。
  const commands = await commandsUpdate(bridge, record)
  await bridge.notifyAwaited(sessionId, commands === undefined ? replay : [...replay, commands])

  // 沙箱模式与 plan 状态都写在会话日志里，因此这里读到的是**恢复出来的**那个
  // 状态，而不是部署默认——恢复一个当初放宽过权限的会话，控件要如实显示放宽
  // 后的状态。
  const options = await optionsFor(bridge, record)
  const modes = modeStateFor(bridge.port.modes, record.handle.agent)
  return {
    ...(options.length > 0 ? { configOptions: options } : {}),
    ...(modes === undefined ? {} : { modes }),
  }
}
