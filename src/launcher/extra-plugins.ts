/**
 * 第三方 Cordis 插件挂载点（`DEEPSEEK_ACP_PLUGINS`）。
 *
 * 存在的理由：这个组合是**写死**的——`boot()` 里三十来个 `ctx.plugin()` 一口气列
 * 完，没有任何外部入口。想在桥里挂一个自己的 Cordis 插件（例如只做运行时提示词
 * 注入、完全不改宿主文件的 dsh-purge），只能 fork 整个包。这个模块把「挂一个插件」
 * 降成一条环境变量，其余一概不动。
 *
 * 三条设计约束，每条都对应本仓库既有的规则：
 *
 * 1. **AC-G1：stdout 是协议通道。** 第三方插件一句 `console.log` 就会把 ndJSON
 *    帧流打断，客户端只会显示「连接失败」，而且失败点离原因很远。所以挂载窗口内
 *    把 `process.stdout.write` 临时改道到 stderr。**窗口只覆盖「解析依赖图 + import
 *    + apply」这一段**：更久会把 ACP 自己的帧也改道，那才是真的把协议弄坏。窗口
 *    之外才写的插件不在保护范围内——这一点写在这里，而不是假装已经解决。
 * 2. **配置错误不得让 agent 起不来。** 一个拼错的插件名不该把编辑器里的 DeepSeek
 *    变成不可用。JSON 不合法、某一项没名字、import 失败、apply 抛错，一律 stderr
 *    一行 + 继续 boot。这与 `parseCli` 对待未知参数的立场相同（见 `cli.ts`）。
 * 3. **纯下游（D4）。** 这里只 `import` 用户点名的模块，不往 `node_modules` 里塞
 *    东西、不 patch 上游包。
 *
 * 解析是纯函数（不碰 `process`），因此可以直接单测；只有挂载那半截需要 ctx。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 环境变量名。与 `DEEPSEEK_ACP_PROVIDER` / `_MODEL` / `_SESSIONS_ROOT` 同一族命名。 */
export const EXTRA_PLUGINS_ENV = 'DEEPSEEK_ACP_PLUGINS'

/**
 * 一行挂载声明。
 *
 * `name` 是交给 `import()` 的说明符：可以是包名（从本包位置解析）、绝对路径、
 * 或 `file:` URL。`config` 原样交给 `ctx.plugin`，缺省时不传。
 */
export interface ExtraPluginRow {
  readonly name: string
  readonly config?: unknown
}

/** 解析结果。`errors` 非空也照常启动——它们只是要打到 stderr 的告警。 */
export interface ExtraPluginParse {
  readonly rows: readonly ExtraPluginRow[]
  readonly errors: readonly string[]
}

/**
 * 挂载结果：成功挂上的模块名、失败项与原因，以及「挂上了但还在等服务」的项。
 *
 * `pending` 单列而不算进 `mounted`：`inject` 里的服务缺席时 Cordis 不报错，只让
 * fiber 停在 PENDING、`apply` 一次都不跑。算成「已挂载」就等于在日志里告诉用户
 * 配置生效了，而它其实什么都没做。
 */
export interface ExtraPluginMount {
  readonly mounted: readonly string[]
  readonly failed: readonly { readonly name: string; readonly reason: string }[]
  readonly pending: readonly { readonly name: string; readonly missing: readonly string[] }[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从 `import()` 的命名空间里取出插件本体。
 *
 * 具名导出 `apply` 的模块（例如 dsh-purge）命名空间本身就是插件；只有
 * `export default` 的模块要拆一层，与 `@deepseek-ai/cordis-plugin-loader` 的
 * unwrapping 一致。两者都不是时原样交回，由 `ctx.plugin` 报 invalid plugin。
 */
function pluginOf(module: unknown): unknown {
  const namespace = module as { apply?: unknown; default?: unknown } | null
  if (typeof namespace?.apply === 'function') return module
  return namespace?.default ?? module
}

/**
 * 把 `name` 变成 `import()` 认得的说明符。
 *
 * 绝对路径必须先转成 `file:` URL：POSIX 上直接把 `/a/b.mjs` 交给动态 import 碰巧能用，
 * Windows 上 `C:\\a\\b.mjs` 的盘符会被当成 URL scheme，以 `ERR_UNSUPPORTED_ESM_URL_SCHEME`
 * 失败——而 README 承诺的正是「绝对路径」。包名与 `file:` URL 原样交出。
 * @param name - 用户写的说明符
 * @returns 交给 `import()` 的说明符
 */
function specifierOf(name: string): string {
  return isAbsolute(name) ? pathToFileURL(name).href : name
}

/**
 * 解析 `DEEPSEEK_ACP_PLUGINS`。
 *
 * 逐项判定而不是「一项坏就全丢」：用户在一个数组里配了三个插件、第三个拼错时，
 * 前两个照常生效比整份配置作废更有用，而错误信息已经点名了是第几项。
 * @param raw - 环境变量的原文；`undefined` 与空白串都表示「没配」。
 * @returns 可用行与逐项错误
 */
export function parseExtraPlugins(raw: string | undefined): ExtraPluginParse {
  const text = raw?.trim() ?? ''
  if (text === '') return { rows: [], errors: [] }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    // 环境变量在编辑器侧是手填的文本框，多余的引号、尾逗号、把数组写成对象都是
    // 常见输入。报清楚是哪种，比让进程带着半份配置静默起服务好。
    return { rows: [], errors: [`${EXTRA_PLUGINS_ENV} 不是合法 JSON：${messageOf(error)}`] }
  }
  if (!Array.isArray(value)) {
    return { rows: [], errors: [`${EXTRA_PLUGINS_ENV} 必须是数组，收到 ${value === null ? 'null' : typeof value}`] }
  }

  const rows: ExtraPluginRow[] = []
  const errors: string[] = []
  value.forEach((item, index) => {
    const where = `第 ${index + 1} 项`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`${where}不是对象`)
      return
    }
    const record = item as Record<string, unknown>
    const name = record['name']
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${where}缺少非空字符串 name`)
      return
    }
    // `config` 缺席时不给这个键：`exactOptionalPropertyTypes` 下「没有」和「是
    // undefined」是两回事，`{ config: undefined }` 这种形状类型上就不该出现。
    // （Cordis 4.1 的 `ctx.plugin(mod)` 与 `ctx.plugin(mod, undefined)` 走的是同一条
    // 路径，挂载时传 `row.config` 不会因此改变行为。）
    rows.push(Object.hasOwn(record, 'config') ? { name: name.trim(), config: record['config'] } : { name: name.trim() })
  })
  return { rows, errors }
}

/** `process.stdout.write` 的替身：一律转投 stderr，签名按原函数的两个重载放宽。 */
function redirectToStderr(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
  const write = process.stderr.write.bind(process.stderr) as unknown as (
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ) => boolean
  return write(chunk, encoding, callback)
}

/**
 * 在 `process.stdout.write` 已改道到 stderr 的前提下跑一段异步工作。
 *
 * `finally` 里恢复**原函数引用**而不是包一层：ACP 桥随后要拿到真正的 stdout，
 * 而多次挂载时任何一层漏恢复都会把协议写进 stderr。
 * @param work - 要保护的工作
 * @returns `work()` 的结果
 */
async function withStdoutToStderr<T>(work: () => Promise<T>): Promise<T> {
  const stdout = process.stdout as unknown as { write: (...args: never[]) => boolean }
  const original = stdout.write
  stdout.write = redirectToStderr as unknown as typeof stdout.write
  try {
    return await work()
  } finally {
    stdout.write = original
  }
}

/**
 * 按行挂载第三方插件。任何一行失败都只记一条告警，不向上抛。
 *
 * `warn` 由调用方注入而不是在这里直接取 `ctx.logger`：组合里的 logger 是
 * `installStderrLog` 装出来的 exporter，而单测里的裸 `Context` 没有它。把告警
 * 出口做成参数，测试就不必为了测挂载而先搭一整套日志。
 * @param ctx - 组合上下文（只要 `plugin` 与查服务用的 `get`）
 * @param rows - {@link parseExtraPlugins} 的 `rows`
 * @param warn - 逐条失败告警的去处（调用方接 stderr）
 * @returns 成功与失败清单
 */
export async function mountExtraPlugins(
  ctx: Pick<Context, 'plugin' | 'get'>,
  rows: readonly ExtraPluginRow[],
  warn: (message: string) => void,
): Promise<ExtraPluginMount> {
  const mounted: string[] = []
  const failed: { name: string; reason: string }[] = []
  const pending: { name: string; missing: string[] }[] = []

  for (const row of rows) {
    try {
      // 保护范围就是这一整段：import 会执行模块顶层代码，apply 会执行插件的装配。
      // 两者都是第三方代码，都可能 `console.log`。
      const fiber = await withStdoutToStderr(async () => {
        const module: unknown = await import(specifierOf(row.name))
        return await ctx.plugin(pluginOf(module) as never, row.config as never)
      })
      const missing = Object.keys(fiber.inject).filter((service) => ctx.get(service) === undefined)
      if (missing.length > 0) {
        pending.push({ name: row.name, missing })
        warn(`${row.name} 已挂载但未生效，缺少服务：${missing.join(', ')}`)
        continue
      }
      mounted.push(row.name)
    } catch (error) {
      // 逐项吞掉：一个插件起不来不该牵连下一个，更不该让 ACP 服务起不来。
      failed.push({ name: row.name, reason: messageOf(error) })
      warn(`${row.name} 加载失败，已跳过：${messageOf(error)}`)
    }
  }
  return { mounted, failed, pending }
}
