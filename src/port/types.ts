/**
 * 窄接口层：协议映射层与 dsh 进程内实现之间的唯一边界。
 *
 * 存在理由（架构 §七）：若上游 SDK 通道日后补齐 cancel 与反向请求，可替换本
 * 接口的实现而不动协议层与映射层。同时它也是 R1（上游漂移）的收敛点——契约
 * 测试只需针对这一层。
 * @module
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ClientTextReader } from '../composition/session-fs.js'
import type { McpMountSpec } from '../mcp/spec.js'
import type { ToolLookup } from '../presentation/presenter.js'
import type { ForkPoint } from '../session/fork-point.js'

/**
 * agent 句柄。
 *
 * **显式区分 `agent` 与句柄本身**：`ctx.agents.create()` 返回的是句柄，而工具
 * 注册表的 ScopeKey 是 `handle.agent`。传错对象不会报错，只会静默返回空集
 * （spike 结论 C2）。此处从类型上消除该误用。
 */
export interface AgentHandle {
  /** ScopeKey：所有 scope 查询与身份比对都用它 */
  readonly agent: Agent
  /** 幂等释放；resolve 时注册表、loop、持久化均已静默 */
  readonly dispose: () => Promise<void>
  /** 本会话的运行时控制面（US-16 / US-17） */
  readonly controls: SessionControls
}

/**
 * 单个会话的运行时控制面。
 *
 * 每一项都**只影响本会话**。模型走 agent 作用域的选择 ref（下一步生效，不打断
 * 正在跑的那一步）；沙箱模式落在会话日志里（因此随会话恢复而恢复）。
 */
export interface SessionControls {
  /** 当前模型 id；未设置时 undefined */
  model(): string | undefined
  /** 当前 provider 路由；未设置时 undefined */
  provider(): string | undefined
  /**
   * 切路由（provider + model 一起）；在下一步进入 prompt 装配时生效。
   *
   * **两者必须同时给**：模型 id 只在它自己的 provider 下有意义，分开设会出现
   * 「provider 已换、model 还是旧的」这半步状态，而那一步的请求会带着一个新
   * provider 不认识的模型 id 发出去，表现为换 provider 之后就报 404。上游的
   * `ModelSelection` 本身也是 `{provider, model}` 一对。
   */
  setRoute(provider: string, model: string): void
  /**
   * 当前模型的上下文窗口（token）；未知时 undefined。
   *
   * **同步读**：用量上报走的是事件映射那条纯同步链，而窗口大小要向适配器
   * 异步解析。因此这里读的是缓存，未命中时顺手起一次解析并先返回 undefined
   * ——调用方据此跳过这一条上报。解析是本地目录查表（毫秒级），而两次
   * `assistant/message` 之间隔着一整轮模型往返，所以实际上只有理论上的第一条
   * 会落空。
   */
  contextWindow(): number | undefined
  /**
   * 本会话显式选中的推理档位；没选过时 undefined（此时用适配器的默认）。
   */
  reasoningEffort(): string | undefined
  /**
   * 切推理档位；与切模型同样在下一步进入 prompt 装配时生效。
   */
  setReasoningEffort(effort: string): void
  /** 当前有效沙箱模式（会话覆盖 ?? 部署默认）；组合没挂 sandboxPolicy 时 undefined */
  sandboxMode(): string | undefined
  /** 切沙箱模式；没挂 sandboxPolicy 时为 no-op */
  setSandboxMode(mode: string): void
}

/** 会话生命周期。 */
export interface SessionLifecycle {
  /**
   * @param options.provider - provider 路由；缺失时 agent 无法组装请求
   * @param options.model - 模型 id；同上
   * @param options.mcpServers - 按会话挂载的 MCP server，已翻译为上游配置
   * @param options.readDelegate - 文本读改道到编辑器；`undefined` 表示全走磁盘
   */
  create(options: {
    sessionId: SessionId
    cwd: string
    provider?: string
    model?: string
    mcpServers?: readonly McpMountSpec[]
    readDelegate?: ClientTextReader
  }): Promise<AgentHandle>
  /**
   * 从持久化日志恢复一个已存在的会话。
   *
   * 与 {@link create} 不同，`cwd` 不是入参而是**日志里记着的事实**——工作区
   * 是不可变会话元数据。调用方拿到的 cwd 从返回值取，用请求里的那个去装配
   * 会让恢复出来的会话在另一个工作区里跑历史。
   */
  resume(options: {
    sessionId: SessionId
    provider?: string
    model?: string
    mcpServers?: readonly McpMountSpec[]
    readDelegate?: ClientTextReader
  }): Promise<AgentHandle & { readonly cwd: string | undefined }>
  /**
   * 以另一个会话的历史为种子，建一个**新**会话。
   *
   * 与 {@link resume} 的差别不只是 id：`resume` 让同一个会话活过来，之后写的
   * 事件追加进**同一条**日志；`fork` 造的是一条独立日志，两边此后各写各的，
   * 父会话不会因为子会话继续对话而改变。这正是 ACP `session/fork` 要的东西
   * ——「基于这段上下文另开一支，不影响原来那条」。
   *
   * 种子默认取到**最后一个完整回合**为止，见实现里的 `forkSeed`。
   * @param options.forkPoint - 客户端指名的分叉点；给了就截到那条助手消息所在
   *   回合结束为止，认不出来时抛 `ForkPointUnresolved`
   * @returns 子会话句柄；`cwd` 取自父会话的 header（工作区随历史继承）
   */
  fork(options: {
    parentSessionId: SessionId
    sessionId: SessionId
    provider?: string
    model?: string
    mcpServers?: readonly McpMountSpec[]
    readDelegate?: ClientTextReader
    forkPoint?: ForkPoint
  }): Promise<AgentHandle & { readonly cwd: string | undefined }>
  /** 该 agent 是否仍在活注册表中且为同一对象（防同 id 冒充） */
  isLive(agent: Agent): boolean
  /**
   * 活注册表里有没有这个 id 的会话。
   *
   * 与 {@link isLive} 的差别是**手上有没有对象**：那个防的是同 id 冒充，要拿
   * 已知 agent 去比对身份；这个只有客户端给的一个 id，答的是「这条会话此刻
   * 是不是开着的」。
   *
   * 用途是给 {@link SessionCatalog.presence} 兜底：活着的会话未必在盘上——
   * 写入是按窗口批量合并的，一条刚聊完的会话可能还在缓冲里；一条一个事件都
   * 还没有的会话则根本没有物件（上游惰性物化）。只问磁盘会把它们判成不存在。
   */
  hasLive(sessionId: SessionId): boolean
}

/** 一条持久化会话的元数据摘要。 */
export interface SessionSummary {
  readonly sessionId: SessionId
  /** 会话创建时的工作区；日志里可能没有 */
  readonly cwd: string | undefined
  /** Unix 毫秒 */
  readonly createdAt: number
  /** 会话标题；组合没挂 `dsh-session-title`、或日志尚无标题时 undefined */
  readonly title: string | undefined
  /** 最后一条事件的时间（Unix 毫秒）；日志空或读不出来时 undefined */
  readonly updatedAt: number | undefined
}

/**
 * 已持久化会话的只读目录。
 *
 * 组合没挂持久化时整体为 undefined —— 那种部署里会话随进程消失，
 * `session/load` 与 `session/list` 都不该被 advertise。
 */
export interface SessionCatalog {
  /** 全部已落盘会话，不做截断 */
  list(): Promise<SessionSummary[]>
  /** 某会话的完整事件日志，按 seq 升序 */
  events(sessionId: SessionId): Promise<readonly SessionEvent[]>
  /**
   * 这个 id 的日志物件在不在。
   *
   * 它存在的唯一理由是**事后分诊**：别的读取已经失败了，据此判一句「是不存在，
   * 还是在但坏了」。所以它不该被放到成功路径上——那是给每次恢复白加一次读盘，
   * 换来的只是一个 TOCTOU 窗口更小的同样答案。
   *
   * **必须是三态而不是布尔。** 「查不出来」与「确认不存在」在这里是两件相反
   * 的事：前者要求保持原样（继续报内部错误），后者才允许改判成 not found。
   * 挤进一个布尔里，就只能给「查不出来」挑一个默认值，而挑错的那一半会静默
   * 地把一类故障说成另一类。
   */
  presence(sessionId: SessionId): Promise<SessionPresence>
}

/**
 * 一条会话的日志物件在这台机器上的存在状态。
 *
 *  - `absent`：**确认**没有这条日志。只有这一种允许把错误改判成 not found。
 *  - `present`：物件在（哪怕内容是坏的）。
 *  - `unknown`：查不出来——后端不提供逐会话的物件，或探测本身失败了。
 */
export type SessionPresence = 'absent' | 'present' | 'unknown'

/** 一条命令的发现元数据。 */
export interface CommandInfo {
  /** 不带前导斜杠的命令名 */
  readonly name: string
  readonly description: string
  /** 自由文本输入的占位提示；命令不收输入时 undefined */
  readonly hint: string | undefined
}

/** 一条命令的执行结果。 */
export interface CommandOutcome {
  readonly ok: boolean
  /** 直接呈现给用户的文本；命令无话可说时 undefined */
  readonly text: string | undefined
}

/**
 * 人类命令面（US-18）。
 *
 * 组合没挂命令注册表时整体为 undefined —— 那种部署里 `/` 开头的输入就是普通
 * 文本，原样送给模型。
 */
export interface CommandPlane {
  /** 该 agent 可见的命令，已应用作用域遮蔽 */
  list(agent: Agent): readonly CommandInfo[]
  /**
   * 执行一行 slash 命令。
   * @returns 结果；**语法不符或命令名未注册时返回 undefined**，调用方据此
   *   回退到模型——用户打的 `/usr/bin/env 是什么` 不该被当成命令吞掉
   */
  run(agent: Agent, line: string, signal: AbortSignal): Promise<CommandOutcome | undefined>
  /** 注册表变更订阅；返回取消订阅函数 */
  onChange(sink: () => void): () => void
}

/** 一条**用户可调用**技能的发现元数据（US-27）。 */
export interface SkillInfo {
  /** kebab-case 技能名，不带前导斜杠 */
  readonly name: string
  /** 已按 {@link SkillPlane.list} 的约定截断 */
  readonly description: string
}

/**
 * 技能面（US-27）。
 *
 * 只暴露**用户可调用**的那一半。模型侧完全不经过这里：`dsh-tool-skill` 自己在
 * `agent/pre-step` 注入目录、自己注册 `skill` 工具、自己扫 `/名字` 手势，本
 * bridge 一个字都不用转译。这里做的事只有一件——把技能名喂进编辑器的斜杠补全，
 * 否则用户得先知道技能叫什么才敲得出来，功能等于藏着。
 *
 * 组合没挂 `ctx.skills` 时整体为 undefined。
 */
export interface SkillPlane {
  /**
   * 该会话可见的用户可调用技能。
   *
   * **异步**（提供方可能是远程的），这是它与 {@link CommandPlane.list} 唯一的
   * 结构差异。发现失败、超时、被取消时返回空数组而不是抛：技能列表是锦上添花，
   * 不该让建会话失败——代价只是这一次列表里没有技能。
   * @param agent - 观察作用域；技能与工具一样可以注册在 agent 层遮蔽全局同名项
   * @param cwd - 工作区，决定 `<项目根>/.dsh/skills` 那两个根扫哪里
   */
  list(agent: Agent, cwd: string | undefined): Promise<readonly SkillInfo[]>
  /** 目录变更订阅；返回取消订阅函数 */
  onChange(sink: () => void): () => void
}

/**
 * 会话模式面（US-19）。
 *
 * 只有 plan 这一个协作状态，因此这里是布尔而非任意模式名——ACP 侧的
 * `default` / `plan` 词表由 bridge 拥有（见 config/modes.ts）。组合没挂
 * plan-mode 时整体为 undefined，此时不 advertise `modes`，`session/set_mode`
 * 也直接拒绝。
 */
export interface ModePlane {
  /**
   * @returns `active` 是日志里记着的状态；`pending` 是尚未落实的选择
   *   （回合进行中切换时，要等下一个被接受的步骤边界才写进日志）
   */
  get(agent: Agent): { readonly active: boolean; readonly pending: boolean | undefined }
  set(agent: Agent, active: boolean): void
}

/** 一个可配置的 provider 路由（ACP `providers/*`）。 */
export interface ProviderConfig {
  readonly id: string
  /** 展示名；目录没给时回落到 id */
  readonly displayName: string
  /**
   * 是否**不可禁用**。
   *
   * 静态组合进来的适配器（本项目里是 `llm-deepseek`）为真：它的路由不是从设置
   * 文档来的，`providers/disable` 删不掉，谎称可删只会让客户端给出一个点了没
   * 反应的按钮。
   */
  readonly required: boolean
  /**
   * 当前生效的**非机密**路由配置；未配置时 undefined。
   *
   * ACP 把「`current` 缺席」定义为该 provider 处于禁用态，因此这里的 undefined
   * 是有语义的，不是「读不出来」。
   */
  readonly current: { readonly apiType: string; readonly baseUrl: string } | undefined
}

/**
 * provider 配置面（ACP `providers/list` / `set` / `disable`）。
 *
 * 组合没挂设置服务、或挂了一个只读的，整体为 undefined —— 此时 `initialize`
 * 不 advertise `providers` 能力位，三个方法也直接拒绝。声明与实现同一个真值来源，
 * 与 `loadSession` 那几项一样。
 */
export interface ProviderPlane {
  /**
   * 本部署认得的线协议词表，供客户端画下拉框。
   *
   * **异步**：词表归 pi-ai 所有，而那个包 import 一次要 5 秒，因此它是惰性拉起
   * 的（见 `src/composition/pi-ai.ts`）。第一次问会等，之后是缓存。
   */
  protocols(): Promise<readonly string[]>
  /** 全部可配置 provider（含未激活的），以及各自当前的非机密配置 */
  list(): Promise<readonly ProviderConfig[]>
  /**
   * 写入一条 provider 配置。
   *
   * **密钥不落设置文档**：实现从 `headers` 里摘出授权头交给凭据服务，设置文档
   * 里只留一个引用。见 `src/protocol/providers.ts`。
   */
  set(input: {
    readonly id: string
    readonly apiType: string
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>> | undefined
  }): Promise<void>
  /** 禁用（= 删掉配置）一条 provider 路由 */
  disable(id: string): Promise<void>
}

/** 一张待准入的图片，base64 线上形态。 */
export interface EncodedImage {
  /** 声明的 media type；准入时会拿解码后的字节核对 */
  readonly mediaType: string
  /** 规范 base64（RFC 4648）；URL-safe 别名与空白都会被拒 */
  readonly data: string
  /** 展示名；**永不当作路径解释** */
  readonly name?: string
}

/**
 * 一段待提交的用户输入，按**线序**排列。
 *
 * 保序不是讲究：「这是改之前的截图 [图] 这是改之后的 [图]」在图片被挪到末尾之后
 * 就成了另一句话。ACP 的 prompt 本来就是有序块数组，上游的消息内容也是，中间这
 * 一层没有理由把顺序丢掉。
 */
export type PromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly image: ImageAttachmentRef }

/**
 * 图片输入面（US-23）。
 *
 * 组合没挂附件服务时整体为 undefined —— 此时 `promptCapabilities.image` 报 false，
 * 发来的图片块会被显式拒绝（AC-G2），而不是静默丢掉。
 */
export interface ImagePlane {
  /** 本部署接受的图片 media type 词表，供拒绝信息说清楚「那你要什么」 */
  readonly mediaTypes: readonly string[]
  /**
   * 某条路由收不收图片。
   *
   * **按会话当前路由逐次问**，不是启动时问一次：阶段 1 之后模型可以中途换，
   * 一个在建会话时成立的答案在第三轮可能已经不成立了。解析不出来时报 false
   * ——宁可拒绝一次能成的请求，也不要让它到适配器那里再炸。
   */
  accepts(provider: string, model: string): Promise<boolean>
  /**
   * 校验并落盘一批图片，返回可写进消息的引用。
   *
   * **整批要么全成要么全败**（上游 `saveImages` 的语义）：一半图片落了盘、另一半
   * 没有，那条消息就是残的，而模型看不出少了什么。
   * @throws 准入被拒时抛上游的 `AttachmentError`
   */
  admit(images: readonly EncodedImage[]): Promise<readonly ImageAttachmentRef[]>
}

/** 会话事件订阅。 */
export interface EventSource {
  /**
   * 订阅全部会话事件。回调需自行按 agent 解复用。
   * @returns 取消订阅函数
   */
  onSessionEvent(sink: (agent: Agent, event: SessionEvent) => void): () => void
  /** 某条入队消息被认领为某个回合时触发，用于 prompt↔turn 相关性 */
  onInboxClaimed(sink: (agent: Agent, messageId: string, turn: number) => void): () => void
  /** 回合级模型错误 */
  onAgentError(sink: (agent: Agent, turn: number, error: unknown) => void): () => void
}

/** 驱动单个 agent。 */
export interface AgentDriver {
  /**
   * 构造一条用户消息但**不入队**。
   *
   * 分两步是必须的：in-flight 槽位要在入队前武装（监听器驱动的同步回合可能
   * 在入队调用返回前就跑完），而武装时就需要 messageId 才能建立相关性。
   * @param parts - 按线序排列的文本与图片，见 {@link PromptPart}
   */
  prepare(parts: readonly PromptPart[]): { readonly messageId: string; readonly submit: (agent: Agent) => void }
  cancel(agent: Agent): void
  /** 整体静默并确认已挂载的持久化完成；保存失败时拒绝，不能报告成功。 */
  whenIdle(agent: Agent): Promise<void>
}

/** 协议层可见的全部宿主能力。 */
export interface HarnessPort {
  readonly sessions: SessionLifecycle
  readonly events: EventSource
  readonly driver: AgentDriver
  /**
   * 工具定义查询，供呈现层读取工具自己声明的卡片。
   *
   * 组合里没挂工具注册表时为 undefined——那种部署只有对话，工具事件根本不会
   * 出现，此时强制要求这个服务只会把 bridge 变得更难嵌入。
   */
  readonly tools: ToolLookup | undefined
  /**
   * 已持久化会话的目录；组合没挂持久化时为 undefined。
   *
   * `initialize` 的能力声明直接读它：advertise 与实现必须严格一致，声明了
   * `loadSession` 却没有持久化，客户端会在恢复时拿到一个无从解释的错误。
   */
  readonly catalog: SessionCatalog | undefined
  /** 人类命令面；组合没挂命令注册表时 undefined */
  readonly commands: CommandPlane | undefined
  /** 技能面；组合没挂 `ctx.skills` 时 undefined */
  readonly skills: SkillPlane | undefined
  /** 会话模式面；组合没挂 plan-mode 时 undefined */
  readonly modes: ModePlane | undefined
  /** provider 配置面；组合没挂可写的设置服务时 undefined */
  readonly providers: ProviderPlane | undefined
  /** 图片输入面；组合没挂附件服务时 undefined */
  readonly images: ImagePlane | undefined
  /**
   * 当前注册着适配器的全部 provider 路由。
   *
   * 只报**活的**路由（`ctx.llm.listProviders()`）：用户在设置文档里配了但
   * 还没生效的条目不在此列，模型下拉里出现一个选了就 404 的分组毫无意义。
   * 「可配置但未激活」是 `providers/list` 那条线的事，与这里正交。
   */
  listProviders(): readonly { id: string; name: string }[]
  /**
   * 该 provider 下可选的模型。
   *
   * 目录取不到（provider 未注册、适配器不支持枚举）时返回空数组：模型这个
   * 配置项随即不 advertise，好过给客户端一个空下拉框。
   */
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  /**
   * 某个 provider/model 的推理档位词表。
   *
   * **词表随模型变**（某些部署只剩 `off`），所以这是按路由查的、不是全局常量。
   * 这里可以异步：配置项组装本来就是 async 的，因此不必像上下文窗口那样忍受
   * 「缓存没热就先不报」——那边被同步的事件映射逼着只能读缓存。
   * @returns 档位与适配器默认；解析不出来时 efforts 为空
   */
  reasoningEfforts(
    provider: string,
    model: string,
  ): Promise<{ efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string }>
  /** 部署支持的沙箱模式词表；组合没挂 sandboxPolicy 时为空 */
  readonly sandboxModes: readonly string[]
}
