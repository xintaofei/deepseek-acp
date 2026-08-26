/**
 * TC-TERM-* —— 终端卡片的端到端（US-10）。
 *
 * 这里跑的是**真实的平台 shell 子进程**：真实工具 → 真实执行 → 真实 `tool/result`
 * → 呈现器 → ACP 帧。`presentation.spec.ts` 那一批是纯函数，手写的视图对象只
 * 能证明映射自洽，证明不了上游工具真的产出那种视图。
 *
 * 事实上正是这条链抓到了 `_meta.terminal_output` 的载荷键写成 `output`
 * （应为 `data`）—— 纯函数用例照着实现写，跟着一起错了。
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import {
  NATIVE_SHELL_TOOL,
  cwdCommand,
  stderrAndExitCommand,
  stdoutCommand,
} from './native-shell.js'
import { realTempDir } from './temp-dir.js'

interface RawUpdate {
  sessionUpdate: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  content?: unknown[]
  rawInput?: unknown
  _meta?: {
    terminal_info?: { terminal_id: string; cwd?: string }
    terminal_output?: { terminal_id: string; data: string }
    terminal_exit?: { terminal_id: string; exit_code?: number; signal?: string }
  }
}

/** 起会话、跑一条命令，返回调用侧与结果侧两帧。 */
async function runCommand(
  h: TestHarness,
  options: { command: string; description?: string; workdir?: string; cwd: string; terminal: boolean },
): Promise<{ call: RawUpdate; result: RawUpdate }> {
  if (options.terminal) {
    await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { _meta: { terminal_output: true } },
    })
  }
  const { sessionId } = await h.acp.request('session/new', { cwd: options.cwd, mcpServers: [] })

  const raw: RawUpdate[] = []
  h.onUpdate((u) => raw.push(u as RawUpdate))

  h.llm.toolCall = {
    id: 'term-1',
    name: NATIVE_SHELL_TOOL,
    args: JSON.stringify({
      command: options.command,
      description: options.description ?? 'run a command',
      ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    }),
  }
  await h.acp.request('session/prompt', {
    sessionId: sessionId as never,
    prompt: [{ type: 'text', text: '跑一下' }],
  })
  await waitFor(() => raw.some((u) => u.sessionUpdate === 'tool_call_update'), 20_000, 'terminal result card')

  const call = raw.find((u) => u.sessionUpdate === 'tool_call')
  const result = raw.find((u) => u.sessionUpdate === 'tool_call_update')
  if (call === undefined || result === undefined) throw new Error('missing tool card frames')
  return { call, result }
}

describe('TC-TERM-01 支持终端的客户端拿到终端卡片', () => {
  it('调用侧：命令作标题、execute 卡、terminal 内容块、terminal_info 带 cwd', async () => {
    const h = await createHarness({ shell: 'local' })
    const cwd = realTempDir('dsacp-term-')
    const command = stdoutCommand('hello-terminal')
    const { call } = await runCommand(h, {
      command,
      description: '打个招呼',
      cwd,
      terminal: true,
    })

    expect(call.title).toBe(command)
    expect(call.kind).toBe('execute')
    expect(call.status).toBe('in_progress')
    // 描述在终端块**之前** —— 终端卡片本身没有描述槽位
    expect(call.content).toEqual([
      { type: 'content', content: { type: 'text', text: '打个招呼' } },
      { type: 'terminal', terminalId: 'term-1' },
    ])
    expect(call._meta?.terminal_info).toEqual({ terminal_id: 'term-1', cwd })
    // 入参对象与表头同源：cwd 两处必须是同一个值
    expect(call.rawInput).toEqual({ command, description: '打个招呼', cwd })
    h.disposeBridge()
  }, 30_000)

  it('结果侧：真实 stdout 走 _meta.terminal_output.data，退出码进 terminal_exit', async () => {
    const h = await createHarness({ shell: 'local' })
    const { result } = await runCommand(h, {
      command: stdoutCommand('hello-terminal'),
      cwd: realTempDir('dsacp-term-'),
      terminal: true,
    })

    expect(result.status).toBe('completed')
    // 键名是 data 不是 output；内容是子进程真的打出来的东西
    expect(result._meta?.terminal_output?.terminal_id).toBe('term-1')
    expect(result._meta?.terminal_output?.data).toContain('hello-terminal')
    expect(result._meta?.terminal_exit).toEqual({ terminal_id: 'term-1', exit_code: 0 })
    // content 会整体替换调用侧内容 —— 带上就把终端块自己冲掉了
    expect(result).not.toHaveProperty('content')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-TERM-02 非零退出', () => {
  it('退出码进 pill，卡片仍是 completed —— 非零退出是模型要读的结果，不是工具故障', async () => {
    const h = await createHarness({ shell: 'local' })
    const { result } = await runCommand(h, {
      command: stderrAndExitCommand('oops', 3),
      cwd: realTempDir('dsacp-term-'),
      terminal: true,
    })

    expect(result._meta?.terminal_exit).toEqual({ terminal_id: 'term-1', exit_code: 3 })
    expect(result.status).toBe('completed')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-TERM-03 不支持终端的客户端', () => {
  it('退回围栏 console 文本，且完全不发 _meta', async () => {
    const h = await createHarness({ shell: 'local' })
    const cwd = realTempDir('dsacp-term-')
    const command = stdoutCommand('plain-fallback')
    const { call, result } = await runCommand(h, {
      command,
      description: '打个招呼',
      cwd,
      terminal: false,
    })

    // 调用侧只剩描述，没有 terminal 内容块
    expect(call).not.toHaveProperty('_meta')
    expect(call.content).toEqual([{ type: 'content', content: { type: 'text', text: '打个招呼' } }])
    // 这条路径上没有 `terminal_info` 表头，工作目录只能从入参对象里读
    expect(call.rawInput).toEqual({ command, description: '打个招呼', cwd })

    expect(result).not.toHaveProperty('_meta')
    const text = (result.content?.[0] as { content?: { text?: string } })?.content?.text ?? ''
    expect(text).toContain('```console')
    expect(text).toContain('plain-fallback')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-TERM-04 工作目录', () => {
  it('未给 workdir 时命令跑在会话 cwd 里', async () => {
    const h = await createHarness({ shell: 'local' })
    const cwd = realTempDir('dsacp-term-')
    const { result } = await runCommand(h, { command: cwdCommand(), cwd, terminal: true })

    // 这条同时钉住两件事：cwd 表头没有说谎，且 N 个会话共用一个 executor 时
    // 每个会话跑在自己的工作区里（工具层从 session.header.cwd 取默认 workdir）。
    expect(result._meta?.terminal_output?.data.trim()).toBe(cwd)
    h.disposeBridge()
  }, 30_000)
})
