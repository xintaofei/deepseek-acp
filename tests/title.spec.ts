/**
 * TC-TITLE-* —— 会话标题（US-22）。
 *
 * 标题是**后来**才有的：它由第一条用户消息推导，因此不能在 `session/new` 的
 * 应答里给出，只能作为 `session_info_update` 推过去。列表那边则要从日志里折出
 * 来——header 里没有标题，也没有「最后活动时间」。
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { toSessionInfos } from '../src/protocol/session-list.js'
import type { SessionSummary } from '../src/port/types.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

/** 客户端收到的标题更新，按到达顺序。 */
function titleUpdates(h: TestHarness): { title: string | null | undefined; updatedAt: string | null | undefined }[] {
  const seen: { title: string | null | undefined; updatedAt: string | null | undefined }[] = []
  h.onUpdate((update) => {
    const u = update as { sessionUpdate: string; title?: string | null; updatedAt?: string | null }
    if (u.sessionUpdate === 'session_info_update') seen.push({ title: u.title, updatedAt: u.updatedAt })
  })
  return seen
}

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 's' as SessionId,
    cwd: '/w',
    createdAt: 0,
    title: undefined,
    updatedAt: undefined,
    ...over,
  }
}

describe('TC-TITLE-01 实时标题', () => {
  it('第一条用户消息之后推出标题，并带上事件自己的时间戳', async () => {
    const h = await createHarness({ title: true })
    const seen = titleUpdates(h)
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-title-'), mcpServers: [] })

    // 建会话时还没有任何用户消息，也就没有标题可推。
    expect(seen).toEqual([])

    await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '修复登录页的 CSRF 校验' }],
    })
    await waitFor(() => seen.length > 0, 5_000, 'session_info_update')

    expect(seen[0]?.title).toContain('修复登录页')
    // ISO 8601，且不是「现在」的近似 —— 取的是事件时间戳。
    expect(seen[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    h.disposeBridge()
  }, 30_000)

  it('没挂标题服务时一条都不推 —— 不编一个标题出来', async () => {
    const h = await createHarness()
    const seen = titleUpdates(h)
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-title-'), mcpServers: [] })
    await h.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '你好' }] })

    expect(seen).toEqual([])
    h.disposeBridge()
  }, 30_000)
})

describe('TC-TITLE-02 恢复与列表', () => {
  it('session/load 重放同一条标题更新', async () => {
    const sessionsRoot = realTempDir('dsacp-title-root-')
    const cwd = realTempDir('dsacp-title-')
    const recorder = await createHarness({ sessionsRoot, title: true })
    const { sessionId } = await recorder.acp.request('session/new', { cwd, mcpServers: [] })
    await recorder.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '修复登录页的 CSRF 校验' }],
    })
    recorder.disposeBridge()
    await recorder.retire()

    const loader = await createHarness({ sessionsRoot, title: true })
    const seen = titleUpdates(loader)
    await loader.acp.request('session/load', { sessionId, cwd, mcpServers: [] })

    // 恢复出来的会话同样要有名字，否则列表里有名字、打开之后变回一串 id。
    expect(seen).toHaveLength(1)
    expect(seen[0]?.title).toContain('修复登录页')
    loader.disposeBridge()
  }, 40_000)

  it('session/list 从日志折出标题与最后活动时间', async () => {
    const sessionsRoot = realTempDir('dsacp-title-root-')
    const cwd = realTempDir('dsacp-title-')
    const recorder = await createHarness({ sessionsRoot, title: true })
    const { sessionId } = await recorder.acp.request('session/new', { cwd, mcpServers: [] })
    await recorder.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '把缓存换成 Redis' }],
    })
    recorder.disposeBridge()
    await recorder.retire()

    const reader = await createHarness({ sessionsRoot, title: true })
    const listed = await reader.acp.request('session/list', {})
    const entry = listed.sessions.find((s) => s.sessionId === sessionId)

    expect(entry?.title).toContain('把缓存换成')
    expect(entry?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    reader.disposeBridge()
  }, 40_000)
})

describe('TC-TITLE-03 列表投影', () => {
  it('按最后活动时间倒序，缺失时退回创建时间', () => {
    const infos = toSessionInfos([
      summary({ sessionId: 'old-but-active' as SessionId, createdAt: 1, updatedAt: 900 }),
      summary({ sessionId: 'new-but-idle' as SessionId, createdAt: 500 }),
      summary({ sessionId: 'newest' as SessionId, createdAt: 2, updatedAt: 1000 }),
    ])
    // 按创建时间排会把今天一直在聊的老会话压到末尾 —— 那正好是用户最想找的那条。
    expect(infos.map((s) => s.sessionId)).toEqual(['newest', 'old-but-active', 'new-but-idle'])
  })

  it('没有标题时不给这个字段 —— 客户端会退回显示 id', () => {
    const [info] = toSessionInfos([summary({})])
    expect(info).not.toHaveProperty('title')
    expect(info).not.toHaveProperty('updatedAt')
  })
})
