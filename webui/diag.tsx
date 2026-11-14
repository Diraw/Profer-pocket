/**
 * 诊断浮层：URL 带 `?diag=1` 时挂在页面右下角，每 400ms 刷新一次实时推导状态。
 *
 * 用途：排查「实时消息流里正文 headline 消失、刷新后又出现」这类只有客户端
 * 累积状态能看见的问题 —— 刷新拉取的数据是干净的，坏的是实时累积过程，
 * 必须把累积态（消息序列、分组、timeline 推导、运行标志）原样打出来对比。
 *
 * 交互：可选中复制；「复制」按钮一键写剪贴板（不可用时退化为全选）；
 * 「收起」缩成右下角小 pill，不挡输入框，随时点开。
 */
import * as React from 'react'

export interface DiagMessageSummary {
  t: string
  u: string
  p: boolean
  r: boolean
  b: string[]
}

export interface DiagLastTurn {
  headlineLen: number
  headline: string
  items: string[]
  pendingTools: number
  trailingPending: boolean
  finished: boolean
  settled: boolean
}

export interface DiagData {
  build: string
  stale: boolean
  events: string[]
  reconnects: number
  connected: boolean
  running: boolean
  sessionActive: boolean
  lastTurnFinished: boolean
  lastNonSystem: { index: number; pending: boolean }
  messages: DiagMessageSummary[]
  lastTurn: DiagLastTurn | null
}

export function DiagOverlay({ data }: { data: DiagData }): React.ReactElement | null {
  const [enabled] = React.useState(
    () => new URLSearchParams(window.location.search).has('diag'),
  )
  const [collapsed, setCollapsed] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const dataRef = React.useRef(data)
  dataRef.current = data
  const bodyRef = React.useRef<HTMLPreElement>(null)

  React.useEffect(() => {
    if (!enabled || collapsed) return
    // 直接写 textContent，不走 React 重渲染：流式期间每帧渲染，400ms 刷新足够
    const timer = window.setInterval(() => {
      if (bodyRef.current) bodyRef.current.textContent = JSON.stringify(dataRef.current, null, 1)
    }, 400)
    return () => { window.clearInterval(timer) }
  }, [enabled, collapsed])

  const copy = React.useCallback(async (): Promise<void> => {
    const text = JSON.stringify(dataRef.current, null, 1)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
      return
    } catch {
      // 剪贴板不可用（非安全上下文 / 权限拒绝）：退化为全选，用户手动复制
    }
    const node = bodyRef.current
    if (!node) return
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [])

  if (!enabled) return null

  if (collapsed) {
    return (
      <button
        type="button"
        className="diag-pill"
        onClick={() => setCollapsed(false)}
        title="展开诊断面板"
      >
        DIAG
      </button>
    )
  }

  return (
    <div className="diag-panel" data-testid="webui-diag-panel">
      <div className="diag-bar">
        <span className="diag-title">DIAG</span>
        <button type="button" className="diag-btn" onClick={() => void copy()}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
        <button type="button" className="diag-btn" onClick={() => setCollapsed(true)}>
          收起
        </button>
      </div>
      <pre className="diag-body" ref={bodyRef} data-testid="webui-diag" />
    </div>
  )
}
