/**
 * 会话作用域的文件系统：把**读**改道到编辑器，其余原样交给根后端（US-25）。
 *
 * 为什么值得改道：编辑器手里的是缓冲区，磁盘上的是上次保存的版本。用户改了没
 * 存，agent 走磁盘就读到旧的，然后基于旧内容去改新文件。ACP 的
 * `fs/read_text_file` 就是为这件事存在的。
 *
 * 为什么**只**改读：
 *
 * 1. 写和 edit 一旦委托出去，就绕开了 `dsh-fs-sandbox` 的策略围栏——那道围栏
 *    是本项目实测补上的洞（`workspace-write` 下 `write` 曾把文件写到工作区
 *    之外）。客户端自己也有围栏，但那是**它的**围栏；两道围栏各判各的，
 *    「文件权限」那个配置项就不再说了算。
 * 2. `editText` 的字面匹配 + 版本守卫是后端的一个临界区（读→匹配→重写）。把
 *    读换成缓冲区、把改留在磁盘，等于在临界区外面塞了一份不同的输入。
 *
 * 因此本类是**组合**而非继承 `SandboxedFileSystem`：所有非读方法转发到根实例
 * 上，`LocalFileSystem` 那份 per-targetKey 的写锁才仍然是全进程唯一的一份。
 * 每个会话各 new 一个 `SandboxedFileSystem` 会让两个会话写同一个文件时各拿各
 * 的锁，把「一个赢、其余看到新版本后判 stale」变成一场竞态。
 *
 * 已知代价，不在本模块消解：读到缓冲区之后，同一轮里的 `edit` 仍对磁盘做字面
 * 匹配，内容不一致时会以 `FS_NO_MATCH` 失败。这是一次**响亮**的失败（模型会
 * 重读再改），不是静默改错文件，所以接受。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * 向编辑器取一份文本。
 *
 * 返回 `undefined` 表示「这条路走不通，请走磁盘」——**错误分类归实现方**，因为
 * 只有它知道哪些 ACP 错误是良性的（客户端没打开这个文件、文件超过它的读上限）
 * 哪些是真故障。本模块不 catch：抛出来的异常就该抛出来。
 * @param path - 该文件的一种绝对路径拼写；见 {@link DelegatedReadFileSystem}
 *   的 `askClient`，同一次读可能按不同拼写问两次
 * @param opts - 取消信号，以及「这是最后一个候选」的标记
 * @param opts.signal - 随工具调用取消
 * @param opts.final - 这次落空即等于回落磁盘。**缺席按 `true` 处理**：只问一次
 *   的调用方不必知道有这回事，而诊断该记的那一行不能因为省略了实参而丢
 * @returns 客户端那份文本；`undefined` 表示这个拼写问不到
 */
export type ClientTextReader = (
  path: string,
  opts?: { readonly signal?: AbortSignal | undefined; readonly final?: boolean | undefined },
) => Promise<string | undefined>

/** 把单块文本包成 `streamText` 要的 `AsyncIterable`。 */
async function* singleChunk(text: string): AsyncIterable<string> {
  yield text
}

/** {@link DelegatedReadFileSystem} 的装配参数。 */
export interface DelegatedReadConfig {
  /** 根后端；除读之外的一切都转发给它 */
  base: FileSystem
  /** 向编辑器取文本的委托 */
  read: ClientTextReader
}

/**
 * 读改道、其余转发的文件系统装饰器。注册为所在 context 的 `fs`。
 *
 * **必须经 `ctx.plugin()` 装配，不要直接 `new`**：直接构造时这个服务挂在调用方
 * 当时所在的 fiber 上，而会话装配跑在一个尚未 commit 的 fiber 里——实测那时
 * `scoped.get('fs')` 仍是 undefined，于是 `dsh-tool-fs` 的 `inject: ['fs']` 永远
 * 等不到，四个文件工具**一个都不会注册**（既不在会话作用域也不在全局）。
 * 经 `plugin()` 装则由它自己的 fiber 拥有并发布，与组合里挂 `SandboxedFileSystem`
 * 的写法一致。
 */
export class DelegatedReadFileSystem extends FileSystem {
  /**
   * 底座与委托是**普通字段而不是 `#private`**：Cordis 把服务实例包在 Proxy 后
   * 面交给消费方，而私有字段的 brand check 认的是实例本身，经代理访问会抛
   * 「Cannot read private member from an object whose class did not declare
   * it」。上游的服务（如 `LocalFileSystem.config`）也都是普通字段。
   */
  readonly baseFs: FileSystem
  readonly clientRead: ClientTextReader

  /**
   * @param ctx - 会话作用域、且已 `isolate('fs')` 的 context
   * @param config - 底座与读委托
   */
  constructor(ctx: Context, config: DelegatedReadConfig) {
    super(ctx)
    this.baseFs = config.base
    this.clientRead = config.read
  }

  /**
   * **必须转发**：`dsh-tool-fs` 拿这个值决定要不要执行沙箱策略
   * （`defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')`）。
   * 基类的默认实现返回 `undefined`，忘了这一条就等于把围栏整个关掉——而且是
   * 静默关掉，工具照跑、写照成功。
   */
  override get sandboxMode(): SandboxMode | undefined {
    return this.baseFs.sandboxMode
  }

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.baseFs.resolve(path, opts)
  }

  processPath(target: FsTarget): string {
    return this.baseFs.processPath(target)
  }

  fileUrl(target: FsTarget): string {
    return this.baseFs.fileUrl(target)
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    return this.baseFs.contains(parent, child)
  }

  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.baseFs.stat(target, signal)
  }

  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.baseFs.lstat(path, opts, signal)
  }

  /**
   * 先按规范化路径问编辑器，落空再按调用方拼写问一次。
   *
   * **路径不是字符串。** `processPath` 返回的是 realpath（`dsh-fs-local` 拿它
   * 当 targetKey），而编辑器是按**它自己收到的那个拼写**在管缓冲区的——那个
   * 拼写来自 `session/new` 的 cwd，正是 `displayPath` 保留下来的东西。两者在
   * 有符号链接时不同（macOS 的 `/var` → `/private/var`、Windows 的目录联接），
   * 于是委托问了个编辑器不认识的路径，`fs-read.ts` 把失败吞成回落磁盘，模型
   * 拿到的是上次保存的旧内容——**静默**的错误输入。
   *
   * **顺序不能反。** 规范化路径是今天就在用的那个，先问它保证现有命中一个不丢；
   * 反过来先问拼写，会在「编辑器改脏的是链接目标、模型走的是链接路径」时拿到
   * 一个从磁盘新建的缓冲区——ACP 只要求绝对路径，成功打开不等于找到了那份脏
   * 数据。所以这里严格只增不减：只在**今天会静默回落磁盘**的那条支路上多问
   * 一次。两个拼写相同时（长名工作区的常态）不发第二次。
   * @param target - 已解析的目标
   * @param signal - 随工具调用取消
   * @returns 编辑器那份文本；两个拼写都问不到时 undefined
   */
  private async askClient(target: FsTarget, signal?: AbortSignal): Promise<string | undefined> {
    const canonical = this.baseFs.processPath(target)
    const display = target.displayPath
    const hasFallback = display !== canonical
    const first = await this.clientRead(canonical, { signal, final: !hasFallback })
    if (first !== undefined || !hasFallback) return first
    return await this.clientRead(display, { signal, final: true })
  }

  /** 先问编辑器；它给不出就走磁盘。 */
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const fromClient = await this.askClient(target, signal)
    return fromClient ?? (await this.baseFs.readText(target, signal))
  }

  /**
   * 大文件走的那条读路径，与 {@link readText} 同源。
   *
   * 委托拿到的是整份文本，这里不再分块：分块的意义是不把大文件一次性读进内存，
   * 而它已经在内存里了，再切一刀只是自欺。
   */
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const fromClient = await this.askClient(target, signal)
    if (fromClient === undefined) return this.baseFs.streamText(target, signal)
    return singleChunk(fromClient)
  }

  /**
   * **不**改道：`fs/read_text_file` 是文本方法，没有字节语义；图片走这条路。
   */
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.baseFs.readBytes(target, signal, maxBytes)
  }

  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.baseFs.listDir(target, signal)
  }

  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.baseFs.writeText(target, content, expected, signal, sandboxPolicy)
  }

  editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.baseFs.editText(target, edit, expected, signal, sandboxPolicy)
  }
}

/**
 * 在会话作用域装好文件工具，需要时先把 `fs` 换成改道版本。
 *
 * **文件工具必须装在会话作用域**：`dsh-tool-fs` 的 `apply(ctx)` 闭包捕获的是
 * 它自己的挂载 context，执行时读的是那个 context 上的 `ctx.fs`。装在根上就永远
 * 看不到会话级的替换，无论下面 isolate 了什么。工具注册表本身支持这种装法——
 * 「scoped tools shadow globals」是它写明的语义，MCP 工具走的也是同一条路。
 *
 * 没有委托时**不** isolate：`isolate('fs')` 会切断父作用域的绑定，下面不挂后端
 * 的话 `ctx.fs` 直接不存在，而 `dsh-tool-fs` 的 `inject: ['fs']` 会一直等下去
 * ——表现为 `session/new` 挂起，不是报错。
 * @param agentCtx - agent 作用域 context
 * @param fsTool - `@deepseek-ai/dsh-tool-fs` 插件（注入以便测试替身）
 * @param read - 读委托；`undefined` 表示客户端不支持，全程走磁盘
 */
export async function mountSessionFs(
  agentCtx: Context,
  fsTool: unknown,
  read: ClientTextReader | undefined,
): Promise<void> {
  // `agentCtx.fs` 会抛「cannot get property "fs" without inject」——本 context
  // 没有声明注入 `fs`。`get` 是 Cordis 里明确的可选读法，与本项目读 `tools` /
  // `sessionPersistence` 的写法一致；组合根本没挂文件系统时它返回 undefined，
  // 那种部署里没有底座可包，委托也就无从谈起。
  const base = agentCtx.get('fs')
  if (read === undefined || base === undefined) {
    await agentCtx.plugin(fsTool as never, {} as never)
    return
  }
  const scoped = agentCtx.isolate('fs')
  await scoped.plugin(DelegatedReadFileSystem, { base, read })
  await scoped.plugin(fsTool as never, {} as never)
}
