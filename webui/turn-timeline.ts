/**
 * 把一个 assistant-turn 拆成「最终正文 + 过程时间线」。
 *
 * 桌面端的过程组是「叙述 → 工具行 → 思考摘要」按原始顺序交织的（见
 * `render-block-derivation.ts` + `ProcessBlockGroup.tsx`），而 WebUI 之前只把
 * 工具名压成一列扁平清单：54 次调用滚下来，分不清哪一步在干什么。
 *
 * 这里只做纯派生，不持有折叠状态。口径对齐桌面端，但简化了两处：
 * 1. 不做折叠窗口（`FoldedSegmentsRegion`）——分页已经限制了窗口大小；
 * 2. 不做分段动画与倒数自动收起。
 */
import type { MessageGroup } from '@profer/session-core'

export interface TimelineTool {
  id: string
  name: string
  /** 主进程投影下来的一行摘要（命令 / prompt / 业务 id…），可能没有。 */
  summary?: string
  failed?: boolean
  /** 工具结果是否已回来：决定行内是「进行中」还是完成态。 */
  done: boolean
  /** 投影里保留的文件路径，展开时能看到。 */
  filePath?: string
}

export type TimelineItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string; partial: boolean }
  | { kind: 'tool'; key: string; tool: TimelineTool }

export interface AssistantTimeline {
  /** 最终正文，留在过程组外直接可见；可能为空。 */
  headline: string
  /** 过程组内的条目，保持原始顺序。 */
  items: TimelineItem[]
  toolCount: number
  thinkingCount: number
  textCount: number
  /** 「执行过程：54 次工具调用，17 段思考，6 条消息」 */
  summary: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * 工具名 → 「分类 + 名称」。
 *
 * MCP 工具是 `mcp__server__tool`，分类就是 server（大写的 `AUTOMATION` / `COLLABORATION`）；
 * 内置工具没有分类，直接显示原名 —— 与桌面端过程行的呈现一致。
 */
export function toolLabel(name: string): { category?: string; label: string } {
  const parts = name.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3 && parts[1]) {
    return { category: parts[1].toUpperCase(), label: parts.slice(2).join('_') }
  }
  return { label: name }
}

function emptyTimeline(): AssistantTimeline {
  return { headline: '', items: [], toolCount: 0, thinkingCount: 0, textCount: 0, summary: '执行过程' }
}

export function summarizeProcess(toolCount: number, thinkingCount: number, textCount: number): string {
  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (thinkingCount > 0) parts.push(`${thinkingCount} 段思考`)
  if (textCount > 0) parts.push(`${textCount} 条消息`)
  return `执行过程：${parts.join('，') || '过程'}`
}

/**
 * 定位「最终正文」区间：最后一段连续 text。
 *
 * 与桌面端同一条判据：该 text 之后只能是 thinking（reasoning 晚于正文到达的形态），
 * 且它之前的所有 tool_use 结果都得到齐 —— 否则这段 text 更可能是「给工具看的中间说明」，
 * 整轮应当收在过程组里。中途（结果未到）不外置，等结果回来再挪出去。
 */
function findHeadlineRange(items: TimelineItem[]): { start: number; end: number } | null {
  let end = -1
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]?.kind === 'text') { end = index; break }
  }
  if (end < 0) return null
  for (let index = end + 1; index < items.length; index++) {
    if (items[index]?.kind !== 'thinking') return null
  }
  for (let index = 0; index < end; index++) {
    const item = items[index]
    if (item?.kind === 'tool' && !item.tool.done) return null
  }
  let start = end
  while (start > 0 && items[start - 1]?.kind === 'text') start--
  return { start, end }
}

/**
 * 收集一轮里的过程条目。
 *
 * 两遍扫描：先收工具结果（决定 done / failed），再按原始顺序排块 ——
 * tool_result 与 tool_use 可能落在不同消息里，一遍扫会在结果到达前就渲染成「进行中」。
 */
export function buildAssistantTimeline(group: MessageGroup | undefined): AssistantTimeline {
  if (!group || group.type !== 'assistant-turn') return emptyTimeline()

  const resultIds = new Set<string>()
  const failedIds = new Set<string>()
  for (const message of group.turnMessages) {
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      if (typeof block.tool_use_id !== 'string') continue
      resultIds.add(block.tool_use_id)
      if (block.is_error === true) failedIds.add(block.tool_use_id)
    }
  }

  const items: TimelineItem[] = []
  for (const message of group.turnMessages) {
    const record = message as { message?: { content?: unknown }; _partial?: unknown }
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    const partial = record._partial === true
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text') {
        const text = asString(block.text)
        if (text) items.push({ kind: 'text', key: `text-${items.length}`, text })
        continue
      }
      if (block.type === 'thinking') {
        const text = asString(block.thinking)
        if (text) items.push({ kind: 'thinking', key: `think-${items.length}`, text, partial })
        continue
      }
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      const id = typeof block.id === 'string' ? block.id : `tool-${items.length}`
      const input = isRecord(block.input) ? block.input : {}
      items.push({
        kind: 'tool',
        key: id,
        tool: {
          id,
          name: block.name,
          summary: asString(block.summary),
          filePath: asString(input.file_path),
          done: resultIds.has(id),
          ...(failedIds.has(id) ? { failed: true } : {}),
        },
      })
    }
  }

  const range = findHeadlineRange(items)
  const headline = range
    ? items.slice(range.start, range.end + 1)
      .map((item) => (item.kind === 'text' ? item.text : ''))
      .join('\n\n')
      .trim()
    : ''
  const processItems = range
    ? [...items.slice(0, range.start), ...items.slice(range.end + 1)]
    : items

  let toolCount = 0
  let thinkingCount = 0
  let textCount = 0
  for (const item of processItems) {
    if (item.kind === 'tool') toolCount += 1
    else if (item.kind === 'thinking') thinkingCount += 1
    else textCount += 1
  }

  return {
    headline,
    items: processItems,
    toolCount,
    thinkingCount,
    textCount,
    summary: summarizeProcess(toolCount, thinkingCount, textCount),
  }
}
