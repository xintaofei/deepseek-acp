/**
 * `@deepseek-ai/dsh-llm-pi-ai` 的**惰性**加载。
 *
 * ## 为什么要惰性
 *
 * 这个包 `import` 一次要 **4.9 秒**（对照：`dsh-llm-deepseek` 0.24 秒）——它在模块
 * 求值期把 `@earendil-works/pi-ai` 的整张 provider 目录拉起来。静态 import 会把这
 * 5 秒加到**每一次**编辑器启动上，而绝大多数部署根本没配第二条 provider 路由，
 * 等于为一个用不上的能力永久付费。实测：加进组合后 `initialize` 的首次应答从
 * ~3s 涨到 ~4-10s。
 *
 * 所以它只在两种时刻被拉起来：
 *
 * 1. **启动时**，设置文档里确实写了 `llm-pi-ai` 段 —— 那说明用户配了路由，模型
 *    要走它，不加载就等于配置不生效。
 * 2. **首次 `providers/*` 调用时** —— 用户打开了 provider 配置界面，这是一次明确
 *    的交互，等一下是可以接受的；而它不发生在启动路径上。
 *
 * 第 1 条的判据是 `AcpSettings.mentionsPiAi()`：它看的是**当前生效**的文档——
 * 自己那份，或还没有时只读导入的旧文档——所以 0.9.0 配过路由的用户升级后照样在
 * 启动时加载。判据的取舍（拿不准就答「有」）写在那里。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

/** pi-ai 插件模块的类型；只用到命名空间插件契约与协议词表。 */
type PiAiModule = typeof import('@deepseek-ai/dsh-llm-pi-ai')

/**
 * 进程级单例。
 *
 * 存的是 **promise 而不是模块**：两处并发触发（启动预筛与首次 `providers/list`）
 * 时，第二个等在同一个 promise 上，而不是各拉一次 5 秒的模块。
 */
let pending: Promise<PiAiModule> | undefined

/**
 * 拉起 pi-ai 模块，进程内只做一次。
 * @returns 模块命名空间
 */
export async function loadPiAi(): Promise<PiAiModule> {
  pending ??= import('@deepseek-ai/dsh-llm-pi-ai')
  return pending
}

/** pi-ai 在设置服务里的命名空间；目录条目靠它辨认。 */
const PI_AI_NS = 'llm-pi-ai'
/**
 * 每个根 context 上正在进行的那一次挂载。
 *
 * 启动路径传根 context，`providers/*` 传 bridge 的子 context，两者可能同时进来。
 * 按 `ctx.root` 记，后来的等在同一个 promise 上，而不是各自挂一次、第二次以「已声明」
 * 失败。挂完即删：之后靠查注册表判断（见下）。
 */
const mounts = new WeakMap<object, Promise<void>>()

/**
 * 确保 pi-ai 已挂进这个 context，**幂等**。
 *
 * `providers/*` 要的不只是模块，而是它注册进 `ctx.llm` 的**可配置 provider 目录**
 * ——没挂插件，目录就是空的，用户在配置界面里一个可选项都看不到，也就无从添加
 * 第一条路由。而重复挂载会以 `configurable provider "amazon-bedrock" is already
 * declared` 失败，所以这里必须幂等。
 *
 * ## 为什么查状态而不是记一个标志
 *
 * 一开始这里用 `WeakSet` 按 context 记「挂过了」，**是错的**：启动路径传的是根
 * context，而 `providers/*` 那条路径传的是 bridge 插件自己的子 context，两个是
 * 不同的对象，于是标志查不中、插件被挂第二次。查注册表的真实状态没有这个问题
 * ——不管谁在什么作用域挂的，目录是同一份。
 *
 * pi-ai 即便**休眠挂载**（零路由）也会把整张内置目录声明进可配置 provider 目录
 * （上游 README 明说），所以「目录里有 `llm-pi-ai` 段的条目」与「插件已挂」是
 * 等价的，不会出现挂了却查不到的空窗。
 * @param ctx - 任意 context；只要能看到同一个 `ctx.llm` 即可
 */
export async function ensurePiAi(ctx: Context): Promise<void> {
  const llm = ctx.get('llm')
  if (llm === undefined) return
  if (llm.listConfigurableProviders().some((entry) => entry.settingsNs === PI_AI_NS)) return
  let mounting = mounts.get(ctx.root)
  if (mounting === undefined) {
    mounting = (async () => {
      if (ctx.get('loader') === undefined) await ctx.root.plugin(Loader, { baseUrl: import.meta.url })
      const loader = ctx.get('loader')!
      const entry = {
        id: PI_AI_NS,
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: ctx.get('acpSettings')?.section(PI_AI_NS) ?? {},
      }
      // 条目 id 固定为 `llm-pi-ai`：pi-ai 拿 Loader 条目 id 当自己的设置命名空间
      // （`settingsNs`），上面的查重与 `providers/*` 都靠这个名字认它。
      loader.ensureId(entry)
      await loader.create(entry)
      await loader.await()
    })()
    mounts.set(ctx.root, mounting)
  }
  try { await mounting }
  finally { if (mounts.get(ctx.root) === mounting) mounts.delete(ctx.root) }
}
