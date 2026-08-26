/**
 * TC-USAGE-* —— 上下文用量（US-24）。
 *
 * ACP 的 `usage_update` 是**上下文窗口占用**（`used` / `size`），不是累计花费。
 * 这个区别决定了两件事：各步不能相加（否则很快爆表），以及分母不知道时整条
 * 不发（编一个默认值会画出一根看起来权威、刻度却是错的进度条）。
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MODEL_OPTION } from '../src/config/options.js'
import { mapEvent } from '../src/mapping/updates.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { FAKE_MODEL_ALT } from './fake-llm.js'
import { realTempDir } from './temp-dir.js'

/** 一条带记账的 `assistant/message` 事件。 */
function messageWith(usage: Record<string, number> | undefined): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 1_700_000_000_000,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', id: 'm1', content: [] },
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SessionEvent
}

/** 客户端收到的用量更新。 */
function usageUpdates(seen: unknown[]): { used: number; size: number }[] {
  return seen.filter(
    (u): u is { sessionUpdate: string; used: number; size: number } =>
      (u as { sessionUpdate?: string }).sessionUpdate === 'usage_update',
  )
}

describe('TC-USAGE-01 记账 → 上下文占用', () => {
  it('输入侧三项相加，reasoning 不再加一次', () => {
    // 上游明确输入三项**不相交**（计费输入 = 三者之和）。少加缓存项，开着缓存
    // 的会话会显示成只用了一小半；而 `reasoningTokens` 是产出的一部分，
    // 再加一次就是重复计数。
    const updates = mapEvent(
      messageWith({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 8 }),
      { contextWindow: () => 8192 },
    )
    expect(updates).toEqual([{ sessionUpdate: 'usage_update', used: 155, size: 8192 }])
  })

  it('只有必填两项时也算得对', () => {
    expect(mapEvent(messageWith({ inputTokens: 7, outputTokens: 3 }), { contextWindow: () => 100 })).toEqual([
      { sessionUpdate: 'usage_update', used: 10, size: 100 },
    ])
  })

  it('适配器没给记账就不上报', () => {
    expect(mapEvent(messageWith(undefined), { contextWindow: () => 8192 })).toEqual([])
  })

  it('分母未知时整条不发 —— 不编默认值', () => {
    // `size` 在 ACP 里是必填。随便填一个，客户端会画出一根刻度错误但看起来
    // 完全正常的进度条——那比没有进度条更坏。
    for (const window of [undefined, 0]) {
      expect(mapEvent(messageWith({ inputTokens: 1, outputTokens: 1 }), { contextWindow: () => window })).toEqual([])
    }
    // 上下文里压根没给这个能力时同理（组合可插拔）。
    expect(mapEvent(messageWith({ inputTokens: 1, outputTokens: 1 }), {})).toEqual([])
  })

  it('每一步各报各的占用，不做累加', () => {
    // 累加会让 `used` 单调增长直到超过 `size`。上下文占用是**当前状态**，
    // 不是花费流水。
    const context = { contextWindow: () => 8192 }
    const first = mapEvent(messageWith({ inputTokens: 100, outputTokens: 20 }), context)
    const second = mapEvent(messageWith({ inputTokens: 300, outputTokens: 10 }), context)
    expect(first).toEqual([{ sessionUpdate: 'usage_update', used: 120, size: 8192 }])
    expect(second).toEqual([{ sessionUpdate: 'usage_update', used: 310, size: 8192 }])
  })
})

describe('TC-USAGE-02 端到端：一轮对话后客户端拿到占用', () => {
  /** 收集原始 update 负载。 */
  function collect(h: TestHarness): unknown[] {
    const seen: unknown[] = []
    h.onUpdate((update) => seen.push(update))
    return seen
  }

  it('跑完一轮后推出 usage_update，分母是当前模型的上下文窗口', async () => {
    const h = await createHarness()
    const seen = collect(h)
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-usage-'), mcpServers: [] })
    // **第一轮**就要有：窗口大小虽然要异步解析，但建会话时已经热过一次，
    // 所以用量条不会在会话开头空一轮。
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '一' }] })

    await waitFor(() => usageUpdates(seen).length > 0, 5_000, 'usage_update')
    const last = usageUpdates(seen).at(-1)
    // 8192 来自假适配器的 `resolveModel`；用例断言的是「分母确实取自适配器」，
    // 而不是某个写死在 bridge 里的数。
    expect(last?.size).toBe(8192)
    expect(last?.used).toBe(155)
    h.disposeBridge()
  }, 30_000)

  it('适配器不报记账时一条都不推', async () => {
    const h = await createHarness()
    const seen = collect(h)
    h.llm.usage = undefined
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-usage-'), mcpServers: [] })
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '一' }] })

    expect(usageUpdates(seen)).toEqual([])
    h.disposeBridge()
  }, 30_000)

  it('会话内换模型后，分母跟着换', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-usage-'), mcpServers: [] })
    // 先跑一轮，把第一个模型的窗口解析进缓存。
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '一' }] })

    const seen = collect(h)
    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_ALT as never,
    })
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '二' }] })

    await waitFor(() => usageUpdates(seen).length > 0, 5_000, 'usage_update')
    // 假适配器对两个模型报同一个窗口，所以这里断言的是「切模型之后仍然报得出
    // 来」——分母是**跟着当前选择重新查的**，而不是建会话时固化的一份快照。
    expect(usageUpdates(seen).at(-1)?.size).toBe(8192)
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL_ALT)
    h.disposeBridge()
  }, 30_000)
})
