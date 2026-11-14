/**
 * `session/list` 的标题索引：让列表不必每次把每条日志都读一遍。
 *
 * ## 为什么需要它
 *
 * 会话头里没有标题，也没有最后活动时间，两者都只能从日志折出来。在 0.1.5 上逐条
 * 读一遍还算便宜（200 条约 0.6 s）。DSH 0.2 起，**v3 旧日志**的每次只读打开都要把
 * 整个会话根的头部扫一遍（`session-persistence-jsonl` 为 v3 → v4 迁移收集子会话，
 * 校验时再扫一遍），逐条读于是变成 O(N²)：同样 200 条要 50–60 s，而且每次都这么
 * 慢——v3 文件只有被写打开过才会迁成 v4。
 *
 * ## 做法
 *
 * 1. **按变更键缓存**每条会话折出来的标题与最后活动时间，落在适配器自己的目录里，
 *    跨进程复用。命中就不读日志。
 * 2. **未命中的冷读有时间预算**：预算内读完的当场返回；没读完的这一次先不带标题
 *    （客户端退回显示 id，按创建时间排序），在后台读完、写进索引，下一次列表就有了。
 *    这样升级后的第一次列表也是秒级，而不是让编辑器干等一分钟、甚至先超时。
 * 3. 冷读**最新的优先**：列表顶上的那几条最先拿到标题。
 *
 * ## 变更键为什么不直接用 `revision`
 *
 * 上游 `revision` 对 v4 是文件的 stat 指纹（dev/ino/size/mtime/ctime），跨进程稳定，
 * 直接用。对 v3 它还拼了一段**整个会话根**所有日志文件的指纹哈希——任何一条会话
 * 写了一个字，所有 v3 会话的 revision 都会变，按它缓存等于每聊一句就让 v3 的缓存
 * 全部失效，而 v3 恰恰是最慢、最需要缓存的那一批。
 *
 * 所以 v3（`formatStatus: 'migration-required'`）改用**文件字节数**当键。这是安全的：
 * 升级后 v3 文件不会再被写——写打开会在旁边生成 v4，此后只写 v4，`formatStatus` 随之
 * 变成 `current`、键也跟着换成 revision；只有降级回 0.9.0 才可能往 v3 里追加，而
 * 追加必然改变字节数。键里折进去的只有标题与活动时间，子会话归属不影响这两项。
 * @module
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionListIndex: SessionListIndex
  }
}

/** 索引文件的格式版本；不认得的版本整份忽略，当作冷启动。 */
const FORMAT_VERSION = 1

/**
 * 冷读的默认时间预算（毫秒）。
 *
 * 编辑器打开会话历史面板时在等这一次应答。2 秒内能读完上百条 v4 或几十条 v3；
 * 读不完的那些这一次只是少个标题，不影响能不能恢复。
 */
const DEFAULT_BUDGET_MS = 2_000

/**
 * 同时进行的冷读条数。
 *
 * 不是越大越快：后端对目录、头部、stat 读取有一个共享的并发上限（默认 3），每条
 * v3 打开都要往里塞「根目录会话数」那么多个任务，一条就足以占满它。开得多只是让
 * 排在后面的 `session/load` 等得更久——用户点开一条会话时，后台的预热不该挡在它
 * 前面。实测（200 条 v3）：并发 1 与 2 预热总时长相同（约 58 s），而预热期间一次
 * `session/load` 从 1.4–1.6 s 降到 1.0–1.2 s（空闲时 0.6 s）。
 */
const READ_CONCURRENCY = 1

/** 写盘前攒批的时间（毫秒）：后台一条条读完时不必每条都写一次文件。 */
const FLUSH_DELAY_MS = 1_000

/** 一条会话从日志折出来的、列表要用的那两项。 */
export interface ListedFacts {
  readonly title: string | undefined
  readonly updatedAt: number | undefined
}

/** 索引里的一条：变更键加上折出来的结果。读失败的也记，免得每次都重付一遍。 */
interface Entry extends ListedFacts {
  readonly key: string
}

interface IndexFile {
  version: number
  entries: Record<string, Entry>
}

/** 部署配置。 */
export interface SessionListIndexConfig {
  /** 索引文件路径。 */
  path: string
  /** 冷读的时间预算（毫秒）；只给用例调。 */
  budgetMs?: number
}

/**
 * 一条会话快照的变更键。
 * @param snapshot - `persistence.list()` 给出的快照
 * @returns 相等即可视为日志没变的键
 */
export function listKey(snapshot: SessionPersistenceSnapshot): string {
  if (snapshot.formatStatus === 'migration-required' && snapshot.sizeBytes !== undefined) {
    return `historical:${snapshot.sizeBytes}`
  }
  return `revision:${String(snapshot.revision)}`
}

function isEntry(value: unknown): value is Entry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['key'] === 'string'
    && (entry['title'] === undefined || typeof entry['title'] === 'string')
    && (entry['updatedAt'] === undefined || typeof entry['updatedAt'] === 'number')
  )
}

/**
 * 读索引文件。缺失、损坏、版本不认得一律当作空索引：它只是缓存，丢了的代价是
 * 再冷读一遍，不值得为它让列表失败。
 */
function readIndex(path: string): Map<string, Entry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IndexFile>
    if (parsed.version !== FORMAT_VERSION || parsed.entries === null || typeof parsed.entries !== 'object') {
      return new Map()
    }
    return new Map(Object.entries(parsed.entries).filter((pair): pair is [string, Entry] => isEntry(pair[1])))
  } catch {
    return new Map()
  }
}

/** `session/list` 的标题索引服务。 */
export class SessionListIndex extends Service {
  static Config = Schema.object({
    path: Schema.string().required(),
    budgetMs: Schema.natural(),
  })

  readonly path: string
  private readonly budgetMs: number
  private readonly entries: Map<string, Entry>
  /** 正在冷读的会话：同一条只读一次，后来的列表等在同一个 promise 上。 */
  private readonly inflight = new Map<string, Promise<void>>()
  /** 等着冷读的任务，最新的会话排在前面。 */
  private queue: (() => Promise<void>)[] = []
  private running = 0
  private dirty = false
  private flushTimer: NodeJS.Timeout | undefined
  /** 上一次列表里出现过的 id：写盘时据此丢掉已删除会话的条目。 */
  private listed: ReadonlySet<string> | undefined
  private disposed = false

  constructor(ctx: Context, config: SessionListIndexConfig) {
    super(ctx, 'sessionListIndex')
    this.path = config.path
    this.budgetMs = config.budgetMs ?? DEFAULT_BUDGET_MS
    this.entries = readIndex(this.path)
    ctx.effect(() => () => {
      this.disposed = true
      this.queue = []
      if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
      // 尽力把最后一批写下去；进程正在退出，失败也没人能处理。
      if (this.dirty) void this.flush().catch(() => {})
    })
  }

  /**
   * 给每条快照配上标题与最后活动时间，顺序与输入一致。
   * @param snapshots - `persistence.list()` 的结果
   * @param read - 冷读一条会话；抛错表示日志读不出来
   * @returns 与 snapshots 一一对应；预算内没读完的那几条两项都是 undefined
   */
  async describe(
    snapshots: readonly SessionPersistenceSnapshot[],
    read: (snapshot: SessionPersistenceSnapshot) => Promise<ListedFacts>,
  ): Promise<ListedFacts[]> {
    this.listed = new Set(snapshots.map((s) => String(s.header.id)))
    const misses = snapshots
      .filter((s) => this.entries.get(String(s.header.id))?.key !== listKey(s))
      .sort((a, b) => b.header.createdAt - a.header.createdAt)
    const pending = misses.map((s) => this.warm(s, read))
    if (pending.length > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.budgetMs)
          // 预算计时不该让一个本来要退出的进程多活 2 秒。
          timer.unref()
        }),
      ])
      clearTimeout(timer)
    }
    return snapshots.map((s) => {
      const entry = this.entries.get(String(s.header.id))
      return entry?.key === listKey(s)
        ? { title: entry.title, updatedAt: entry.updatedAt }
        : { title: undefined, updatedAt: undefined }
    })
  }

  /** 冷读一条（已在读就加入那一次），读完写进索引。 */
  private warm(
    snapshot: SessionPersistenceSnapshot,
    read: (snapshot: SessionPersistenceSnapshot) => Promise<ListedFacts>,
  ): Promise<void> {
    const id = String(snapshot.header.id)
    const key = listKey(snapshot)
    const existing = this.inflight.get(id)
    if (existing !== undefined) return existing
    const task = new Promise<void>((resolve) => {
      this.queue.push(async () => {
        try {
          const facts = await read(snapshot).catch((): ListedFacts => ({ title: undefined, updatedAt: undefined }))
          if (this.disposed) return
          this.entries.set(id, { key, ...facts })
          this.markDirty()
        } finally {
          this.inflight.delete(id)
          resolve()
        }
      })
    })
    this.inflight.set(id, task)
    this.pump()
    return task
  }

  private pump(): void {
    while (!this.disposed && this.running < READ_CONCURRENCY) {
      const job = this.queue.shift()
      if (job === undefined) return
      this.running += 1
      void job().finally(() => {
        this.running -= 1
        this.pump()
      })
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush().catch((error: unknown) => {
        this.ctx.logger.warn('could not save the session list index %s: %s', this.path, String(error))
      })
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref()
  }

  /**
   * 写盘：与盘上那份合并后整份替换。
   *
   * 一个编辑器连接一个进程，同一个会话根可能同时有好几个进程在写索引。合并而不是
   * 覆盖，免得一个进程把另一个刚读完的条目抹掉；同一条以本进程的为准——它刚读过。
   */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    mkdirSync(dirname(this.path), { recursive: true })
    await withFileLock(this.path, async () => {
      const merged = readIndex(this.path)
      for (const [id, entry] of this.entries) merged.set(id, entry)
      const listed = this.listed
      if (listed !== undefined) for (const id of merged.keys()) if (!listed.has(id)) merged.delete(id)
      const file: IndexFile = { version: FORMAT_VERSION, entries: Object.fromEntries(merged) }
      await writeFileAtomic(this.path, JSON.stringify(file), { mode: 0o600 })
    })
  }
}
