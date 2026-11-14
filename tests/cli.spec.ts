/**
 * TC-CLI-* —— 命令行解析与 `--setup`（ACP 的 Terminal Auth）。
 *
 * 分两层：`parseCli` / `readSecret` 是纯函数与纯流处理，进程内直接测；写盘那条必须
 * 起**真实子进程**——`--setup` 的契约是「退出码 0 即登录成功」，而退出码只有真进程
 * 才有。凭据落点由 `DSH_HOME` 指到临时目录，绝不碰开发者自己的 `~/.dsh`。
 *
 * 另有一组进程内用例守着「凭据文件压住客户端传入的 key」时的那行提示（TC-CLI-04）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it } from 'vitest'
import { shadowedApiKeyNotice } from '../src/launcher/boot.js'
import { AGENT_INFO } from '../src/protocol/initialize.js'
import { parseCli } from '../src/launcher/cli.js'
import { CREDENTIAL_REF, readSecret } from '../src/launcher/setup.js'
import { realTempDir } from './temp-dir.js'

const BIN = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

describe('TC-CLI-01 parseCli', () => {
  it('无参数起服务', () => {
    expect(parseCli([]).kind).toBe('serve')
  })

  it('--version / -v 打印版本', () => {
    for (const flag of ['--version', '-v']) {
      const action = parseCli([flag])
      expect(action.kind).toBe('print')
      expect(action.kind === 'print' && action.text).toBe(AGENT_INFO.version)
    }
  })

  it('--help / -h 打印帮助', () => {
    for (const flag of ['--help', '-h']) {
      const action = parseCli([flag])
      expect(action.kind).toBe('print')
      expect(action.kind === 'print' && action.text).toContain('--setup')
    }
  })

  it('--setup 走登录', () => {
    expect(parseCli(['--setup']).kind).toBe('setup')
  })

  it('未知参数照常起服务 —— 不为此拒绝启动', () => {
    // 编辑器可能出于自己的理由多传点什么；为此拒绝启动会把一个能跑的集成变成
    // 一句「连接失败」。子进程级的同名用例在 `stdout-guard.spec.ts`。
    expect(parseCli(['--what-is-this']).kind).toBe('serve')
    expect(parseCli(['--setup-ish']).kind).toBe('serve')
  })

  it('「只想看一眼」的开关优先于登录', () => {
    // 同时传时先打印再退出：`--version` 之类不该被一个交互式登录劫持。
    expect(parseCli(['--setup', '--version']).kind).toBe('print')
    expect(parseCli(['--setup', '--help']).kind).toBe('print')
  })
})

describe('TC-CLI-02 readSecret 不回显', () => {
  /** 收集写出去的内容。 */
  function sink(): { stream: NodeJS.WritableStream; text: () => string } {
    let text = ''
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        text += String(chunk)
        callback()
      },
    })
    return { stream: stream as unknown as NodeJS.WritableStream, text: () => text }
  }

  it('终端下提示照出，但击键回显被吞掉', async () => {
    const out = sink()
    const key = await readSecret(
      { input: Readable.from(['sk-secret-value\n']) as unknown as NodeJS.ReadableStream, output: out.stream, isTty: true },
      'KEY: ',
    )

    expect(key).toBe('sk-secret-value')
    expect(out.text()).toContain('KEY: ')
    // 这条才是重点：密钥不能出现在输出里。回显一旦漏出来，它会留在用户的终端
    // 回滚缓冲区里，也会被编辑器的终端面板原样收走。
    expect(out.text()).not.toContain('sk-secret-value')
  })

  it('非终端时原样读一行', async () => {
    const out = sink()
    const key = await readSecret(
      { input: Readable.from(['sk-piped\n']) as unknown as NodeJS.ReadableStream, output: out.stream, isTty: false },
      'KEY: ',
    )
    expect(key).toBe('sk-piped')
  })
})

describe('TC-CLI-03 --setup 写盘（子进程）', () => {
  let home: string | undefined

  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** 起一次 `--setup`，把 `stdin` 喂进去，等它自己退出。 */
  async function runSetupBin(
    dshHome: string,
    stdin: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, '--setup'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: dshHome },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      child.stdin.write(stdin)
      child.stdin.end()
      const cap = setTimeout(() => child.kill(), 15_000)
      child.on('close', (code) => {
        clearTimeout(cap)
        resolve({ code, stdout, stderr })
      })
    })
  }

  it('读到 Key 就写进 .credentials.yaml，退出码 0', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
    const run = await runSetupBin(home, 'sk-test-abc123\n')

    // 退出码 0 是 Terminal Auth 唯一的成功信号：客户端只看这个数就去重连了。
    expect(run.code, `stderr=${run.stderr.slice(0, 400)}`).toBe(0)

    const doc = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    expect(doc).toContain('DEEPSEEK_API_KEY')
    expect(doc).toContain('sk-test-abc123')
  }, 30_000)

  it('stdout 一个字都不写 —— 提示与结果全走 stderr', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
    const run = await runSetupBin(home, 'sk-test-abc123\n')
    // `--setup` 不起服务，写 stdout 不违反 AC-G1，但保持同一条约定：排查时不必
    // 先想「这次是哪种模式」。
    expect(run.stdout).toBe('')
  }, 30_000)

  it('空输入不写盘，退出码非 0', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
    const run = await runSetupBin(home, '\n')

    // 报成功却没存下东西，客户端会重连然后在第一个回合莫名失败——那种失败离
    // 「登录」已经很远，用户无从联想。
    expect(run.code).not.toBe(0)
    expect(() => readFileSync(join(home as string, '.credentials.yaml'), 'utf8')).toThrow()
  }, 30_000)
})

describe('TC-CLI-04 凭据文件压住客户端的 key 时提示一行', () => {
  // DSH 0.2 起 `$DSH_HOME/.credentials.yaml` 压过进程环境变量，0.1.x 相反。跑过
  // `--setup` 再在编辑器里经 `env` 换 key 的用户会静默用旧 key，这一行是唯一的线索。

  /** 一个只挂凭据服务的组合：文件里存 `stored`，进程环境里放 `inherited`。 */
  async function credentialsOnly(stored: string | undefined, inherited: string | undefined): Promise<Context> {
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: inherited === undefined ? {} : { DEEPSEEK_API_KEY: inherited } },
    ]))
    await ctx.plugin(LocalCredentials, { dshHome: realTempDir('dsacp-cred-'), watch: false })
    if (stored !== undefined) await ctx.credentials.set(CREDENTIAL_REF, stored)
    return ctx
  }

  it('两处不一致：说清用的是文件里的、怎么改，但两边的值都不出现', async () => {
    const ctx = await credentialsOnly('sk-stored-111', 'sk-client-222')
    const notice = await shadowedApiKeyNotice(ctx, '/somewhere/.credentials.yaml')
    expect(notice).toContain('DEEPSEEK_API_KEY')
    expect(notice).toContain('/somewhere/.credentials.yaml')
    expect(notice).toContain('--setup')
    // 提示进 stderr，而编辑器会把 agent 的 stderr 原样收进日志面板：值或片段一个都不能漏。
    for (const secret of ['sk-stored-111', 'sk-client-222', 'stored-111', 'client-222']) {
      expect(notice).not.toContain(secret)
    }
    await ctx.fiber.dispose()
  })

  it('同一个 key 放了两处、只有一处、或一处都没有 —— 都不提示', async () => {
    for (const [stored, inherited] of [
      ['sk-same', 'sk-same'],
      ['sk-stored', undefined],
      [undefined, 'sk-client'],
      [undefined, undefined],
    ] as const) {
      const ctx = await credentialsOnly(stored, inherited)
      expect(await shadowedApiKeyNotice(ctx), `stored=${stored} inherited=${inherited}`).toBeUndefined()
      await ctx.fiber.dispose()
    }
  })

  it('环境变量是空串 —— 等于没给，不提示', async () => {
    // 编辑器的配置面板里清空一个字段，多半是传一个空串而不是不传。
    const ctx = await credentialsOnly('sk-stored', '')
    expect(await shadowedApiKeyNotice(ctx)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
