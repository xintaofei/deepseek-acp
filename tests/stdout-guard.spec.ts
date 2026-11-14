/**
 * TC-GUARD-01 —— stdout 仅承载 ACP JSON-RPC 帧。
 *
 * 必须起**真实子进程**：这条约束的风险在于组合里任何一个插件写了 stdout，
 * 而进程内测试用的是内存流，根本碰不到真的 process.stdout。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_INFO } from '../src/protocol/initialize.js'

const BIN = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

interface Run {
  stdout: string
  stderr: string
  code: number | null
}

/**
 * 起子进程，喂入若干 JSON-RPC 帧，等应答齐了再收尾。
 *
 * **等应答而不是 sleep 固定时长。** 原先是「睡 900ms 再关 stdin」，而冷启动要
 * ~900ms（其中约 590ms 是加载 42 个包的 import，`composeAgent` 本身只要 ~70ms），
 * 于是组合一变大用例就开始随机失败——关 stdin 触发 teardown，进程一个字都没来得及
 * 输出。固定 sleep 本来就是在赌启动耗时，这里改成等到收齐帧为止。
 */
async function runBin(frames: object[], timeoutMs = 15_000, args: readonly string[] = []): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEEPSEEK_ACP_PROVIDER: 'nope', DEEPSEEK_ACP_MODEL: 'nope' },
    })
    let stdout = ''
    let stderr = ''
    let finishing = false

    /** 收齐每个请求的应答（或超时）后关 stdin，让进程正常收尾。 */
    const finish = (): void => {
      if (finishing) return
      finishing = true
      child.stdin.end()
      setTimeout(() => child.kill(), 1_000)
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      const complete = stdout.split('\n').filter((l) => l.trim().length > 0).length
      if (complete >= frames.length) finish()
    })
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', reject)

    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`)
    // 兜底：某帧本就不产生应答时，别把用例挂死。
    const cap = setTimeout(finish, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(cap)
      resolve({ stdout, stderr, code })
    })
  })
}

describe('TC-GUARD-03 启动不卡死', () => {
  it('initialize 有应答，不会在装配期挂住', async () => {
    const elapsed = await new Promise<number>((resolve, reject) => {
      const started = Date.now()
      const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', reject)
      child.stdout.once('data', () => {
        const ms = Date.now() - started
        child.kill()
        resolve(ms)
      })
      setTimeout(() => {
        child.kill()
        reject(new Error('initialize 20s 内无应答'))
      }, 20_000)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
      )
    })

    // **这里不断言延迟。** 曾经写过 `toBeLessThan(3000)`，但整个套件是并行跑的，
    // 同时有一堆用例在起 shell 子进程和探测沙箱：单独跑 ~0.8s，满载时 4.7s。一个
    // 会被套件自身负载左右的计时断言分不清「劣化」与「机器忙」，只会长期随机
    // 失败，然后被所有人无视。
    //
    // 能可靠测到的是另一个故障模式：装配期死锁 / 某个插件永不 ready —— 那种情况
    // 下永远没有应答，与负载无关。冷启动的实际数字（约 900ms，其中 ~590ms 是加载
    // 依赖树的 import，`composeAgent` 本身只要 ~70ms）记在 README，不在这里执法。
    expect(elapsed).toBeGreaterThan(0)
  }, 30_000)
})

describe('TC-GUARD-02 断连即退出（无孤儿进程）', () => {
  it('stdin 关闭后进程在 5s 内自行退出', async () => {
    const exit = await new Promise<{ code: number | null; ms: number; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      let stdout = ''
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
      )

      // 等它真正跑起来（组合装配完、watcher/定时器都已建立）再断开，
      // 否则测的是「还没来得及持有句柄」，抓不到回归。
      //
      // 就绪信号取 `initialize` 的**应答**而不是一个固定的 sleep：装配要花两三秒
      // （多数时间在加载几十个上游插件），机器一忙就更久，而原先那个 1.2s 的
      // 睡眠短于装配本身——于是断开落在装配中途，恰恰是上面那句注释说要避开的
      // 情形，同时让这条用例的耗时随机器负载浮动。应答发出即证明组合已经就位。
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
        if (!stdout.includes('"protocolVersion"')) return
        child.stdout.removeAllListeners('data')
        const t0 = Date.now()
        child.stdin.end()
        const orphan = setTimeout(() => {
          child.kill('SIGKILL')
          resolve({ code: null, ms: Date.now() - t0, stderr })
        }, 5_000)
        child.on('exit', (code) => {
          clearTimeout(orphan)
          resolve({ code, ms: Date.now() - t0, stderr })
        })
      })
    })

    // code === null 表示只能靠 SIGKILL 收场 —— 编辑器场景下就是一个孤儿进程。
    expect(exit.code, `进程未自行退出（${exit.ms}ms 后被强杀）；stderr=${exit.stderr.slice(0, 400)}`).toBe(0)
  }, 30_000)

  it('技能目录已被监听时同样在 5s 内退出', async () => {
    // 上一条只等到 `initialize`，那时技能 watcher 还不存在：它们是在第一次**列技能**
    // 时按扫到的根建立的，而 `session/new` 要列一次（斜杠补全）。技能热加载开着
    // （boot.ts 的 SkillFilesystem），这条守的就是「watcher 不能拖住进程」。
    const cwd = mkdtempSync(join(tmpdir(), 'dsacp-guard-skills-'))
    mkdirSync(join(cwd, '.git'))
    mkdirSync(join(cwd, '.dsh', 'skills', 'guard-probe'), { recursive: true })
    writeFileSync(
      join(cwd, '.dsh', 'skills', 'guard-probe', 'SKILL.md'),
      '---\nname: guard-probe\ndescription: probe\n---\n\nbody\n',
    )
    const exit = await new Promise<{ code: number | null; ms: number; stderr: string; listed: boolean }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
        let stderr = ''
        let stdout = ''
        let closing = false
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('error', reject)
        for (const frame of [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
          { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } },
        ]) {
          child.stdin.write(`${JSON.stringify(frame)}\n`)
        }
        // 就绪信号是带着这个技能的斜杠目录：它出现，说明技能已经列过、watcher 已建立。
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString()
          if (closing || !stdout.includes('guard-probe')) return
          closing = true
          const t0 = Date.now()
          child.stdin.end()
          const orphan = setTimeout(() => {
            child.kill('SIGKILL')
            resolve({ code: null, ms: Date.now() - t0, stderr, listed: true })
          }, 5_000)
          child.on('exit', (code) => {
            clearTimeout(orphan)
            resolve({ code, ms: Date.now() - t0, stderr, listed: true })
          })
        })
        // 兜底：技能一直没出现时别把用例挂死，交给下面的断言报出来。
        setTimeout(() => {
          if (closing) return
          child.kill('SIGKILL')
          resolve({ code: null, ms: 0, stderr, listed: false })
        }, 20_000)
      },
    )
    expect(exit.listed, `斜杠目录里没出现 guard-probe；stderr=${exit.stderr.slice(0, 400)}`).toBe(true)
    expect(exit.code, `进程未自行退出（${exit.ms}ms 后被强杀）；stderr=${exit.stderr.slice(0, 400)}`).toBe(0)
  }, 30_000)
})

describe('TC-GUARD-01 stdout 纯净性', () => {
  it('stdout 的每一行都是可解析的 JSON-RPC 帧', async () => {
    const run = await runBin([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: tmpdir(), mcpServers: [] } },
    ])

    const lines = run.stdout.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length, `stdout 无输出；stderr=${run.stderr.slice(0, 400)}`).toBeGreaterThan(0)

    for (const line of lines) {
      let parsed: unknown
      expect(() => {
        parsed = JSON.parse(line)
      }, `非 JSON 行：${line.slice(0, 200)}`).not.toThrow()
      expect(parsed).toHaveProperty('jsonrpc', '2.0')
    }
  }, 30_000)

  it('initialize 应答携带本服务端身份', async () => {
    const run = await runBin([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    ])
    const frames = run.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id?: number; result?: { agentInfo?: { name?: string } } })
    const init = frames.find((f) => f.id === 1)
    expect(init?.result?.agentInfo?.name).toBe('deepseek-acp')
  }, 30_000)
})

describe('TC-GUARD-04 CLI 开关', () => {
  /** 带参数起一次子进程，等它自己退出。 */
  async function runArgs(args: string[], timeoutMs = 15_000): Promise<Run> {
    return await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      const cap = setTimeout(() => child.kill(), timeoutMs)
      child.on('close', (code) => {
        clearTimeout(cap)
        resolve({ stdout, stderr, code })
      })
    })
  }

  it('--version 打印版本并退出，不等 stdin', async () => {
    // 没有这条开关时，`deepseek-acp --version` 会照常起 ACP 服务然后静静地等
    // stdin——对人眼就是卡死。这里**不关 stdin**，全靠进程自己退出，所以它同时
    // 钉住了「不等 stdin」这半条。
    const run = await runArgs(['--version'])
    expect(run.code).toBe(0)
    // 比对 `AGENT_INFO` 而非硬编码字面量：版本号本来就会变，写死会让每次改版本
    // 都伴随一次「用例挂了」。真正该钉的「它与 package.json 一致」在
    // `session.spec.ts` 里。
    expect(run.stdout.trim()).toBe(AGENT_INFO.version)
  }, 30_000)

  it('--help 说清楚它不是给人直接用的，并指向探针', async () => {
    const run = await runArgs(['--help'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('ACP')
    expect(run.stdout).toContain('DEEPSEEK_ACP_MODEL')
    expect(run.stdout).toContain('acp-probe.mjs')
  }, 30_000)

  it('未知参数照常起服务 —— 不为此拒绝启动', async () => {
    // 编辑器可能出于自己的理由多传点什么。为一个不认识的参数拒绝启动，
    // 会把一个本来能跑的集成变成一句「连接失败」。
    const run = await runBin(
      [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }],
      15_000,
      ['--some-flag-we-do-not-know'],
    )
    expect(run.stdout).toContain('"protocolVersion"')
  }, 30_000)
})
