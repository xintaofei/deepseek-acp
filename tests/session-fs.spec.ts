/**
 * TC-FS-* —— 会话作用域的读改道（US-25）。
 *
 * 断的是装饰器本身的契约，与工具层分开：`DelegatedReadFileSystem` 是一个
 * 12 个抽象成员的实现，其中**只有两个**该改变行为。转发漏一个不会报错，只会
 * 在某条冷路径上悄悄换掉语义——所以这里逐项钉。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it } from 'vitest'
import { clientTextReader, type RequestFn } from '../src/answerers/fs-read.js'
import { DelegatedReadFileSystem, type ClientTextReader } from '../src/composition/session-fs.js'
import { createHarness, type TestHarness } from './harness.js'
import { aliasDir, realTempDir } from './temp-dir.js'

const DISK = '磁盘上的旧内容\n'
const BUFFER = '编辑器里没保存的新内容\n'

interface Fixture {
  base: FileSystem
  file: string
  /** 每次委托调用收到的路径，按顺序 */
  asked: string[]
}

/**
 * 一个真的本地后端 + 一个真的文件；装饰器套在它外面。
 *
 * 走 `ctx.plugin` 而不是 `new LocalFileSystem(ctx, {})`：schemastery 的默认值
 * 是在插件装配时套上去的，直接 new 会拿着空 config 撞进「diffBasisMaxBytes
 * 必须是正整数」。
 */
async function fixture(): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, {})
  const dir = realTempDir('dsacp-fs-')
  const file = join(dir, 'a.txt')
  writeFileSync(file, DISK, 'utf8')
  return { base: ctx.fs, file, asked: [] }
}

/** 把 `reader` 套到 `f.base` 上，并记录每次委托调用。 */
function decorate(f: Pick<Fixture, 'base' | 'asked'>, reader: ClientTextReader): FileSystem {
  const ctx = new Context()
  return new DelegatedReadFileSystem(ctx, {
    base: f.base,
    read: async (path, opts) => {
      f.asked.push(path)
      return reader(path, opts)
    },
  })
}

let f: Fixture
beforeEach(async () => {
  f = await fixture()
})

describe('TC-FS-01 读改道', () => {
  it('客户端给得出内容时，读到的是缓冲区那份而不是磁盘那份', async () => {
    const fs = decorate(f, async () => BUFFER)
    const target = await fs.resolve(f.file)
    expect(await fs.readText(target)).toBe(BUFFER)
    // 委托拿到的是**后端执行世界里的绝对路径**：客户端按路径找它打开的缓冲区，
    // 给它一个相对路径或 targetKey 都会让它找不到而静默回落。
    expect(f.asked).toEqual([f.file])
  })

  it('客户端给不出时回落磁盘 —— undefined 是「走磁盘」不是「空文件」', async () => {
    // 这两者混淆的后果很具体：模型会认为文件是空的，然后「补全」它。
    const fs = decorate(f, async () => undefined)
    const target = await fs.resolve(f.file)
    expect(await fs.readText(target)).toBe(DISK)
    // 只问一次：这个夹具里调用方拼写与规范化拼写相同，TC-FS-06 的别名兜底
    // 不该给这个常态多加一次 ACP 往返。
    expect(f.asked).toEqual([f.file])
  })

  it('大文件那条流式读路径同样改道 —— 两条读路径不能分叉', async () => {
    // `dsh-tool-fs` 按文件大小在 readText 与 streamText 之间选，只改一条等于
    // 「小文件看得到未保存内容、大文件看不到」，而这个阈值对用户不可见。
    const fs = decorate(f, async () => BUFFER)
    const target = await fs.resolve(f.file)
    let text = ''
    for await (const chunk of await fs.streamText(target)) text += chunk
    expect(text).toBe(BUFFER)
  })

  it('流式读也遵守回落', async () => {
    const fs = decorate(f, async () => undefined)
    const target = await fs.resolve(f.file)
    let text = ''
    for await (const chunk of await fs.streamText(target)) text += chunk
    expect(text).toBe(DISK)
  })
})

describe('TC-FS-02 写与 edit 不改道', () => {
  it('writeText 落到磁盘，且完全不问客户端', async () => {
    const fs = decorate(f, async () => BUFFER)
    const target = await fs.resolve(f.file)
    await fs.writeText(target, '写入的内容\n')
    expect(readFileSync(f.file, 'utf8')).toBe('写入的内容\n')
    // 一次委托都没发生：写一旦经客户端，就绕开了 `dsh-fs-sandbox` 的围栏。
    expect(f.asked).toEqual([])
  })

  it('editText 对**磁盘**内容做字面匹配，不用缓冲区那份', async () => {
    // 这是本设计已知且接受的代价：读到的是缓冲区、改的是磁盘。钉住它是为了
    // 让「哪天有人顺手把 edit 也改道了」变成一次红灯，而不是一次静默的越界写。
    const fs = decorate(f, async () => BUFFER)
    const target = await fs.resolve(f.file)
    const outcome = await fs.editText(target, {
      oldString: '磁盘上的旧内容',
      newString: '改过了',
      replaceAll: false,
    })
    expect(outcome).toBeDefined()
    expect(readFileSync(f.file, 'utf8')).toBe('改过了\n')
    expect(f.asked).toEqual([])
  })

  it('readBytes 不改道 —— fs/read_text_file 没有字节语义', async () => {
    const fs = decorate(f, async () => BUFFER)
    const target = await fs.resolve(f.file)
    const bytes = await fs.readBytes(target, undefined, 1024)
    expect(new TextDecoder().decode(bytes)).toBe(DISK)
    expect(f.asked).toEqual([])
  })
})

describe('TC-FS-03 能力事实必须透传', () => {
  it('sandboxMode 转发底座的值 —— 不转发就等于静默关掉整条围栏', async () => {
    // `dsh-tool-fs` 读到 undefined 会连 `sandboxPolicy` 都不去取，于是每次写
    // 都是无围栏的 `writeText`。基类的默认实现**正好**返回 undefined，所以
    // 「忘了 override」的失败模式是最坏的那种：一切照常，只是围栏没了。
    const fenced = {
      get sandboxMode(): SandboxMode {
        return 'workspace-write'
      },
    } as FileSystem
    const ctx = new Context()
    const fs = new DelegatedReadFileSystem(ctx, { base: fenced, read: async () => undefined })
    expect(fs.sandboxMode).toBe('workspace-write')
  })

  it('底座不约束时也如实报告 undefined，不自己编一个', async () => {
    const fs = decorate(f, async () => undefined)
    // `LocalFileSystem` 自己的文档写明 cwd 只是解析默认值、不是 containment
    // 边界，它报 undefined 是诚实的；装饰器不该把它「修」成有约束。
    expect(fs.sandboxMode).toBeUndefined()
  })

  it('身份类方法转发到底座 —— 两侧算出的 targetKey 必须是同一个', async () => {
    const fs = decorate(f, async () => undefined)
    const viaDecorator = await fs.resolve(f.file)
    const viaBase = await f.base.resolve(f.file)
    expect(viaDecorator.targetKey).toBe(viaBase.targetKey)
    expect(fs.processPath(viaDecorator)).toBe(f.base.processPath(viaBase))
    expect(fs.fileUrl(viaDecorator)).toBe(f.base.fileUrl(viaBase))
    expect(fs.contains(await fs.resolve(join(f.file, '..')), viaDecorator)).toBe(true)
  })

  it('stat / listDir 透传', async () => {
    const fs = decorate(f, async () => BUFFER)
    const target = await fs.resolve(f.file)
    const info = await fs.stat(target)
    // 大小取自磁盘：`stat` 是元数据，客户端那份没有权威的 size/mtime。
    expect(info?.size).toBe(Buffer.byteLength(DISK))
    const dir = await fs.resolve(join(f.file, '..'))
    expect((await fs.listDir(dir)).map((e) => e.name)).toContain('a.txt')
    expect(f.asked).toEqual([])
  })
})

/**
 * 造一份「同一个文件、两种拼写」的夹具：`link/a.txt` 与 `real/a.txt` 是同一个
 * 文件，前者未经 realpath。
 * @returns 两种拼写；建不出目录链接时 undefined
 */
function makeAlias(): { real: string; alias: string } | undefined {
  const dirs = aliasDir('dsacp-fs-alias-')
  if (dirs === undefined) return undefined
  writeFileSync(join(dirs.real, 'a.txt'), DISK, 'utf8')
  return { real: join(dirs.real, 'a.txt'), alias: join(dirs.alias, 'a.txt') }
}

const ALIAS = makeAlias()

describe('TC-FS-06 路径别名：委托必须问到编辑器手里那份缓冲区', () => {
  if (ALIAS === undefined) {
    // 留一条**看得见**的跳过记录：整组静默消失等于没有这份覆盖，而这正是
    // 本项目在 Windows 上栽过的那个跟头。
    it.skip('需要支持重解析点/符号链接的文件系统，本机建不出目录链接', () => {})
    return
  }
  const { alias } = ALIAS

  let base: FileSystem
  let asked: string[]
  /**
   * 委托实际会发出的第一个拼写。
   *
   * **取自被测系统自己**（`processPath`），不在测试里重算一遍 realpath：上游
   * `LocalFileSystem` 用的是 `fs/promises` 的 `realpath`（非 `.native`），测试
   * 若挑了另一个变体，在 Windows 上就会与被测对象对不上而给出假结论。
   */
  let canonical: string

  beforeEach(async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, {})
    base = ctx.fs
    asked = []
    canonical = base.processPath(await base.resolve(alias))
  })

  /** 只认某一个拼写：命中给缓冲区，其余一律「给不出」。 */
  function onlyForPath(want: string): ClientTextReader {
    return async (path) => (path === want ? BUFFER : undefined)
  }

  it('前提成立：两种拼写不同，但指向同一个文件', () => {
    expect(canonical).not.toBe(alias)
    expect(readFileSync(canonical, 'utf8')).toBe(readFileSync(alias, 'utf8'))
  })

  it('规范化拼写命中时只问一次 —— 兜底不该给常态加一次往返', async () => {
    const fs = decorate({ base, asked }, onlyForPath(canonical))
    expect(await fs.readText(await fs.resolve(alias))).toBe(BUFFER)
    expect(asked).toEqual([canonical])
  })

  it('编辑器只认调用方拼写时，改问它 —— 而不是静默把磁盘上的旧内容交给模型', async () => {
    // 这条钉的是一次**静默降级**：编辑器手里是改脏了的缓冲区，我们按 realpath
    // 去问、它按自己那份拼写找不到，于是模型拿到上次保存的版本去改新文件，
    // 而卡片上完全看不出发生过降级。
    const fs = decorate({ base, asked }, onlyForPath(alias))
    const text = await fs.readText(await fs.resolve(alias))
    expect(text).toBe(BUFFER)
    expect(text).not.toBe(DISK)
    // 顺序不能反：规范化拼写在前。反过来会在「编辑器改脏的是链接目标、模型
    // 走的是链接路径」时打开一个从磁盘新建的缓冲区，从此问不到那份脏数据。
    expect(asked).toEqual([canonical, alias])
  })

  it('两个拼写都落空才回落磁盘', async () => {
    const fs = decorate({ base, asked }, async () => undefined)
    expect(await fs.readText(await fs.resolve(alias))).toBe(DISK)
    expect(asked).toEqual([canonical, alias])
  })

  it('streamText 与 readText 同源 —— 大文件那条路不能只问一个拼写', async () => {
    const fs = decorate({ base, asked }, onlyForPath(alias))
    let text = ''
    for await (const chunk of await fs.streamText(await fs.resolve(alias))) text += chunk
    expect(text).toBe(BUFFER)
    expect(asked).toEqual([canonical, alias])
  })

  it('第二个拼写命中时，诊断里不该出现「回落磁盘」—— 那一行会说谎', async () => {
    // 装的是真的 `clientTextReader`，不是测试替身：会不会说谎取决于它与
    // `askClient` 之间那个 `final` 约定，只测其中一半等于没测。
    const warned: string[] = []
    const read = clientTextReader(
      SessionId('s-alias'),
      async (_method, params) => {
        if (params.path !== alias) throw new Error('client has no buffer for this file')
        return { content: BUFFER }
      },
      (message) => warned.push(message),
    )
    const fs = new DelegatedReadFileSystem(new Context(), { base, read })
    expect(await fs.readText(await fs.resolve(alias))).toBe(BUFFER)
    expect(warned).toEqual([])
  })

  it('两个拼写都落空时，「回落磁盘」只记一行 —— 不是每个候选一行', async () => {
    const warned: string[] = []
    const read = clientTextReader(
      SessionId('s-alias'),
      async () => {
        throw new Error('client has no buffer for this file')
      },
      (message) => warned.push(message),
    )
    const fs = new DelegatedReadFileSystem(new Context(), { base, read })
    expect(await fs.readText(await fs.resolve(alias))).toBe(DISK)
    expect(warned).toHaveLength(1)
    // 记的是**最后**那个候选：那才是真正走到磁盘的那一次。
    expect(warned[0]).toContain(alias)
  })
})

describe('TC-FS-07 委托的诊断：`final` 决定何时记「回落磁盘」', () => {
  /** 造一个读委托，返回它与它记下的诊断行。 */
  function reader(respond: RequestFn): { read: ClientTextReader; warned: string[] } {
    const warned: string[] = []
    return { read: clientTextReader(SessionId('s-1'), respond, (m) => warned.push(m)), warned }
  }

  const boom: RequestFn = async () => {
    throw new Error('nope')
  }

  it('非最后一个候选落空时保持安静 —— 后面还有一次机会', async () => {
    const { read, warned } = reader(boom)
    expect(await read('/a.txt', { final: false })).toBeUndefined()
    expect(warned).toEqual([])
  })

  it('最后一个候选落空才记 —— 这时才真的要读磁盘了', async () => {
    const { read, warned } = reader(boom)
    expect(await read('/a.txt', { final: true })).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('/a.txt')
    expect(warned[0]).toContain('nope')
  })

  it('省略 opts 时按「最后一个候选」处理 —— 少写一个实参不该让诊断消失', async () => {
    const { read, warned } = reader(boom)
    expect(await read('/a.txt')).toBeUndefined()
    expect(warned).toHaveLength(1)
  })

  it('客户端不报错地给不出内容，同样算一次回落', async () => {
    // 以前这条路一行不记。两段式下它还会吃掉前一个候选的错误（那个已经按
    // `final: false` 保持安静），于是整次回落变得毫无痕迹。
    const { read, warned } = reader(async () => ({}))
    expect(await read('/a.txt')).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('no content')
  })

  it('空字符串是命中不是落空 —— 不记诊断，也不读磁盘', async () => {
    // 混淆这两者的后果很具体：模型会认为文件是空的，然后「补全」它。
    const { read, warned } = reader(async () => ({ content: '' }))
    expect(await read('/a.txt')).toBe('')
    expect(warned).toEqual([])
  })
})

describe('TC-FS-04 端到端：ACP 反向请求 → read 工具', () => {
  /** 让模型调一次 `read`，返回工具结果里的文本。 */
  async function readViaTool(h: TestHarness, path: string): Promise<string> {
    const { sessionId } = await h.acp.request('session/new', { cwd: dirname(path), mcpServers: [] })
    h.llm.toolCall = { id: 'read-1', name: 'read', args: JSON.stringify({ file_path: path }) }
    const cards: { kind: string; raw: unknown }[] = []
    h.onUpdate((raw) => {
      const u = raw as { sessionUpdate: string }
      if (u.sessionUpdate.startsWith('tool_call')) cards.push({ kind: u.sessionUpdate, raw })
    })
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '读一下' }] })
    return JSON.stringify(cards)
  }

  it('客户端声明了能力，读就走 fs/read_text_file 并拿到缓冲区内容', async () => {
    const h = await createHarness({ fs: true, fsRead: true })
    const dir = realTempDir('dsacp-e2e-')
    const file = join(dir, 'buf.txt')
    writeFileSync(file, DISK, 'utf8')
    h.setFsReadResponder(() => ({ content: BUFFER }))

    const rendered = await readViaTool(h, file)

    // 委托确实发生了，且带的是本会话的 id 与绝对路径。
    expect(h.fsReads).toHaveLength(1)
    expect(h.fsReads[0]?.path).toBe(file)
    // 卡片里出现的是缓冲区那份 —— 整条链（能力位 → 委托 → 装饰器 → 工具）通了。
    expect(rendered).toContain('编辑器里没保存的新内容')
    expect(rendered).not.toContain('磁盘上的旧内容')
    h.disposeBridge()
  }, 30_000)

  it('客户端报错时静默回落磁盘 —— 委托只是锦上添花，不该有让 read 挂掉的权力', async () => {
    const h = await createHarness({ fs: true, fsRead: true })
    const dir = realTempDir('dsacp-e2e-fail-')
    const file = join(dir, 'buf.txt')
    writeFileSync(file, DISK, 'utf8')
    // 不设应答器，用默认的那个：它抛「client has no buffer for this file」。

    const rendered = await readViaTool(h, file)

    expect(h.fsReads).toHaveLength(1)
    expect(rendered).toContain('磁盘上的旧内容')
    h.disposeBridge()
  }, 30_000)

  it('客户端没声明能力就一次委托都不发 —— 声明与调用同一个真值来源', async () => {
    // 反面很重要：SDK 两侧都写着「Only available if the client advertises」，
    // 没声明还调等于对着没注册的方法发请求，拿回 methodNotFound。
    const h = await createHarness({ fs: true })
    // **必须自己握一次手**：不带 `fsRead` 时 harness 不代劳 initialize，而没
    // 握手就根本走不到能力判定那一行——这条用例会因为「没协商过」而通过，
    // 与「协商过、判定为不支持」是两回事。这里显式声明 false 才钉得住后者。
    await h.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    const dir = realTempDir('dsacp-e2e-nocap-')
    const file = join(dir, 'buf.txt')
    writeFileSync(file, DISK, 'utf8')
    h.setFsReadResponder(() => ({ content: BUFFER }))

    const rendered = await readViaTool(h, file)

    expect(h.fsReads).toEqual([])
    expect(rendered).toContain('磁盘上的旧内容')
    h.disposeBridge()
  }, 30_000)
})
