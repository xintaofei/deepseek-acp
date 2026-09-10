/**
 * 面向编辑器的 Agent Client Protocol 适配器（Cordis 插件）。
 *
 * 本包**不得有 default export**：Cordis loader 的 unwrapping 会吞掉具名
 * `inject` 元数据，导致注入静默失效——装配照常成功，第一次用到才炸。
 * （上游为此写过一份复盘，结论就是这一条。）
 *
 * stdout 是协议通道：组合中不得挂 stdout logger，全部诊断走 stderr。
 * @module deepseek-acp
 */

import { Readable, Writable } from 'node:stream'
import { agent as createAgentApp, ndJsonStream, type AgentContext, type Stream } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// 侧效应类型导入：把 `approval/request` waterfall 合并到 Context 的事件表上。
// 本 bridge 只监听它，不注入 `approval` 服务——组合里没挂审批服务时事件不会
// 触发，监听本身无害。
import type {} from '@deepseek-ai/dsh-user-approval'
// 同样是侧效应类型导入：把 `userQuestions` 合并到 Context 的服务表上，让下面的
// `ctx.get('userQuestions')` 有类型。服务本身是可选组合件。
import type {} from '@deepseek-ai/dsh-user-questions'
import { answerApproval } from './answerers/approval.js'
import { askUser } from './answerers/ask.js'
import { clientTextReader } from './answerers/fs-read.js'
import type { Bridge, AcpBridgeConfig } from './bridge.js'
import { mapEvent } from './mapping/updates.js'
import { createInProcessPort } from './port/in-process.js'
import { handleCancel } from './protocol/session-cancel.js'
import { handleCloseSession } from './protocol/session-close.js'
import { handleForkSession } from './protocol/session-fork.js'
import { handleResumeSession } from './protocol/session-resume.js'
import {
  clientSupportsCompaction,
  clientSupportsElicitation,
  clientSupportsFsRead,
  clientSupportsTerminal,
  clientSupportsTerminalAuth,
  describeClient,
  handleInitialize,
} from './protocol/initialize.js'
import { handleListSessions } from './protocol/session-list.js'
import { handleLoadSession } from './protocol/session-load.js'
import { refreshCommands } from './protocol/session-commands.js'
import {
  handleDisableProvider,
  handleListProviders,
  handleSetProvider,
} from './protocol/providers.js'
import { handleSetConfigOption } from './protocol/session-config.js'
import { handleSetMode } from './protocol/session-mode.js'
import { handleNewSession } from './protocol/session-new.js'
import { handlePrompt } from './protocol/session-prompt.js'
import { SessionTable, settlePrompt } from './session/table.js'
import { internalError } from './codec/errors.js'

export type { AcpBridgeConfig } from './bridge.js'
export { mapEvent } from './mapping/updates.js'
export { acpPromptToText, promptHasUnsupportedContent } from './codec/prompt.js'
export { turnEndToStopReason } from './codec/stop-reason.js'

export const name = 'deepseek-acp'

/** 本 bridge 创建并拥有 agent；其余能力由 agent 组合承载。 */
export const inject = ['agents']

export const Config: Schema<AcpBridgeConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
})

/** 传输层注入点：测试用来替换 stdio，CLI 用来把连接寿命接到进程寿命上。 */
export interface ApplyOptions {
  stream?: Stream
  /**
   * 连接关闭且 teardown 结束后调用一次；Cordis disposal 路径**不**触发
   * （那种情况下宿主还活着，寿命不该由本插件决定）。
   *
   * CLI 用它退出进程：stdio agent 靠「句柄耗尽自然退出」是不牢靠的，组合里
   * 任何一个 watcher 或长活定时器都会把进程留下来变成孤儿。
   */
  onClosed?: () => void
}

/**
 * 挂载 ACP bridge。
 * @param ctx - 已注入 `agents` 的 Cordis context
 * @param config - provider / model 选择
 */
export function apply(ctx: Context, config: AcpBridgeConfig & ApplyOptions = {}): void {
  const port = createInProcessPort(ctx)
  const table = new SessionTable()
  const logger = ctx.logger

  /** 连接建立后捕获，用于在请求处理器之外推送通知。 */
  let connection: AgentContext | undefined
  /**
   * 客户端是否实现 `fs/read_text_file`（US-25），握手时定下。
   *
   * 与 `terminalOutput` / `elicitation` 不同，它不放在 `bridge` 上：处理器不
   * 直接读它，只经 `bridge.readDelegate` 拿结果——那个闭包同时需要连接，而连接
   * 本来就不在 `bridge` 里。
   */
  let fsRead = false

  const bridge: Bridge = {
    port,
    table,
    config,
    terminalOutput: false,
    elicitation: false,
    compaction: false,
    readDelegate(sessionId: SessionId) {
      const conn = connection
      // 能力位在握手时定下（`fsRead`），连接在 `onConnect` 时捕获；两者都没有
      // 就没有委托这回事，会话安静地全程走磁盘。
      if (!fsRead || conn === undefined) return undefined
      return clientTextReader(
        sessionId,
        (method, params, options) => conn.request(method, params, options),
        (message) => {
          bridge.warn(message)
        },
      )
    },
    notify(sessionId: SessionId, update) {
      const conn = connection
      if (conn === undefined) return
      // 通知失败必须被隔离：消失的客户端不得破坏进行中的 agent 回合。
      void conn.notify('session/update', { sessionId, update }).catch((error: unknown) => {
        logger?.warn?.(`deepseek-acp: session/update failed: ${String(error)}`)
      })
    },
    async notifyAwaited(sessionId: SessionId, updates) {
      const conn = connection
      if (conn === undefined) throw internalError('no ACP connection to replay into')
      // 按序发起、一并等待：发起顺序即写出顺序，所以这样既保序又有背压。
      // 与 `notify` 不同，这里的失败**要**冒泡——见 Bridge.notifyAwaited。
      await Promise.all(updates.map((update) => conn.notify('session/update', { sessionId, update })))
    },
    notifyAfterResponse(sessionId: SessionId, update) {
      // 一个 macrotask 就够，且是**确定的**而非碰运气：SDK 里处理器返回与写出
      // 应答之间只隔一个 microtask（`await handler(...)` 之后同步调
      // `responder.respond`，后者把消息压进连接共享的 writeQueue）。宏任务排在
      // 全部微任务之后，因此应答一定先入队，而入队顺序就是写出顺序。
      setTimeout(() => {
        bridge.notify(sessionId, update)
      }, 0)
    },
    assertOpen() {
      if (table.closed) throw internalError('the ACP bridge has been disposed')
    },
    warn(message: string) {
      logger?.warn?.(`deepseek-acp: ${message}`)
    },
  }

  // ── 事件订阅：映射为 ACP 更新，并推进 prompt 结算 ──────────────────
  const offSessionEvent = port.events.onSessionEvent((agent, event: SessionEvent) => {
    // I2：精确对象比对，仅比 id 不足以防同 id 冒充。
    const record = table.ownedBy(agent)
    if (record === undefined) return

    for (const update of mapEvent(event, {
      presenter: record.presenter,
      terminal: { enabled: bridge.terminalOutput, cwd: record.cwd },
      contextWindow: record.handle.controls.contextWindow,
      compaction: bridge.compaction,
    })) {
      bridge.notify(record.acpSessionId, update)
    }

    const inflight = record.inflight
    if (inflight === undefined) return
    if (event.type === 'turn/end' && (inflight.anyTurn || inflight.turn === event.data.turn)) {
      if (event.data.reason.kind === 'error') {
        // 模型失败立刻以 prompt 错误浮现；普通结束等 whole-agent idle。
        record.inflight = undefined
        inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`))
      } else {
        inflight.endReason = event.data.reason
      }
    }
  })

  // ── 实时流式分片 ──────────────────────────────────────────────────
  //
  // 单独一条订阅：分片不是会话事件（日志里没有它，见 mapping/assistant-stream.ts），
  // 而没有它客户端要等一整步结束才看到第一个字。
  const offAssistantStream = port.events.onAssistantStream((agent, frame) => {
    const record = table.ownedBy(agent)
    if (record === undefined) return
    for (const update of record.stream.frame(frame)) bridge.notify(record.acpSessionId, update)
  })

  const offClaimed = port.events.onInboxClaimed((agent, messageId, turn) => {
    const inflight = table.ownedBy(agent)?.inflight
    if (inflight !== undefined && inflight.messageId === messageId) inflight.turn = turn
  })

  // 注册表变更会影响全局视图或某个 agent 的遮蔽层，事件本身分辨不出是哪种，
  // 于是逐个会话各自重新解析（US-18 命令 / US-27 技能）。
  //
  // 两条事件走**同一个**刷新：一条 `available_commands_update` 里两个来源都在，
  // 只重算一半是不可能的。技能那条来自文件 watcher（新建一个 SKILL.md 就会响），
  // 因此这里比命令那条频繁得多。
  const refresh = (): void => {
    // 刷新现在是异步的，且是从事件回调里发起的——没有人接这个 promise。失败必须
    // 就地咽掉：一次目录刷新失败不该变成 unhandled rejection 打死进程。
    void refreshCommands(bridge).catch((error: unknown) => {
      bridge.warn(`command catalog refresh failed: ${String(error)}`)
    })
  }
  const offCommands = port.commands?.onChange(refresh)
  const offSkills = port.skills?.onChange(refresh)

  const offAgentError = port.events.onAgentError((agent, turn, error) => {
    const record = table.ownedBy(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    const detail = error instanceof Error ? error.message : String(error)
    inflight.reject(internalError(`turn failed: ${detail}`))
  })

  // ── 审批应答器：dsh 的 approval/request → ACP session/request_permission ──
  //
  // 只认领本 bridge 拥有的 agent；别人的 agent 一律 `next()`，否则会把同进程内
  // 其他消费者（子 agent、TUI）的审批问题劫持到这条 ACP 连接上。
  const offApproval = ctx.on('approval/request', (request, next) => {
    const record = table.ownedBy(request.agent)
    if (record === undefined) return next()

    const conn = connection
    return answerApproval(
      record.acpSessionId,
      {
        ...(request.callId !== undefined ? { callId: String(request.callId) } : {}),
        toolName: request.toolName,
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
      },
      {
        // `AgentContext` 是按方法名调用的通用 context（`request` / `notify`），
        // 没有每个方法一个的具名方法。
        ...(conn !== undefined
          ? { requestPermission: (params) => conn.request('session/request_permission', params) }
          : {}),
        warn: bridge.warn,
      },
    ).then((decision) => decision ?? next())
  })

  // ── 征询应答器：dsh 的 user-questions/request → ACP 的提问通道 ────────
  //
  // 与审批那条同构的 waterfall（上游把原先独占的 `registerProvider` 换成了
  // 作用域 waterfall）。因此认领规则也照抄那条：只接本 bridge 拥有的 agent，
  // 其余一律 `next()`——否则会把同进程内其他消费方（子 agent、TUI）的提问
  // 劫持到这条 ACP 连接上，而那边根本没有对应的会话可挂。
  //
  // 具体走表单还是授权通道由 `askUser` 按能力位选路，见 answerers/ask.ts。
  const offQuestions = ctx.on('user-questions/request', (request, next) => {
    const agent = request.agent
    if (agent === undefined || table.ownedBy(agent) === undefined) return next()

    // 依赖在**每次提问时**现取：监听器在 apply 期就挂上了，那时连接还没建立，
    // 能力位也还没协商。在这里固化一份快照等于永远拿到「无连接、不支持」。
    const conn = connection
    return askUser(request, {
      elicitation: bridge.elicitation,
      ...(conn === undefined
        ? {}
        : {
            createElicitation: (params, options) => conn.request('elicitation/create', params, options),
            requestPermission: (params, options) =>
              conn.request('session/request_permission', params, options),
          }),
      sessionOf: (agent) => table.ownedBy(agent as Agent)?.acpSessionId,
      soleCallOf: (agent) => table.ownedBy(agent as Agent)?.presenter.solePendingCall(),
    })
  })

  // ── ACP 应用：按方法名注册处理器 ──────────────────────────────────
  const app = createAgentApp()
    .onConnect((opened) => {
      // `.client` 是用于调用客户端侧方法的 context。
      connection = opened.client
    })
    .onRequest('initialize', ({ params }) => {
      // 握手先于建会话，因此这里定下的能力对之后所有会话生效。
      bridge.terminalOutput = clientSupportsTerminal(params)
      bridge.elicitation = clientSupportsElicitation(params)
      bridge.compaction = clientSupportsCompaction(params)
      fsRead = clientSupportsFsRead(params)
      // 记一行客户端能力位：一切降级行为的排查都从这里开始。走 stderr（AC-G1），
      // 且只在挂了 exporter 的组合里可见——测试装配不挂，因此不吵。
      logger?.info?.(`client ${describeClient(params)}`)
      return handleInitialize({
        persistent: port.catalog !== undefined,
        // 与 `persistent` 同构：能力位跟着组合走，不跟着愿望走。
        providers: port.providers !== undefined,
        image: port.images !== undefined,
        // 终端登录是 opt-in 的方法类型：只发给声明认得它的客户端，其余照旧拿空
        // 数组。**必须读 `params`**——这是本 handler 里唯一一处「应答内容取决于
        // 请求」的地方，漏掉的表现不是报错，是老客户端收到一个没准备好的变体。
        terminalAuth: clientSupportsTerminalAuth(params),
      })
    })
    .onRequest('authenticate', () => {
      // 仍是 no-op，但理由变了：现在 advertise 的那条是 **Terminal Auth**，而按
      // 规范它**不经过这个 RPC**——客户端是拿同一个二进制加 `--setup` 另起一个
      // 交互式进程，看退出码判成败，登录发生在这条连接之外。
      //
      // 那为什么不干脆报错？因为客户端**可以**把任意 methodId 送进来（老客户端、
      // 或者把 terminal 方法误当成 agent 方法的实现），而这里除了「确认一声」没有
      // 别的事要做：真正的凭据检查发生在第一个回合，缺 Key 就是 `MISSING_CREDENTIAL`。
      // 为一个无害的调用返回错误，只会把「能跑」变成「连不上」。
    })
    .onRequest('session/new', ({ params }) => handleNewSession(bridge, params))
    .onRequest('session/load', ({ params }) => handleLoadSession(bridge, params))
    .onRequest('session/list', ({ params }) => handleListSessions(bridge, params))
    .onRequest('session/close', ({ params }) => handleCloseSession(bridge, params))
    .onRequest('session/resume', ({ params }) => handleResumeSession(bridge, params))
    .onRequest('session/fork', ({ params }) => handleForkSession(bridge, params))
    .onRequest('providers/list', ({ params }) => handleListProviders(bridge, params))
    .onRequest('providers/set', ({ params }) => handleSetProvider(bridge, params))
    .onRequest('providers/disable', ({ params }) => handleDisableProvider(bridge, params))
    .onRequest('session/set_config_option', ({ params }) => handleSetConfigOption(bridge, params))
    .onRequest('session/set_mode', ({ params }) => handleSetMode(bridge, params))
    .onRequest('session/prompt', ({ params }) => handlePrompt(bridge, params))
    .onNotification('session/cancel', ({ params }) => {
      handleCancel(bridge, params)
    })

  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const connected = app.connect(stream)

  // ── 统一静默边界：断连与 Cordis disposal 共用，且幂等 ──────────────
  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing

    const records = table.drain() // 置 closed，拒绝新会话与新 prompt（I3）
    offSessionEvent()
    offAssistantStream()
    offClaimed()
    offCommands?.()
    offSkills?.()
    offAgentError()
    // 先摘掉审批应答器：teardown 期间再来的问题应当落到链尾的 fail-closed
    // 默认值，而不是发往一条正在关闭的连接。
    offApproval()
    // 征询应答器同理：摘掉之后 seam 自己会报「没有应答器」，好过发往一条正在
    // 关闭的连接然后永远等不到应答。
    offQuestions()

    // 先停自己的活再 await：释放可能阻塞在持久化上，期间顶层 agent
    // 不该继续跑模型与工具调用。
    for (const record of records) {
      port.driver.cancel(record.handle.agent)
      settlePrompt(record, 'cancelled')
    }

    quiescing = (async () => {
      const results = await Promise.allSettled(records.map((r) => r.handle.dispose()))
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
      // 并行释放但串行上报：先 await 全部结果，避免早退留下未回收资源。
      if (failures.length > 0) {
        const detail = failures.map((f) => (f instanceof Error ? f.message : String(f))).join('; ')
        throw new AggregateError(failures, `ACP agent teardown failed for ${failures.length} session(s): ${detail}`)
      }
    })()
    return quiescing
  }

  void connected.closed
    .catch((error: unknown) => {
      bridge.warn(`connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      bridge.warn(`connection-close teardown failed: ${String(error)}`)
    })
    // teardown 失败也要放行：宁可带着告警退出，也不要留下孤儿进程。
    .finally(() => config.onClosed?.())

  ctx.effect(() => quiesce, 'deepseek-acp.connection')
}
