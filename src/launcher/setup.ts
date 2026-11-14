/**
 * `--setup` —— 终端登录，即 ACP 的 **Terminal Auth**。
 *
 * 存在的理由不是「环境变量不好用」，而是 ACP registry 只认两档鉴权：Agent Auth
 * （agent 自己起本地 HTTP server 跑 OAuth 回调）与 Terminal Auth。规范里还定义着
 * Environment Variable Auth，但 registry 明确不收，而 DeepSeek 给第三方的是 API
 * Key、没有 OAuth——于是能走的只剩这一条。
 *
 * 协议侧的契约极简：客户端拿 `authMethods` 里那条 `type: 'terminal'` 的方法，用
 * **同一个二进制**加上它给的 `args` 另起一个交互式进程，等它退出。**退出码 0 即
 * 成功**，然后客户端重连、重新 `initialize`、重试原操作。没有任何带内成功信号，
 * 所以这里唯一要守住的就是退出码的诚实：写盘成功才 0。
 *
 * 这条路径**不经过 `authenticate` RPC**（见 `src/index.ts` 里那个 no-op），登录发生
 * 在另一个进程里，与协议连接无关。
 * @module
 */

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * 凭据引用名。
 *
 * 与 `dsh-llm-deepseek` 的 `apiKeyEnv` 默认值同名——适配器每次请求按这个名字解析
 * 凭据，写别的名字等于写进一个没人读的槽位。上游没把那个默认值 export 出来，所以
 * 这里是**第二处字面量**：`boot()` 挂 `LlmDeepSeek` 时没有覆盖 `apiKeyEnv`，两边
 * 因此指的是同一个槽位；哪天要改成可配置的，这两处得一起动。
 */
export const CREDENTIAL_REF = credentialRef('DEEPSEEK_API_KEY')

/** {@link readSecret} 的输入输出，参数化只为可测。 */
export interface SecretIo {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** 输入端是否是终端；决定要不要压掉回显。 */
  isTty: boolean
}

/**
 * 读一行密钥，**终端下不回显**。
 *
 * 回显要靠一个中间 Writable 掐掉：readline 把提示语和用户的每一次击键都写向同一个
 * output，所以先把提示放行、再合上闸，之后的击键回显就到不了屏幕。这比
 * `setRawMode` 自己处理退格与 Ctrl-C 省事得多，也不必去改 readline 的私有方法。
 *
 * **非终端（管道）时不压回显**：那头没有人在看，`terminal: false` 下 readline 本来
 * 也不回显。用例正是从这条路进来的。
 * @param io - 输入输出与终端判定
 * @param prompt - 提示语
 * @returns 用户输入的那一行（未 trim）
 */
export async function readSecret(io: SecretIo, prompt: string): Promise<string> {
  let muted = false
  const gate = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) io.output.write(chunk)
      callback()
    },
  })

  const rl = createInterface({ input: io.input, output: gate, terminal: io.isTty })
  try {
    return await new Promise<string>((resolve) => {
      // **先接 `close`**：EOF（stdin 直接关掉）与 Ctrl-C 都只让 readline `close`，
      // `question` 的回调永远不来。不接的话 promise 一直悬着，Node 最终以「未决的
      // top-level await」退出——码是 13，非 0 没错，但那是个说不清的数字，而这条
      // 路径的退出码是**给客户端看的唯一信号**。空串会被下面的空值检查拦成 1。
      rl.on('close', () => resolve(''))
      // `question` 同步把提示写出去，所以合闸放在调用之后——顺序反了会连提示一起吞掉。
      rl.question(prompt, resolve)
      muted = io.isTty
    })
  } finally {
    rl.close()
    // 无条件补一个换行：终端下用户的回车被闸门吞了，管道下 readline 本来就不回显
    // ——两条路都不会自己产生换行，不补的话后续输出接在提示语屁股后面。
    io.output.write('\n')
  }
}

/**
 * 跑一遍登录：读 key，写进凭据文件。
 *
 * 只挂 `LocalCredentials` 一个插件，**不复用 `composeAgent()`**：那个函数的契约写着
 * 「不含 provider 适配器与凭据——那两个是部署配置，不是 agent 能力」，而登录要动的
 * 恰恰只有凭据这一层。装一整套 agent 只为写一行 YAML，既慢又把失败面铺大了。
 *
 * 落点是 `$DSH_HOME/.credentials.yaml`（`0600`，目录 `0700`，由 provider 自己保证）。
 * DSH 0.2 起这一层压过一切，**包括客户端传进来的环境变量**，所以写完之后，编辑器
 * 配置里填的 `DEEPSEEK_API_KEY` 就不再生效。成功提示里明说这一点：用户多半是在
 * 编辑器里配过 key 才来跑这一步的，不说的话，他之后在那里改 key 会发现改了没用。
 *
 * 提示与结果一律走 **stderr**：stdout 在这个进程里虽然不是协议通道（`--setup` 根本
 * 不起服务），但保持同一条约定，排查时不必先想「这次是哪种模式」。
 * @param env - 进程环境，用于解析 `$DSH_HOME`
 * @param io - 输入输出；缺省用真实的 stdin/stderr
 * @returns 进程退出码：0 成功，1 失败
 */
export async function runSetup(env: NodeJS.ProcessEnv, io?: SecretIo): Promise<number> {
  const streams: SecretIo = io ?? {
    input: process.stdin,
    output: process.stderr,
    isTty: process.stdin.isTTY === true,
  }

  const dshHome = resolveDshHome(undefined, env)
  streams.output.write(`把 DeepSeek API Key 粘在下面，将写入 ${dshHome}/.credentials.yaml\n`)

  let key: string
  try {
    key = (await readSecret(streams, `${CREDENTIAL_REF}: `)).trim()
  } catch (error) {
    streams.output.write(`deepseek-acp: 读取输入失败：${String(error)}\n`)
    return 1
  }

  // provider 对空值是拒绝而不是存一个空串（清除要用 `unset`），所以这里先拦一道，
  // 好给出一句人能看懂的话而不是一条来自存储层的报错。
  if (key.length === 0) {
    streams.output.write('deepseek-acp: 没有读到 Key，未做任何改动\n')
    return 1
  }

  const ctx = new Context()
  try {
    // `watch: false` —— 这个进程写完就退，热重载没有收益，而 watcher 会持有事件
    // 循环让它不肯退出（与 `boot()` 里同一个理由）。
    await ctx.plugin(LocalCredentials, { watch: false, dshHome })
    await ctx.credentials.set(CREDENTIAL_REF, key)
  } catch (error) {
    streams.output.write(`deepseek-acp: 写入失败：${String(error)}\n`)
    return 1
  } finally {
    // await 到异步清理也跑完为止，否则可能在写盘落定前就退出。
    await ctx.fiber.dispose()
  }

  streams.output.write(`deepseek-acp: 已写入 ${CREDENTIAL_REF}，可以回到编辑器了\n`)
  streams.output.write(`deepseek-acp: 此后它优先于编辑器配置里的 ${CREDENTIAL_REF}；要换 key，再跑一次 --setup\n`)
  return 0
}
