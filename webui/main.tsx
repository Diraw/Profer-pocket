/**
 * Profer WebUI —— 单会话极简页。
 *
 * 设计：一个 URL 只承载一个会话，不引入 Jotai / 侧栏 / Tab / 文件预览 / 引用跳转。
 * 通信层直接复用同仓 pocket 的 WsClient（token、心跳、重连、命令配对、断线重放都是现成的），
 * 页面与 /ws 同源；会话内容、发消息、交互审批全部经主进程单写者，本页不读写任何会话文件。
 *
 * 交互审批走「取能力不搬文件」：数据结构与命令语义对齐桌面端三张横幅，
 * UI 用自写的 interactions.tsx，不引入 electronapi-stub / atoms / globals.css。
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SDKMessage } from '@profer/shared'
import { groupIntoTurns, toTranscript } from '@profer/session-core'
import { TurnExtras, extractTurnExtras, stripContextBlocks, type ImageLoadResult } from './turn-extras'
import { GoalBar, GoalLauncher, normalizeGoal, type GoalAction, type GoalState } from './goal'
import { WsClient, defaultWsUrl } from '../src/renderer/pocket/ws-client'
import {
  InteractionCards,
  decodeInteractions,
  normalizeAskUserItems,
  normalizeExitPlanItems,
  normalizePermissionItems,
  normalizePermissionMode,
  type AskUserItem,
  type SendPermissionMode,
  type ExitPlanAction,
  type ExitPlanItem,
  type InteractionHandlers,
  type PermissionItem,
} from './interactions'
import './styles.css'

interface WebuiBoot {
  sessionId?: string
  token?: string
}

interface SessionMeta {
  title: string
  channelId: string
  modelId?: string
  workspaceId?: string
  permissionMode?: SendPermissionMode
}

declare global {
  interface Window { __PROFER_WEBUI_BOOT__?: WebuiBoot }
}

/** 由 vite define 在构建时注入，用于判断浏览器跑的是不是最新产物。 */
declare const __WEBUI_BUILD__: string
console.info('[profer-webui] build', __WEBUI_BUILD__)

/** 空态快捷入口：只填进输入框，不直接发出去，避免误触消耗一轮。 */
const QUICK_PROMPTS = ['总结一下当前进度', '接下来该做什么', '解释一下刚才的改动']

const boot = window.__PROFER_WEBUI_BOOT__
const query = new URLSearchParams(window.location.search)
const pathMatch = window.location.pathname.match(/^\/s\/([^/]+)/)
const pathId = pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : ''
const sessionId = boot?.sessionId ?? query.get('session') ?? pathId
const token = boot?.token ?? query.get('token') ?? localStorage.getItem('profer-webui-token') ?? ''

// 首屏凭据只用于过一次鉴权：立即从地址栏抹掉，避免留在浏览器历史 / Referer 里。
if (token) localStorage.setItem('profer-webui-token', token)
if (query.has('token')) {
  const clean = new URL(window.location.href)
  clean.searchParams.delete('token')
  window.history.replaceState(null, '', clean.pathname + clean.search)
}

/** 兼容服务端返回裸数组 / 分页结构 / 外层 result 三种形态。 */
function decodeMessages(raw: unknown): SDKMessage[] {
  const value = raw as { messages?: unknown; data?: unknown } | null
  if (Array.isArray(raw)) return raw as SDKMessage[]
  if (Array.isArray(value?.messages)) return value.messages as SDKMessage[]
  const data = value?.data as { messages?: unknown } | unknown[] | null
  if (Array.isArray(data)) return data as SDKMessage[]
  if (Array.isArray(data?.messages)) return (data as { messages: unknown[] }).messages as SDKMessage[]
  return []
}

/** 流式期间同一回合会落多行快照；按 uuid 覆盖而不是追加，避免重复气泡。 */
function upsertMessage(list: SDKMessage[], incoming: SDKMessage): SDKMessage[] {
  const uuid = (incoming as { uuid?: string }).uuid
  if (uuid) {
    const index = list.findIndex((item) => (item as { uuid?: string }).uuid === uuid)
    if (index >= 0) {
      const next = list.slice()
      next[index] = incoming
      return next
    }
  }
  return [...list, incoming]
}

function upsertById<T extends { requestId: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.requestId === item.requestId)
  if (index >= 0) {
    const next = list.slice()
    next[index] = item
    return next
  }
  return [...list, item]
}

function App(): React.ReactElement {
  const [messages, setMessages] = React.useState<SDKMessage[]>([])
  const [connection, setConnection] = React.useState('连接中…')
  const [connected, setConnected] = React.useState(false)
  const [meta, setMeta] = React.useState<SessionMeta | null>(null)
  const [running, setRunning] = React.useState(false)
  const [input, setInput] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [acting, setActing] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [permissions, setPermissions] = React.useState<PermissionItem[]>([])
  const [askUsers, setAskUsers] = React.useState<AskUserItem[]>([])
  const [exitPlans, setExitPlans] = React.useState<ExitPlanItem[]>([])
  const [goal, setGoal] = React.useState<GoalState | null>(null)
  const [autoApprove, setAutoApprove] = React.useState(() => localStorage.getItem('profer-webui-auto-approve') === '1')
  const clientRef = React.useRef<WsClient | null>(null)
  const autoApprovedRef = React.useRef<Set<string>>(new Set())
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const lastCompletedRef = React.useRef(0)
  /** 是否贴着底部。用户上滑阅读时不跟随新内容，只露出「回到最新」。 */
  const atBottomRef = React.useRef(true)
  const [jumpVisible, setJumpVisible] = React.useState(false)

  // session-core 的纯函数负责快照去重与 turn 分组，避免自己重抄一套口径。
  const groups = React.useMemo(() => groupIntoTurns(messages), [messages])
  const turns = React.useMemo(() => toTranscript(groups), [groups])
  const extras = React.useMemo(() => groups.map(extractTurnExtras), [groups])
  const hasPending = permissions.length + askUsers.length + exitPlans.length > 0

  /**
   * 贴底才跟随。用户上滑读历史时不能被新内容拽回底部，只露出一颗「回到最新」。
   * 平滑滚动只给按钮用：流式输出时每帧重置 smooth 动画会明显拖影。
   */
  const scrollToLatest = React.useCallback((smooth: boolean): void => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    atBottomRef.current = true
    setJumpVisible(false)
  }, [])

  const handleStreamScroll = (): void => {
    const node = scrollRef.current
    if (!node) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48
    atBottomRef.current = atBottom
    // 只在可见性真变化时 setState，否则滚动过程中每次都重渲染整个消息树。
    setJumpVisible((previous) => (previous === !atBottom ? previous : !atBottom))
  }

  React.useEffect(() => {
    if (atBottomRef.current) scrollToLatest(false)
  }, [groups, hasPending, running, scrollToLatest])

  /** 输入框自增长；先归 auto 再取 scrollHeight，否则删字后高度不会回缩。 */
  React.useEffect(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`
  }, [input])

  const reload = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      setMessages(decodeMessages(await client.getSdkMessages(sessionId)))
      setNotice((previous) => previous.startsWith('读取会话失败') ? '' : previous)
    } catch (error) {
      setNotice(`读取会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sessionId])

  /** 快照拉取：页面晚连 / 断线重连时补回已经存在的待处理交互。 */
  const loadInteractions = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      const next = decodeInteractions(await client.getPendingInteractions(sessionId))
      setPermissions(next.permissions)
      setAskUsers(next.askUsers)
      setExitPlans(next.exitPlans)
    } catch {
      // 拉取失败不打断消息读取，事件流与下一轮轮询会补上
    }
  }, [sessionId])

  /** Goal 状态完全由主进程持有，这里只做快照拉取；实时变化靠 goal_state 事件推送。 */
  const loadGoal = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      const result = await client.getGoal(sessionId) as { goal?: unknown } | null
      setGoal(normalizeGoal(result?.goal))
    } catch {
      // 读取失败不打断会话读取：事件流与下一轮 run 结束都会重新拉取
    }
  }, [sessionId])

  /** 图片不在消息体里：send_local_image 只带 path，经 WS 读取会话工作区内的图片文件。 */
  const loadImage = React.useCallback(async (path: string): Promise<ImageLoadResult> => {
    const client = clientRef.current
    // 未连接 ≠ 失败：交给 TurnImage 保持「加载中」，连接就绪后它会被重试。
    if (!client || !connected) return { status: 'pending' }
    try {
      const result = await client.readFileAsDataUrl(path, { sessionId }) as { dataUrl?: unknown } | null
      const dataUrl = result?.dataUrl
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) return { status: 'ok', dataUrl }
      return { status: 'error', message: '服务端返回的不是图片数据，可能该路径不在当前会话授权范围内' }
    } catch (error) {
      // 这里必须原样带出服务端文案（文件不存在 / 越权 / 超限），否则无从排查。
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }, [sessionId, connected])

  React.useEffect(() => {
    if (!sessionId || !token) {
      setConnection('缺少会话 ID 或访问凭据')
      return
    }
    // WsClient.sendCommand 在 onopen 之前会直接 reject「连接未就绪」，
    // 因此先备好「首次连接就绪」的 Promise，等 open 后再取会话详情与历史消息。
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    let cancelled = false
    const client = new WsClient({
      url: defaultWsUrl(),
      token,
      onStatusChange: (state, info) => {
        if (state === 'open') {
          setConnection('已连接')
          setConnected(true)
          markReady()
        }
        else if (state === 'unauthorized') { setConnection('凭据无效'); setConnected(false) }
        else { setConnection(state === 'connecting' ? '连接中…' : `连接断开${info ? ` · ${info}` : ''}`); setConnected(false) }
      },
      onAgentEvent: (event) => {
        if (event.sessionId !== sessionId) return
        const payload = event.payload as {
          kind?: string
          message?: SDKMessage
          event?: { type?: string; request?: Record<string, unknown>; requestId?: string; goal?: unknown }
        } | null
        if (payload?.kind === 'sdk_message' && payload.message) {
          setMessages((previous) => upsertMessage(previous, payload.message as SDKMessage))
          setRunning(true)
          return
        }
        if (payload?.kind !== 'profer_event') return
        const proferEvent = payload.event
        const type = proferEvent?.type
        const request = proferEvent?.request
        // Goal 每次状态变化主进程都会推一条完整状态，这里整体替换 ——
        // 状态机在电脑端，网页不做任何本地推断（重启/重连后也不会漂移）。
        if (type === 'goal_state') {
          setGoal(normalizeGoal(proferEvent?.goal))
          return
        }
        // 三类阻塞交互：request 入队、resolved 出队，口径与桌面端横幅一致。
        if (type === 'permission_request' && request) {
          const item = normalizePermissionItems([request])[0]
          if (item) setPermissions((previous) => upsertById(previous, item))
        } else if (type === 'permission_resolved') {
          setPermissions((previous) => previous.filter((item) => item.requestId !== proferEvent?.requestId))
        } else if (type === 'ask_user_request' && request) {
          const item = normalizeAskUserItems([request])[0]
          if (item) setAskUsers((previous) => upsertById(previous, item))
        } else if (type === 'ask_user_resolved') {
          setAskUsers((previous) => previous.filter((item) => item.requestId !== proferEvent?.requestId))
        } else if (type === 'exit_plan_mode_request' && request) {
          const item = normalizeExitPlanItems([request])[0]
          if (item) setExitPlans((previous) => upsertById(previous, item))
        } else if (type === 'exit_plan_mode_resolved') {
          setExitPlans((previous) => previous.filter((item) => item.requestId !== proferEvent?.requestId))
        }
        // run_completed 与 run_idle 会在同一轮先后到达，3 秒内只收敛一次。
        if (type === 'run_completed' || type === 'run_idle') {
          const now = Date.now()
          if (now - lastCompletedRef.current > 3000) {
            lastCompletedRef.current = now
            setRunning(false)
            void reload(client)
            void loadGoal(client)
          }
        }
      },
    })
    clientRef.current = client
    client.connect()
    // 5 秒兜底轮询，覆盖事件丢失与重连；与桌面端 pending-interaction 收敛节奏一致。
    const poll = window.setInterval(() => { void loadInteractions(client) }, 5000)
    void (async () => {
      const opened = await Promise.race([
        ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000)),
      ])
      if (cancelled) return
      if (!opened) {
        setNotice('连接超时，请确认 Profer 的 Web 会话已启用后刷新页面重试')
        return
      }
      try {
        const detail = await client.sessionDetail(sessionId) as { meta?: Record<string, unknown>; data?: { meta?: Record<string, unknown> } } | null
        const raw = detail?.meta ?? detail?.data?.meta ?? null
        if (raw) {
          setMeta({
            title: typeof raw.title === 'string' ? raw.title : sessionId,
            channelId: typeof raw.channelId === 'string' ? raw.channelId : '',
            modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
            workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : undefined,
            permissionMode: normalizePermissionMode(raw.permissionMode),
          })
        }
      } catch (error) {
        setNotice(`读取会话信息失败：${error instanceof Error ? error.message : String(error)}`)
      }
      await reload(client)
      await loadInteractions(client)
      await loadGoal(client)
    })()
    return () => {
      cancelled = true
      window.clearInterval(poll)
      client.disconnect()
      clientRef.current = null
    }
  }, [sessionId, token, reload, loadInteractions, loadGoal])

  const respondPermission = React.useCallback(async (
    requestId: string,
    behavior: 'allow' | 'deny',
    alwaysAllow = false,
  ): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.respondPermission(requestId, behavior, alwaysAllow)
      setPermissions((previous) => previous.filter((item) => item.requestId !== requestId))
      await loadInteractions(client)
    } catch (error) {
      setNotice(`权限响应失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadInteractions])

  const respondAskUser = React.useCallback(async (requestId: string, answers: Record<string, string>): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.respondAskUser(requestId, answers)
      setAskUsers((previous) => previous.filter((item) => item.requestId !== requestId))
      await loadInteractions(client)
    } catch (error) {
      setNotice(`回答提交失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadInteractions])

  const respondExitPlan = React.useCallback(async (
    requestId: string,
    action: ExitPlanAction,
    feedback?: string,
  ): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.respondExitPlanMode(requestId, action, feedback)
      setExitPlans((previous) => previous.filter((item) => item.requestId !== requestId))
      await loadInteractions(client)
    } catch (error) {
      setNotice(`计划审批失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadInteractions])

  /** Goal 控制：全部转发给主进程状态机，本地只按返回值刷新展示。 */
  const runGoalAction = React.useCallback(async (action: GoalAction): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      if (action === 'pause') await client.pauseGoal(sessionId)
      else if (action === 'resume') await client.resumeGoal(sessionId)
      else if (action === 'stop') await client.stopGoal(sessionId)
      else {
        await client.clearGoal(sessionId)
        setGoal(null)
        return
      }
      await loadGoal(client)
    } catch (error) {
      setNotice(`Goal 操作失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadGoal, sessionId])

  const startGoal = React.useCallback(async (text: string): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.startGoal({ sessionId, goal: text })
      await loadGoal(client)
    } catch (error) {
      setNotice(`设定目标失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadGoal, sessionId])

  const interactionHandlers = React.useMemo<InteractionHandlers>(() => ({
    onPermission: (id, behavior, alwaysAllow) => { void respondPermission(id, behavior, alwaysAllow) },
    onAskUser: (id, answers) => { void respondAskUser(id, answers) },
    onExitPlan: (id, action, feedback) => { void respondExitPlan(id, action, feedback) },
  }), [respondPermission, respondAskUser, respondExitPlan])

  // 网页端「自动批准」兜底：收到权限请求即代为允许并记住本会话，不改动桌面端的会话设置。
  React.useEffect(() => {
    if (!autoApprove || !connected || acting) return
    const first = permissions[0]
    if (!first || autoApprovedRef.current.has(first.requestId)) return
    autoApprovedRef.current.add(first.requestId)
    void respondPermission(first.requestId, 'allow', true)
  }, [autoApprove, connected, acting, permissions, respondPermission])

  const toggleAutoApprove = (): void => {
    setAutoApprove((previous) => {
      const next = !previous
      localStorage.setItem('profer-webui-auto-approve', next ? '1' : '0')
      if (!next) autoApprovedRef.current.clear()
      return next
    })
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    const client = clientRef.current
    if (!text || busy || !client) return
    if (!meta?.channelId) {
      setNotice('尚未取到会话渠道信息，请稍候或刷新页面')
      return
    }
    setBusy(true)
    try {
      // 必须透传会话当前的权限模式：服务端把它作为本轮 override。
      // 写死 'auto' 会把会话的「完全自动」降级成每步都要确认（历史 bug）。
      await client.sendMessage({
        sessionId,
        userMessage: text,
        channelId: meta.channelId,
        modelId: meta.modelId,
        workspaceId: meta.workspaceId,
        permissionMode: meta.permissionMode ?? 'bypassPermissions',
      })
      setInput('')
      setRunning(true)
      setNotice('')
    } catch (error) {
      setNotice(`发送失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await clientRef.current?.stopAgent(sessionId)
      setRunning(false)
    } catch (error) {
      setNotice(`停止失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <button
          className={`icon-btn ${autoApprove ? 'on' : ''}`}
          onClick={toggleAutoApprove}
          title={autoApprove
            ? '自动批准已开启：网页收到工具确认会直接允许，并登记为本会话免确认'
            : '自动批准已关闭：工具确认需要在这里手动点'}
        >
          {autoApprove ? '自动' : '手动'}
        </button>
        <div className="title-pill" title={meta?.title || sessionId}>
          <span className="title-text">{meta?.title || 'Profer 会话'}</span>
        </div>
        <div className="conn" title={connection}>
          <span className={`conn-dot ${connected ? 'ok' : notice ? 'bad' : 'wait'}`} />
          <span className="label">{connected ? '在线' : connection}</span>
        </div>
      </header>
      {goal
        ? <GoalBar goal={goal} busy={acting} onAction={(action) => void runGoalAction(action)} />
        : connected
          ? <GoalLauncher busy={acting} onStart={(text) => void startGoal(text)} />
          : null}
      {notice && <div className="notice">{notice}</div>}
      <div className="stage">
        <div className="stream" ref={scrollRef} onScroll={handleStreamScroll}>
          {turns.length === 0 ? (
            <div className="empty">
              <div className="empty-title">{connected ? '开始对话' : '正在连接'}</div>
              <div className="empty-desc">
                {connected
                  ? '这个页面只承载当前这一个会话。消息实时推送，并与电脑端保持同一份记录。'
                  : '正在连接 Profer 主进程。若长时间无响应，请确认电脑端的 Web 会话仍处于启用状态。'}
              </div>
              {connected && (
                <div className="empty-chips">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      className="empty-chip"
                      onClick={() => {
                        setInput(prompt)
                        inputRef.current?.focus()
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : turns.map((turn) => {
            const text = stripContextBlocks(turn.text)
            const extra = extras[turn.index]
            return (
              <div className={`turn ${turn.role === 'user' ? 'user' : 'assistant'}`} key={turn.index}>
                {text && (
                  <div className="body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  </div>
                )}
                <TurnExtras tools={extra?.tools ?? []} imagePaths={extra?.imagePaths ?? []} loadImage={loadImage} />
              </div>
            )
          })}
          {running && (
            <div className="running-hint">Profer 正在处理</div>
          )}
        </div>
        {jumpVisible && (
          <button className="jump-latest" onClick={() => scrollToLatest(true)}>
            ↓ 回到最新
          </button>
        )}
      </div>
      {hasPending && (
        <div className="interactions">
          <InteractionCards
            permissions={permissions}
            askUsers={askUsers}
            exitPlans={exitPlans}
            busy={acting}
            {...interactionHandlers}
          />
        </div>
      )}
      <div className="composer">
        <div className={`composer-pill ${hasPending ? 'blocked' : ''}`}>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={hasPending}
            placeholder={hasPending ? '先处理上方的确认卡片' : '发送消息…（Enter 发送，Shift+Enter 换行）'}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              // 中文输入法用 Enter 上屏，此时不能当成发送；isComposing 就是这道闸。
              event.preventDefault()
              void send()
            }}
          />
          {/* 一个位置一个主动作：有字是发送，运行中且没字是停止 */}
          {running && !input.trim() ? (
            <button className="send-btn run" onClick={() => void stop()} title="停止本轮运行">■</button>
          ) : (
            <button
              className={`send-btn ${input.trim() && connected && !busy && !hasPending ? 'ready' : ''}`}
              disabled={!input.trim() || !connected || busy || hasPending}
              onClick={() => void send()}
              title="发送（Enter）"
            >
              {busy ? '…' : '↑'}
            </button>
          )}
        </div>
        <div className="composer-meta">
          <span>{hasPending ? '待确认' : running ? '运行中' : connected ? '空闲' : connection}</span>
          <span className="spacer" />
          <span title={sessionId}>会话 {sessionId ? sessionId.slice(0, 8) : '未指定'}</span>
          <span>·</span>
          <span>构建 {__WEBUI_BUILD__}</span>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
