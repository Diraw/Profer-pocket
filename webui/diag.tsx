/**
 * 诊断浮层：URL 带 `?diag=1` 时挂在页面右下角，每 400ms 打印一次实时推导状态。
 *
 * 用途：排查「实时消息流里正文 headline 消失、刷新后又出现」这类只有客户端
 * 累积状态能看见的问题 —— 刷新拉取的数据是干净的，坏的是实时累积过程，
 * 必须把累积态（消息序列、分组、timeline 推导、运行标志）原样打出来对比。
 *
 * 只读展示，不参与渲染；不传会话内容，只传结构摘要（type/uuid 前 8 位/块类型）。
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
  reconnects: number
  connected: boolean
  running: boolean
  sessionActive: boolean
  lastTurnFinished: boolean
  lastNonSystem: { index: number; pending: boolean }
  messages: DiagMessageSummary[]
  lastTurn: DiagLastTurn | null
}

export function DiagOverlay({ data }: { data: DiagData }): null {
  const [enabled] = React.useState(
    () => new URLSearchParams(window.location.search).has('diag'),
  )
  const dataRef = React.useRef(data)
  dataRef.current = data

  React.useEffect(() => {
    if (!enabled) return
    const node = document.createElement('pre')
    node.setAttribute('data-testid', 'webui-diag')
    node.style.cssText = [
      'position:fixed', 'right:8px', 'bottom:8px', 'margin:0', 'padding:8px',
      'max-width:min(94vw,640px)', 'max-height:56vh', 'overflow:auto',
      'background:rgba(10,12,10,.86)', 'color:#9fe8a8', 'border-radius:10px',
      'font:10px/1.45 ui-monospace,Menlo,Consolas,monospace', 'white-space:pre-wrap',
      'word-break:break-all', 'z-index:2147483000', 'pointer-events:none',
    ].join(';')
    document.body.appendChild(node)
    const timer = window.setInterval(() => {
      node.textContent = JSON.stringify(dataRef.current, null, 1)
    }, 400)
    return () => {
      window.clearInterval(timer)
      node.remove()
    }
  }, [enabled])

  return null
}
