import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { INITIAL_PAGE, decodeMessagePage, mergePrepend, tailPageSize, upsertMessage } from './message-page'

const message = (uuid: string, text = 'hi'): SDKMessage =>
  ({ uuid, type: 'assistant', message: { role: 'assistant', content: text } } as unknown as SDKMessage)

describe('消息分页：返回形态解析', () => {
  test('Given 分页结构 When 解析 Then 取出正文、起点与是否还有更早', () => {
    const page = decodeMessagePage({
      messages: [message('a')],
      total: 120,
      startIndex: 60,
      endIndex: 119,
      hasMore: true,
    })
    expect(page.messages).toHaveLength(1)
    expect(page.startIndex).toBe(60)
    expect(page.hasMore).toBe(true)
  })

  test('Given 旧服务端返回裸数组 When 解析 Then 视为「全量已到头」，不显示加载更早', () => {
    const page = decodeMessagePage([message('a'), message('b')])
    expect(page.messages).toHaveLength(2)
    expect(page.startIndex).toBe(0)
    expect(page.hasMore).toBe(false)
  })

  test('Given 外层 data 包裹 When 解析 Then 同样能取到分页字段', () => {
    const page = decodeMessagePage({
      data: { messages: [message('a')], startIndex: 5, hasMore: true },
    })
    expect(page.messages).toHaveLength(1)
    expect(page.startIndex).toBe(5)
    expect(page.hasMore).toBe(true)
  })

  test('Given 脏数据或空值 When 解析 Then 返回空页而不是抛错', () => {
    for (const raw of [null, undefined, {}, 'oops', { messages: 'nope' }]) {
      expect(decodeMessagePage(raw)).toEqual({ messages: [], startIndex: 0, hasMore: false })
    }
  })

  test('Given 分页字段缺失 When 解析 Then 起点回退 0，且不谎称还有更早', () => {
    const page = decodeMessagePage({ messages: [message('a')] })
    expect(page.startIndex).toBe(0)
    expect(page.hasMore).toBe(false)
  })
})

describe('消息分页：向前拼接', () => {
  test('Given 相邻两页在 turn 边界重叠 When 拼接 Then 按 uuid 去重且更早的在前', () => {
    const older = [message('a'), message('b'), message('c')]
    const current = [message('c'), message('d')]
    const merged = mergePrepend(older, current)
    expect(merged.map((item) => (item as { uuid: string }).uuid)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('Given 更早的页全部已存在 When 拼接 Then 结果不变，不会重复渲染', () => {
    const current = [message('a'), message('b')]
    expect(mergePrepend([message('a')], current)).toHaveLength(2)
  })

  test('Given 历史消息没有 uuid When 拼接 Then 全部保留，宁可重复也不丢历史', () => {
    const nameless = { type: 'assistant', message: { content: 'x' } } as unknown as SDKMessage
    const merged = mergePrepend([nameless], [message('a')])
    expect(merged).toHaveLength(2)
  })
})

describe('消息分页：尾部窗口大小', () => {
  test('Given 未加载过历史 When 取尾部 Then 至少一屏首屏量', () => {
    expect(tailPageSize(0)).toBe(INITIAL_PAGE)
  })

  test('Given 已加载过历史 When 重取尾部 Then 覆盖当前持有量并留余量，避免窗口往前滑', () => {
    expect(tailPageSize(200)).toBeGreaterThan(200)
  })
})

/** partial 帧：coordinator 明言「部分帧可能没有 UUID，终稿才有」，身份只在 _provenance.messageId。 */
const partialFrame = (text: string, opts: { messageId?: string; uuid?: string } = {}): SDKMessage =>
  ({
    type: 'assistant',
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
    _partial: true,
    _provenance: { schemaVersion: 1, runId: 'run-1', messageId: opts.messageId ?? 'msg-1', author: { type: 'agent', id: 's1' } },
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage)

/** 终稿：带 provider uuid，与 partial 共享同一个 messageId。 */
const finalFrame = (text: string, uuid = 'uuid-final', messageId = 'msg-1'): SDKMessage =>
  ({
    type: 'assistant',
    uuid,
    _provenance: { schemaVersion: 1, runId: 'run-1', messageId, author: { type: 'agent', id: 's1' } },
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage)

describe('实时消息合并：按 _provenance 身份覆盖，partial 不成残条', () => {
  test('Given partial 帧无 uuid、final 带 uuid 且同 messageId When 合并 Then 覆盖成一条（残条根因）', () => {
    // 这正是「正文一输出完就消失、刷新又出现」的机制：只按 uuid 合并时，
    // 每条 partial（无 uuid）都被追加，text 残条之后挂 tool_use 残条挡住 headline。
    const list = upsertMessage([], partialFrame('你'))
    const list2 = upsertMessage(list, partialFrame('你好'))
    const list3 = upsertMessage(list2, finalFrame('你好', 'uuid-final'))
    expect(list3).toHaveLength(1)
    expect((list3[0] as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe('你好')
  })

  test('Given partial 帧各自带不同 uuid When 合并 Then 仍按 messageId 覆盖成一条', () => {
    const list = upsertMessage([], partialFrame('你', { uuid: 'u1', messageId: 'm' }))
    const list2 = upsertMessage(list, partialFrame('你好', { uuid: 'u2', messageId: 'm' }))
    expect(list2).toHaveLength(1)
  })

  test('Given 两条不同 messageId 的消息 When 合并 Then 各自成条不互相覆盖', () => {
    let list: SDKMessage[] = []
    list = upsertMessage(list, partialFrame('a', { messageId: 'm1' }))
    list = upsertMessage(list, partialFrame('b', { messageId: 'm2' }))
    list = upsertMessage(list, finalFrame('a终稿', 'uuid-a', 'm1'))
    expect(list).toHaveLength(2)
  })

  test('Given 无 _provenance 的旧消息 When 合并 Then 回退按 uuid 覆盖', () => {
    let list = upsertMessage([], message('u1', 'old'))
    list = upsertMessage(list, message('u1', 'new'))
    expect(list).toHaveLength(1)
  })

  test('Given result 消息（无 uuid 无 provenance）When 合并 Then 追加不去覆盖任何东西', () => {
    const result = { type: 'result', subtype: 'success' } as unknown as SDKMessage
    let list = upsertMessage([finalFrame('hi')], result)
    list = upsertMessage(list, result)
    expect(list).toHaveLength(3)
  })

  test('Given 已有 final、同身份 partial 还在飞（回前台重拉后的反序）When 合并 Then 保留 final 不让内容倒退', () => {
    const list = upsertMessage([finalFrame('完整正文')], partialFrame('完整正'))
    expect(list).toHaveLength(1)
    expect((list[0] as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe('完整正文')
  })

  test('Given 已有 partial、同身份 final 到达 When 合并 Then 终稿覆盖增量', () => {
    const list = upsertMessage([partialFrame('完整正')], finalFrame('完整正文'))
    expect(list).toHaveLength(1)
    expect((list[0] as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe('完整正文')
  })

  test('Given 同身份 final 重复到达（重连重放）When 合并 Then 保持一条', () => {
    let list = upsertMessage([], finalFrame('hi'))
    list = upsertMessage(list, finalFrame('hi'))
    expect(list).toHaveLength(1)
  })
})
