/**
 * TC-COMPACT-* —— 上下文压缩的线上映射。
 *
 * 上游把一次压缩记成三条**日志事件**（`start` 持锁 → `summary` 带摘要 → `end`
 * 放锁），ACP 那边是一个按 id upsert 的实体加一串摘要分片。这里断的就是这层翻译。
 *
 * 用纯 `mapEvent` 而不是端到端跑一次真压缩：触发压缩要把上下文顶到阈值以上，
 * 那需要几十轮真实对话，跑一次几分钟，而它验证的东西（阈值策略、摘要质量）全在
 * 上游那一侧。这层要保证的只有一件事——事件翻对了没有。
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { mapEvent } from '../src/mapping/updates.js'
import { clientSupportsCompaction } from '../src/protocol/initialize.js'
import { createHarness, waitFor } from './harness.js'
import { realTempDir } from './temp-dir.js'

const ID = 'cmp-1'

/** 造一条压缩日志事件。 */
const event = (type: string, data: Record<string, unknown>): SessionEvent =>
  ({ type, data: { compactionId: ID, ...data } }) as never

/** 打开了压缩能力的映射上下文。 */
const ON = { compaction: true }

describe('TC-COMPACT-01 事件 → ACP 更新', () => {
  it('start → in_progress', () => {
    expect(mapEvent(event('compaction/start', { turn: 3 }), ON)).toEqual([
      { sessionUpdate: 'compaction_update', compactionId: ID, status: 'in_progress' },
    ])
  })

  it('summary → 逐块摘要分片', () => {
    const updates = mapEvent(
      event('compaction/summary', {
        summary: [
          { type: 'text', text: '前半段在改构建脚本。' },
          { type: 'text', text: '后半段在修测试。' },
        ],
        shadowedRange: { start: 2, end: 40 },
        shadowedSeqs: [2, 3],
        shadowedTokenCount: 1234,
        provider: 'p',
        model: 'm',
      }),
      ON,
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: ID,
        content: { type: 'text', text: '前半段在改构建脚本。' },
      },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: ID,
        content: { type: 'text', text: '后半段在修测试。' },
      },
    ])
  })

  it('摘要里的非文本块被跳过', () => {
    // 摘要理论上是任意内容块，但「这段历史被压成了什么」这件事上，图片或工具
    // 调用没有意义，而 ACP 的分片一次只带一块。
    const updates = mapEvent(
      event('compaction/summary', {
        summary: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }, { type: 'text', text: '正文' }],
        shadowedRange: { start: 1, end: 2 },
        shadowedSeqs: [1],
        shadowedTokenCount: 1,
        provider: 'p',
        model: 'm',
      }),
      ON,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ content: { type: 'text', text: '正文' } })
  })

  it('end 不带 error → completed，且**不重发摘要**', () => {
    const updates = mapEvent(event('compaction/end', { turn: 3 }), ON)
    expect(updates).toEqual([
      { sessionUpdate: 'compaction_update', compactionId: ID, status: 'completed' },
    ])
    // 摘要已经由分片建起来了，`summary` 字段是补丁语义（省略即保持不变）。
    // 再发一遍不是冗余而是**违规**：规范只允许非空 summary 与 completed 同行，
    // 而重发意味着我们得把它从上一条事件里记下来——那就要在这层攒状态。
    expect(updates[0]).not.toHaveProperty('summary')
  })

  it('end 带 error → failed，原因原样带上', () => {
    expect(mapEvent(event('compaction/end', { turn: 3, error: '模型没返回摘要' }), ON)).toEqual([
      {
        sessionUpdate: 'compaction_update',
        compactionId: ID,
        status: 'failed',
        error: '模型没返回摘要',
      },
    ])
  })
})

describe('TC-COMPACT-02 客户端没声明就一条都不发', () => {
  it('三种事件在缺省上下文下都不产出更新', () => {
    // 规范这里用的是 MUST：「Agents MUST only send this update when the Client
    // advertised ClientSessionCapabilities::compaction」。
    for (const e of [
      event('compaction/start', { turn: 1 }),
      event('compaction/summary', {
        summary: [{ type: 'text', text: 'x' }],
        shadowedRange: { start: 1, end: 2 },
        shadowedSeqs: [1],
        shadowedTokenCount: 1,
        provider: 'p',
        model: 'm',
      }),
      event('compaction/end', { turn: 1 }),
    ]) {
      expect(mapEvent(e), e.type).toEqual([])
    }
  })

  it('能力位读的是 clientCapabilities.session.compaction', () => {
    const probe = (clientCapabilities: unknown): boolean =>
      clientSupportsCompaction({ protocolVersion: 1, clientCapabilities } as never)
    // 「给了对象就是支持」，与 elicitation 同一套语义。
    expect(probe({ session: { compaction: {} } })).toBe(true)
    expect(probe({ session: { compaction: null } })).toBe(false)
    expect(probe({ session: {} })).toBe(false)
    expect(probe({})).toBe(false)
    expect(probe(undefined)).toBe(false)
  })

  /**
   * 握手 → 建会话 → 把一条 `compaction/start` 喂进事件总线，返回客户端收到的更新。
   *
   * 直接发事件而不是真触发一次压缩：要把上下文顶到阈值以上得跑几十轮对话，而那
   * 验证的是上游的阈值策略，不是本层的接线。这里要证的只有「握手读到的能力位有
   * 没有真的走到发送那一步」——它中间隔着 bridge 字段与映射上下文两跳，纯函数
   * 用例覆盖不到。
   */
  async function updatesFor(clientCapabilities: unknown): Promise<Record<string, unknown>[]> {
    const h = await createHarness()
    await h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities } as never)
    const { sessionId } = await h.acp.request('session/new', {
      cwd: realTempDir('dsacp-compact-'),
      mcpServers: [],
    })
    const seen: Record<string, unknown>[] = []
    h.onUpdate((u) => seen.push(u as Record<string, unknown>))
    const session = h.ctx.agents.get(String(sessionId) as never)?.session
    expect(session, '会话应当还活着').toBeDefined()
    h.ctx.emit('session/event', session as never, event('compaction/start', { turn: null }) as never)
    // 通知是排到微任务里发的，`disposeBridge()` 紧跟着调会把它掐掉。
    await waitFor(
      () => seen.some((u) => String(u['sessionUpdate']).startsWith('compaction')),
      2_000,
      'compaction update',
    ).catch(() => {})
    h.disposeBridge()
    return seen.filter((u) => String(u['sessionUpdate']).startsWith('compaction'))
  }

  it('客户端声明了就发得出去', async () => {
    expect(await updatesFor({ session: { compaction: {} } })).toEqual([
      { sessionUpdate: 'compaction_update', compactionId: ID, status: 'in_progress' },
    ])
  }, 30_000)

  it('客户端没声明就一条都不发 —— 握手结果真的走到了发送那一步', async () => {
    expect(await updatesFor({})).toEqual([])
  }, 30_000)
})
