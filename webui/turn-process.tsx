/**
 * 执行过程组：标题行 + 「叙述 → 工具行 → 思考摘要」交织的时间线。
 *
 * 与桌面端 `ProcessBlockGroup` 对齐的部分：标题行句式、按原顺序交织、运行中展开/结束收起。
 * 对齐不了的部分：桌面端能展开每个工具的结构化结果与 diff，移动端只有投影后的一行摘要
 * （完整入参与结果不出主进程），所以这里展开只回显摘要与文件路径 —— 不假装有结果可看。
 */
import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { stripContextBlocks } from './turn-extras'
import { toolLabel, type AssistantTimeline, type TimelineTool } from './turn-timeline'

function ToolRow({ tool }: { tool: TimelineTool }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const { category, label } = toolLabel(tool.name)
  // 只有摘要或路径才算「有细节可展开」，否则不挂一个点了没反应的箭头
  const expandable = Boolean(tool.summary || tool.filePath)

  return (
    <div className={`prow${tool.failed ? ' failed' : ''}${expandable ? ' expandable' : ''}`}>
      <button
        className="prow-head"
        onClick={() => expandable && setOpen((previous) => !previous)}
        aria-expanded={expandable ? open : undefined}
        title={tool.summary ? `${label} ${tool.summary}` : label}
      >
        <span className={`prow-dot${tool.done ? '' : ' live'}`} aria-hidden="true" />
        <span className="prow-title">
          {category && <span className="prow-cat">{category}</span>}
          <span className="prow-name">{label}</span>
        </span>
        {!open && tool.summary && <span className="prow-summary">{tool.summary}</span>}
        {tool.failed && <span className="prow-flag">失败</span>}
        {expandable && <span className={`chev${open ? ' open' : ''}`} aria-hidden="true">›</span>}
      </button>
      {open && (
        <div className="prow-detail">
          {tool.summary && <span className="prow-detail-text">{tool.summary}</span>}
          {tool.filePath && <code className="prow-detail-path">{tool.filePath}</code>}
        </div>
      )}
    </div>
  )
}

function ThinkingRow({ text, partial }: { text: string; partial: boolean }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  // 折叠时只留一行开头：完整思考有 2000 字上限，直接铺开会把工具行挤到看不见
  const preview = text.replace(/\s+/g, ' ').trim()

  return (
    <div className="prow think">
      <button className="prow-head" onClick={() => setOpen((previous) => !previous)} aria-expanded={open}>
        <span className="think-mark" aria-hidden="true">✦</span>
        <span className="prow-title">
          <span className="prow-cat">思考{partial ? '中' : '摘要'}</span>
        </span>
        {!open && <span className="prow-summary">{preview}</span>}
        <span className="think-more">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  )
}

export function TurnProcess({ timeline, live }: {
  timeline: AssistantTimeline
  /** 这一轮正在跑：自动展开，结束后自动收起。 */
  live: boolean
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(live)
  // 用户手动开合过就不再跟着运行状态走，否则刚展开就被下一次事件收起
  const touchedRef = React.useRef(false)

  React.useEffect(() => {
    if (touchedRef.current) return
    setOpen(live)
  }, [live])

  if (timeline.items.length === 0) return null

  return (
    <div className="process">
      <button
        className="process-head"
        onClick={() => { touchedRef.current = true; setOpen((previous) => !previous) }}
        aria-expanded={open}
      >
        <span className={`chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
        <span className="process-summary">{timeline.summary}</span>
      </button>
      {open && (
        <div className="process-body">
          {timeline.items.map((item) => {
            if (item.kind === 'tool') return <ToolRow key={item.key} tool={item.tool} />
            if (item.kind === 'thinking') return <ThinkingRow key={item.key} text={item.text} partial={item.partial} />
            const text = stripContextBlocks(item.text)
            if (!text) return null
            return (
              <div className="process-text" key={item.key}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
