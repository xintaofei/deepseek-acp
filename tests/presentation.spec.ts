/**
 * TC-PRE-* / TC-MAP-* —— 工具卡片呈现（US-08/09/10/11/13）。
 *
 * 全是纯函数测试：呈现层不碰连接，也不需要模型。这正是「实时流与 session/load
 * 重放同源」能成立的原因——同一组函数喂同一批事件必然产出同一批更新。
 */

import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { harnessBlockToAcpContent } from '../src/codec/content.js'
import { mapEvent } from '../src/mapping/updates.js'
import { todosToPlan } from '../src/mapping/plan.js'
import { ToolPresenter, parseToolArguments } from '../src/presentation/presenter.js'
import { displayTitle, insideWorkspace } from '../src/presentation/paths.js'
import { terminalCwd } from '../src/presentation/terminal.js'
import { NO_TERMINAL, toolCallUpdate, toolResultUpdate } from '../src/presentation/tool-call.js'

const CID = ToolCallId('call-1')
const WS = resolve('work', 'repo')
const FILE = join(WS, 'a.ts')
const SOURCE_FILE = join(WS, 'src', 'a.ts')
const OUTSIDE_FILE = resolve(WS, '..', 'other', 'hosts')
const withTerminal = { enabled: true, cwd: WS }

/** 一个只有 `get` 的最小注册表替身。 */
function registry(defs: Record<string, { presentCall?: unknown; presentResult?: unknown }>) {
  return { get: (name: string) => defs[name] } as never
}

describe('TC-PRE-01 呈现器解析工具声明', () => {
  it('工具声明了就用工具的', () => {
    const p = new ToolPresenter(
      registry({ write: { presentCall: () => ({ card: 'diff', title: 'Write a.ts', diffs: [] }) } }),
    )
    expect(p.call(CID, 'write', '{}').card).toBe('diff')
  })

  it('没声明就用通用兜底，标题即工具名', () => {
    const p = new ToolPresenter(registry({}))
    const view = p.call(CID, 'mystery', '{"a":1}')
    expect(view).toEqual({ card: 'generic', title: 'mystery', kind: 'other', rawInput: { a: 1 } })
  })

  it('presentCall 抛错不得打断流式：退回兜底并上报', () => {
    const warned: string[] = []
    const p = new ToolPresenter(
      registry({
        boom: {
          presentCall: () => {
            throw new Error('kaboom')
          },
        },
      }),
      (m) => warned.push(m),
    )
    expect(p.call(CID, 'boom', '{}').card).toBe('generic')
    expect(warned[0]).toContain('presentCall threw')
  })

  it('presentResult 抛错退回原始内容', () => {
    const warned: string[] = []
    const p = new ToolPresenter(
      registry({
        boom: {
          presentResult: () => {
            throw new Error('kaboom')
          },
        },
      }),
      (m) => warned.push(m),
    )
    p.call(CID, 'boom', '{}')
    const view = p.result(CID, [{ type: 'text', text: 'raw' }], false)
    expect(view).toEqual({ card: 'generic', content: [{ type: 'text', text: 'raw' }] })
    expect(warned[0]).toContain('presentResult threw')
  })

  it('结果找不到对应调用（迟到或未知 callId）时给原始内容', () => {
    const p = new ToolPresenter(registry({}))
    expect(p.result(ToolCallId('ghost'), [{ type: 'text', text: 'x' }], false)).toEqual({
      card: 'generic',
      content: [{ type: 'text', text: 'x' }],
    })
  })

  it('孤儿防护：调用侧不是终端时，结果侧的终端视图降级为通用', () => {
    const p = new ToolPresenter(
      registry({
        weird: {
          presentCall: () => ({ card: 'generic', title: 'weird' }),
          presentResult: () => ({ card: 'terminal', output: 'hi' }),
        },
      }),
    )
    p.call(CID, 'weird', '{}')
    const view = p.result(CID, [{ type: 'text', text: 'raw' }], false)
    // 否则 _meta.terminal_output 会指向一个客户端从未创建过的终端
    expect(view.card).toBe('generic')
  })

  it('通用结果只换标题时补上原始内容，卡片不被清空', () => {
    const p = new ToolPresenter(
      registry({ t: { presentResult: () => ({ card: 'generic', title: '完成' }) } }),
    )
    p.call(CID, 't', '{}')
    expect(p.result(CID, [{ type: 'text', text: 'raw' }], false)).toEqual({
      card: 'generic',
      title: '完成',
      content: [{ type: 'text', text: 'raw' }],
    })
  })

  it('参数非法 JSON 时保留原始字符串 —— 那往往正是要排查的东西', () => {
    expect(parseToolArguments('{oops')).toBe('{oops')
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('TC-MAP-01 通用卡片', () => {
  it('映射 title / kind / rawInput / locations', () => {
    const view: ToolCallView = {
      card: 'generic',
      title: 'Read a.ts',
      kind: 'read',
      rawInput: { path: 'a.ts' },
      locations: [{ path: FILE, line: 12 }],
    }
    expect(toolCallUpdate(CID, view, withTerminal)).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: CID,
      title: 'Read a.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
      locations: [{ path: FILE, line: 12 }],
    })
  })

  it('未声明 kind 时落到 other', () => {
    const update = toolCallUpdate(CID, { card: 'generic', title: 't' })
    expect(update).toMatchObject({ kind: 'other' })
  })
})

describe('TC-MAP-02 diff 卡片（US-09）', () => {
  it('产出 diff content 块，kind 固定为 edit', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Write a.ts',
      diffs: [{ path: FILE, oldText: null, newText: 'hi' }],
    }
    expect(toolCallUpdate(CID, view, withTerminal)).toMatchObject({
      kind: 'edit',
      content: [{ type: 'diff', path: FILE, oldText: null, newText: 'hi' }],
    })
  })

  it('结果侧同样发 diff —— 否则模型的结果文本会把 diff 冲掉', () => {
    const view: ToolResultView = {
      card: 'diff',
      diffs: [{ path: FILE, oldText: 'a', newText: 'b' }],
    }
    expect(toolResultUpdate(CID, view, false, withTerminal)).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      content: [{ type: 'diff', path: FILE, oldText: 'a', newText: 'b' }],
    })
  })
})

describe('TC-MAP-03 终端卡片（US-10）', () => {
  const call: ToolCallView = { card: 'terminal', title: 'ls -la', description: '列目录', cwd: 'src' }

  it('客户端支持时给 terminal 块与 terminal_info（cwd 按工作区解析）', () => {
    const update = toolCallUpdate(CID, call, withTerminal)
    expect(update).toMatchObject({
      kind: 'execute',
      content: [
        { type: 'content', content: { type: 'text', text: '列目录' } },
        { type: 'terminal', terminalId: CID },
      ],
      _meta: { terminal_info: { terminal_id: CID, cwd: join(WS, 'src') } },
    })
  })

  it('客户端不支持时只有描述，没有 _meta，也没有 terminal 块', () => {
    const update = toolCallUpdate(CID, call, NO_TERMINAL)
    expect(update).not.toHaveProperty('_meta')
    expect(update.content).toEqual([{ type: 'content', content: { type: 'text', text: '列目录' } }])
  })

  it('rawInput 是参数对象：命令 + 描述 + 解析后的 cwd，与 terminal_info 表头同源', () => {
    const update = toolCallUpdate(CID, call, withTerminal)
    expect(update.rawInput).toEqual({ command: 'ls -la', description: '列目录', cwd: join(WS, 'src') })
  })

  it('没有终端能力时 rawInput 照发 —— 那时 cwd 没有别的出路', () => {
    // 正是这条路径上的客户端最需要它：`_meta` 一个字节都不发，工作目录只剩这里。
    const update = toolCallUpdate(CID, call, { enabled: false, cwd: WS })
    expect(update).not.toHaveProperty('_meta')
    expect(update.rawInput).toEqual({ command: 'ls -la', description: '列目录', cwd: join(WS, 'src') })
  })

  it('描述与 cwd 都缺席时不塞空键 —— 客户端会把它们当成「有但为空」', () => {
    const bare: ToolCallView = { card: 'terminal', title: 'pwd' }
    expect(toolCallUpdate(CID, bare, NO_TERMINAL).rawInput).toEqual({ command: 'pwd' })
  })

  it('结果侧走 _meta 且**不带 content** —— content 会整体替换掉终端块', () => {
    const view: ToolResultView = { card: 'terminal', output: 'a\nb', exitCode: 0 }
    const update = toolResultUpdate(CID, view, false, withTerminal)
    expect(update).not.toHaveProperty('content')
    // 载荷键必须是 `data`。这里曾经写成 `output`，纯函数用例照着实现写就一起
    // 错了——真实客户端下的表现是终端建出来了但永远空着。
    expect(update).toMatchObject({
      _meta: {
        terminal_output: { terminal_id: CID, data: 'a\nb' },
        terminal_exit: { terminal_id: CID, exit_code: 0 },
      },
    })
    const meta = (update as { _meta?: { terminal_output?: Record<string, unknown> } })._meta
    expect(meta?.terminal_output).not.toHaveProperty('output')
  })

  it('信号致死给 signal 而非 exit_code', () => {
    const update = toolResultUpdate(CID, { card: 'terminal', output: '', signal: 'SIGTERM' }, false, withTerminal)
    expect(update).toMatchObject({ _meta: { terminal_exit: { terminal_id: CID, signal: 'SIGTERM' } } })
  })

  it('退出状态未知时什么都不给 —— 编一个 exit 0 会把「不知道」显示成「成功」', () => {
    const update = toolResultUpdate(CID, { card: 'terminal', output: 'x' }, false, withTerminal)
    const meta = (update as { _meta?: Record<string, unknown> })._meta
    expect(meta).toHaveProperty('terminal_output')
    expect(meta).not.toHaveProperty('terminal_exit')
  })

  it('客户端不支持时退回围栏 console 文本', () => {
    const update = toolResultUpdate(CID, { card: 'terminal', output: 'out', exitCode: 2 }, false, NO_TERMINAL)
    const text = (update.content?.[0] as { content?: { text?: string } })?.content?.text
    expect(text).toContain('```console')
    expect(text).toContain('out')
    expect(text).toContain('[exit 2]')
  })

  it('terminalCwd：绝对路径原样，相对路径按工作区解析，缺省用工作区', () => {
    const absolute = resolve(WS, '..', 'abs')
    expect(terminalCwd(absolute, WS)).toBe(absolute)
    expect(terminalCwd('sub', WS)).toBe(join(WS, 'sub'))
    expect(terminalCwd(undefined, WS)).toBe(WS)
    expect(terminalCwd(undefined, undefined)).toBeUndefined()
  })
})

describe('TC-MAP-04 未来卡片变体不得打断流式', () => {
  it('未知调用卡片降级为通用，不抛错', () => {
    const future = { card: 'hologram', title: '未来卡片' } as unknown as ToolCallView
    expect(() => toolCallUpdate(CID, future)).not.toThrow()
    expect(toolCallUpdate(CID, future)).toMatchObject({ sessionUpdate: 'tool_call', title: '未来卡片', kind: 'other' })
  })

  it('未知结果卡片只更新状态，保留调用侧内容', () => {
    const future = { card: 'hologram' } as unknown as ToolResultView
    expect(() => toolResultUpdate(CID, future, false)).not.toThrow()
    expect(toolResultUpdate(CID, future, false)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: CID,
      status: 'completed',
    })
  })

  it('search / read 这类带 content 的新变体用它们的 content', () => {
    const read = {
      card: 'read',
      path: 'a.ts',
      offset: 1,
      lines: [],
      totalLines: 0,
      content: [{ type: 'text', text: 'file body' }],
    } as unknown as ToolResultView
    expect(toolResultUpdate(CID, read, false)).toMatchObject({
      content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
    })
  })

  it('失败结果状态为 failed', () => {
    expect(toolResultUpdate(CID, { card: 'generic' }, true)).toMatchObject({ status: 'failed' })
  })
})

describe('TC-MAP-05 事件映射', () => {
  const presenter = new ToolPresenter(registry({}))

  it('tool/call 产出 tool_call', () => {
    const event = {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: CID, name: 'ls', arguments: '{}' },
    } as unknown as SessionEvent
    expect(mapEvent(event, { presenter })).toMatchObject([{ sessionUpdate: 'tool_call', toolCallId: CID }])
  })

  it('tool/result 从 message.content[0] 读取 callId 与结果', () => {
    presenter.call(CID, 'ls', '{}')
    const event = {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: CID, content: [{ type: 'text', text: 'ok' }], isError: false }],
        },
      },
    } as unknown as SessionEvent
    expect(mapEvent(event, { presenter })).toMatchObject([
      { sessionUpdate: 'tool_call_update', toolCallId: CID, status: 'completed' },
    ])
  })

  it('非 append 的 tool/result 是转录改写，不重新呈现', () => {
    const event = {
      type: 'tool/result',
      surfaceOp: 'replace',
      data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: CID, content: [] }] } },
    } as unknown as SessionEvent
    expect(mapEvent(event, { presenter })).toEqual([])
  })

  it('没有呈现器时工具事件不产出更新（纯对话部署）', () => {
    const event = {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: CID, name: 'ls', arguments: '{}' },
    } as unknown as SessionEvent
    expect(mapEvent(event)).toEqual([])
  })

  it('todo/write → plan（US-13）', () => {
    const event = {
      type: 'todo/write',
      data: { todos: [{ content: '写测试', status: 'in_progress' }] },
    } as unknown as SessionEvent
    expect(mapEvent(event)).toEqual([
      { sessionUpdate: 'plan', entries: [{ content: '写测试', priority: 'medium', status: 'in_progress' }] },
    ])
  })

  it('harness 待办没有优先级，一律 medium 而非凭空编一个', () => {
    const plan = todosToPlan([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'completed' },
    ] as never)
    expect(plan.entries.map((e) => e.priority)).toEqual(['medium', 'medium'])
  })

  it('未知事件类型静默返回空数组', () => {
    expect(mapEvent({ type: 'future/event', data: {} } as unknown as SessionEvent)).toEqual([])
  })
})

describe('TC-MAP-06 路径呈现', () => {
  it('标题里的工作区内绝对路径相对化', () => {
    expect(displayTitle(`Read ${SOURCE_FILE}`, SOURCE_FILE, WS)).toBe(`Read ${join('src', 'a.ts')}`)
  })

  it('工作区外的路径保持绝对 —— 相对化会误导', () => {
    expect(displayTitle(`Read ${OUTSIDE_FILE}`, OUTSIDE_FILE, WS)).toBe(`Read ${OUTSIDE_FILE}`)
  })

  it('没有路径或没有工作区时原样', () => {
    expect(displayTitle('ls -la', undefined, WS)).toBe('ls -la')
    expect(displayTitle('Read /a/b', '/a/b', undefined)).toBe('Read /a/b')
  })

  it('locations 不相对化 —— 那是给编辑器定位用的，改了会静默跳不过去', () => {
    const update = toolCallUpdate(
      CID,
      { card: 'generic', title: `Read ${FILE}`, locations: [{ path: FILE }] },
      withTerminal,
    )
    expect(update.title).toBe('Read a.ts')
    expect(update.locations).toEqual([{ path: FILE }])
  })

  it('结果卡的标题也相对化 —— 否则同一张卡完成时会换个写法', () => {
    const update = toolResultUpdate(
      CID,
      { card: 'diff', title: `Wrote ${FILE}`, diffs: [{ path: FILE, oldText: null, newText: 'hi' }] },
      false,
      withTerminal,
    )
    // 标题给人看：相对。diff 的 path 给编辑器定位：绝对。
    expect(update.title).toBe('Wrote a.ts')
    expect(update.content).toEqual([{ type: 'diff', path: FILE, oldText: null, newText: 'hi' }])
  })

  it('结果卡没给标题时不凭空造一个 —— 保留调用侧的标题', () => {
    const update = toolResultUpdate(CID, { card: 'diff', diffs: [{ path: FILE, oldText: null, newText: 'hi' }] }, false, withTerminal)
    expect(update).not.toHaveProperty('title')
  })

  it('insideWorkspace 边界', () => {
    expect(insideWorkspace(join(WS, 'a'), WS)).toBe(true)
    expect(insideWorkspace(WS, WS)).toBe(false)
    expect(insideWorkspace(join(`${WS}-other`, 'a'), WS)).toBe(false)
    expect(insideWorkspace(resolve(WS, '..', 'other'), WS)).toBe(false)
  })
})

describe('TC-MAP-07 内容块编解码', () => {
  it('文本直通', () => {
    expect(harnessBlockToAcpContent({ type: 'text', text: 'x' })).toEqual({ type: 'text', text: 'x' })
  })

  it('reasoning 不进工具卡片正文 —— 它有自己的通道', () => {
    expect(harnessBlockToAcpContent({ type: 'reasoning', text: 'think' })).toBeUndefined()
  })

  it('未知块返回 undefined 而非抛错（ContentBlockMap 可声明合并扩展）', () => {
    expect(harnessBlockToAcpContent({ type: 'hologram' } as never)).toBeUndefined()
  })
})
