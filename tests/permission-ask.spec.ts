/**
 * TC-ASK-* —— 提问的降级通道（US-21 兜底）。
 *
 * 客户端没有表单征询时，带选项的问题走 `session/request_permission`。这条路径
 * 存在的前提是一个能力面事实：`elicitation/create` 是可选方法且受能力位门控，
 * 而 `session/request_permission` 在 ACP 的 `Client` 接口里是必选的——前者可能
 * 不存在，后者一定存在。
 *
 * 与表单路径共享两条硬约束，两边都要各自守住：答案里**不能有 `custom`**
 * （`exit_plan_mode` 判定批准的条件之一），取消**必须**是 `ASK_CANCELLED`
 * （plan mode 认这个 code）。这两条错了，界面上一切正常，只是计划永远批不过。
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import {
  answerFromOutcome,
  askViaPermission,
  toPermissionRequest,
  type PermissionAskDeps,
} from '../src/answerers/permission-ask.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

const SESSION = 'sess-1' as SessionId
const CALL = 'call-1'

/** 一道普通单选题。 */
const PICK: AskUserQuestionItem = {
  id: 'pick',
  question: '用哪种缓存？',
  options: [
    { label: 'Redis', description: '要额外部署' },
    { label: '内存', description: '重启即失效' },
  ],
}

/** 计划评审题：与 `exit_plan_mode` 实际发出的那一份同构。 */
const REVIEW: AskUserQuestionItem = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '# 方案\n\n先改 A 再改 B。',
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' },
}

/** 卡片正文里的纯文本，便于整体查找。 */
function cardText(request: RequestPermissionRequest): string {
  return (request.toolCall.content ?? [])
    .map((entry) => (entry.type === 'content' && entry.content.type === 'text' ? entry.content.text : ''))
    .join('\n')
}

/** 选中第 n 个选项的应答。 */
function pickNth(request: RequestPermissionRequest, n: number): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId: request.options[n]?.optionId ?? '' } }
}

describe('TC-ASK-01 问题 → 授权请求', () => {
  it('选项变按钮，说明进卡片正文而不是按钮名', () => {
    const request = toPermissionRequest(SESSION, PICK, CALL)

    expect(request.sessionId).toBe(SESSION)
    expect(request.toolCall.toolCallId).toBe(CALL)
    expect(request.toolCall.title).toBe('用哪种缓存？')
    // `PermissionOption` 没有 description 槽位。把说明拼进 `name` 会得到一排
    // 长到没法看的按钮，所以按钮只留标签，说明放正文。
    expect(request.options.map((o) => o.name)).toEqual(['Redis', '内存'])
    expect(cardText(request)).toContain('**Redis** — 要额外部署')
    expect(cardText(request)).toContain('**内存** — 重启即失效')
  })

  it('optionId 按下标，不用标签 —— 重复标签不该串答案', () => {
    const request = toPermissionRequest(
      SESSION,
      { id: 'dup', question: '选哪个？', options: [{ label: '同名' }, { label: '同名' }] },
      CALL,
    )
    expect(request.options.map((o) => o.optionId)).toEqual(['opt-0', 'opt-1'])
    // 两个标签相同，但两颗按钮必须是可区分的。
    expect(new Set(request.options.map((o) => o.optionId)).size).toBe(2)
  })

  it('多选题降级为单选时，标题里说清楚', () => {
    const request = toPermissionRequest(
      SESSION,
      { id: 'm', question: '要哪些？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
      CALL,
    )
    // 用户点不了第二项时，「界面坏了」与「本来就只能选一项」是两种体验。
    expect(request.toolCall.title).toContain('只能选一项')
  })

  it('计划评审：批准项是 allow，其余是 reject，方案正文可读', () => {
    const request = toPermissionRequest(SESSION, REVIEW, CALL)

    expect(request.options).toEqual([
      { optionId: 'opt-0', name: 'Approve', kind: 'allow_once' },
      { optionId: 'opt-1', name: 'Keep planning', kind: 'reject_once' },
    ])
    // 看不见方案的「批准」按钮毫无意义。
    expect(cardText(request)).toContain('# 方案')
    expect(request.toolCall.kind).toBe('switch_mode')
  })

  it('普通问题的选项之间没有褒贬，一律 allow_once —— 且永不产出 allow_always', () => {
    const generic = toPermissionRequest(SESSION, PICK, CALL)
    expect(generic.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_once'])
    // `allow_always` 是在告诉客户端「可以记住这个选择」，而下一个问题与这一个
    // 毫无关系——记住的结果就是替用户答了一个他没看过的问题。
    for (const request of [generic, toPermissionRequest(SESSION, REVIEW, CALL)]) {
      expect(request.options.map((o) => o.kind)).not.toContain('allow_always')
    }
  })
})

describe('TC-ASK-02 应答 → 结构化回答', () => {
  it('答案是 selected 一项，且 custom 必须不存在', () => {
    const answer = answerFromOutcome(PICK, { outcome: { outcome: 'selected', optionId: 'opt-1' } })
    expect(answer).toEqual({ id: 'pick', selected: ['内存'] })
    // 这条是给 `exit_plan_mode` 守门的：它判定通过的条件包含
    // `custom === undefined`，塞一个空串会让任何计划都通不过评审。
    expect(answer).not.toHaveProperty('custom')
  })

  it('取消翻成 ASK_CANCELLED —— 与表单路径同一个 code', () => {
    // plan mode 专门认它，据此告诉模型「用户想改说别的，留在计划模式等消息」。
    expect(() => answerFromOutcome(PICK, { outcome: { outcome: 'cancelled' } })).toThrow(
      expect.objectContaining({ code: 'ASK_CANCELLED' }) as never,
    )
  })

  it('未知 optionId 报错而不是猜一个 —— 猜错在计划评审里等于替用户点了批准', () => {
    expect(() => answerFromOutcome(PICK, { outcome: { outcome: 'selected', optionId: 'opt-9' } })).toThrow(
      expect.objectContaining({ code: 'NO_ANSWER' }) as never,
    )
  })
})

describe('TC-ASK-03 提问循环', () => {
  const deps = (
    requestPermission: PermissionAskDeps['requestPermission'],
  ): PermissionAskDeps => ({
    ...(requestPermission === undefined ? {} : { requestPermission }),
    sessionOf: () => SESSION,
    soleCallOf: () => CALL,
  })

  it('多问题串行发出，逐个作答', async () => {
    const seen: RequestPermissionRequest[] = []
    const answer = await askViaPermission(
      {
        questions: [PICK, { id: 'go', question: '继续吗？', options: [{ label: '继续' }, { label: '停' }] }],
        agent: {},
      },
      deps(async (params) => {
        seen.push(params)
        return pickNth(params, 0)
      }),
    )

    expect(seen.map((r) => r.toolCall.title)).toEqual(['用哪种缓存？', '继续吗？'])
    expect(answer.answers).toEqual([
      { id: 'pick', selected: ['Redis'] },
      { id: 'go', selected: ['继续'] },
    ])
  })

  it('任一问题没有选项就整体拒绝，且一次都不问 —— 否则用户白答一次', async () => {
    const seen: RequestPermissionRequest[] = []
    await expect(
      askViaPermission(
        { questions: [PICK, { id: 'free', question: '还有别的吗？' }], agent: {} },
        deps(async (params) => {
          seen.push(params)
          return pickNth(params, 0)
        }),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'UNSUPPORTED' }) as never)
    // 校验若放在循环里，用户会答完第一题才撞上失败，那一次作答完全白费。
    expect(seen).toEqual([])
  })

  it('挂到唯一在飞的那次调用上；判定不了时才合成 id', async () => {
    const ids: string[] = []
    const capture: PermissionAskDeps['requestPermission'] = async (params) => {
      ids.push(params.toolCall.toolCallId)
      return pickNth(params, 0)
    }
    await askViaPermission({ questions: [PICK], agent: {} }, deps(capture))
    await askViaPermission({ questions: [PICK], agent: {} }, { ...deps(capture), soleCallOf: () => undefined })

    // 挂到真实调用上，提示就出现在 ask_user_question 自己的卡片里；判定不了
    // （并行工具）时宁可多一张卡片，也不要挂到隔壁工具头上。
    expect(ids).toEqual([CALL, 'ask-pick'])
  })

  it('没有连接时不是「用户拒绝」，是提不了问', async () => {
    await expect(askViaPermission({ questions: [PICK], agent: {} }, deps(undefined))).rejects.toThrow(
      expect.objectContaining({ code: 'NO_CONNECTION' }) as never,
    )
  })
})

describe('TC-ASK-04 端到端：客户端没有表单能力时照样能问', () => {
  /** 让模型发起一次 ask_user_question 调用，返回会话 id。 */
  async function askThroughModel(h: TestHarness, questions: unknown): Promise<string> {
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-ask-'), mcpServers: [] })
    h.llm.toolCall = { id: 'ask-1', name: 'ask_user_question', args: JSON.stringify({ questions }) }
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '开始' }] })
    return String(sessionId)
  }

  it('ask_user_question 走授权通道，答案落回工具结果', async () => {
    const h = await createHarness({ questions: true, elicitation: false })
    h.setPermissionResponder((request) => pickNth(request, 0))

    const sessionId = await askThroughModel(h, [
      { id: 'pick', question: '用哪种缓存？', options: [{ label: 'Redis' }, { label: '内存' }] },
    ])

    expect(h.elicitations).toEqual([])
    expect(h.permissionRequests).toHaveLength(1)
    expect(h.permissionRequests[0]?.toolCall.title).toBe('用哪种缓存？')
    // 挂的是**模型这次调用**的 id（`ask-1`）而不是合成的 `ask-pick`：这一条
    // 才证明 presenter 那条线真的接上了，提示会出现在工具自己的卡片里。
    expect(h.permissionRequests[0]?.toolCall.toolCallId).toBe('ask-1')
    // 落回会话日志才证明答案的**形状**被上游接受了，而不只是「按钮显示出来过」。
    const agent = h.ctx.agents.get(sessionId as never)
    const results = JSON.stringify(agent?.session.events.filter((e) => e.type === 'tool/result') ?? [])
    expect(results).toContain('Redis')
    h.disposeBridge()
  }, 30_000)

  it('exit_plan_mode 的计划评审同样走得通，批准后退出计划模式', async () => {
    // 这条最要紧：计划评审只有提问这一个出口，且它对答案形状（`selected` 恰好
    // 一项且无 `custom`）的要求最严——降级路径走歪一点这里就通不过。
    const h = await createHarness({ planMode: true, elicitation: false })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-ask-'), mcpServers: [] })
    await h.acp.request('session/set_mode', { sessionId, modeId: 'plan' })

    h.setPermissionResponder((request) => pickNth(request, 0)) // opt-0 = Approve
    h.llm.toolCall = {
      id: 'exit-1',
      name: 'exit_plan_mode',
      args: JSON.stringify({ plan: '# 方案\n\n先改 A 再改 B。' }),
    }
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '给个方案' }] })

    const agent = h.ctx.agents.get(sessionId as never)!
    await waitFor(() => h.ctx.planMode.get(agent).active === false, 5_000, 'plan mode exited')
    expect(h.permissionRequests).toHaveLength(1)
    // 方案正文要在卡片里，否则用户批的是一个自己没看过的东西。
    expect(cardText(h.permissionRequests[0]!)).toContain('# 方案')
    h.disposeBridge()
  }, 30_000)

  it('选了「继续规划」时不退出 —— 只有精确的批准标签才算通过', async () => {
    const h = await createHarness({ planMode: true, elicitation: false })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-ask-'), mcpServers: [] })
    await h.acp.request('session/set_mode', { sessionId, modeId: 'plan' })

    h.setPermissionResponder((request) => pickNth(request, 1)) // opt-1 = Keep planning
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
