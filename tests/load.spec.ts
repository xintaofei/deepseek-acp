/**
 * TC-LOAD-* / TC-LIST-* —— 会话恢复与列表（US-14 / US-15）。
 *
 * 走真实的 JSONL 持久化：先在一个 harness 里聊出一段历史，销毁它，再用**另一个**
 * harness 从磁盘恢复。同进程内复用一个 harness 测不到这条链——活会话还在内存里，
 * 恢复会从内存拿到答案，磁盘上写没写、能不能读回来都不知道。
 */

import { isAbsolute } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { mapEvent } from '../src/mapping/updates.js'
import { createHarness, waitFor, type CapturedUpdate, type TestHarness } from './harness.js'
import { NATIVE_SHELL_TOOL, stdoutCommand } from './native-shell.js'
import { aliasDir, realTempDir } from './temp-dir.js'

/** 在一个独立 harness 里聊一轮，返回会话 id 与它产出的更新。 */
async function recordSession(
  root: string,
  cwd: string,
  options: { deltas?: string[]; toolCall?: { id: string; name: string; args: string } } = {},
): Promise<{ sessionId: string; updates: CapturedUpdate[] }> {
  const h = await createHarness({ sessionsRoot: root, ...(options.toolCall !== undefined ? { shell: 'local' as const } : {}) })
  const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
  if (options.deltas !== undefined) h.llm.deltas = options.deltas
  if (options.toolCall !== undefined) h.llm.toolCall = options.toolCall
  await h.acp.request('session/prompt', {
    sessionId: sessionId as never,
    prompt: [{ type: 'text', text: '你好' }],
  })
  // 先释放 bridge（取消并 dispose 全部 agent，触发最终 drain），再**彻底退休**它。
  //
  // 顺序不能反。用 `retire()` 而不是 `waitPersisted()`：后者的判据是「会话出现在
  // `list()` 里」，那只是**头部**落盘的时刻，录制端的写入方仍然活着；`retire()` 等到
  // flush 与 per-id 链都排空。恢复端随后会成为同一个日志文件的第二个写入方，让两者
  // 在时间上不重叠是这类用例本来就该有的前提。详见 harness 里 `retire` 的注释。
  h.disposeBridge()
  await waitFor(() => !h.hasAgent(String(sessionId)), 5_000, 'agent teardown')
  await h.retire()
  // 录制期不许有后台失败。上游把这类事故只报给 `ctx.logger`（持久化的
  // `reportBackgroundFailure` 就是），不抛给调用方——不看这里，一次「写失败并重试」
  // 的表现就只是稍后恢复时一句没头没尾的 `Internal error`。这条断言把错误本身
  // 印在失败消息里，让下次复现自己说出原因。
  const trouble = h.logs.filter((l) => l.type === 'warn' || l.type === 'error')
  expect(trouble.map((l) => `[${l.type}] ${l.name}: ${l.text}`), '录制期出现后台失败').toEqual([])
  return { sessionId: String(sessionId), updates: h.updates }
}

/** 用新 harness 从磁盘恢复。 */
async function loadInto(
  root: string,
  sessionId: string,
  cwd: string,
  options: { terminal?: boolean; shell?: 'local' } = {},
): Promise<{ h: TestHarness; raw: Record<string, unknown>[] }> {
  // 恢复端的组合必须和录制端一致：呈现器按工具名去注册表找 `presentCall`，
  // 工具不在就只能退回通用卡片。上游把 `agentPreset` 做成不可变会话元数据，
  // 正是这个原因。
  const h = await createHarness({ sessionsRoot: root, ...(options.shell !== undefined ? { shell: options.shell } : {}) })
  await h.acp.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: options.terminal === true ? { _meta: { terminal_output: true } } : {},
  })
  const raw: Record<string, unknown>[] = []
  h.onUpdate((u) => raw.push(u as Record<string, unknown>))
  await h.acp.request('session/load', { sessionId: sessionId as never, cwd, mcpServers: [] })
  return { h, raw }
}

describe('TC-LOAD-01 历史重放', () => {
  it('恢复后把当初的助手消息按原样重放给客户端', async () => {
    const root = realTempDir('dsacp-load-')
    const cwd = realTempDir('dsacp-ws-')
    const { sessionId } = await recordSession(root, cwd, { deltas: ['前情', '提要'] })

    const { h, raw } = await loadInto(root, sessionId, cwd)
    const text = raw
      .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
      .map((u) => (u['content'] as { text?: string }).text ?? '')
      .join('')
    expect(text).toContain('前情提要')
    // 用户那条也要在，否则恢复出来的是一段没有问题的回答
    expect(raw.some((u) => u['sessionUpdate'] === 'user_message_chunk')).toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('恢复后的会话可以继续对话', async () => {
    const root = realTempDir('dsacp-load-')
    const cwd = realTempDir('dsacp-ws-')
    const { sessionId } = await recordSession(root, cwd)

    const { h } = await loadInto(root, sessionId, cwd)
    h.llm.deltas = ['续', '上']
    const response = await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '接着说' }],
    })
    expect(response.stopReason).toBe('end_turn')
    h.disposeBridge()
  }, 30_000)

  it('工具卡片也一并重放 —— 恢复出来的转录不能少一段', async () => {
    const root = realTempDir('dsacp-load-')
    const cwd = realTempDir('dsacp-ws-')
    const command = stdoutCommand('replayed')
    const { sessionId } = await recordSession(root, cwd, {
      toolCall: { id: 'r-1', name: NATIVE_SHELL_TOOL, args: JSON.stringify({ command, description: 'echo' }) },
    })

    const { h, raw } = await loadInto(root, sessionId, cwd, { terminal: true, shell: 'local' })
    const call = raw.find((u) => u['sessionUpdate'] === 'tool_call')
    const done = raw.find((u) => u['sessionUpdate'] === 'tool_call_update')
    expect(call).toMatchObject({ toolCallId: 'r-1', title: command, kind: 'execute' })
    // 呈现器是恢复时新建的：结果卡片能带上 diff/终端信息，说明它在重放里
    // 重新建立了 call→result 的关联，而不是退化成一张裸文本卡。
    expect((done?.['_meta'] as { terminal_output?: { data?: string } })?.terminal_output?.data).toContain('replayed')
    h.disposeBridge()
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('Windows 可恢复历史 bash 调用并在下一回合使用 pwsh', async () => {
    const root = realTempDir('dsacp-load-legacy-')
    const cwd = realTempDir('dsacp-ws-legacy-')
    const { sessionId } = await recordSession(root, cwd, {
      toolCall: {
        id: 'legacy-bash',
        name: 'bash',
        args: JSON.stringify({ command: 'echo historical', description: 'historical shell call' }),
      },
    })

    const { h, raw } = await loadInto(root, sessionId, cwd, { terminal: true, shell: 'local' })
    const replayed = raw.find(
      (u) => u['sessionUpdate'] === 'tool_call' && u['toolCallId'] === 'legacy-bash',
    )
    expect(replayed).toMatchObject({ toolCallId: 'legacy-bash', title: 'bash', kind: 'other' })
    expect(replayed?.['rawInput']).toMatchObject({ command: 'echo historical' })

    h.llm.toolCall = {
      id: 'native-after-load',
      name: NATIVE_SHELL_TOOL,
      args: JSON.stringify({ command: stdoutCommand('continued'), description: 'continue with native shell' }),
    }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '继续' }],
    })
    await waitFor(
      () => raw.some((u) => u['sessionUpdate'] === 'tool_call_update' && u['toolCallId'] === 'native-after-load'),
      20_000,
      'native shell result after legacy load',
    )
    const continued = raw.find(
      (u) => u['sessionUpdate'] === 'tool_call_update' && u['toolCallId'] === 'native-after-load',
    )
    expect(JSON.stringify(continued)).toContain('continued')
    h.disposeBridge()
  }, 60_000)
})

describe('TC-LOAD-02 恢复的校验', () => {
  it('cwd 与日志不一致时拒绝 —— 否则会把 A 项目的历史恢复进 B 的工作区', async () => {
    const root = realTempDir('dsacp-load-')
    const cwd = realTempDir('dsacp-ws-')
    const other = realTempDir('dsacp-other-')
    const { sessionId } = await recordSession(root, cwd)

    const h = await createHarness({ sessionsRoot: root })
    await expect(
      h.acp.request('session/load', { sessionId: sessionId as never, cwd: other, mcpServers: [] }),
    ).rejects.toThrow(/cwd mismatch/)
    // 拒绝之后不得留下已发布的 agent
    expect(h.hasAgent(sessionId)).toBe(false)
    h.disposeBridge()
  }, 30_000)

  it('cwd 是同一个目录的另一种拼写时放行 —— 比的是目录，不是字符串', async () => {
    // 这一条在 macOS 上不用建链接也会红：`os.tmpdir()` 是 `/var/folders/…`，
    // 真实路径是 `/private/var/…`。Windows 上则是 8.3 短名。裸相等的后果是
    // 用户**加载不了自己的会话**，而错误信息里两个路径看着还挺像。
    //
    // `session/resume` 不另写一条：它与 `session/load` 共用 `restoreSession`，
    // cwd 校验就在那个函数里，覆盖这一侧即覆盖两侧。
    const dirs = aliasDir('dsacp-load-alias-')
    if (dirs === undefined) return // 文件系统不支持重解析点
    const root = realTempDir('dsacp-load-')
    const { sessionId } = await recordSession(root, dirs.real)

    const h = await createHarness({ sessionsRoot: root })
    await h.acp.request('session/load', {
      sessionId: sessionId as never,
      cwd: dirs.alias,
      mcpServers: [],
    })
    expect(h.hasAgent(sessionId)).toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('未知会话 id 报错而非静默建一个空会话', async () => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-load-') })
    await expect(
      h.acp.request('session/load', {
        sessionId: 'no-such-session' as never,
        cwd: realTempDir('dsacp-ws-'),
        mcpServers: [],
      }),
    ).rejects.toThrow()
    // 报的是哪个错误码由 TC-MISSING-* 钉住：`-32002` 而不是 `-32603`。
    h.disposeBridge()
  }, 30_000)
})

describe('TC-LIST-01 会话列表', () => {
  it('列出已落盘会话，最新在前', async () => {
    const root = realTempDir('dsacp-list-')
    const a = realTempDir('dsacp-ws-a-')
    const b = realTempDir('dsacp-ws-b-')
    const first = await recordSession(root, a)
    const second = await recordSession(root, b)

    const h = await createHarness({ sessionsRoot: root })
    const listed = await h.acp.request('session/list', {})
    const ids = listed.sessions.map((s) => String(s.sessionId))
    expect(ids).toContain(first.sessionId)
    expect(ids).toContain(second.sessionId)
    expect(ids.indexOf(second.sessionId)).toBeLessThan(ids.indexOf(first.sessionId))
    // 每条都带绝对 cwd —— 客户端要靠它决定恢复到哪个工作区
    for (const info of listed.sessions) expect(isAbsolute(info.cwd)).toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('按 cwd 过滤', async () => {
    const root = realTempDir('dsacp-list-')
    const a = realTempDir('dsacp-ws-a-')
    const b = realTempDir('dsacp-ws-b-')
    const inA = await recordSession(root, a)
    await recordSession(root, b)

    const h = await createHarness({ sessionsRoot: root })
    const listed = await h.acp.request('session/list', { cwd: a })
    expect(listed.sessions.map((s) => String(s.sessionId))).toEqual([inA.sessionId])
    h.disposeBridge()
  }, 30_000)

  it('按 cwd 过滤时认得同一个目录的另一种拼写', async () => {
    const dirs = aliasDir('dsacp-list-alias-')
    if (dirs === undefined) return // 文件系统不支持重解析点
    const root = realTempDir('dsacp-list-')
    const other = realTempDir('dsacp-ws-other-')
    const inAlias = await recordSession(root, dirs.real)
    await recordSession(root, other)

    const h = await createHarness({ sessionsRoot: root })
    // 编辑器按它自己那份拼写来问。裸相等的后果是会话选择器**空的**——用户会
    // 以为历史没了。
    const listed = await h.acp.request('session/list', { cwd: dirs.alias })
    expect(listed.sessions.map((s) => String(s.sessionId))).toEqual([inAlias.sessionId])
    h.disposeBridge()
  }, 60_000)
})

describe('TC-LOAD-03 重放里的用户消息', () => {
  /** 构造一条 `user/message` 事件。 */
  const userEvent = (source: { kind: string }, text: string): Parameters<typeof mapEvent>[0] =>
    ({
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { id: 'm-1', role: 'user', source, content: [{ type: 'text', text }] },
    }) as never

  it('实时流里不回显用户消息 —— 客户端刚发过这条 prompt', () => {
    expect(mapEvent(userEvent({ kind: 'user' }, '你好'), {})).toEqual([])
  })

  it('重放时回放用户消息', () => {
    expect(mapEvent(userEvent({ kind: 'user' }, '你好'), { replay: true })).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你好' } },
    ])
  })

  it('注入的上下文**不**当作用户消息重放', () => {
    // agent-instructions 会把 AGENTS.md / CLAUDE.md 包成一条 `kind: 'plugin'`
    // 的用户消息塞进回合。当成用户气泡放出去，用户会在自己的对话记录里看到
    // 一整份从没打过的 CLAUDE.md。
    const injected = userEvent({ kind: 'plugin' }, '<system-reminder>整份 CLAUDE.md</system-reminder>')
    expect(mapEvent(injected, { replay: true })).toEqual([])
  })
})

describe('TC-LIST-02 能力声明随组合而变', () => {
  it('挂了持久化才 advertise loadSession 与 session/list', async () => {
    const h = await createHarness({ sessionsRoot: realTempDir('dsacp-caps-') })
    const init = await h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.agentCapabilities?.loadSession).toBe(true)
    expect(init.agentCapabilities?.sessionCapabilities?.list).toEqual({})
    h.disposeBridge()
  }, 30_000)

  it('没挂持久化则既不声明也不可用 —— 声明与实现同一个真值来源', async () => {
    const h = await createHarness()
    const init = await h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.agentCapabilities?.loadSession).toBeFalsy()
    expect(init.agentCapabilities?.sessionCapabilities?.list).toBeUndefined()

    // 客户端可以无视能力声明直接调；此时必须是「没这个方法」而不是别的错。
    await expect(h.acp.request('session/list', {})).rejects.toThrow(/persistence/)
    h.disposeBridge()
  }, 30_000)
})
