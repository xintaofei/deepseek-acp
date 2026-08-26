/**
 * TC-REASON-* —— 推理档位配置项。
 *
 * ACP 的 `session/prompt` 里**没有**推理字段（只有 `sessionId` / `prompt` /
 * `_meta`），所以档位唯一的表达位置就是 `configOptions`，与模型、文件权限同一
 * 个机制。
 *
 * 这条链有两处特有的坑，都在下面钉着：
 *  1. 词表**随模型变**（有的路由只剩 `off`）。切模型后不换词表，选一个旧档位会
 *     在下一次请求里撞上 `UNSUPPORTED_REASONING_EFFORT`，而界面上毫无异常。
 *  2. 适配器在**未配置**默认档时照样报一个 `defaultEffort`，但那种情况下它实际
 *     什么都不往请求里放。照着报告画 UI 就是在显示一个我们并不保证的档位。
 */

import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { MODEL_OPTION, REASONING_OPTION, configOptions } from '../src/config/options.js'
import type { SessionControls } from '../src/port/types.js'
import { createHarness, type TestHarness } from './harness.js'
import { FAKE_MODEL, FAKE_MODEL_ALT } from './fake-llm.js'
import { realTempDir } from './temp-dir.js'

/** 取某个配置项。 */
function option(options: readonly SessionConfigOption[] | undefined, id: string): SessionConfigOption | undefined {
  return (options ?? []).find((o) => o.id === id)
}

/** 某个 select 的候选值。 */
function values(o: SessionConfigOption | undefined): string[] {
  if (o?.type !== 'select') return []
  return o.options.flatMap((e) => ('group' in e ? e.options.map((x) => x.value) : [e.value]))
}

/** 某个 select 的当前值。 */
function current(o: SessionConfigOption | undefined): string | undefined {
  return o?.type === 'select' ? o.currentValue : undefined
}

/** 一个可编排的控制面替身。 */
function stubControls(over: Partial<SessionControls> = {}): SessionControls {
  return {
    model: () => FAKE_MODEL,
    provider: () => 'p',
    setRoute: () => {},
    contextWindow: () => undefined,
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    sandboxMode: () => undefined,
    setSandboxMode: () => {},
    ...over,
  }
}

const THREE = {
  efforts: [{ id: 'off', name: 'OFF' }, { id: 'high', name: 'HIGH' }, { id: 'max', name: 'MAX' }],
  defaultEffort: 'high',
}

describe('TC-REASON-01 档位项的组装', () => {
  it('多档时 advertise，当前值取会话选择', () => {
    const options = configOptions({
      controls: stubControls({ reasoningEffort: () => 'max' }),
      routes: [],
      sandboxModes: [],
      reasoning: THREE,
    })
    const reasoning = option(options, REASONING_OPTION)
    expect(values(reasoning)).toEqual(['off', 'high', 'max'])
    expect(current(reasoning)).toBe('max')
    // 已知 id 用中文说后果，而不是把适配器的英文串直接摆出来。
    expect(reasoning?.type === 'select' ? reasoning.name : undefined).toBe('推理档位')
  })

  it('会话没选过时落到适配器默认档', () => {
    const options = configOptions({ controls: stubControls(), routes: [], sandboxModes: [], reasoning: THREE })
    expect(current(option(options, REASONING_OPTION))).toBe('high')
  })

  it('只有一个候选时不 advertise —— 选不动的下拉框没有意义', () => {
    const options = configOptions({
      controls: stubControls(),
      routes: [],
      sandboxModes: [],
      reasoning: { efforts: [{ id: 'off', name: 'OFF' }], defaultEffort: 'off' },
    })
    expect(option(options, REASONING_OPTION)).toBeUndefined()
  })

  it('路由不暴露推理时不 advertise', () => {
    const options = configOptions({ controls: stubControls(), routes: [], sandboxModes: [] })
    expect(option(options, REASONING_OPTION)).toBeUndefined()
  })

  it('当前值不在词表里时整项不发 —— 不给一个选不中的下拉框', () => {
    // 切模型会清空会话的档位选择，正常不该出现这种状态；真出现了（词表变窄而
    // 选择还在）也宁可不显示，也不要显示一个客户端高亮不了的当前值。
    const options = configOptions({
      controls: stubControls({ reasoningEffort: () => 'max' }),
      routes: [],
      sandboxModes: [],
      reasoning: { efforts: [{ id: 'off', name: 'OFF' }, { id: 'high', name: 'HIGH' }], defaultEffort: 'off' },
    })
    expect(option(options, REASONING_OPTION)).toBeUndefined()
  })

  it('认不得的档位 id 原样透传 —— 上游加档位不该让它消失', () => {
    const options = configOptions({
      controls: stubControls(),
      routes: [],
      sandboxModes: [],
      reasoning: {
        efforts: [{ id: 'off', name: 'OFF' }, { id: 'turbo', name: 'Turbo', description: '未来档位' }],
        defaultEffort: 'off',
      },
    })
    expect(values(option(options, REASONING_OPTION))).toEqual(['off', 'turbo'])
  })
})

describe('TC-REASON-02 端到端：切档位进得了请求', () => {
  /** 建会话并返回它的配置项。 */
  async function newSession(h: TestHarness): Promise<{ sessionId: string; options: SessionConfigOption[] }> {
    const created = await h.acp.request('session/new', { cwd: realTempDir('dsacp-reason-'), mcpServers: [] })
    return { sessionId: String(created.sessionId), options: (created.configOptions ?? []) as SessionConfigOption[] }
  }

  it('建会话就带上档位项，默认值是适配器默认', async () => {
    const h = await createHarness()
    const { options } = await newSession(h)
    expect(values(option(options, REASONING_OPTION))).toEqual(['off', 'high', 'max'])
    expect(current(option(options, REASONING_OPTION))).toBe('high')
    h.disposeBridge()
  }, 30_000)

  it('没选过档位时，请求里带的就是界面显示的那一档', async () => {
    // 这条钉的是「显示值 = 实际发送值」。`LlmRuntime` 会把适配器报告的
    // `defaultEffort` 物化进请求（`effective = requested ?? defaultEffort`），
    // 所以两者本来就同源——但同源是运行时的行为，不是我们能默认的事，得有用例
    // 守着：一旦哪天不物化了，界面上那个「高」就成了一句空话。
    const h = await createHarness()
    const { sessionId, options } = await newSession(h)
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '一' }] })
    expect(h.llm.effortsUsed.at(-1)).toBe(current(option(options, REASONING_OPTION)))
    expect(h.llm.effortsUsed.at(-1)).toBe('high')
    h.disposeBridge()
  }, 30_000)

  it('切档位后，下一次请求真的带着新档位', async () => {
    const h = await createHarness()
    const { sessionId } = await newSession(h)
    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: REASONING_OPTION as never,
      value: 'max' as never,
    })
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '一' }] })
    // 断的是**适配器收到了什么**，不是「配置项显示成了什么」——后者可以在完全
    // 没接通请求装配的情况下照样正确。
    expect(h.llm.effortsUsed.at(-1)).toBe('max')
    h.disposeBridge()
  }, 30_000)

  it('切模型会清空档位选择，落到新模型的默认档', async () => {
    // 假适配器故意让两个模型词表不同：FAKE_MODEL 有三档，FAKE_MODEL_ALT 只有
    // `off`。留着旧选择的话，`LlmRuntime` 会在下一次请求里抛
    // `UNSUPPORTED_REASONING_EFFORT`——它会校验有效档位在词表里。也就是说不清空
    // 的后果是一个**响亮的**失败，不是静默走偏；清空把它变成一次平滑的重置。
    const h = await createHarness()
    const { sessionId } = await newSession(h)
    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: REASONING_OPTION as never,
      value: 'max' as never,
    })

    const after = await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_ALT as never,
    })
    // 新模型只剩一档 → 整项不再 advertise。
    expect(option(after.configOptions as SessionConfigOption[], REASONING_OPTION)).toBeUndefined()

    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '一' }] })
    // 关键断言：请求里**没有**残留的 `max`，而是新模型唯一合法的那一档。
    expect(h.llm.effortsUsed.at(-1)).toBe('off')
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL_ALT)
    h.disposeBridge()
  }, 30_000)

  it('设一个不在词表里的档位被拒', async () => {
    const h = await createHarness()
    const { sessionId } = await newSession(h)
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: sessionId as never,
        configId: REASONING_OPTION as never,
        value: 'turbo' as never,
      }),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)
})
