/**
 * 工具呈现意图 → ACP `tool_call` / `tool_call_update`。
 *
 * **这里没有 `assertNever`**，尽管 `ToolCallView` / `ToolResultView` 都是可辨识
 * 联合。参考实现用了，而这两个联合此后已经长出 `search` / `read` / `web` 三个
 * 新成员——穷尽 switch 会在上游加变体的那天把整条流式打掉。未识别的卡片一律
 * 退回通用文本卡片，这正是上游文档给「无该能力的 UI」规定的降级路径。
 * @module
 */

import type { SessionUpdate, ToolCallUpdate, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FileLocation, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { toolResultContent } from '../codec/content.js'
import { displayTitle, relativizeLocations } from './paths.js'
import { terminalCallMeta, terminalCwd, terminalExitMeta, terminalFallbackContent } from './terminal.js'

/**
 * `session/update` 里 tool_call / tool_call_update 两个分支。
 *
 * 从 SDK 的 `SessionUpdate` 里抽取而非自己拼 `{sessionUpdate} & ToolCallUpdate`：
 * 两者并不等价——`tool_call` 要求 `title: string`，而 `ToolCallUpdate.title` 是
 * `string | null`。自己拼会编译通过却在运行时发出不合规的帧。
 */
export type ToolCallSessionUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: 'tool_call' } | { sessionUpdate: 'tool_call_update' }
>

/** 一个会话的终端渲染能力与工作区。 */
export interface TerminalRendering {
  /** 客户端是否支持 Zed 的终端 `_meta` 约定 */
  readonly enabled: boolean
  /** 会话工作区，用作终端卡片的 cwd 表头与路径相对化基准 */
  readonly cwd: string | undefined
}

/** 默认：不渲染终端，走 ```console 文本兜底。 */
export const NO_TERMINAL: TerminalRendering = { enabled: false, cwd: undefined }

/** ACP 工具卡片内容项。 */
type AcpToolCallContent = NonNullable<ToolCallUpdate['content']>[number]

function acpLocations(locations: readonly FileLocation[] | undefined): ToolCallLocation[] | undefined {
  if (locations === undefined || locations.length === 0) return undefined
  return locations.map((l) => ({ path: l.path, ...(l.line !== undefined ? { line: l.line } : {}) }))
}

/**
 * 调用态更新。
 * @param callId - 调用 id
 * @param view - 工具声明的调用视图
 * @param terminal - 会话的终端渲染能力
 * @returns `tool_call` 更新
 */
export function toolCallUpdate(
  callId: ToolCallId,
  view: ToolCallView,
  terminal: TerminalRendering = NO_TERMINAL,
): ToolCallSessionUpdate {
  if (view.card === 'diff') {
    const content: AcpToolCallContent[] = view.diffs.map((d) => ({
      type: 'diff',
      path: d.path,
      oldText: d.oldText,
      newText: d.newText,
    }))
    const rawPath = view.locations?.[0]?.path ?? view.diffs[0]?.path
    const locations = acpLocations(relativizeLocations(view.locations, terminal.cwd))
    return {
      sessionUpdate: 'tool_call',
      toolCallId: callId,
      title: displayTitle(view.title, rawPath, terminal.cwd),
      kind: 'edit',
      status: 'in_progress',
      ...(locations !== undefined ? { locations } : {}),
      ...(content.length > 0 ? { content } : {}),
    }
  }

  if (view.card === 'terminal') {
    // 描述渲染在卡片**上方**（终端卡片本身没有描述槽位）。
    const description: AcpToolCallContent[] =
      view.description !== undefined ? [{ type: 'content', content: { type: 'text', text: view.description } }] : []
    const content: AcpToolCallContent[] = [
      ...description,
      ...(terminal.enabled ? [{ type: 'terminal' as const, terminalId: callId }] : []),
    ]
    // `_meta.terminal_info` 的 cwd 表头同源：客户端不管从哪一侧读，看到的工作
    // 目录都是同一个。
    const cwd = terminalCwd(view.cwd, terminal.cwd)
    return {
      sessionUpdate: 'tool_call',
      toolCallId: callId,
      title: view.title,
      kind: 'execute',
      status: 'in_progress',
      // **参数对象，不是命令字符串。** ACP 给这个字段的语义就是「发给工具的入
      // 参」，两个参考适配器也都发对象（codex-acp 是 `{command, cwd}`，
      // claude-agent-acp 直接发整个入参对象），客户端的通用启发式照着这个形状
      // 写。发裸字符串的代价落在没有终端能力的客户端上：cwd 只在 `_meta` 里，
      // 而 `_meta` 那一侧此刻根本不发；描述虽有 content 块，但结果侧的 content
      // 会把调用侧的整个集合替换掉。两者都只剩这里一条出路。
      rawInput: {
        command: view.title,
        ...(view.description !== undefined ? { description: view.description } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      },
      ...(content.length > 0 ? { content } : {}),
      ...terminalCallMeta(callId, view.cwd, terminal),
    }
  }

  // generic 与一切未来变体。未识别的调用视图至少还有 title——上游三种调用
  // 视图都有，把它当通用卡片显示远好过丢掉整次调用。
  const generic = view as Extract<ToolCallView, { card: 'generic' }>
  const content = generic.content !== undefined ? toolResultContent(generic.content) : []
  const locations = acpLocations(relativizeLocations(generic.locations, terminal.cwd))
  return {
    sessionUpdate: 'tool_call',
    toolCallId: callId,
    title: displayTitle(generic.title, generic.locations?.[0]?.path, terminal.cwd),
    kind: (generic.kind ?? 'other') as ToolKind,
    status: 'in_progress',
    ...(generic.rawInput !== undefined ? { rawInput: generic.rawInput } : {}),
    ...(locations !== undefined ? { locations } : {}),
    ...(content.length > 0 ? { content } : {}),
  }
}

/**
 * 结果态更新。
 * @param callId - 调用 id
 * @param view - 工具声明的结果视图
 * @param isError - 是否失败
 * @param terminal - 会话的终端渲染能力
 * @returns `tool_call_update` 更新
 */
export function toolResultUpdate(
  callId: ToolCallId,
  view: ToolResultView,
  isError: boolean,
  terminal: TerminalRendering = NO_TERMINAL,
): ToolCallSessionUpdate {
  const status = isError ? ('failed' as const) : ('completed' as const)
  const title = view.title !== undefined ? { title: view.title } : {}

  if (view.card === 'terminal') {
    if (terminal.enabled) {
      // **不带 content**：Zed 里 `tool_call_update.content` 会整体替换调用侧
      // 装好的内容集合，再发一次就把终端块本身冲掉了。输出走 `_meta`。
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        ...title,
        _meta: {
          // 载荷键是 `data` —— 不是 `output`。写错不会报错：客户端照样按
          // `terminal_info` 建出终端，然后永远收不到内容，卡片一直空着。
          terminal_output: { terminal_id: callId, data: view.output ?? '' },
          ...terminalExitMeta(callId, view),
        },
      }
    }
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status,
      ...title,
      content: terminalFallbackContent(view),
    }
  }

  if (view.card === 'diff') {
    // 标题相对化，与调用侧同一条规则。少了这一步，卡片在完成那一刻会从
    // 「Write b.ts」跳成「Wrote /很长的/绝对路径/b.ts」——同一张卡、同一个文件，
    // 只因为换了半边代码就换了写法。
    //
    // `DiffResultView` 没有 `locations`（调用侧的 `DiffCallView` 才有），所以主路径
    // 只能取第一条 diff。`content` 里的 path 仍然保持绝对：那是给编辑器跳转用的。
    const rawPath = view.diffs[0]?.path
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status,
      ...(view.title !== undefined ? { title: displayTitle(view.title, rawPath, terminal.cwd) } : {}),
      content: view.diffs.map((d) => ({ type: 'diff', path: d.path, oldText: d.oldText, newText: d.newText })),
    }
  }

  // generic / search / read / web 及未来变体：能给出 `content` 的就用它，
  // 否则只更新状态与标题，保留调用侧已经装好的内容。
  const content = 'content' in view && view.content !== undefined ? toolResultContent(view.content) : undefined
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status,
    ...title,
    ...(content !== undefined && content.length > 0 ? { content } : {}),
  }
}
