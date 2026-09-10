/**
 * session event → ACP SessionUpdate 的映射。
 *
 * **纯函数**：入参为事件（加一个呈现器），出参为更新数组，不触碰连接对象。
 * 这是「实时流与 `session/load` 重放同源」的实现基础，也让协议行为可在无模型、
 * 无 API Key 的条件下测试（详设 §二 硬约束、测试用例 TC-PROP-03）。
 * @module
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 侧效应类型导入：把 `command/run`、`command/done`、`plan/mode` 合并进
// `SessionEventMap`。纯类型，组合里没挂这两个插件时下面的分支根本收不到事件。
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-title'
import { harnessBlockToAcpContent } from '../codec/content.js'
import { modeId } from '../config/modes.js'
import type { ToolPresenter } from '../presentation/presenter.js'
import { NO_TERMINAL, toolCallUpdate, toolResultUpdate, type TerminalRendering } from '../presentation/tool-call.js'
import { assistantStreamUpdates } from './assistant-stream.js'
import { todosToPlan } from './plan.js'

/** 映射一条事件所需的会话上下文。 */
export interface MappingContext {
  /** 解析工具自己声明的卡片；缺席时工具事件不产出更新 */
  readonly presenter?: ToolPresenter
  /** 终端渲染能力与工作区 */
  readonly terminal?: TerminalRendering
  /** 当前模型的上下文窗口（token）；缺席或返回 undefined 时不产出用量更新 */
  readonly contextWindow?: () => number | undefined
  /**
   * 是否在重放历史（`session/load`）。
   *
   * 影响两类事件，两类的理由相反：
   *
   *  - **用户消息与命令回显**：实时流里客户端刚把 prompt 发过来，回显一遍是
   *    重复；重放时不给，客户端拿到的是一串没有问题的回答。
   *  - **助手分片**：实时那份走的是进程内帧流（`agent/assistant-stream`），
   *    日志里的紧凑流只在重放时展开——两边都发就是每句话说两遍。
   *
   * 归结成一句：这个开关切的是「这条更新在实时路径上是不是已经由别处发过了」。
   */
  readonly replay?: boolean
  /**
   * 客户端是否 advertise 了 `session.compaction`。
   *
   * 规范在这里用的是 **MUST**：「Agents MUST only send this update when the
   * Client advertised `ClientSessionCapabilities::compaction`」。缺省 false ——
   * 压缩照常发生（它是模型侧的事），只是不往线上发这两条更新。
   */
  readonly compaction?: boolean
}

/**
 * 一步的记账 → 该步结束时上下文里占了多少 token。
 *
 * ACP 的 `usage_update` 是**上下文窗口占用**（`used` / `size`），不是累计花费，
 * 所以不能把各步相加——那会很快超过 `size` 并画出一根爆表的进度条。
 *
 * 输入侧三项相加是因为上游明确它们**不相交**（`inputTokens` 只算未命中缓存的
 * 部分，命中的走 `cacheReadTokens` / `cacheWriteTokens`，计费输入是三者之和），
 * 少加一项会让开着缓存的会话显示成只用了一小半。`reasoningTokens` **不加**：
 * 它是产出 token 的一部分，再加一次就是重复计数。
 * @param usage - 这一步的记账
 * @returns 该步结束时的上下文占用
 */
function contextUsed(usage: TokenUsage): number {
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return input + usage.outputTokens
}

/**
 * 把一条 session event 映射为零或多条 ACP 更新。
 *
 * 未知事件类型**静默返回空数组**而非抛错：`SessionEventMap` 由各插件声明合并，
 * 组合可插拔，出现本 bridge 不认识的事件是正常状态（详设 §4.3）。
 * @param event - durable session event
 * @param context - 会话级呈现上下文
 * @returns 需要发往客户端的更新，按序
 */
export function mapEvent(event: SessionEvent, context: MappingContext = {}): SessionUpdate[] {
  const terminal = context.terminal ?? NO_TERMINAL

  switch (event.type) {
    case 'assistant/message': {
      const { turn, step, stream, usage } = event.data
      // 重放时才从日志里展开分片。实时路径下这段文本已经由
      // `agent/assistant-stream` 那条进程内帧流逐片发过了（见
      // `./assistant-stream.ts`），在这里再发一遍就是每句话说两次。
      //
      // 反过来，重放时**只能**走这里：帧流不落库，日志里剩下的就是这条消息随身
      // 带的紧凑记录。两条路径产出的更新序列相同，`session/load` 因此仍与当初
      // 那次逐字一致——同源这件事从「同一条事件」变成了「同一条规则」。
      const updates: SessionUpdate[] = context.replay === true ? assistantStreamUpdates(turn, step, stream) : []

      // 用量记账随消息一起落库——上游没有独立的用量事件，两者同源同刻。
      if (usage === undefined) return updates
      const size = context.contextWindow?.()
      // 分母不知道就不发这一条：ACP 的 `size` 是必填项，编一个默认值会画出一根
      // 看起来权威、实际刻度错误的进度条——那比没有进度条更坏。
      if (size === undefined || size <= 0) return updates
      updates.push({ sessionUpdate: 'usage_update', used: contextUsed(usage), size })
      return updates
    }

    case 'assistant/attempt': {
      // 一次**没能committed成消息**的尝试：流中途报错、被重试、或取消时一个字
      // 都还没吐出来。上游把它单独记一条，正是为了「保住那段已经发出去的文字，
      // 又不把它伪造成模型可见的历史」。
      //
      // **重放它，尽管它不在 surface 上。** 判据不是「这段话算不算对话」，而是
      // 「客户端当时看没看见」——看见了就必须在恢复时同样看见，否则同一条会话
      // 重开之后少掉一段，而那正是本模块开头那条硬约束（实时与重放同源）说的事。
      // 上游给这条事件配了 `stream` 字段就是为了让消费方能做到这一点。
      //
      // 用与 `assistant/message` **相同**的 `<turn>:<step>`：重试走的是同一步
      // （loop 在 `while(true)` 外面就捕获了 turn/step），实时那两次也是共用这
      // 一个 id 发出去的。给它另编一个 id 会让重放把一段当时连在一起的文字拆成
      // 两个气泡——那同样是「与当初不一样」。
      //
      // 代价照实说：一次「吐了半句话再重试」的回合，转录里会留下那半句加上重来
      // 的完整答案。这是 0.8.0（`assistant/chunk` 逐片落库）就有的样子，不是这
      // 次改出来的；真要收拾它得先有一个能撤回已发分片的机制，那是另一件事。
      if (context.replay !== true) return []
      return assistantStreamUpdates(event.data.turn, event.data.step, event.data.stream)
    }

    // ── 上下文压缩 ────────────────────────────────────────────────────
    //
    // 上游把一次压缩记成三条日志事件（`start` 持锁 → `summary` 带摘要 → `end`
    // 放锁），ACP 那边是一个按 id upsert 的实体加一串摘要分片。对应关系：
    //
    //   compaction/start   → compaction_update  status=in_progress
    //   compaction/summary → compaction_summary_chunk × N（摘要逐块追加）
    //   compaction/end     → compaction_update  status=completed / failed
    //
    // 摘要**只经分片发**，不在 `completed` 里重发一遍：`summary` 字段是补丁语义
    // （省略即保持不变），分片已经把内容建起来了。而且规范只允许非空 `summary`
    // 与 `completed` 同行，摘要事件那一刻还没到 `completed`。
    case 'compaction/start': {
      if (context.compaction !== true) return []
      return [
        {
          sessionUpdate: 'compaction_update',
          compactionId: event.data.compactionId,
          status: 'in_progress',
        },
      ]
    }

    case 'compaction/summary': {
      if (context.compaction !== true) return []
      const { compactionId, summary } = event.data
      // 只发文本块：摘要理论上是任意内容块，但 ACP 的分片一次带一块，而非文本
      // 块（图片、工具调用）在「这段历史被压成了什么」这件事上没有意义。
      return summary
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => ({
          sessionUpdate: 'compaction_summary_chunk' as const,
          compactionId,
          content: { type: 'text' as const, text: block.text },
        }))
    }

    case 'compaction/end': {
      if (context.compaction !== true) return []
      const { compactionId, error } = event.data
      return [
        {
          sessionUpdate: 'compaction_update',
          compactionId,
          // `error` 在这条事件上就是「这次尝试失败了」的全部证据——上游对失败的
          // 记录方式是照常 append 一条 `end` 并带上原因，而不是不 append。
          ...(error === undefined
            ? { status: 'completed' as const }
            : { status: 'failed' as const, error }),
        },
      ]
    }

    case 'tool/call': {
      const presenter = context.presenter
      if (presenter === undefined) return []
      const { callId, name, arguments: args } = event.data
      return [toolCallUpdate(callId, presenter.call(callId, name, args), terminal)]
    }

    case 'tool/result': {
      const presenter = context.presenter
      if (presenter === undefined) return []
      // 非 append 的 surfaceOp 是转录改写（例如免模型剪枝），不是又跑了一次
      // 工具。重新呈现会消费掉待决调用记录，还可能冲掉原本已完成的终端/diff。
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return []

      const block = event.data.message.content[0]
      const callId: ToolCallId = block.toolCallId
      const isError = block.isError ?? false
      const view = presenter.result(callId, block.content, isError, event.data.meta)
      return [toolResultUpdate(callId, view, isError, terminal)]
    }

    case 'user/message': {
      if (context.replay !== true) return []
      // 只回放**用户真的敲进去**的那部分。`kind: 'plugin'` 是注入的上下文
      // （agent-instructions 那条包着 AGENTS.md 的 `<system-reminder>`、目录
      // 快照等）——它们是给模型看的管道，当成用户气泡显示，用户会看到自己
      // 从没打过的一整份 CLAUDE.md。
      if (event.data.source.kind !== 'user') return []
      const updates: SessionUpdate[] = []
      for (const block of event.data.content) {
        const content = harnessBlockToAcpContent(block)
        // 这里用消息自己的持久 id：`user/message` 事件的数据**就是**那条消息，
        // 没有 turn/step 可取（用户消息在回合里被认领，不属于某一步）。
        if (content !== undefined) {
          updates.push({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content })
        }
      }
      return updates
    }

    case 'command/run': {
      // 与 `user/message` 同一条理由：实时路径下客户端刚把这行命令发过来，
      // 回显一遍是重复；重放时不给，恢复出来的对话里就会凭空冒出一段命令结果。
      if (context.replay !== true) return []
      // `args` 是 `parseCommand` 原样切出来的后缀（含分隔空白），所以直接拼接
      // 就还原成用户当初敲的那一行，不必自己补空格。
      const line = `/${event.data.name}${event.data.args ?? ''}`
      return [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: line } }]
    }

    case 'command/done': {
      const text = event.data.text
      if (text === undefined || text.length === 0) return []
      // 成功与失败都走同一条：ACP 没有「系统消息」这类更新，唯一的文本通道就是
      // 助手消息。失败**不**翻成 JSON-RPC 错误——那样重放时就没有它了，而一次
      // 失败的命令与它的失败原因同样是对话的一部分。
      return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }]
    }

    case 'plan/mode':
      // 实时与重放共用：`session/set_mode` 已经乐观回过一条同值的更新，这里
      // 再来一条是幂等的（携带完整状态而非增量）。少了它，模型自己通过
      // `exit_plan_mode` 退出时选择器会一直停在「计划」上。
      return [{ sessionUpdate: 'current_mode_update', currentModeId: modeId(event.data.active) }]

    case 'session/title':
      // 标题是**后来**才有的：它由第一条用户消息推导，可能还会随对话刷新。
      // 因此实时与重放共用这一条——恢复一个老会话时客户端同样要拿到标题，
      // 否则会话列表里有名字、打开之后反而变回一串 id。
      //
      // `updatedAt` 取事件自己的时间戳，不是「现在」：重放一个上周的会话不该
      // 把它标成刚刚活动过。
      return [
        {
          sessionUpdate: 'session_info_update',
          title: event.data.title,
          updatedAt: new Date(event.time).toISOString(),
        },
      ]

    case 'todo/write':
      return [{ sessionUpdate: 'plan', ...todosToPlan(event.data.todos) }]

    default:
      return []
  }
}
