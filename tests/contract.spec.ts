/**
 * TC-CONTRACT-* —— 对上游 dsh 的契约断言。
 *
 * 这些用例守护的是**上游漂移**（风险 R1）。它们锁定的行为都不显然，且
 * 违反时不会报错，只会静默失效——没有测试就无从发现。
 */

import { tmpdir } from 'node:os'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionService from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { waitFor } from './harness.js'

async function bootDsh(): Promise<Context> {
  const ctx = new Context()
  // `SessionProjections` 是 `AgentLoop` 的注入项（回合边界投影归它注册）：缺席时
  // loop 不启动、也不报错，直到第一次建 agent 才以「no agent factory registered」失败。
  for (const p of [
    SystemPrompt,
    SessionService,
    LlmService,
    ToolRegistry,
    SessionProjections,
    AgentRegistry,
    AgentLoop,
  ]) {
    await ctx.plugin(p, {})
  }
  await waitFor(() => ctx.agents !== undefined && ctx.tools !== undefined, 5_000, 'dsh services')
  return ctx
}

const probeTool = (name: string) =>
  defineTool({
    name,
    description: 'contract probe',
    parameters: { msg: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      return 'ok'
    },
  })

describe('TC-CONTRACT-01 ScopeKey 是 handle.agent 而非句柄本身', () => {
  it('用 handle.agent 查询可见作用域工具；用句柄查询静默返回空集', async () => {
    const ctx = await bootDsh()
    let scopeKey: object | undefined

    const handle = await ctx.agents.create({
      sessionId: 'contract-scope' as never,
      meta: { cwd: tmpdir() },
      setup: (agentCtx: Context) => {
        agentCtx.tools.register(probeTool('scoped_probe'))
        scopeKey = scopeOf(agentCtx)
      },
    })

    const names = (scope?: object) => ctx.tools.schemas(scope as never).map((s) => s.name)

    // 正确用法
    expect(names(handle.agent)).toContain('scoped_probe')
    // 误用：不抛错，静默返回空集——这正是它危险的地方
    expect(names(handle as unknown as object)).not.toContain('scoped_probe')
    // 未泄漏到全局
    expect(names()).not.toContain('scoped_probe')
    // 上游语义锚点
    expect(scopeKey).toBe(handle.agent)

    await handle.dispose()
  })
})

describe('TC-CONTRACT-02 setup 返回值契约', () => {
  it('setup 返回插件 fork 会让 create 失败（必须 await 后返回 void）', async () => {
    const ctx = await bootDsh()
    const child = {
      name: 'contract-child',
      inject: ['tools'],
      apply(pluginCtx: Context) {
        pluginCtx.tools.register(probeTool('child_probe'))
      },
    }

    // 工厂会对 setup 的返回值调用 .commit()；返回 Fiber 即崩溃。
    await expect(
      ctx.agents.create({
        sessionId: 'contract-setup-bad' as never,
        meta: { cwd: tmpdir() },
        setup: (agentCtx: Context) => agentCtx.plugin(child, {} as never) as never,
      }),
    ).rejects.toThrow(/commit/i)

    // 正确写法
    const ok = await ctx.agents.create({
      sessionId: 'contract-setup-good' as never,
      meta: { cwd: tmpdir() },
      setup: async (agentCtx: Context) => {
        await agentCtx.plugin(child, {} as never)
      },
    })
    expect(ctx.tools.schemas(ok.agent as never).map((s) => s.name)).toContain('child_probe')
    await ok.dispose()
  })
})

describe('TC-CONTRACT-03 依赖版本线一致性', () => {
  it('全部 dsh 依赖锁定同一精确版本，不出现 latest/^/*', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const entries = Object.entries({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
    }).filter(([n]) => n.startsWith('@deepseek-ai/dsh-'))

    expect(entries.length).toBeGreaterThan(0)
    const versions = new Set<string>()
    for (const [dep, range] of entries) {
      // 上游各包的 latest dist-tag 指向不同版本线，range 会解析出不兼容的 peer
      expect(range, dep).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
      versions.add(range)
    }
    expect([...versions], '全部 dsh 包必须同一版本').toHaveLength(1)
  })
})

describe('TC-CONTRACT-05 src/ 的每个外部 import 都已声明为运行时依赖', () => {
  /**
   * **这条守的是一个只在别人机器上出现的故障。**
   *
   * `src/` 里 import 一个只写在 `devDependencies` 里的包，在本仓库永远是好的：
   * `node_modules` 里装着全部依赖。但发到 npm 之后，用户 `npm i -g deepseek-acp`
   * 拿到的是 `dependencies` + `peerDependencies`，`devDependencies` 一个都不装——
   * 于是 `deepseek-acp --version` 第一句就 `ERR_MODULE_NOT_FOUND`。
   *
   * 而且它在本地**完全测不出来**：全部 286 个用例都绿，`npm pack` 也不报错，
   * 因为打包只看 `files`，从不检查 import 图。首发时这里同时漏了 5 个包
   * （`dsh-agent-loop` / `dsh-system-prompt` / `dsh-tools` / `dsh-user-approval`
   * / `dsh-scope`），它们碰巧作为传递依赖被 npm 提升到了顶层，所以连
   * 「本地跑一下装好的 tarball」都未必能抓到——换个包管理器（pnpm 严格布局）
   * 才会炸。
   *
   * 类型导入同样算：`.d.ts` 随包分发，消费者的 tsc 解析不到就报错。
   */

  /** 收集 `from '...'`、裸 `import '...'`、动态 `import('...')` 三种形态。 */
  const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm

  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return tsFilesUnder(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })
  }

  /** `@scope/name/deep` → `@scope/name`；`name/deep` → `name`。 */
  function packageOf(specifier: string): string {
    const parts = specifier.split('/')
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string)
  }

  it('没有任何 src/ 的 import 只落在 devDependencies 上', () => {
    const root = new URL('../', import.meta.url)
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const shipped = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])

    const imported = new Map<string, string[]>()
    for (const file of tsFilesUnder(fileURLToPath(new URL('src', root)))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('node:')) continue
        const name = packageOf(specifier)
        imported.set(name, [...(imported.get(name) ?? []), file])
      }
    }

    // 扫描器自检：它曾经因为正则没覆盖多行 import 而**什么都没扫到**，那种
    // 情况下下面的断言恒真。先钉住「确实扫出了东西，且包含一个已知的包」。
    expect(imported.size).toBeGreaterThan(20)
    expect([...imported.keys()]).toContain('@agentclientprotocol/sdk')

    const undeclared = [...imported].filter(([name]) => !shipped.has(name))
    expect(
      undeclared.map(([name, files]) => `${name}（${files.join(', ')}）`),
      '这些包被 src/ 直接 import，但不在 dependencies / peerDependencies 里',
    ).toEqual([])
  })
})

describe('TC-CONTRACT-04 注入服务的签名断言', () => {
  it('本 bridge 依赖的服务方法均存在', async () => {
    const ctx = await bootDsh()
    expect(typeof ctx.agents.create).toBe('function')
    expect(typeof ctx.agents.get).toBe('function')

    const handle = await ctx.agents.create({
      sessionId: 'contract-api' as never,
      meta: { cwd: tmpdir() },
    })
    const agent = handle.agent
    // 驱动一个 agent 所需的全部方法
    expect(typeof agent.followup).toBe('function')
    expect(typeof agent.cancel).toBe('function')
    expect(typeof agent.whenIdle).toBe('function')
    // Agent.id 就是 SessionId（同一身份），port 的存活校验依赖这一点
    expect(agent.id).toBe(agent.session.id)
    expect(ctx.agents.get(agent.id)).toBe(agent)

    await handle.dispose()
  })
})
