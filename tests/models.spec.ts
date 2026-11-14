/**
 * TC-MODEL-* —— 内置组合 advertise 的 DeepSeek 模型目录。
 *
 * 这份目录是**我们自己维护**的（`boot.ts` 的 `DEEPSEEK_MODELS` 覆盖了适配器
 * 自带的那份），所以它会随官方上下线而过期，而过期不会以任何形式报错：模型
 * 选择器照常画得出来，用户选中一个已下线的 id 照常调得通（官方转给现役模型
 * 并按现役价计费），只是他以为自己在用另一个模型。这一组用例把那份目录的
 * **形状**与**内容**都钉住，让下一次官方改动至少要经过一次「用例变红」。
 *
 * 目录内容的来源是官方定价页：
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

import { Context } from '@deepseek-ai/cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { describe, expect, it } from 'vitest'
import { DEEPSEEK_MODELS, DEEPSEEK_PROVIDER_CONFIG, DEFAULT_MODEL, DEFAULT_PROVIDER } from '../src/launcher/boot.js'

/** 官方已下线、但仍能调通的旧 id。摆进选择器就是误导，见 `DEEPSEEK_MODELS`。 */
const RETIRED = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']

/**
 * 一个不是官方源的 Messages 根。DSH 0.2.2 起，内置目录配官方源时适配器会去拉
 * `/models` 列表——用例里那是一次真实的外网请求（假 key 换来一个 401，再退回内置
 * 目录）。换成别的源就不跟列表，解析出的模型信息与内置目录一致，且一个包都不发。
 * 两支都用它：哪天我们的目录恰好等于内置目录，`ours` 那支也不会偷偷联网。
 */
const OFFLINE_BASE_URL = 'https://catalog-fixture.invalid/anthropic'

/**
 * 只挂 LLM 那两层的最小组合。
 *
 * 不用 `composeAgent`：它刻意不含 provider 适配器（那是部署配置而非 agent
 * 能力），而这里要断的恰恰是适配器怎么消化我们这份目录。
 * @param catalog - `ours` 挂我们的覆盖；`upstream` 不覆盖，用上游自带的那份（TC-MODEL-03
 *   拿它对比）。不用「传 undefined 表示上游」：显式传 undefined 会落到参数默认值上，
 *   两边就成了同一份目录——这条用例第一版正是这样空过了变异测试。
 */
async function llmOnly(catalog: 'ours' | 'upstream' = 'ours'): Promise<Context> {
  const ctx = new Context()
  // DSH 0.2 起没有 key 时官方路由的模型目录是空的。这里给一个假 key：既不依赖开发者
  // 本机有没有 key，也不会真的去连模型 API（列目录与解析模型信息都不发请求）。
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DEEPSEEK_API_KEY: 'sk-offline-catalog-fixture' } },
  ]))
  await ctx.plugin(LlmService)
  // `ours` 挂的就是部署那份配置（`DEEPSEEK_PROVIDER_CONFIG`），不另抄一份：抄的那份
  // 会和 boot.ts 慢慢漂开，用例测的就不再是真正发出去的东西了。
  await ctx.plugin(LlmDeepSeek, {
    ...(catalog === 'ours' ? DEEPSEEK_PROVIDER_CONFIG : { reasoningEffort: 'high' }),
    baseURL: OFFLINE_BASE_URL,
  })
  return ctx
}

describe('TC-MODEL-01 目录内容', () => {
  it('默认模型在目录里 —— 否则模型选择器里没有当前值可选中', () => {
    expect(DEEPSEEK_MODELS.map((m) => m.id)).toContain(DEFAULT_MODEL)
  })

  it('默认模型是 V4.1 Flash，且它收图片', () => {
    // 「收图片」不是锦上添花：`promptCapabilities.image` 与图片准入都按会话当前
    // 路由判，默认档收不收图直接决定用户第一次拖图进来会不会被拒。
    const flash = DEEPSEEK_MODELS.find((m) => m.id === DEFAULT_MODEL)
    expect(flash?.inputModalities).toContain('image')
  })

  it('已下线的 id 一个都不在', () => {
    const ids = DEEPSEEK_MODELS.map((m) => m.id)
    expect(RETIRED.filter((id) => ids.includes(id))).toEqual([])
  })

  it('每条都有展示名 —— 选择器显示的是它，缺席会退回裸 id', () => {
    expect(DEEPSEEK_MODELS.filter((m) => m.name === undefined || m.name.length === 0)).toEqual([])
  })
})

describe('TC-MODEL-02 适配器真的消化得了这份目录', () => {
  it('列出来的正是我们写的那几条，顺序一致', async () => {
    // 覆盖目录时写错一个字段（比如漏掉 `systemPromptUpdate` 的字面量、或给纯文本
    // 模型挂了图片预算），`resolveModels` 会在**装配期**抛错。跑一次真装配，
    // 这类错误就落在这条用例上，而不是落在用户第一次启动编辑器时。
    const ctx = await llmOnly()
    const models = await ctx.llm.listModels(DEFAULT_PROVIDER)
    expect(models.map((m) => m.id)).toEqual(DEEPSEEK_MODELS.map((m) => m.id))
  })

  it('默认模型解析出的上下文窗口是 1,048,576 —— 用量进度条的分母', async () => {
    // 分母错了不会报错，只会画出一根刻度错误的进度条，而那比没有进度条更坏。
    // 这是官方 `/models` 列表声明的值（2^20）。定价页写的「1M」是取整，而适配器在
    // 条目缺省时回落的是十进制 1,000,000——所以目录里必须显式写，这条守的就是它没被省掉。
    const ctx = await llmOnly()
    const info = await ctx.llm.resolveModelInfo(DEFAULT_PROVIDER, DEFAULT_MODEL)
    expect(info.context?.contextWindow).toBe(1_048_576)
  })

  it('默认模型报告的输入模态含 image —— 图片准入读的就是它', async () => {
    const ctx = await llmOnly()
    const info = await ctx.llm.resolveModelInfo(DEFAULT_PROVIDER, DEFAULT_MODEL)
    expect(info.inputModalities).toContain('image')
  })
})

describe('TC-MODEL-03 覆盖不丢上游的字段', () => {
  // 覆盖目录的代价：上游给条目加了字段，这里不照抄就静默丢掉。DSH 0.2 加的
  // `toolUpdate` 就这样丢过一次——它管的是会话中途工具变了时的提示缓存，丢了不报错，
  // 只让 KV cache 命中率掉下去。这里拿上游自带的目录逐条对比解析出的模型信息，
  // 只放过展示文字（`description`：我们的是中文）。
  //
  // 这条红了不一定是我们错：可能是上游加了模型或字段。照抄过来，或者删掉覆盖、
  // 直接用上游的目录，两条路都比让它继续漂着好。
  it('模型 id 与顺序和上游一致', async () => {
    const ours = await (await llmOnly()).llm.listModels(DEFAULT_PROVIDER)
    const upstream = await (await llmOnly('upstream')).llm.listModels(DEFAULT_PROVIDER)
    expect(ours.map((m) => m.id)).toEqual(upstream.map((m) => m.id))
  })

  it('除说明文字外，每条解析出的模型信息与上游逐字段相同', async () => {
    const ours = await llmOnly()
    const upstream = await llmOnly('upstream')
    for (const { id } of await upstream.llm.listModels(DEFAULT_PROVIDER)) {
      const { description: _ours, ...mine } = await ours.llm.resolveModelInfo(DEFAULT_PROVIDER, id)
      const { description: _theirs, ...theirs } = await upstream.llm.resolveModelInfo(DEFAULT_PROVIDER, id)
      expect(mine, id).toEqual(theirs)
    }
  })

  it('默认模型带着两个缓存开关 —— 上面那条若被放宽，这条仍守着最贵的那次丢失', async () => {
    const info = await (await llmOnly()).llm.resolveModelInfo(DEFAULT_PROVIDER, DEFAULT_MODEL)
    expect(info.systemPromptUpdate).toBe('in-history')
    expect(info.toolUpdate).toBe('addition-only')
  })

  it('每条都有中文说明 —— 这是还留着覆盖的唯一理由', () => {
    for (const model of DEEPSEEK_MODELS) expect(model.description, model.id).toMatch(/[\u4e00-\u9fff]/)
  })
})
