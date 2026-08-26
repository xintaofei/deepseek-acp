/**
 * `session/list` —— 列出可恢复的会话（US-15）。
 * @module
 */

import { isAbsolute } from 'node:path'
import type { ListSessionsRequest, ListSessionsResponse, SessionInfo } from '@agentclientprotocol/sdk'
import type { Bridge } from '../bridge.js'
import { invalidParams, methodNotFound } from '../codec/errors.js'
import type { SessionSummary } from '../port/types.js'
import { sameWorkspace } from '../session/workspace-path.js'

/**
 * 摘要 → ACP `SessionInfo`。
 *
 * **没有 cwd 的会话直接丢弃**：`SessionInfo.cwd` 是必填的绝对路径，编不出来。
 * 拿 `process.cwd()` 顶上会把一条无处安放的历史标成属于当前项目，客户端据此
 * 恢复就是错的工作区。
 *
 * 排序键是**最后活动时间**（缺失时退回创建时间）：会话选择器是按「最近在做
 * 什么」翻的，按创建时间排会把今天一直在聊的老会话压到末尾。
 *
 * 工作区过滤**不在这里**：判两个路径是不是同一个目录要读文件系统（见
 * {@link sameWorkspace}），而这个函数是纯映射加排序。把一次 I/O 藏进投影函数里
 * 只会让它的签名说谎。
 * @param summaries - 持久化摘要（已按工作区过滤过）
 * @returns 按最后活动时间倒序的会话信息
 */
export function toSessionInfos(summaries: readonly SessionSummary[]): SessionInfo[] {
  const activity = (s: SessionSummary): number => s.updatedAt ?? s.createdAt
  return summaries
    .filter((s): s is SessionSummary & { cwd: string } => s.cwd !== undefined)
    .sort((a, b) => activity(b) - activity(a))
    .map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      // 缺字段客户端会退回显示 id —— 比显示一个编出来的标题好。
      ...(s.title === undefined ? {} : { title: s.title }),
      ...(s.updatedAt === undefined ? {} : { updatedAt: new Date(s.updatedAt).toISOString() }),
    }))
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 全部可恢复会话，最新在前
 */
export async function handleListSessions(
  bridge: Bridge,
  params: ListSessionsRequest,
): Promise<ListSessionsResponse> {
  bridge.assertOpen()
  const catalog = bridge.port.catalog
  if (catalog === undefined) {
    throw methodNotFound('session/list requires a session-persistence backend')
  }
  if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  // 不分页：返回的是元数据（id + 路径），一次给全比让客户端管游标简单得多。
  // 若日后真要截断，必须同时实现 `nextCursor`——静默截断会让客户端以为
  // 「就这么多会话」，而那正是列表这个功能唯一要回答的问题。
  if (params.cursor !== undefined && params.cursor !== null) {
    throw invalidParams('pagination is not supported: session/list returns every session at once')
  }
  return { sessions: toSessionInfos(await byWorkspace(await catalog.list(), params.cwd)) }
}

/**
 * 按工作区过滤会话摘要。
 *
 * 裸相等会让用户看不到自己的会话：编辑器发来的 cwd 与当初落盘的那个可以是同
 * 一个目录的不同拼写。这里逐条比目录而不是比字符串。
 *
 * 并发解析：`sameWorkspace` 的快路（拼写原样相等）不读文件系统，只有拼写不同
 * 的条目才付一次 `realpath`。调用方本来就要逐条读日志折标题，多这一次不改变
 * 量级。
 * @param summaries - 全部摘要
 * @param cwd - 请求里的工作区；缺席或 null 表示不过滤
 * @returns 落在该工作区里的摘要
 */
async function byWorkspace(
  summaries: readonly SessionSummary[],
  cwd: string | null | undefined,
): Promise<readonly SessionSummary[]> {
  if (cwd === undefined || cwd === null) return summaries
  const keep = await Promise.all(
    summaries.map(async (s) => s.cwd !== undefined && (await sameWorkspace(s.cwd, cwd))),
  )
  return summaries.filter((_, i) => keep[i] === true)
}
