/**
 * TC-TURN-* / TC-DISP-* —— 回合结算、流式增量、取消、释放。
 * 走真实 agent loop，只有模型是假的。
 */

import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createHarness, waitFor, type TestHarness } from './harness.js'

const CWD = tmpdir()
let harness: TestHarness | undefined

afterEach(() => {
  harness?.disposeBridge()
  harness = undefined
})

async function boot(): Promise<TestHarness> {
  const h = await createHarness()
  harness = h
  await h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return h
}

async function newSession(h: TestHarness): Promise<string> {
  const res = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
  return res.sessionId
}

const prompt = (h: TestHarness, sessionId: string, text = 'hi') =>
  h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })

describe('回合结算（US-03）', () => {
  it('正常完成的一轮报 end_turn', async () => {
    const h = await boot()
    const s = await newSession(h)
    const res = await prompt(h, s)
    expect(res.stopReason).toBe('end_turn')
  })

  it('助手文本按增量逐片送达，而非单次整段', async () => {
    const h = await boot()
    h.llm.deltas = ['A', 'B', 'C']
    const s = await newSession(h)
    await prompt(h, s)

    const chunks = h.updates.filter((u) => u.kind === 'agent_message_chunk' && u.sessionId === s)
    // 三个分片 → 三条更新。若实现改成缓冲整段，这里会退化成 1。
    expect(chunks.map((c) => c.text)).toEqual(['A', 'B', 'C'])
  })

  it('思考增量映射为 agent_thought_chunk 而非混入回复', async () => {
    const h = await boot()
    // 端到端而非只测映射函数：0.1.5 起推理与正文走的是同一条**进程内帧流**，
    // 而分流发生在帧的 `type` 上。只喂映射层的话，一个把两者都发成正文的
    // 中继实现照样能过。
    h.llm.reasoningDeltas = ['thi', 'nk']
    h.llm.deltas = ['ok']
    const s = await newSession(h)
    await prompt(h, s)

    const mine = h.updates.filter((u) => u.sessionId === s)
    expect(mine.filter((u) => u.kind === 'agent_thought_chunk').map((u) => u.text)).toEqual(['thi', 'nk'])
    expect(mine.filter((u) => u.kind === 'agent_message_chunk').map((u) => u.text)).toEqual(['ok'])
  })

  it('同一会话第二个在途 prompt 被拒（I1）', async () => {
    const h = await boot()
    h.llm.delayMs = 80
    const s = await newSession(h)
    const first = prompt(h, s, 'slow')
    await waitFor(() => h.llm.calls > 0, 3_000, 'model call started')
    await expect(prompt(h, s, 'second')).rejects.toThrow(/already in flight/i)
    await first
  })
})

describe('取消（US-04）', () => {
  it('session/cancel 结算该轮为 cancelled', async () => {
    const h = await boot()
    h.llm.delayMs = 200
    const s = await newSession(h)
    const inflight = prompt(h, s, 'slow')
    await waitFor(() => h.llm.calls > 0, 3_000, 'model call started')

    await h.acp.notify('session/cancel', { sessionId: s })
    const res = await inflight
    expect(res.stopReason).toBe('cancelled')
  })

  it('取消只影响本会话，兄弟会话不受干扰（AC-G3）', async () => {
    const h = await boot()
    h.llm.delayMs = 120
    const a = await newSession(h)
    const b = await newSession(h)

    const promptA = prompt(h, a, 'slow-a')
    const promptB = prompt(h, b, 'slow-b')
    await waitFor(() => h.llm.calls >= 2, 3_000, 'both calls started')

    await h.acp.notify('session/cancel', { sessionId: a })
    expect((await promptA).stopReason).toBe('cancelled')
    // B 未被取消，应正常结束
    expect((await promptB).stopReason).toBe('end_turn')
  })

  it('取消后可立即发起下一个 prompt（槽位已释放）', async () => {
    const h = await boot()
    h.llm.delayMs = 120
    const s = await newSession(h)
    const first = prompt(h, s, 'slow')
    await waitFor(() => h.llm.calls > 0, 3_000, 'model call started')
    await h.acp.notify('session/cancel', { sessionId: s })
    await first

    h.llm.delayMs = 0
    const second = await prompt(h, s, 'next')
    expect(second.stopReason).toBe('end_turn')
  })
})

describe('多会话流式隔离（US-05）', () => {
  it('两会话并发流式，各自更新携带正确的 sessionId 且不交错串台', async () => {
    const h = await boot()
    h.llm.deltas = ['x', 'y']
    const a = await newSession(h)
    const b = await newSession(h)

    await Promise.all([prompt(h, a), prompt(h, b)])

    const forA = h.updates.filter((u) => u.sessionId === a && u.kind === 'agent_message_chunk')
    const forB = h.updates.filter((u) => u.sessionId === b && u.kind === 'agent_message_chunk')
    expect(forA.map((u) => u.text)).toEqual(['x', 'y'])
    expect(forB.map((u) => u.text)).toEqual(['x', 'y'])
  })
})

describe('释放与孤儿（US-06）', () => {
  it('卸载 bridge 插件后其创建的 agent 被注销，不留孤儿', async () => {
    const h = await boot()
    const s = await newSession(h)
    expect(h.hasAgent(s)).toBe(true)

    h.disposeBridge()
    await waitFor(() => !h.hasAgent(s), 5_000, 'agent unregistered')
    expect(h.hasAgent(s)).toBe(false)
    harness = undefined
  })

  it('释放后新的 session/new 被拒（closed 守卫，I3）', async () => {
    const h = await boot()
    h.disposeBridge()
    harness = undefined
    await expect(
      h.acp.request('session/new', { cwd: CWD, mcpServers: [] }),
    ).rejects.toThrow(/disposed|closed/i)
  })

  it('释放时的在途 prompt 被结算为 cancelled，而非永挂', async () => {
    const h = await boot()
    h.llm.delayMs = 300
    const s = await newSession(h)
    const inflight = prompt(h, s, 'slow')
    await waitFor(() => h.llm.calls > 0, 3_000, 'model call started')

    h.disposeBridge()
    harness = undefined
    const res = await inflight
    expect(res.stopReason).toBe('cancelled')
  })

  it('重复释放共享同一个 teardown（幂等）', async () => {
    const h = await boot()
    await newSession(h)
    h.disposeBridge()
    expect(() => {
      h.disposeBridge()
    }).not.toThrow()
    harness = undefined
  })
})
