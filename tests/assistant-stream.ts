/**
 * 助手流的测试夹具。
 *
 * 0.1.5 起「模型说了什么」在日志里的载体是 `assistant/message` 随身带的**紧凑
 * 记录**（连续同类 delta 打包成一条 run），实时侧则是进程内的帧流。三个用例文件
 * 都要造这两种形状，各造一份迟早会分叉——而分叉的表现正是「重放与实时不一致」，
 * 也就是这些用例本身要证伪的那件事。
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mapEvent } from '../src/mapping/updates.js'

/** 一条正文 run；`texts` 是被打包的各片，拼接结果即这一段文本。 */
export function textRun(...texts: string[]): unknown {
  return { type: 'text-chunks', time0: 0, index: 0, dt: texts.map(() => 0), texts }
}

/** 一条推理 run。 */
export function reasoningRun(...texts: string[]): unknown {
  return { type: 'reasoning-chunks', time0: 0, index: 0, dt: texts.map(() => 0), texts }
}

/**
 * 一条带紧凑流的 `assistant/message` 事件。
 * @param stream - 紧凑记录，见 {@link textRun} / {@link reasoningRun}
 * @param turn - 回合号
 * @param step - 步骤号
 */
export function messageEvent(stream: readonly unknown[], turn = 1, step = 1): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: { turn, step, message: { role: 'assistant', content: [] }, stream },
  } as unknown as SessionEvent
}

/**
 * 走**重放**路径把一条紧凑流映射成更新。
 *
 * 实时路径不经这里（分片走帧流），所以夹具显式带上 `replay: true`——用例要断的
 * 是「日志里的这段文字念出来是什么」。
 */
export function replayStream(stream: readonly unknown[], turn?: number, step?: number): unknown[] {
  return mapEvent(messageEvent(stream, turn, step), { replay: true })
}
