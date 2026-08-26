/**
 * 工作区路径的同一性判断。
 *
 * 路径不是字符串。同一个目录可以有多种拼写——Windows 的 8.3 短名、macOS 的
 * `/var` → `/private/var` 符号链接、目录联接、大小写差异——而 `session/load`
 * 与 `session/fork` 拿「请求里的 cwd 是否等于日志里记着的 cwd」当**授权边界**：
 * 判错一次，A 项目的历史就恢复进了 B 项目的工作区，模型会拿着 A 的文件路径去
 * 改 B 的文件。
 *
 * **但不能靠词法归一去凑。** 两种看着都对的写法都是错的：
 *
 * - 折叠大小写：Windows 支持按目录开启大小写敏感（`fsutil file
 *   setCaseSensitiveInfo`），`\\wsl$` 与大小写敏感的 UNC/NFS 同理，同一目录下
 *   可以并存 `Foo` 与 `foo`。折叠会把两个不同的工作区判成一个。
 * - `resolve()`：它在**不知道符号链接的情况下先折叠 `..`**。`a/link/../b` 与
 *   `a/b` 在词法上相同，而 `link` 指向别处时两者是完全不同的目录（本机实测）。
 *
 * 因此快路**只做可证明身份中性的那一步**——去掉尾部分隔符——其余一律交给
 * `realpath.native`。这是一条授权边界，省 I/O 不值得拿它换。
 * @module
 */

import { realpath } from 'node:fs'
import { sep } from 'node:path'
import { promisify } from 'node:util'

/**
 * **必须是 `.native`。** `fs/promises` 的 `realpath` 没有 `.native`（实测是
 * `undefined`），而只有 native 版走 `GetFinalPathNameByHandle`，在 Windows 上
 * 展开 8.3 短名并给出磁盘上真实的大小写。非 native 版只解符号链接，
 * `C:\Users\RUNNER~1` 会原样留着。
 */
const realpathNative = promisify(realpath.native)

const CHAR_SLASH = 0x2f
const CHAR_BACKSLASH = 0x5c
const CHAR_COLON = 0x3a

/**
 * 是否是路径分隔符。
 *
 * POSIX 上**只认正斜杠**：反斜杠在那里是合法的文件名字符，把它当分隔符削掉会
 * 让 `/a/b\` 与 `/a/b` 这两个不同的文件被判成同一个。
 */
function isSep(code: number): boolean {
  return code === CHAR_SLASH || (sep === '\\' && code === CHAR_BACKSLASH)
}

/**
 * 去掉尾部分隔符，**保留文件系统根**。
 *
 * 刻意**不**调 `resolve()`：见模块注释，`..` 的折叠在有符号链接时不保身份。
 *
 * 削不干净的两种情况原样返回，交给 `realpath` 去判——快路的职责是「确定相同时
 * 省一次 I/O」，拿不准时退回慢路永远是安全的：
 *
 * - `C:\` 削成 `C:` 会**改变含义**（后者是「C 盘上的当前目录」，一个相对路径）；
 * - `/`、`//`、`\\` 全是分隔符，削完什么都不剩。
 * @param path - 任意路径
 * @returns 去掉尾部分隔符后的路径
 */
export function trimTrailingSep(path: string): string {
  let end = path.length
  while (end > 1 && isSep(path.charCodeAt(end - 1))) end--
  if (end === path.length) return path
  if (end === 1 && isSep(path.charCodeAt(0))) return path
  if (end === 2 && path.charCodeAt(1) === CHAR_COLON) return path
  return path.slice(0, end)
}

/**
 * 两个路径是否指向同一个工作区。
 *
 * 去尾分隔符后**原样相等**即同一，零 I/O——这是唯一安全的快路。其余一切拼写
 * 差异（大小写、8.3 短名、`..`、符号链接、目录联接）都各自解析一次真实路径
 * 再比。
 *
 * **解析不了就判不同（fail-closed）**：「路径已不存在」不是放行的理由，而这
 * 与今天的行为一致——今天拼写不等也是拒绝。宁可拒错，不可放错。
 * @param a - 一个绝对路径
 * @param b - 另一个绝对路径
 * @returns 指向同一个目录则 true
 */
export async function sameWorkspace(a: string, b: string): Promise<boolean> {
  if (trimTrailingSep(a) === trimTrailingSep(b)) return true
  try {
    const [realA, realB] = await Promise.all([realpathNative(a), realpathNative(b)])
    return realA === realB
  } catch {
    return false
  }
}
