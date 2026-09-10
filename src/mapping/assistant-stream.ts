/**
 * 模型流式分片 → ACP 的 `agent_message_chunk` / `agent_thought_chunk`。
 *
 * **为什么单独一个模块**：上游把助手分片从会话日志里撤掉了。0.1.1 里每一片都是
 * 一条持久 `assistant/chunk` 事件，实时与重放因此天然同源（同一条事件走同一个
 * `mapEvent`）；0.1.5 起分片走两条路——实时是进程内的 `agent/assistant-stream`
 * 帧流（transient），落库的则是随 `assistant/message` 一起写下的**紧凑记录**
 * （连续同类 delta 打包成一条 run）。两条路的数据形状不同，但必须产出同一串
 * 更新，所以把那条「一片 → 更新」的规则收在这里，两边各自喂自己的数据进来。
 *
 * 帧流不持久这件事有一个直接后果：**没有它就没有流式**。日志里只剩组装完的整条
 * 消息，客户端要等一整步才看到第一个字——那正是本项目相对官方 automation 通道的
 * 核心差异（US-03）。
 * @module
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import { assistantMessageId } from '../session/fork-point.js'

/**
 * 一片模型输出 → 零或多条更新。
 *
 * 正文与推理**共享同一个 messageId**：它们属于同一条助手消息，ACP 那边靠
 * `messageId` 判「还是不是同一条」，分开给会把一次回答拆成两个气泡。
 *
 * 非文本片（block-start、tool-call-delta、usage、finish）在这里一律落空：工具
 * 调用有自己的卡片通道（`tool/call` 事件），用量有自己的 `usage_update`，在这里
 * 再发一次只会重复。
 * @param messageId - 该消息的 ACP 标识，见 {@link assistantMessageId}
 * @param chunk - 一片模型输出
 * @returns 需要发往客户端的更新
 */
export function assistantChunkUpdates(messageId: string, chunk: StreamChunk): SessionUpdate[] {
  if (chunk.type === 'text-delta') {
    return [{ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: chunk.text } }]
  }
  if (chunk.type === 'reasoning-delta') {
    return [{ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: chunk.text } }]
  }
  return []
}

/**
 * 落库的紧凑流 → 更新序列（重放路径）。
 *
 * **不走 `expandAssistantStream`**，尽管那是上游给的官方展开函数。两个理由：
 * 它会把每条 run 还原成逐片时间戳（重放不需要时间，客户端只是把文本接起来），
 * 而且它对读到的记录做校验并在不合法时抛 `TypeError` ——一条尾部损坏的日志会
 * 因此炸掉整次 `session/load`，而恢复一个坏会话的正确结果是「能显示多少显示
 * 多少」。这里按 run 直读，一条 run 发一条更新：拼接结果与逐片发完全相同，
 * 而一个几百轮的会话能少发几万条通知（`notifyAwaited` 是把它们一并 await 的）。
 * @param turn - 该消息所在回合
 * @param step - 该消息所在步骤
 * @param stream - 随 `assistant/message` 一起落库的紧凑记录
 * @returns 需要发往客户端的更新，按流序
 */
export function assistantStreamUpdates(
  turn: number,
  step: number,
  stream: readonly AssistantStreamRecord[],
): SessionUpdate[] {
  const messageId = assistantMessageId(turn, step)
  const updates: SessionUpdate[] = []
  for (const record of stream) {
    if (record.type === 'text-chunks') {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: record.texts.join('') },
      })
    } else if (record.type === 'reasoning-chunks') {
      updates.push({
        sessionUpdate: 'agent_thought_chunk',
        messageId,
        content: { type: 'text', text: record.texts.join('') },
      })
    } else if (record.type === 'chunk') {
      // 打不进 run 的那些原始片（block-start、usage、finish…）。按上游的打包
      // 规则文本与推理不会出现在这里，但走同一个函数不用多花什么，而少写这一支
      // 的代价是它哪天真出现时静默丢字。
      updates.push(...assistantChunkUpdates(messageId, record.chunk))
    }
  }
  return updates
}

/**
 * 实时帧流 → 更新序列，按会话持有。
 *
 * 存在理由是**帧流本身不带 turn/step**：只有 `start` 帧带，其后的 `chunk` 帧
 * 只有 `attemptId` / `revision` / `index`。而 messageId 必须是 `turn:step`
 * ——`session/fork` 的分叉点就是拿客户端回传的这个 id 去日志里比对的
 * （见 `src/session/fork-point.ts`），换成 attemptId 会让重放与实时发出两套
 * 互不相认的 id，分叉点从此永远认不出来。所以这里记住每次尝试开头那一帧。
 *
 * **按会话一个实例**：`attemptId` 只在单个 agent 生命周期内唯一，跨会话共用
 * 会让两条会话的同名尝试互相串——与 `ToolPresenter` 同一条理由。
 */
export class AssistantStreamRelay {
  /**
   * `attemptId` → 该次尝试的 messageId。
   *
   * **只按 attemptId 记，不把 `revision` 也拼进键。** 那个字段看着像「第几次
   * 尝试」，实际是**每一帧**都自增一次的发布序号（`revision: nextRevision()`
   * 同时出现在 start 与每一个 chunk 上）。拿它进键，chunk 就永远配不上自己那条
   * start ——表现是整条流式静默消失，一个字都不发。attemptId 自己就是「哪一次
   * 尝试」的标识（`${sessionId}:${计数}`），重发的 start 覆盖同一个键正是要的。
   */
  readonly #open = new Map<string, string>()

  /**
   * 处理一帧。
   * @param frame - 一条 start / chunk / end 帧
   * @returns 需要发往客户端的更新
   */
  frame(frame: AssistantStreamFrame): SessionUpdate[] {
    if (frame.type === 'start') {
      this.#open.set(frame.attemptId, assistantMessageId(frame.turn, frame.step))
      return []
    }
    if (frame.type === 'end') {
      this.#open.delete(frame.attemptId)
      return []
    }
    const messageId = this.#open.get(frame.attemptId)
    // 没见过开头的尝试：会话是在这次尝试进行中才登记进表的（`session/load`
    // 恢复一条正在跑的会话），此时发不出正确的 messageId。丢掉这几片好过用
    // 一个编出来的 id ——那会让客户端把它们当成另一条消息单独起一个气泡。
    if (messageId === undefined) return []
    return assistantChunkUpdates(messageId, frame.chunk)
  }
}
