/**
 * 解析工具自己声明的呈现意图，带兜底。
 *
 * **卡片类型由工具自己声明，bridge 绝不按工具名嗅探**（US-08）。名字嗅探会把
 * 「叫 bash 的就是终端」这种假设焊死在 bridge 里，第三方工具一旦重名就错得
 * 悄无声息，而工具改了呈现方式 bridge 也跟不上。
 * @module
 */

import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'

/** 解析工具定义所需的最小 registry 面。 */
export type ToolLookup = Pick<ToolRegistry, 'get'>

/** 已发出、等待结果的调用。 */
interface PendingCall {
  readonly name: string
  readonly args: unknown
  /** 调用侧用的卡片类型，用于结果侧的孤儿防护 */
  readonly card: ToolCallView['card']
}

/**
 * 解析工具参数 JSON。
 *
 * 解析失败返回原始字符串而非丢弃：模型产出非法 JSON 时，把它原样显示给用户
 * 比显示一个空卡片有用得多——那往往正是要排查的东西。
 * @param args - 事件里的原始参数字符串
 * @returns 解析结果，或原字符串
 */
export function parseToolArguments(args: string): unknown {
  if (args.length === 0) return {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/**
 * 按会话持有的呈现器：把 `tool/call` 与 `tool/result` 关联起来。
 *
 * 需要关联是因为 `presentResult(args, result)` 要拿到**调用时**的参数，而结果
 * 事件里没有。
 */
export class ToolPresenter {
  private readonly pending = new Map<string, PendingCall>()
  private readonly tools: ToolLookup | undefined
  private readonly onError: (message: string) => void
  private readonly scope: ScopeKey | undefined

  /**
   * @param tools - 工具注册表（缺席时全部走兜底）
   * @param onError - 呈现器抛错的接收端
   * @param scope - 执行方 agent 的 scope，用于按作用域解析工具
   */
  constructor(tools: ToolLookup | undefined, onError: (message: string) => void = () => {}, scope?: ScopeKey) {
    this.tools = tools
    this.onError = onError
    this.scope = scope
  }

  /**
   * 调用态呈现意图，并记住 `(name, args, card)` 供结果侧使用。
   * @param callId - 调用 id
   * @param name - 工具名
   * @param argsJson - 原始参数字符串
   * @returns 工具声明的视图，或通用兜底
   */
  call(callId: ToolCallId, name: string, argsJson: string): ToolCallView {
    const args = parseToolArguments(argsJson)
    let declared: ToolCallView | undefined
    try {
      declared = this.tools?.get(name, this.scope)?.presentCall?.(args)
    } catch (error: unknown) {
      // presentCall 抛错不得打断流式：记一笔，退回通用卡片。
      this.onError(`tool "${name}" presentCall threw, using generic card: ${String(error)}`)
      declared = undefined
    }
    const view: ToolCallView = declared ?? { card: 'generic', title: name, kind: 'other', rawInput: args }
    this.pending.set(callId, { name, args, card: view.card })
    return view
  }

  /**
   * 结果态呈现意图，消费掉对应的调用记录。
   * @param callId - 调用 id
   * @param content - 模型可见的结果内容
   * @param isError - 是否失败
   * @param meta - 工具私有的呈现负载
   * @returns 归一化后的视图
   */
  result(callId: ToolCallId, content: ContentBlock[], isError: boolean, meta?: JsonValue): ToolResultView {
    const call = this.pending.get(callId)
    this.pending.delete(callId)
    // 没有对应调用（未知或迟到的 callId）——无从呈现，原样给内容。
    if (call === undefined) return { card: 'generic', content }

    let declared: ToolResultView | undefined
    try {
      declared = this.tools
        ?.get(call.name, this.scope)
        ?.presentResult?.(call.args, { content, isError, ...(meta !== undefined ? { meta } : {}) })
    } catch (error: unknown) {
      this.onError(`tool "${call.name}" presentResult threw, using raw result: ${String(error)}`)
      declared = undefined
    }
    if (declared === undefined) return { card: 'generic', content }

    // 孤儿防护：只有调用侧就是终端卡片时，才认结果侧的终端视图。否则
    // `_meta.terminal_output` 会指向一个客户端从未创建过的终端。
    if (declared.card === 'terminal' && call.card !== 'terminal') return { card: 'generic', content }

    // 通用结果只换了标题、没给内容时，补上原始内容——否则卡片会被清空。
    if (declared.card === 'generic' && declared.content === undefined) return { ...declared, content }
    return declared
  }

  /**
   * 当前**唯一**在飞的调用 id；有零个或多个时返回 undefined。
   *
   * 给提问的降级通道用：`session/request_permission` 要求带一个 `toolCall`，
   * 而提问的发起方（`ask_user_question` / `exit_plan_mode`）此刻正好就是那个
   * 还没出结果的调用，于是提示能挂到它自己的卡片上，而不必凭空造一个客户端
   * 不认识的 id。判据是「唯一」而不是「按工具名找」：bridge 不按名字嗅探工具
   * （见本模块开头），而并行调用时本来就无从判断是哪一个在提问——那种情况下
   * 交回 undefined 让调用方合成一个，宁可多出一张卡片，也不要挂到隔壁工具上。
   * @returns 唯一在飞的调用 id
   */
  solePendingCall(): string | undefined {
    if (this.pending.size !== 1) return undefined
    for (const callId of this.pending.keys()) return callId
    return undefined
  }

  /** 丢弃未完成的调用记录（会话结束时）。 */
  clear(): void {
    this.pending.clear()
  }
}
