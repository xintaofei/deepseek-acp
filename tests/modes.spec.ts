/**
 * TC-MODE-* —— 会话模式（US-19）。
 *
 * ACP 的模式选择器是通用的（任意 id 集合），上游只有 plan 一个协作状态（一个
 * 布尔）。这里测的是那层投影：`default` / `plan` 的词表由 bridge 拥有，切换要
 * 落到上游的布尔上，而模型自己退出 plan mode 时选择器也要跟着回来。
 */

import { describe, expect, it } from 'vitest'
import { AVAILABLE_MODES, DEFAULT_MODE, PLAN_MODE, modeActive, modeId } from '../src/config/modes.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { realTempDir } from './temp-dir.js'

/** 客户端收到的模式更新 id，按到达顺序。 */
function modeUpdates(h: TestHarness): string[] {
  const seen: string[] = []
  h.onUpdate((update) => {
    const u = update as { sessionUpdate: string; currentModeId?: string }
    if (u.sessionUpdate === 'current_mode_update') seen.push(u.currentModeId ?? '')
  })
  return seen
}

describe('TC-MODE-01 能力声明', () => {
  it('未挂 plan-mode 时不 advertise modes，且 set_mode 报能力缺失', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })
    const created = await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })
    expect(created.modes).toBeUndefined()

    // 「能力缺失」而非「参数错了」：后者会让客户端以为换个 id 重试有用。
    await expect(
      h.acp.request('session/set_mode', { sessionId, modeId: PLAN_MODE }),
    ).rejects.toThrow(/dsh-plan-mode/)
    h.disposeBridge()
  }, 30_000)

  it('挂了之后 session/new 带回两项词表，当前为常规', async () => {
    const h = await createHarness({ planMode: true })
    const created = await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })

    expect(created.modes?.currentModeId).toBe(DEFAULT_MODE)
    expect(created.modes?.availableModes.map((m) => m.id)).toEqual([DEFAULT_MODE, PLAN_MODE])
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MODE-02 切换', () => {
  it('set_mode 落到上游的布尔状态上，并回一条 current_mode_update', async () => {
    const h = await createHarness({ planMode: true })
    const seen = modeUpdates(h)
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })

    await h.acp.request('session/set_mode', { sessionId, modeId: PLAN_MODE })
    const agent = h.ctx.agents.get(sessionId as never)!
    // 空闲时切换会立刻写进日志，所以这里读到的是已提交状态。
    expect(h.ctx.planMode.get(agent)).toEqual({ active: true })

    await waitFor(() => seen.includes(PLAN_MODE), 5_000, 'current_mode_update')
    h.disposeBridge()
  }, 30_000)

  it('未知 modeId 被拒 —— 静默落到 default 会让用户以为自己切成功了', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })

    await expect(
      h.acp.request('session/set_mode', { sessionId, modeId: 'yolo' }),
    ).rejects.toThrow(/unknown mode/)
    h.disposeBridge()
  }, 30_000)

  it('未知会话被拒', async () => {
    const h = await createHarness({ planMode: true })
    await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })

    await expect(
      h.acp.request('session/set_mode', { sessionId: 'nope' as never, modeId: PLAN_MODE }),
    ).rejects.toThrow(/unknown session/)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MODE-03 已提交的状态变化也会通知', () => {
  it('/plan off 让选择器回到常规 —— 变化不只来自 set_mode', async () => {
    const h = await createHarness({ planMode: true })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-mode-'), mcpServers: [] })
    await h.acp.request('session/set_mode', { sessionId, modeId: PLAN_MODE })

    const seen = modeUpdates(h)
    // 走命令面退出，bridge 完全没参与这次决定 —— 只能靠日志事件察觉。
    await h.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan off' }],
    })
    await waitFor(() => seen.includes(DEFAULT_MODE), 5_000, 'mode back to default')

    const agent = h.ctx.agents.get(sessionId as never)!
    expect(h.ctx.planMode.get(agent).active).toBe(false)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-MODE-04 恢复', () => {
  it('session/load 还原当初的 plan 状态', async () => {
    const sessionsRoot = realTempDir('dsacp-mode-root-')
    const cwd = realTempDir('dsacp-mode-')
    const recorder = await createHarness({ sessionsRoot, planMode: true })
    const { sessionId } = await recorder.acp.request('session/new', { cwd, mcpServers: [] })
    await recorder.acp.request('session/set_mode', { sessionId, modeId: PLAN_MODE })
    recorder.disposeBridge()
    await recorder.retire()

    const loader = await createHarness({ sessionsRoot, planMode: true })
    const seen = modeUpdates(loader)
    const loaded = await loader.acp.request('session/load', { sessionId, cwd, mcpServers: [] })

    // 应答里的当前值来自**日志**，不是部署默认。
    expect(loaded.modes?.currentModeId).toBe(PLAN_MODE)
    // 重放也走同一条映射，所以恢复出来的转录里那次切换仍在。
    expect(seen).toContain(PLAN_MODE)
    loader.disposeBridge()
  }, 40_000)
})

describe('TC-MODE-05 词表投影', () => {
  it('布尔与线上 id 一一对应，未知 id 返回 undefined', () => {
    expect(modeId(true)).toBe(PLAN_MODE)
    expect(modeId(false)).toBe(DEFAULT_MODE)
    expect(modeActive(PLAN_MODE)).toBe(true)
    expect(modeActive(DEFAULT_MODE)).toBe(false)
    expect(modeActive('plan-mode')).toBeUndefined()
  })

  it('plan 的说明不承诺权限限制 —— 那是沙箱的事', () => {
    const plan = AVAILABLE_MODES.find((m) => m.id === PLAN_MODE)
    expect(plan?.description).toContain('引导')
  })
})
