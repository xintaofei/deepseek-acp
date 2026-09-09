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
    const { sessionId } = await h.acp.request('session/new', {
      cwd: realTempDir('dsacp-durable-work-'), mcpServers: [],
    })
    const stopFailure = h.ctx.on('session/flush', () => { throw new Error('injected flush failure') })
    try {
      await expect(h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text }],
      })).rejects.toThrow('injected flush failure')
      stopFailure()
      await expect(h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text }],
      })).resolves.toMatchObject({ stopReason: 'end_turn' })
    } finally {
      stopFailure()
      await h.retire()
    }
  }, 30_000)

  it('can cancel while persistence is still blocked', async () => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-durable-cancel-') })
    const { sessionId } = await h.acp.request('session/new', {
      cwd: realTempDir('dsacp-durable-work-'), mcpServers: [],
    })
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const stopBlocking = h.ctx.on('session/flush', async () => { entered(); await blocked })
    try {
      const response = h.acp.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: 'hello' }],
      })
      await started
      await h.acp.notify('session/cancel', { sessionId })
      await expect(response).resolves.toMatchObject({ stopReason: 'cancelled' })
    } finally {
      release()
      stopBlocking()
      await h.retire()
    }
  }, 30_000)
})
