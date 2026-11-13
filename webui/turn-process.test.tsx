import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MessageGroup } from '@profer/session-core'
import { buildAssistantTimeline } from './turn-timeline'
import { TurnProcess } from './turn-process'

function turnOf(contents: unknown[][], results: string[] = []): MessageGroup {
  const assistant = contents.map((content, index) => ({
    type: 'assistant' as const,
    uuid: `a${index}`,
    message: { role: 'assistant', content },
  }))
  const toolResults = results.map((id) => ({
    type: 'user' as const,
    uuid: `r-${id}`,
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  }))
  return { type: 'assistant-turn', assistantMessages: assistant, turnMessages: [...assistant, ...toolResults] } as never as MessageGroup
}

const text = (value: string): unknown => ({ type: 'text', text: value })
const thinking = (value: string): unknown => ({ type: 'thinking', thinking: value })
const tool = (id: string, name: string, summary?: string): unknown => ({ type: 'tool_use', id, name, input: {}, ...(summary ? { summary } : {}) })

describe('执行过程组渲染', () => {
  const timeline = buildAssistantTimeline(turnOf([
    [thinking('先确认目录结构'), text('看一下工作区'), tool('t1', 'mcp__collaboration__delegate_agent', '一行原文结论，不要复述过程。')],
  ], ['t1']))

  test('Given 运行中 When 渲染 Then 标题行是「N 次工具调用」句式，内容默认展开', () => {
    const html = renderToStaticMarkup(<TurnProcess timeline={timeline} live />)
    expect(html).toContain('执行过程：1 次工具调用，1 段思考，1 条消息')
    // live 时默认展开：工具行与思考行都在 DOM 里
    expect(html).toContain('delegate_agent')
    expect(html).toContain('COLLABORATION')
  })

  test('Given 已结束 When 渲染 Then 默认收起，过程内容不进 DOM（避免长会话一屏全被过程占满）', () => {
    const html = renderToStaticMarkup(<TurnProcess timeline={timeline} live={false} />)
    expect(html).toContain('执行过程：1 次工具调用，1 段思考，1 条消息')
    expect(html).not.toContain('delegate_agent')
  })

  test('Given 工具行 When 渲染 Then 摘要就在行内，不用展开才看得到在做什么', () => {
    const html = renderToStaticMarkup(<TurnProcess timeline={timeline} live />)
    expect(html).toContain('一行原文结论，不要复述过程。')
  })

  test('Given 没有过程条目 When 渲染 Then 返回 null，不留一行空标题', () => {
    const empty = buildAssistantTimeline(turnOf([[text('直接回答')]]))
    expect(renderToStaticMarkup(<TurnProcess timeline={empty} live />)).toBe('')
  })
})
