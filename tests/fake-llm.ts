/**
 * 假模型适配器：让**真实的 agent loop** 完整跑一轮，而不需要 API Key。
 *
 * 只伪造模型这一层，回合生命周期（turn/start、inbox 认领、assistant/chunk、
 * turn/end、whole-agent idle）全部走真实路径——否则测不到结算语义。
 * @module
 */

import {
  LlmAdapter,
  type FinishReason,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

export const FAKE_PROVIDER = 'fake'
export const FAKE_MODEL = 'fake-model'

/**
 * 第二条 provider 路由。
 *
 * 名字**刻意以 `fake` 为前缀**：`decodeRouteValue` 按 provider 前缀最长匹配还原
 * 取值，两个 provider 一个是另一个的前缀正是那段逻辑唯一会出错的形状。用一个
 * 不相干的名字（`other`）会让这条路径在用例里空过。
 */
export const FAKE_PROVIDER_ALT = 'fake-alt'

/**
 * 第二个可选模型。
 *
 * 模型配置项只在候选**多于一个**时 advertise（选不动的下拉框没有意义），
 * 所以目录里必须有两个，US-16 那条链才测得到。
 */
export const FAKE_MODEL_ALT = 'fake-model-pro'

/**
 * 收图片的模型。
 *
 * 目录里必须**同时**有收图和不收图的模型，US-23 那条链才测得全：只有收图的
 * 模型时「纯文本模型上发图要被拒」永远走不到，而那正是用户最容易撞上的路径
 * （部署默认模型就是纯文本的）。
 */
export const FAKE_MODEL_VISION = 'fake-model-vision'

/** 可编排的假适配器。 */
export class FakeLlmAdapter extends LlmAdapter {
  /** 每次调用产出的文本分片；分成多片以便验证增量转发 */
  deltas: string[] = ['Hel', 'lo']
  /**
   * 正文之前产出的推理分片；默认不产出。
   *
   * 推理与正文走的是**两条不同的更新**（`agent_thought_chunk` /
   * `agent_message_chunk`），而它们在流里紧挨着。默认关掉是因为绝大多数用例断的
   * 是正文，凭空多出思考块会让它们全部失配。
   */
  reasoningDeltas: string[] = []
  /** 每片之间的延迟，用于制造可取消的窗口 */
  delayMs = 0
  /** 置位后 stream 抛错，用于验证回合失败路径 */
  failWith: Error | undefined
  /**
   * 置位后本次流**先照常吐出 {@link deltas}、再以一个 error finish 收尾**；
   * 产出后清空，下一次调用正常作答。
   *
   * 与 {@link failWith} 的差别是这条**吐过字**：上游据此把这次尝试记成
   * `assistant/attempt`（带着已经发出去的分片）而不是 `assistant/message`，
   * 而「已经发出去的分片」正是实时与重放最容易分叉的那一处。抛异常那条走的是
   * 另一个分支（没有 finish，assembler 里也没有 blocks），测不到这件事。
   *
   * 配一个返回 `{kind:'retry'}` 的 `agent/request-error` 监听器，就得到一次
   * 真实的「吐了半句话再重试」——真实部署里 `dsh-llm-retry` 与
   * `dsh-compaction-basic` 都会产生这个形状。
   */
  errorFinishOnce: { message: string; code: string } | undefined
  /**
   * 文本流的结束原因。
   *
   * 默认正常结束；改成 `max-tokens` 可以制造一个被截断的回合，用来分辨
   * 「真的读到了这一轮的结束原因」与「没读到、回退成了 end_turn」——两者在
   * 正常结束时给出同一个答案，只有非正常结束才区分得开。
   */
  finishWith: FinishReason = { kind: 'stop' }
  /**
   * 每次流在 finish 之前产出的 token 记账。
   *
   * 默认带缓存字段：输入侧三项是**不相交**的，只加 `inputTokens` 会让开着缓存
   * 的会话显示成只用了一小半——这个默认值让那个错误在用例里现形。置 undefined
   * 则完全不报，用来验证「适配器没给记账时不上报」。
   */
  usage: TokenUsage | undefined = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 8,
  }
  /** 记录收到的调用次数 */
  calls = 0
  /**
   * 置位后本次流产出一次工具调用而非文本；产出后清空，下一步回到文本，
   * 否则真实的 agent loop 会拿着工具结果无限再调。
   */
  toolCall: { id: string; name: string; args: string } | undefined
  /**
   * 回合**进行中**的钩子，在第一片文本之前 await。
   *
   * 审批必须在开着的回合里提出（`ApprovalService.request` 对空闲 agent 直接
   * 拒绝，因为审计事件对要落在日志的 commit/replay 边界内）。靠 sleep 去撞这个
   * 窗口是不稳定的，所以给一个确定的挂钩点。
   */
  duringTurn: (() => Promise<void>) | undefined

  override providerInfo(provider: string) {
    return { id: provider, name: 'Fake' }
  }

  /** 每次 stream 调用实际收到的模型，按顺序；用于验证切换真的改了路由。 */
  modelsUsed: string[] = []

  /**
   * 每次 stream 调用实际收到的 provider，按顺序。
   *
   * 与 {@link modelsUsed} 分开记：跨 provider 切换时**只看模型看不出问题**
   * ——两个 provider 各有一个同名模型时，路由错了而模型名对得上，用例会空过。
   */
  providersUsed: string[] = []

  /**
   * 是否把 {@link FAKE_MODEL_VISION} 也列进目录。
   *
   * 默认关：多数用例断的是一个两项的模型下拉，凭空多一项会让它们全部失配，而
   * 那些用例与图片毫无关系。要在会话里**切到**收图模型必须打开它——配置项只
   * 接受它 advertise 过的取值。
   */
  offerVisionModel = false

  override async listModels(provider: string) {
    return [
      { provider, id: FAKE_MODEL, name: FAKE_MODEL },
      { provider, id: FAKE_MODEL_ALT, name: FAKE_MODEL_ALT },
      ...(this.offerVisionModel ? [{ provider, id: FAKE_MODEL_VISION, name: FAKE_MODEL_VISION }] : []),
    ]
  }

  /**
   * 每个模型暴露的推理档位。
   *
   * 键是模型 id，值是档位 id 列表。默认让两个模型的**词表不同**——真实部署里
   * 词表就是随模型变的（有的只剩 `off`），而「切模型后档位列表要跟着换」正是
   * 这条链最容易漏的地方。
   */
  reasoningByModel: Record<string, string[]> = {
    [FAKE_MODEL]: ['off', 'high', 'max'],
    [FAKE_MODEL_ALT]: ['off'],
  }

  /** 适配器报告的默认档位。 */
  defaultEffort = 'high'

  override async resolveModel(provider: string, model: string) {
    const efforts = this.reasoningByModel[model] ?? []
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 8192 },
      // **不受 `offerVisionModel` 影响**：那个开关管的是「列不列进下拉框」，
      // 而解析是按 id 查的。真实目录同样可以解析出没列在默认清单里的模型。
      //
      // 显式写出 `['text']` 而不是省略：上游把「缺席」定义为**不知道**、把显式
      // 省略定义为**否定能力**，两者在准入判断上是两回事。
      inputModalities: model === FAKE_MODEL_VISION ? (['text', 'image'] as const) : (['text'] as const),
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((id) => ({ id: id as never, name: id.toUpperCase() })),
              defaultEffort: (efforts.includes(this.defaultEffort)
                ? this.defaultEffort
                : efforts[0]) as never,
            },
          }),
    }
  }

  /** 每次 stream 实际收到的推理档位，按顺序；用于验证切换真的进了请求。 */
  effortsUsed: (string | undefined)[] = []

  /**
   * 每次 stream 收到的**完整对话历史**，压成 `角色:文本` 一行一条。
   *
   * fork 唯一要证明的事情就是这个：子会话的第一次请求里得带着父会话聊过的内容。
   * 从会话表、header、日志文件去看都只能证明「历史被复制了」，证明不了它**进了
   * 请求**——而后者才是「继承上下文」这句话的含义。
   */
  historiesUsed: string[][] = []

  /**
   * 每次 stream 里**带图片的那条消息**的内容块类型序列，按调用顺序。
   *
   * 图片这条链上「顺序」是会悄悄错的那一环：`[文本][图][文本]` 被拍成
   * `[文本+文本][图]` 时，模型看到的是另一句话，而任何「有没有收到图片」的断言
   * 都照样通过。所以要能看见块的排列，不只是它们的存在。
   *
   * **按内容找而不是按位置找**：请求里除了用户消息还有运行时上下文快照那类注入
   * 消息，它们的位置不由本用例决定（`at(-1)` 拿到的经常是快照而不是用户那条）。
   */
  blockKindsUsed: string[][] = []

  /** 每次 stream 收到的图片附件 id，跨全部消息按序收集。 */
  imagesUsed: string[][] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.modelsUsed.push(options.model)
    this.providersUsed.push(options.provider)
    {
      type Block = { type?: string; attachment?: { attachmentId?: string } }
      const perMessage = options.messages.map((message) =>
        Array.isArray(message.content) ? (message.content as Block[]) : [],
      )
      this.imagesUsed.push(
        perMessage
          .flat()
          .filter((block) => block.type === 'image')
          .map((block) => String(block.attachment?.attachmentId)),
      )
      const withImage = perMessage.find((blocks) => blocks.some((block) => block.type === 'image'))
      this.blockKindsUsed.push((withImage ?? perMessage.at(-1) ?? []).map((block) => String(block.type)))
    }
    this.historiesUsed.push(
      options.messages.map((message) => {
        // 内容是块树；只把文本块拼起来，工具调用那些块对这个用途没有信息。
        const content = message.content
        const text =
          typeof content === 'string'
            ? content
            : (content as { type?: string; text?: string }[] | undefined)
                ?.filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('') ?? ''
        return `${String(message.role)}:${text}`
      }),
    )
    this.effortsUsed.push(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
    if (this.failWith !== undefined) throw this.failWith

    const pendingCall = this.toolCall
    if (pendingCall !== undefined) {
      this.toolCall = undefined
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: pendingCall.id as never,
        name: pendingCall.name,
        argumentsDelta: pendingCall.args,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: pendingCall.id as never, name: pendingCall.name, arguments: pendingCall.args },
      }
      // 记账在终止性 finish **之前**产出，与上游适配器约定一致。
      if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    if (this.reasoningDeltas.length > 0) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (const text of this.reasoningDeltas) yield { type: 'reasoning-delta', index: 0, text }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: this.reasoningDeltas.join('') },
      }
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.duringTurn !== undefined) await this.duringTurn()
    for (const text of this.deltas) {
      if (options.signal?.aborted === true) break
      if (this.delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs)
          options.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      }
      yield { type: 'text-delta', index: 0, text }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.deltas.join('') } }
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }

    const errorFinish = this.errorFinishOnce
    if (errorFinish !== undefined) {
      this.errorFinishOnce = undefined
      yield { type: 'finish', reason: { kind: 'error', failure: errorFinish } }
      return
    }
    yield { type: 'finish', reason: this.finishWith }
  }
}
