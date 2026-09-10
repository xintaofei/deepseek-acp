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
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { describe, expect, it } from 'vitest'
import { DEEPSEEK_MODELS, DEFAULT_MODEL, DEFAULT_PROVIDER } from '../src/launcher/boot.js'

/** 官方已下线、但仍能调通的旧 id。摆进选择器就是误导，见 `DEEPSEEK_MODELS`。 */
const RETIRED = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']

/**
 * 只挂 LLM 那两层的最小组合。
 *
 * 不用 `composeAgent`：它刻意不含 provider 适配器（那是部署配置而非 agent
 * 能力），而这里要断的恰恰是适配器怎么消化我们这份目录。
 */
async function llmOnly(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmDeepSeek, { reasoningEffort: 'high', models: DEEPSEEK_MODELS })
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

  it('默认模型解析出的上下文窗口是 1M —— 用量进度条的分母', async () => {
    // 分母错了不会报错，只会画出一根刻度错误的进度条，而那比没有进度条更坏。
    // 1M 是定价页写的值，也是适配器的 `defaultContextWindow`；两者一致，因此
    // 目录里省略 `contextWindow` 是安全的——这条用例守的就是这个「一致」。
    const ctx = await llmOnly()
    const info = await ctx.llm.resolveModelInfo(DEFAULT_PROVIDER, DEFAULT_MODEL)
    expect(info.context?.contextWindow).toBe(1_000_000)
  })

  it('默认模型报告的输入模态含 image —— 图片准入读的就是它', async () => {
    const ctx = await llmOnly()
    const info = await ctx.llm.resolveModelInfo(DEFAULT_PROVIDER, DEFAULT_MODEL)
    expect(info.inputModalities).toContain('image')
  })
})
