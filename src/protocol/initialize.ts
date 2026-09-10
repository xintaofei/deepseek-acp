/**
 * `initialize` —— 版本协商与能力声明。
 *
 * **advertise 与实现必须严格一致**（验收标准 AC-G1 的延伸）：此处只声明
 * M1-a 真正实现了的能力。声明了却没实现，客户端会调用后失败。
 * @module
 */

import {
  PROTOCOL_VERSION,
  type AuthMethod,
  type InitializeRequest,
  type InitializeResponse,
} from '@agentclientprotocol/sdk'

/**
 * 服务端身份，固定字面量而非配置项。
 *
 * **必须与 `package.json` 的 `version` 一致**，且这是两处独立的字面量：`import`
 * 一个 JSON 会让构建产物的相对路径依赖包布局，不值得。一致性由
 * `tests/session.spec.ts` 的一条用例守着——codeg 注册自定义 agent 时按
 * `deepseek-acp@<版本>` 对账，两处一旦漂移，表现是编辑器里连不上而不是报错。
 */
export const AGENT_INFO = { name: 'deepseek-acp', version: '0.9.0' } as const

/**
 * 唯一的鉴权方式：**Terminal Auth**（`deepseek-acp --setup`）。
 *
 * 为什么是这一档。ACP 规范定义了三种：`agent`（agent 自己起本地 HTTP server 跑
 * OAuth 回调）、`terminal`（另起一个交互式进程登录）、`env_var`（客户端收集变量后
 * 重启 agent）。本项目的凭据是一个 API Key：
 *
 * - `agent` 走不了——DeepSeek 给第三方的是 API Key，没有 OAuth。
 * - `env_var` 最贴近现状，但它在 v2 里已被移除（旧描述符一律按 `agent` 解码），
 *   而 **ACP registry 明确只收 `agent` 与 `terminal` 两档**。
 *
 * 于是剩下 `terminal`。语义上也不亏：Key 落进 `$DSH_HOME/.credentials.yaml` 之后与
 * 启动方式无关，正好治「GUI 编辑器不继承登录 shell 环境」那个老问题。
 *
 * **`args` 必须与 {@link ../launcher/cli.ts} 认的开关一字不差**：客户端是拿同一个
 * 二进制加上这里给的参数另起进程的，写错了表现是「登录界面一闪而过然后仍未登录」。
 * `tests/session.spec.ts` 钉着这条。
 */
const TERMINAL_AUTH = {
  id: 'terminal',
  name: '在终端里登录',
  description: '在终端里粘贴 DeepSeek API Key，存进 $DSH_HOME/.credentials.yaml',
  type: 'terminal',
  args: ['--setup'],
} as const satisfies AuthMethod

/**
 * 客户端是否支持 Zed 的终端 `_meta` 约定。
 *
 * ACP 没有为这个约定定义能力位（它本就是 `_meta` 扩展），所以只能读
 * `clientCapabilities._meta.terminal_output`。**严格比 `=== true`**：`_meta`
 * 的值类型是 `unknown`，任何真值判断都会把字符串 `"false"` 当成支持。
 * @param params - initialize 请求
 * @returns 支持终端卡片则 true
 */
export function clientSupportsTerminal(params: InitializeRequest): boolean {
  return params.clientCapabilities?._meta?.['terminal_output'] === true
}

/**
 * 客户端是否支持表单式 elicitation（US-21）。
 *
 * 与终端约定不同，这个有正式能力位——但它在 1.3.0 里仍标着 UNSTABLE。语义是
 * 「给了对象就是支持」：`{}` 表示支持，omit 与 null 都表示不支持。
 * @param params - initialize 请求
 * @returns 支持表单征询则 true
 */
export function clientSupportsElicitation(params: InitializeRequest): boolean {
  const form = params.clientCapabilities?.elicitation?.form
  return form !== undefined && form !== null
}

/**
 * 客户端是否支持按 id upsert 的压缩更新。
 *
 * 这一条**没有对应的 agent 能力位**——压缩在 ACP 里完全是客户端侧的显示能力，
 * 规范对 agent 的要求是一句 MUST：「Agents MUST only send this update when the
 * Client advertised `ClientSessionCapabilities::compaction`」。所以这里读到的
 * 结果直接决定发不发那两条更新，而不是决定 agent 声明什么。
 *
 * 与 elicitation 同样的「给了对象就是支持」语义：`{}` 支持，omit 与 null 不支持。
 * @param params - initialize 请求
 * @returns 支持压缩更新则 true
 */
export function clientSupportsCompaction(params: InitializeRequest): boolean {
  const compaction = params.clientCapabilities?.session?.compaction
  return compaction !== undefined && compaction !== null
}

/**
 * 客户端是否实现 `fs/read_text_file`（US-25）。
 *
 * 这一位是**布尔**而非对象，所以判定与 elicitation 那条不同：`=== true` 才算。
 * 缺席与显式 `false` 在这里没有行为差别（两种都是不能调），但排查时是两种信号
 * ——所以 {@link describeClient} 分得开，这个函数不分。
 *
 * SDK 两侧的注释都写着 "Only available if the client advertises the
 * `fs.readTextFile` capability"：没声明就调，等于对着一个没注册处理器的方法发
 * 请求，拿回 methodNotFound。
 * @param params - initialize 请求
 * @returns 可以把文本读委托给编辑器则 true
 */
export function clientSupportsFsRead(params: InitializeRequest): boolean {
  return params.clientCapabilities?.fs?.readTextFile === true
}

/**
 * 客户端是否**认得** Terminal Auth —— 决定 {@link handleInitialize} 要不要
 * advertise {@link TERMINAL_AUTH}。
 *
 * 这一位是**opt-in**，不是可选的礼貌。SDK 对 `ClientCapabilities.auth` 的说明写着
 * 「Determines which authentication method types the agent **may** include in its
 * `InitializeResponse`」，`auth.terminal` 那条更直白：「When `true`, the agent may
 * include `terminal` entries」。没声明就塞过去，等于给客户端一个它没准备好的联合
 * 变体——轻则被忽略，重则整个 `initialize` 应答解析失败。
 *
 * **两个信号都认**，因为现实里两种都在用：
 *
 * - `auth.terminal === true` —— 正式能力位（1.3.0 里仍标 UNSTABLE）。
 * - `_meta['terminal-auth'] === true` —— 先于能力位存在的约定。**ACP registry 的
 *   准入校验器发的正是这个**（`client.py` 的 `initialize` 只带 `terminal: true`、
 *   `fs`、以及 `_meta` 里的 `terminal_output` / `terminal-auth`），只认正式能力位
 *   的话 CI 会拿到空数组，直接判「No authMethods in response」。
 *
 * **不能读顶层的 `clientCapabilities.terminal`**：那一位说的是「客户端实现了
 * `terminal/*` 那组方法」（终端卡片），与「认不认得终端登录」是两件事。registry
 * 的校验器两个都发，正好会把这个混淆掩盖过去。
 *
 * 两处都**严格比 `=== true`**：`_meta` 的值类型是 `unknown`，真值判断会把字符串
 * `"false"` 当成支持。
 * @param params - initialize 请求
 * @returns 可以 advertise 终端登录则 true
 */
export function clientSupportsTerminalAuth(params: InitializeRequest): boolean {
  const caps = params.clientCapabilities
  return caps?.auth?.terminal === true || caps?._meta?.['terminal-auth'] === true
}

/**
 * 把客户端声明的能力位摘成一行，供握手时记进 stderr。
 *
 * 存在的理由很实际：**「这个编辑器到底支持什么」是排查一切降级行为的起点**。
 * 表单征询没弹出来、终端卡片没画出来、`fs` 委托没生效——三者的第一个问题都是
 * 「它 advertise 了吗」，而在此之前那只能靠猜或者去翻编辑器源码。
 *
 * 每项都如实回显**原始值**而非布尔判定：`readTextFile` 缺席与显式 `false` 在
 * 排查时是两种不同的信号（前者是老客户端，后者是明确不支持）。
 * @param params - initialize 请求
 * @returns 单行摘要
 */
export function describeClient(params: InitializeRequest): string {
  const caps = params.clientCapabilities
  const shown = (value: unknown): string => (value === undefined ? '（未声明）' : JSON.stringify(value))
  return [
    `protocolVersion=${params.protocolVersion}`,
    `fs.readTextFile=${shown(caps?.fs?.readTextFile)}`,
    `fs.writeTextFile=${shown(caps?.fs?.writeTextFile)}`,
    `elicitation.form=${shown(caps?.elicitation?.form)}`,
    `terminal=${shown(caps?.terminal)}`,
    `_meta.terminal_output=${shown(caps?._meta?.['terminal_output'])}`,
    // 登录入口没出现在编辑器里时，第一个要问的就是这两位。**分开回显**：正式
    // 能力位与 `_meta` 约定是两条独立的来路，合成一个布尔就分不清是「老客户端」
    // 还是「新客户端但没开」。
    `auth.terminal=${shown(caps?.auth?.terminal)}`,
    `_meta.terminal-auth=${shown(caps?._meta?.['terminal-auth'])}`,
  ].join('  ')
}

/**
 * 生成 initialize 应答。
 *
 * `loadSession` 与 `sessionCapabilities` 的 `list` / `resume` 是**按组合动态
 * 声明**的：宿主没挂持久化时会话随进程消失，声明了客户端就会去调，然后拿到一个
 * 无从解释的错误。这些方法本身也会在没有持久化时直接 `methodNotFound`——声明与
 * 实现同一个真值来源。
 *
 * `close` 是例外，无条件声明：它释放的是**进程内**资源（agent、MCP 子进程、
 * 订阅），与会话能不能从日志恢复无关。
 *
 * `authMethods` 同理**跟着客户端走**（见 {@link clientSupportsTerminalAuth}）：终端
 * 登录是一条 opt-in 的方法类型，没声明的客户端拿到它只会困惑。
 * @param options.persistent - 组合是否挂了持久化后端
 * @param options.terminalAuth - 客户端是否认得终端登录
 * @returns 本 bridge 的 initialize 应答
 */
export function handleInitialize(
  options: { persistent: boolean; terminalAuth?: boolean; providers?: boolean; image?: boolean } = {
    persistent: false,
  },
): InitializeResponse {
  return {
    // 单版本 agent：规范里「支持则同版本，否则取最新支持版本」两条分支
    // 都归结到这一个版本。
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { ...AGENT_INFO },
    agentCapabilities: {
      // `embeddedContext` 已实现：内嵌 `resource` 块的文本整段内联（`src/codec/prompt.ts`），
      // 这是「@ 一个文件、内容直接带过来」的通道，也能带上磁盘上根本没有的东西。
      // audio 仍未实现（上游没有音频路由）。
      //
      // **`image` 跟着附件服务走，不跟着「当前模型收不收图」走。** 这是一个取舍，
      // 值得写清楚：能力位是**连接级**的（握手时声明一次），而「这条路由收不收图」
      // 是**会话级且可变**的（阶段 1 之后模型能中途换）。用部署默认模型去决定它
      // 的话，任何一个纯文本的默认档都会让能力位恒为 false，客户端直接把上传入口
      // 藏掉——用户就算切到收图的模型也再没有办法把图发进来，功能等于不存在。
      // （本部署当前的默认档 `deepseek-flash` 恰好收图，但那是可配置的部署事实，
      // 不是这个判断可以依赖的前提。）
      //
      // 反过来声明了却在纯文本模型上发图，用户会收到一条**说得出怎么办**的拒绝
      // （见 `session-prompt.ts` 的 `admitImages`：报出当前模型名，让去模型选择器
      // 里换）。两种错法里，这一种是用户自己能走出来的。
      promptCapabilities: { image: options.image === true, audio: false, embeddedContext: true },
      // **`McpCapabilities` 只描述非 stdio 传输**：stdio 是所有 agent 的基线，
      // 没有位可以表示「支持/不支持 stdio」（也因此无法声明「完全不支持 MCP」）。
      // 这里声明的是本部署确实翻译得了的那两种之外的情况：
      //   http → `streamable-http`，`dsh-mcp-client` 支持
      //   sse  → 上游没有这个传输（MCP 规范也已标 deprecated）
      //   acp  → 需要把 MCP 报文经 ACP 连接代理回客户端，那是自研传输，不是配置
      mcpCapabilities: { http: true, sse: false, acp: false },
      // `{}` 才表示「支持」；omit 与 null 都表示不支持。
      //
      // `close` **不**跟随持久化：释放资源与会话能不能恢复无关，没挂持久化时
      // 关掉一个会话同样要把 agent 与它的 MCP 子进程收走。
      //
      // `fork` 同样无条件声明，理由类似但要多绕一步：它的种子首选取自**活的**
      // 父会话，那条路径根本不碰持久化。没挂持久化的组合里它退化成「只能 fork
      // 当前开着的会话」——仍是一个能用的功能，而那也正是那种部署里唯一说得通
      // 的语义（会话本来就随进程消失）。按持久化声明会把它整个藏掉。
      sessionCapabilities: {
        close: {},
        fork: {},
        ...(options.persistent ? { list: {}, resume: {} } : {}),
      },
      // `providers/*` 同样**按组合动态声明**：组合没挂可写的设置服务时整个 plane
      // 缺席，三个方法会拒绝，此时声明它等于让客户端画一个必然报错的配置表单。
      ...(options.providers === true ? { providers: {} } : {}),
      ...(options.persistent ? { loadSession: true } : {}),
    },
    // 声明了它**不等于**会拦住建会话：本 bridge 从不返回 `auth_required`，缺 Key
    // 的失败仍旧发生在第一个回合（`MISSING_CREDENTIAL`）。这条只是把「还有一条
    // 登录路子」告诉认得它的客户端，让它能给出一个入口。
    //
    // 不认得的客户端拿到空数组——与本改动之前的行为一字不差，因此不会有回归。
    // `args` 复制一份：`TERMINAL_AUTH` 是 `as const`（readonly），而应答类型要的是
    // 可变数组，且这个对象每次握手都要新造一个，免得共享引用被下游改到。
    authMethods:
      options.terminalAuth === true ? [{ ...TERMINAL_AUTH, args: [...TERMINAL_AUTH.args] }] : [],
  }
}
