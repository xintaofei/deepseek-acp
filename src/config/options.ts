/**
 * 会话配置项：模型（US-16）与权限预设（US-17）。
 *
 * ACP 没有「支持配置项」这个能力位——**声明方式就是在 `session/new` /
 * `session/load` 的应答里把 `configOptions` 带回去**。因此这里返回空数组等价于
 * 「本会话没有可配置项」，客户端不会显示控件，也不会去调 `set_config_option`。
 * @module
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { SessionControls } from '../port/types.js'

/** 模型选择的配置项 id。 */
export const MODEL_OPTION = 'model'

/** 沙箱模式（权限预设）的配置项 id。 */
export const SANDBOX_OPTION = 'sandbox'

/** 推理档位的配置项 id。 */
export const REASONING_OPTION = 'reasoning'

/** 推理档位的展示名。词表由适配器给，这里只把已知 id 翻成中文。 */
const REASONING_LABELS: Record<string, { name: string; description: string }> = {
  off: { name: '关闭', description: '不做推理，直接作答；最快' },
  low: { name: '低', description: '略作推理；比关闭稳，比高档快' },
  high: { name: '高', description: '推理后作答；日常编码的默认档' },
  max: { name: '最高', description: '推理更久；难题更稳，但慢且更费 token' },
}

/**
 * 沙箱模式的展示名与说明。用户看到的是后果，不是词表里的字面量。
 *
 * **措辞一律陈述「这个模式意图约束什么」，不承诺「一定拦得住」。** 后端自报的
 * 强制力是分级的：Windows ACL 报 `enforcement: 'partial'`——受限令牌必须保留
 * Everyone SID，于是对 Everyone 授予写权限的外部对象仍然可写，而 NTFS 硬链接
 * 还能让工作区内的路径与工作区外的路径指向同一个文件对象。**较旧的受支持
 * Landlock ABI 同样报 `partial`**（`dsh-sandbox-local` README.zh:38-39），所以
 * 绝对语气在任何平台上都是夸大，不只是 Windows——一个没装 bwrap、跑在旧内核上
 * 的 Linux 部署，与 Windows 处在同一档。
 */
const SANDBOX_LABELS: Record<string, { name: string; description: string }> = {
  'read-only': { name: '只读', description: '按只读策略执行；需要写入时切换权限' },
  'workspace-write': {
    name: '可写工作区',
    description: '写入意在限制于会话工作区与系统临时目录；越界的调用会请求单次授权',
  },
  'danger-full-access': { name: '完全访问', description: '不施加任何文件限制。仅在你清楚后果时选择' },
}

/**
 * Windows 上补给受限模式的部分强制说明。
 *
 * **为什么不做成事实驱动**：`enforcement` 挂在 `ConfinedArgv` 上，是**每一次
 * `confine()` 调用的结果**，不是 provider 的静态属性。要在 advertise 配置项时
 * 拿到真值就得先跑一次探针 `confine()`，而 ACL 后端的授权物化是整树立即传播的
 * （大工作区上数十秒）。为一句文案付这个代价不划算；保守措辞是这里的正确解。
 */
const WINDOWS_PARTIAL = 'Windows 上是部分强制：只约束常规 NTFS 写入，不约束读取、网络与进程'

/** 声称有边界的模式。`danger-full-access` 不在其中——它本来就不声称有边界。 */
const FENCED_MODES: ReadonlySet<string> = new Set(['read-only', 'workspace-write'])

/**
 * 某个沙箱模式的说明文案。
 * @param mode - 模式 id
 * @param platform - 判断用的平台
 * @returns 说明；模式不在词表里时 undefined（名字会退回原样的 id）
 */
function sandboxDescription(mode: string, platform: NodeJS.Platform): string | undefined {
  const base = SANDBOX_LABELS[mode]?.description
  if (base === undefined) return undefined
  return platform === 'win32' && FENCED_MODES.has(mode) ? `${base}。${WINDOWS_PARTIAL}` : base
}

/**
 * 一个推理档位 → 下拉项。
 *
 * 本地译名优先于适配器给的名字：词表 id 是稳定的（`off` / `high` / `max`），
 * 而适配器的 `name` 是英文的展示串。认得的 id 用中文说明后果，认不得的原样透传
 * ——新增档位不会因此消失，只是没有中文说明。
 */
function effortChoice(effort: { id: string; name: string; description?: string }): {
  value: string
  name: string
  description?: string
} {
  const label = REASONING_LABELS[effort.id]
  if (label !== undefined) return { value: effort.id, name: label.name, description: label.description }
  if (effort.description !== undefined) {
    return { value: effort.id, name: effort.name, description: effort.description }
  }
  return { value: effort.id, name: effort.name }
}

/** 一条可选路由：某个 provider 下的某个模型。 */
export interface RouteChoice {
  readonly provider: string
  /** provider 的展示名，用作分组标题 */
  readonly providerName: string
  readonly model: string
  readonly modelName: string
}

/**
 * 路由项的取值分隔符。
 *
 * 只在**多 provider** 时才拼进取值里（见 {@link routeValue}）。裸模型 id 在
 * 跨 provider 时会歧义——两个 provider 可以各有一个 `deepseek-v4-pro`，而 ACP
 * 的取值是一个扁平字符串，分组只影响显示、不进值域。
 */
const ROUTE_SEPARATOR = '::'

/**
 * 一条路由的 ACP 取值。
 *
 * 单 provider 时**原样用模型 id**：那是绝大多数部署的形状，拼上一个恒定前缀
 * 只会让已经存着选择的客户端全部失配，换不来任何消歧。
 * @param route - 该路由
 * @param composite - 是否需要带上 provider 前缀
 */
function routeValue(route: RouteChoice, composite: boolean): string {
  return composite ? `${route.provider}${ROUTE_SEPARATOR}${route.model}` : route.model
}

/**
 * ACP 取值 → 路由。
 *
 * **按已知 provider 前缀匹配而不是 split**：模型 id 里可以出现分隔符（网关常见
 * 的 `vendor/model` 形状再拼上版本号），split 会把它切在错误的地方。前缀按长度
 * 从长到短试，于是 `a` 与 `a::b` 两个 provider 同时存在时也只有一个解。
 *
 * 匹配不上就当作裸模型 id，落到会话当前的 provider ——单 provider 部署的取值
 * 就是这个形状，同一个函数覆盖两种编码。
 * @param value - 客户端回传的取值
 * @param routes - 当前 advertise 过的全部路由
 * @returns 命中的路由；值不在词表里时 undefined
 */
export function decodeRouteValue(
  value: string,
  routes: readonly RouteChoice[],
): RouteChoice | undefined {
  const providers = [...new Set(routes.map((r) => r.provider))].sort((a, b) => b.length - a.length)
  for (const provider of providers) {
    const prefix = `${provider}${ROUTE_SEPARATOR}`
    if (!value.startsWith(prefix)) continue
    const model = value.slice(prefix.length)
    const hit = routes.find((r) => r.provider === provider && r.model === model)
    if (hit !== undefined) return hit
  }
  return routes.find((r) => r.model === value)
}

/** 组装配置项所需的会话事实。 */
export interface ConfigInputs {
  readonly controls: SessionControls
  /** 全部可选路由（跨 provider）；少于两条时不 advertise 模型项 */
  readonly routes: readonly RouteChoice[]
  /** 部署支持的沙箱模式；空数组表示没挂 sandboxPolicy */
  readonly sandboxModes: readonly string[]
  /**
   * 当前模型的推理档位词表与适配器默认；空数组表示这个路由不暴露推理档位。
   *
   * **随模型而变**，不是全局常量：某些部署只剩 `off` 一项。
   */
  readonly reasoning?: {
    readonly efforts: readonly { id: string; name: string; description?: string }[]
    readonly defaultEffort?: string
  }
  /**
   * 判断沙箱文案用的平台；缺席时用 `process.platform`。
   *
   * 存在这个字段只为让用例能在别的平台上断言 Windows 的那句话。否则这条分支
   * 只在 Windows CI 上被执行到，而它讲的恰恰是 Windows 独有的事实——最需要
   * 覆盖的一句，反而最难在开发机上验证。
   */
  readonly platform?: NodeJS.Platform
}

/**
 * 按当前会话状态组装配置项。
 *
 * 每次都**重新读取**当前值而不是缓存：`set_config_option` 的应答与后续的
 * `session/new` 都要反映真实状态，缓存一份就会出现「界面显示已切换、实际没切」。
 * @param inputs - 会话事实
 * @returns 配置项数组；无可配置项时为空
 */
export function configOptions(inputs: ConfigInputs): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  const currentModel = inputs.controls.model()
  const currentProvider = inputs.controls.provider()
  // 只有一个候选时不 advertise：给用户一个选不动的下拉框没有意义。
  if (currentModel !== undefined && inputs.routes.length > 1) {
    // 跨了 provider 才分组、才拼前缀。单 provider 时保持原来的扁平形状与裸模型
    // id ——那是绝大多数部署，不该为一个它们用不上的能力改变线上取值。
    const providers = [...new Set(inputs.routes.map((r) => r.provider))]
    const composite = providers.length > 1
    const current =
      currentProvider === undefined
        ? currentModel
        : routeValue(
            { provider: currentProvider, providerName: '', model: currentModel, modelName: '' },
            composite,
          )
    options.push({
      type: 'select',
      id: MODEL_OPTION,
      name: '模型',
      category: 'model',
      currentValue: current,
      options: composite
        ? providers.map((provider) => ({
            // `group` 是 id、`name` 才是给人看的标签 —— 两者错位的表现是分组标题
            // 变成一串路由 key，而客户端不会因此报错。
            group: provider,
            name: inputs.routes.find((r) => r.provider === provider)?.providerName ?? provider,
            options: inputs.routes
              .filter((r) => r.provider === provider)
              .map((r) => ({ value: routeValue(r, true), name: r.modelName })),
          }))
        : inputs.routes.map((r) => ({ value: routeValue(r, false), name: r.modelName })),
    })
  }

  const efforts = inputs.reasoning?.efforts ?? []
  // 同样只有一个候选时不 advertise：选不动的下拉框没有意义。
  if (efforts.length > 1) {
    // 会话没显式选过就显示适配器的默认档——这与实际发送的是同一个值：
    // `LlmRuntime` 也按 `requested ?? defaultEffort` 物化。同源，但那是运行时的
    // 行为而非本模块能保证的事，所以有用例钉着（TC-REASON-02）。
    const current = inputs.controls.reasoningEffort() ?? inputs.reasoning?.defaultEffort
    // 当前值必须在词表里，否则客户端会拿到一个选不中的下拉框。
    if (current !== undefined && efforts.some((effort) => effort.id === current)) {
      options.push({
        type: 'select',
        id: REASONING_OPTION,
        name: '推理档位',
        description: '越高越慢越费 token，难题更稳',
        category: 'model',
        currentValue: current,
        options: efforts.map((effort) => effortChoice(effort)),
      })
    }
  }

  const currentSandbox = inputs.controls.sandboxMode()
  if (currentSandbox !== undefined && inputs.sandboxModes.length > 0) {
    options.push({
      type: 'select',
      id: SANDBOX_OPTION,
      name: '文件权限',
      description: '命令与文件工具共用这一条边界',
      category: 'mode',
      currentValue: currentSandbox,
      options: inputs.sandboxModes.map((mode) => {
        const description = sandboxDescription(mode, inputs.platform ?? process.platform)
        return {
          value: mode,
          name: SANDBOX_LABELS[mode]?.name ?? mode,
          ...(description === undefined ? {} : { description }),
        }
      }),
    })
  }

  return options
}
