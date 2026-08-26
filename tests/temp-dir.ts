/**
 * 测试用的临时目录夹具。
 *
 * **`realpathSync.native` 而不是 `realpathSync`。** 两者都解符号链接，但只有
 * native 版走 `GetFinalPathNameByHandle`，把 Windows 的 8.3 短名
 * （`C:\Users\RUNNER~1\AppData\Local\Temp\…`）展开成长名并给出磁盘上真实的大小写。
 * 子进程报的是长名——PowerShell 的 `(Get-Location).Path` 就是——测试拿短名去比
 * 会在 Windows CI 上失败，而在开发机上完全看不见。
 *
 * 这个模块存在的另一个理由：这段夹具原先在 18 个用例文件里各写了一份，改一处
 * 修不了另外十七处。
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 一个真实存在的临时目录，路径已完全规范化。
 * @param prefix - 目录名前缀，失败时用来认出是哪组用例留下的
 * @returns 绝对路径
 */
export function realTempDir(prefix = 'dsacp-'): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * 造一对「同一个目录、两种拼写」的路径。
 *
 * **主动建目录链接，而不是指望环境自带的别名。** macOS 的 `/var` →
 * `/private/var` 与 Windows 的 8.3 短名都能产生别名，但那是环境事实不是保证，
 * Linux 上的 `/tmp` 通常就没有——指望它，这类用例会在最需要它的平台上安静地
 * 不存在。
 *
 * 用 `'junction'` 类型是为了 Windows：目录联接不需要特权，而符号链接默认需要。
 * 该实参在其它平台被忽略。
 * @param prefix - 目录名前缀
 * @returns 真实目录与它的别名；文件系统不支持重解析点时 undefined
 */
export function aliasDir(prefix = 'dsacp-alias-'): { real: string; alias: string } | undefined {
  const root = realTempDir(prefix)
  const real = join(root, 'real')
  mkdirSync(real)
  const alias = join(root, 'link')
  try {
    symlinkSync(real, alias, 'junction')
  } catch {
    return undefined
  }
  return { real, alias }
}
