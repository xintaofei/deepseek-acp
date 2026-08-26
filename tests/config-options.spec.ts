/**
 * TC-CFG-* —— 会话配置项（US-16 模型 / US-17 权限）。
 *
 * ACP 没有「支持配置项」的能力位：声明方式就是在 `session/new` / `session/load`
 * 的应答里带回 `configOptions`。因此这里既测「有没有声明」，也测「设了之后
 * 应答里的值有没有跟着变」——客户端只能靠后者重绘控件。
 */

import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { RouteChoice } from '../src/config/options.js'
import { MODEL_OPTION, SANDBOX_OPTION, configOptions, decodeRouteValue } from '../src/config/options.js'
import type { SessionControls } from '../src/port/types.js'
import { FAKE_MODEL, FAKE_MODEL_ALT, FAKE_PROVIDER, FAKE_PROVIDER_ALT } from './fake-llm.js'
import { createHarness, waitFor } from './harness.js'
import { NATIVE_SHELL_TOOL, writeFileCommand } from './native-shell.js'
import { realTempDir } from './temp-dir.js'

/** 取某个配置项。 */
function option(options: readonly SessionConfigOption[] | null | undefined, id: string) {
  return (options ?? []).find((o) => o.id === id)
}

/** 某个 select 的候选值。 */
function values(o: SessionConfigOption | undefined): string[] {
  if (o === undefined || o.type !== 'select') return []
  return o.options.flatMap((e) => ('group' in e ? e.options.map((x) => x.value) : [e.value]))
}

/** 单 provider（`p`）下的一条路由 —— 这些用例测的是模型维度，provider 是背景。 */
function route(model: string, modelName: string): RouteChoice {
  return { provider: 'p', providerName: 'P', model, modelName }
}

/** 某个 select 里某个取值的说明文案。 */
function describeOf(o: SessionConfigOption | undefined, value: string): string | null | undefined {
  if (o === undefined || o.type !== 'select') return undefined
  const flat = o.options.flatMap((e) => ('group' in e ? e.options : [e]))
  return flat.find((x) => x.value === value)?.description
}

/** 只关心沙箱维度时的最小 controls。 */
function sandboxControls(mode: string): SessionControls {
  return {
    model: () => undefined,
    provider: () => undefined,
    setRoute: () => {},
    contextWindow: () => undefined,
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    sandboxMode: () => mode,
    setSandboxMode: () => {},
  }
}

const ALL_MODES = ['read-only', 'workspace-write', 'danger-full-access']

describe('TC-CFG-01 权限预设（US-17）', () => {
  it('session/new 声明沙箱配置项，当前值为部署默认', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const created = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })

    const sandbox = option(created.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type).toBe('select')
    // harness 的 sandbox 组合默认 read-only
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('read-only')
    expect(values(sandbox)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    h.disposeBridge()
  }, 30_000)

  it('设置后应答里的 currentValue 立即反映新值', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })

    const set = await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'workspace-write' as never,
    })
    const sandbox = option(set.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('workspace-write')
    h.disposeBridge()
  }, 30_000)

  it('切换后命令真的在新模式下执行 —— 控件不能只是装饰', async () => {
    const h = await createHarness({ shell: 'sandbox' })

    /** 在某会话里写一个文件，返回模型可见的结果文本。 */
    const writeFile = async (sessionId: string, callId: string): Promise<string> => {
      const raw: Record<string, unknown>[] = []
      h.onUpdate((u) => raw.push(u as Record<string, unknown>))
      h.llm.toolCall = {
        id: callId,
        name: NATIVE_SHELL_TOOL,
        args: JSON.stringify({ command: writeFileCommand(`${callId}.txt`, 'ok'), description: 'write a file' }),
      }
      await h.acp.request('session/prompt', {
        sessionId: sessionId as never,
        prompt: [{ type: 'text', text: '写个文件' }],
      })
      await waitFor(
        () => raw.some((u) => u['sessionUpdate'] === 'tool_call_update' && u['toolCallId'] === callId),
        20_000,
        `result ${callId}`,
      )
      const done = raw.find((u) => u['sessionUpdate'] === 'tool_call_update' && u['toolCallId'] === callId)
      return JSON.stringify(done?.['content'] ?? '')
    }

    // 反向对照：不切模式时同样的命令**必须**被拒。没有这一半，即便切换完全
    // 没生效，「没有 denied」也可能因为别的原因成立，用例就是空过的。
    const before = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfgws-'), mcpServers: [] })
    expect(await writeFile(String(before.sessionId), 'cfg-denied')).toContain('denied')

    const after = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfgws-'), mcpServers: [] })
    await h.acp.request('session/set_config_option', {
      sessionId: after.sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'workspace-write' as never,
    })
    expect(await writeFile(String(after.sessionId), 'cfg-allowed')).not.toContain('denied')
    h.disposeBridge()
  }, 60_000)

  it('切换只影响本会话', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const a = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })

    await h.acp.request('session/set_config_option', {
      sessionId: a.sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'danger-full-access' as never,
    })
    // B 不受影响 —— 沙箱覆盖写在**各自的**会话日志里
    const bAgain = await h.acp.request('session/set_config_option', {
      sessionId: b.sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'read-only' as never,
    })
    const sandbox = option(bAgain.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('read-only')
    h.disposeBridge()
  }, 30_000)

  it('沙箱覆盖随 session/load 一起恢复', async () => {
    const root = realTempDir('dsacp-cfgroot-')
    const cwd = realTempDir('dsacp-cfgws-')
    const rec = await createHarness({ shell: 'sandbox', sessionsRoot: root })
    const { sessionId } = await rec.acp.request('session/new', { cwd, mcpServers: [] })
    await rec.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'danger-full-access' as never,
    })
    // 得先有内容才会落盘（懒物化）；设置本身就产生了一条 sandbox/mode 事件
    rec.disposeBridge()
    await waitFor(() => !rec.hasAgent(String(sessionId)), 5_000, 'teardown')
    await rec.retire()

    const loader = await createHarness({ shell: 'sandbox', sessionsRoot: root })
    const loaded = await loader.acp.request('session/load', {
      sessionId: sessionId as never,
      cwd,
      mcpServers: [],
    })
    // 恢复一个当初放宽过权限的会话，控件要如实显示放宽后的状态 —— 显示成部署
    // 默认（read-only）会让用户以为是安全的，而模型实际仍在 full-access 下跑。
    const sandbox = option(loaded.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('danger-full-access')
    loader.disposeBridge()
  }, 40_000)
})

describe('TC-CFG-04 模型切换（US-16）', () => {
  it('声明模型项，当前值为建会话时用的那个', async () => {
    const h = await createHarness()
    const created = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })
    const model = option(created.configOptions, MODEL_OPTION)
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe(FAKE_MODEL)
    expect(values(model)).toEqual([FAKE_MODEL, FAKE_MODEL_ALT])
    h.disposeBridge()
  }, 30_000)

  it('切换后下一次请求真的发给新模型 —— 只改显示值等于没切', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })

    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '第一轮' }],
    })
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL)

    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_ALT as never,
    })
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '第二轮' }],
    })
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL_ALT)
    h.disposeBridge()
  }, 30_000)

  it('切换只影响本会话', async () => {
    const h = await createHarness()
    const a = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })

    await h.acp.request('session/set_config_option', {
      sessionId: a.sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_ALT as never,
    })

    await h.acp.request('session/prompt', {
      sessionId: b.sessionId as never,
      prompt: [{ type: 'text', text: 'B 这一轮' }],
    })
    // B 仍用原模型：选择 ref 是**按 agent 作用域**装的，不是进程级共享
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-CFG-02 校验', () => {
  it('未知 configId 被拒 —— 静默接受会让客户端以为生效了', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: sessionId as never,
        configId: 'nope' as never,
        value: 'x' as never,
      }),
    ).rejects.toThrow(/unknown config option/)
    h.disposeBridge()
  }, 30_000)

  it('不在候选里的值被拒 —— 否则拼错的模型 id 会一路带到下一次请求', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: sessionId as never,
        configId: SANDBOX_OPTION as never,
        value: 'yolo-mode' as never,
      }),
    ).rejects.toThrow(/no value/)
    h.disposeBridge()
  }, 30_000)

  it('未知会话被拒', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: 'nope' as never,
        configId: SANDBOX_OPTION as never,
        value: 'read-only' as never,
      }),
    ).rejects.toThrow(/unknown session/)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-CFG-03 组合决定声明什么', () => {
  it('没挂 sandboxPolicy 时不声明权限项', async () => {
    // 默认 harness 不挂沙箱
    const h = await createHarness()
    const created = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })
    expect(option(created.configOptions, SANDBOX_OPTION)).toBeUndefined()
    h.disposeBridge()
  }, 30_000)

  it('模型只有一个候选时不声明模型项 —— 选不动的下拉框没有意义', () => {
    const controls: SessionControls = {
      model: () => 'only-one',
      provider: () => 'p',
      setRoute: () => {},
      contextWindow: () => undefined,
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      sandboxMode: () => undefined,
      setSandboxMode: () => {},
    }
    expect(
      configOptions({ controls, routes: [route('only-one', 'Only')], sandboxModes: [] }),
    ).toEqual([])
  })

  it('两个以上候选才声明模型项，当前值为已选模型', () => {
    const controls: SessionControls = {
      model: () => 'b',
      provider: () => 'p',
      setRoute: () => {},
      contextWindow: () => undefined,
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      sandboxMode: () => undefined,
      setSandboxMode: () => {},
    }
    const options = configOptions({
      controls,
      routes: [route('a', 'A'), route('b', 'B')],
      sandboxModes: [],
    })
    const model = option(options, MODEL_OPTION)
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe('b')
    expect(values(model)).toEqual(['a', 'b'])
  })

  it('provider/model 缺失时不声明模型项', () => {
    const controls: SessionControls = {
      model: () => undefined,
      provider: () => 'p',
      setRoute: () => {},
      contextWindow: () => undefined,
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      sandboxMode: () => undefined,
      setSandboxMode: () => {},
    }
    expect(
      configOptions({ controls, routes: [route('a', 'A'), route('b', 'B')], sandboxModes: [] }),
    ).toEqual([])
  })
})

describe('TC-CFG-05 多 provider 路由', () => {
  /** 某 select 的分组标题；不是分组形状时为空数组。 */
  function groups(o: SessionConfigOption | undefined): string[] {
    if (o === undefined || o.type !== 'select') return []
    return o.options.flatMap((e) => ('group' in e ? [e.group] : []))
  }

  const controls = (model: string, provider: string): SessionControls => ({
    model: () => model,
    provider: () => provider,
    setRoute: () => {},
    contextWindow: () => undefined,
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    sandboxMode: () => undefined,
    setSandboxMode: () => {},
  })

  it('跨 provider 时按 provider 分组，取值带前缀', () => {
    const options = configOptions({
      controls: controls('m1', 'p1'),
      routes: [
        { provider: 'p1', providerName: '一号', model: 'm1', modelName: 'M1' },
        { provider: 'p2', providerName: '二号', model: 'm2', modelName: 'M2' },
      ],
      sandboxModes: [],
    })
    const model = option(options, MODEL_OPTION)
    expect(groups(model)).toEqual(['p1', 'p2'])
    expect(values(model)).toEqual(['p1::m1', 'p2::m2'])
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe('p1::m1')
  })

  it('单 provider 保持扁平与裸模型 id —— 不为一个用不上的能力改变线上取值', () => {
    const options = configOptions({
      controls: controls('a', 'p'),
      routes: [route('a', 'A'), route('b', 'B')],
      sandboxModes: [],
    })
    const model = option(options, MODEL_OPTION)
    expect(groups(model)).toEqual([])
    expect(values(model)).toEqual(['a', 'b'])
  })

  it('两个 provider 各有同名模型时，取值仍然互不混淆', () => {
    // 裸模型 id 在这种形状下是**歧义**的：客户端回一个 `same`，agent 无从知道
    // 它指哪一家。前缀就是为这个存在的。
    const options = configOptions({
      controls: controls('same', 'p2'),
      routes: [
        { provider: 'p1', providerName: '一号', model: 'same', modelName: 'Same' },
        { provider: 'p2', providerName: '二号', model: 'same', modelName: 'Same' },
      ],
      sandboxModes: [],
    })
    expect(values(option(options, MODEL_OPTION))).toEqual(['p1::same', 'p2::same'])
    expect(option(options, MODEL_OPTION)?.type === 'select'
      ? (option(options, MODEL_OPTION) as { currentValue: string }).currentValue
      : undefined).toBe('p2::same')
  })

  describe('decodeRouteValue', () => {
    const routes: RouteChoice[] = [
      { provider: 'fake', providerName: 'F', model: 'm', modelName: 'M' },
      { provider: 'fake-alt', providerName: 'FA', model: 'm', modelName: 'M' },
    ]

    it('一个 provider 是另一个的前缀时，按最长前缀还原', () => {
      // `fake-alt::m` 用 `fake` 这个前缀也「匹配」得上（剩下 `-alt::m`），
      // 按短的先试就会把它判给错误的一家。
      expect(decodeRouteValue('fake-alt::m', routes)).toEqual(routes[1])
      expect(decodeRouteValue('fake::m', routes)).toEqual(routes[0])
    })

    it('模型 id 里带分隔符也不会被切错', () => {
      const withSep: RouteChoice[] = [
        { provider: 'gw', providerName: 'GW', model: 'vendor::model::v2', modelName: 'V' },
      ]
      expect(decodeRouteValue('gw::vendor::model::v2', withSep)).toEqual(withSep[0])
    })

    it('裸模型 id 落到唯一那条路由 —— 单 provider 的取值就是这个形状', () => {
      const single: RouteChoice[] = [{ provider: 'p', providerName: 'P', model: 'a', modelName: 'A' }]
      expect(decodeRouteValue('a', single)).toEqual(single[0])
    })

    it('词表里没有的取值解不出来', () => {
      expect(decodeRouteValue('fake::nope', routes)).toBeUndefined()
      expect(decodeRouteValue('nope', routes)).toBeUndefined()
    })
  })

  it('切到另一个 provider 的模型后，请求真的换了路由 —— 只改显示值等于没切', async () => {
    const h = await createHarness({ altProvider: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfg-'), mcpServers: [] })

    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '第一轮' }],
    })
    expect(h.llm.providersUsed.at(-1)).toBe(FAKE_PROVIDER)
    expect(h.llmAlt?.providersUsed).toEqual([])

    const set = await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: MODEL_OPTION as never,
      value: `${FAKE_PROVIDER_ALT}::${FAKE_MODEL}` as never,
    })
    // 应答里的当前值要立刻反映新路由，客户端据此重绘。
    const model = option(set.configOptions, MODEL_OPTION)
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe(
      `${FAKE_PROVIDER_ALT}::${FAKE_MODEL}`,
    )

    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '第二轮' }],
    })
    // 判据落在**另一个适配器实例**上：它收到了调用，就证明请求确实进了另一家，
    // 而不是同一家换了个模型名。
    expect(h.llmAlt?.providersUsed.at(-1)).toBe(FAKE_PROVIDER_ALT)
    expect(h.llm.providersUsed).toEqual([FAKE_PROVIDER])
    h.disposeBridge()
  }, 40_000)
})

describe('TC-CFG-05 权限文案不承诺后端不保证的强制力', () => {
  /**
   * 为什么这组用例值得存在：这是**安全表达**，不是措辞偏好。
   *
   * 后端自报的强制力是分级的——Windows ACL 报 `enforcement: 'partial'`（受限
   * 令牌必须保留 Everyone SID），而较旧的受支持 Landlock ABI **同样**报
   * `partial`。用户是照着这句话决定要不要把权限收紧的；说得比后端做得到的更死，
   * 就是在替后端许一个它兑不了的承诺。
   */
  const absolutes = ['不允许任何', '完全禁止', '一定', '保证', '无法写入']

  it('三种模式的文案都不用绝对语气 —— 在任何平台上', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const sandbox = option(
        configOptions({
          controls: sandboxControls('read-only'),
          routes: [],
          sandboxModes: ALL_MODES,
          platform,
        }),
        SANDBOX_OPTION,
      )
      for (const mode of ALL_MODES) {
        const text = describeOf(sandbox, mode) ?? ''
        expect(text, `${platform}/${mode} 的文案`).not.toBe('')
        for (const word of absolutes) expect(text, `${platform}/${mode} 的文案`).not.toContain(word)
      }
    }
  })

  it('Windows 上给两个受限模式补一句部分强制说明', () => {
    const sandbox = option(
      configOptions({
        controls: sandboxControls('read-only'),
        routes: [],
        sandboxModes: ALL_MODES,
        platform: 'win32',
      }),
      SANDBOX_OPTION,
    )
    expect(describeOf(sandbox, 'read-only')).toContain('部分强制')
    expect(describeOf(sandbox, 'workspace-write')).toContain('部分强制')
    // `danger-full-access` **不**加：那个模式本来就不声称有边界，给它补一句
    // 「只约束常规 NTFS 写入」反而是凭空造出一条并不存在的边界。
    expect(describeOf(sandbox, 'danger-full-access')).not.toContain('部分强制')
  })

  it('非 Windows 平台不出现那句话 —— 它讲的是 Windows 独有的事实', () => {
    const sandbox = option(
      configOptions({
        controls: sandboxControls('read-only'),
        routes: [],
        sandboxModes: ALL_MODES,
        platform: 'darwin',
      }),
      SANDBOX_OPTION,
    )
    for (const mode of ALL_MODES) expect(describeOf(sandbox, mode)).not.toContain('Windows')
  })

  it('词表外的模式原样透传，不编一句说明', () => {
    // 上游新增模式时，宁可只显示 id，也不要给它安一段别的模式的后果描述。
    const sandbox = option(
      configOptions({
        controls: sandboxControls('brand-new'),
        routes: [],
        sandboxModes: ['brand-new'],
        platform: 'win32',
      }),
      SANDBOX_OPTION,
    )
    expect(values(sandbox)).toEqual(['brand-new'])
    expect(describeOf(sandbox, 'brand-new')).toBeUndefined()
  })
})
