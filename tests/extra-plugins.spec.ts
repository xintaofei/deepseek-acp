/**
 * TC-PLUG-* —— `DEEPSEEK_ACP_PLUGINS`：第三方 Cordis 插件的解析与挂载。
 *
 * 分两层：`parseExtraPlugins` 是纯函数，进程内直接测；挂载那半截必须真的
 * `import()` 一个模块——**只有真模块才能证明「加载期写 stdout 会被挡住」**，
 * 用一个内存替身测不到 `process.stdout`。临时模块写在 `realTempDir` 里，用
 * `file:` URL 交给 `import()`，绝不碰仓库自己的文件。
 *
 * 这组用例守的是三条约束（见 `src/launcher/extra-plugins.ts`）：AC-G1（stdout 即
 * 协议）、配置错误不得阻断启动、纯下游。
 */

import { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTRA_PLUGINS_ENV,
  parseExtraPlugins,
  mountExtraPlugins,
  type ExtraPluginRow,
} from '../src/launcher/extra-plugins.js'
import { realTempDir } from './temp-dir.js'

describe('TC-PLUG-01 parseExtraPlugins 读得懂，也读得懂「没配」', () => {
  it('未设置与空白串都是「没配」——不起服务失败、不留告警', () => {
    for (const raw of [undefined, '', '   ', '\n']) {
      expect(parseExtraPlugins(raw), `raw=${JSON.stringify(raw)}`).toEqual({ rows: [], errors: [] })
    }
  })

  it('一行带 config、一行不带 —— config 缺席时不留这个键', () => {
    const parsed = parseExtraPlugins(
      JSON.stringify([{ name: 'dsh-purge-community', config: { mode: 'light' } }, { name: 'plain' }]),
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toEqual([{ name: 'dsh-purge-community', config: { mode: 'light' } }, { name: 'plain' }])
    // `exactOptionalPropertyTypes` 下「没有 config」与「config 是 undefined」是
    // 两回事，而 Cordis 里 `plugin(mod, undefined)` 与 `plugin(mod)` 也不等价。
    expect(Object.hasOwn(parsed.rows[1] as ExtraPluginRow, 'config')).toBe(false)
  })
})

describe('TC-PLUG-02 坏配置逐项报错，且不拖垮整份列表', () => {
  it('JSON 不合法 —— 零行 + 一条点名的错误', () => {
    const parsed = parseExtraPlugins('[{"name":"x"},]')
    expect(parsed.rows).toEqual([])
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]).toContain(EXTRA_PLUGINS_ENV)
    expect(parsed.errors[0]).toContain('JSON')
  })

  it('不是数组 —— 说清收到的是什么', () => {
    const parsed = parseExtraPlugins('{"name":"x"}')
    expect(parsed.rows).toEqual([])
    expect(parsed.errors[0]).toContain('必须是数组')
  })

  it('第三项拼错 —— 前两项照常保留，错误点名第几项', () => {
    // 逐项判定的理由就在这里：用户配了三个、第三个漏了 name，前两个没必要陪葬。
    const parsed = parseExtraPlugins(
      JSON.stringify([{ name: 'a' }, { name: 'b' }, { config: {} }, 'c', { name: '   ' }]),
    )
    expect(parsed.rows.map((row) => row.name)).toEqual(['a', 'b'])
    expect(parsed.errors).toHaveLength(3)
    expect(parsed.errors[0]).toContain('第 3 项')
    expect(parsed.errors[1]).toContain('第 4 项')
    expect(parsed.errors[2]).toContain('第 5 项')
  })
})

describe('TC-PLUG-03 真模块挂得上', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.length = 0
  })

  /** 写一个临时 ESM 插件模块，返回它的 `file:` URL。 */
  function writeModule(source: string): string {
    const dir = realTempDir('dsacp-plug-')
    dirs.push(dir)
    const file = join(dir, 'plugin.mjs')
    writeFileSync(file, source, 'utf8')
    return pathToFileURL(file).href
  }

  it('apply 被调用、返回值里记为已挂载', async () => {
    const url = writeModule(
      [
        'globalThis.__dsacpPlugCalls = (globalThis.__dsacpPlugCalls ?? 0) + 1',
        'export const name = "tc-plug-ok"',
        'export function apply() {}',
      ].join('\n'),
    )
    const ctx = new Context()
    const warnings: string[] = []
    const result = await mountExtraPlugins(ctx, [{ name: url }], (message) => warnings.push(message))

    expect(result.failed).toEqual([])
    expect(result.mounted).toEqual([url])
    // 模块顶层真的被求值了：一条只写进 `mounted` 的假实现会让这里保持 undefined。
    expect((globalThis as Record<string, unknown>)['__dsacpPlugCalls']).toBe(1)
    expect(warnings).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('TC-PLUG-04 加载失败软着陆，后面的照常挂', () => {
  const ctx = new Context()
  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('包名不存在 —— 一条告警、不抛、下一个仍然挂上', async () => {
    const dir = realTempDir('dsacp-plug-')
    const url = pathToFileURL(join(dir, 'ok.mjs')).href
    writeFileSync(join(dir, 'ok.mjs'), 'export const name = "tc-plug-after"\nexport function apply() {}\n', 'utf8')

    const warnings: string[] = []
    // 这条是防止「一个配错的插件把编辑器里的 DeepSeek 变成不可用」的唯一保障：
    // 断言必须落在「没抛 + 后面的挂上了」，只断言 failed 长度挡不住把抛出去。
    const result = await mountExtraPlugins(
      ctx,
      [{ name: 'dsh-purge-this-package-does-not-exist' }, { name: url }],
      (message) => warnings.push(message),
    )

    expect(result.failed.map((row) => row.name)).toEqual(['dsh-purge-this-package-does-not-exist'])
    expect(result.failed[0]?.reason).not.toBe('')
    expect(result.mounted).toEqual([url])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('加载失败')
  })
})

describe('TC-PLUG-05 挂载窗口内 stdout 一个字都不写（AC-G1）', () => {
  it('插件直接写 stdout —— 字节改道 stderr，stdout 保持干净', async () => {
    const dir = realTempDir('dsacp-plug-')
    const file = join(dir, 'noisy.mjs')
    // 用 `process.stdout.write` 而不是 `console.log`：进程内用例里 vitest 自己接管了
    // console（它的输出去的是启动时抓走的那条流），所以 console 这条路在进程内测不到
    // ——`stdout-guard.spec.ts` 为此专门起真子进程。协议帧走的同样是 `write`，测这一层
    // 才测到真东西；`console.log` 在生产里最终也落到同一个 `write` 上。
    writeFileSync(
      file,
      [
        'export const name = "tc-plug-noisy"',
        'export function apply() {',
        "  process.stdout.write('TC-PLUG-05-LEAK\\n')",
        '}',
      ].join('\n'),
      'utf8',
    )

    // 两个流都换成内存 sink：`withStdoutToStderr` 保存的是**调用当刻**的 write，
    // 所以替身必须在 mount 之前就位，它才会被当成「原函数」在收尾时恢复。
    const out: string[] = []
    const err: string[] = []
    const stdout = process.stdout as unknown as { write: (...args: never[]) => boolean }
    const stderr = process.stderr as unknown as { write: (...args: never[]) => boolean }
    const originalOut = stdout.write
    const originalErr = stderr.write
    stdout.write = ((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never
    stderr.write = ((chunk: unknown) => {
      err.push(String(chunk))
      return true
    }) as never

    const ctx = new Context()
    try {
      await mountExtraPlugins(ctx, [{ name: pathToFileURL(file).href }], () => {})
    } finally {
      stdout.write = originalOut
      stderr.write = originalErr
      await ctx.fiber.dispose()
    }

    // 协议帧就走在 stdout 上：这里出现一个字节，客户端那边就是「连接失败」。
    expect(out.join('')).not.toContain('TC-PLUG-05-LEAK')
    expect(err.join('')).toContain('TC-PLUG-05-LEAK')
  })
})
