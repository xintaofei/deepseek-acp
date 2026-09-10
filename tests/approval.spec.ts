/**
 * TC-APPR-* —— 审批桥（US-12）。
 *
 * 这一层的失败模式不对称：漏掉一次授权提示只是烦人，**误判成放行**则是让模型
 * 无提示地改用户的代码。所以用例重点全在 fail-closed 一侧。
 */

import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ALLOW_OPTION_ID,
  PERMISSION_OPTIONS,
  answerApproval,
  decisionFromResponse,
} from '../src/answerers/approval.js'
import { createHarness } from './harness.js'

const SID = SessionId('s-1')
const noopWarn = (): void => {}
const selected = (optionId: string): RequestPermissionResponse => ({
  outcome: { outcome: 'selected', optionId },
})

describe('TC-APPR-01 应答映射', () => {
  it('唯一放行选项才算放行', () => {
    expect(decisionFromResponse(selected(ALLOW_OPTION_ID))).toBe('allowed-once')
  })

  it('明确拒绝', () => {
    expect(decisionFromResponse(selected('reject-once'))).toBe('rejected')
  })

  it('取消', () => {
    expect(decisionFromResponse({ outcome: { outcome: 'cancelled' } })).toBe('cancelled')
  })

  it('未知 optionId 一律当拒绝 —— 不合规客户端不得成为提权路径', () => {
    for (const bogus of ['allow', 'Allow-Once', 'allow_always', '', 'yes', 'allow-once ']) {
      expect(decisionFromResponse(selected(bogus)), bogus).toBe('rejected')
    }
  })

  it('只 advertise 一次性选项 —— dsh 的结论词表里没有「始终允许」', () => {
    expect(PERMISSION_OPTIONS.map((o) => o.optionId)).toEqual(['allow-once', 'reject-once'])
    expect(PERMISSION_OPTIONS.some((o) => o.kind === 'allow_always')).toBe(false)
  })
})

describe('TC-APPR-02 answerApproval 的认领与 fail-closed', () => {
  it('放行请求原样带上 sessionId、callId 与选项', async () => {
    const seen: unknown[] = []
    const decision = await answerApproval(
      SID,
      { callId: 'call-7', toolName: 'bash' },
      {
        requestPermission: async (params) => {
          seen.push(params)
          return selected(ALLOW_OPTION_ID)
        },
        warn: noopWarn,
      },
    )
    expect(decision).toBe('allowed-once')
    expect(seen).toEqual([
      { sessionId: SID, toolCall: { toolCallId: 'call-7' }, options: [...PERMISSION_OPTIONS] },
    ])
  })

  it('没有 callId 就不认领 —— 协议要求把提示挂在工具卡片上', async () => {
    let called = false
    const decision = await answerApproval(
      SID,
      { toolName: 'bash' },
      {
        requestPermission: async () => {
          called = true
          return selected(ALLOW_OPTION_ID)
        },
        warn: noopWarn,
      },
    )
    expect(decision).toBeUndefined()
    expect(called, '不认领时不该打扰客户端').toBe(false)
  })

  it('没有连接时拒绝，而不是交给下一个应答器', async () => {
    const decision = await answerApproval(SID, { callId: 'c', toolName: 'bash' }, { warn: noopWarn })
    // 返回 undefined 会走 next()，链尾若有自动放行的应答器，断连就成了提权路径
    expect(decision).toBe('rejected')
  })

  it('客户端抛错时拒绝', async () => {
    const decision = await answerApproval(
      SID,
      { callId: 'c', toolName: 'bash' },
      {
        requestPermission: () => Promise.reject(new Error('client gone')),
        warn: noopWarn,
      },
    )
    expect(decision).toBe('rejected')
  })
})

describe('TC-APPR-03 经真实 waterfall 的端到端', () => {
  /** 在开着的回合里提一个审批问题，返回 dsh 侧的结论。 */
  async function askDuringTurn(
    h: Awaited<ReturnType<typeof createHarness>>,
    sessionId: string,
  ): Promise<string> {
    const agent = h.ctx.agents.get(sessionId as never)
    if (agent === undefined) throw new Error('agent 未创建')

    let outcome = '<未提问>'
    h.llm.duringTurn = async () => {
      outcome = await h.ctx.approval.request({
        agent,
        toolName: 'bash',
        callId: ToolCallId('call-1'),
      })
    }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: 'go' }],
    })
    return outcome
  }

  it('客户端选择放行 → allowed-once，且请求带上了会话与调用 id', async () => {
    const h = await createHarness()
    h.setPermissionResponder(() => selected(ALLOW_OPTION_ID))
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })

    expect(await askDuringTurn(h, sessionId)).toBe('allowed-once')
    expect(h.permissionRequests).toHaveLength(1)
    expect(h.permissionRequests[0]?.sessionId).toBe(sessionId)
    expect(h.permissionRequests[0]?.toolCall.toolCallId).toBe('call-1')
    h.disposeBridge()
  })

  it('客户端拒绝 → rejected', async () => {
    const h = await createHarness()
    h.setPermissionResponder(() => selected('reject-once'))
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    expect(await askDuringTurn(h, sessionId)).toBe('rejected')
    h.disposeBridge()
  })

  it('客户端回未知 optionId → rejected（fail-closed 贯穿整条链）', async () => {
    const h = await createHarness()
    h.setPermissionResponder(() => selected('allow_always'))
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    expect(await askDuringTurn(h, sessionId)).toBe('rejected')
    h.disposeBridge()
  })

  it('bridge 卸载后不再认领，落回链尾的 unavailable', async () => {
    const h = await createHarness()
    h.setPermissionResponder(() => selected(ALLOW_OPTION_ID))
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    const agent = h.ctx.agents.get(sessionId as never)
    if (agent === undefined) throw new Error('agent 未创建')

    h.disposeBridge()
    // 卸载会释放 agent，故这里只断言应答器已摘除：请求不再到达客户端
    const before = h.permissionRequests.length
    await h.ctx.approval
      .request({ agent, toolName: 'bash', callId: ToolCallId('call-2') })
      .catch(() => 'threw')
    expect(h.permissionRequests.length, '卸载后不得再打扰客户端').toBe(before)
  })
})
