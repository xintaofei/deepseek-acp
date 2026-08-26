/**
 * TC-SKILL-* —— 技能面（US-27）。
 *
 * 分工要先说清楚，否则很容易多测或漏测：**模型侧那半边不是本项目的代码**。
 * `dsh-tool-skill` 自己注册 `skill` 工具、自己在 `agent/pre-step` 注入目录、自己扫
 * `/名字` 手势，本 bridge 一行都没参与。所以这里测的是三件事：
 *
 * 1. 装配起来了，而且模型侧那条链确实活着（TC-SKILL-01）——不验这一条，后面
 *    「没漏出去」的断言就可能只是因为压根没发生。
 * 2. 用户可调用的技能进了 ACP 斜杠目录，且与命令的合并规则正确（02 / 03）。
 * 3. 技能正文与目录**不**漏给客户端，实时与重放都不漏（04）。
 * 4. 没挂技能面时逐字节不变（05）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { toAvailableCommands } from '../src/protocol/session-commands.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

/**
 * 写一个技能。
 * @param root - 技能根目录（`<root>/<name>/SKILL.md`）
 * @param name - kebab-case 技能名
 * @param front - frontmatter 正文（不含 `---` 围栏）
 * @param body - 指令正文
 */
function writeSkill(root: string, name: string, front: string, body: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`)
}

/** 项目级技能根（rank 100），随会话 cwd 走。 */
function projectSkills(cwd: string): string {
  return join(cwd, '.dsh', 'skills')
}

/** 从客户端收到的更新里取最后一份斜杠目录。 */
function lastCatalog(raw: Record<string, unknown>[]): { name: string; description: string }[] | undefined {
  const updates = raw.filter((u) => u['sessionUpdate'] === 'available_commands_update')
  const last = updates[updates.length - 1]
  return last?.['availableCommands'] as { name: string; description: string }[] | undefined
}

/**
 * 建一个挂了技能面的 harness，并订阅原始更新。
 *
 * 用户级技能根指向一个**空的**临时目录：项目级那两个根随会话 cwd 走，是用例
 * 自己写的，于是「目录里应该有哪些技能」完全由用例决定。见 harness 里 `skills`
 * 选项为什么收路径而不是布尔。
 */
async function skillHarness(
  options: { commands?: boolean; sessionsRoot?: string } = {},
): Promise<{ h: TestHarness; raw: Record<string, unknown>[] }> {
  const h = await createHarness({
    fs: true,
    skills: realTempDir('dsacp-skillhome-'),
    ...(options.commands === true ? { commands: true } : {}),
    ...(options.sessionsRoot !== undefined ? { sessionsRoot: options.sessionsRoot } : {}),
  })
  const raw: Record<string, unknown>[] = []
  h.onUpdate((u) => raw.push(u as Record<string, unknown>))
  return { h, raw }
}

/** 目录里技能那一半的名字（命令没有这个前缀）。 */
function skillNames(raw: Record<string, unknown>[]): string[] {
  return (lastCatalog(raw) ?? []).filter((c) => c.description.startsWith('技能：')).map((c) => c.name)
}

describe('TC-SKILL-01 装配', () => {
  it('挂上之后 skill 工具对模型可见 —— 模型侧那条链是活的', async () => {
    const cwd = realTempDir('dsacp-ws-')
    writeSkill(projectSkills(cwd), 'brew-coffee', 'name: brew-coffee\ndescription: 冲咖啡', '烧水')

    const { h } = await skillHarness()
    const names = (h.ctx.tools.schemas() as { name: string }[]).map((t) => t.name)
    expect(names).toContain('skill')
    h.disposeBridge()
  }, 30_000)

  it('用户显式手势真的把技能正文注入了这一回合', async () => {
    // 这条是后面「没漏出去」那些断言的**前提**：注入若没发生，那些 false 就是空的。
    const cwd = realTempDir('dsacp-ws-')
    writeSkill(
      projectSkills(cwd),
      'only-user',
      'name: only-user\ndescription: 只给人用\ndisable-model-invocation: true',
      '独一无二的技能正文标记',
    )

    const root = realTempDir('dsacp-sessions-')
    const { h } = await skillHarness({ sessionsRoot: root })
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
    h.llm.deltas = ['好的']
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '/only-user 帮我看看' }],
    })

    h.disposeBridge()
    await waitFor(() => !h.hasAgent(String(sessionId)), 5_000, 'agent teardown')
    await h.retire()
    const events = await readEvents(root)
    // 注入的那条是 user-role 消息，source kind 由 dsh-skill 声明
    expect(events).toContain('skill-invocation')
    expect(events).toContain('独一无二的技能正文标记')
  }, 30_000)
})

describe('TC-SKILL-02 斜杠目录合并', () => {
  it('技能进目录：带「技能：」前缀与自由文本 hint', () => {
    expect(toAvailableCommands([], [{ name: 'brew-coffee', description: '冲咖啡' }])).toEqual([
      { name: 'brew-coffee', description: '技能：冲咖啡', input: { hint: '补充说明（可选）' } },
    ])
  })

  it('命令赢重名，技能整条丢掉 —— 两个都登记等于给一个点了不生效的条目', () => {
    const merged = toAvailableCommands(
      [{ name: 'plan', description: '切换计划模式', hint: undefined }],
      [
        { name: 'plan', description: '一个碰巧同名的技能' },
        { name: 'brew-coffee', description: '冲咖啡' },
      ],
    )
    expect(merged.map((c) => c.name)).toEqual(['plan', 'brew-coffee'])
    // 赢的那条必须是**命令**的描述，不能是技能的
    expect(merged[0]?.description).toBe('切换计划模式')
  })

  it('没有技能时输出与技能面存在之前逐字节相同', () => {
    const commands = [
      { name: 'plan', description: '切换计划模式', hint: undefined },
      { name: 'echo', description: '回显', hint: '要回显的文本' },
    ]
    // 第二个参数省略与传空数组必须等价 —— 前者是没挂技能面那条路径
    const legacy = [
      { name: 'plan', description: '切换计划模式' },
      { name: 'echo', description: '回显', input: { hint: '要回显的文本' } },
    ]
    expect(toAvailableCommands(commands)).toEqual(legacy)
    expect(toAvailableCommands(commands, [])).toEqual(legacy)
  })

  it('命令保持原序在前，技能跟在后面', () => {
    const merged = toAvailableCommands(
      [
        { name: 'z-command', description: 'Z', hint: undefined },
        { name: 'a-command', description: 'A', hint: undefined },
      ],
      [{ name: 'a-skill', description: 'AS' }],
    )
    expect(merged.map((c) => c.name)).toEqual(['z-command', 'a-command', 'a-skill'])
  })
})

describe('TC-SKILL-03 发现与调用策略', () => {
  it('session/new 的目录里带上项目级技能', async () => {
    const cwd = realTempDir('dsacp-ws-')
    writeSkill(projectSkills(cwd), 'brew-coffee', 'name: brew-coffee\ndescription: 冲咖啡', '烧水')

    const { h, raw } = await skillHarness({ commands: true })
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    await waitFor(() => lastCatalog(raw) !== undefined, 5_000, '斜杠目录')

    expect(lastCatalog(raw)).toContainEqual({
      name: 'brew-coffee',
      description: '技能：冲咖啡',
      input: { hint: '补充说明（可选）' },
    })
    h.disposeBridge()
  }, 30_000)

  it('`user-invocable: false` 的技能不进目录 —— 那是只给模型用的', async () => {
    const cwd = realTempDir('dsacp-ws-')
    const root = projectSkills(cwd)
    writeSkill(root, 'model-only', 'name: model-only\ndescription: 只给模型\nuser-invocable: false', 'X')
    writeSkill(root, 'both-ok', 'name: both-ok\ndescription: 都行', 'Y')

    const { h, raw } = await skillHarness({ commands: true })
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    await waitFor(() => lastCatalog(raw) !== undefined, 5_000, '斜杠目录')

    // **精确相等而非包含**：这条同时把「用户级根确实关在临时目录里」变成承重的
    // 断言。用包含的话，harness 若忘了隔离 `~/.agents/skills`，用例在装了技能的
    // 开发机上照样绿，只在别人的机器上换一副面孔。
    expect(skillNames(raw)).toEqual(['both-ok'])
    h.disposeBridge()
  }, 30_000)

  it('`disable-model-invocation` 的技能**仍在**用户目录里 —— 两个开关是独立的', async () => {
    const cwd = realTempDir('dsacp-ws-')
    writeSkill(
      projectSkills(cwd),
      'only-user',
      'name: only-user\ndescription: 只给人用\ndisable-model-invocation: true',
      'X',
    )

    const { h, raw } = await skillHarness({ commands: true })
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    await waitFor(() => lastCatalog(raw) !== undefined, 5_000, '斜杠目录')

    expect(skillNames(raw)).toEqual(['only-user'])
    h.disposeBridge()
  }, 30_000)

  it('超长描述被截断到 120 码位并折成一行', async () => {
    const cwd = realTempDir('dsacp-ws-')
    // 多行 + 超长：两件事一起验，因为它们是同一个函数的两个分支
    const long = `第一行\n${'很长'.repeat(200)}`
    writeSkill(projectSkills(cwd), 'wordy', `name: wordy\ndescription: |\n  ${long.replace(/\n/g, '\n  ')}`, 'X')

    const { h, raw } = await skillHarness({ commands: true })
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    await waitFor(() => lastCatalog(raw) !== undefined, 5_000, '斜杠目录')

    const entry = (lastCatalog(raw) ?? []).find((c) => c.name === 'wordy')
    expect(entry).toBeDefined()
    const description = entry?.description ?? ''
    expect(description).not.toContain('\n')
    expect(description.endsWith('…')).toBe(true)
    // 前缀不算进上限：上限管的是技能自己的描述
    expect([...description.slice('技能：'.length)].length).toBe(120)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-SKILL-06 发现根的优先级（上游契约）', () => {
  /**
   * 这条守的不是本项目的代码，是**上游的 rank 顺序**：
   * project-dsh 100 < project-agents 200 < user-dsh 400 < user-agents 500，小者赢。
   * 归结成两条正交的规则——**项目级压过全局，专用目录压过共用目录**。
   *
   * 为什么下游要钉上游的常量：它是用户会依赖的行为（「在 `<项目根>/.dsh/skills` 放个
   * 同名的就能覆盖全局技能」），而本项目的 `SkillPlane` 直接把这个顺序透传进斜杠补全。
   * 上游把顺序调一下，我们这边**没有任何用例会红**——目录照样有内容、条数照样对，只是
   * 赢的那条换了个人。与 TC-CONTRACT-\* 同一个理由：上游漂移要有人接着。
   */
  it('四个根都扫，且 project-dsh 赢过其余三个', async () => {
    const home = realTempDir('dsacp-skillhome-')
    const cwd = realTempDir('dsacp-ws-')
    const front = (name: string, description: string): string => `name: ${name}\ndescription: ${description}`

    // 同名塞进四个根
    for (const [root, tag] of [
      [projectSkills(cwd), '项目-dsh'],
      [join(cwd, '.agents', 'skills'), '项目-agents'],
      [join(home, 'dsh-home', 'skills'), '用户-dsh'],
      [join(home, 'agents-home', 'skills'), '用户-agents'],
    ] as const) {
      writeSkill(root, 'clash', front('clash', tag), 'X')
    }
    // 各根再放一个独有的，证明四个根**都**被扫到（否则「project-dsh 赢」可能只是
    // 因为别的根压根没扫）
    writeSkill(projectSkills(cwd), 'only-proj-dsh', front('only-proj-dsh', 'a'), 'X')
    writeSkill(join(cwd, '.agents', 'skills'), 'only-proj-agents', front('only-proj-agents', 'b'), 'X')
    writeSkill(join(home, 'dsh-home', 'skills'), 'only-user-dsh', front('only-user-dsh', 'c'), 'X')
    writeSkill(join(home, 'agents-home', 'skills'), 'only-user-agents', front('only-user-agents', 'd'), 'X')

    const h = await createHarness({ fs: true, skills: home })
    const all = await h.ctx.skills.list({ cwd })
    const by = new Map(all.map((s) => [s.name, s]))

    expect([...by.keys()].sort()).toEqual([
      'clash',
      'only-proj-agents',
      'only-proj-dsh',
      'only-user-agents',
      'only-user-dsh',
    ])
    expect(by.get('clash')?.source).toBe('project-dsh')
    expect(by.get('clash')?.description).toBe('项目-dsh')
    h.disposeBridge()
  }, 30_000)

  it('只有用户级两个根时，专用目录赢共用目录', async () => {
    const home = realTempDir('dsacp-skillhome-')
    writeSkill(join(home, 'dsh-home', 'skills'), 'clash', 'name: clash\ndescription: 用户-dsh', 'X')
    writeSkill(join(home, 'agents-home', 'skills'), 'clash', 'name: clash\ndescription: 用户-agents', 'X')

    const h = await createHarness({ fs: true, skills: home })
    const all = await h.ctx.skills.list({ cwd: realTempDir('dsacp-ws-') })
    expect(all.find((s) => s.name === 'clash')?.source).toBe('user-dsh')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-SKILL-04 技能内容不漏给客户端', () => {
  it('实时流里既没有目录也没有技能正文', async () => {
    const cwd = realTempDir('dsacp-ws-')
    writeSkill(
      projectSkills(cwd),
      'only-user',
      'name: only-user\ndescription: 只给人用\ndisable-model-invocation: true',
      '独一无二的技能正文标记',
    )

    const { h, raw } = await skillHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
    h.llm.deltas = ['好的']
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '/only-user 帮我看看' }],
    })

    const dumped = JSON.stringify(raw)
    expect(dumped).not.toContain('独一无二的技能正文标记')
    expect(dumped).not.toContain('available_skills')
    h.disposeBridge()
  }, 30_000)

  it('重放里同样不漏 —— 恢复出来的转录不该多出一份 CLAUDE.md 式的注入', async () => {
    const cwd = realTempDir('dsacp-ws-')
    const root = realTempDir('dsacp-sessions-')
    writeSkill(
      projectSkills(cwd),
      'only-user',
      'name: only-user\ndescription: 只给人用\ndisable-model-invocation: true',
      '独一无二的技能正文标记',
    )

    const rec = await skillHarness({ sessionsRoot: root })
    const { sessionId } = await rec.h.acp.request('session/new', { cwd, mcpServers: [] })
    rec.h.llm.deltas = ['好的']
    await rec.h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '/only-user 帮我看看' }],
    })
    rec.h.disposeBridge()
    await waitFor(() => !rec.h.hasAgent(String(sessionId)), 5_000, 'agent teardown')
    await rec.h.retire()

    const back = await skillHarness({ sessionsRoot: root })
    await back.h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await back.h.acp.request('session/load', { sessionId: sessionId as never, cwd, mcpServers: [] })

    const dumped = JSON.stringify(back.raw)
    // 用户自己敲的那条要在，注入的两种都不能在
    expect(dumped).toContain('/only-user 帮我看看')
    expect(dumped).not.toContain('独一无二的技能正文标记')
    expect(dumped).not.toContain('available_skills')
    back.h.disposeBridge()
  }, 30_000)
})

describe('TC-SKILL-05 没挂技能面时的降级', () => {
  it('目录里只有命令，且不因技能面缺席而报错', async () => {
    const cwd = realTempDir('dsacp-ws-')
    // 就算目录里躺着技能，没挂 `ctx.skills` 就一个都发现不了
    writeSkill(projectSkills(cwd), 'brew-coffee', 'name: brew-coffee\ndescription: 冲咖啡', '烧水')

    const h = await createHarness({ commands: true, planMode: true })
    const raw: Record<string, unknown>[] = []
    h.onUpdate((u) => raw.push(u as Record<string, unknown>))
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    await waitFor(() => lastCatalog(raw) !== undefined, 5_000, '斜杠目录')

    const catalog = lastCatalog(raw) ?? []
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.every((c) => !c.description.startsWith('技能：'))).toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('两个面都没挂时根本不发这条更新', async () => {
    const cwd = realTempDir('dsacp-ws-')
    const h = await createHarness()
    const raw: Record<string, unknown>[] = []
    h.onUpdate((u) => raw.push(u as Record<string, unknown>))
    await h.acp.request('session/new', { cwd, mcpServers: [] })
    // 目录更新是 `notifyAfterResponse` 推的（一个宏任务之后），给它机会出现
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lastCatalog(raw)).toBeUndefined()
    h.disposeBridge()
  }, 30_000)
})

/** 把 sessions root 下的日志读成一整块文本。 */
async function readEvents(root: string): Promise<string> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(root)
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}
