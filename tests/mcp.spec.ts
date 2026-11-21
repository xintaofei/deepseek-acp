/**
 * TC-MCP-* —— 按会话挂载 MCP（US-20）。
 *
 * 这是本项目相对官方老 bridge 的主要差异化点，也是 codeg 用户此前必须关掉
 * 「MCP 支持」才能连上的原因。
 *
 * 前四条走真实的 stdio MCP 子进程（`fixtures/mock-mcp-server.mjs`，四十行裸
 * JSON-RPC，无 SDK 依赖）；命名算法那组是纯函数。
 */

import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { McpServer } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { publicServerName, toolNamePrefix, SERVER_NAME_MAX } from '../src/mcp/naming.js'
import { UnsupportedMcpServer, toMountSpec } from '../src/mcp/spec.js'
import { createInProcessPort } from '../src/port/in-process.js'
import { FAKE_MODEL, FAKE_PROVIDER } from './fake-llm.js'
import { createHarness, waitFor } from './harness.js'

const SERVER = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url))

/**
 * 平台定时器能表达的最大延时（2^31-1）。这里写字面量而非 import
 * `MAX_TIMER_DELAY_MS`：用例要独立于实现证明「给的就是上限」，引用同一个
 * 常量就变成常量与自己相等，一点没测。
 */
const TIMER_CEILING_MS = 2_147_483_647

/** 一条 stdio server 声明。 */
const stdio = (name: string, toolName: string, fail = false): McpServer => ({
  name,
  command: process.execPath,
  args: [SERVER],
  env: [
    { name: 'MCP_TOOL_NAME', value: toolName },
    ...(fail ? [{ name: 'MCP_FAIL', value: '1' }] : []),
  ],
})

/** 某 scope 可见的 MCP 工具名。 */
function mcpTools(h: Awaited<ReturnType<typeof createHarness>>, sessionId: string): string[] {
  const agent = h.ctx.agents.get(sessionId as never)
  return h.ctx.tools
    .schemas(agent as never)
    .map((s) => s.name)
    .filter((n) => n.startsWith('mcp__'))
    .sort()
}

describe('TC-MCP-01 按会话挂载后工具仅对本会话可见', () => {
  it('会话作用域可见，全局目录不含', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', {
      cwd: tmpdir(),
      mcpServers: [stdio('github', 'create_issue')],
    })

    // 前缀是 a1_（连接内第一个会话）
    expect(mcpTools(h, String(sessionId))).toEqual(['mcp__a1_github__create_issue'])
    // 全局目录不含 —— 泄漏到全局意味着别的会话也能看到别人的 server
    expect(h.ctx.tools.schemas().map((s) => s.name).filter((n) => n.startsWith('mcp__'))).toEqual([])
    h.disposeBridge()
  }, 30_000)

  it('session/new 返回时工具已就绪，无需轮询', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', {
      cwd: tmpdir(),
      mcpServers: [stdio('alpha', 'ping_alpha')],
    })
    // 不 await 任何东西，紧接着查 —— 工厂 await 整个 setup，
    // 而 `agentCtx.plugin()` 返回 thenable 的 Fiber（Spike 2 A6）
    expect(mcpTools(h, String(sessionId))).toContain('mcp__a1_alpha__ping_alpha')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MCP-02/03 会话隔离与同名 server', () => {
  it('两会话配**同名** server 均创建成功且互不可见', async () => {
    const h = await createHarness()
    const a = await h.acp.request('session/new', {
      cwd: tmpdir(),
      mcpServers: [stdio('github', 'tool_a')],
    })
    // 未加前缀时这一句会失败：`serverName "github" is already in use by
    // another mcp-client instance`。这是方案 A 存在的唯一理由。
    const b = await h.acp.request('session/new', {
      cwd: tmpdir(),
      mcpServers: [stdio('github', 'tool_b')],
    })

    expect(mcpTools(h, String(a.sessionId))).toEqual(['mcp__a1_github__tool_a'])
    expect(mcpTools(h, String(b.sessionId))).toEqual(['mcp__a2_github__tool_b'])
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MCP-08 MCP 工具可被调用，并呈现为标准工具卡片', () => {
  it('模型调用 MCP 工具 → 真实子进程执行 → tool_call / tool_call_update', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', {
      cwd: tmpdir(),
      mcpServers: [stdio('alpha', 'echo_tool')],
    })

    const raw: Record<string, unknown>[] = []
    h.onUpdate((u) => raw.push(u as Record<string, unknown>))

    h.llm.toolCall = {
      id: 'm-1',
      name: 'mcp__a1_alpha__echo_tool',
      args: JSON.stringify({ msg: 'hi-from-mcp' }),
    }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '用一下那个工具' }],
    })
    await waitFor(() => raw.some((u) => u['sessionUpdate'] === 'tool_call_update'), 20_000, 'mcp result card')

    // MCP 工具没有 `presentCall`，所以走通用卡片、标题即工具名 —— bridge 不按
    // 名字嗅探，对 MCP 工具与本地工具一视同仁。
    expect(raw.find((u) => u['sessionUpdate'] === 'tool_call')).toMatchObject({
      toolCallId: 'm-1',
      title: 'mcp__a1_alpha__echo_tool',
    })
    // 结果确实来自那个子进程（夹具回 `<tool>:<msg>`）
    const done = raw.find((u) => u['sessionUpdate'] === 'tool_call_update')
    const text = JSON.stringify(done?.['content'] ?? '')
    expect(text).toContain('echo_tool:hi-from-mcp')
    expect(done?.['status']).toBe('completed')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MCP-05 启动失败使 session/new 显式失败', () => {
  it('server 起不来时整个 session/new 失败，而不是给一个静默缺工具的会话', async () => {
    const h = await createHarness()
    await expect(
      h.acp.request('session/new', {
        cwd: tmpdir(),
        mcpServers: [stdio('broken', 'never', true)],
      }),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MCP-06 会话释放回收 MCP，不影响其它会话', () => {
  it('释放 A 后其工具消失，B 完好', async () => {
    // 走 port 而非 ACP：`session/new` 把释放句柄留在 bridge 的会话表里，客户端
    // 侧没有「只释放某个会话」的入口（`session/close` 尚未实现）。这里要断言的
    // 正是**单个会话**的释放语义，所以直接拿句柄。
    const h = await createHarness()
    const port = createInProcessPort(h.ctx)
    const mk = async (id: string, name: string, tool: string) =>
      await port.sessions.create({
        sessionId: SessionId(id),
        cwd: tmpdir(),
        provider: FAKE_PROVIDER,
        model: FAKE_MODEL,
        mcpServers: [toMountSpec(stdio(name, tool), id === 'mcp-a' ? 1 : 2)],
      })

    const a = await mk('mcp-a', 'alpha', 'tool_a')
    const b = await mk('mcp-b', 'beta', 'tool_b')
    const tools = (scope: object) =>
      h.ctx.tools.schemas(scope as never).map((s) => s.name).filter((n) => n.startsWith('mcp__')).sort()

    expect(tools(a.agent)).toEqual(['mcp__a1_alpha__tool_a'])
    expect(tools(b.agent)).toEqual(['mcp__a2_beta__tool_b'])

    await a.dispose()
    // A 的工具随作用域一起 unwind；B 不受影响
    expect(tools(a.agent)).toEqual([])
    expect(tools(b.agent)).toEqual(['mcp__a2_beta__tool_b'])

    await b.dispose()
    h.disposeBridge()
  }, 30_000)

  it('同一 server 名释放后可被新会话重新占用', async () => {
    // MCP 的 serverName 是进程内全局唯一的。释放没有真的回收掉那个注册，
    // 下一个用同一序号的会话就会以「已被占用」失败 —— 前缀方案也救不了，
    // 因为前缀只在**并存**的会话之间隔离。
    const h = await createHarness()
    const port = createInProcessPort(h.ctx)
    const mk = async (id: string) =>
      await port.sessions.create({
        sessionId: SessionId(id),
        cwd: tmpdir(),
        provider: FAKE_PROVIDER,
        model: FAKE_MODEL,
        mcpServers: [toMountSpec(stdio('github', 'tool_x'), 1)],
      })

    const first = await mk('mcp-reuse-1')
    await first.dispose()
    const second = await mk('mcp-reuse-2')
    expect(
      h.ctx.tools.schemas(second.agent as never).map((s) => s.name).filter((n) => n.startsWith('mcp__')),
    ).toEqual(['mcp__a1_github__tool_x'])
    await second.dispose()
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MCP-04 命名算法', () => {
  it('短名直接加前缀，模型看到干净的名字', () => {
    expect(publicServerName(1, 'github')).toBe('a1_github')
    expect(toolNamePrefix(publicServerName(1, 'github'))).toBe('mcp__a1_github__')
  })

  it('结果恒不超过 32 —— 33 字符上游即拒绝', () => {
    for (const len of [27, 28, 29, 40, 200]) {
      for (const seq of [1, 9, 10, 999, 100000]) {
        const name = publicServerName(seq, 'x'.repeat(len))
        expect(name.length, `seq=${seq} len=${len}`).toBeLessThanOrEqual(SERVER_NAME_MAX)
        expect(name.length).toBeGreaterThan(0)
      }
    }
  })

  it('结果恒满足上游字符集 [A-Za-z0-9_-]', () => {
    for (const raw of ['github', 'my server', 'a.b', '中文名', '@scope/pkg', '', 'x'.repeat(50)]) {
      expect(publicServerName(3, raw), raw).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    }
  })

  it('确定性：同输入恒同输出', () => {
    const long = 'x'.repeat(40)
    expect(publicServerName(2, long)).toBe(publicServerName(2, long))
  })

  it('仅在被截断部分不同的两个名字不产出相同结果', () => {
    const a = `${'x'.repeat(40)}alpha`
    const b = `${'x'.repeat(40)}beta`
    expect(publicServerName(1, a)).not.toBe(publicServerName(1, b))
  })

  it('规整会撞名的两个名字也不产出相同结果', () => {
    // `a.b` 与 `a b` 都会被规整成 `a_b`。只按详设原文「超长才加哈希」处理，
    // 同一会话内第二个 server 就会以「serverName 已被占用」失败 —— 正是 C4
    // 要解决的冲突换个地方重现。
    expect(publicServerName(1, 'a.b')).not.toBe(publicServerName(1, 'a b'))
  })

  it('不同会话序号产出不同前缀', () => {
    expect(publicServerName(1, 'github')).not.toBe(publicServerName(2, 'github'))
  })
})

describe('TC-MCP-07 不支持的传输显式拒绝', () => {
  it('http 翻译为 streamable-http', () => {
    const spec = toMountSpec(
      { type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [{ name: 'X-Key', value: 'v' }] },
      1,
    )
    expect(spec).toEqual({
      transport: 'streamable-http',
      serverName: 'a1_remote',
      url: 'https://example.com/mcp',
      headers: { 'X-Key': 'v' },
      toolCallTimeoutMs: TIMER_CEILING_MS,
      failOnStartupError: true,
    })
  })

  it('两种传输都显式给出 toolCallTimeoutMs，值为定时器上限', () => {
    // 漏掉这个字段不报错，只会静默退回 `dsh-mcp-client` 的 60 s 默认值，于是
    // 一等人作答的 MCP 工具（codeg 的 `ask_user_question`、`wait_ms: 0` 的
    // `get_delegation_status`）必然以 `Request timed out` 失败——卡片还开着，
    // 模型已经收到超时，两边各看到一半真相。
    //
    // 断言写死 2^31-1 而不是 import 同一个常量：比常量与自己相等，等于没测。
    // 这里要钉住的是「必须是定时器上限」这件事——写 60_000 是本缺陷，写
    // 2^31 会溢出成 1 ms 并在每次调用上立刻超时，两种错法都该变红。
    const cases = [
      toMountSpec({ name: 'alpha', command: process.execPath, args: [], env: [] }, 1),
      toMountSpec({ type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [] }, 1),
    ]
    for (const spec of cases) expect(spec.toolCallTimeoutMs).toBe(TIMER_CEILING_MS)
    // 两种传输是两条独立分支，漏一条就是漏一半客户端。
    expect(cases.map((spec) => spec.transport)).toEqual(['stdio', 'streamable-http'])
  })

  it('sse 与 acp 抛 UnsupportedMcpServer —— 静默跳过会让模型看不见工具且难查', () => {
    for (const server of [
      { type: 'sse' as const, name: 's', url: 'https://x/y', headers: [] },
      { type: 'acp' as const, name: 'a', serverId: 'id-1' as never },
    ]) {
      expect(() => toMountSpec(server, 1)).toThrow(UnsupportedMcpServer)
    }
  })

  it('失败信息说明本 agent 支持什么，客户端才知道怎么改', () => {
    expect(() => toMountSpec({ type: 'sse', name: 's', url: 'https://x/y', headers: [] }, 1)).toThrow(
      /stdio and http/,
    )
  })
})
