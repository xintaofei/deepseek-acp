/**
 * ACP `McpServer` → `dsh-mcp-client` 挂载配置（US-20）。
 *
 * 两侧的传输词表不重合，这里是那道翻译层，也是**显式拒绝**不支持传输的地方。
 * @module
 */

import type { McpServer } from '@agentclientprotocol/sdk'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { publicServerName } from './naming.js'

/**
 * 一次 MCP 工具调用的期限，取值就是平台定时器能表达的最大值（约 24.8 天）。
 *
 * `dsh-mcp-client` 自己的默认值是 60 s（`DEFAULT_TOOL_CALL_TIMEOUT_MS`），MCP SDK
 * 的 `DEFAULT_REQUEST_TIMEOUT_MSEC` 同样是 60 s。这个数对本地工具够用，但对
 * **等真人**的 MCP 工具是错的：codeg 的 `ask_user_question` 要等到用户点下按钮，
 * `get_delegation_status` 的 `wait_ms: 0` 要等子 agent 跑完，两者都可以合理地
 * 超过一分钟。撞上默认值时的表现是工具带着 `Request timed out` 失败，而界面上
 * 那张卡片还开着——用户与模型各自看到一半真相，且没有任何一处日志说清是哪个
 * 超时。
 *
 * 不另编一个「够大」的数字：这里没有可推断的正确值。期限本该由取消信号终结
 * （工具自己的 `exec.signal`、连接断开），计时器只该是防止 MCP server 卡死的
 * 兜底，而兜底不该比真实等待短。取 `MAX_TIMER_DELAY_MS` 而不是自己写
 * `2 ** 31 - 1`，是为了让「多大算平台上限」只有一个真值来源——写大 1 会溢出成
 * 1 ms 并在每次调用上立刻超时，写错也没有任何地方会报错。
 */
const MCP_TOOL_CALL_TIMEOUT_MS = MAX_TIMER_DELAY_MS

/** 一个待挂载的 MCP server，已翻译成上游插件的配置形状。 */
export type McpMountSpec =
  | {
      readonly transport: 'stdio'
      readonly serverName: string
      readonly command: string
      readonly args: string[]
      readonly env: Record<string, string>
      readonly toolCallTimeoutMs: number
      readonly failOnStartupError: true
    }
  | {
      readonly transport: 'streamable-http'
      readonly serverName: string
      readonly url: string
      readonly headers: Record<string, string>
      readonly toolCallTimeoutMs: number
      readonly failOnStartupError: true
    }

/** 翻译失败：客户端送来了本部署无法承载的 server。 */
export class UnsupportedMcpServer extends Error {}

/** `[{name, value}]` → `{name: value}`。 */
function toRecord(pairs: readonly { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs) out[pair.name] = pair.value
  return out
}

/**
 * 翻译一个 ACP MCP server 声明。
 *
 * `failOnStartupError` 恒为 true：MCP server 起不来时，客户端配了工具而模型看不见
 * 它们，表现是「模型莫名其妙不会用 github」——比 `session/new` 直接失败难查得多。
 *
 * `toolCallTimeoutMs` 每条都显式给出，理由见 {@link MCP_TOOL_CALL_TIMEOUT_MS}：
 * 漏掉这个字段不会报错，只会静默退回上游那个 60 s 默认值。
 * @param server - ACP 侧声明
 * @param sessionSeq - 连接内会话序号，用于前缀隔离
 * @returns 上游插件配置
 * @throws {UnsupportedMcpServer} 传输方式不受支持时
 */
export function toMountSpec(server: McpServer, sessionSeq: number): McpMountSpec {
  const serverName = publicServerName(sessionSeq, server.name)

  // stdio 是无 `type` 标签的那个变体（ACP 把它当基线）。
  if (!('type' in server)) {
    return {
      transport: 'stdio',
      serverName,
      command: server.command,
      args: [...server.args],
      env: toRecord(server.env),
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    }
  }

  if (server.type === 'http') {
    return {
      transport: 'streamable-http',
      serverName,
      url: server.url,
      headers: toRecord(server.headers),
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    }
  }

  // `sse`：上游 `dsh-mcp-client` 只有 stdio 与 streamable-http 两种传输。SSE 是
  // MCP 的旧式传输，规范已标为 deprecated，上游不实现是合理的。
  //
  // `acp`：MCP 报文经 ACP 连接本身代理（客户端替 agent 跑那个 server）。它需要
  // 一个把 `mcp/message` 往返桥接到 mcp-client 的自研传输，不是配置能解决的。
  //
  // 两者都**显式拒绝**而非静默跳过：客户端送来 server 就是指望这些工具可用，
  // 假装接受只会让模型看不见它们，而故障现场离原因很远。
  throw new UnsupportedMcpServer(
    `MCP transport "${server.type}" is not supported (server "${server.name}"); ` +
      `this agent supports stdio and http`,
  )
}

/**
 * 批量翻译。
 * @param servers - ACP 侧声明
 * @param sessionSeq - 连接内会话序号
 * @returns 上游插件配置数组
 * @throws {UnsupportedMcpServer} 任一不受支持即整体失败
 */
export function toMountSpecs(servers: readonly McpServer[], sessionSeq: number): McpMountSpec[] {
  return servers.map((server) => toMountSpec(server, sessionSeq))
}
