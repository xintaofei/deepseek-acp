/**
 * TC-CMD-* —— 人类命令面（US-18）。
 *
 * 这条链上最容易做错、且做错了看不出来的是**顺序**：`session/new` 的会话 id 是
 * 服务端生成的，客户端第一次知道它是在应答里；抢在应答前面发的
 * `available_commands_update` 指向一个客户端还不认识的会话，多数客户端直接丢弃
 * ——表现是「命令目录时有时无」，而 agent 侧一切正常。所以这里专门测线上顺序，
 * 不只测「发了没有」。
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { toAvailableCommands } from '../src/protocol/session-commands.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

/** 客户端收到的命令快照，按到达顺序。 */
function snapshots(h: TestHarness): AvailableCommand[][] {
  const seen: AvailableCommand[][] = []
  h.onUpdate((update) => {
    const u = update as { sessionUpdate: string; availableCommands?: AvailableCommand[] }
    if (u.sessionUpdate === 'available_commands_update') seen.push(u.availableCommands ?? [])
  })
  return seen
}

/** 客户端收到的助手文本，拼接。 */
function agentText(h: TestHarness): string {
  return h.updates.filter((u) => u.kind === 'agent_message_chunk').map((u) => u.text ?? '').join('')
}

describe('TC-CMD-01 命令目录', () => {
  it('未挂命令注册表时不推快照 —— 空目录也不推', async () => {
    const h = await createHarness()
    const seen = snapshots(h)
    await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })
    // 给延后的那条快照足够的时间真的发出来（如果它存在的话）。
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual([])
    h.disposeBridge()
  }, 30_000)

  it('挂了 plan-mode 后，session/new 之后推出含 /plan 的全量快照', async () => {
    const h = await createHarness({ planMode: true })
    const seen = snapshots(h)
    await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })
    await waitFor(() => seen.length > 0, 5_000, 'commands snapshot')

    expect(seen[0]).toEqual([
      { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
    ])
    h.disposeBridge()
  }, 30_000)

  it('快照排在 session/new 的应答之后 —— 客户端要先认识这个会话', async () => {
    const h = await createHarness({ planMode: true })
    const seen = snapshots(h)
    // 客户端与 agent 共用一条有序流：若快照先于应答写出，它的处理器会先跑完，
    // 于是 `request` 兑现的那一刻 `seen` 里就已经有东西了。
    await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })
    expect(seen).toEqual([])

    await waitFor(() => seen.length > 0, 5_000, 'commands snapshot')
    h.disposeBridge()
  }, 30_000)

  it('注册表变更时刷新每一个在册会话', async () => {
    const h = await createHarness({ planMode: true })
    const seen = snapshots(h)
    const cwd = realTempDir('dsacp-cmd-')
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    // 先等两条建会话快照落地，之后新增的才确定是刷新带来的。
    await waitFor(() => seen.length === 2, 5_000, 'initial snapshots')

    // 注册一条新命令 —— 上游据此发 `commands/change`。
    const off = h.ctx.commands.register({
      name: 'zzz',
      description: '测试命令',
      handler: () => ({ kind: 'success', text: 'ok' }),
    })
    await waitFor(() => seen.length >= 4, 5_000, 'refreshed snapshots')

    // 两个会话各收到一份刷新，且都含新命令。
    expect(seen).toHaveLength(4)
    for (const snapshot of seen.slice(2)) expect(snapshot.map((c) => c.name)).toEqual(['plan', 'zzz'])
    off()
    h.disposeBridge()
  }, 30_000)

  it('session/load 把快照跟在历史后面一起给出', async () => {
    const sessionsRoot = realTempDir('dsacp-cmd-root-')
    const cwd = realTempDir('dsacp-cmd-')
    const recorder = await createHarness({ sessionsRoot, planMode: true })
    const { sessionId } = await recorder.acp.request('session/new', { cwd, mcpServers: [] })
    await recorder.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '你好' }],
    })
    recorder.disposeBridge()
    await recorder.retire()

    const loader = await createHarness({ sessionsRoot, planMode: true })
    const seen = snapshots(loader)
    await loader.acp.request('session/load', { sessionId, cwd, mcpServers: [] })
    // 恢复路径下客户端本来就知道会话 id（是它给的），因此快照与历史一起在
    // 应答**之前**送达 —— 应答兑现时它已经在手上了。
    expect(seen).toHaveLength(1)
    expect(seen[0]?.map((c) => c.name)).toEqual(['plan'])
    loader.disposeBridge()
  }, 40_000)
})

describe('TC-CMD-02 命令不触发模型请求', () => {
  it('/plan 由命令面处理，模型一次都没被调用', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })

    const result = await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan' }],
    })
    expect(result.stopReason).toBe('end_turn')
    expect(h.llm.calls).toBe(0)
    h.disposeBridge()
  }, 30_000)

  it.each([
    ['语法合法但名字没注册', '/nope 参数'],
    ['压根不是命令语法', '/usr/bin/env 是什么'],
  ])('%s 的输入落回模型', async (_label, text) => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })

    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    expect(h.llm.calls).toBe(1)
    h.disposeBridge()
  }, 30_000)

  it('没挂命令面时 /plan 也是普通文本', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })

    await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan' }],
    })
    expect(h.llm.calls).toBe(1)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-CMD-03 命令结果呈现', () => {
  it('命令的产出经 command/done 事件浮现为助手文本', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })

    await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan' }],
    })
    expect(agentText(h)).toContain('Plan mode on.')
    h.disposeBridge()
  }, 30_000)

  it('/plan <消息> 会 steer 出一个真回合，prompt 等它跑完才结算', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })

    const result = await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan 帮我设计登录流程' }],
    })
    // 命令自己不进模型，但它 steer 进去的那条消息进了 —— 结算点必须等到
    // 那个回合结束，否则客户端会在助手还在说话时就以为回合完了。
    expect(h.llm.calls).toBe(1)
    expect(result.stopReason).toBe('end_turn')
    expect(agentText(h)).toContain('Hello')
    h.disposeBridge()
  }, 30_000)

  it('steer 出来的回合被截断时，如实报 max_tokens', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })
    h.llm.finishWith = { kind: 'max-tokens' }

    // 这条链只有在命令路径接受「任意回合」的结束原因时才成立：被 steer 的那条
    // 消息 id 由上游铸造，bridge 拿不到，无法按消息相关联。若不接受，这里会
    // 回退成 end_turn —— 回答明明被截断了，客户端却当成一次完整回答。
    const result = await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan 帮我设计登录流程' }],
    })
    expect(result.stopReason).toBe('max_tokens')
    h.disposeBridge()
  }, 30_000)

  it('steer 出来的回合失败时，prompt 以失败结束而不是假装正常', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cmd-'), mcpServers: [] })
    h.llm.failWith = new Error('boom')

    // 这条链只有在命令路径接受「任意回合」的结束原因时才成立：那条被 steer
    // 的消息 id 由上游铸造，bridge 拿不到，无法按消息相关联。若不接受，
    // 这里会静默地返回 end_turn —— 模型明明炸了，客户端却看到一次正常结束。
    await expect(
      h.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/plan 帮我设计登录流程' }],
      }),
    ).rejects.toThrow(/turn failed/)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-CMD-04 目录投影', () => {
  it('name 不带斜杠，无 hint 时不给 input 字段', () => {
    expect(
      toAvailableCommands([
        { name: 'plan', description: '计划', hint: '[off|message]' },
        { name: 'compact', description: '压缩', hint: undefined },
      ]),
    ).toEqual([
      { name: 'plan', description: '计划', input: { hint: '[off|message]' } },
      { name: 'compact', description: '压缩' },
    ])
  })
})
