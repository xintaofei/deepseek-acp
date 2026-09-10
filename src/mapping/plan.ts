/**
 * `todo/write` → ACP `plan`（US-13）。
 * @module
 */

import type { Plan, PlanEntry } from '@agentclientprotocol/sdk'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'

/**
 * 整张待办列表映射为一份替换式 plan。
 *
 * 每条都标 `medium`：harness 的待办不带优先级，编一个高低会凭空给用户传达
 * 一个模型从未表达过的判断。
 * @param todos - 完整待办列表
 * @returns ACP plan
 */
export function todosToPlan(todos: readonly TodoItem[]): Plan {
  return {
    entries: todos.map((todo): PlanEntry => ({ content: todo.content, priority: 'medium', status: todo.status })),
  }
}
