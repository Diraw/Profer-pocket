import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { INITIAL_PAGE, decodeMessagePage, mergePrepend, tailPageSize } from './message-page'

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
