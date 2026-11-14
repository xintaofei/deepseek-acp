/**
 * TC-COMP-* —— 内置组合的断言。
 *
 * 断的是 `composeAgent`（不是 `boot`）：后者会把 bridge 接到真的 stdio 上，
 * 进程内测试碰它就等于抢走 `process.stdin`。
 *
 * 这一批与 harness 里那套是互补的：harness 挂平台的 local executor，让终端
 * 卡片用例不背沙箱依赖；**部署真正用的是 sandbox executor**，那个差别只有
 * 这里能抓到。
 * 沙箱后端不可用的平台上这些用例会失败——那是对的，组合在那种平台上本来就
 * 起不来，静默降级成无约束执行才是坏结果。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { PLAN_SECTION, composeAgent, installStderrLog } from '../src/launcher/boot.js'
import { createInProcessPort } from '../src/port/in-process.js'
import { waitFor } from './harness.js'
import { realTempDir } from './temp-dir.js'
import { NATIVE_SHELL_TOOL } from './native-shell.js'
import { nativeShellToolName } from '../src/composition/shell.js'

/**
 * 全文件共用一个组合。
 *
 * 装一次要做沙箱平台探测，逐用例重装是纯粹的浪费；而这些用例只读不写，
 * 共用没有串扰风险。Cordis 4 的根 context 没有对外的整体 teardown，进程随
 * vitest 一起结束即可。
 */
/** 往技能根里写一个最小的技能。 */
function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nbody\n`)
}

let shared: Promise<Context> | undefined
function composed(): Promise<Context> {
  shared ??= (async () => {
    const ctx = new Context()
    // 会话根用临时目录：别把用例跑出来的日志写进用户的 ~/.dsh。
    await composeAgent(ctx, { sessionsRoot: mkdtempSync(join(tmpdir(), 'dsacp-comp-')) })
    await waitFor(() => ctx.tools?.get(NATIVE_SHELL_TOOL) !== undefined, 10_000, 'composed tools')
    return ctx
  })()
  return shared
}

/**
 * 一个会话作用域的视角。
 *
 * **文件工具只在会话作用域可见**（US-25）：`dsh-tool-fs` 由 port 装在
 * `agentCtx` 上，因为它捕获自己的挂载 context，只有这样会话级的 `fs` 替换才
 * 生效。全局视角（`ctx.tools.get(name)`）看不到它们——这不是缺陷，而是这些
 * 工具的作用域事实，所以断言也得换到模型实际所处的那个视角。
 */
let sharedScope: Promise<{ ctx: Context; agent: Agent }> | undefined
function scoped(): Promise<{ ctx: Context; agent: Agent }> {
  sharedScope ??= (async () => {
    const ctx = await composed()
    const handle = await createInProcessPort(ctx).sessions.create({
      sessionId: SessionId('tc-comp-fs'),
      cwd: mkdtempSync(join(tmpdir(), 'dsacp-comp-cwd-')),
      // **带上委托**，这样 `DelegatedReadFileSystem` 真的在链路里，下面那条
      // 提权参数断言才顺带覆盖了它对 `sandboxMode` 的转发。恒返回 undefined
      // 表示「客户端给不出，走磁盘」，读写行为与不带委托时一致。
      readDelegate: async () => undefined,
    })
    return { ctx, agent: handle.agent }
  })()
  return sharedScope
}

describe('TC-COMP-01 工具集', () => {
  it('全局作用域挂上了 M1-b 承诺的工具', async () => {
    const ctx = await composed()
    for (const name of [NATIVE_SHELL_TOOL, 'glob', 'grep', 'todo_write']) {
      expect(ctx.tools.get(name), `缺少工具 ${name}`).toBeDefined()
    }
    const foreignShell = NATIVE_SHELL_TOOL === 'pwsh' ? 'bash' : 'pwsh'
    expect(ctx.tools.get(foreignShell), `不应同时注册 ${foreignShell}`).toBeUndefined()
  }, 30_000)

  it('平台到 shell 方言的映射固定', () => {
    expect(nativeShellToolName('win32')).toBe('pwsh')
    expect(nativeShellToolName('linux')).toBe('bash')
    expect(nativeShellToolName('darwin')).toBe('bash')
  })

  it('文件工具在会话作用域里 —— 模型看得到，全局视角看不到', async () => {
    const { ctx, agent } = await scoped()
    for (const name of ['read', 'write', 'edit']) {
      expect(ctx.tools.get(name, agent), `会话作用域缺少工具 ${name}`).toBeDefined()
      // 反面同样要钉住：若哪天它们又被装回根上，会话级 fs 替换会静默失效
      // ——工具照跑、读照成功，只是永远读的是磁盘。
      expect(ctx.tools.get(name), `${name} 不该出现在全局作用域`).toBeUndefined()
    }
  }, 30_000)

  it('M1-c 的两个交互工具也在：提问与退出计划模式', async () => {
    const ctx = await composed()
    for (const name of ['ask_user_question', 'exit_plan_mode']) {
      expect(ctx.tools.get(name), `缺少工具 ${name}`).toBeDefined()
    }
  }, 30_000)
})

describe('TC-COMP-09 工具执行器已选定（DSH 0.2.2）', () => {
  // 0.2.2 把「怎么执行工具」从 `dsh-tools` 拆成了独立插件（原生 / PTC）。漏挂时工具
  // 照样注册、上面几条照样绿，typecheck 也是绿的；坏在模型那一侧：每一步装配提示词
  // 都抛 `ToolExecutorUnavailableError`，一轮对话都跑不起来。所以这里走模型实际
  // 走的那条路——按会话作用域装配一次，断工具真的进了请求。
  it('会话作用域装配提示词时，工具定义经执行器进了请求', async () => {
    const { ctx, agent } = await scoped()
    const assembled = await ctx.systemPrompt.assemble({ scope: agent })
    const names = (assembled.tools as { name: string }[] | undefined)?.map((tool) => tool.name) ?? []
    for (const name of [NATIVE_SHELL_TOOL, 'read', 'edit', 'ask_user_question']) {
      expect(names, `请求里缺少工具 ${name}`).toContain(name)
    }
  }, 30_000)
})

describe('TC-COMP-04 M1-c 的服务都在', () => {
  it('命令面、plan mode、提问 seam、标题服务均已挂载', async () => {
    const ctx = await composed()
    // bridge 是按 `ctx.get(...)` 决定要不要 advertise 对应能力的：这里少一个，
    // 表现就是编辑器里那个控件整个消失，而 agent 侧一切「正常」。
    for (const service of ['commands', 'planMode', 'userQuestions', 'sessionTitle']) {
      expect(ctx.get(service as never), `缺少服务 ${service}`).toBeDefined()
    }
  }, 30_000)

  it('图片超预算的恢复已挂上 —— 否则 IMAGE_OFFLOAD_REQUIRED 无人接、带 image/offload 的日志也读不回来', async () => {
    const ctx = await composed()
    expect(ctx.sessions.messageProjections.map((p) => p.type)).toContain('image/offload')
  }, 30_000)

  it('plan 引导段告诉模型方案要以 # 标题开头 —— 上游会照这条硬校验', () => {
    // `exit_plan_mode` 用 `/^#\s+\S/` 校验方案文本，不满足直接拒绝这次退出。
    // 提示里不写，模型只能撞几次墙才知道；这两处是同一条规则的两半。
    expect(PLAN_SECTION).toContain('# ')
    expect(EXIT_PLAN_MODE).toBe('exit_plan_mode')
    expect(/^#\s+\S/.test('# 方案\n\n先改 A。')).toBe(true)
  })
})

describe('TC-COMP-07 技能栈（US-27）', () => {
  it('注册表与模型侧工具都在 —— 三件一套缺一不可', async () => {
    const ctx = await composed()
    // 注册表在，说明 `dsh-skill` 挂上了；bridge 靠 `ctx.get('skills')` 决定要不要
    // 把技能并进斜杠目录，缺了它整个功能静默消失。
    expect(ctx.get('skills')).toBeDefined()
    // `skill` 工具在，说明 `dsh-tool-skill` 挂上了。只挂注册表不挂它，模型侧
    // 一无所知——技能只剩用户手动敲一条路。
    expect(ctx.tools?.get('skill')).toBeDefined()
  }, 30_000)

  it('本地提供方已注册 —— 只挂注册表等于一个永远空的目录', async () => {
    const ctx = await composed()
    // 注册表不暴露提供方列表，所以从行为侧验：能列出来（哪怕是空的）而不抛，
    // 就说明 `list()` 走通了整条提供方链。这台机器上有没有技能不影响判定。
    await expect(ctx.get('skills')?.list({ cwd: tmpdir() })).resolves.toBeInstanceOf(Array)
  }, 30_000)

  it('不挂 skill-badge —— 上游交付的 CLI 也把它声明为禁用', async () => {
    const ctx = await composed()
    // 徽章提供方会贡献一个名为 `dsh` 的 bundled 技能。它出现在这里，说明有人
    // 顺手把 badge 也挂了，那是显式选择而不该是默认。
    //
    // 先断言注册表在：不然注册表整个消失时这条会空过一个「没有 dsh」的假绿。
    const skills = ctx.get('skills')
    expect(skills).toBeDefined()
    const summaries = await skills!.list({ cwd: tmpdir() })
    expect(summaries.map((s) => s.name)).not.toContain('dsh')
    // DSH 0.2 还会发现启动配置里声明的 bundled 根；那不等于单独的 `dsh-skill-badge`
    // 插件被挂上了，所以这里专门再断一次 bundled 来源的 `dsh`。
    expect(summaries.some((s) => s.name === 'dsh' && s.source === 'bundled')).toBe(false)
  }, 30_000)

  it('技能目录热加载：会话中途新加的技能不用重连就进目录', async () => {
    // PR #9 曾把 watch 关掉，于是新加的技能要等下一次连接才看得到。bridge 靠
    // `skills/change` 刷新斜杠补全，所以这里断的是这条事件真的来了，而不只是再列一次
    // 能列出来——不开 watch 时手动再列一次也可能列得出来，但没人会去列。
    const ctx = await composed()
    const skills = ctx.get('skills')!
    const cwd = realTempDir('dsacp-comp-skills-')
    mkdirSync(join(cwd, '.git'))
    writeSkill(join(cwd, '.dsh', 'skills'), 'first')
    // 先列一次：watcher 是按列过的根建立的。
    expect((await skills.list({ cwd })).map((s) => s.name)).toContain('first')

    let changed = 0
    const off = ctx.on('skills/change', () => {
      changed += 1
    })
    try {
      writeSkill(join(cwd, '.dsh', 'skills'), 'added-later')
      await waitFor(() => changed > 0, 10_000, 'skills/change after adding a skill')
      expect((await skills.list({ cwd })).map((s) => s.name)).toContain('added-later')
    } finally {
      off()
    }
  }, 30_000)
})

describe('TC-COMP-08 用例不读本机的家目录', () => {
  it('DSH_HOME 与 DSH_AGENTS_HOME 都指向临时目录 —— 组合按生产默认值解析的路径落不到 ~/.dsh、~/.agents', () => {
    // `composeAgent` 挂的指令加载与技能提供方都按这两个变量找全局目录；`~/.agents` 是与
    // 其它 agent 工具共用的，开发机上多半有东西。注入在 vitest 配置里（tests/isolated-homes.ts），
    // 漏掉那一行，这条先红。
    expect(resolveDshHome()).toContain('dsacp-test-home-')
    expect(resolveAgentsHome()).toContain('dsacp-test-home-')
  })
})

describe('TC-COMP-05 文件工具在沙箱之下', () => {
  it('ctx.fs 报告 workspace-write —— 缺了它，write/edit 全程无约束', async () => {
    const ctx = await composed()
    // `dsh-tool-fs` 是**拿这个值**决定要不要执行策略的：`undefined` 意味着
    // 「后端不做约束」，于是它连 `sandboxPolicy` 都不去取，每次写都是无围栏的
    // `writeText`。`dsh-fs-local` 正好报 undefined —— 曾经挂的就是它，实测下
    // 一次越界写会直接打到内核，只有操作系统的文件权限拦得住。
    expect(ctx.fs.sandboxMode).toBe('workspace-write')
  }, 30_000)

  it('write / edit 都 advertise 了提权参数 —— 与 shell 同一条边界', async () => {
    const { ctx, agent } = await scoped()
    // 这两个字段是「本工具受约束」的可观测证据：`tool-fs` 只在后端确实约束时
    // 才生成它们。少了它们，模型连「这次越界，请授权」都表达不了。
    //
    // 会话作用域取值同时钉住了另一件事：会话里那份 `ctx.fs`（US-25 之后可能
    // 是读改道的装饰器）必须仍然报告 `sandboxMode`。装饰器忘了转发这个 getter
    // 的话，围栏会**静默**整个失效，而这两个字段正好会跟着消失。
    for (const name of ['write', 'edit']) {
      const params = ctx.tools.get(name, agent)?.parameters as { properties?: Record<string, unknown> }
      expect(Object.keys(params.properties ?? {}), `${name} 缺提权参数`).toContain('sandbox_permissions')
    }
  }, 30_000)

  it('read 不带提权参数 —— 任何模式都允许读，给了反而是噪声', async () => {
    const { ctx, agent } = await scoped()
    const params = ctx.tools.get('read', agent)?.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(params.properties ?? {})).not.toContain('sandbox_permissions')
  }, 30_000)
})

describe('TC-COMP-02 shell 在沙箱之下', () => {
  it('executor 报告 workspace-write —— 与文件工具同一条边界', async () => {
    const ctx = await composed()
    // `sandboxMode` 是「这个 executor 会约束执行」的能力事实：local executor
    // 报 undefined，sandbox executor 报配置的默认模式。工具层也靠它决定要不要
    // 给模型 `sandbox_permissions` 这个提权参数。
    expect(ctx.shell.sandboxMode).toBe('workspace-write')
  }, 30_000)

  it('提权参数已 advertise，模型可以就越界命令发起授权', async () => {
    const ctx = await composed()
    const params = ctx.tools.get(NATIVE_SHELL_TOOL)?.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(params.properties ?? {})).toContain('sandbox_permissions')
  }, 30_000)
})

describe('TC-COMP-03 后台任务关闭', () => {
  it('shell schema 里没有 run_in_background —— ACP 下自发回合无处归属', async () => {
    const ctx = await composed()
    const params = ctx.tools.get(NATIVE_SHELL_TOOL)?.parameters as { properties?: Record<string, unknown> }
    // 关掉不只是「不用」：留着 schema 而在执行时拒绝，模型会反复尝试并把
    // 失败当成自己参数写错。
    expect(Object.keys(params.properties ?? {})).not.toContain('run_in_background')
  }, 30_000)
})

describe('TC-COMP-06 stderr 日志放到 warn', () => {
  /** 装上生产侧的 exporter，收集它写往 stderr 的内容。 */
  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stderr.write
    return { lines, restore: () => void (process.stderr.write = original) }
  }

  it('warn 真的写得出去 —— 装了 exporter 不等于放行了等级', () => {
    // 这条守的是一个**曾经就是这样错着的**配置：cordis 的等级是 error=0 /
    // info=1 / warn=2 / debug=3，exporter 不写 `levels` 时生效等级是 1，于是
    // 所有 `warn` 被静默丢弃。而 bridge 里「通知失败」「审批因断连被拒」
    // 「呈现器抛错」这些**只**报 warn——真实二进制里一条都不会出现，且看起来
    // 像是日志已经接好了。
    const ctx = new Context()
    installStderrLog(ctx)
    const cap = captureStderr()
    try {
      ctx.logger.warn('探针：warn 必须可见')
      ctx.logger.error('探针：error 必须可见')
      ctx.logger.debug('探针：debug 不该出现')
    } finally {
      cap.restore()
    }
    const all = cap.lines.join('')
    expect(all, 'warn 被等级过滤掉了：exporter 需要 levels: { default: 2 }').toContain('探针：warn 必须可见')
    expect(all).toContain('探针：error 必须可见')
    // debug 留在默认关闭：它是排查时才开的，默认吐出来会淹掉真正的线索。
    expect(all).not.toContain('探针：debug 不该出现')
  })

  it('printf 占位符被展开，Error 带着堆栈 —— 上游的告警几乎都是这种写法', () => {
    // 0.9.0 的 exporter 把参数原样拼起来：`warn('watcher error on %s', path)` 印成
    // 「watcher error on %s /path」，`Error` 经 JSON.stringify 只剩 `{}`。
    const ctx = new Context()
    installStderrLog(ctx)
    const cap = captureStderr()
    try {
      ctx.logger.warn('探针：%s 在 %d 行', 'a.ts', 42)
      ctx.logger.warn(new Error('探针：带堆栈的错误'))
    } finally {
      cap.restore()
    }
    const all = cap.lines.join('')
    expect(all).toContain('探针：a.ts 在 42 行')
    expect(all).not.toContain('%s')
    expect(all).toContain('探针：带堆栈的错误')
    expect(all).toMatch(/\n\s+at /)
  })
})
