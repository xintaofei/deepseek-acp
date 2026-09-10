/**
 * 测试夹具：引导最小 dsh 组合并挂上 bridge，用一对内存流承载真实的
 * ndJSON JSON-RPC 帧——因此测试覆盖到实际的编解码路径，而非绕过它。
 *
 * 不需要真实模型或 API Key：assistant 事件由测试直接向会话日志追加。
 * @module
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  PROTOCOL_VERSION,
  client as createClientApp,
  ndJsonStream,
  type ClientContext,
  type Stream,
} from '@agentclientprotocol/sdk'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as AskUserTool from '@deepseek-ai/dsh-tool-ask-user'
import LlmService from '@deepseek-ai/dsh-llm'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import FileSettings from '@deepseek-ai/dsh-settings-file'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionService from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import SpillStore from '@deepseek-ai/dsh-spill'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type {
  ElicitationSchema,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import { ensurePiAi } from '../src/composition/pi-ai.js'
import { mountNativeShell, type NativeShellToolName } from '../src/composition/shell.js'
import * as bridge from '../src/index.js'
import { FAKE_MODEL, FAKE_PROVIDER, FAKE_PROVIDER_ALT, FakeLlmAdapter } from './fake-llm.js'

/** 客户端侧收到的更新，按到达顺序。 */
export interface CapturedUpdate {
  sessionId: string
  kind: string
  text?: string
}

/** 客户端侧对 `session/request_permission` 的应答策略，可逐用例改写。 */
export type PermissionResponder = (
  request: RequestPermissionRequest,
) => RequestPermissionResponse | Promise<RequestPermissionResponse>

/** 客户端侧对 `elicitation/create` 的应答策略，可逐用例改写。 */
export type ElicitationResponder = (
  request: CreateElicitationRequest,
) => CreateElicitationResponse | Promise<CreateElicitationResponse>

/**
 * 客户端侧对 `fs/read_text_file` 的应答策略，可逐用例改写（US-25）。
 *
 * 抛异常就是「这份缓冲区我给不出」——真实客户端的常态（文件没打开、超出它的
 * 读上限、路径在它的策略之外），agent 侧据此回落磁盘。
 */
export type FsReadResponder = (
  request: ReadTextFileRequest,
) => ReadTextFileResponse | Promise<ReadTextFileResponse>

/** 一条被 harness 收下的 cordis 日志记录。 */
export interface CapturedLog {
  /** `info` / `warn` / `error` / `debug` */
  type: string
  /** 记录器名，形如插件名 */
  name: string
  /** 拼好的正文 */
  text: string
}

export interface TestHarness {
  ctx: Context
  /** 驱动 agent 侧方法的客户端 context */
  acp: ClientContext
  updates: CapturedUpdate[]
  /**
   * 这个 harness 收到的全部日志记录，按到达顺序。
   *
   * **为什么用例需要它**：上游把「后台写入失败」这类事故只报给 `ctx.logger`
   * （例如持久化的 `reportBackgroundFailure`），而不抛给调用方。生产侧在 `boot()`
   * 里装了 stderr exporter，测试装配路径**故意没装**（每个用例都吐一遍日志会淹掉
   * 真正的失败输出）——代价是这些线索在用例里全部落空。
   *
   * 结果就是 TC-LOAD-01 那个偶发：日志里出现重复的 seq 批次，只能推断「字节已落盘
   * 却被判为失败」，但**究竟是哪个错误触发的重试，无从得知**。这里把记录收下来，
   * 下次复现时能直接说出是 EMFILE、EIO 还是 rollback 失败，而不是继续猜。
   */
  logs: CapturedLog[]
  /** 可编排的假模型 */
  llm: FakeLlmAdapter
  /** 第二条 provider 路由的适配器；没开 `altProvider` 时 undefined */
  llmAlt: FakeLlmAdapter | undefined
  /** 客户端收到的授权请求，按到达顺序 */
  permissionRequests: RequestPermissionRequest[]
  /** 客户端收到的表单征询，按到达顺序 */
  elicitations: CreateElicitationRequest[]
  /** 客户端收到的文本读委托，按到达顺序（US-25） */
  fsReads: ReadTextFileRequest[]
  /** 改写客户端如何应答表单征询 */
  setElicitationResponder: (responder: ElicitationResponder) => void
  /** 改写客户端如何应答文本读委托 */
  setFsReadResponder: (responder: FsReadResponder) => void
  /** 订阅**原始** update 负载（`updates` 只保留摘要字段） */
  onUpdate: (sink: (update: unknown) => void) => void
  /** 改写客户端如何应答授权请求 */
  setPermissionResponder: (responder: PermissionResponder) => void
  /** 卸载 bridge 插件——即「仅 ACP 的 HMR 释放」路径 */
  disposeBridge: () => void
  /** 某会话 id 是否仍有存活 agent（孤儿检测） */
  hasAgent: (sessionId: string) => boolean
  /**
   * 等到某会话真的落盘。
   *
   * 写入是批量合并的（默认 200ms 窗口）：回合结束、乃至 agent 从注册表里消失，
   * 都**不**等于日志已经在磁盘上。直接去读会读到空目录。
   *
   * **它只保证「日志出现了」，不保证「写完了」**——判据是会话出现在 `list()` 里，
   * 而那是**头部**落盘的时刻。要让另一个 harness 去读同一个 root，用 `retire()`。
   */
  waitPersisted: (sessionId: string, timeoutMs?: number) => Promise<void>
  /**
   * 彻底退休这个 harness：卸载整棵 ctx 并**等到**清理完成。
   *
   * 「录一个 harness、再用另一个 harness 从磁盘恢复」是本套件测持久化的标准手法。
   * 它有个不明显的前提：恢复端 `session/load` 之后也会成为同一个日志文件的写入方，
   * 所以录制端必须**先彻底停**，两个写入方不能在时间上重叠。
   *
   * `disposeBridge()` 达不到这个要求——它只卸 bridge 插件；`session/disposed` 触发的
   * 上游 `retire()` 是发射后不管的（promise 只存进 `retirements`，没人 await）。
   * `waitPersisted()` 也不行：它的判据是会话出现在 `list()` 里，那是**头部**落盘的
   * 时刻，后续批次还没写。
   *
   * 这里卸的是根 fiber，于是持久化插件的 `ctx.effect` 清理函数会被执行并**被等待**：
   * flush 全部活会话 → 等干所有 per-id 链 → 关后端。返回之后磁盘上的日志才是终态。
   *
   * ## 它修的是什么（已确诊）
   *
   * TC-LOAD-01 曾偶发失败，现场是日志里出现**重复的 seq 批次**（15,16,17 写了两遍），
   * 上游读取端据此拒绝加载（`corrupt session log: seq gap in committed region`）。
   *
   * 成因在上游 `onCreated` → `adoptLivePrefix` 这条路：新建的写入控制器先
   * `loadStored(id)` **读**磁盘上已有的前缀，再把「超出该前缀的那段」**追加**回去。
   * 这个「读—算—写」在**单个 coordinator 内**由 per-id promise 链保护，跨 coordinator
   * 则毫无保护。于是：
   *
   * 1. 恢复端 `session/load` 恢复会话 → `initFor` → `onCreated` → `loadStored` 读到
   *    录制端此刻的日志（停在 seq 14）
   * 2. 录制端的最终排空落盘，写入 [15,16,17]
   * 3. 恢复端按**第 1 步读到的**前缀算 suffix，把 [15,16,17] 又追加一遍
   * 4. 随后重放历史时撞见重复 seq，拒绝加载
   *
   * **两次写入都是成功的**，所以一条日志都没有——这也是当初查不下去的原因；另一半
   * 原因是 `live.init.catch(() => {})` 把 init 期的错误静默吞掉了。
   *
   * 证据：同样 8 路负载下，旧写法（`waitPersisted`）连续两轮都在第 3 次命中，
   * 换成 `retire()` 后 30 次 0 命中。
   *
   * > 上游这条读—写竞争在**跨进程**同样成立（同一个 sessions root，一个进程还在写、
   * > 另一个去 load 同一会话）。按 D4「纯下游」的约束我们不改上游，只能规避。
   */
  retire: () => Promise<void>
}

/** 等待条件成立。 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * 表单的默认作答：每个字段取第一个候选，自由文本给一段占位。
 *
 * 这个函数只认自己发出去的那套 schema 形状（`oneOf` / `items.anyOf` / 纯
 * string），不做通用 JSON Schema 求解。
 */
function defaultFormAnswer(request: CreateElicitationRequest): Record<string, string | string[]> {
  const schema = 'requestedSchema' in request ? (request.requestedSchema as ElicitationSchema) : undefined
  const content: Record<string, string | string[]> = {}
  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    const p = property as {
      type?: string
      oneOf?: { const: string }[]
      items?: { anyOf?: { const: string }[]; enum?: string[] }
    }
    if (p.type === 'array') {
      const first = p.items?.anyOf?.[0]?.const ?? p.items?.enum?.[0]
      content[key] = first === undefined ? [] : [first]
    } else {
      content[key] = p.oneOf?.[0]?.const ?? '默认回答'
    }
  }
  return content
}

/** 一对互联的 web 流，模拟 stdio 两端。 */
function pipePair(): { a: Stream; b: Stream } {
  let ctrlA!: ReadableStreamDefaultController<Uint8Array>
  let ctrlB!: ReadableStreamDefaultController<Uint8Array>
  const aToB = new ReadableStream<Uint8Array>({ start: (c) => { ctrlA = c } })
  const bToA = new ReadableStream<Uint8Array>({ start: (c) => { ctrlB = c } })
  const aOut = new WritableStream<Uint8Array>({ write: (chunk) => { ctrlA.enqueue(chunk) } })
  const bOut = new WritableStream<Uint8Array>({ write: (chunk) => { ctrlB.enqueue(chunk) } })
  return { a: ndJsonStream(aOut, bToA), b: ndJsonStream(bOut, aToB) }
}

/**
 * 引导组合、挂载 bridge、连接内存客户端。
 * @param options.config - 传给 bridge 的配置
 * @param options.shell - 挂上平台原生 shell 工具：`local` 无沙箱，`sandbox` 走
 *   部署真正用的那个 executor（要求平台有可用沙箱后端）
 * @param options.sessionsRoot - 挂 JSONL 持久化并落盘到此；缺省不挂持久化，
 *   于是 `session/load` / `session/list` 既不被 advertise 也不可用
 * @param options.commands - 挂命令注册表（不含任何命令，除非同时挂 plan-mode）
 * @param options.planMode - 挂 `dsh-plan-mode`：会话模式、`/plan` 命令与
 *   `exit_plan_mode` 工具都随它进来
 * @param options.questions - 挂 `dsh-user-questions` seam 与 `ask_user_question`
 *   工具；bridge 会把提问接到 ACP 的表单征询上
 * @param options.elicitation - 客户端是否 advertise `elicitation.form`；默认
 *   跟随 `questions`，显式给 false 可测「客户端不支持」的降级
 * @param options.title - 挂 `dsh-session-title`（不注册 provider，用内置的
 *   确定性回退）
 * @param options.fs - 挂 `dsh-fs-local` 后端；文件工具由 port 装在会话作用域，
 *   所以这里只需要底座。与 `shell: 'local'` 同理：**不**挂沙箱版，让文件用例
 *   不背平台依赖，部署真正用的那个由 `composition.spec` 断
 * @param options.fsRead - 客户端是否 advertise `fs.readTextFile`（US-25）；
 *   为真时握手会声明它，并注册一个可改写的 `fs/read_text_file` 应答器
 */
export async function createHarness(
  options: {
    config?: bridge.AcpBridgeConfig
    shell?: 'local' | 'sandbox'
    /** Explicit PowerShell executable for Windows executor compatibility tests. */
    pwshPath?: string
    sessionsRoot?: string
    commands?: boolean
    planMode?: boolean
    questions?: boolean
    elicitation?: boolean
    title?: boolean
    fs?: boolean
    fsRead?: boolean
    /**
     * 挂技能栈，并把用户级技能根**关进这个目录**（`<它>/dsh-home`、
     * `<它>/agents-home`）。给路径而不是布尔，就是为了让「不许扫到本机家目录」
     * 无法被忘记。项目级的根仍由会话 cwd 决定。
     */
    skills?: string
    /**
     * 再注册**第二个 provider 路由**（{@link FAKE_PROVIDER_ALT}），由 `h.llmAlt`
     * 暴露它自己的适配器。
     *
     * 单适配器测不到跨 provider 的东西：模型下拉只有在候选跨了 provider 时才
     * 变成分组形状、取值才带前缀，而「切到别家的模型」是否真的换了路由，也只有
     * 在有第二家时才问得出来。
     */
    altProvider?: boolean
    /**
     * 挂设置服务与本地凭据，两者都**关进这个目录**（`<它>/settings.yaml`、
     * `<它>/.credentials.yaml`）。
     *
     * 给路径而不是布尔，与 `skills` 同样的理由，而且更硬：这条链会**写盘**，
     * 一个忘了隔离的用例会去改本机真正的 `~/.dsh/.credentials.yaml`。
     */
    settings?: string
    /** Explicit inherited environment layer; useful for host-independent credential tests. */
    launchEnvironment?: Readonly<Record<string, string>>
    /**
     * 挂附件服务（图片输入，US-23），对象库**关进这个目录**。
     *
     * 与 `settings` 同样给路径而不是布尔，理由也一样且同样硬：图片准入会真的
     * 往盘上写内容寻址对象，不隔离就写进本机的 `~/.dsh/attachments/`。而这些
     * 对象目前**永不回收**（上游把 GC 推迟了），跑一遍用例就在用户家目录里留
     * 一堆再也没人认领的文件。
     */
    attachments?: string
  } = {},
): Promise<TestHarness> {
  const ctx = new Context()
  if (options.launchEnvironment !== undefined) {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: options.launchEnvironment },
    ]))
  }
  const logs: CapturedLog[] = []
  // 装在挂任何插件**之前**：exporter 只对注册之后的记录生效，晚一步就漏掉装配期
  // 的告警——而装配期恰恰是最容易出事又最难看出来的那一段。
  //
  // 不往 stderr 打：`boot.ts` 里那条注释是对的，每个用例都吐一遍日志会淹掉真正的
  // 失败输出。收进数组，谁需要谁去读（`h.logs`）；真出事时由用例自己打出来。
  ctx.logger.exporter({
    colors: false,
    // 不写 `levels` 时生效等级是 1，`warn`(2) 与 `debug`(3) 会被静默丢掉——而
    // 上游报告后台失败用的正是 `warn`。用例里全都收下，判断交给用例自己。
    levels: { default: 3 },
    export(message: { type: string; name: string; args: unknown[] }) {
      logs.push({
        type: message.type,
        name: message.name,
        text: message.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      })
    },
  })
  // `SessionProjections` 在这份基础组合里不再可选：`AgentLoop` 现在 inject 它
  // （回合边界投影归它注册）。缺席时 loop 不会启动、也不报错——`session/new`
  // 会以「no agent factory registered」失败，而那条信息读起来像是漏挂了 loop。
  for (const plugin of [
    SystemPrompt,
    SessionService,
    LlmService,
    ToolRegistry,
    SessionProjections,
    AgentRegistry,
    AgentLoop,
    ApprovalService,
  ]) {
    await ctx.plugin(plugin, {})
  }
  if (options.sessionsRoot !== undefined) {
    // `compression: 'none'` —— 用例出问题时日志能直接 cat 出来看。
    await ctx.plugin(JsonlPersistence, { root: options.sessionsRoot, compression: 'none' })
  }
  // 命令面与模式面分别可选：默认两个都不挂，于是「没挂时的降级行为」才是
  // 大多数用例跑的那条路径，不必专门去构造。
  if (options.title === true) {
    // 与部署一致：不注册 provider，用内置的确定性回退（取第一条用户消息）。
    await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 60, maxTitleBytes: 120 })
  }
  // 文件系统底座。文件工具**不**在这里挂：它随会话装（`mountSessionFs`），
  // 这样会话级的读改道才可能生效。
  if (options.fs === true) await ctx.plugin(LocalFileSystem, {})
  // 技能栈（US-27）。`skill-filesystem` 经 `ctx.fs` 读盘，所以顺带把它挂上。
  //
  // **`dshHome` 与 `agentsHome` 必须显式指向临时目录。** 不给的话它们默认落到
  // `~/.dsh/skills` 与 `~/.agents/skills`——而 `~/.agents/skills` 是与其它 agent
  // 工具共用的目录，开发机上通常非空。用例会因此扫到开发者自己的技能，断言随
  // 「这台机器上装了什么」而变，在 CI 上绿、在本地红（或者反过来）。这一条是
  // 实测踩到的：调研 spike 里就意外列出了三个本机技能。
  if (options.skills !== undefined) {
    if (options.fs !== true) await ctx.plugin(LocalFileSystem, {})
    await ctx.plugin(SkillRegistry, {})
    await ctx.plugin(SkillFilesystem, {
      dshHome: join(options.skills, 'dsh-home'),
      agentsHome: join(options.skills, 'agents-home'),
      // watcher 在用例里只会带来不确定性：目录是用例自己写的，写完就查，没有
      // 「外部进程改了文件」这回事。关掉也就少了一份 chokidar 句柄。
      watch: false,
    })
    await ctx.plugin(ToolSkill, {})
  }
  if (options.commands === true || options.planMode === true) await ctx.plugin(CommandRuntime)
  // plan-mode 的 `exit_plan_mode` 要经 `ctx.userQuestions` 评审，因此挂 plan-mode
  // 就一并挂上这个 seam —— 否则那条链在测试里根本走不通。
  if (options.questions === true || options.planMode === true) {
    await ctx.plugin(UserQuestions)
    await ctx.plugin(AskUserTool)
  }
  // plan-mode 会往 `sessionProjections` 注册一个投影单元；那个服务已在基础组合里。
  if (options.planMode === true) await ctx.plugin(PlanMode, { section: 'TEST PLAN SECTION' })
  // 默认用 `local`：终端卡片那条链跟哪个 executor 无关，而沙箱后端要做平台
  // 探测、探测不到就 fail-closed——让全部用例都背上平台依赖换不来覆盖。只有
  // 明确要测拒绝/提权的用例才要 `sandbox`。
  let mountedShell: NativeShellToolName | undefined
  if (options.shell !== undefined) {
    await ctx.plugin(SpillStore, [])
    // 只挂 `-local`：它继承 `dsh-subprocess` 并注册同一个服务，两个都挂会以
    // 「服务已注册」失败；只挂 seam 则要到第一次执行才炸 spawn 不是函数。
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(ShellEnv, {})
    if (options.shell === 'sandbox') {
      await ctx.plugin(LocalSandbox, {})
      // `read-only`：任何写都被拒，用来制造确定的拒绝与提权窗口。
      await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
    }
    mountedShell = await mountNativeShell(
      ctx,
      options.shell,
      options.pwshPath === undefined ? {} : { pwshPath: options.pwshPath },
    )
  }
  await waitFor(
    () =>
      ctx.agents !== undefined
      && ctx.tools !== undefined
      && ctx.sessions !== undefined
      && ctx.approval !== undefined
      && (mountedShell === undefined || ctx.tools.get(mountedShell) !== undefined)
      && (options.commands !== true || ctx.get('commands') !== undefined)
      && (options.skills === undefined || ctx.get('skills') !== undefined)
      && (options.planMode !== true || ctx.get('planMode') !== undefined),
    5_000,
    'dsh services',
  )

  // provider 配置面（`providers/*`）需要一个**可写**的设置服务与凭据服务。两者
  // 都指向用例给的隔离目录：这条链真的写盘。
  if (options.settings !== undefined) {
    await ctx.plugin(FileSettings, {
      path: join(options.settings, 'settings.yaml'),
      // watch 关掉，理由与 boot.ts 一致：watcher 持有事件循环。用例里还多一层
      // ——vitest 不会因为一个悬着的 watcher 失败，只会在整轮结束时挂住。
      watch: false,
    })
    await ctx.plugin(LocalCredentials, { dshHome: options.settings, watch: false })
    // 走与生产同一条幂等入口：`providers/*` 也会调它，两处各挂一次会以
    // 「路由已注册」失败。
    await ensurePiAi(ctx)
  }

  if (options.attachments !== undefined) {
    // `dshHome` 显式给出：`attachment-local` 缺省会走 `$DSH_HOME` 再退到
    // `~/.dsh`，而用例绝不能写进那里。
    await ctx.plugin(LocalAttachments, { dshHome: options.attachments })
  }

  // 只伪造模型这一层；回合生命周期走真实 agent loop。
  const llm = new FakeLlmAdapter()
  ctx.llm.registerAdapter([FAKE_PROVIDER], llm)
  // 第二条路由用**另一个适配器实例**而不是把同一个注册两次：这样
  // `llmAlt.providersUsed` 非空本身就证明请求进了另一家，不必再去分辨同一份
  // 记录里的两条路由。
  const llmAlt = options.altProvider === true ? new FakeLlmAdapter() : undefined
  if (llmAlt !== undefined) ctx.llm.registerAdapter([FAKE_PROVIDER_ALT], llmAlt)

  const { a: agentSide, b: clientSide } = pipePair()
  // `stream` 属于 ApplyOptions（测试传输覆盖），不在 Config schema 里。
  await ctx.plugin(bridge, {
    provider: FAKE_PROVIDER,
    model: FAKE_MODEL,
    ...options.config,
    stream: agentSide,
  } as never)

  const updates: CapturedUpdate[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const elicitations: CreateElicitationRequest[] = []
  // 默认取第一个选项（无选项则给一段自由文本）：用例若忘了设策略，得到的是
  // 一个「用户答了」的确定结果，而不是挂住。
  let elicitationResponder: ElicitationResponder = (request) => ({
    action: 'accept',
    content: defaultFormAnswer(request),
  })
  // 默认拒绝：测试若忘了设策略，得到的是 fail-closed 而非静默放行。
  let responder: PermissionResponder = () => ({
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  })
  const fsReads: ReadTextFileRequest[] = []
  // 默认「这个文件我没打开」——与真实编辑器最常见的情形一致，也让忘了设应答
  // 的用例得到确定的回落而不是一份编出来的内容。
  let fsReadResponder: FsReadResponder = () => {
    throw new Error('client has no buffer for this file')
  }

  const rawSinks: ((update: unknown) => void)[] = []
  const clientApp = createClientApp()
    .onNotification('session/update', ({ params }) => {
      const update = params.update as { sessionUpdate: string; content?: { text?: string } }
      updates.push({
        sessionId: String(params.sessionId),
        kind: update.sessionUpdate,
        ...(update.content?.text !== undefined ? { text: update.content.text } : {}),
      })
      for (const sink of rawSinks) sink(params.update)
    })
    .onRequest('session/request_permission', ({ params }) => {
      permissionRequests.push(params)
      return responder(params)
    })
    .onRequest('elicitation/create', ({ params }) => {
      elicitations.push(params)
      return elicitationResponder(params)
    })
    .onRequest('fs/read_text_file', ({ params }) => {
      fsReads.push(params)
      return fsReadResponder(params)
    })
  const connection = clientApp.connect(clientSide)

  // 能力位是在 `initialize` 时协商的，而 elicitation 只在客户端 advertise 了
  // `elicitation.form` 时才可用。用到征询的用例都要先握手，这里代劳；其余用例
  // 保持原样（自己按需调 initialize）。
  const wantsElicitation = options.elicitation ?? (options.questions === true || options.planMode === true)
  if (wantsElicitation || options.elicitation === false || options.fsRead === true) {
    await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        ...(wantsElicitation ? { elicitation: { form: {} } } : {}),
        // 布尔位，且判定是 `=== true`：给 false 与不给在行为上等价，但这里
        // 只在要它时给，握手摘要里就分得出「没声明」和「声明了不支持」。
        ...(options.fsRead === true ? { fs: { readTextFile: true, writeTextFile: false } } : {}),
      },
    })
  }

  return {
    ctx,
    acp: connection.agent,
    updates,
    logs,
    llm,
    llmAlt,
    permissionRequests,
    elicitations,
    fsReads,
    onUpdate: (sink: (update: unknown) => void) => {
      rawSinks.push(sink)
    },
    setFsReadResponder: (next: FsReadResponder) => {
      fsReadResponder = next
    },
    setPermissionResponder: (next: PermissionResponder) => {
      responder = next
    },
    setElicitationResponder: (next: ElicitationResponder) => {
      elicitationResponder = next
    },
    disposeBridge: () => {
      ctx.registry.delete(bridge)
    },
    // `ctx.fiber.dispose()` 返回的是 cordis 串起来的 `disposalTask`，await 得到的
    // 才是「异步清理也跑完了」。`ctx.registry.delete()` 做不到——它只是同步地对
    // 每个 fiber 调一次 `dispose()`，不等返回值。
    retire: async () => {
      await ctx.fiber.dispose()
    },
    hasAgent: (sessionId: string) => ctx.agents.get(sessionId as never) !== undefined,
    waitPersisted: async (sessionId: string, timeoutMs = 10_000) => {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('harness has no persistence mounted')
      const deadline = Date.now() + timeoutMs
      for (;;) {
        try {
          const snapshots = await persistence.list()
          if (snapshots.some((s) => String(s.header.id) === sessionId)) return
        } catch (error: unknown) {
          // The atomic directory publisher can expose its temporary directory
          // to list() just before renaming it. Retry only that transient race.
          if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
        }
        if (Date.now() > deadline) throw new Error(`session ${sessionId} never persisted`)
        await new Promise((r) => setTimeout(r, 25))
      }
    },
  }
}
