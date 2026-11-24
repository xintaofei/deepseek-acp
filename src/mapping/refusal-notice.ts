/**
 * 内容安全拒答（`CONTENT_REFUSED`）→ 转录里的一行说明，以及这一轮怎么结算。
 *
 * DSH 0.2.2-rc.5 起，DeepSeek 以 `stop_reason: "refusal"` 结束响应流时，适配器先报
 * 这一步的计费用量，再以 `CONTENT_REFUSED` 失败；有 `stop_details.explanation` 的话
 * （例如哪张图片被拦了）拼进错误消息。重试插件不重试它（上游默认码表里没有，部署的
 * `DEEPSEEK_RETRY_POLICY` 也没加）——同一个请求重发，审查结论不会变。
 *
 * **这一轮按正常结束结算（`end_turn`），原因写进转录。** 不报 JSON-RPC 错误：拒答是
 * 模型给出的明确结论，不是 agent 坏了，`internalError` 会让编辑器弹一个「内部错误」的
 * 红框；而且错误只在应答里，`session/load` 时就没有它了，恢复出来的转录停在半句话上，
 * 看不出为什么。与 `command/done` 失败走文本通道同一条理由。
 *
 * **也不报 ACP 的 `refusal`**，尽管字面上正好对得上。Zed 收到 `refusal` 会把转录从
 * 最后一条用户消息起整段删掉（那一轮没有已完成的工具输出时），它的意思是「这条提问
 * 不算数」。DSH 不是这样：拒答的那次回答记成 `assistant/attempt`、不进模型历史，但
 * **用户消息留在历史里**，下一轮模型照样看得见。报 `refusal` 的话，编辑器里看不见的
 * 内容模型却看得见，而本该解释原因的这行说明也跟着被删掉。codeg 对 `refusal` 只弹
 * 一条「通常是后端或网关出错」的提示，同样不对。
 *
 * 说明从 `turn/end` 产出：`CONTENT_REFUSED` 只在那条事件上（`reason.error`）。实时与
 * 重放共用这一条规则，恢复出来的转录与当时一致。
 * @module
 */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** 上游 `LLM_FAILURE_CODES` 里的那个码。 */
const CONTENT_REFUSED = 'CONTENT_REFUSED'

/**
 * 上游 `translate.ts` 的错误消息前缀；后面跟 `: <explanation>` 或什么都不跟。
 *
 * 只用来把 provider 的说明从英文外壳里剥出来。对不上（上游改了措辞，或别的 provider
 * 也开始报这个码）就原样展示整条消息，不会丢信息。
 */
const UPSTREAM_PREFIX = /^DeepSeek refused to answer under its content safety review(?::\s*([\s\S]*))?$/

/** 只认 `CONTENT_REFUSED`，其余失败照旧以 prompt 错误浮现。 */
export function contentRefusal(reason: TurnEndReason): { readonly message: string } | undefined {
  if (reason.kind !== 'error' || reason.error.code !== CONTENT_REFUSED) return undefined
  return reason.error
}

/**
 * 同一件事在 `agent/error` 上的样子：抛出来的 `LlmError`。
 *
 * agent-loop 先发 `agent/error`、再在 `finally` 里追加 `turn/end`。普通 prompt 的回合
 * 号已经认领到了，那个监听器会让给 `turn/end`；命令（`/plan …`）起的回合拿不到回合号，
 * 不在这里让开的话，prompt 在 `turn/end` 到达之前就以内部错误结算了。
 *
 * 按 `code` 判，不用 `instanceof`：上游明确要按码路由，且不同副本的类不相等。
 */
export function isContentRefusalError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === CONTENT_REFUSED
}

/**
 * 拒答说明。
 *
 * 前面空一行：拒答常在吐了半句之后才到，不另起段落会直接粘在那半句后面（同
 * `retry-notice.ts`）。后面不空：这一轮到此结束。
 *
 * 说清两件用户用得上的事：被拒的回答不进上下文；提问本身还在上下文里，所以问题若出在
 * 提问（典型是一张图），之后几轮可能接着被拒，换个说法或新开会话。
 * @param failure - `turn/end` 上的那条失败
 * @returns 带前置空行的一段文字
 */
export function refusalNoticeText(failure: { readonly message: string }): string {
  const matched = UPSTREAM_PREFIX.exec(failure.message.trim())
  const raw = matched === null ? failure.message.trim() : (matched[1] ?? '').trim()
  // 句末自带的句号去掉，下面统一补一个。
  const explanation = raw.replace(/[。.]+$/, '')
  const detail = explanation === '' ? '' : `原因：${explanation}。`
  return (
    `\n\n（模型拒绝回答：未通过 DeepSeek 的内容安全审查。${detail}` +
    '这次的回答不会进入上下文，但你的提问仍在；若是提问本身（例如图片）触发的，之后几轮可能继续被拒，' +
    '请换个说法或新开会话。）'
  )
}
