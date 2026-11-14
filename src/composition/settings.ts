/**
 * ACP 自己保管的 provider 设置文档。
 *
 * ## 为什么不用上游的设置服务
 *
 * DSH 0.2 删掉了 `dsh-settings-file`。新的 `dsh-settings` 是 Cordis Loader profile
 * 的投影：它 inject `configEditor` 与 `profileContext`，不在上游那套 profile 启动器
 * 里挂就**永远挂起**，`providers/*` 面就这样静默消失。我们不起 profile，所以自己
 * 管一份只装 `llm-pi-ai` 段的小文档，校验、回滚交给 pi-ai 插件自己的 Config。
 *
 * ## 为什么不再写 `$DSH_HOME/settings.yaml`
 *
 * 那是 0.9.0 写的位置，也是上游 0.1.x 的设置文档。上游 0.2.x 的 CLI / 桌面端
 * 启动时只要看见它，就把它**改名**成 `settings.yaml.imported`，再把内容导进自己的
 * profile（`dsh-settings` 的 `importLegacyDocument`）。同一台机器上两边都用的话：
 *
 * - 我们写进去的路由，下次上游一启动就被挪走，我们下次启动读到 ENOENT，路由静默
 *   丢失；
 * - 我们再写一份，上游下次启动又挪一次，`rename` 还会覆盖上一份 `.imported`。
 *
 * 所以文档落在 `$DSH_HOME/deepseek-acp/settings.yaml`，那是上游不认识的路径。
 *
 * ## 旧文档：只读导入
 *
 * 自己的文档还不存在时，从 `$DSH_HOME/settings.yaml`、再从
 * `settings.yaml.imported` 里取 `llm-pi-ai` 段当作当前内容——前者是 0.9.0 写的，
 * 后者是它被上游挪走之后的样子。**只读不写**：那两个文件归上游与旧版本所有，
 * 降级回 0.9.0 时它们还得原样可用。第一次经 `providers/*` 修改时，导入的内容连同
 * 这次修改一起落进我们自己的文档，此后旧文档就不再被读。
 * @module
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context, Service, resolveConfig } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import Schema from '@deepseek-ai/schemastery'
import { parse, stringify } from 'yaml'
import { redactSecrets } from '@deepseek-ai/dsh-settings'

/** 文档里唯一可写、也唯一会被读出的段：pi-ai 的插件配置。 */
const PI_AI_NS = 'llm-pi-ai'

/**
 * pi-ai 1.x 改了名的内置 provider：旧 id → 新 id。
 *
 * 只作用于旧文档的导入。旧 id 留在段里不会报错，而是变成一条带 `error`、没有
 * 模型的手工路由——用户看到的是「配好的 Azure 不见了，多了一个坏掉的同名项」。
 */
const RENAMED_PROVIDERS: Readonly<Record<string, string>> = {
  'azure-openai-responses': 'azure',
}

type Document = Record<string, Record<string, unknown>>
type PathOp = { op: 'unset'; path: readonly string[] }
declare module '@deepseek-ai/cordis' {
  interface Context {
    acpSettings: AcpSettings
  }
}

/** 设置服务的部署配置；两项都只给用例用，生产走默认值。 */
export interface AcpSettingsConfig {
  /** 本适配器自己的文档；缺省 `$DSH_HOME/deepseek-acp/settings.yaml`。 */
  path?: string
  /**
   * 自己的文档不存在时，依次尝试只读导入的旧文档；缺省为 `$DSH_HOME` 下的
   * `settings.yaml` 与 `settings.yaml.imported`。给 `[]` 关掉导入。
   */
  legacy?: readonly string[] | null
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('ACP settings must be a mapping')
  return value as Record<string, unknown>
}

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const child = record(target[key])
      target[key] = child
      merge(child, record(value))
    } else target[key] = structuredClone(value)
  }
}

/**
 * 读一份 YAML 映射。
 * @param path - 文件路径
 * @returns 文档；文件不存在时 undefined。解析失败照常抛出——坏文档要让人看见，
 * 当成「没配置」会让用户的路由静默消失。
 */
function readDocument(path: string): Document | undefined {
  try {
    return record(parse(readFileSync(path, 'utf8'))) as Document
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 把旧文档的 `llm-pi-ai` 段改写成当前 pi-ai 认得的形状。
 * @param section - 旧段（不改动入参）
 * @returns 改名后的副本
 */
function upgradeLegacySection(section: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(section)
  const providers = next['providers']
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return next
  const table = providers as Record<string, unknown>
  for (const [from, to] of Object.entries(RENAMED_PROVIDERS)) {
    // 新旧两个 id 都在时保留新的：那是用户在新版本里亲手配过的。
    if (from in table && !(to in table)) table[to] = table[from]
    delete table[from]
  }
  return next
}

/** 只装 pi-ai 段、与上游 profile 互不相干的设置文档。 */
export class AcpSettings extends Service {
  static inject = ['loader']
  // `legacy` 不能写成裸的 `Schema.array`：schemastery 会把缺省值补成 `[]`，
  // 生产里的旧文档导入就这样被静默关掉了。缺省必须保持「没给」。
  static Config = Schema.object({
    path: Schema.string(),
    legacy: Schema.union([Schema.array(Schema.string()), Schema.const(null)]).default(null),
  })

  /** 本适配器自己的文档，所有写入都落在这里。 */
  readonly documentPath: string
  /** 自己的文档不存在时依次只读导入的旧文档。 */
  readonly legacyPaths: readonly string[]
  readonly writable = true

  constructor(ctx: Context, config: AcpSettingsConfig = {}) {
    super(ctx, 'acpSettings')
    const home = resolveDshHome()
    this.documentPath = config.path ?? join(home, 'deepseek-acp', 'settings.yaml')
    this.legacyPaths = config.legacy ?? [join(home, 'settings.yaml'), join(home, 'settings.yaml.imported')]
  }

  /**
   * 当前生效的文档：自己的那份；还没有时取第一份带 pi-ai 段的旧文档。
   *
   * 每次都现读，不缓存：一个客户端连接一个进程，读的次数屈指可数，而缓存会让
   * 「另一个进程刚写过」这种情况读到旧值。
   */
  private read(): Document {
    const own = readDocument(this.documentPath)
    if (own !== undefined) return own
    for (const path of this.legacyPaths) {
      let section: unknown
      try {
        section = readDocument(path)?.[PI_AI_NS]
        if (section !== undefined) return { [PI_AI_NS]: upgradeLegacySection(record(section)) }
      } catch (error) {
        // 旧文档归上游与旧版本所有，内容不由我们保证。读不懂就跳过并留一行，
        // 不能让它挡住启动——那等于因为别人的文件把整个适配器拉下线。
        this.ctx.logger.warn('skipping unreadable legacy settings %s: %s', path, String(error))
      }
    }
    return {}
  }

  /**
   * 启动时要不要拉起 pi-ai 的判据：当前生效的文档里有没有 pi-ai 段。
   *
   * 读不了（文档损坏）时答「有」：误判为有只是白付一次加载，而 pi-ai 那边会把
   * 坏配置报出来；误判为无则让用户配好的路由静默失效。
   */
  mentionsPiAi(): boolean {
    try {
      return Object.keys(record(this.read()[PI_AI_NS])).length > 0
    } catch {
      return true
    }
  }

  section(ns: string): Record<string, unknown> {
    return structuredClone(this.read()[ns] ?? {})
  }

  /**
   * 脱敏后的段视图，供 `providers/list` 使用。
   *
   * 总是脱敏，与入参无关：这份视图唯一的去处就是线上。脱敏按 pi-ai 自己的 Config
   * 标注的密钥字段来做，所以 pi-ai 还没挂上时什么都不返回，而不是返回未脱敏的值。
   */
  describe(_options: { redactSecrets: boolean }): { ns: string; value: unknown }[] {
    const value = this.read()[PI_AI_NS]
    if (value === undefined) return []
    const entry = [...(this.ctx.get('loader')?.entries() ?? [])].find(
      (entry) => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai',
    )
    const schema = (entry?.moduleNamespace as { Config?: Schema<never> } | undefined)?.Config
    return schema === undefined ? [] : [{ ns: PI_AI_NS, value: redactSecrets(schema, value).value }]
  }

  /**
   * 改一次段：先让 pi-ai 的 Config 与可用性钩子校验候选值，再热更新路由，最后才
   * 落盘。任何一步失败都把线上路由回滚到改之前，文档不动。
   */
  private async edit(ns: string, change: (section: Record<string, unknown>) => void): Promise<void> {
    if (ns !== PI_AI_NS) throw new Error(`ACP settings namespace "${ns}" is not writable`)
    // 锁文件与原子写的临时文件都建在文档旁边，目录必须先在。
    mkdirSync(dirname(this.documentPath), { recursive: true })
    await withFileLock(this.documentPath, async () => {
      const document = this.read()
      const section = record(document[ns])
      document[ns] = section
      change(section)
      const loader = this.ctx.get('loader')
      if (loader === undefined) throw new Error('Provider loader is not available')
      const entry = [...loader.entries()].find((entry) => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
      const fiber = entry?.fiber
      if (entry === undefined || fiber === undefined) throw new Error('Provider configuration is not loaded')
      const candidate = fiber.ctx.waterfall(fiber, 'internal/config', section, () => section)
      resolveConfig(fiber.runtime!, candidate)
      const before = structuredClone(entry.options.config ?? {})
      try {
        await loader.update(entry.id, { config: section })
        await loader.await()
        await writeFileAtomic(this.documentPath, stringify(document), { mode: 0o600 })
      } catch (error) {
        await loader.update(entry.id, { config: before })
        await loader.await()
        throw error
      }
    })
  }

  async update(ns: string, patch: object): Promise<void> {
    await this.edit(ns, (section) => merge(section, record(patch)))
  }

  async mutate(ns: string, ops: readonly PathOp[]): Promise<void> {
    await this.edit(ns, (section) => {
      for (const op of ops) {
        let node = section
        for (const segment of op.path.slice(0, -1)) node = record(node[segment])
        const key = op.path.at(-1)
        if (key !== undefined) delete node[key]
      }
    })
  }
}
