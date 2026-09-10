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

/** 在一个独立 harness 里聊一轮，返回会话 id 与它产出的更新（含未经压缩的原始帧）。 */
async function recordSession(
  root: string,
  cwd: string,
  options: { deltas?: string[]; toolCall?: { id: string; name: string; args: string } } = {},
): Promise<{ sessionId: string; updates: CapturedUpdate[]; raw: Record<string, unknown>[] }> {
  const h = await createHarness({ sessionsRoot: root, ...(options.toolCall !== undefined ? { shell: 'local' as const } : {}) })
  const raw: Record<string, unknown>[] = []
  h.onUpdate((u) => raw.push(u as Record<string, unknown>))
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
  //
  // `local-subprocess-runtime` 例外：它在启动时报一句**平台能力**告知（macOS 没有
  // 持久进程范围所有者，进程树围栏因此弱一档），每次挂 shell 都会有，与本次录制
  // 发生了什么无关。不排除它就等于把这条断言在所有带 shell 的用例上永久钉红——
  // 只按名字排除一个已知发声者，别的 warn 照样让用例失败。
  const trouble = h.logs.filter(
    (l) => (l.type === 'warn' || l.type === 'error') && l.name !== 'local-subprocess-runtime',
  )
  expect(trouble.map((l) => `[${l.type}] ${l.name}: ${l.text}`), '录制期出现后台失败').toEqual([])
  return { sessionId: String(sessionId), updates: h.updates, raw }
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

  it('重放给出的 messageId 与实时流那次相同，文本也逐字相同', async () => {
    // 客户端在实时流里记下一个 messageId，可能过几天、重开编辑器之后才拿它去
    // `session/fork`。两条路径给出不同的 id，那次分叉就会以「找不到这条消息」
    // 失败。0.1.5 起两条路径不再是同一条事件（实时走进程内帧流、重放走随消息
    // 落库的紧凑流），这条用例因此从「守着别被拆开」变成「守着拆开之后仍相等」。
    //
    // 断的是 **id 集合与拼接文本**，不是分片条数：紧凑流把连续同类 delta 并成
    // 一条 run，重放于是发并好的整段而实时发逐片。客户端两边都是接起来显示，
    // 拿条数当判据只会把一个正确的实现钉死在一种打包方式上。
    const root = realTempDir('dsacp-load-')
    const cwd = realTempDir('dsacp-ws-')
    const chunks = (updates: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
      updates.filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
    const ids = (updates: readonly Record<string, unknown>[]): Set<unknown> =>
      new Set(chunks(updates).map((u) => u['messageId']))
    const text = (updates: readonly Record<string, unknown>[]): string =>
      chunks(updates)
        .map((u) => (u['content'] as { text?: string }).text ?? '')
        .join('')

    const { sessionId, raw: live } = await recordSession(root, cwd, { deltas: ['前情', '提要'] })
    const { h, raw } = await loadInto(root, sessionId, cwd)

    expect(chunks(live).length, '录制期本该有助手分片').toBeGreaterThan(0)
    expect(ids(raw)).toEqual(ids(live))
    expect(text(raw)).toBe(text(live))
    // 同一条消息的分片共享一个 id —— ACP 对这个字段的语义就是「值变了即新消息」。
    expect(ids(live).size).toBe(1)
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

  it('吐了半句话再重试的一步：恢复出来的与当时看到的逐字相同', async () => {
    // 这条守的是 0.1.5 拆开实时/落库两条载体之后最容易漏的那个缺口。
    //
    // 一次模型请求中途以 error finish 收尾、随后被重试时，上游把废弃的那次记成
    // `assistant/attempt`（带着它**已经发出去的**分片），成功那次记成
    // `assistant/message`。两次共用同一个 `<turn>:<step>`——loop 在重试循环
    // 外面就捕获了 turn/step。
    //
    // 于是：实时路径下客户端两次都收到了分片（帧流不区分尝试成不成），而重放
    // 如果只展开 `assistant/message`，恢复出来的对话就会**少掉那半句**。少一段
    // 不会报错、不会有任何用例自己变红，只会让用户重开会话后发现内容变了。
    const root = realTempDir('dsacp-load-')
    const cwd = realTempDir('dsacp-ws-')

    const h = await createHarness({ sessionsRoot: root })
    const live: Record<string, unknown>[] = []
    h.onUpdate((u) => live.push(u as Record<string, unknown>))
    // 让第一次尝试真的被重试。真实部署里这个监听器由 `dsh-llm-retry` 或
    // `dsh-compaction-basic`（上下文溢出后压缩再来一次）提供；用例自己挂一个
    // 是为了让这个形状**确定地**发生，而不是靠撞一次网络抖动。
    let retried = false
    h.ctx.on('agent/request-error', (_payload, next) => {
      if (retried) return next()
      retried = true
      return Promise.resolve({ kind: 'retry' as const })
    })

    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
    h.llm.deltas = ['半句']
    h.llm.errorFinishOnce = { message: 'stream died mid-flight', code: 'PROVIDER_ERROR' }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '说点什么' }],
    })
    h.disposeBridge()
    await waitFor(() => !h.hasAgent(String(sessionId)), 5_000, 'agent teardown')
    await h.retire()

    // 前提自检：重试确实发生了，且客户端确实两次都收到了分片。这两条不成立的
    // 话，下面那个相等就是两个空数组相等，用例永远绿。
    expect(retried, '第一次尝试应当被重试').toBe(true)
    const text = (updates: readonly Record<string, unknown>[]): string =>
      updates
        .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
        .map((u) => (u['content'] as { text?: string }).text ?? '')
        .join('')
    expect(text(live), '实时应当既有废弃那次的半句、也有重来那次的').toBe('半句半句')

    const { h: restored, raw } = await loadInto(root, String(sessionId), cwd)
    expect(text(raw)).toBe(text(live))
    restored.disposeBridge()
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

  it('重放时回放用户消息，带上这条消息的持久 id', () => {
    // `messageId` 是 ACP 给 `ContentChunk` 的标准字段（同一条消息的分片共享它）。
    // 用户消息没有 turn/step 可取，用的是消息自己那个跨表示边界不变的 id。
    expect(mapEvent(userEvent({ kind: 'user' }, '你好'), { replay: true })).toEqual([
      { sessionUpdate: 'user_message_chunk', messageId: 'm-1', content: { type: 'text', text: '你好' } },
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
