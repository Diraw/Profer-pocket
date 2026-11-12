/**
 * WebUI 的 Goal 展示与控制。
 *
 * 「取能力不搬文件」：只保留展示需要的字段，不引入 @profer/shared 的完整 AgentGoalState
 * （pocket 那份是滞后快照，且 goal 字段会随主仓演进）。状态机完全在电脑端主进程，
 * 本页只做「看到状态 + 发命令」，不做本地推断。
 */
import * as React from 'react'

export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked' | 'failed' | 'stopped' | 'stopping' | 'budget_limited'

/** 与 @profer/shared 的 GOAL_STATUSES 对齐；未知状态一律不渲染，避免把未来新增状态显示错。 */
export const GOAL_STATUSES: readonly GoalStatus[] = ['active', 'paused', 'completed', 'blocked', 'failed', 'stopped', 'stopping', 'budget_limited']

/** 可以被「继续」的状态：与主进程 utils/goal-lifecycle 的 RESUMABLE 一致。 */
const RESUMABLE: readonly GoalStatus[] = ['paused', 'blocked', 'failed', 'stopped', 'budget_limited']

export type GoalAction = 'pause' | 'resume' | 'stop' | 'clear'

export interface GoalState {
  id: string
  goal: string
  status: GoalStatus
  iteration: number
  updatedAt: number
  lastSummary?: string
  reasonDetail?: string
  maxIterations?: number
  /** 已归档/已完成时的停因文本（主进程的 stopReason，旧字段但仍有值）。 */
  stopReason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把 WS 返回的 goal 归一化成展示模型。
 *
 * 返回 null 的两种情况都不要渲染：没有 goal，或者状态不在已知集合里
 * （后者说明两端版本不一致，显示一个猜出来的状态比不显示更糟）。
 */
export function normalizeGoal(value: unknown): GoalState | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  const goal = asString(value.goal)
  const status = asString(value.status) as GoalStatus | undefined
  if (!id || !goal || !status || !GOAL_STATUSES.includes(status)) return null
  const limits = isRecord(value.limits) ? value.limits : {}
  return {
    id,
    goal,
    status,
    iteration: asNumber(value.iteration) ?? 0,
    updatedAt: asNumber(value.updatedAt) ?? 0,
    lastSummary: asString(value.lastSummary),
    reasonDetail: asString(value.reasonDetail),
    maxIterations: asNumber(limits.maxIterations),
    stopReason: asString(value.stopReason),
  }
}

/** 当前状态下允许的操作。终态只留「清除」，进行中只留「暂停/停止」，避免给出非法动作。 */
export function goalActions(status: GoalStatus): GoalAction[] {
  if (status === 'active') return ['pause', 'stop']
  if (status === 'stopping') return ['stop']
  if (status === 'completed') return ['clear']
  if (RESUMABLE.includes(status)) return ['resume', 'clear']
  return ['clear']
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: '执行中',
  paused: '已暂停',
  completed: '已完成',
  blocked: '受阻',
  failed: '失败',
  stopped: '已停止',
  stopping: '停止中',
  budget_limited: '达到预算上限',
}

const ACTION_LABEL: Record<GoalAction, string> = {
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  clear: '清除',
}

export function goalStatusLabel(status: GoalStatus): string {
  return STATUS_LABEL[status]
}

/** 一屏看全：状态 + 目标 + 轮次 + 最近一轮结论，过长自动省略。 */
export function GoalBar({ goal, busy, onAction }: {
  goal: GoalState
  busy: boolean
  onAction: (action: GoalAction) => void
}): React.ReactElement {
  const actions = goalActions(goal.status)
  const progress = goal.maxIterations ? `第 ${goal.iteration}/${goal.maxIterations} 轮` : `第 ${goal.iteration} 轮`
  const detail = goal.reasonDetail ?? goal.lastSummary ?? (goal.status === 'completed' ? goal.stopReason : undefined)
  return (
    <div className="goal-bar">
      <div className="goal-line">
        <span className={`goal-status ${goal.status}`}>{goalStatusLabel(goal.status)}</span>
        <span className="goal-text" title={goal.goal}>{goal.goal}</span>
        <span className="goal-meta">{progress}</span>
      </div>
      {detail && <div className="goal-detail" title={detail}>{detail}</div>}
      <div className="goal-actions">
        {actions.map((action) => (
          <button
            key={action}
            className={action === 'stop' || action === 'clear' ? 'goal-action danger' : 'goal-action'}
            disabled={busy}
            onClick={() => onAction(action)}
          >
            {ACTION_LABEL[action]}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 没有 Goal 时的入口：默认收起，避免给不用的会话增加视觉噪音。 */
export function GoalLauncher({ busy, onStart }: {
  busy: boolean
  onStart: (goal: string) => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')

  if (!open) {
    return (
      <button className="goal-new" onClick={() => setOpen(true)}>+ 设定目标</button>
    )
  }
  const submit = (): void => {
    const goal = text.trim()
    if (!goal || busy) return
    onStart(goal)
    setText('')
    setOpen(false)
  }
  return (
    <div className="goal-launcher">
      <textarea
        value={text}
        placeholder="描述一个需要多轮持续执行的目标，例如：把 X 模块的测试补到全绿"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() }
        }}
        rows={2}
      />
      <div className="goal-launcher-row">
        <span className="hint">Ctrl/⌘ + Enter 开始</span>
        <button onClick={() => { setOpen(false); setText('') }}>取消</button>
        <button className="primary" disabled={!text.trim() || busy} onClick={submit}>开始</button>
      </div>
    </div>
  )
}
