/**
 * TC-WSPATH-* —— 工作区路径的同一性判断。
 *
 * 这是一条**授权边界**：`session/load` 与 `session/fork` 拿它决定要不要把一条
 * 历史恢复进请求里的工作区。判错的两个方向代价不对称——
 *
 * - 判「不同」错了：用户加载不了自己的会话，看得见、能报告；
 * - 判「相同」错了：A 项目的历史进了 B 项目的工作区，模型拿着 A 的文件路径去
 *   改 B 的文件，**静默**。
 *
 * 所以这里的重点是那些「看着该相同、其实不同」的拼写。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sameWorkspace, trimTrailingSep } from '../src/session/workspace-path.js'
import { realTempDir } from './temp-dir.js'

describe('TC-WSPATH-01 快路：只去尾分隔符', () => {
  it('去掉尾部分隔符', () => {
    expect(trimTrailingSep(`${sep}a${sep}b${sep}`)).toBe(`${sep}a${sep}b`)
    expect(trimTrailingSep(`${sep}a${sep}b${sep}${sep}`)).toBe(`${sep}a${sep}b`)
    expect(trimTrailingSep(`${sep}a${sep}b`)).toBe(`${sep}a${sep}b`)
  })

  it('文件系统根原样保留 —— 削空了就不是路径了', () => {
    expect(trimTrailingSep(sep)).toBe(sep)
    expect(trimTrailingSep(`${sep}${sep}`)).toBe(`${sep}${sep}`)
  })

  it.runIf(sep === '\\')('盘符根原样保留 —— `C:` 是相对路径，含义不同', () => {
    expect(trimTrailingSep('C:\\')).toBe('C:\\')
    expect(trimTrailingSep('C:\\a\\')).toBe('C:\\a')
  })

  it.runIf(sep === '/')('POSIX 上反斜杠是合法文件名字符，不能当分隔符削', () => {
    // 削了的话 `/a/b\` 与 `/a/b` 会被判成同一个目录，而它们是两个不同的东西。
    expect(trimTrailingSep('/a/b\\')).toBe('/a/b\\')
  })
})

describe('TC-WSPATH-02 同一目录的不同拼写判为相同', () => {
  it('原样相等（含尾分隔符差异）走快路', async () => {
    const dir = realTempDir('dsacp-ws-')
    expect(await sameWorkspace(dir, dir)).toBe(true)
    expect(await sameWorkspace(dir, `${dir}${sep}`)).toBe(true)
  })

  it('符号链接与它的目标是同一个工作区', async () => {
    const root = realTempDir('dsacp-ws-')
    const real = join(root, 'project')
    mkdirSync(real)
    symlinkSync(real, join(root, 'link'), 'junction')
    expect(await sameWorkspace(join(root, 'link'), real)).toBe(true)
  })

  it('未规范化的临时目录与它的真实路径是同一个工作区', async () => {
    // macOS 上 `os.tmpdir()` 是 `/var/folders/…`，真实路径是 `/private/var/…`；
    // Windows 上是 8.3 短名与长名。两者都是**环境自带**的别名，正是这个函数
    // 存在的原因。没有别名的平台（通常是 Linux）这条退化成快路，仍然有效。
    const raw = mkdtempSync(join(tmpdir(), 'dsacp-ws-raw-'))
    expect(await sameWorkspace(raw, realpathSync.native(raw))).toBe(true)
  })
})

describe('TC-WSPATH-03 看着该相同、其实不同的拼写', () => {
  it('`link/../sibling` 与 `sibling` 不是同一个目录', async () => {
    // 这条是 `resolve()` 快路的反例：它在不知道符号链接的情况下先折叠 `..`，
    // 于是把下面这两个词法相同、实际指向不同位置的路径判成同一个。
    const root = realTempDir('dsacp-ws-')
    const outside = join(root, 'outside')
    mkdirSync(join(outside, 'project'), { recursive: true })
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'project'), { recursive: true })
    symlinkSync(join(outside, 'nested'), join(repo, 'link'), 'junction')
    mkdirSync(join(outside, 'nested', 'project'), { recursive: true })

    // **不能用 `join()` 拼**：它自己就会把 `link/..` 折叠掉，拼出来的正好是
    // `repo/project`，于是这条用例测的变成「同一个字符串等于自己」。要测的那个
    // `..` 必须原样留在串里。
    const viaLink = `${repo}${sep}link${sep}..${sep}project`
    const direct = join(repo, 'project')
    expect(await sameWorkspace(viaLink, direct)).toBe(false)
    // 顺带钉住反例本身成立：这两个串在词法上确实会被折叠成同一个。
    expect(resolve(viaLink)).toBe(resolve(direct))
  })

  it('两个各自独立的目录不是同一个工作区', async () => {
    expect(await sameWorkspace(realTempDir('dsacp-ws-a-'), realTempDir('dsacp-ws-b-'))).toBe(false)
  })
})

describe('TC-WSPATH-04 解析不了就判不同（fail-closed）', () => {
  it('目录已不存在时判不同 —— 「路径没了」不是放行的理由', async () => {
    const gone = realTempDir('dsacp-ws-gone-')
    const alive = realTempDir('dsacp-ws-')
    rmSync(gone, { recursive: true, force: true })
    expect(await sameWorkspace(gone, alive)).toBe(false)
  })

  it('但拼写原样相同时仍判相同 —— 与今天的裸相等行为一致', async () => {
    // 快路不读文件系统，所以这里不会因为目录不存在而拒绝加载一条会话。
    const gone = realTempDir('dsacp-ws-gone-')
    rmSync(gone, { recursive: true, force: true })
    expect(await sameWorkspace(gone, gone)).toBe(true)
  })
})
