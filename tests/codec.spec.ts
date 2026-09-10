/**
 * TC-CODEC-* —— 纯函数编解码。无任何运行时依赖。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { acpPromptToText, promptHasUnsupportedContent } from '../src/codec/prompt.js'
import { turnEndToStopReason } from '../src/codec/stop-reason.js'
import { AssistantStreamRelay } from '../src/mapping/assistant-stream.js'
import { mapEvent } from '../src/mapping/updates.js'
import { handleInitialize } from '../src/protocol/initialize.js'
import { messageEvent, reasoningRun, replayStream, textRun } from './assistant-stream.js'

describe('turnEndToStopReason', () => {
  it('把每个已知 TurnEndReason 映射为合法 StopReason', () => {
    const cases: Array<[TurnEndReason['kind'], string]> = [
      ['completed', 'end_turn'],
      ['max-tokens', 'max_tokens'],
      ['aborted', 'end_turn'],
      ['interrupted', 'cancelled'],
      ['blocked', 'end_turn'],
    ]
    for (const [kind, expected] of cases) {
      expect(turnEndToStopReason({ kind } as TurnEndReason), kind).toBe(expected)
    }
  })

  it('error 结束不产出误导性的 max_tokens/cancelled', () => {
    const reason = { kind: 'error', error: new Error('boom') } as unknown as TurnEndReason
    expect(turnEndToStopReason(reason)).toBe('end_turn')
  })

  it('对未来新增的 kind 回退 end_turn 而非抛错', () => {
    // TurnEndReason 可被插件声明合并扩展；抛错会让 prompt 永挂。
    const future = { kind: 'some-future-kind' } as unknown as TurnEndReason
    expect(turnEndToStopReason(future)).toBe('end_turn')
  })
})

describe('acpPromptToText', () => {
  it('按线序拼接 text 块', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]
    expect(acpPromptToText(prompt)).toBe('ab')
  })

  it('把 resource_link 渲染为显式文本引用而非丢弃', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'see ' },
      { type: 'resource_link', uri: 'file:///a/b.ts', name: 'b.ts' },
    ]
    const text = acpPromptToText(prompt)
    expect(text).toContain('resource_link')
    expect(text).toContain('file:///a/b.ts')
    expect(text).toContain('b.ts')
  })

  it('内嵌 resource 的文本整段内联 —— 这才是 embeddedContext 的用处', () => {
    // 它带得动**磁盘上没有**的内容：未保存的缓冲区、剪贴板片段、diff 视图里
    // 选中的一段。渲染成引用而非直接拼接，是为了让模型分得清哪段是附件。
    const prompt: ContentBlock[] = [
      { type: 'text', text: '看这个：' },
      { type: 'resource', resource: { uri: 'file:///a/b.ts', mimeType: 'text/x-typescript', text: 'const x = 1' } },
    ]
    const text = acpPromptToText(prompt)
    expect(text).toContain('const x = 1')
    expect(text).toContain('file:///a/b.ts')
    expect(text).toContain('text/x-typescript')
  })

  it('二进制 resource 渲染成引用，不把 base64 塞进提示词', () => {
    // 内联 base64 既贵又没用；但也**不能静默丢掉**——模型看得见「这有个附件
    // 我读不了」，比凭空少一段上下文强。
    const prompt: ContentBlock[] = [
      { type: 'resource', resource: { uri: 'file:///a/x.png', mimeType: 'image/png', blob: 'iVBORw0KGgo=' } },
    ]
    const text = acpPromptToText(prompt)
    expect(text).toContain('file:///a/x.png')
    expect(text).toContain('image/png')
    expect(text).not.toContain('iVBORw0KGgo=')
  })

  it('无文本块时返回空串', () => {
    expect(acpPromptToText([])).toBe('')
  })
})

describe('promptHasUnsupportedContent', () => {
  it('放行 text、resource_link 与内嵌 resource', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'x' },
      { type: 'resource_link', uri: 'file:///a', name: 'a' },
      { type: 'resource', resource: { uri: 'file:///b', text: 'y' } },
    ]
    expect(promptHasUnsupportedContent(prompt)).toBe(false)
  })

  it('识别出 audio —— 上游没有音频路由，它确实未 advertise', () => {
    expect(promptHasUnsupportedContent([{ type: 'audio', data: 'x', mimeType: 'audio/wav' }])).toBe(true)
  })

  it('放行 image —— 它能不能真的收下不是纯函数判得了的', () => {
    // 图片要不要拒绝取决于两件运行时的事：组合挂没挂附件服务、以及会话**当前**
    // 这条路由收不收图。所以这里放行，由 `handlePrompt` 用具体理由拒绝——那种
    // 拒绝说得出「换哪个模型」，而这里只能说「不支持」。
    expect(promptHasUnsupportedContent([{ type: 'image', data: 'x', mimeType: 'image/png' }])).toBe(false)
  })

  it('放行集合与 initialize 声明的能力**逐项一致**', () => {
    // 两处是同一件事的两半，分开写就会分叉：那边多声明一项而这边不放行，
    // 客户端收到的是「你说你支持」的困惑错误；这边多放行而那边不声明，
    // 规矩的客户端根本不会发过来。这条用例就是把它们钉在一起。
    //
    // `image: true` 是必须传的：它**按组合动态声明**（挂了附件服务才为真），
    // 而纯函数这边没有组合可看，恒放行。拿默认参数去比等于拿「没挂附件服务的
    // 部署」跟「放行集合」比，那两者本来就不该相等。
    const caps = handleInitialize({ persistent: false, image: true }).agentCapabilities
      ?.promptCapabilities
    const probe = (block: ContentBlock): boolean => !promptHasUnsupportedContent([block])
    expect(probe({ type: 'image', data: 'x', mimeType: 'image/png' })).toBe(caps?.image ?? false)
    expect(probe({ type: 'audio', data: 'x', mimeType: 'audio/wav' })).toBe(caps?.audio ?? false)
    expect(probe({ type: 'resource', resource: { uri: 'file:///a', text: 'x' } })).toBe(
      caps?.embeddedContext ?? false,
    )
  })

  it('没挂附件服务时 initialize 不声明 image', () => {
    // 与上面那条互补：动态声明真的是动态的，不是恒 true。
    expect(handleInitialize().agentCapabilities?.promptCapabilities?.image).toBe(false)
  })
})

describe('mapEvent', () => {
  it('重放时把落库的紧凑流展开成 agent_message_chunk（US-03）', () => {
    expect(replayStream([textRun('Hel', 'lo')])).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: '1:1', content: { type: 'text', text: 'Hello' } },
    ])
  })

  it('推理 run 展开成 agent_thought_chunk', () => {
    expect(replayStream([reasoningRun('think')])).toEqual([
      { sessionUpdate: 'agent_thought_chunk', messageId: '1:1', content: { type: 'text', text: 'think' } },
    ])
  })

  it('正文与推理共享同一个 messageId，换一步就换一个', () => {
    // ACP 对 `messageId` 的语义是「值变了即新消息开始」。推理与正文属于同一条
    // 助手消息，必须同 id；下一步（工具跑完之后那次模型调用）才是新消息。
    const idOf = (record: unknown, turn?: number, step?: number): unknown =>
      (replayStream([record], turn, step)[0] as { messageId?: string }).messageId
    expect(idOf(textRun('a'))).toBe(idOf(reasoningRun('b')))
    expect(idOf(textRun('a'))).not.toBe(idOf(textRun('a'), 1, 2))
    expect(idOf(textRun('a'))).not.toBe(idOf(textRun('a'), 2, 1))
  })

  it('非文本片（如 block-start）不产出更新', () => {
    expect(replayStream([{ type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } }]))
      .toEqual([])
  })

  it('**不重放**时一条分片都不发 —— 实时路径的文本走帧流，不走这里', () => {
    // 这一条钉着 0.1.5 之后最容易出的那个错：日志里的紧凑流与进程内的帧流是
    // 同一段文字的两种载体，两边都发就是每句话说两遍。
    expect(mapEvent(messageEvent([textRun('Hello')]))).toEqual([])
  })

  it('未知事件类型静默忽略而非抛错', () => {
    // SessionEventMap 由各插件声明合并，组合可插拔，未知事件是正常状态。
    expect(() => mapEvent({ type: 'some/future-event', data: {} } as never)).not.toThrow()
    expect(mapEvent({ type: 'some/future-event', data: {} } as never)).toEqual([])
  })

  it('是事件的纯函数：同一输入恒产出相等输出（TC-PROP-03 基础）', () => {
    const event = messageEvent([textRun('same')])
    expect(mapEvent(event, { replay: true })).toEqual(mapEvent(event, { replay: true }))
  })
})

describe('AssistantStreamRelay —— 实时帧流', () => {
  // `revision` 在真实帧上是**逐帧自增**的发布序号，不是「第几次尝试」。夹具照着
  // 这个事实造帧：写成常量的话，一个错误地把它拼进键的实现照样能通过。
  let revision = 0
  const start = (turn: number, step: number, attemptId = 'a-1') =>
    ({ type: 'start', attemptId, revision: ++revision, turn, step }) as never
  const chunk = (chunk: unknown, attemptId = 'a-1') =>
    ({ type: 'chunk', attemptId, revision: ++revision, index: 0, time: 0, chunk }) as never
  const end = (attemptId = 'a-1') =>
    ({ type: 'end', attemptId, revision: ++revision, index: 1, outcome: { kind: 'abandoned' } }) as never

  it('分片带上 start 帧那次尝试的 turn/step —— 与重放给出同一个 messageId', () => {
    const relay = new AssistantStreamRelay()
    expect(relay.frame(start(2, 3))).toEqual([])
    expect(relay.frame(chunk({ type: 'text-delta', index: 0, text: 'hi' }))).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: '2:3', content: { type: 'text', text: 'hi' } },
    ])
  })

  it('没见过 start 的尝试一片都不发 —— 编一个 messageId 会把它拆成另一个气泡', () => {
    const relay = new AssistantStreamRelay()
    expect(relay.frame(chunk({ type: 'text-delta', index: 0, text: 'hi' }))).toEqual([])
  })

  it('end 之后同一个 attemptId 不再复用旧的 turn/step', () => {
    const relay = new AssistantStreamRelay()
    relay.frame(start(1, 1))
    relay.frame(end())
    expect(relay.frame(chunk({ type: 'text-delta', index: 0, text: 'late' }))).toEqual([])
  })

  it('同一次尝试被重发 start 时按新的那次算', () => {
    const relay = new AssistantStreamRelay()
    relay.frame(start(1, 1))
    relay.frame(start(4, 2))
    expect(relay.frame(chunk({ type: 'text-delta', index: 0, text: 'x' }))).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: '4:2', content: { type: 'text', text: 'x' } },
    ])
  })

  it('两次并存的尝试互不串台', () => {
    const relay = new AssistantStreamRelay()
    relay.frame(start(1, 1, 'a-1'))
    relay.frame(start(9, 9, 'a-2'))
    expect(relay.frame(chunk({ type: 'text-delta', index: 0, text: 'x' }, 'a-1'))).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: '1:1', content: { type: 'text', text: 'x' } },
    ])
  })
})
