/**
 * 直接读会话日志**物件**的测试夹具。
 *
 * 有些用例的判据必须是磁盘上的字节，而不是任何一个后端接口的返回值：
 *
 *  - TC-SESS-09（`prompt-durability.spec.ts`）断的是「应答返回时那一轮已经落
 *    盘」。走后端读会把这条命题偷换成「后端认为它可见」——写入是按窗口批量合并
 *    的，缓冲里的内容对后端可见、对崩溃后的下一个进程不可见，而后者才是那条
 *    用例存在的理由。
 *  - TC-MISSING-03 要制造一条**头部损坏**的日志，得先找到文件再改它的第一行。
 *
 * 因此这里绕过 `ctx.sessionPersistence` 直接走 `node:fs`。这当然把用例绑在了
 * JSONL 后端上，但那两条用例本来就是绑着的（一条断原始 JSON 文本，一条要写坏
 * 一行），假装通用没有意义。
 * @module
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 在会话根目录下递归找出那条日志文件。
 *
 * 文件名带**格式代号**：v0 是光秃秃的 `session.jsonl`，之后每一代加一个 `.vN`
 * （当前是 `session.v3.jsonl`）。写死某一代会让这个 helper 在下一次格式升级时
 * 静默返回 `undefined`，而用例读起来像是「录制根本没落盘」——这个坑实测踩过。
 * @param root - `sessionsRoot`
 * @returns 日志文件的绝对路径；一个都没有时 `undefined`
 */
export function findSessionLog(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && /^session(\.v\d+)?\.jsonl$/.test(entry.name)) return path
    if (entry.isDirectory()) {
      const nested = findSessionLog(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * 日志文件此刻在磁盘上的原始内容。
 *
 * **不重试、不等待**：调用方要断的正是「此刻就已经在那里」，补一次轮询就等于把
 * 那个竞态窗口调大到必然通过。
 *
 * 测试组合挂的是 `compression: 'none'`，所以这就是可直接匹配的 JSON 文本。
 * @param root - `sessionsRoot`
 * @returns 文件内容；物件还不存在时 `undefined`
 */
export function readSessionLog(root: string): string | undefined {
  const path = findSessionLog(root)
  return path === undefined ? undefined : readFileSync(path, 'utf8')
}
