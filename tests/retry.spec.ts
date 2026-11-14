/**
 * TC-RETRY-* —— 模型请求失败后的重试（`dsh-llm-retry`）。
 *
 * 0.9.0 起组合里一直没挂这个插件：适配器把失败分好了类、带着默认策略，却没有人
 * 去执行，网络一抖这一轮就直接失败。这一组钉住挂上之后的四件事——可重试的错误真的
 * 重试并照常作答、必然再失败的不重试、退避中能立刻取消、重试用尽照常报错——外加
 * 用户在等待时看得见的那行提示，以及它在 `session/load` 里与当时一致。与图片卸载
 * （同一个钩子上的另一个处理者）共存由 `images.spec` 的 TC-IMG-04 在挂了重试插件的
 * 组合里再跑一遍来守。
 *
 * 退避用假适配器的策略压到 1 ms（`fakeRetryPolicy`）：数值本身归上游测，这里
 * 只关心「几次、最后怎样、用户看到了什么」。
 */

import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import LlmService, { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_PROVIDER_CONFIG,
  DEEPSEEK_RETRY_POLICY,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from '../src/launcher/boot.js'
import { mapEvent } from '../src/mapping/updates.js'
import { retryNoticeText } from '../src/mapping/retry-notice.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

type RawUpdate = Record<string, unknown>

/** 收下这个 harness 之后收到的每一条原始更新。 */
function capture(h: TestHarness): RawUpdate[] {
  const seen: RawUpdate[] = []
  h.onUpdate((u) => seen.push(u as RawUpdate))
  return seen
}

/** 助手消息分片拼起来的全文。 */
function messageText(updates: readonly RawUpdate[]): string {
  return updates
    .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
    .map((u) => (u['content'] as { text?: string }).text ?? '')
    .join('')
}

/** 其中的重试提示，按出现顺序。 */
function notices(updates: readonly RawUpdate[]): string[] {
  return updates
    .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
    .map((u) => (u['content'] as { text?: string }).text ?? '')
    .filter((text) => text.includes('次重试'))
}

async function newSession(h: TestHarness, cwd = realTempDir('dsacp-retry-')): Promise<string> {
  const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
  return String(sessionId)
}

function prompt(h: TestHarness, sessionId: string, text: string) {
  return h.acp.request('session/prompt', { sessionId: sessionId as never, prompt: [{ type: 'text', text }] })
}

describe('TC-RETRY-01 可重试的失败', () => {
  it('网络错误之后自动重试，这一轮照常作答', async () => {
    const h = await createHarness({ retry: true })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.failNext = [{ code: 'TRANSPORT', message: 'socket hang up' }]

    const result = await prompt(h, sessionId, '你好')
    expect(result.stopReason).toBe('end_turn')
    // 失败的一次 + 重试的一次。
    expect(h.llm.calls).toBe(2)
    expect(notices(seen)).toEqual(['\n\n（模型请求失败：网络连接出错。0.0 秒后第 1/3 次重试）\n\n'])
    expect(messageText(seen).endsWith('Hello')).toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('提示与这一步的回答共用一个 messageId —— 同一个气泡里按时间排着', async () => {
    const h = await createHarness({ retry: true })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.failNext = [{ code: 'SERVER', status: 503, message: 'overloaded' }]
    await prompt(h, sessionId, '你好')

    const chunks = seen.filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
    const ids = new Set(chunks.map((u) => u['messageId']))
    expect(ids.size).toBe(1)
    // 提示排在回答之前，且带上了 HTTP 状态码。
    expect((chunks[0]?.['content'] as { text: string }).text).toContain('服务端出错，HTTP 503')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-RETRY-02 不该重试的失败', () => {
  it('认证失败不重试 —— 必然再失败的不该再发一次计费请求', async () => {
    const h = await createHarness({ retry: true })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.failNext = [{ code: 'AUTH', status: 401, message: 'Authentication Fails' }]

    await expect(prompt(h, sessionId, '你好')).rejects.toThrow(/Authentication Fails/)
    expect(h.llm.calls).toBe(1)
    expect(notices(seen)).toEqual([])
    h.disposeBridge()
  }, 30_000)

  it('没挂重试插件时，同一个网络错误让这一轮立刻失败 —— 0.9.0 的行为，留作对照', async () => {
    // 这条是下面那些用例的前提自检：要是不挂插件也会重试，「挂上之后会重试」就
    // 什么都没证明。
    const h = await createHarness()
    const sessionId = await newSession(h)
    h.llm.failNext = [{ code: 'TRANSPORT', message: 'socket hang up' }]
    await expect(prompt(h, sessionId, '你好')).rejects.toThrow(/socket hang up/)
    expect(h.llm.calls).toBe(1)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-RETRY-03 退避中取消', () => {
  it('等待重试时 session/cancel 立刻结算为 cancelled，不再发起重试', async () => {
    // 退避拉到一分钟：取消若不打断等待，这条会超时，而不是碰巧通过。
    const h = await createHarness({
      retry: true,
      retryPolicy: { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } },
    })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.failNext = [{ code: 'TRANSPORT', message: 'socket hang up' }]

    const inflight = prompt(h, sessionId, '你好')
    await waitFor(() => notices(seen).length === 1, 5_000, 'retry notice')
    const started = Date.now()
    await h.acp.notify('session/cancel', { sessionId: sessionId as never })
    const result = await inflight
    expect(result.stopReason).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(h.llm.calls).toBe(1)

    // 槽位已释放，下一轮不受残留的等待影响。
    const next = await prompt(h, sessionId, '再来')
    expect(next.stopReason).toBe('end_turn')
    expect(h.llm.calls).toBe(2)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-RETRY-04 重试用尽', () => {
  it('次数用完照常报错，提示逐次递增；下一轮的计数从头开始', async () => {
    const h = await createHarness({
      retry: true,
      retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.failNext = [1, 2, 3].map((n) => ({ code: 'TIMEOUT', message: `timeout #${n}` }))

    await expect(prompt(h, sessionId, '你好')).rejects.toThrow(/timeout #3/)
    // 第一次 + 两次重试。
    expect(h.llm.calls).toBe(3)
    expect(notices(seen).map((text) => text.match(/第 (\d+\/\d+) 次/)?.[1])).toEqual(['1/2', '2/2'])

    // 计数是按步的：上一轮用光了，这一轮照样有两次。
    h.llm.failNext = [{ code: 'TIMEOUT', message: 'timeout again' }]
    const next = await prompt(h, sessionId, '再来')
    expect(next.stopReason).toBe('end_turn')
    expect(notices(seen).at(-1)).toContain('第 1/2 次重试')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-RETRY-05 重放与实时一致', () => {
  it('吐了半句话后网络断开：恢复出来的转录与当时逐字相同，提示夹在两次之间', async () => {
    const root = realTempDir('dsacp-retry-load-')
    const cwd = realTempDir('dsacp-retry-ws-')
    const h = await createHarness({ retry: true, sessionsRoot: root })
    const live = capture(h)
    const sessionId = await newSession(h, cwd)
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { code: 'TRANSPORT', message: 'connection reset' }
    await prompt(h, sessionId, '说点什么')
    await h.retire()

    const notice = '\n\n（模型请求失败：网络连接出错。0.0 秒后第 1/3 次重试）\n\n'
    expect(messageText(live)).toBe(`半句${notice}半句`)

    const restored = await createHarness({ retry: true, sessionsRoot: root })
    const replayed = capture(restored)
    await restored.acp.request('session/load', { sessionId: sessionId as never, cwd, mcpServers: [] })
    expect(messageText(replayed)).toBe(messageText(live))
    // 文本相同还不够：气泡按 messageId 分组。半句、提示、重来的回答在实时里是同一个
    // id，重放时也必须是同一个，否则恢复出来的是三个气泡。
    const ids = (updates: readonly RawUpdate[]) => [
      ...new Set(updates.filter((u) => u['sessionUpdate'] === 'agent_message_chunk').map((u) => u['messageId'])),
    ]
    expect(ids(live)).toHaveLength(1)
    expect(ids(replayed)).toEqual(ids(live))
    restored.disposeBridge()
  }, 30_000)
})

describe('TC-RETRY-06 提示文字', () => {
  const base = { retryId: 'r' as never, turn: 2, step: 1, provider: 'p', policyKey: 'k', delayMs: 1500 }

  it('普通模式带上限，常见错误码给中文说法', () => {
    expect(retryNoticeText({ ...base, mode: 'normal', retry: 2, maxRetries: 5, failure: { code: 'RATE_LIMIT', message: 'x', status: 429 } }))
      .toBe('\n\n（模型请求失败：请求被限流，HTTP 429。1.5 秒后第 2/5 次重试）\n\n')
  })

  it('always 模式没有上限，只说第几次；不认识的错误码原样给出', () => {
    expect(retryNoticeText({ ...base, mode: 'always', retry: 7, failure: { code: 'PI_AI_ERROR', message: 'x' } }))
      .toBe('\n\n（模型请求失败：PI_AI_ERROR。1.5 秒后第 7 次重试）\n\n')
  })

  it('映射：llm/retry 出一条助手分片，id 是那一步的；llm/retry-started 不出更新', () => {
    const retryEvent = {
      type: 'llm/retry',
      data: { ...base, mode: 'normal', retry: 1, maxRetries: 5, failure: { code: 'TRANSPORT', message: 'x' } },
    } as unknown as SessionEvent
    expect(mapEvent(retryEvent)).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: '2:1',
        content: { type: 'text', text: '\n\n（模型请求失败：网络连接出错。1.5 秒后第 1/5 次重试）\n\n' },
      },
    ])
    const startedEvent = { type: 'llm/retry-started', data: { retryId: 'r', turn: 2, step: 1, retry: 1 } } as unknown as SessionEvent
    expect(mapEvent(startedEvent)).toEqual([])
  })
})

describe('TC-RETRY-07 响应流中途断开（STREAM_CLOSED，#5）', () => {
  /** 退避压到 1 ms、次数照部署：只换「多久」，不换「重试哪些码」。 */
  const deployedCodes = { ...DEEPSEEK_RETRY_POLICY, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }

  it('官方路由真正生效的策略：上游默认的每个码都在，另加 STREAM_CLOSED', async () => {
    // 挂真的适配器与部署配置，读运行时**捕获下来**的策略，而不是只看我们传了什么：
    // 适配器若不接这个字段（或换了名字），这里拿到的就是上游默认，用例会红。
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DEEPSEEK_API_KEY: 'sk-offline-retry-fixture' } },
    ]))
    await ctx.plugin(LlmService)
    // 非官方源：不去拉 `/models` 列表，一个包都不发（理由见 models.spec 的 OFFLINE_BASE_URL）。
    await ctx.plugin(LlmDeepSeek, { ...DEEPSEEK_PROVIDER_CONFIG, baseURL: 'https://retry-fixture.invalid/anthropic' })

    const prepared = await ctx.llm.prepareCall({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL })
    const policy = prepared.retryPolicy
    const upstream = resolveRetryPolicy(undefined, 'upstream default')
    if (policy.mode !== 'normal' || upstream.mode !== 'normal') throw new Error('expected normal-mode policies')

    expect(policy.retryableCodes).toContain('STREAM_CLOSED')
    // 是在上游默认之上**加**一个，不是换掉：哪天上游默认多了一个码，也照样继承。
    expect(policy.retryableCodes).toEqual(expect.arrayContaining([...upstream.retryableCodes]))
    expect(policy.retryableCodes).toHaveLength(upstream.retryableCodes.length + 1)
    // 次数与退避仍是上游默认。
    expect(policy.maxRetries).toBe(upstream.maxRetries)
    expect(policy.initialDelayMs).toBe(upstream.initialDelayMs)
    expect(policy.maxDelayMs).toBe(upstream.maxDelayMs)
  })

  it('吐了半句后流被截断：照部署的策略重试，这一轮照常作答，提示说清是流断了', async () => {
    const h = await createHarness({ retry: true, retryPolicy: deployedCodes })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { code: 'STREAM_CLOSED', message: 'DeepSeek Messages stream ended before message_stop' }

    const result = await prompt(h, sessionId, '说点什么')
    expect(result.stopReason).toBe('end_turn')
    expect(h.llm.calls).toBe(2)
    expect(notices(seen)).toHaveLength(1)
    expect(notices(seen)[0]).toContain('响应流中途断开')
    expect(messageText(seen)).toBe(`半句${notices(seen)[0]}半句`)
    h.disposeBridge()
  }, 30_000)

  it('对照：上游默认的码表不重试 STREAM_CLOSED —— 上一条重试成功靠的是部署的策略', async () => {
    // 不给 `retryableCodes`，即上游默认。要是这里也重试了，上一条就什么都没证明。
    const h = await createHarness({
      retry: true,
      retryPolicy: { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.failNext = [{ code: 'STREAM_CLOSED', message: 'stream ended before message_stop' }]

    await expect(prompt(h, sessionId, '你好')).rejects.toThrow(/stream ended before message_stop/)
    expect(h.llm.calls).toBe(1)
    expect(notices(seen)).toEqual([])
    h.disposeBridge()
  }, 30_000)
})
