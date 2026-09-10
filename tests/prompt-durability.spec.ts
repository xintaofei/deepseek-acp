/**
 * TC-SESS-09 —— prompt 应答不得跑在自己的历史前面。
 *
 * 落盘是批量合并的（默认 200ms 窗口），而 `agent.whenIdle()` 不排空它：应答写
 * 出时那一轮很可能还在写入缓冲里。客户端拿到 `end_turn` 就退出（编辑器关掉、
 * 一次性脚本跑完）时，这一轮就此消失——重开会话只剩用户那半句话，而且**没有
 * 任何错误**，看起来像模型忘了自己说过什么。
 *
 * 所以这一组用例断的是**物理存储**，不是 `list()` 或轮询：判据必须是「应答之
 * 后一个字节都不用等」，任何等待都会把这个竞态掩盖掉。
 */

import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

describe('TC-SESS-09 prompt completion persists the final turn', () => {
  it('returns only after the completed assistant turn reaches the native log', async () => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-durable-') })
    try {
      const { sessionId } = await h.acp.request('session/new', {
        cwd: realTempDir('dsacp-durable-work-'), mcpServers: [],
      })
      h.llm.deltas = ['durable-final-answer']
      const response = await h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: 'hello' }],
      })
      expect(response.stopReason).toBe('end_turn')
      // Read physical storage before disposal or any polling can mask the gap.
      const raw = await h.ctx.get('sessionPersistence')!.readRaw(sessionId as never)
      expect(raw, 'prompt response must not precede its persisted history').toBeDefined()
      expect(raw?.content).toContain('durable-final-answer')
      expect(raw?.content).toContain('"turn/end"')
    } finally {
      await h.retire()
    }
  }, 30_000)

  it.each(['hello', '/plan off'])('reports flush failure and releases the prompt slot: %s', async (text) => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-durable-error-'), planMode: true })
    let stopFailure: (() => void) | undefined
    try {
      const { sessionId } = await h.acp.request('session/new', {
        cwd: realTempDir('dsacp-durable-work-'), mcpServers: [],
      })
      stopFailure = h.ctx.on('session/flush', () => { throw new Error('injected flush failure') })
      await expect(h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text }],
      })).rejects.toThrow('injected flush failure')
      // 这条错误的另一个去处是 stderr：客户端可能只显示「失败」甚至整个吞掉，
      // 而盘满 / 根目录不可写是部署侧的事故，运维得看得见它。
      expect(h.logs.some((l) => l.text.includes('completion failed: injected flush failure'))).toBe(true)
      stopFailure()
      await expect(h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text }],
      })).resolves.toMatchObject({ stopReason: 'end_turn' })
    } finally {
      stopFailure?.()
      await h.retire()
    }
  }, 30_000)

  it('can cancel while persistence is still blocked', async () => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-durable-cancel-') })
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let stopBlocking: (() => void) | undefined
    try {
      const { sessionId } = await h.acp.request('session/new', {
        cwd: realTempDir('dsacp-durable-work-'), mcpServers: [],
      })
      stopBlocking = h.ctx.on('session/flush', async () => { entered(); await blocked })
      const response = h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: 'hello' }],
      })
      await started
      await h.acp.notify('session/cancel', { sessionId })
      await expect(response).resolves.toMatchObject({ stopReason: 'cancelled' })
    } finally {
      release()
      stopBlocking?.()
      await h.retire()
    }
  }, 30_000)
})
