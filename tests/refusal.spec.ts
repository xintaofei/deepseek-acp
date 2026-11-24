/**
 * TC-REFUSE-* —— 内容安全拒答（`CONTENT_REFUSED`，DSH 0.2.2-rc.5 起）。
 *
 * DeepSeek 以 `stop_reason: "refusal"` 结束响应流时，上游适配器报完用量后以
 * `CONTENT_REFUSED` 失败。这一组钉住本适配器的处理（理由见
 * `src/mapping/refusal-notice.ts`）：
 *
 *  - 这一轮以 `end_turn` 结算，而不是 JSON-RPC 内部错误；原因（含 provider 的说明）
 *    写进转录，且部署的重试策略不重试它。
 *  - `session/load` 恢复出来的转录与当时逐字一致。
 *  - 提示里说的「回答不进上下文、提问还在」与下一次请求的历史相符。
 *  - 其余失败照旧以 prompt 错误浮现（对照）。
 *
 * 另有一条直接喂上游 `translate` 一段拒答事件：说明是从上游错误消息里剥出来的，
 * 上游改了措辞，这条会先红。
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { DEEPSEEK_RETRY_POLICY } from '../src/launcher/boot.js'
import { refusalNoticeText } from '../src/mapping/refusal-notice.js'
import { mapEvent } from '../src/mapping/updates.js'
import { createHarness, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

type RawUpdate = Record<string, unknown>

/** 上游 `translate.ts` 带说明时的原话。 */
const UPSTREAM_MESSAGE = 'DeepSeek refused to answer under its content safety review: image #1 was blocked'

/** 退避压到 1 ms、可重试码照部署：拒答若被重试，`calls` 会多出来。 */
const deployedCodes = { ...DEEPSEEK_RETRY_POLICY, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }

function capture(h: TestHarness): RawUpdate[] {
  const seen: RawUpdate[] = []
  h.onUpdate((u) => seen.push(u as RawUpdate))
  return seen
}

function messageText(updates: readonly RawUpdate[]): string {
  return updates
    .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
    .map((u) => (u['content'] as { text?: string }).text ?? '')
    .join('')
}

async function newSession(h: TestHarness, cwd = realTempDir('dsacp-refuse-')): Promise<string> {
  const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
  return String(sessionId)
}

function prompt(h: TestHarness, sessionId: string, text: string) {
  return h.acp.request('session/prompt', { sessionId: sessionId as never, prompt: [{ type: 'text', text }] })
}

describe('TC-REFUSE-01 拒答以正常结束结算，原因进转录', () => {
  it('吐了半句后被拒：end_turn、不重试，半句之后接上带说明的提示', async () => {
    const h = await createHarness({ retry: true, retryPolicy: deployedCodes })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { code: 'CONTENT_REFUSED', message: UPSTREAM_MESSAGE }

    const result = await prompt(h, sessionId, '看看这张图')
    expect(result.stopReason).toBe('end_turn')
    expect(h.llm.calls).toBe(1)
    const notice = refusalNoticeText({ message: UPSTREAM_MESSAGE })
    expect(messageText(seen)).toBe(`半句${notice}`)
    expect(notice).toContain('原因：image #1 was blocked。')
    // 不是重试提示：拒答不该被描述成「请求失败、N 秒后重试」。
    expect(messageText(seen)).not.toContain('次重试')
    h.disposeBridge()
  }, 30_000)

  it('提示里说的与下一次请求相符：被拒的回答不在历史里，提问还在', async () => {
    const h = await createHarness({ retry: true, retryPolicy: deployedCodes })
    const sessionId = await newSession(h)
    h.llm.deltas = ['被拒的半句']
    h.llm.errorFinishOnce = { code: 'CONTENT_REFUSED', message: UPSTREAM_MESSAGE }
    await prompt(h, sessionId, '第一问')

    h.llm.deltas = ['Hello']
    const next = await prompt(h, sessionId, '第二问')
    expect(next.stopReason).toBe('end_turn')
    const history = h.llm.historiesUsed.at(-1)?.join('\n') ?? ''
    expect(history).toContain('第一问')
    expect(history).toContain('第二问')
    expect(history).not.toContain('被拒的半句')
    h.disposeBridge()
  }, 30_000)

  it('对照：别的不重试的失败照旧以 prompt 错误浮现，不出拒答提示', async () => {
    const h = await createHarness({ retry: true, retryPolicy: deployedCodes })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { code: 'INVALID_REQUEST', message: 'bad image' }

    await expect(prompt(h, sessionId, '看看这张图')).rejects.toThrow(/turn failed: bad image/)
    expect(messageText(seen)).not.toContain('拒绝回答')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-REFUSE-04 命令起的回合被拒', () => {
  it('/plan 带正文时被拒：同样以 end_turn 结算并带提示，而不是内部错误', async () => {
    // 命令路径的在途槽位没有回合号，`agent/error` 先于 `turn/end` 到达——那个监听器
    // 不让开的话，这里会以「turn failed」拒绝。
    const h = await createHarness({ planMode: true, retry: true, retryPolicy: deployedCodes })
    const seen = capture(h)
    const sessionId = await newSession(h)
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { code: 'CONTENT_REFUSED', message: UPSTREAM_MESSAGE }

    const result = await prompt(h, sessionId, '/plan 看看这张图')
    expect(result.stopReason).toBe('end_turn')
    expect(h.llm.calls).toBe(1)
    expect(messageText(seen)).toContain(refusalNoticeText({ message: UPSTREAM_MESSAGE }))
    h.disposeBridge()
  }, 30_000)
})

describe('TC-REFUSE-02 重放与实时一致', () => {
  it('恢复出来的转录与当时逐字相同，提示仍在半句之后', async () => {
    const root = realTempDir('dsacp-refuse-load-')
    const cwd = realTempDir('dsacp-refuse-ws-')
    const h = await createHarness({ retry: true, retryPolicy: deployedCodes, sessionsRoot: root })
    const live = capture(h)
    const sessionId = await newSession(h, cwd)
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { code: 'CONTENT_REFUSED', message: UPSTREAM_MESSAGE }
    await prompt(h, sessionId, '看看这张图')
    await h.retire()

    const restored = await createHarness({ retry: true, sessionsRoot: root })
    const replayed = capture(restored)
    await restored.acp.request('session/load', { sessionId: sessionId as never, cwd, mcpServers: [] })
    expect(messageText(live)).toContain('拒绝回答')
    expect(messageText(replayed)).toBe(messageText(live))
    restored.disposeBridge()
  }, 30_000)
})

describe('TC-REFUSE-03 映射与文字', () => {
  const turnEnd = (reason: unknown) => ({ type: 'turn/end', data: { turn: 3, reason } }) as unknown as SessionEvent

  it('只有 CONTENT_REFUSED 出更新，且不带 messageId（turn/end 上没有 step）', () => {
    const updates = mapEvent(turnEnd({ kind: 'error', error: { code: 'CONTENT_REFUSED', message: UPSTREAM_MESSAGE } }))
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: refusalNoticeText({ message: UPSTREAM_MESSAGE }) } },
    ])
    expect(mapEvent(turnEnd({ kind: 'error', error: { code: 'AUTH', message: 'nope' } }))).toEqual([])
    expect(mapEvent(turnEnd({ kind: 'completed' }))).toEqual([])
  })

  it('说明从上游外壳里剥出来；没有说明就不写「原因」；认不出的消息原样给出', () => {
    expect(refusalNoticeText({ message: UPSTREAM_MESSAGE })).toContain('原因：image #1 was blocked。')
    expect(refusalNoticeText({ message: `${UPSTREAM_MESSAGE}.` })).toContain('原因：image #1 was blocked。')
    const bare = refusalNoticeText({ message: 'DeepSeek refused to answer under its content safety review' })
    expect(bare).not.toContain('原因')
    expect(bare.startsWith('\n\n（模型拒绝回答：未通过 DeepSeek 的内容安全审查。这次的回答')).toBe(true)
    expect(refusalNoticeText({ message: 'blocked by policy X' })).toContain('原因：blocked by policy X。')
  })

  it('上游 translate 遇到 refusal：先报用量，再以 CONTENT_REFUSED 失败，消息形状与本适配器的解析对得上', async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }
      yield { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { explanation: 'image #1 was blocked' } }, usage: { output_tokens: 3 } }
      yield { type: 'message_stop' }
    }
    // 包的 `./src/*` 子路径导出：`translate` 不在主入口上。用动态导入是因为本仓库的
    // tsconfig 不允许以 `.ts` 结尾的静态导入；签名只取这里用到的部分。
    const specifier = '@deepseek-ai/dsh-llm-deepseek/src/translate.ts'
    const { translate } = (await import(specifier)) as {
      translate: (events: AsyncIterable<Record<string, unknown>>, model: string) => AsyncIterable<{ type: string }>
    }
    const chunks: { type: string }[] = []
    let failure: unknown
    try {
      for await (const chunk of translate(events(), 'deepseek-v4-pro')) chunks.push(chunk)
    } catch (error: unknown) {
      failure = error
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(['usage'])
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('CONTENT_REFUSED')
    expect((failure as LlmError).message).toBe(UPSTREAM_MESSAGE)
  })
})
