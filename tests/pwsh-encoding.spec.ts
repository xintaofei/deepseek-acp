/**
 * TC-PWSHENC-* —— `read-only` 下原生子进程的非 ASCII 输出编码（Windows 专用）。
 *
 * **为什么单独一个文件、单独一次 vitest 调用**：这组用例要临时改**控制台的
 * 全局代码页**。`vitest.config.ts` 在 Windows 上跑两个 worker，代码页一改，另
 * 一个 worker 上正在跑的 shell 用例就拿到了错的代码页——轻则无关用例随机翻车，
 * 重则给这里一个假结论。`describe.sequential` 挡不住这件事：它只排序**文件内**
 * 的用例。因此主 `npm test` 用 `exclude` 把本文件排除，由
 * `npm run test:encoding`（`vitest.encoding.config.ts`，单 worker）单独跑。
 *
 * **测的是什么**：`src/composition/pwsh-compat.ts` 设了 `$OutputEncoding`（管
 * PowerShell **发给**原生程序的编码），却把 `[Console]::OutputEncoding`（管原生
 * 程序输出**回来**怎么解码）关在 `FullLanguage` 分支里——而 `read-only` 恰好是
 * ConstrainedLanguage 的那一档。现有用例整整绕开了这个缺口：受限那条用的是托管
 * 的 `Write-Output`（PowerShell 自己编码），而真跑 `node.exe` / `cmd.exe` 的探针
 * 全是 ASCII。
 *
 * **先测量，再修。** 这个文件只回答「到底失不失真」。修法（preamble 里加
 * `chcp.com 65001`）与兜底（按模式的 fail-closed 闸门）按这里的结论决定。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

const WINDOWS_POWERSHELL = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const POWERSHELL_7 = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')

/** 期望原样回来的那两串。`中文` = U+4E2D U+6587。 */
const WANT_STDOUT = '中文-out'
const WANT_STDERR = '中文-err'

/**
 * 让 `node.exe` 打出非 ASCII 的一行 PowerShell。
 *
 * 非 ASCII 用 `String.fromCharCode` 现拼，**命令本身保持纯 ASCII**：否则
 * 「命令怎么传进去」与「输出怎么传回来」两个编码问题会混在一起，红了也不知道
 * 是哪一头。这里只想测回来的那一头。
 * @param stream - 写到哪个流
 */
function probeCommand(stream: 'stdout' | 'stderr'): string {
  // '中文-out' / '中文-err'
  const codes =
    stream === 'stdout' ? '20013,25991,45,111,117,116' : '20013,25991,45,101,114,114'
  const script = `process.${stream}.write(String.fromCharCode(${codes}))`
  return `& '${process.execPath.replaceAll("'", "''")}' -e '${script}'`
}

/**
 * 读当前控制台代码页。
 * @returns 代码页；没有控制台或读不出来时 undefined
 */
function readCodePage(): number | undefined {
  try {
    const out = execFileSync('chcp.com', { encoding: 'ascii', stdio: ['ignore', 'pipe', 'ignore'] })
    // 输出被本地化过（「Active code page: 437」/「活动代码页: 936」），只取末尾数字。
    const match = /(\d+)\s*$/.exec(out.trim())
    return match?.[1] === undefined ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

/** 设代码页。设没设上由调用方**读回**判断，这里不报错。 */
function setCodePage(codePage: number): void {
  try {
    execFileSync('chcp.com', [String(codePage)], { stdio: 'ignore' })
  } catch {
    // 没有附着控制台，或这台机器没装这个代码页。读回校验会发现，用例据此判红
    // ——**吞掉的是异常，不是结论**。
  }
}

/** 对抗性代码页。UTF-8 是 65001；跑在它上面的绿灯什么都不证明。 */
const ADVERSARIAL_CODE_PAGE = 936

describe.skipIf(process.platform !== 'win32')('TC-PWSHENC read-only 下的原生输出编码', () => {
  /** 进本组用例时控制台真正在用的代码页；失败消息里要带上它，否则结论无从解读。 */
  let effective: number | undefined
  let original: number | undefined

  beforeAll(() => {
    original = readCodePage()
    // **在被测命令之外**建立代码页。写进 `spec.command` 是不行的：将来 F2b 的
    // preamble 会先把它设成 65001，命令再改回 936，测的就不是要测的东西了。
    //
    // **只在还得回去的时候才动它。** 代码页是同一个 CI step 里后续命令共享的
    // 全局状态，而下面的 `afterAll` 只能还原到读到过的那个值。原始值读不出来
    // 就一个字节都不改——「测不了」由 {@link assertAdversarialCodePage} 判红，
    // 不靠留下一个改坏了的控制台来表达。
    if (original !== undefined) setCodePage(ADVERSARIAL_CODE_PAGE)
    effective = readCodePage()
  })

  afterAll(() => {
    // 这一轮只跑这一个文件，但进程仍然共享控制台——不还回去就把 936 留给了
    // 同一个 CI step 里后面的命令。与上面的条件严格配对：没读到原始值就没设过，
    // 没设过就没有东西需要恢复。
    if (original !== undefined) setCodePage(original)
  })

  /**
   * 断言这一轮**确实**跑在对抗性代码页上。
   *
   * **建不起来必须红，不能跳过、更不能默默继续。** 这个文件是一次**测量**，它
   * 的绿灯要拿来决定 F2b / F2c 做不做：跑在 65001 上的绿灯恒真，会把「没验证过」
   * 报成「没有缺口」。而 skip 在 CI 里退出码是 0，`release.yml` 会带着一份并不
   * 存在的覆盖发版——正是这套配置要防的那个静默漏洞。宁可红在「测不了」上。
   *
   * 每条探针都各自调一次：vitest 的用例彼此独立，只靠下面那条独立用例把关的话，
   * 它红了探针照样会跑，照样可能给出一个绿灯。
   */
  function assertAdversarialCodePage(): void {
    expect(
      effective,
      `本轮代码页 ${String(effective)}（原始 ${String(original)}）。测量必须跑在 ` +
        `${String(ADVERSARIAL_CODE_PAGE)} 上：65001 下这条用例恒绿，证明不了缺口不存在。` +
        'chcp 设不上通常意味着这个进程没有附着控制台。',
    ).toBe(ADVERSARIAL_CODE_PAGE)
  }

  /**
   * 在 `read-only` 下跑两条探针，返回模型会读到的文本。
   * @param pwshPath - 用哪个 PowerShell
   */
  async function roundTrip(pwshPath: string): Promise<{ stdout: string; stderr: string }> {
    assertAdversarialCodePage()
    const h = await createHarness({ shell: 'sandbox', pwshPath })
    try {
      const workdir = realTempDir('dsacp-enc-')
      const out = await h.ctx.shell.run(h.ctx.shell.resolve({ command: probeCommand('stdout'), workdir }))
      const err = await h.ctx.shell.run(h.ctx.shell.resolve({ command: probeCommand('stderr'), workdir }))
      expect(out.exitCode, out.stderr.text).toBe(0)
      expect(err.exitCode).toBe(0)
      return { stdout: out.stdout.text, stderr: err.stderr.text }
    } finally {
      await h.retire()
    }
  }

  it('本轮确实跑在代码页 936 上 —— 否则下面两条的绿灯不作数', () => {
    // 单独一条，是为了让「测量环境没建起来」与「编码真的失真」在报告里分得开：
    // 前者红在这里，后者红在下面。
    assertAdversarialCodePage()
  })

  it.skipIf(!existsSync(WINDOWS_POWERSHELL))(
    'Windows PowerShell 5.1：node.exe 的非 ASCII 输出原样到达模型',
    async () => {
      // 这一档是可疑的那个：`read-only` 下它是 ConstrainedLanguage，
      // `[Console]::OutputEncoding` 没被设过，于是按控制台代码页解码 UTF-8 字节。
      const { stdout, stderr } = await roundTrip(WINDOWS_POWERSHELL)
      expect(stdout, `代码页 ${String(effective)} 下 stdout 失真`).toContain(WANT_STDOUT)
      expect(stderr, `代码页 ${String(effective)} 下 stderr 失真`).toContain(WANT_STDERR)
    },
    180_000,
  )

  it.skipIf(!existsSync(POWERSHELL_7))(
    'PowerShell 7：同一条探针也必须原样回来',
    async () => {
      // 对照组。PS 7 默认把 `[Console]::OutputEncoding` 设成 UTF-8，因此它**应该**
      // 是绿的。两档一起看才能把「缺口」定位到 5.1，而不是笼统归给 `read-only`。
      const { stdout, stderr } = await roundTrip(POWERSHELL_7)
      expect(stdout, `代码页 ${String(effective)} 下 stdout 失真`).toContain(WANT_STDOUT)
      expect(stderr, `代码页 ${String(effective)} 下 stderr 失真`).toContain(WANT_STDERR)
    },
    180_000,
  )
})
