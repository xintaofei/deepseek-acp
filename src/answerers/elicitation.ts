/**
 * 征询应答器：把 dsh 的 `ctx.userQuestions` 接到 ACP 的 `elicitation/create`
 * 表单上（US-21）。
 *
 * 这条链有两个消费方：模型直接调的 `ask_user_question`，以及 plan mode 的
 * `exit_plan_mode` ——后者的「计划评审」就是一次带选项的征询。因此这里的映射
 * 不能只顾着「能把问题显示出来」，还要保证答案的**形状**与上游期待的一致：
 * `exit_plan_mode` 判定通过的条件是 `selected` 恰好一项且 `custom` **不存在**，
 * 给每个选项题都塞一个空 `custom` 会让任何计划都无法通过评审。
 *
 * ACP 的 elicitation 在 1.3.0 里仍标着 UNSTABLE，且由客户端能力位
 * `elicitation.form` 决定支不支持。**能力判断不在本模块**：选路归
 * `./ask.ts`，客户端没有表单能力时它会降级到授权通道（`./permission-ask.ts`）。
 * @module
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  EnumOption,
} from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'

/** 选项 → ACP 的带标题枚举项（`description` 让客户端把权衡也显示出来）。 */
function enumOptions(item: AskUserQuestionItem): EnumOption[] {
  return (item.options ?? []).map((option) => ({
    // `const` 就是回传值，也就是上游 `selected` 里的标签本身 —— 不另造 id：
    // 上游的答案契约用的是标签，多一层映射就多一处对不上的机会。
    const: option.label,
    title: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
}

/**
 * 一个问题 → 一个表单字段。
 *
 * ACP 的字段只有 `title` 与 `description` 两个文字槽。有 `header` 时它占了
 * `title`，问题正文就得挤进 `description`（排在 `detail` 前面）——否则正文在发出
 * 的那一刻就没了，客户端拿到什么都补不回来（issue #10）。唯一的例外是正文已经
 * 在别处显示：单问题时它就是整张表单的 `message`，再放一遍是重复。
 * @param item - 问题
 * @param questionInMessage - 问题正文是否已经作为表单的 `message` 显示
 */
function propertyFor(item: AskUserQuestionItem, questionInMessage: boolean): ElicitationPropertySchema {
  // 空串 header 当作没有：拿它当标题等于一个空白标签，正文反而被挤走了。
  const header = item.header === '' ? undefined : item.header
  const showQuestion = header !== undefined && header !== item.question && !questionInMessage
  const description = [showQuestion ? item.question : undefined, item.detail]
    .filter((part) => part !== undefined && part !== '')
    .join('\n\n')
  const common = {
    title: header ?? item.question,
    ...(description === '' ? {} : { description }),
    // 呈现意图对通用客户端无意义，但也不该丢：认识 `plan-review` 的客户端可以
    // 把它渲染成一次决策而非普通选项列表，答案编码两种情况完全相同。
    ...(item.intent === undefined ? {} : { _meta: { intent: item.intent } }),
  }
  const options = enumOptions(item)
  // 没有选项 = 自由文本。上游据此把答案放进 `custom` 而不是 `selected`。
  if (options.length === 0) return { type: 'string', ...common }
  if (item.multiSelect === true) return { type: 'array', ...common, items: { anyOf: options } }
  return { type: 'string', ...common, oneOf: options }
}

/**
 * 一组问题 → 一次表单征询。
 *
 * 一次征询承载全部问题（而非每题一次）：ACP 的表单本来就是「一个 schema 多个
 * 字段」，拆成多次会让用户连点 N 个弹窗，而上游 `ask()` 的语义是一次问完。
 * @param sessionId - 提问方所属的 ACP 会话
 * @param items - 待问的问题
 * @returns ACP 征询请求
 */
export function toElicitation(
  sessionId: SessionId,
  items: readonly AskUserQuestionItem[],
): CreateElicitationRequest {
  const properties: Record<string, ElicitationPropertySchema> = {}
  for (const item of items) properties[item.id] = propertyFor(item, items.length === 1)

  return {
    mode: 'form',
    sessionId,
    // `message` 是必填的标题行。单问题时直接用问题本身；多问题时各字段自带
    // 标题，这里只报个数，免得把所有问题重复两遍。
    message: items.length === 1 ? (items[0]?.question ?? '') : `需要你回答 ${items.length} 个问题`,
    requestedSchema: {
      type: 'object',
      properties,
      // 全部必填：上游的问题都是「不答就没法继续」，可选字段会让用户直接提交
      // 一个空表单，而调用方拿到空答案也只能再问一遍。
      required: items.map((item) => item.id),
    },
  }
}

/**
 * 一个字段的回填值 → 上游的答案项。
 *
 * 关键在于 `selected` 与 `custom` 的分流：只有**确实在选项表里**的字符串才算
 * 选择，其余都是用户自己写的内容。反过来（把任何字符串都当成选择）会让一个
 * 自由输入静默变成「选了个不存在的选项」，调用方无从分辨。
 */
function answerItem(item: AskUserQuestionItem, value: unknown): AskUserQuestionAnswerItem | undefined {
  const labels = new Set((item.options ?? []).map((option) => option.label))
  const values = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : undefined
  if (values === undefined) return undefined

  const selected = values.filter((entry) => labels.has(entry))
  const custom = values.filter((entry) => !labels.has(entry)).join('\n')
  return {
    id: item.id,
    selected,
    // **空串也算没有**：`custom` 存在与否是有含义的信号（`exit_plan_mode` 据此
    // 区分「批准」与「带反馈地继续规划」），塞一个空串等于永远在给反馈。
    ...(custom === '' ? {} : { custom }),
  }
}

/**
 * 表单应答 → 上游答案。
 * @param items - 当初提的问题，用于分流 selected / custom
 * @param response - 客户端应答
 * @returns 结构化答案
 * @throws {UserQuestionError} 用户放弃作答，或客户端回了一份空答案
 */
export function toAnswer(
  items: readonly AskUserQuestionItem[],
  response: CreateElicitationResponse,
): AskUserQuestionAnswer {
  // `decline` 与 `cancel` 都是「没有作出决定」。统一成 `ASK_CANCELLED`：上游
  // 认这个 code —— plan mode 据此把「用户想改说别的」翻成一条让模型留在计划
  // 模式里等消息的指示，换个 code 就退回通用失败文案了。
  if (response.action === 'decline') {
    throw new UserQuestionError('the user declined to answer', 'ASK_CANCELLED')
  }
  if (response.action !== 'accept') {
    throw new UserQuestionError(`the user dismissed the request (${response.action})`, 'ASK_CANCELLED')
  }

  const content: Record<string, unknown> = { ...(response.content ?? {}) }
  const answers = items.flatMap((item) => {
    const answer = answerItem(item, content[item.id])
    return answer === undefined ? [] : [answer]
  })
  // 接受了却什么都没回填 —— 当成没作答，而不是「选了零项」：后者会被调用方
  // 读成一次有效的否定回答。
  if (answers.length === 0 && items.length > 0) {
    throw new UserQuestionError('the client accepted the form without any answer', 'NO_ANSWER')
  }
  return { answers }
}

/** {@link askViaElicitation} 所需的外部依赖，便于单测注入。 */
export interface ElicitationDeps {
  /** 发起 `elicitation/create`；无连接或客户端不支持时 undefined */
  readonly createElicitation?: (
    params: CreateElicitationRequest,
    options?: { cancellationSignal?: AbortSignal },
  ) => Promise<CreateElicitationResponse>
  /** 提问方 agent → ACP 会话 id；不属于本 bridge 时返回 undefined */
  readonly sessionOf: (agent: unknown) => SessionId | undefined
}

/**
 * 向客户端提问并等待作答。
 * @param request - 上游的提问（问题、提问方 agent、中止信号）
 * @param deps - 外部依赖
 * @returns 结构化答案
 * @throws {UserQuestionError} 无法提问或用户未作答
 */
export async function askViaElicitation(
  request: { questions: AskUserQuestionItem[]; agent?: unknown; signal?: AbortSignal },
  deps: ElicitationDeps,
): Promise<AskUserQuestionAnswer> {
  const createElicitation = deps.createElicitation
  if (createElicitation === undefined) {
    throw new UserQuestionError('no ACP connection to ask the user through', 'NO_CONNECTION')
  }
  // 提问必须落在某个会话上：ACP 的表单是挂在会话里呈现的。没有 agent 的调用
  // 方（后台任务、别的 bridge 拥有的子 agent）在这条连接上无处提问。
  const sessionId = request.agent === undefined ? undefined : deps.sessionOf(request.agent)
  if (sessionId === undefined) {
    throw new UserQuestionError('the question does not belong to an ACP session', 'NO_SESSION')
  }

  let response: CreateElicitationResponse
  try {
    response = await createElicitation(
      toElicitation(sessionId, request.questions),
      request.signal === undefined ? {} : { cancellationSignal: request.signal },
    )
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new UserQuestionError(`the elicitation request failed: ${detail}`, 'REQUEST_FAILED')
  }
  return toAnswer(request.questions, response)
}
