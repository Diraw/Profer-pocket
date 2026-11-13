import { describe, expect, test } from 'bun:test'
import type { MessageGroup } from '@profer/session-core'
import { buildAssistantTimeline, isTurnFinished, isTurnSettled, summarizeProcess, toolLabel } from './turn-timeline'

/** 一轮 = 若干 assistant 消息 + 承载 tool_result 的 user 消息（tail 用来追加 result 等收尾消息）。 */
function turnOf(
  contents: unknown[][],
  results: Array<{ id: string; error?: boolean }> = [],
  tail: unknown[] = [],
): MessageGroup {
  const assistant = contents.map((content, index) => ({
    type: 'assistant' as const,
    uuid: `a${index}`,
    message: { role: 'assistant', content },
  }))
  const toolResults = results.map((result) => ({
    type: 'user' as const,
    uuid: `r-${result.id}`,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: result.id,
        ...(result.error ? { is_error: true } : {}),
      }],
    },
  }))
  return {
    type: 'assistant-turn',
    assistantMessages: assistant,
    turnMessages: [...assistant, ...toolResults, ...tail],
  } as never as MessageGroup
}

/** 顶层 result：整轮收尾的唯一可靠信号（子代理的 result 带 parent_tool_use_id）。 */
const result = (parentToolUseId: string | null = null): unknown => ({
  type: 'result', uuid: `res-${parentToolUseId ?? 'top'}`, parent_tool_use_id: parentToolUseId,
})

const text = (value: string): unknown => ({ type: 'text', text: value })
const thinking = (value: string): unknown => ({ type: 'thinking', thinking: value })
const tool = (id: string, name: string, input: Record<string, unknown> = {}, summary?: string): unknown => ({
  type: 'tool_use', id, name, input, ...(summary ? { summary } : {}),
})

describe('过程时间线：顺序与正文外置', () => {
  test('Given 叙述 + 工具 + 结尾正文 When 拆分 Then 过程保持原顺序，正文只留最后一段', () => {
    const timeline = buildAssistantTimeline(turnOf(
      [[text('先看一下目录'), tool('t1', 'Bash', { file_path: '/x' }, 'ls -la')]],
      [{ id: 't1' }],
    ))
    // 结尾没有 text 段 → 没有可外置的正文
    expect(timeline.headline).toBe('')
    expect(timeline.items.map((item) => item.kind)).toEqual(['text', 'tool'])
  })

  test('Given 过程后跟最终答复 When 拆分 Then 答复外置，过程里不再重复它', () => {
    const timeline = buildAssistantTimeline(turnOf([
      [text('先跑一下测试'), tool('t1', 'Bash', {}, 'bun test')],
      [text('测试通过，问题出在缓存。')],
    ], [{ id: 't1' }]))

    expect(timeline.headline).toBe('测试通过，问题出在缓存。')
    expect(timeline.items.map((item) => item.kind)).toEqual(['text', 'tool'])
    expect(timeline.summary).toBe('执行过程：1 次工具调用，1 条消息')
  })

  test('Given 工具结果还没回来 When 拆分 Then 保守地不外置（那段 text 可能是给工具看的说明）', () => {
    const timeline = buildAssistantTimeline(turnOf([
      [tool('t1', 'Bash', {}, 'bun test')],
      [text('看起来快好了')],
    ]))
    expect(timeline.headline).toBe('')
    expect(timeline.items.some((item) => item.kind === 'text')).toBe(true)
  })

  test('Given 正文之后又追加了思考 When 拆分 Then 正文仍外置，思考留在过程里', () => {
    const timeline = buildAssistantTimeline(turnOf([
      [text('开始'), tool('t1', 'Read', {}, 'a.ts')],
      [text('改好了。'), thinking('还要注意缓存')],
    ], [{ id: 't1' }]))
    expect(timeline.headline).toBe('改好了。')
    expect(timeline.items.map((item) => item.kind)).toEqual(['text', 'tool', 'thinking'])
  })

  test('Given 只有思考与工具 When 拆分 Then 没有正文，标题行仍然给出可读计数', () => {
    const timeline = buildAssistantTimeline(turnOf([[thinking('先想一下'), tool('t1', 'Glob', {}, '*.ts')]]))
    expect(timeline.headline).toBe('')
    expect(timeline.summary).toBe('执行过程：1 次工具调用，1 段思考')
  })

  test('Given 有工具结果永不回来但整轮已收尾 When 拆分 Then 正文仍然外置（否则用户以为没有回答）', () => {
    // 真实形态：工具被中断，tool_result 从未落盘；死等结果会让正文永久锁在过程组里
    const timeline = buildAssistantTimeline(turnOf([
      [tool('t1', 'inspect_preview', {}, '预览')],
      [text('预览器有故障，但页面本身可以看。')],
    ], [], [result()]))
    expect(timeline.headline).toBe('预览器有故障，但页面本身可以看。')
    expect(timeline.items.map((item) => item.kind)).toEqual(['tool'])
  })

  test('Given 同样的形态但这轮还在跑 When 拆分 Then 保守地不外置，等结果', () => {
    const timeline = buildAssistantTimeline(turnOf([
      [tool('t1', 'inspect_preview', {}, '预览')],
      [text('我先看看这一页')],
    ]))
    expect(timeline.headline).toBe('')
  })

  test('Given 末尾正文之后还有工具 When 拆分 Then 仍不外置 —— 那是中间说明不是最终答复', () => {
    const timeline = buildAssistantTimeline(turnOf([
      [text('我先确认一下')],
      [tool('t1', 'Bash', {}, 'ls')],
    ], [{ id: 't1' }], [result()]))
    expect(timeline.headline).toBe('')
  })
})

describe('轮次是否收尾', () => {
  test('Given 有顶层 result When 判定 Then 已收尾', () => {
    expect(isTurnFinished(turnOf([[text('好了')]], [], [result()]))).toBe(true)
  })

  test('Given 只有子代理 result When 判定 Then 不算收尾（子任务结束≠整轮结束）', () => {
    expect(isTurnFinished(turnOf([[text('进行中')]], [], [result('tool-abc')]))).toBe(false)
  })

  test('Given 没有任何 result When 判定 Then 未收尾', () => {
    expect(isTurnFinished(turnOf([[text('进行中')]]))).toBe(false)
  })

  test('Given 非 assistant-turn 分组 When 判定 Then 一律视为未收尾', () => {
    expect(isTurnFinished(undefined)).toBe(false)
  })
})

describe('过程时间线：工具状态', () => {
  test('Given 结果已回且带 is_error When 拆分 Then 标记失败并置 done', () => {
    const timeline = buildAssistantTimeline(turnOf([[tool('t1', 'Bash', {}, 'exit 1')]], [{ id: 't1', error: true }]))
    const item = timeline.items[0]
    expect(item?.kind).toBe('tool')
    if (item?.kind !== 'tool') throw new Error('期望工具条目')
    expect(item.tool.done).toBe(true)
    expect(item.tool.failed).toBe(true)
  })

  test('Given 结果未回 When 拆分 Then done=false（行内显示呼吸点，不是「已完成」）', () => {
    const timeline = buildAssistantTimeline(turnOf([[tool('t1', 'Bash')]]))
    const item = timeline.items[0]
    if (item?.kind !== 'tool') throw new Error('期望工具条目')
    expect(item.tool.done).toBe(false)
    expect(item.tool.failed).toBeUndefined()
  })

  test('Given 工具带文件路径 When 拆分 Then 路径可展开查看', () => {
    const timeline = buildAssistantTimeline(turnOf([[
      tool('t1', 'Read', { file_path: 'D:/ProferAI/README.md' }, ''),
    ]]))
    const item = timeline.items[0]
    if (item?.kind !== 'tool') throw new Error('期望工具条目')
    expect(item.tool.filePath).toBe('D:/ProferAI/README.md')
  })
})

describe('工具名解析', () => {
  test('Given MCP 工具 When 解析 Then 分类取 server，名称取工具段', () => {
    expect(toolLabel('mcp__collaboration__delegate_agent')).toEqual({ category: 'COLLABORATION', label: 'delegate_agent' })
    expect(toolLabel('mcp__automation__delete_automation')).toEqual({ category: 'AUTOMATION', label: 'delete_automation' })
  })

  test('Given 内置工具 When 解析 Then 没有分类，只显示原名', () => {
    expect(toolLabel('BrowserNewTab')).toEqual({ label: 'BrowserNewTab' })
  })

  test('Given 名称里带多个双下划线 When 解析 Then 只切出第一段分类', () => {
    expect(toolLabel('mcp__memory-archive__search_memory')).toEqual({ category: 'MEMORY-ARCHIVE', label: 'search_memory' })
  })
})

describe('过程句式', () => {
  test('Given 三项都有 When 汇总 Then 与桌面端同句式', () => {
    expect(summarizeProcess(54, 17, 6)).toBe('执行过程：54 次工具调用，17 段思考，6 条消息')
  })

  test('Given 只有部分计数 When 汇总 Then 不写 0', () => {
    expect(summarizeProcess(1, 0, 0)).toBe('执行过程：1 次工具调用')
    expect(summarizeProcess(0, 2, 0)).toBe('执行过程：2 段思考')
  })

  test('Given 全为 0 When 汇总 Then 退化成「过程」，不出现空标题', () => {
    expect(summarizeProcess(0, 0, 0)).toBe('执行过程：过程')
  })
})

describe('非助手回合', () => {
  test('Given 用户回合 When 派生 Then 空时间线（用户输入不进过程组）', () => {
    const timeline = buildAssistantTimeline({ type: 'user', message: { message: { content: [text('你好')] } } } as never)
    expect(timeline.items).toEqual([])
    expect(timeline.headline).toBe('')
  })

  test('Given 没有分组 When 派生 Then 空时间线，调用方不必判空', () => {
    expect(buildAssistantTimeline(undefined).summary).toBe('执行过程')
  })
})

describe('过程组收起判据（WebUI 看不到 result）', () => {
  const text = (value: string) => [{ type: 'text', text: value }]
  const tool = (id: string) => [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/a' } }]

  test('Given 有顶层 result When 判定收尾 Then true（权威判据仍然生效）', () => {
    const group = turnOf([tool('t1')], [{ id: 't1' }], [{ type: 'result', subtype: 'success' }])
    expect(isTurnSettled(group, buildAssistantTimeline(group))).toBe(true)
  })

  test('Given 没有 result 但最终正文已抽出、工具都完成 When 判定收尾 Then true', () => {
    // 这就是网页端的真实形态：projectSdkMessagesToPocketView 会把 result 整条过滤掉
    const group = turnOf([tool('t1'), text('已经做完了。')], [{ id: 't1' }])
    const timeline = buildAssistantTimeline(group)
    expect(timeline.headline).toContain('已经做完了')
    expect(isTurnFinished(group)).toBe(false)
    expect(isTurnSettled(group, timeline)).toBe(true)
  })

  test('Given 最终正文已出现但还有工具没拿到结果 When 判定收尾 Then false（不能提前收起）', () => {
    const group = turnOf([tool('t1'), tool('t2'), text('先写到这里。')], [{ id: 't1' }])
    const timeline = buildAssistantTimeline(group)
    expect(isTurnSettled(group, timeline)).toBe(false)
  })

  test('Given 只有工具调用没有正文 When 判定收尾 Then false', () => {
    const group = turnOf([tool('t1')], [{ id: 't1' }])
    expect(isTurnSettled(group, buildAssistantTimeline(group))).toBe(false)
  })

  test('Given 用户回合 / 空分组 When 判定收尾 Then false', () => {
    expect(isTurnSettled(undefined, undefined)).toBe(false)
    expect(isTurnSettled({ type: 'user', message: {} } as never, undefined)).toBe(false)
  })

  test('Given 收尾后又来了新工具调用 When 重算 Then headline 被收回 items，判据变回 false', () => {
    const settled = turnOf([tool('t1'), text('做完了。')], [{ id: 't1' }])
    expect(isTurnSettled(settled, buildAssistantTimeline(settled))).toBe(true)
    const continued = turnOf([tool('t1'), text('做完了。'), tool('t2')], [{ id: 't1' }])
    const timeline = buildAssistantTimeline(continued)
    expect(timeline.headline).toBe('')
    expect(isTurnSettled(continued, timeline)).toBe(false)
  })
})
