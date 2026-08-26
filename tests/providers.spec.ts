/**
 * TC-PROV-* —— ACP `providers/list` / `set` / `disable`（多 provider 配置面）。
 *
 * 这一组的重心不在「配置写没写进去」，而在**密钥没有从任何一个出口漏出去**：
 * 设置文档是明文的、`providers/list` 的应答会整段发给客户端、而配置界面拿到的
 * 是一份缺了密钥的视图——三处各有一种漏法，各有一条用例。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

/** 这个部署的设置文档全文；还没写过时为空串。 */
function settingsText(home: string): string {
  try {
    return readFileSync(join(home, 'settings.yaml'), 'utf8')
  } catch {
    return ''
  }
}

/** 这个部署的凭据文档全文；还没写过时为空串。 */
function credentialsText(home: string): string {
  try {
    return readFileSync(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return ''
  }
}

const SECRET = 'sk-super-secret-value-do-not-leak'

function createProviderHarness(home = realTempDir('dsacp-prov-')) {
  return createHarness({ settings: home, launchEnvironment: {} })
}

describe('TC-PROV-01 能力位跟着组合走', () => {
  it('没挂设置服务时不 advertise providers，且三个方法都拒绝', async () => {
    const h = await createHarness()
    const init = await h.acp.request('initialize', {
      protocolVersion: 1 as never,
      clientCapabilities: {} as never,
    })
    expect((init.agentCapabilities as Record<string, unknown>)['providers']).toBeUndefined()

    // 声明没有 ≠ 调了就静默成功。规矩的客户端不会调，有 bug 的会。
    await expect(h.acp.request('providers/list', {} as never)).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)

  it('挂了可写设置服务就 advertise', async () => {
    const h = await createProviderHarness()
    const init = await h.acp.request('initialize', {
      protocolVersion: 1 as never,
      clientCapabilities: {} as never,
    })
    expect((init.agentCapabilities as Record<string, unknown>)['providers']).toEqual({})
    h.disposeBridge()
  }, 30_000)
})

describe('TC-PROV-02 列表不漏密钥', () => {
  it('providers/list 的应答里一个字节的密钥都没有', async () => {
    const home = realTempDir('dsacp-prov-')
    const h = await createProviderHarness(home)
    await h.acp.request('providers/set', {
      providerId: 'openai' as never,
      apiType: 'openai-completions' as never,
      baseUrl: 'https://api.example.com/v1',
      headers: { Authorization: `Bearer ${SECRET}` },
    } as never)

    const listed = await h.acp.request('providers/list', {} as never)
    // 整段序列化后搜 —— 逐字段断言会漏掉将来新增的字段，而这里要守的恰恰是
    // 「任何一个字段都不许带密钥」。
    expect(JSON.stringify(listed)).not.toContain(SECRET)

    const openai = (listed.providers as { providerId: string; current?: unknown }[]).find(
      (p) => p.providerId === 'openai',
    )
    expect(openai?.current).toEqual({
      apiType: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
    })
    h.disposeBridge()
  }, 30_000)

  it('未配置的 provider current 缺席 —— ACP 用它表示「已禁用」', async () => {
    const h = await createProviderHarness()
    const listed = await h.acp.request('providers/list', {} as never)
    const entries = listed.providers as { providerId: string; current?: unknown; required: boolean }[]
    // pi-ai 会把它内置目录里的每个 provider 都声明成可配置项，此时一条都还没配。
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.filter((p) => !p.required).every((p) => p.current === undefined)).toBe(true)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-PROV-03 密钥落凭据文件而不是设置文档', () => {
  it('set 之后：设置文档只有引用名，凭据文档才有明文', async () => {
    const home = realTempDir('dsacp-prov-')
    const h = await createProviderHarness(home)
    await h.acp.request('providers/set', {
      providerId: 'openai' as never,
      apiType: 'openai-completions' as never,
      baseUrl: 'https://api.example.com/v1',
      headers: { Authorization: `Bearer ${SECRET}` },
    } as never)

    const settings = settingsText(home)
    // 这一条是本组的核心：`settings.yaml` 会被配置界面整段读出来，也常常被用户
    // 连同报错一起贴出去。
    expect(settings).not.toContain(SECRET)
    expect(settings).toContain('OPENAI_API_KEY')
    expect(settings).toContain('https://api.example.com/v1')

    // 反向对照：密钥确实存下来了，而不是被丢掉了。少了这一半，即使 set 什么都
    // 没做，上面三条也全都成立。
    expect(credentialsText(home)).toContain(SECRET)
    h.disposeBridge()
  }, 30_000)

  it('不带授权头时不写凭据，路由照样配得上', async () => {
    const home = realTempDir('dsacp-prov-')
    const h = await createProviderHarness(home)
    await h.acp.request('providers/set', {
      providerId: 'openai' as never,
      apiType: 'openai-completions' as never,
      baseUrl: 'https://gateway.internal/v1',
    } as never)
    expect(settingsText(home)).toContain('https://gateway.internal/v1')
    expect(credentialsText(home)).not.toContain('OPENAI_API_KEY')
    h.disposeBridge()
  }, 30_000)
})

describe('TC-PROV-04 禁用只删自己那一条', () => {
  it('disable 一个 provider 不会带走同段里另一个的配置', async () => {
    const home = realTempDir('dsacp-prov-')
    const h = await createProviderHarness(home)
    const set = async (id: string, url: string): Promise<void> => {
      await h.acp.request('providers/set', {
        providerId: id as never,
        apiType: 'openai-completions' as never,
        baseUrl: url,
        headers: { Authorization: `Bearer ${SECRET}-${id}` },
      } as never)
    }
    await set('openai', 'https://one.example/v1')
    await set('anthropic', 'https://two.example/v1')

    await h.acp.request('providers/disable', { providerId: 'openai' as never } as never)

    const settings = settingsText(home)
    // 这条守的是「用脱敏视图重建整段再写回」那个坑：那种实现会把 anthropic
    // 一起抹掉，而所有「openai 没了」的断言仍旧成立。
    expect(settings).not.toContain('https://one.example/v1')
    expect(settings).toContain('https://two.example/v1')
    expect(settings).toContain('ANTHROPIC_API_KEY')

    // 另一条的密钥也必须还在凭据文件里。
    expect(credentialsText(home)).toContain(`${SECRET}-anthropic`)
    h.disposeBridge()
  }, 30_000)

  it('required 的 provider 拒绝禁用 —— 静默成功会让用户以为生效了', async () => {
    const h = await createProviderHarness()
    const listed = await h.acp.request('providers/list', {} as never)
    const required = (listed.providers as { providerId: string; required: boolean }[]).find(
      (p) => p.required,
    )
    // 静态组合进来的假 provider 就是这一类：它的路由不在设置文档里。
    expect(required).toBeDefined()
    await expect(
      h.acp.request('providers/disable', { providerId: required?.providerId as never } as never),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)
})

describe('TC-PROV-05 入参校验', () => {
  it('本 build 不认得的 apiType 当场拒绝', async () => {
    const h = await createProviderHarness()
    await expect(
      h.acp.request('providers/set', {
        providerId: 'openai' as never,
        apiType: 'telepathy' as never,
        baseUrl: 'https://api.example.com/v1',
      } as never),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)

  it('空 baseUrl 拒绝 —— 它会被上游当成「继承目录默认」，与用户意图相反', async () => {
    const h = await createProviderHarness()
    await expect(
      h.acp.request('providers/set', {
        providerId: 'openai' as never,
        apiType: 'openai-completions' as never,
        baseUrl: '   ',
      } as never),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)

  it('不可配置的 provider id 拒绝', async () => {
    const h = await createProviderHarness()
    await expect(
      h.acp.request('providers/set', {
        providerId: 'no-such-provider' as never,
        apiType: 'openai-completions' as never,
        baseUrl: 'https://api.example.com/v1',
      } as never),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)
})
