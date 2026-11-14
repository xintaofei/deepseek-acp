/**
 * CLI 入口：`npx deepseek-acp`。
 *
 * **stdout 是协议通道**：本文件与其加载的任何组合都不得向 stdout 写非协议
 * 内容。全部诊断走 stderr（验收标准 AC-G1）。
 * @module
 */

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { Context, Logger, type Exporter } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as CompactCommand from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import LlmService from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionService from '@deepseek-ai/dsh-session'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SpillStore from '@deepseek-ai/dsh-spill'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as AskUserTool from '@deepseek-ai/dsh-tool-ask-user'
import * as FsSearchTool from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as TodoTool from '@deepseek-ai/dsh-tool-todo'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { composeLsp, discoverLspServers, type LspServerSpec } from '../composition/lsp.js'
import { AcpSettings } from '../composition/settings.js'
import { SessionListIndex } from '../session/list-index.js'
import { ensurePiAi } from '../composition/pi-ai.js'
import { mountNativeShell } from '../composition/shell.js'
import * as acpBridge from '../index.js'
import { CREDENTIAL_REF } from './setup.js'
import { installToolCallStreamGuard } from './tool-call-stream-guard.js'

/**
 * 部署 persona（system prompt 的 order-0 段）。
 *
 * 不写死在 `dsh-system-prompt` 里的 harness 身份之外再造一套身份——那段
 * （`harness:identity`，order -100）已经声明「你是 DeepSeek Harness 驱动的
 * agent」。这里补的是**这个部署**是什么：一个跑在编辑器里的编码助手。
 *
 * 不复述任何工具的用法：每个工具自己贡献 schema 与提示段（平台 shell 还自带
 * 一段讲退出码），沙箱模式则由 `sandbox-policy` 贡献。在这里重写
 * 一遍只会多花 token，且会在上游改了行为时变成过时的错误说明。
 */
const PERSONA = [
  '你是一个通过 Agent Client Protocol 接入编辑器的编码助手，协助用户理解和修改他们的代码库。',
  '',
  '回答关于代码的问题前先读代码，不要凭文件名或猜测作答。',
  '你的改动会直接呈现在用户的编辑器里：改完说清楚改了什么，不要粘贴整份文件。',
].join('\n')

/**
 * Plan mode 生效时追加的引导段（US-19）。
 *
 * 只讲**这个模式要模型怎么做**，不讲它能不能写文件——plan mode 是引导，不是
 * 强制，真正的边界在沙箱与审批那边（上游 README 明确如此）。在这里写「不要
 * 修改文件」会造出一个假的保险：模型可能照做，也可能不照做，而用户会以为它
 * 一定不动手。
 *
 * 那条 `#` 标题的要求不是文风偏好：`exit_plan_mode` 会用 `/^#\s+\S/` 校验，
 * 不满足就直接拒绝这次退出。不写在提示里，模型要撞上几次才知道。
 */
export const PLAN_SECTION = [
  '当前处于计划模式：先把问题查清楚，再一次性给出完整方案，最后通过 exit_plan_mode 交给用户确认。',
  '',
  '先读代码再下结论，不要基于文件名或猜测编写方案。',
  '方案要具体到改哪些文件、各自改什么、以及为什么这么改；把你考虑过又放弃的做法和理由一并说清楚。',
  '提交给 exit_plan_mode 的方案必须是 Markdown，且以一个 `# ` 标题开头。',
].join('\n')

/** 工作区指令加载的字节上限：AGENTS.md / CLAUDE.md 合计。 */
const INSTRUCTIONS_MAX_BYTES = 40_000

/**
 * 会话日志的落盘根目录。
 *
 * 放在 `$DSH_HOME` 之下而不是项目里：编辑器启动的 agent 其 `process.cwd()`
 * 是不确定的（可能是 `/`），项目相对路径会把会话散落到各处；而会话列表要
 * 跨项目可见，本来就该有一个固定位置。上游那个 backend 也刻意没有默认值，
 * 理由相同。
 * @param env - 进程环境
 */
export function sessionsRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env['DEEPSEEK_ACP_SESSIONS_ROOT']
  // 第一个形参是「显式配置的 home」，环境在第二个。
  return explicit !== undefined && explicit.length > 0
    ? explicit
    : join(resolveDshHome(undefined, env), 'sessions')
}

/**
 * `session/list` 标题索引的文件位置（见 `src/session/list-index.ts`）。
 *
 * 放在会话根的**旁边**而不是里面：会话根与上游 CLI / 桌面端共用，里面的目录结构
 * 归上游的持久化后端管，塞进一个它不认识的文件不是我们能做的决定。文件名带上会话根
 * 的哈希，`DEEPSEEK_ACP_SESSIONS_ROOT` 指向别处时各用各的，不会串。缺省的会话根是
 * `$DSH_HOME/sessions`，索引因此落在 `$DSH_HOME/deepseek-acp/` 下，与设置文档同一处。
 * @param root - 会话根
 */
export function sessionListIndexPath(root: string): string {
  const absolute = resolve(root)
  const digest = createHash('sha256').update(absolute).digest('hex').slice(0, 16)
  return join(dirname(absolute), 'deepseek-acp', `session-index-${digest}.json`)
}

/**
 * 内置组合的默认 provider 路由 —— 由 `@deepseek-ai/dsh-llm-deepseek` 注册。
 * 换适配器时同时改这里与 {@link boot} 里挂载的插件。
 */
export const DEFAULT_PROVIDER = 'deepseek-official'

/**
 * 默认模型：DeepSeek-V4.1-Flash。
 *
 * 按官方定价页，它比 V4 Pro 便宜得多（输出单价约为它的三分之一）、并发上限是它的五倍，
 * 而且**收图片**——V4 Pro 不收。编辑器里的默认档因此是它：用户第一次把截图拖进
 * 来就能用，不必先去选择器里换模型。
 */
export const DEFAULT_MODEL = 'deepseek-flash'

/**
 * 本部署 advertise 的 DeepSeek 模型目录。
 *
 * ## 为什么还要覆盖
 *
 * 最初覆盖是因为上游内置目录里留着两个已下线的 id。DSH 0.2 起上游目录与这里
 * 列的是同样两条，留着覆盖只为一件事：**选择器里的说明是中文**，与适配器其余
 * 面向用户的文字一致（上游给 Flash 没写说明，给 Pro 的是英文）。
 *
 * 代价是目录会漂移：上游给条目加了字段，这里不照抄就**静默**丢掉，不报任何错。
 * 0.2 加的 `toolUpdate` 就这样丢过一次。所以 TC-MODEL-03 拿上游自带目录逐条对比
 * 除展示文字外的每个字段，上游一动用例就红——到那时要么照抄，要么干脆删掉覆盖。
 *
 * 目录是**建议性**的：它决定选择器里有什么、以及图片准入怎么判，不限制
 * `DEEPSEEK_ACP_MODEL` 能填什么——要用某个老 id 或内部灰度模型，环境变量照样直通。
 *
 * 未列出的字段吃适配器默认：`contextWindow` 回落到 `defaultContextWindow`（1M，
 * 与定价页相同），图片预算回落到适配器的默认值。`maxTokens` 同样不动——定价页写的
 * 384K 是**上限**，而适配器选的 256K 已经远超一次编码回答的量级，把上限拉满只会
 * 抬高单轮的最坏成本。
 *
 * @see https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
export const DEEPSEEK_MODELS: DeepSeekCatalogModel[] = [
  {
    id: DEFAULT_MODEL,
    name: 'DeepSeek-V4.1-Flash',
    description: '更快更省，支持图像理解。日常编码的默认档。',
    inputModalities: ['text', 'image'],
    // 下面两项是**提示缓存**的开关，漏掉都不报错，只会让 KV cache 命中率静默下降，
    // 所以照抄上游，不省。
    //
    // `in-history`：系统提示变了，把变化作为一条历史消息追加，而不是改写请求开头。
    systemPromptUpdate: 'in-history',
    // `addition-only`：会话中途工具变了（MCP 服务器晚连上、技能目录变了），新工具
    // 作为历史里的一次「新增」声明，不改动已缓存的前缀。没有它，agent loop 每遇到
    // 一次工具表变化就从头开一段新请求，整段前缀的缓存全部作废。
    toolUpdate: 'addition-only',
  },
  {
    id: 'deepseek-v4-pro',
    // 定价页那一行的版本名是 `DeepSeek-V4-Pro-0813`。这里**去掉快照后缀**：
    // 选择器里显示的是「选哪个模型」，而 `0813` 是同一个模型的哪一版快照——
    // id 不带它，官方也随时可能把它指向新快照。上游自带目录的写法同此。
    name: 'DeepSeek-V4-Pro',
    // 0.9.0 写的是「官方已宣布有序下线」。2026-11 的定价页已没有这句话，它照常在售，
    // 所以只写能从定价页核实的差别：更贵、不收图。「适合复杂任务」是上游目录的说法。
    description: '价格更高，不支持图像理解；上游建议用于复杂或对质量要求高的任务。',
  },
]

/** 从环境变量读取配置，缺省值集中在此。 */
export interface LauncherEnv {
  provider: string
  model: string
}

/**
 * 解析环境变量层。
 *
 * 与插件层不同，CLI **必须**给出 provider/model：`agents.create()` 缺其一即
 * 拒绝建会话。插件层保持可选，是为了让宿主组合自己决定。
 * @param env - 进程环境
 */
export function readEnv(env: NodeJS.ProcessEnv): LauncherEnv {
  return {
    provider: env['DEEPSEEK_ACP_PROVIDER'] ?? DEFAULT_PROVIDER,
    model: env['DEEPSEEK_ACP_MODEL'] ?? DEFAULT_MODEL,
  }
}

/**
 * 装配 agent 能力：模型无关、传输无关的那一层。
 *
 * 与 {@link boot} 分开是为了可测：`boot` 会把 bridge 接到真的 stdio 上，进程内
 * 测试碰它就等于抢走 `process.stdin`。组合本身（挂了哪些工具、沙箱是什么模式）
 * 才是要断言的东西，这里单独拿出来。
 *
 * 不含 provider 适配器与凭据 —— 那两个是部署配置，不是 agent 能力。
 * @param ctx - 根 context
 * @param options.sessionsRoot - 会话日志落盘根目录，见 {@link sessionsRoot}
 * @param options.lspServers - 已按 PATH 筛过的语言服务器表；缺省不挂 LSP。
 *   **发现放在 `boot()`、组合放在这里**：PATH 随机器变，而这个函数的装配结果
 *   必须给定输入就确定——否则 `tests/composition.spec.ts` 断的东西会变成
 *   「跑测试的这台机器装没装 typescript-language-server」。见 `composition/lsp.ts`。
 */
export async function composeAgent(
  ctx: Context,
  options: { sessionsRoot: string; lspServers?: Readonly<Record<string, LspServerSpec>> },
): Promise<void> {
  // 组合中不得挂 stdout logger —— stdout 属于协议。
  // `personaPrefix`（不再是 `persona`）：上游把部署人设拆成了前后两段，前段排在
  // 一方指导之前、后段排在其后。我们的这段讲的是「这个部署是什么」，属于前段。
  await ctx.plugin(SystemPrompt, { personaPrefix: PERSONA })
  for (const plugin of [SessionService, LlmService, ToolRegistry, AgentRegistry, AgentLoop]) {
    await ctx.plugin(plugin, {})
  }
  // 审批服务本身只是提问的接线板；真正的应答器由 bridge 注册（answerers/approval.ts）。
  // 没有应答器时链尾 fail-closed 成 `unavailable`。
  await ctx.plugin(WorkingDirectory, {})
  await ctx.plugin(ApprovalService, {})
  // 同为 seam：提问的 UI 提供方由 bridge 注册（answerers/elicitation.ts），落到
  // ACP 的 `elicitation/create` 表单上。`exit_plan_mode` 的计划评审也走这条链。
  await ctx.plugin(UserQuestions)
  // 沙箱要先于文件系统就位：`fs-sandbox` 注入 `sandboxPolicy`，而紧接着的
  // `agent-instructions` 就要用 `ctx.fs` 读 AGENTS.md——策略没到位，文件服务
  // 就还没注册。
  //
  // 沙箱后端按平台功能探测（macOS 走 Seatbelt），探测失败即 fail-closed。
  await ctx.plugin(LocalSandbox, {})
  // `workspace-write` 而非默认的 `read-only`：编辑器里的 agent 本来就是来改
  // 代码的，只读会让每次写都变成升级请求。边界仍是会话 cwd，越界要走审批。
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  // 文件系统 seam：`agent-instructions` 用它读 AGENTS.md，不注册任何工具。
  //
  // **`fs-sandbox` 而非 `fs-local`**，理由与 shell 那边同构且更硬：`tool-fs` 是
  // 拿 `ctx.fs.sandboxMode` 决定要不要执行策略的，而 `LocalFileSystem` 报
  // `undefined`（它自己的文档写明 cwd 只是解析默认值、**不是** containment
  // 边界）。挂它等于 `write` / `edit` 全程无约束，同时「文件权限」那个配置项
  // 只管得住 shell——一个只拦得住一半的边界比没有边界更坏，因为它看起来是有的。
  // 这个缺口实测复现过：`workspace-write` 下 `write` 把文件写到了工作区之外。
  await ctx.plugin(SandboxedFileSystem, {})
  // 从会话 cwd 向上找到项目根（标记 `.git`），加载 AGENTS.md / CLAUDE.md
  // 及其 .local 覆盖层，外加 `$DSH_HOME/AGENTS.md` 这条用户全局约定。
  await ctx.plugin(AgentInstructions, { maxBytes: INSTRUCTIONS_MAX_BYTES } as never)

  // 会话日志落盘 —— `session/load` / `session/list` 的**唯一**真值来源。
  // 没有它这两个方法不会被 advertise，也会直接 methodNotFound（见 initialize.ts）。
  await ctx.plugin(JsonlPersistence, { root: options.sessionsRoot })
  // 列表的标题索引：没有它，DSH 0.2 上的 v3 旧日志会让每次 `session/list` 都要
  // 几十秒（逐条读是 O(N²)）。理由与做法见 `src/session/list-index.ts`。
  await ctx.plugin(SessionListIndex, { path: sessionListIndexPath(options.sessionsRoot) })
  // 会话标题（US-22）。**不注册任何 provider**：内置的确定性回退直接取第一条
  // 用户消息的前几个词，不花 token、不引第二条模型路由，而会话选择器要的
  // 「这条是哪次对话」它已经答得上了。真要更好的标题是另起一个 provider 的事。
  await ctx.plugin(SessionTitle, {
    fallbackMaxWords: 8,
    // 中文没有空格分词，按词数截断几乎不生效，真正起作用的是字节上限：
    // 60 字节约合 20 个汉字，够一行标题。
    fallbackMaxBytes: 60,
    maxTitleBytes: 120,
  })

  // ── 命令面与会话模式 ────────────────────────────────────────────────
  // 命令注册表本身不带任何命令，只是接线板；`/plan` 由 plan-mode 注册进来。
  // 没有它的组合里 `/` 开头的输入就是普通文本，原样送给模型。
  await ctx.plugin(CommandRuntime)
  // plan mode 只贡献提示词段与 `/plan` 命令，**不动**沙箱与审批。`exit_plan_mode`
  // 的用户评审走 `ctx.userQuestions`（下面挂的 elicitation 应答器）。
  await ctx.plugin(PlanMode, { section: PLAN_SECTION })

  // ── 工具及其依赖 ────────────────────────────────────────────────────
  // 顺序无关紧要（Cordis 按 inject 解析），但按依赖分层写便于阅读。
  await ctx.plugin(SessionProjections)
  // Config 是位置参数数组而非对象，传 `{}` 会被 schema 拒绝。
  await ctx.plugin(SpillStore, [])
  // 挂 `-local` 这个 provider，**不要**再挂 `dsh-subprocess` —— 后者只是 seam，
  // 前者继承它并注册同一个 `subprocess` 服务，两个都挂会以「服务已注册」失败。
  // 只挂 seam 也不行：那种组合装配得起来，直到第一条命令执行才炸
  // `this.ctx.subprocess.spawn is not a function`。
  await ctx.plugin(LocalSubprocess)
  // 沙箱后端与策略已在文件系统之前挂好（见上），shell 与 fs 共用同一份。

  // `allowParallelInProgress: false` —— 同时只有一项进行中。ACP 的 plan 面板
  // 是给人看进度的，一次亮起五项等于没有进度。
  await ctx.plugin(TodoTool, { allowParallelInProgress: false })
  // **文件工具不在这里挂**，改由 port 装在会话作用域（`mountSessionFs`）。
  // `dsh-tool-fs` 是唯一读 `ctx.fs` 的插件，而它捕获的是自己的挂载 context；
  // 装在根上，会话级的 `fs` 替换（US-25 读改道）就永远看不到。
  // 让模型能主动发问而不是猜：需求不清时问一句，比按错误假设改完一堆文件划算。
  await ctx.plugin(AskUserTool)
  // `sampleOverCapGlobResults: false` —— 超额时给前 N 条而非随机抽样。抽样结果
  // 无法复现，模型基于它做的判断也就无法复核。
  await ctx.plugin(FsSearchTool, { sampleOverCapGlobResults: false })

  // ── 技能（US-27）────────────────────────────────────────────────────
  // 三件一套，缺一不可：注册表是空的接线板，提供方往里填，工具把它端给模型。
  //
  // **挂在根 context 而不是会话作用域。** 与文件工具那条相反的选择，理由也相反：
  // `tool-fs` 必须看到会话级替换过的 `ctx.fs`，而技能发现要的恰恰是部署级的那份
  // ——技能目录不随会话变，变的只有 cwd，而 cwd 是 `list()` 的入参。
  await ctx.plugin(SkillRegistry, {})
  // 本地提供方。扫的根按 rank 从高到低：`<项目根>/.dsh/skills`、
  // `<项目根>/.agents/skills`、`$DSH_HOME/skills`（默认 `~/.dsh`）、
  // `$DSH_AGENTS_HOME/skills`（默认 `~/.agents`）。归结成两条正交的规则：项目级
  // 压过全局，专用目录压过共用目录。TC-SKILL-06 钉着这个顺序（它是上游常量，改了
  // 我们这边不会有任何用例自己变红）。
  //
  // **`.agents` 那两个是与其它 agent 工具共用的目录**——挂上这个插件，别的工具放在
  // 那里的技能会一并被发现并进入 DeepSeek 的上下文。这是有意为之（写过一次的技能
  // 不该按工具再写一遍），但它足够意外，值得在这里留一句。
  //
  // 它经 `ctx.fs` 读盘，而我们挂的是 `SandboxedFileSystem`。不受影响：那一层
  // 只对 `write` / `edit` 两个变更加围栏，读在任何模式下都直通。
  //
  // **watch 保持默认的开启**：会话中途往技能目录里加一个技能、或改了它的描述，
  // 斜杠补全与模型看到的目录随即更新，不必重连。凭据那边关 watch 的理由（watcher
  // 拖住事件循环、进程断连后不退）在这里不成立：插件 teardown 时会关掉自己的
  // watcher。TC-GUARD-02 守着「断连即退出」，TC-COMP-07 守着热加载本身。
  await ctx.plugin(SkillFilesystem, {})
  // 模型侧：注册 `skill` 工具，并在每个步骤前把目录作为持久 `<system-reminder>`
  // 注入。**注入的目录与技能正文都不会漏给客户端**——它们落在会话日志里的
  // source kind 是 `skill-catalog` / `skill-invocation`，而 `mapEvent` 对
  // `user/message` 的过滤是白名单（只放 `kind: 'user'`）。TC-SKILL-04 钉着这条。
  //
  // 不挂 `dsh-skill-badge`：那是随包的徽章技能，上游自己交付的 CLI 也把它声明为
  // 禁用，启用它是显式选择而不是默认。
  await ctx.plugin(ToolSkill, {})

  // ── shell ───────────────────────────────────────────────────────────
  // 沙箱 executor 而非 local executor：文件工具已经在 `workspace-write` 之下，
  // 让 shell 无约束地跑就等于给了一条绕过文件边界的路，
  // 比 `write` 更危险，边界却更松，这种不一致没有道理。
  await ctx.plugin(ShellEnv, {})
  // `enableRunInBackground: false` —— 后台任务在 ACP 下没有落点：完成通知会给
  // 空闲 agent 起一个新回合，而 ACP 的回合边界是 `session/prompt` 的一次请求/
  // 应答。那种自发回合发出的 `session/update` 没有对应的 `stopReason` 归属，
  // 编辑器侧也无从展示。要做得先设计非 prompt 触发的更新怎么归属（M1-c）。
  await mountNativeShell(ctx, 'sandbox')

  // ── 上下文压缩 ──────────────────────────────────────────────────────
  // 长会话撞到上下文上限时，把较早的一段总结成一条替换消息，而不是让下一次
  // 请求直接以 `CONTEXT_WINDOW_EXCEEDED` 失败。编辑器里的会话本来就长（一个
  // 下午的重构能跑几十轮），没有它这条链的终点就是「聊到一半突然不能聊了」。
  //
  // 挂**具体后端**（`-basic`）而不是 `dsh-compaction`——后者导出的
  // `CompactionEngine` 是抽象基类，两个都挂会以「服务已注册」失败。这是这套代码
  // 里第四对同构的坑（subprocess / settings / attachment / 这里）。
  await ctx.plugin(TokenMeter, {})
  // `auto: true` —— 压力触发自动压缩。ACP 没有「请压缩」这个方法，客户端也没有
  // 触发它的入口，只能靠自动策略与 `/compact`。关掉它等于把这个能力藏进一条
  // 用户得先知道才敲得出来的命令里。
  await ctx.plugin(BasicCompaction, { auto: true })
  // 人手触发：`/compact`。命令注册表已在上面挂好；这个命令不收配置。
  await ctx.plugin(CompactCommand)

  // ── 死循环护栏 ──────────────────────────────────────────────────────
  // 不进工具表、不否决调用、不改写入参：只在连续同参重复调用时注入一条升级提示。
  // 决定权仍在模型手里（合法的重复调用不被延迟也不被拦截），成本近乎为零，而它
  // 挡住的是最难自愈的一种失败——模型拿同一个参数反复调同一个工具直到回合耗尽。
  await ctx.plugin(RepeatToolReminder, {})

  // ── 图片输入（US-23）────────────────────────────────────────────────
  // 挂 `-local` 这个 provider，**不要**再挂 `dsh-attachment`——后者导出的
  // `AttachmentStore` 是抽象基类，两个都挂会以「服务已注册」失败。与 subprocess、
  // settings 那两对是同一个坑。
  //
  // 图片字节落进 `$DSH_HOME/attachments/v1/` 的内容寻址库，会话日志里只留引用。
  // 直接把 base64 写进日志会让一条日志涨到几十 MB，而每次恢复都要整份读回来。
  await ctx.plugin(LocalAttachments, {})
  // 图片超预算时的恢复：DSH 0.2 起适配器不再自己丢最旧的图，而是以
  // `IMAGE_OFFLOAD_REQUIRED` 失败，只有这个插件会接住它——记一条 `image/offload`
  // 选出最旧的若干张换成占位文本，再重试这一步。没挂它，图片一多的会话会在某一轮
  // 突然以那个错误码失败，此后每一轮都一样。
  //
  // 它同时注册 `image/offload` 的消息投影：日志里一旦有这种事件（我们写的，或
  // 共用会话根的上游桌面端写的），不挂它这条会话就恢复不出来。所以不跟着
  // 「部署收不收图」走，一律挂。无配置。
  await ctx.plugin(ImageOffload)

  // ── 语言服务器（模型面 `lsp` 工具）──────────────────────────────────
  // 一台机器上一个语言服务器都找不到时整套不挂：`tool-lsp` 会往**每一次**请求的
  // 系统提示里塞一段固定引导，而那个工具的每次调用都只会报「没有路由」。用不上的
  // 能力不该按次收费。
  if (options.lspServers !== undefined) await composeLsp(ctx, options.lspServers)
}

/**
 * 把 cordis 的日志接到 **stderr** 上。
 *
 * 没有这个 exporter，`ctx.logger` 的每一条记录都不会去到任何地方——bridge 里所有
 * `warn`（通知失败、审批因断连被拒、呈现器抛错…）在真实二进制里全是落空的，
 * 而那些恰恰是出问题时唯一的线索。
 *
 * 只装在 `boot()` 里、不装进 `composeAgent()`：后者是进程内测试用的装配路径，
 * 每个用例都吐一遍日志只会淹掉真正的失败输出。
 *
 * **stderr 而非 stdout**：stdout 是协议通道（AC-G1），写一个字节进去就毁掉整条
 * 连接。有子进程级用例守着这条。
 * @param ctx - 根 context
 */
export function installStderrLog(ctx: Context): void {
  const exporter: Exporter = {
    // 颜色交给终端：编辑器多半把 agent 的 stderr 原样收进日志面板，ANSI 码在
    // 那里是噪声。
    colors: false,
    // **必须显式放开到 warn**。cordis 的等级是 error=0 / info=1 / warn=2 /
    // debug=3，而 exporter 不写 `levels` 时生效等级是 **1**——于是 `warn` 被
    // 整个丢弃。上面那段注释说「没有 exporter 这些 warn 就落空」，只说对了一半：
    // 装了 exporter 但不放等级，它们照样落空，而且看起来像是已经接好了。
    // 不放到 3：`debug` 是给排查开的，默认吐出来只会淹没真正的线索。
    levels: { default: 2 },
    // **经 `Logger.format` 展开**，不要自己把参数拼起来。上游的告警几乎都是
    // printf 风格（`warn('watcher error on %s', path)`）：原样拼接会印出字面的 `%s`、
    // 再把参数接在句末；`Error` 参数经 `JSON.stringify` 只剩 `{}`，堆栈整个丢掉。
    // 0.9.0 一直是这样错着的。
    export(message) {
      process.stderr.write(`[${message.type}] ${message.name}: ${Logger.format(exporter, message)}\n`)
    },
  }
  ctx.logger.exporter(exporter)
}

/**
 * 凭据文件压住了客户端传进来的另一个 key 时，`boot()` 在 stderr 提示的那一行。
 *
 * DSH 0.2 把优先级倒了过来：`$DSH_HOME/.credentials.yaml` 里存着的 key 压过进程
 * 环境变量（0.1.x 是环境变量赢）。跑过 `--setup`、之后又在编辑器配置里经 `env`
 * 换 key 的用户，升级后会**静默**继续用文件里的旧 key——请求照样成功，只是用的是
 * 另一把 key、记在另一个账号上，没有任何报错能让人察觉。
 *
 * 只说「两处不一致、用的是哪一处」，任何一边的值、哪怕片段都不进提示。两边相同时
 * 不提示：那只是同一个 key 放了两处，没有歧义。
 * @param ctx - 已挂好凭据服务的根 context
 * @param file - 凭据文件路径，只用于提示文字
 * @returns 提示文字；没有被压住的 key 时 undefined
 */
export async function shadowedApiKeyNotice(
  ctx: Context,
  file = join(resolveDshHome(), '.credentials.yaml'),
): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const stored = await credentials.resolve(CREDENTIAL_REF)
  if (stored?.source !== 'file') return undefined
  // 与凭据 provider 读的是同一层（`process`），而不是 `boot()` 收到的 `env`：要比的
  // 是「它实际看到、却被文件压住的那个值」。
  const inherited = launchEnvironmentOf(ctx).getFrom(CREDENTIAL_REF, ['process'])?.value
  if (inherited === undefined || inherited.length === 0 || inherited === stored.value) return undefined
  return `${CREDENTIAL_REF} from the client environment is ignored: ${file} stores a different key, `
    + 'and since DSH 0.2 the stored key wins. Run `deepseek-acp --setup` to replace it, '
    + 'or delete that entry to use the environment variable.'
}

/**
 * 引导内置组合并挂上 bridge。
 *
 * API Key 的引用名是 `DEEPSEEK_API_KEY`。挂上本地凭据 provider 是为编辑器场景准备
 * 的：GUI 应用不继承登录 shell 的环境变量，`.zshrc` 里的 export 到不了子进程。有了
 * 它，key 可以放在 `$DSH_HOME/.credentials.yaml`（`--setup` 写的就是这里），与启动
 * 方式无关。
 *
 * **DSH 0.2 起凭据文件压过环境变量**，两处都有时用文件里的，不一致时由
 * {@link shadowedApiKeyNotice} 提示。`.env` 文件不读：上游那两层要宿主提供启动环境
 * 快照（`launchEnvironment`），我们没有提供，0.9.0 也一样。
 *
 * 缺 key 时不在启动期报错，而是在第一个回合以 `MISSING_CREDENTIAL` 失败。凭据文件
 * 只在启动时读一次（watch 关着，见下）：`--setup` 写完后客户端会重连，新进程读到
 * 新 key。
 * @param env - 进程环境
 * @param onClosed - 连接关闭且 teardown 结束后调用；CLI 传退出进程
 * @returns 已引导的根 context
 */
export async function boot(env: NodeJS.ProcessEnv, onClosed?: () => void): Promise<Context> {
  const ctx = new Context()
  installStderrLog(ctx)
  // 必须在第一个 LLM 请求前装好（见模块头注释：部分上游路径的分片用显式 null
  // 或空串重复工具调用头，适配器的 `!== void 0` 守卫对两者都不设防，首片捕获的
  // id/name 被逐片覆盖 → 空名派发）。不卸载：一个客户端连接就是一个进程，壳
  // 随进程一起走。
  installToolCallStreamGuard()
  // 语言服务器按 PATH 现查：这是**部署环境**的事实，不是能力装配的一部分。
  // 诊断走 `ctx.logger`，也就是上面那个 stderr exporter——一个配错的
  // `DEEPSEEK_ACP_LSP_SERVERS` 不该让 agent 起不来，但也不该悄无声息。
  const lspServers = await discoverLspServers(env, (message) => {
    ctx.logger('lsp').warn(message)
  })
  await composeAgent(ctx, {
    sessionsRoot: sessionsRoot(env),
    ...(lspServers === undefined ? {} : { lspServers }),
  })
  // watch 关掉：agent 是「一个客户端连接 = 一个进程」的短命子进程，热重载没有
  // 收益，而 fs watcher 会一直持有事件循环，让进程在 stdin 关闭后不退出。
  await ctx.plugin(LocalCredentials, { watch: false })
  // 推理档位显式写出来，而不是吃默认。
  //
  // 行为上这与不配是**一样**的：`LlmRuntime` 会把适配器报告的 `defaultEffort`
  // 物化进请求（`effective = requested ?? reasoning.defaultEffort`），而适配器在
  // 未配置时报告的正是 `high`。写出来是为了让「部署选了哪一档」在组合里是一句
  // 明文，而不是一条要读两个包才推得出来的默认值链——这个默认值直接决定每次
  // 请求的延迟与 token 开销，不该藏着。
  //
  // 模型目录同样显式给出，理由与它的漂移风险见 {@link DEEPSEEK_MODELS}。
  await ctx.plugin(LlmDeepSeek, { reasoningEffort: 'high', models: DEEPSEEK_MODELS })
  const shadowed = await shadowedApiKeyNotice(ctx)
  if (shadowed !== undefined) ctx.logger('credentials').warn('%s', shadowed)
  // ── 用户设置文档：多 provider 的配置面 ────────────────────────────────
  //
  // DSH 0.2 的设置表单属于上游的 profile，我们不起 profile，也不去改桌面端的
  // profile，而是自己保管一份文档（理由见 `src/composition/settings.ts`）。Loader
  // 在这里只是 pi-ai 的挂载器：它的 Config 校验与热更新都要经 Loader 的条目来做。
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  await ctx.plugin(AcpSettings, {})
  // 通用多 provider 适配器：openai / anthropic / azure / vertex / bedrock 走
  // pi-ai 的内置目录，此外还能整条手工声明一个 OpenAI 兼容网关或自建服务。
  //
  // 与 `llm-deepseek` **并存**：`deepseek-official` 那条路由仍归后者（它有
  // DeepSeek 专属的 Files API 图片上传与 vision 模型），pi-ai 只服务用户自己
  // 配出来的路由。两者注册的路由 key 撞车时 `registerAdapter` 会 fail loud，
  // 不会静默顶掉。
  //
  // **只在设置文档真的提到它时才加载**：这个包 import 一次要 5 秒，静态挂进来
  // 会把这 5 秒加到每一次编辑器启动上（实测首次应答 ~3s → ~4-10s）。没配路由的
  // 部署什么都不损失——`providers/*` 那条线会在用户真的去配的时候现拉。
  // 理由与判据见 `src/composition/pi-ai.ts`。
  if (ctx.acpSettings.mentionsPiAi()) {
    await ensurePiAi(ctx)
  }
  await ctx.plugin(acpBridge, { ...readEnv(env), onClosed } as never)
  return ctx
}
