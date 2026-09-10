/**
 * `session/new` —— 创建一个全新会话。
 * @module
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { NewSessionRequest, NewSessionResponse } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams, internalError } from '../codec/errors.js'
import { modeStateFor } from '../config/modes.js'
import { AssistantStreamRelay } from '../mapping/assistant-stream.js'
import { ToolPresenter } from '../presentation/presenter.js'
import { mountSpecs } from './mcp-params.js'
import { commandsUpdate } from './session-commands.js'
import { optionsFor } from './session-config.js'

/**
 * 校验 M1-a 契约之外的会话特性。
 *
 * `cwd` 是会话工作区，同时是 sandbox / shell / fs 的解析根，因此必须是绝对
 * 路径——相对路径会静默跑在启动目录下。
 */
function validate(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 新会话 id
 */
export async function handleNewSession(
  bridge: Bridge,
  params: NewSessionRequest,
): Promise<NewSessionResponse> {
  bridge.assertOpen()
  validate(params)

  const sessionId = SessionId(randomUUID())
  // seq 在翻译 MCP 之前分配：前缀是会话内恒定的隔离标识（详设 §一 C4）。
  const seq = bridge.table.nextSeq()
  const handle = await bridge.port.sessions.create({
    sessionId,
    cwd: params.cwd,
    ...(bridge.config.provider !== undefined ? { provider: bridge.config.provider } : {}),
    ...(bridge.config.model !== undefined ? { model: bridge.config.model } : {}),
    mcpServers: mountSpecs(params.mcpServers, seq),
    // 委托在建会话时定下并绑死这个 id：`fs/read_text_file` 的入参带 sessionId，
    // 而会话作用域的 fs 是在 setup 里装的，之后没有再改的机会。
    ...(() => {
      const readDelegate = bridge.readDelegate(sessionId)
      return readDelegate === undefined ? {} : { readDelegate }
    })(),
  })

  // 创建与连接关闭可能竞争：若期间已关闭，必须释放这个尚未发布的句柄，
  // 否则留下孤儿 agent（详设 §6.1）。
  if (bridge.table.closed) {
    await handle.dispose()
    throw internalError('connection closed during session/new')
  }

  // 呈现器带上 agent 的 scope：工具是按作用域注册的，用全局视图去解析会漏掉
  // 只在该 agent 内可见的工具（约束 C2 的同源陷阱——错的 scope 不报错，只返回空）。
  const presenter = new ToolPresenter(bridge.port.tools, bridge.warn, handle.agent)
  const stream = new AssistantStreamRelay()
  const record = { acpSessionId: sessionId, seq, handle, cwd: params.cwd, presenter, stream, inflight: undefined }
  bridge.table.add(record)

  // 命令目录只能经 `available_commands_update` 给出（应答里没有这个字段），
  // 而这条更新必须排在应答之后 —— 会话 id 是应答首次告知客户端的。
  const commands = await commandsUpdate(bridge, record)
  if (commands !== undefined) bridge.notifyAfterResponse(sessionId, commands)

  // 配置项**随应答一起给出**——ACP 没有「支持配置项」的能力位，带回 `configOptions`
  // 就是声明方式。空数组等价于「本会话没有可配置项」。
  const options = await optionsFor(bridge, record)
  const modes = modeStateFor(bridge.port.modes, handle.agent)
  return {
    sessionId,
    ...(options.length > 0 ? { configOptions: options } : {}),
    ...(modes === undefined ? {} : { modes }),
  }
}
