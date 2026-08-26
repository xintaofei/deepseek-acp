/**
 * TC-IMG-* —— 图片输入（US-23）。
 *
 * 这条链的失败模式几乎都是**静默**的，所以断言要盯住那几处：
 *
 *  - 图片进没进模型请求。会话日志里有引用、附件库里有对象，都不代表模型看见了它。
 *  - 块的**顺序**。`[文本][图][文本]` 被拍成 `[文本+文本][图]` 时，「收到了图片」
 *    照样成立，而模型读到的是另一句话。
 *  - 拒绝要说得出**怎么办**。纯文本模型上发图是用户最容易撞上的路径（部署默认
 *    模型就是纯文本的），一句「不支持」会让人以为这个功能不存在。
 *
 * 全部用例的附件库都**关在临时目录里**。上游把附件的垃圾回收推迟了（对象永不
 * 回收），漏掉隔离就是在用户的 `~/.dsh/attachments/` 里堆一堆没人认领的文件。
 */

import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { MODEL_OPTION } from '../src/config/options.js'
import { createHarness, type TestHarness } from './harness.js'
import { FAKE_MODEL_VISION } from './fake-llm.js'
import { realTempDir } from './temp-dir.js'

/** 一张真的 4×4 红色 PNG。准入会完整解码它，所以不能拿假字节糊弄。 */
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8AARwgWXg4ArpMP8bh5W0YAAAAASUVORK5CYII='

/**
 * 一张 8×8 噪点 PNG，它的 base64 里**确实含 `+` 与 `/`**。
 *
 * 专门为「URL-safe 别名要被拒」那条用例准备：{@link RED_PNG} 的编码里一个
 * `+` `/` 都没有，拿它去做 URL-safe 替换是个空操作，那条用例会因此永远通过而
 * 什么都没测到——它第一次写出来就是这样的。
 */
const NOISY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA00lEQVQImQHIADf/AAswVXqfxOkOM1h9osfsETZbgKXK7xQ5XgCDqM3yFzxhhqvQ9Ro/ZImu0/gdQmeMsdYA+yBFao+02f4jSG2St9wBJktwlbrfBClOAHOYveIHLFF2m8DlCi9UeZ7D6A0yV3yhxgDrEDVaf6TJ7hM4XYKnzPEWO2CFqs/0GT4AY4it0vccQWaLsNX6H0RpjrPY/SJHbJG2ANsAJUpvlLneAyhNcpe84QYrUHWav+QJLgBTeJ3C5wwxVnugxeoPNFl+o8jtEjdcgaYJQ15hHfdF+gAAAABJRU5ErkJggg=='

const image = (data = RED_PNG) => ({ type: 'image' as const, data, mimeType: 'image/png' })

/** 建一个挂了附件服务、并且已经切到收图模型的会话。 */
async function visionSession(h: TestHarness): Promise<string> {
  h.llm.offerVisionModel = true
  const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir('dsacp-ws-'), mcpServers: [] })
  await h.acp.request('session/set_config_option', {
    sessionId: sessionId as never,
    configId: MODEL_OPTION as never,
    value: FAKE_MODEL_VISION as never,
  })
  return String(sessionId)
}

describe('TC-IMG-01 能力声明跟着组合走', () => {
  it('挂了附件服务就声明 image', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const init = await h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const caps = (init.agentCapabilities as { promptCapabilities?: { image?: boolean } }).promptCapabilities
    expect(caps?.image).toBe(true)
    h.disposeBridge()
  }, 30_000)

  it('没挂就不声明 —— 声明与实现同一个真值来源', async () => {
    const h = await createHarness()
    const init = await h.acp.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const caps = (init.agentCapabilities as { promptCapabilities?: { image?: boolean } }).promptCapabilities
    expect(caps?.image).toBe(false)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-IMG-02 图片进模型', () => {
  it('发一张图，模型请求里真的带着它', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '这是什么颜色' }, image()],
    })
    // 断的是**模型收到了**，不是「附件库里有对象」——后者在一个忘了把引用放进
    // 消息的实现里同样成立。
    expect(h.llm.imagesUsed.at(-1)).toHaveLength(1)
    // 引用而不是 base64：字节进了内容寻址库，消息里只留一个内容地址。
    expect(h.llm.imagesUsed.at(-1)?.[0]).toMatch(/^sha256:/)
    // 顺带钉住「日志里不该有 base64」：整条请求的文本里不能出现原始负载。
    expect(h.llm.historiesUsed.at(-1)?.join('\n')).not.toContain(RED_PNG.slice(0, 40))
    h.disposeBridge()
  }, 30_000)

  it('文本与图片按**线序**排列，不是把图片挪到末尾', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '改之前：' }, image(), { type: 'text', text: '改之后：' }, image()],
    })
    // 顺序错了这句话就变了意思，而「收到了两张图」照样成立。
    expect(h.llm.blockKindsUsed.at(-1)).toEqual(['text', 'image', 'text', 'image'])
    expect(h.llm.imagesUsed.at(-1)).toHaveLength(2)
    h.disposeBridge()
  }, 30_000)

  it('相邻文本并成一块 —— 一句话不该被切碎', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [
        { type: 'text', text: '看这个 ' },
        { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
        { type: 'text', text: ' 文件' },
        image(),
      ],
    })
    expect(h.llm.blockKindsUsed.at(-1)).toEqual(['text', 'image'])
    // 三段文本并成一块，且 resource_link 仍在里面。整条请求里搜而不是按下标取
    // ——用户那条消息旁边还有运行时上下文快照，位置不由本用例决定。
    expect(h.llm.historiesUsed.at(-1)?.join('\n')).toContain('a.ts')
    h.disposeBridge()
  }, 30_000)

  it('只发图不发字 —— 「这张图里是什么」不该被当成空 prompt', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [image()],
    })
    expect(h.llm.blockKindsUsed.at(-1)).toEqual(['image'])
    h.disposeBridge()
  }, 30_000)

  it('两张一样的图去重成同一个对象 —— 内容寻址的题中之义', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [image(), image()],
    })
    const ids = h.llm.imagesUsed.at(-1) ?? []
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    h.disposeBridge()
  }, 30_000)
})

describe('TC-IMG-03 拒绝路径', () => {
  it('纯文本模型上发图被拒，且信息里报得出模型名', async () => {
    // 这是用户最容易撞上的一条：部署默认模型就是纯文本的。上游适配器对它也会
    // 拒绝，但那是在请求路上抛的 UNSUPPORTED_CONTENT——表现为一个失败的回合，
    // 而不是一次被拒的请求，用户看到的是「出错了」而不是「换个模型」。
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const { sessionId } = await h.acp.request('session/new', {
      cwd: realTempDir('dsacp-ws-'),
      mcpServers: [],
    })
    await expect(
      h.acp.request('session/prompt', {
        sessionId: sessionId as never,
        prompt: [{ type: 'text', text: '看图' }, image()],
      }),
    ).rejects.toThrow(/does not accept image input/)
    // 一次模型请求都不该发出去。
    expect(h.llm.calls).toBe(0)
    h.disposeBridge()
  }, 30_000)

  it('切到收图模型之后同一个请求就通了 —— 拒绝的是「现在不行」', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const { sessionId } = await h.acp.request('session/new', {
      cwd: realTempDir('dsacp-ws-'),
      mcpServers: [],
    })
    const prompt = { sessionId: sessionId as never, prompt: [image()] }
    await expect(h.acp.request('session/prompt', prompt)).rejects.toThrow(/does not accept image input/)

    // 关键：**逐次**按会话当前路由判断。建会话时的答案不作数，否则这里会继续拒。
    h.llm.offerVisionModel = true
    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_VISION as never,
    })
    await h.acp.request('session/prompt', prompt)
    expect(h.llm.imagesUsed.at(-1)).toHaveLength(1)
    h.disposeBridge()
  }, 30_000)

  it('不是规范 base64 的负载被拒', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await expect(
      h.acp.request('session/prompt', {
        sessionId: sessionId as never,
        // URL-safe 别名不是规范 base64。放行它等于接受两种编码，而两者算出来的
        // 内容地址不同——同一张图会在库里存成两个对象。
        prompt: [image(NOISY_PNG.replace(/\+/g, '-').replace(/\//g, '_'))],
      }),
    ).rejects.toThrow()
    h.disposeBridge()
  }, 30_000)

  it('声称是 PNG 但字节不是图片的负载被拒', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-') })
    const sessionId = await visionSession(h)
    await expect(
      h.acp.request('session/prompt', {
        sessionId: sessionId as never,
        prompt: [image(Buffer.from('这不是图片').toString('base64'))],
      }),
    ).rejects.toThrow()
    // 拒绝发生在**入队之前**：一条带着坏附件的消息不该进会话日志。
    expect(h.llm.calls).toBe(0)
    h.disposeBridge()
  }, 30_000)

  it('带图片的输入不进命令面 —— 命令收不下图片，丢掉它就是静默丢数据', async () => {
    const h = await createHarness({ attachments: realTempDir('dsacp-att-'), commands: true, planMode: true })
    const sessionId = await visionSession(h)
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '/plan 看这张图' }, image()],
    })
    // 走了模型而不是命令面，图片因此还在。
    expect(h.llm.imagesUsed.at(-1)).toHaveLength(1)
    h.disposeBridge()
  }, 30_000)
})
