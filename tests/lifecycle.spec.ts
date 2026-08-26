/**
 * TC-CLOSE-* / TC-RESUME-* —— 会话生命周期的另两个稳定方法。
 *
 * `session/close` 补的是一个真实泄漏：`SessionTable` 原先唯一的移除路径是
 * `drain()`，只在断连或插件卸载时调，于是会话一路累积到连接结束。
 *
 * `session/resume` 与 `session/load` 只差一件事——回不回放历史。两条路径共用同
 * 一段恢复逻辑，所以这里既测差异（回放与否），也测共性（cwd 校验、能力声明）。
 */

import { describe, expect, it } from 'vitest'
import { describeClient } from '../src/protocol/initialize.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

/** 建一个会话、跑一轮并完全退休录制端，返回可供恢复的 id 与 cwd。 */
async function persistedSession(h: TestHarness): Promise<{ sessionId: string; cwd: string }> {
  const cwd = realTempDir('dsacp-life-')
  const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
  await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '你好' }] })
  h.disposeBridge()
  await h.retire()
  return { sessionId: String(sessionId), cwd }
}

describe('TC-CLOSE-01 关闭会话释放资源', () => {
  it('关掉之后 agent 不再存活，且同一个 id 不能再发 prompt', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-life-')
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
    expect(h.hasAgent(String(sessionId))).toBe(true)

    await h.acp.request('session/close', { sessionId })

    expect(h.hasAgent(String(sessionId))).toBe(false)
    // 断**具体的**错：只断 `toThrow()` 抓不到「记录还留在会话表里」这种漏
    // ——那时 prompt 照样失败，只是理由变成了「agent 已释放」。
    await expect(
      h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '还在吗' }] }),
    ).rejects.toThrow(/unknown session/)
    // 再关一次必须报未知会话。这一条才真正钉住「从表里摘掉了」：`hasAgent`
    // 读的是上游注册表（`dispose` 会清），单看它分辨不出 bridge 自己有没有漏。
    await expect(h.acp.request('session/close', { sessionId })).rejects.toThrow(/unknown session/)
    h.disposeBridge()
  }, 30_000)

  it('关闭不波及兄弟会话（AC-G3）', async () => {
    const h = await createHarness()
    const a = await h.acp.request('session/new', { cwd: realTempDir('dsacp-life-'), mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: realTempDir('dsacp-life-'), mcpServers: [] })

    await h.acp.request('session/close', { sessionId: a.sessionId })

    expect(h.hasAgent(String(a.sessionId))).toBe(false)
    expect(h.hasAgent(String(b.sessionId))).toBe(true)
    // 兄弟会话仍然能正常跑完一轮。
    const done = await h.acp.request('session/prompt', {
      sessionId: b.sessionId,
      prompt: [{ type: 'text', text: '你还在' }],
    })
    expect(done.stopReason).toBe('end_turn')
    h.disposeBridge()
  }, 30_000)

  it('关闭未知会话是显式错误，不是静默成功', async () => {
    // 与 `session/cancel` 相反：那是通知、没有应答，且并发下可能取消一个刚被
    // 释放的会话，所以静默。close 有应答，客户端据此认为资源已释放——悄悄成功
    // 会让「关了但没关掉」无从发现。
    const h = await createHarness()
    await expect(h.acp.request('session/close', { sessionId: 'nope' })).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)

  it('关闭会把在途的 prompt 收成 cancelled，而不是留一个挂着的请求', async () => {
    // 注意这条**不**是 `settlePrompt` 那一行的专属证明：`handlePrompt` 挂在
    // `whenIdle` 上的回调也会判成 cancelled，只是要等释放跑完。这里钉的是
    // 对外可观测的契约（不挂起、语义是取消），两条路径都得满足它。
    const h = await createHarness()
    h.llm.delayMs = 5_000 // 制造一个足够长的在途窗口
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-life-'), mcpServers: [] })

    const inflight = h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '慢慢来' }] })
    await waitFor(() => h.llm.calls > 0, 5_000, 'model call started')
    await h.acp.request('session/close', { sessionId })

    // 结算成 `cancelled` 而不是挂住：客户端那边这是一个开着的 JSON-RPC 请求。
    await expect(inflight).resolves.toMatchObject({ stopReason: 'cancelled' })
    h.disposeBridge()
  }, 30_000)
})

describe('TC-RESUME-01 恢复但不回放', () => {
  it('resume 不产出任何历史更新，load 会', async () => {
    const root = realTempDir('dsacp-resume-root-')
    const first = await createHarness({ sessionsRoot: root })
    const { sessionId, cwd } = await persistedSession(first)

    // 换一条连接恢复，与真实的「重开编辑器」一致。
    const resumed = await createHarness({ sessionsRoot: root })
    await resumed.acp.request('session/resume', { sessionId, cwd, mcpServers: [] })
    const afterResume = resumed.updates.filter((u) => u.kind.endsWith('_message_chunk')).length
    expect(afterResume).toBe(0)
    resumed.disposeBridge()
    await resumed.retire()

    const loaded = await createHarness({ sessionsRoot: root })
    await loaded.acp.request('session/load', { sessionId, cwd, mcpServers: [] })
    const afterLoad = loaded.updates.filter((u) => u.kind.endsWith('_message_chunk')).length
    // 同一条日志、同一个恢复段，差别**只**在回放。
    expect(afterLoad).toBeGreaterThan(0)
    loaded.disposeBridge()
  }, 60_000)

  it('恢复出来的会话是活的，能接着聊', async () => {
    const root = realTempDir('dsacp-resume-live-')
    const first = await createHarness({ sessionsRoot: root })
    const { sessionId, cwd } = await persistedSession(first)

    const h = await createHarness({ sessionsRoot: root })
    await h.acp.request('session/resume', { sessionId, cwd, mcpServers: [] })
    const done = await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '接着说' }],
    })
    expect(done.stopReason).toBe('end_turn')
    expect(h.hasAgent(sessionId)).toBe(true)
    h.disposeBridge()
  }, 60_000)

  it('相对 cwd 被拒 —— validateRestore 那一半', async () => {
    // 与下一条分开测：cwd 的两条约束落在**不同函数**里。这条是
    // `validateRestore`（绝对路径），下一条是 `restoreSession`（与日志一致）。
    // 合成一条的话，改坏其中一个不会有任何用例变红。
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-resume-rel-') })
    await expect(
      h.acp.request('session/resume', { sessionId: 'x', cwd: 'relative/path', mcpServers: [] }),
    ).rejects.toThrow(/absolute/)
    h.disposeBridge()
  }, 30_000)

  it('cwd 与日志不符时拒绝 —— restoreSession 那一半，与 load 共用', async () => {
    // 工作区是不可变会话元数据。允许它变意味着可以把 A 项目的历史恢复进 B
    // 项目的工作区，模型会拿着 A 的文件路径去改 B 的文件。共用恢复段就是为了
    // 这条校验不会只在一边生效。
    const root = realTempDir('dsacp-resume-cwd-')
    const first = await createHarness({ sessionsRoot: root })
    const { sessionId } = await persistedSession(first)

    const h = await createHarness({ sessionsRoot: root })
    await expect(
      h.acp.request('session/resume', { sessionId, cwd: realTempDir('dsacp-life-'), mcpServers: [] }),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 60_000)
})

describe('TC-DIAG-01 握手能力位摘要', () => {
  it('缺席与显式 false 分得开 —— 排查时是两种不同的信号', () => {
    // 前者是老客户端（压根不认识这个位），后者是明确不支持。把两者都折成
    // `false` 会让「这个编辑器为什么不弹表单」少掉一半线索。
    const absent = describeClient({ protocolVersion: 1, clientCapabilities: {} } as never)
    expect(absent).toContain('fs.readTextFile=（未声明）')
    expect(absent).toContain('elicitation.form=（未声明）')

    const explicit = describeClient({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false }, elicitation: { form: {} } },
    } as never)
    expect(explicit).toContain('fs.readTextFile=false')
    expect(explicit).toContain('elicitation.form={}')
  })
})

describe('TC-RESUME-02 能力声明跟着组合走', () => {
  it('挂了持久化：list / resume 出现，loadSession 也在', async () => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-caps-') })
    const init = await h.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const caps = init.agentCapabilities as {
      loadSession?: boolean
      sessionCapabilities?: Record<string, unknown>
    }
    expect(caps.loadSession).toBe(true)
    expect(Object.keys(caps.sessionCapabilities ?? {}).sort()).toEqual(['close', 'fork', 'list', 'resume'])
    h.disposeBridge()
  }, 30_000)

  it('没挂持久化：只剩 close 与 fork —— 两者要的都不是「能从日志恢复」', async () => {
    const h = await createHarness()
    const init = await h.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const caps = init.agentCapabilities as {
      loadSession?: boolean
      sessionCapabilities?: Record<string, unknown>
    }
    expect(caps.loadSession).toBeUndefined()
    // `close` 释放的是进程内资源；`fork` 的种子首选取自**活的**父会话，那条路径
    // 同样不碰持久化（退化成「只能 fork 开着的会话」，而在会话随进程消失的部署里
    // 那本就是唯一说得通的语义）。少掉的 `list` / `resume` 才是真正跟着日志走的。
    expect(Object.keys(caps.sessionCapabilities ?? {}).sort()).toEqual(['close', 'fork'])
    h.disposeBridge()
  }, 30_000)

  it('没挂持久化时调 resume 直接 methodNotFound —— 声明与实现同一个真值来源', async () => {
    const h = await createHarness()
    await expect(
      h.acp.request('session/resume', { sessionId: 'x', cwd: realTempDir('dsacp-life-'), mcpServers: [] }),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)
})
