/**
 * TC-FORK-* —— `session/fork`（以一条会话的上下文另开一支）。
 *
 * 这条链有三处**只靠形状看不出来**的地方，用例分别钉住：
 *  1. 「继承了上下文」的判据是父会话的对话**进了子会话的请求**，不是子会话的
 *     日志里有那些字节。前者才是这个功能的定义。
 *  2. 「另开一支」的判据是子会话继续聊之后**父会话没变**。只测子会话拿到了历史，
 *     一个错误实现（其实是 resume）也照样通过。
 *  3. 父会话可以是**没打开的**（只在磁盘上）。上游 `SessionStore.fork` 明确把这
 *     种源排除在外，而 ACP 的客户端从会话列表里挑一条去 fork 是完全正常的用法。
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { aliasDir, realTempDir } from './temp-dir.js'

/** 建会话并聊一轮，返回会话 id。 */
async function chat(h: TestHarness, cwd: string, text: string): Promise<string> {
  const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
  await h.acp.request('session/prompt', {
    sessionId: sessionId as never,
    prompt: [{ type: 'text', text }],
  })
  return String(sessionId)
}

/** 最后一次请求带的对话历史，压成 `角色:文本`。 */
function lastHistory(h: TestHarness): string[] {
  return h.llm.historiesUsed.at(-1) ?? []
}

describe('TC-FORK-01 能力声明', () => {
  it('无条件 advertise —— 活会话那条路径不碰持久化', async () => {
    // 故意**不挂**持久化。fork 在这种组合里退化成「只能 fork 开着的会话」，
    // 但那仍然是能用的；按持久化声明会把它整个藏掉。
    const h = await createHarness()
    const response = await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    const caps = (response.agentCapabilities ?? {}) as {
      sessionCapabilities?: { fork?: unknown; list?: unknown; resume?: unknown }
    }
    expect(caps.sessionCapabilities?.fork).toEqual({})
    // 对照：这两个确实跟着持久化走，没挂就不声明。同一个应答里两种策略并存，
    // 说明「无条件」是选择而不是漏改。
    expect(caps.sessionCapabilities?.list).toBeUndefined()
    expect(caps.sessionCapabilities?.resume).toBeUndefined()
    h.disposeBridge()
  }, 30_000)
})

describe('TC-FORK-02 继承上下文', () => {
  it('子会话是新 id，且第一次请求就带着父会话聊过的内容', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-ws-')
    h.llm.deltas = ['记住', '暗号']
    const parent = await chat(h, cwd, '暗号是天王盖地虎')

    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd,
      mcpServers: [],
    })
    const child = String(forked.sessionId)
    expect(child).not.toBe(parent)

    await h.acp.request('session/prompt', {
      sessionId: child as never,
      prompt: [{ type: 'text', text: '暗号是什么' }],
    })
    // 关键断言：父会话那一问一答在**子会话的请求**里。日志里有、表里有都不算
    // ——模型看不见的历史等于没继承。
    const history = lastHistory(h)
    expect(history.some((line) => line.includes('天王盖地虎'))).toBe(true)
    expect(history.some((line) => line.includes('记住暗号'))).toBe(true)
    expect(history.at(-1)).toContain('暗号是什么')
    h.disposeBridge()
  }, 30_000)

  it('建会话应答带上配置项与新会话 id，与 session/new 同构', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-ws-')
    const parent = await chat(h, cwd, '一')
    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd,
      mcpServers: [],
    })
    // 配置项随应答给出（ACP 没有「支持配置项」的能力位，带回来就是声明方式）。
    // 少了它，客户端在 fork 出来的会话里就没有模型/档位控件。
    expect(Array.isArray(forked.configOptions)).toBe(true)
    expect(h.hasAgent(String(forked.sessionId))).toBe(true)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-FORK-03 父子独立', () => {
  it('在子会话里继续聊，父会话的历史不变', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-ws-')
    const parent = await chat(h, cwd, '父会话的话')

    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd,
      mcpServers: [],
    })
    await h.acp.request('session/prompt', {
      sessionId: String(forked.sessionId) as never,
      prompt: [{ type: 'text', text: '只属于子会话的话' }],
    })

    // 回到父会话再聊一轮：它的请求里**不该**出现子会话说过的话。这一条把
    // fork 与 resume 分开——resume 实现会让两边写进同一条日志，于是这里必挂。
    await h.acp.request('session/prompt', {
      sessionId: parent as never,
      prompt: [{ type: 'text', text: '父会话的第二句' }],
    })
    const history = lastHistory(h)
    expect(history.some((line) => line.includes('只属于子会话的话'))).toBe(false)
    expect(history.some((line) => line.includes('父会话的话'))).toBe(true)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-FORK-04 fork 一条没打开的会话', () => {
  it('父会话只在磁盘上时照样能 fork，历史从日志继承', async () => {
    const root = realTempDir('dsacp-root-')
    const cwd = realTempDir('dsacp-ws-')

    // 录制端：聊一轮然后彻底退休，确保日志真的落盘且写入方已经走了。
    const recorder = await createHarness({ sessionsRoot: root })
    recorder.llm.deltas = ['磁', '盘', '回', '声']
    const parent = await chat(recorder, cwd, '写进日志的话')
    recorder.disposeBridge()
    await waitFor(() => !recorder.hasAgent(parent), 5_000, 'agent teardown')
    await recorder.retire()

    // 另一个 harness：**不** load 父会话，直接 fork 它。
    const h = await createHarness({ sessionsRoot: root })
    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd,
      mcpServers: [],
    })
    expect(h.hasAgent(parent)).toBe(false)

    await h.acp.request('session/prompt', {
      sessionId: String(forked.sessionId) as never,
      prompt: [{ type: 'text', text: '接着说' }],
    })
    const history = lastHistory(h)
    expect(history.some((line) => line.includes('写进日志的话'))).toBe(true)
    expect(history.some((line) => line.includes('磁盘回声'))).toBe(true)
    h.disposeBridge()
  }, 60_000)

  it('子会话自己的日志也落盘 —— 之后能被 session/load 读回来', async () => {
    // 这一条钉的是种子**被持久化了**。上游持久化对「没见过的 id + 盘上没有
    // artifact」这一档会把整个 seed 补写一次；不写的话，fork 出来的会话下次打开
    // 就是一段空对话，而 fork 时它明明有历史。
    const root = realTempDir('dsacp-root-')
    const cwd = realTempDir('dsacp-ws-')
    const h = await createHarness({ sessionsRoot: root })
    h.llm.deltas = ['继', '承', '来', '的']
    const parent = await chat(h, cwd, '父会话原话')
    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd,
      mcpServers: [],
    })
    const child = String(forked.sessionId)
    h.disposeBridge()
    await waitFor(() => !h.hasAgent(child), 5_000, 'agent teardown')
    await h.retire()

    const reader = await createHarness({ sessionsRoot: root })
    await reader.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const raw: Record<string, unknown>[] = []
    reader.onUpdate((u) => raw.push(u as Record<string, unknown>))
    await reader.acp.request('session/load', { sessionId: child as never, cwd, mcpServers: [] })
    const replayed = raw
      .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
      .map((u) => (u['content'] as { text?: string }).text ?? '')
      .join('')
    expect(replayed).toContain('继承来的')
    reader.disposeBridge()
  }, 60_000)

  it('会话列表把子会话记成一条独立会话', async () => {
    const root = realTempDir('dsacp-root-')
    const cwd = realTempDir('dsacp-ws-')
    const h = await createHarness({ sessionsRoot: root })
    const parent = await chat(h, cwd, '一')
    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd,
      mcpServers: [],
    })
    const child = String(forked.sessionId)
    // 两条都要等。子会话的种子是在**建会话时**一次性补写的（上游对「没见过的 id
    // 且盘上没有 artifact」这一档如此），而父会话走的是按窗口批量写的常规路径
    // ——于是子会话经常先落盘。只等子会话的话，这条用例会以「列表里没有父会话」
    // 随机翻车。
    await h.waitPersisted(parent)
    await h.waitPersisted(child)
    const listed = await h.acp.request('session/list', {})
    const ids = (listed.sessions as { sessionId: string }[]).map((s) => s.sessionId)
    expect(ids).toContain(parent)
    expect(ids).toContain(child)
    h.disposeBridge()
  }, 60_000)
})

describe('TC-FORK-05 拒绝路径', () => {
  it('回合进行中拒绝 —— 不静默把那半截回合裁掉', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-ws-')
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
    const parent = String(sessionId)

    // 在回合**中间**挂住，制造一个确定的窗口——靠 sleep 去撞是不稳定的。
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h.llm.duringTurn = () => held
    const turn = h.acp.request('session/prompt', {
      sessionId: parent as never,
      prompt: [{ type: 'text', text: '慢慢说' }],
    })
    await waitFor(() => h.llm.calls > 0, 5_000, 'turn started')

    await expect(
      h.acp.request('session/fork', { sessionId: parent as never, cwd, mcpServers: [] }),
    ).rejects.toThrow(/in flight/)

    release()
    await turn
    // 回合结束后同一个请求就该通过：拒绝的理由是「现在不行」，不是「这条不能 fork」。
    const forked = await h.acp.request('session/fork', { sessionId: parent as never, cwd, mcpServers: [] })
    expect(String(forked.sessionId)).not.toBe(parent)
    h.disposeBridge()
  }, 30_000)

  it('cwd 与父会话不一致时拒绝', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-ws-')
    const other = realTempDir('dsacp-other-')
    const parent = await chat(h, cwd, '一')
    // 种子里全是父会话工作区的路径，搬进另一个工作区等于让模型拿着 A 的路径
    // 去改 B 的文件。
    await expect(
      h.acp.request('session/fork', { sessionId: parent as never, cwd: other, mcpServers: [] }),
    ).rejects.toThrow(/cwd mismatch/)
    h.disposeBridge()
  }, 30_000)

  it('cwd 是同一个目录的另一种拼写时放行 —— 比的是目录，不是字符串', async () => {
    const dirs = aliasDir('dsacp-fork-alias-')
    if (dirs === undefined) return // 文件系统不支持重解析点
    const h = await createHarness()
    const parent = await chat(h, dirs.real, '一')
    // 编辑器发来的 cwd 完全可以是软链/联接那一侧的拼写（macOS 的 `/var`、
    // Windows 的 8.3 短名同理）。裸相等会让用户 fork 不了自己的会话。
    const forked = await h.acp.request('session/fork', {
      sessionId: parent as never,
      cwd: dirs.alias,
      mcpServers: [],
    })
    expect(String(forked.sessionId)).not.toBe(parent)
    h.disposeBridge()
  }, 30_000)

  it('cwd 不是绝对路径、或带了 additionalDirectories 时拒绝', async () => {
    const h = await createHarness()
    const cwd = realTempDir('dsacp-ws-')
    const parent = await chat(h, cwd, '一')
    await expect(
      h.acp.request('session/fork', { sessionId: parent as never, cwd: 'relative/path', mcpServers: [] }),
    ).rejects.toThrow(/absolute path/)
    await expect(
      h.acp.request('session/fork', {
        sessionId: parent as never,
        cwd,
        mcpServers: [],
        additionalDirectories: [realTempDir('dsacp-extra-')],
      }),
    ).rejects.toThrow(/additionalDirectories/)
    h.disposeBridge()
  }, 30_000)

  it('没挂持久化时，fork 一条没打开的会话被明确拒绝', async () => {
    // 这种组合里种子无从取起：既不在内存里，也没有日志可读。给一个说得清原因的
    // 拒绝，好过建出一条空会话让用户以为继承成功了。
    const h = await createHarness()
    const ghost = 'never-existed'
    let failure: { code?: number; message?: string; data?: unknown } | undefined
    try {
      await h.acp.request('session/fork', {
        sessionId: ghost as never,
        cwd: realTempDir('dsacp-ws-'),
        mcpServers: [],
      })
    } catch (error: unknown) {
      failure = error as never
    }
    expect(failure, '这次 fork 本该失败').toBeDefined()
    // `-32002 Resource not found` 而不是 `-32603`：客户端据此把陈旧 id 从会话
    // 列表里摘掉，而不是弹一个「agent 出错了」的框。见 TC-MISSING-*。
    expect(failure?.code).toBe(-32002)
    expect(failure?.data).toEqual({ uri: ghost })
    // 这一条的原因不是自明的——同一个请求换个部署就能成功，所以消息里要说清是
    // 这个部署不带持久化，否则用户只会反复重试。
    expect(failure?.message).toMatch(/no session-persistence backend/)
    h.disposeBridge()
  }, 30_000)
})
