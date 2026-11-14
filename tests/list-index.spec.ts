/**
 * TC-LIST-* —— `session/list` 的标题索引。
 *
 * 要守住的是两件事：列表**不再逐条读日志**（DSH 0.2 上 v3 旧日志逐条读是 O(N²)，
 * 200 条要将近一分钟），以及**缓存不说谎**——日志变了就重读，读不完的宁可这一次
 * 不给标题，也不给一个过期的。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'
import { sessionListIndexPath } from '../src/launcher/boot.js'
import { SessionListIndex, listKey, type ListedFacts } from '../src/session/list-index.js'
import { createHarness, waitFor } from './harness.js'
import { realTempDir } from './temp-dir.js'

/** 一条快照；v3 用 `formatStatus: 'migration-required'`。 */
function snapshot(
  id: string,
  options: { createdAt?: number; revision?: string; v3?: boolean; sizeBytes?: number } = {},
): SessionPersistenceSnapshot {
  return {
    header: { id: SessionId(id), createdAt: options.createdAt ?? 0 } as never,
    revision: SessionPersistenceRevision(options.revision ?? `rev-${id}`),
    ...(options.v3 === true ? { formatStatus: 'migration-required' as const } : { formatStatus: 'current' as const }),
    ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
  }
}

/** 记下每次冷读的 reader；可选地让某几条慢下来。 */
function reader(slow: ReadonlySet<string> = new Set(), slowMs = 0) {
  const reads: string[] = []
  const read = async (s: SessionPersistenceSnapshot): Promise<ListedFacts> => {
    const id = String(s.header.id)
    reads.push(id)
    if (slow.has(id)) await new Promise((r) => setTimeout(r, slowMs))
    return { title: `title-${id}`, updatedAt: 1000 }
  }
  return { reads, read }
}

async function mountIndex(path: string, budgetMs?: number): Promise<{ ctx: Context; index: SessionListIndex }> {
  const ctx = new Context()
  await ctx.plugin(SessionListIndex, { path, ...(budgetMs === undefined ? {} : { budgetMs }) })
  return { ctx, index: ctx.sessionListIndex }
}

describe('TC-LIST-01 命中不读日志', () => {
  it('第二次列表一条都不读', async () => {
    const { index } = await mountIndex(join(realTempDir('dsacp-idx-'), 'index.json'))
    const r = reader()
    const snaps = [snapshot('a'), snapshot('b')]
    expect(await index.describe(snaps, r.read)).toEqual([
      { title: 'title-a', updatedAt: 1000 },
      { title: 'title-b', updatedAt: 1000 },
    ])
    await index.describe(snaps, r.read)
    expect(r.reads.sort()).toEqual(['a', 'b'])
  })

  it('日志变了（revision 变了）就重读 —— 缓存不能给出过期标题', async () => {
    const { index } = await mountIndex(join(realTempDir('dsacp-idx-'), 'index.json'))
    const r = reader()
    await index.describe([snapshot('a', { revision: 'r1' })], r.read)
    await index.describe([snapshot('a', { revision: 'r2' })], r.read)
    expect(r.reads).toEqual(['a', 'a'])
  })

  it('跨进程复用：新实例读盘上的索引，不再冷读', async () => {
    const path = join(realTempDir('dsacp-idx-'), 'nested', 'index.json')
    const first = await mountIndex(path)
    await first.index.describe([snapshot('a')], reader().read)
    await first.index.flush()
    expect(existsSync(path)).toBe(true)
    const r = reader()
    const second = await mountIndex(path)
    expect(await second.index.describe([snapshot('a')], r.read)).toEqual([{ title: 'title-a', updatedAt: 1000 }])
    expect(r.reads).toEqual([])
  })
})

describe('TC-LIST-02 v3 旧日志按字节数缓存', () => {
  // v3 的 revision 里拼着整个会话根的指纹：任何一条会话写一个字它都会变。
  it('revision 变了、字节数没变 —— 仍然命中', async () => {
    const { index } = await mountIndex(join(realTempDir('dsacp-idx-'), 'index.json'))
    const r = reader()
    await index.describe([snapshot('a', { v3: true, sizeBytes: 10, revision: 'x:corpus1' })], r.read)
    await index.describe([snapshot('a', { v3: true, sizeBytes: 10, revision: 'x:corpus2' })], r.read)
    expect(r.reads).toEqual(['a'])
  })

  it('字节数变了（降级后被追加过）、或已迁成 v4 —— 都重读', async () => {
    expect(listKey(snapshot('a', { v3: true, sizeBytes: 10 }))).not.toBe(listKey(snapshot('a', { v3: true, sizeBytes: 11 })))
    expect(listKey(snapshot('a', { v3: true, sizeBytes: 10 }))).not.toBe(listKey(snapshot('a', { sizeBytes: 10 })))
  })
})

describe('TC-LIST-03 冷读有时间预算', () => {
  it('预算内读不完的先不带标题；后台读完后下一次就有，而且只读一次', async () => {
    const { index } = await mountIndex(join(realTempDir('dsacp-idx-'), 'index.json'), 50)
    const r = reader(new Set(['slow']), 300)
    const snaps = [snapshot('fast'), snapshot('slow')]
    const started = Date.now()
    const first = await index.describe(snaps, r.read)
    expect(Date.now() - started).toBeLessThan(250)
    expect(first[1]).toEqual({ title: undefined, updatedAt: undefined })
    // 预算到了也不中止：后台继续读，读完记进索引。
    await waitFor(() => r.reads.includes('slow') && !index['inflight'].has('slow'), 2_000, 'background read')
    const second = await index.describe(snaps, r.read)
    expect(second[1]).toEqual({ title: 'title-slow', updatedAt: 1000 })
    expect(r.reads.filter((id) => id === 'slow')).toHaveLength(1)
  })

  it('最新的会话最先冷读 —— 列表顶上那几条先拿到标题', async () => {
    const { index } = await mountIndex(join(realTempDir('dsacp-idx-'), 'index.json'))
    const r = reader()
    await index.describe(
      [snapshot('old', { createdAt: 1 }), snapshot('new', { createdAt: 3 }), snapshot('mid', { createdAt: 2 })],
      r.read,
    )
    expect(r.reads).toEqual(['new', 'mid', 'old'])
  })

  it('读失败也记下（不必每次重付）；日志一变照样重读', async () => {
    const { index } = await mountIndex(join(realTempDir('dsacp-idx-'), 'index.json'))
    let calls = 0
    const failing = async (): Promise<ListedFacts> => {
      calls += 1
      throw new Error('corrupt log')
    }
    expect(await index.describe([snapshot('a')], failing)).toEqual([{ title: undefined, updatedAt: undefined }])
    await index.describe([snapshot('a')], failing)
    expect(calls).toBe(1)
    await index.describe([snapshot('a', { revision: 'changed' })], failing)
    expect(calls).toBe(2)
  })
})

describe('TC-LIST-04 写盘', () => {
  it('合并盘上已有的条目，丢掉已不存在的会话', async () => {
    const path = join(realTempDir('dsacp-idx-'), 'index.json')
    const other = await mountIndex(path)
    await other.index.describe([snapshot('from-other'), snapshot('deleted')], reader().read)
    await other.index.flush()
    // 另一个进程（同一会话根）读的是另一批，而 `deleted` 已经不在了。
    const mine = await mountIndex(join(path))
    mine.index['entries'].clear()
    await mine.index.describe([snapshot('from-other'), snapshot('mine')], reader().read)
    await mine.index.flush()
    const entries = Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { entries: object }).entries).sort()
    expect(entries).toEqual(['from-other', 'mine'])
  })

  it('损坏的索引文件当作空索引，不让列表失败', async () => {
    const dir = realTempDir('dsacp-idx-')
    const path = join(dir, 'index.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, '{ not json')
    const { index } = await mountIndex(path)
    expect(await index.describe([snapshot('a')], reader().read)).toEqual([{ title: 'title-a', updatedAt: 1000 }])
  })

  it('索引放在会话根旁边，不放进上游后端管理的会话根里', () => {
    const root = join(realTempDir('dsacp-home-'), 'sessions')
    const path = sessionListIndexPath(root)
    expect(path.startsWith(join(root, '/'))).toBe(false)
    expect(path.startsWith(join(root, '..', 'deepseek-acp'))).toBe(true)
    expect(sessionListIndexPath(`${root}-other`)).not.toBe(path)
  })
})

describe('TC-LIST-05 端到端：真的 JSONL 后端', () => {
  it('第二个进程列表时一条日志都不打开，标题照旧', async () => {
    const root = realTempDir('dsacp-list-root-')
    const indexPath = join(realTempDir('dsacp-list-idx-'), 'index.json')
    const cwd = realTempDir('dsacp-list-ws-')
    const writer = await createHarness({ sessionsRoot: root, title: true, listIndex: indexPath })
    const { sessionId } = await writer.acp.request('session/new', { cwd, mcpServers: [] })
    await writer.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '帮我看看登录模块' }],
    })
    const listed = await writer.acp.request('session/list', {})
    expect(listed.sessions[0]?.title).toBeDefined()
    await writer.ctx.sessionListIndex.flush()
    await writer.retire()

    const reopened = await createHarness({ sessionsRoot: root, title: true, listIndex: indexPath })
    try {
      const persistence = reopened.ctx.sessionPersistence
      let opens = 0
      const open = persistence.open.bind(persistence)
      persistence.open = (async (...args: Parameters<typeof open>) => {
        opens += 1
        return await open(...args)
      }) as typeof persistence.open
      const again = await reopened.acp.request('session/list', {})
      expect(again.sessions.map((s) => s.title)).toEqual(listed.sessions.map((s) => s.title))
      expect(again.sessions[0]?.updatedAt).toBe(listed.sessions[0]?.updatedAt)
      expect(opens).toBe(0)
    } finally {
      await reopened.retire()
    }
  }, 30_000)
})
