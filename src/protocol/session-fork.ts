/**
 * `session/fork` —— 以一条会话的上下文为起点，另开一支。
 *
 * 与 `session/load` / `session/resume` 的关键差别是**它造的是一条新会话**：
 * 那两个让同一条会话活过来，此后写的事件追加进同一条日志；fork 之后两边各写
 * 各的，父会话不会因为子会话继续对话而改变。规范给的用例是「基于已有上下文
 * 做点什么（比如生成摘要）而不弄脏原来那条历史」。
 *
 * 因此这里**不复用** `restoreSession`：那个函数从头到尾都建立在「会话 id 是
 * 客户端给的、日志已经存在」之上，而 fork 的子会话 id 是本端现铸的、日志还不
 * 存在。共用只会让两条语义相反的路径互相牵制。
 * @module
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ForkSessionRequest, ForkSessionResponse } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams, internalError, resourceNotFound } from '../codec/errors.js'
import { modeStateFor } from '../config/modes.js'
import { ToolPresenter } from '../presentation/presenter.js'
import { sameWorkspace } from '../session/workspace-path.js'
import { mountSpecs } from './mcp-params.js'
import { commandsUpdate } from './session-commands.js'
import { optionsFor } from './session-config.js'
import { rethrowMissingSession } from './session-missing.js'

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 子会话 id，以及与 `session/new` 同构的模式与配置项
 */
export async function handleForkSession(
  bridge: Bridge,
  params: ForkSessionRequest,
): Promise<ForkSessionResponse> {
  bridge.assertOpen()
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }

  const parentSessionId = params.sessionId as SessionId
  const parent = bridge.table.get(parentSessionId)
  // 父会话不在本连接里就必须能从日志里读到——否则种子无从取起。没挂持久化的
  // 组合里这等于「只能 fork 开着的会话」，那也是那种部署唯一说得通的语义。
  if (parent === undefined && bridge.port.catalog === undefined) {
    throw resourceNotFound(
      parentSessionId,
      'not open in this connection, and no session-persistence backend is composed — only open sessions can be forked here',
    )
  }
  // 回合进行中就拒绝，而不是把那半截回合裁掉。裁掉是**静默丢数据**：用户刚发出
  // 去的那句话与正在生成的回答都不会进子会话，而他看到的是一条「fork 成功」。
  // 等一下就好，所以这里说清楚等什么。
  if (parent?.inflight !== undefined) {
    throw invalidParams(
      `session ${parentSessionId} has a prompt in flight; wait for the turn to finish before forking`,
    )
  }

  const sessionId = SessionId(randomUUID())
  // seq 在翻译 MCP 之前分配，与 `session/new` 同理：前缀是会话内恒定的隔离标识。
  const seq = bridge.table.nextSeq()
  // 种子取自父会话，因此「父会话不在了」是这条路径最常见的失败——它埋在 port 的
  // `persistence.inspect` 里，与日志损坏抛的是同一种裸 `Error`，就地分诊开来。
  const handle = await bridge.port.sessions
    .fork({
      parentSessionId,
      sessionId,
      ...(bridge.config.provider !== undefined ? { provider: bridge.config.provider } : {}),
      ...(bridge.config.model !== undefined ? { model: bridge.config.model } : {}),
      mcpServers: mountSpecs(params.mcpServers ?? [], seq),
      // 读改道绑的是**子**会话 id：编辑器发来的 `fs/read_text_file` 带的是它正在
      // 交互的那条会话，而那条从现在起是子会话。
      ...(() => {
        const readDelegate = bridge.readDelegate(sessionId)
        return readDelegate === undefined ? {} : { readDelegate }
      })(),
    })
    .catch(async (error: unknown) => await rethrowMissingSession(bridge, parentSessionId, error))

  const settled = async (error: Error): Promise<never> => {
    await handle.dispose()
    throw error
  }

  // 工作区不是入参而是**继承来的**：种子里全是父会话工作区里的路径，把它搬进
  // 另一个工作区，模型会拿着 A 项目的文件路径去改 B 项目的文件。`session/load`
  // 拒绝 cwd 漂移是同一个理由，这里更硬——那边至少还是同一条会话。
  if (handle.cwd !== undefined && !(await sameWorkspace(handle.cwd, params.cwd))) {
    return await settled(
      invalidParams(
        `cwd mismatch: session ${parentSessionId} was created in ${handle.cwd}, request asked for ${params.cwd}`,
      ),
    )
  }
  if (bridge.table.closed) {
    return await settled(internalError('connection closed during session/fork'))
  }

  const cwd = handle.cwd ?? params.cwd
  const presenter = new ToolPresenter(bridge.port.tools, bridge.warn, handle.agent)
  const record = { acpSessionId: sessionId, seq, handle, cwd, presenter, inflight: undefined }
  bridge.table.add(record)

  // 与 `session/new` 一样延后到应答之后：子会话 id 是这次应答**首次**告知客户端
  // 的，先发更新的话它收到的是一个还不认识的会话。
  const commands = await commandsUpdate(bridge, record)
  if (commands !== undefined) bridge.notifyAfterResponse(sessionId, commands)

  // 沙箱模式与 plan 状态是从种子里折出来的，因此这里读到的是**父会话当时的**
  // 状态。fork 一个放宽过权限的会话，子会话继承那个放宽——历史继承了，据以产生
  // 历史的状态却重置回部署默认，才是真正让人意外的那种。
  const options = await optionsFor(bridge, record)
  const modes = modeStateFor(bridge.port.modes, handle.agent)
  return {
    sessionId,
    ...(options.length > 0 ? { configOptions: options } : {}),
    ...(modes === undefined ? {} : { modes }),
  }
}
