/**
 * 模型请求重试 → 给用户看的一行提示。
 *
 * `dsh-llm-retry` 每决定重试一次，就在等待**之前**往会话日志里记一条
 * `llm/retry`（第几次、上限、等多久、为什么失败）。上游把它标成 non-surface——
 * 模型看不见它，这是对的；但客户端看不见它，用户面对的就是一个停在半句话、
 * 十几秒不动的回答，分不清是在重试还是卡死了。所以映射层把它翻成一行文字。
 *
 * **放进助手消息**，用那一步自己的 `<turn>:<step>`：ACP 没有「系统消息」这类
 * 更新，唯一的文本通道是 `agent_message_chunk`（命令输出 `command/done` 走的也是
 * 这条）。用同一个 id，「废弃那次的半句 → 重试提示 → 重来的回答」就在同一个气泡
 * 里按时间顺序排着，提示正好解释了文字为什么从头再来。另编一个 id 反而更乱：重来
 * 的回答仍挂在原 id 上，客户端会把它接到提示**上面**那个气泡里。
 *
 * 前后各空一行：失败可能发生在半句话中间，不另起段落的话提示会直接粘在那半句
 * 后面。
 *
 * 实时与重放同源：这条事件在日志里，`session/load` 时走同一个 `mapEvent`，恢复
 * 出来的转录与当时看到的一致。
 * @module
 */

import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry'

/** 默认会被重试的那几类失败的中文说法；其余照原样给错误码。 */
const FAILURE_LABELS: Readonly<Record<string, string>> = {
  TRANSPORT: '网络连接出错',
  TIMEOUT: '请求超时',
  RATE_LIMIT: '请求被限流',
  SERVER: '服务端出错',
  EMPTY_RESPONSE: '模型返回了空响应',
  STREAM_CLOSED: '响应流中途断开',
  MALFORMED_RESPONSE: '响应格式有误',
}

/**
 * 一次重试的提示文字。
 *
 * 只说用户能用上的三件事：为什么失败、多久之后、这是第几次。不带服务端的原始
 * 错误文本——那里面常有 request id、内部类型名，对用户是噪音，排查时日志里有完整的
 * `failure`。HTTP 状态码例外：「503」比「服务端出错」多一层信息，又不长。
 * @param data - `llm/retry` 事件的数据
 * @returns 带前后空行的一段文字
 */
export function retryNoticeText(data: LlmRetryEventData): string {
  const { failure, retry, delayMs } = data
  const label = FAILURE_LABELS[failure.code] ?? failure.code
  const status = failure.status === undefined ? '' : `，HTTP ${failure.status}`
  // `always` 模式没有上限，只说第几次。
  const count = data.mode === 'normal' ? `${retry}/${data.maxRetries}` : `${retry}`
  const seconds = (Math.max(0, delayMs) / 1000).toFixed(1)
  return `\n\n（模型请求失败：${label}${status}。${seconds} 秒后第 ${count} 次重试）\n\n`
}
