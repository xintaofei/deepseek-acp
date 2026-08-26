/**
 * TC-MISSING-* —— 「会话不在了」与「agent 坏了」的分诊。
 *
 * `session/load` / `session/resume` / `session/fork` 三条恢复路径，失败原因五花
 * 八门，而其中最常见的那个（用户把会话删了、工作区状态里存着陈旧 id）是唯一一个
 * **客户端能自己处理**的。上游把它们一并抛成裸 `Error`，落到线上就全是
 * `-32603 Internal error`——编辑器只能对着一条自己删掉的会话弹故障框。
 *
 * 这套用例钉两件事，缺一不可：
 *  1. 不存在的会话报 `-32002 Resource not found`，且 `data.uri` 指名是哪一条；
 *  2. **其余失败一律不动**。只做到第一条的实现（把所有恢复失败都改判成 not
 *     found）比原状更坏：一次真正的故障会被客户端安静地当成「会话没了」摘掉，
 *     用户则以为自己的历史被删了。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RequestError } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { Bridge } from '../src/bridge.js'
import type { SessionCatalog } from '../src/port/types.js'
import { rethrowMissingSession } from '../src/protocol/session-missing.js'
import { createHarness, waitFor } from './harness.js'
import { realTempDir } from './temp-dir.js'

function findSessionLog(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === 'session.jsonl') return path
    if (entry.isDirectory()) {
      const nested = findSessionLog(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** 一个格式合法、但从未存在过的会话 id。 */
const GHOST = SessionId('00000000-0000-4000-8000-000000000000')

/** JSON-RPC 错误的可断言形状。 */
interface WireFailure {
  code?: number
  message: string
  data?: unknown
}

/**
 * 跑一次必定失败的操作，把错误交出来。
 *
 * 不用 `rejects.toThrow`：那个只看消息，而这套用例的全部意义在**错误码**。
 */
async function failure(op: () => Promise<unknown>): Promise<WireFailure> {
  try {
    await op()
  } catch (error: unknown) {
    return error as WireFailure
  }
  throw new Error('这次调用本该失败')
}

/**
 * 假 bridge —— 分诊函数就读 `port.catalog` 与 `port.sessions.hasLive` 这两处。
 * @param catalog - 落盘物件的探测；`undefined` 表示组合没挂持久化
 * @param live - 这个 id 此刻是不是开着的（缺省为否）
 */
function bridgeWith(catalog: Partial<SessionCatalog> | undefined, live = false): Bridge {
  return { port: { catalog, sessions: { hasLive: () => live } } } as never
}

describe('TC-MISSING-01 分诊本身', () => {
  it('确认没有物件 → 改判成 -32002，并指名是哪一条会话', async () => {
    const fail = await failure(async () =>
      rethrowMissingSession(
        bridgeWith({ presence: async () => 'absent' }),
        GHOST,
        new Error('session not found'),
      ),
    )
    expect(fail.code).toBe(-32002)
    // 客户端据 `data.uri` 定位要从列表里摘掉哪一条，不必去解析消息文本。
    expect(fail.data).toEqual({ uri: GHOST })
  })

  it.each([['present'], ['unknown']] as const)(
    '探测结果是 %s → 原错误原样抛回，一个字都不改',
    async (presence) => {
      // 这条才是这套用例的重点。物件在却读不出来（损坏、版本不认识、盘坏了）
      // 是**真的**内部故障；查不出来则是我们这边没本事回答。两种都报成 not
      // found，客户端会把一条还在的会话摘掉，用户则以为历史被删了。
      const boom = new Error('malformed event at seq 42')
      const fail = await failure(async () =>
        rethrowMissingSession(bridgeWith({ presence: async () => presence }), GHOST, boom),
      )
      expect(fail).toBe(boom)
    },
  )

  it('会话开着 → 磁盘上有没有都不问，直接抛原错误', async () => {
    // 活着的会话未必在盘上：写入按窗口批量合并，一条一个事件都还没有的会话
    // 更是根本没有物件。只问磁盘，会把它判成不存在。
    let probed = 0
    const boom = new Error('mcp server failed to start')
    const fail = await failure(async () =>
      rethrowMissingSession(
        bridgeWith(
          {
            presence: async () => {
              probed += 1
              return 'absent'
            },
          },
          true,
        ),
        GHOST,
        boom,
      ),
    )
    expect(fail).toBe(boom)
    expect(probed, '会话开着就不该再去问磁盘').toBe(0)
  })

  it('已经是协议错误就直接放行，连查都不查', async () => {
    // cwd 不符、连接已关这类错误是本层自己造的，码早就选好了。多查一次不只是
    // 浪费——探测失败还会把一个本来清楚的错误搅浑。
    let probed = 0
    const mismatch = RequestError.invalidParams(undefined, 'cwd mismatch')
    const fail = await failure(async () =>
      rethrowMissingSession(
        bridgeWith({
          presence: async () => {
            probed += 1
            return 'absent'
          },
        }),
        GHOST,
        mismatch,
      ),
    )
    expect(fail).toBe(mismatch)
    expect(probed, '协议错误不该触发探测').toBe(0)
  })

  it('探测自己抛错 → 抛原错误', async () => {
    // 读不出来就宣布会话不存在，是拿我们这边的故障去指认用户的数据没了。
    const boom = new Error('EIO')
    const fail = await failure(async () =>
      rethrowMissingSession(
        bridgeWith({
          presence: async () => {
            throw new Error('目录读不了')
          },
        }),
        GHOST,
        boom,
      ),
    )
    expect(fail).toBe(boom)
  })

  it('没挂持久化 → 无从查证，抛原错误', async () => {
    const boom = new Error('nope')
    expect(await failure(async () => rethrowMissingSession(bridgeWith(undefined), GHOST, boom))).toBe(boom)
  })
})

describe('TC-MISSING-02 三条恢复路径的线上错误码', () => {
  it.each([['session/load'], ['session/resume'], ['session/fork']])(
    '%s 未知会话 → -32002 而不是 -32603',
    async (method) => {
      const h = await createHarness({ sessionsRoot: realTempDir('dsacp-missing-') })
      const fail = await failure(async () =>
        h.acp.request(method as never, {
          sessionId: GHOST,
          cwd: realTempDir('dsacp-ws-'),
          mcpServers: [],
        } as never),
      )
      // `-32603` 说的是「agent 坏了」，客户端唯一能做的是把错误摊给用户看；
      // `-32002` 说的是「那条会话没了」，客户端可以自己把它摘掉。
      expect(fail.code, `${method} 的错误码`).toBe(-32002)
      expect(fail.data).toEqual({ uri: GHOST })
      // 拒绝之后不得留下已发布的 agent。这里数**总数**而不是问 `hasAgent(GHOST)`：
      // fork 的子会话 id 是本端现铸的随机值，请求失败时调用方根本不知道它是什么，
      // 按 id 去问等于什么都没问。
      expect(h.ctx.agents.list(), `${method} 失败后不该留下 agent`).toEqual([])
      h.disposeBridge()
    },
    30_000,
  )

  // 「没挂持久化时 fork 一条没打开的会话」同样报 -32002，那条在 session-fork.spec
  // 里——它首先是 fork 的语义（种子无从取起就该拒绝），错误码只是顺带。
})

describe('TC-MISSING-03 别的失败不受影响', () => {
  /** 在一个独立 harness 里聊一轮并彻底落盘，返回会话 id。 */
  async function record(root: string, cwd: string): Promise<string> {
    const h = await createHarness({ sessionsRoot: root })
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '你好' }],
    })
    // 录制端必须先彻底停：恢复端会成为同一个日志文件的第二个写入方。
    h.disposeBridge()
    await waitFor(() => !h.hasAgent(String(sessionId)), 5_000, 'agent teardown')
    await h.retire()
    return String(sessionId)
  }

  it('resume 的 cwd 不符仍是 -32602 —— 新加的 catch 不能把协议错误吞掉', async () => {
    // `restoreSession` 的 cwd 校验落在新加的 `.catch()` 里面，所以这条路径是
    // 「协议错误直接放行」那个分支在真实调用栈上的验证。
    const root = realTempDir('dsacp-missing-')
    const cwd = realTempDir('dsacp-ws-')
    const other = realTempDir('dsacp-other-')
    const sessionId = await record(root, cwd)

    const h = await createHarness({ sessionsRoot: root })
    const fail = await failure(async () =>
      h.acp.request('session/resume', { sessionId: sessionId as never, cwd: other }),
    )
    expect(fail.code).toBe(-32602)
    expect(fail.message).toMatch(/cwd mismatch/)
    expect(h.hasAgent(sessionId)).toBe(false)
    h.disposeBridge()
  }, 30_000)

  it('头部损坏的日志仍报 -32603 —— 不能把「坏了」说成「没了」', async () => {
    // 这条守的是整套分诊的底线，而且它**抓到过一个真的实现错误**：最初的探测
    // 拿 `persistence.list()` 当判据，而 JSONL 后端在列举时会静默跳过解析不了
    // 的头部（`listArtifacts` 里的 `continue`）。于是一条头部损坏的会话在清单
    // 里根本不出现，被判成「不存在」，客户端会安静地把它从列表里摘掉——用户
    // 那份还躺在磁盘上、原本可以抢救的历史，就这样被宣告删除了。
    //
    // 换成 `readRaw` 之后才分得开：物件不在返回 `undefined`，物件在但读不出来
    // 是**抛错**。
    const root = realTempDir('dsacp-missing-')
    const cwd = realTempDir('dsacp-ws-')
    const sessionId = await record(root, cwd)

    const log = findSessionLog(root)
    expect(log, '录出来的日志应当能找到').toBeDefined()
    if (log === undefined) throw new Error('录出来的日志未找到')
    const lines = readFileSync(log, 'utf8').split('\n')
    // 只弄坏头部行，事件行原样保留：文件确实还在，只是读不出来。
    writeFileSync(log, ['{ 这一行不是 JSON', ...lines.slice(1)].join('\n'))

    const h = await createHarness({ sessionsRoot: root })
    const fail = await failure(async () =>
      h.acp.request('session/load', { sessionId: sessionId as never, cwd, mcpServers: [] }),
    )
    expect(fail.code, '日志损坏是内部故障，不是「会话不存在」').toBe(-32603)
    expect(String(fail.message) + JSON.stringify(fail.data)).toMatch(/corrupt/)
    h.disposeBridge()
  }, 30_000)

  it('fork 一条开着但还没落盘的父会话，子会话装配失败时不能怪到父头上', async () => {
    // 最不好察觉的一种误判。父会话刚建出来、一个事件都还没有，因此**磁盘上没有
    // 它的物件**（上游惰性物化）；此时让子会话的 MCP server 起不来，分诊如果只
    // 问磁盘，就会把「MCP 起不来」报成「父会话不存在」——客户端据此把一条正开着、
    // 用户面前就摆着的会话从列表里摘掉。
    //
    // 会话已经聊过但还在写入缓冲里（写入按窗口批量合并）也是同一回事，只是不好
    // 稳定复现；零事件这种是它可确定化的版本。
    const root = realTempDir('dsacp-missing-')
    const cwd = realTempDir('dsacp-ws-')
    const h = await createHarness({ sessionsRoot: root })
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })

    // 前提自检：父会话确实开着，且确实还没有落盘物件。这两条不成立的话，下面
    // 那个断言就不再是在测它想测的东西了。
    expect(h.hasAgent(String(sessionId)), '父会话应当开着').toBe(true)
    const persistence = h.ctx.get('sessionPersistence')
    expect(await persistence!.readRaw(sessionId as never), '父会话不该已经落盘').toBeUndefined()

    const fail = await failure(async () =>
      h.acp.request('session/fork', {
        sessionId: sessionId as never,
        cwd,
        mcpServers: [
          {
            name: 'broken',
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url))],
            env: [
              { name: 'MCP_TOOL_NAME', value: 'never' },
              { name: 'MCP_FAIL', value: '1' },
            ],
          },
        ],
      }),
    )
    expect(fail.code, 'MCP 起不来是内部故障，与父会话在不在无关').toBe(-32603)
    expect(fail.data).not.toEqual({ uri: sessionId })
    // 父会话必须毫发无损地留在原地。
    expect(h.hasAgent(String(sessionId)), 'fork 失败不该动到父会话').toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('恢复成功时一次都不探测 —— 分诊只在失败之后发生', async () => {
    // 这是个**设计**断言，不是性能断言：把探测挪到操作之前看起来更直白，代价是
    // 给每一次成功的恢复白加一次读盘，换来的还是同一个答案——中间那个 TOCTOU
    // 窗口它也挡不住。
    const root = realTempDir('dsacp-missing-')
    const cwd = realTempDir('dsacp-ws-')
    const sessionId = await record(root, cwd)

    const h = await createHarness({ sessionsRoot: root })
    const persistence = h.ctx.get('sessionPersistence')
    expect(persistence, 'harness 应当挂了持久化').toBeDefined()
    let probed = 0
    const real = persistence!.readRaw.bind(persistence)
    // 在实例上盖一个同名属性，遮蔽原型上的方法。
    Object.defineProperty(persistence, 'readRaw', {
      configurable: true,
      value: async (...args: Parameters<typeof real>) => {
        probed += 1
        return await real(...args)
      },
    })

    await h.acp.request('session/load', { sessionId: sessionId as never, cwd, mcpServers: [] })
    expect(probed, '成功的 session/load 不该探测物件').toBe(0)
    // 证明上面那个 0 不是因为拦截根本没装上——否则这条用例永远绿，包括在一个
    // 真的把探测挪到了前面的实现上。
    await persistence!.readRaw(sessionId as never)
    expect(probed, '拦截器应当是活的').toBe(1)
    h.disposeBridge()
  }, 30_000)
})
