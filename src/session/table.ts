/**
 * 会话表：记录、所有权、in-flight 槽位与统一 teardown。
 *
 * 不变量（详设 §4.2）：
 *   I1 每会话至多一个 in-flight prompt
 *   I2 路由前做**精确 agent 对象比对**，仅比对 id 不足以防同 id 冒充
 *   I3 进入 teardown 后不再接受新会话与新 prompt
 * @module
 */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AssistantStreamRelay } from '../mapping/assistant-stream.js'
import type { AgentHandle } from '../port/types.js'
import type { ToolPresenter } from '../presentation/presenter.js'

/** 一次在途 prompt 的结算状态。 */
export interface InflightPrompt {
  /** 相关联的用户消息 id；命令路径没有自己构造消息，为 undefined */
  readonly messageId: string | undefined
  /**
   * 是否接受**任意**回合的结束原因。
   *
   * 命令路径（`/plan 帮我设计 X`）由上游 `agent.steer()` 起回合，那条消息的 id
   * 在上游铸造，bridge 拿不到，因此无法按消息相关联。此时以「本会话的下一个
   * 回合结束」为准——I1 保证每会话至多一个在途 prompt，不存在第二个候选。
   */
  readonly anyTurn: boolean
  /** 由 `agent/inbox/claimed` 填入，用于精确结算 */
  turn: number | undefined
  /** 在相关联的 turn/end 记录，在整体 idle 时才用于结算 */
  endReason: TurnEndReason | undefined
  readonly resolve: (reason: StopReason) => void
  readonly reject: (error: Error) => void
}

/** 单个 ACP 会话的运行时记录。 */
export interface SessionRecord {
  readonly acpSessionId: SessionId
  /** 连接内单调序号；M1-c 的 MCP 前缀隔离将使用它 */
  readonly seq: number
  readonly handle: AgentHandle
  readonly cwd: string
  /**
   * 按会话持有：它把 `tool/call` 的参数记到 `tool/result` 用得上的时候。
   * 跨会话共用会让两个会话的同名 callId 互相串。
   */
  readonly presenter: ToolPresenter
  /**
   * 同样按会话持有：它把实时帧流开头那一帧的 turn/step 记到后续分片用得上的
   * 时候。跨会话共用会让两条会话的同名 attemptId 互相串。
   */
  readonly stream: AssistantStreamRelay
  inflight: InflightPrompt | undefined
}

/** 会话表。 */
export class SessionTable {
  readonly #records = new Map<SessionId, SessionRecord>()
  #nextSeq = 1
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  /** 下一个会话序号（连接内单调）。 */
  nextSeq(): number {
    return this.#nextSeq++
  }

  add(record: SessionRecord): void {
    this.#records.set(record.acpSessionId, record)
  }

  get(id: SessionId): SessionRecord | undefined {
    return this.#records.get(id)
  }

  /**
   * 按 agent 反查记录，并校验是同一对象（I2）。
   * @returns 本表拥有该 agent 时返回记录，否则 undefined
   */
  ownedBy(agent: Agent): SessionRecord | undefined {
    const record = this.#records.get(agent.id)
    return record?.handle.agent === agent ? record : undefined
  }

  values(): SessionRecord[] {
    return [...this.#records.values()]
  }

  /**
   * 摘掉一条记录（`session/close`）。
   *
   * **只从表里摘，不释放 agent**：释放是异步的，而摘除必须在同一个同步段里
   * 完成——否则 `await dispose()` 期间到达的事件仍会路由到一个正在拆的会话，
   * 而客户端已经认为它没了。调用方负责随后 dispose。
   * @returns 被摘掉的记录；本来就不在表里时 undefined
   */
  remove(id: SessionId): SessionRecord | undefined {
    const record = this.#records.get(id)
    if (record === undefined) return undefined
    this.#records.delete(id)
    return record
  }

  /** 标记关闭并取走全部记录，后续 add/get 不再生效（I3）。 */
  drain(): SessionRecord[] {
    this.#closed = true
    const records = this.values()
    this.#records.clear()
    return records
  }
}

/**
 * 结算某会话的在途 prompt；无在途时为 no-op。
 * @param record - 会话记录
 * @param reason - 结算原因
 */
export function settlePrompt(record: SessionRecord, reason: StopReason): void {
  const inflight = record.inflight
  if (inflight === undefined) return
  record.inflight = undefined
  inflight.resolve(reason)
}
