/**
 * `fs/read_text_file` —— 把文本读委托给编辑器（US-25）。
 *
 * 只做一件事：把一次 ACP 反向请求包成 {@link ClientTextReader}。取舍全在错误
 * 处理上——见下面 {@link clientTextReader} 的注释。
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ClientTextReader } from '../composition/session-fs.js'

/** 发起一次客户端侧请求；形状与 `AgentContext.request` 一致。 */
export type RequestFn = (
  method: 'fs/read_text_file',
  params: { sessionId: string; path: string },
  options?: { cancellationSignal?: AbortSignal },
) => Promise<{ content?: string } | undefined>

/**
 * 造一个绑定到某个会话的读委托。
 *
 * **任何失败都回落磁盘，不上抛。** 理由是这条链路的性质：委托是一次
 * *优化*（看得见未保存的缓冲区），不是读文件的必要条件。而失败的原因有一整
 * 排且都完全正常——客户端没打开这个文件、文件超过它的读上限（codeg 有一句
 * `file too large for fs/read_text_file`）、路径在它的策略之外、它正在重载。
 * 把这些都变成读失败，等于让一个「锦上添花」的能力具备了让 `read` 工具整个
 * 挂掉的权力。
 *
 * 代价是真故障也会被吞成静默降级，所以每次回落都记一行（走 stderr，AC-G1）。
 *
 * **「回落」是调用方才知道的事。** 同一次读可能按两种拼写各问一次（见
 * `DelegatedReadFileSystem.askClient`），第一次落空并不意味着要读磁盘——第二次
 * 可能命中。所以这一行由 `opts.final` 决定何时记，非最后一个候选落空时保持安静：
 * 否则日志会在委托其实成功的那些读上说「回落磁盘了」。
 * @param sessionId - 本会话 id；随每次请求发给客户端
 * @param request - 反向请求函数
 * @param warn - 回落时的诊断输出
 * @returns 读委托
 */
export function clientTextReader(
  sessionId: SessionId,
  request: RequestFn,
  warn: (message: string) => void,
): ClientTextReader {
  return async (path, opts) => {
    // 缺席按「这是最后一个候选」处理：漏记一行诊断比多记一行坏。
    const final = opts?.final ?? true
    const signal = opts?.signal
    try {
      const response = await request(
        'fs/read_text_file',
        { sessionId: String(sessionId), path },
        signal === undefined ? {} : { cancellationSignal: signal },
      )
      // `content` 缺席与空字符串是两回事：后者是「客户端说这个文件是空的」，
      // 要如实返回，`?? undefined` 会把它错判成「客户端给不出」而去读磁盘。
      const content = response?.content
      // 客户端**不报错**地给不出内容，同样是一次回落。以前这条路一行不记，
      // 而两段式下它会吃掉前一个候选的错误（前一个非 final 已经保持安静了），
      // 于是整次回落变得毫无痕迹——正是这套诊断要防的那件事。
      if (content === undefined && final) {
        warn(`fs/read_text_file fell back to disk for ${path}: client returned no content`)
      }
      return content
    } catch (error) {
      if (final) warn(`fs/read_text_file fell back to disk for ${path}: ${String(error)}`)
      return undefined
    }
  }
}
