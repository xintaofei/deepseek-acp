/**
 * TC-ELI-* —— 表单征询（US-21）。
 *
 * 这条链有两个消费方：模型直接调的 `ask_user_question`，以及 plan mode 的
 * `exit_plan_mode`（计划评审就是一次带选项的征询）。所以这里不只测「问题显示
 * 出来了」，还测**答案的形状**：`exit_plan_mode` 判定通过的条件是 `selected`
 * 恰好一项且 `custom` 不存在，给每个选项题都塞一个空 `custom` 会让任何计划都
 * 通不过评审——而那种错误在「问题显示出来了」这层是看不见的。
 */

import { describe, expect, it } from 'vitest'
import type { CreateElicitationRequest, ElicitationSchema } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { toAnswer, toElicitation } from '../src/answerers/elicitation.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

const SESSION = 'sess-1' as SessionId

/** 取出请求里的表单 schema。 */
function schemaOf(request: CreateElicitationRequest): ElicitationSchema {
  return (request as unknown as { requestedSchema: ElicitationSchema }).requestedSchema
}

/** 让模型发起一次 ask_user_question 调用，返回会话 id。 */
async function askThroughModel(h: TestHarness, questions: unknown): Promise<string> {
  const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-eli-'), mcpServers: [] })
  h.llm.toolCall = { id: 'ask-1', name: 'ask_user_question', args: JSON.stringify({ questions }) }
  await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '开始' }] })
  return String(sessionId)
}

/** 某会话已记录的工具结果，序列化后便于整体查找。 */
function toolResults(h: TestHarness, sessionId: string): string {
  const agent = h.ctx.agents.get(sessionId as never)
  return JSON.stringify(agent?.session.events.filter((e) => e.type === 'tool/result') ?? [])
}

describe('TC-ELI-01 问题 → 表单', () => {
  it('单选题给带标题的枚举，选项说明一并带上', () => {
    const item: AskUserQuestionItem = {
      id: 'q1',
      header: '选一个',
      question: '用哪种缓存？',
      detail: '两种都能跑通',
      options: [
        { label: 'Redis', description: '要额外部署' },
        { label: '内存', description: '重启即失效' },
      ],
    }
    const request = toElicitation(SESSION, [item])

    expect(request.mode).toBe('form')
    expect(request.message).toBe('用哪种缓存？')
    const property = schemaOf(request).properties?.['q1'] as {
      type: string
      title: string
      description: string
      oneOf: { const: string; title: string; description?: string }[]
    }
    expect(property.type).toBe('string')
    expect(property.title).toBe('选一个')
    expect(property.description).toBe('两种都能跑通')
    expect(property.oneOf).toEqual([
      { const: 'Redis', title: 'Redis', description: '要额外部署' },
      { const: '内存', title: '内存', description: '重启即失效' },
    ])
    // 全部必填：可选字段会让用户提交一个空表单，调用方只能再问一遍。
    expect(schemaOf(request).required).toEqual(['q1'])
  })

  it('多选题给数组，无选项题给自由文本', () => {
    const request = toElicitation(SESSION, [
      { id: 'multi', question: '要哪些？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
      { id: 'free', question: '还有别的吗？' },
    ])
    const properties = schemaOf(request).properties ?? {}

    expect((properties['multi'] as { type: string }).type).toBe('array')
    expect((properties['multi'] as { items: { anyOf: { const: string }[] } }).items.anyOf.map((o) => o.const))
      .toEqual(['A', 'B'])
    expect((properties['free'] as { type: string }).type).toBe('string')
    expect((properties['free'] as { oneOf?: unknown }).oneOf).toBeUndefined()
    // 多问题时标题行只报个数，免得把每个问题重复两遍。
    expect(request.message).toBe('需要你回答 2 个问题')
  })

  it('呈现意图放进 _meta —— 通用客户端忽略它，认识的可以渲染成一次决策', () => {
    const request = toElicitation(SESSION, [
      {
        id: 'review',
        question: '批准吗？',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      },
    ])
    const property = schemaOf(request).properties?.['review'] as { _meta?: { intent?: unknown } }
    expect(property._meta?.intent).toEqual({ kind: 'plan-review', approve: 'Approve' })
  })
})

describe('TC-ELI-02 表单答案 → 结构化回答', () => {
  const options: AskUserQuestionItem[] = [
    { id: 'q1', question: '选一个', options: [{ label: 'Approve' }, { label: 'Reject' }] },
  ]

  it('选项题的答案进 selected，且 custom 必须不存在', () => {
    const answer = toAnswer(options, { action: 'accept', content: { q1: 'Approve' } })
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['Approve'] }])
    // 这条断言是给 `exit_plan_mode` 守门的：它判定通过的条件包含
    // `custom === undefined`，塞一个空串会让任何计划都通不过评审。
    expect(answer.answers[0]).not.toHaveProperty('custom')
  })

  it('不在选项表里的字符串算自由输入，不算选了个不存在的选项', () => {
    const answer = toAnswer(options, { action: 'accept', content: { q1: '都不行，再想想' } })
    expect(answer.answers).toEqual([{ id: 'q1', selected: [], custom: '都不行，再想想' }])
  })

  it('无选项题的答案进 custom', () => {
    const answer = toAnswer([{ id: 'free', question: '说说看' }], {
      action: 'accept',
      content: { free: '用 Redis' },
    })
    expect(answer.answers).toEqual([{ id: 'free', selected: [], custom: '用 Redis' }])
  })

  it('多选把成员与非成员分开', () => {
    const answer = toAnswer(
      [{ id: 'm', question: '要哪些？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
      { action: 'accept', content: { m: ['A', 'C'] } },
    )
    expect(answer.answers).toEqual([{ id: 'm', selected: ['A'], custom: 'C' }])
  })

  it.each([['decline'], ['cancel']])('%s 一律翻成 ASK_CANCELLED —— 上游认这个 code', (action) => {
    // plan mode 专门认 `ASK_CANCELLED`，据此告诉模型「用户想改说别的，留在
    // 计划模式等消息」。换个 code 就退回通用失败文案了。
    expect(() => toAnswer(options, { action } as never)).toThrow(
      expect.objectContaining({ code: 'ASK_CANCELLED' }) as never,
    )
  })

  it('接受了却什么都没回填，当成没作答而不是「选了零项」', () => {
    expect(() => toAnswer(options, { action: 'accept', content: {} })).toThrow(/without any answer/)
  })
})

describe('TC-ELI-03 端到端：模型提问 → 客户端表单 → 工具结果', () => {
  it('ask_user_question 的问题到达客户端，答案回到工具结果里', async () => {
    const h = await createHarness({ questions: true })
    h.setElicitationResponder(() => ({ action: 'accept', content: { pick: 'Redis' } }))

    const sessionId = await askThroughModel(h, [
      { id: 'pick', question: '用哪种缓存？', options: [{ label: 'Redis' }, { label: '内存' }] },
    ])

    expect(h.elicitations).toHaveLength(1)
    expect(h.elicitations[0]?.message).toBe('用哪种缓存？')
    // 工具结果落回会话日志 —— 这一步才证明答案的**形状**被上游接受了，
    // 而不只是「表单弹出来过」。
    expect(toolResults(h, sessionId)).toContain('Redis')
    h.disposeBridge()
  }, 30_000)

  it('客户端没有 elicitation 能力、问题又没有选项时，给出模型读得懂的失败', async () => {
    // **有选项**的问题在这种客户端上会降级到授权通道，见 TC-ASK-04。这里测的是
    // 降级也救不了的那一支：自由文本题在按钮上无处输入。
    const h = await createHarness({ questions: true, elicitation: false })
    const sessionId = await askThroughModel(h, [{ id: 'pick', question: '用哪种？' }])

    expect(h.elicitations).toEqual([])
    // 一颗按钮都没有的授权请求等于一个点不动的弹窗——宁可让模型改口，也不要
    // 发出去。
    expect(h.permissionRequests).toEqual([])
    // 失败要说清是**客户端**的能力缺口，模型才可能改用别的办法（把选项写进
    // 回答里让用户口头选）而不是反复重试同一个工具。
    expect(toolResults(h, sessionId)).toContain('does not support form elicitation')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-ELI-04 计划评审（exit_plan_mode）走的是同一条链', () => {
  it('批准后退出 plan mode，选择器回到常规', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-eli-'), mcpServers: [] })
    await h.acp.request('session/set_mode', { sessionId, modeId: 'plan' })

    h.setElicitationResponder(() => ({ action: 'accept', content: { 'plan-review': 'Approve' } }))
    h.llm.toolCall = {
      id: 'exit-1',
      name: 'exit_plan_mode',
      args: JSON.stringify({ plan: '# 方案\n\n先改 A 再改 B。' }),
    }
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '给个方案' }] })

    const agent = h.ctx.agents.get(sessionId as never)!
    await waitFor(() => h.ctx.planMode.get(agent).active === false, 5_000, 'plan mode exited')
    expect(h.elicitations).toHaveLength(1)
    h.disposeBridge()
  }, 30_000)

  it('选了「继续规划」时不退出 —— 只有精确的批准标签才算通过', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-eli-'), mcpServers: [] })
    await h.acp.request('session/set_mode', { sessionId, modeId: 'plan' })

    h.setElicitationResponder(() => ({ action: 'accept', content: { 'plan-review': 'Keep planning' } }))
    h.llm.toolCall = {
      id: 'exit-1',
      name: 'exit_plan_mode',
      args: JSON.stringify({ plan: '# 方案\n\n先改 A 再改 B。' }),
    }
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '给个方案' }] })

    const agent = h.ctx.agents.get(sessionId as never)!
    expect(h.ctx.planMode.get(agent).active).toBe(true)
    h.disposeBridge()
  }, 30_000)
})
