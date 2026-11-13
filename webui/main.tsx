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
import { TurnAttachments, TurnImages, extractTurnExtras, stripContextBlocks, type ImageLoadResult } from './turn-extras'
import { TurnProcess } from './turn-process'
import { buildAssistantTimeline, isTurnSettled } from './turn-timeline'
import {
  SOURCE_LABELS,
  describeUsage,
  describeUsageDetail,
  formatClock,
  resolveTurnModel,
  resolveTurnSource,
  resolveTurnTime,
  sumTurnUsage,
} from './turn-meta'
import { OLDER_PAGE, decodeMessagePage, mergePrepend, tailPageSize } from './message-page'
import { FOLLOW_DEFAULT, modelLabelFor, normalizeChannelModels, resolveStrengthState, type ModelOption } from './model-selection'
import { SessionSettingsMenu, describeSessionModel } from './session-settings'
import { PresetPanel } from './preset-panel'
import {
  normalizePresets,
  resolveCurrentPreset,
  selectablePresets,
  type PresetPatch,
  type PresetReference,
  type WebPreset,
} from './preset-model'
import { applyPageTitle } from './page-title'
import { base64FromDataUrl, formatBytes, resolveSendText, validateAttachmentFile } from './attachments'
import { GoalBar, GoalEditor, GoalLauncher, type GoalAction } from './goal'
import { normalizeGoal, normalizeGoalHistory, type GoalContract, type GoalLimits, type GoalState } from './goal-model'
import { VisualizationList, normalizeVisualizations, placeOrphanVisualizations, type VisualizationItem } from './visualization'
import { WsClient, defaultWsUrl } from '../src/renderer/pocket/ws-client'
import {
  InteractionCards,
  decodeInteractions,
  normalizeAskUserItems,
  normalizeExitPlanItems,
  normalizeGoalProposals,
  normalizePermissionItems,
  normalizePermissionMode,
  type AskUserItem,
  type SendPermissionMode,
  type ExitPlanAction,
  type ExitPlanItem,
  type GoalProposalItem,
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
  /** 内核决定用哪套推理档位：claude → effort，pi → 模型自带 levels */
  agentRuntime?: string
  /** 会话级强度覆盖；null/缺省表示跟随预设 */
  agentEffort?: string | null
  openAIThinkingLevel?: string | null
  /** 预设（岗位）：reference 是唯一真源，presetId 兼容旧数据 */
  presetId?: string
  presetReference?: PresetReference | null
  /** 会话所属工作区 slug —— 预设是工作区级配置，所有预设命令都要带它 */
  workspaceSlug?: string
  revision?: number
}

/**
 * `list_channels` 的渠道条目。
 *
 * 只声明用得上的字段：模型表交给 `normalizeChannelModels` 自己校验，
 * 客户端不在这里二次建模 —— 免得服务端加字段时这里先坏。
 */
interface RemoteChannel {
  id: string
  name?: string
  provider?: string
  baseUrl?: string
  enabled?: boolean
  agentRuntimes?: string[]
  models?: unknown[]
}

/**
 * 待发送附件。
 *
 * `filename` 用**服务端返回的名字**：同名文件会被加序号（a.png → a-1.png），
 * 拿本地原名回填会在发送时解析不到。失败项留在列表里而不是弹走 ——
 * 用户需要看到是哪个文件、为什么被拒。
 */
interface StagedAttachment {
  key: string
  filename: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
}

declare global {
  interface Window { __PROFER_WEBUI_BOOT__?: WebuiBoot }
}

/** 由 vite define 在构建时注入，用于判断浏览器跑的是不是最新产物。 */
declare const __WEBUI_BUILD__: string
console.info('[profer-webui] build', __WEBUI_BUILD__)

/** 空态快捷入口：只填进输入框，不直接发出去，避免误触消耗一轮。 */
const QUICK_PROMPTS = ['总结一下当前进度', '接下来该做什么', '解释一下刚才的改动']

/**
 * 触屏设备上没有 Shift 键：若 Enter 仍当发送，就永远没办法在消息里换行。
 * 按指针类型分流 —— 粗指针（手机/平板）Enter 换行、统一用圆键发送；
 * 细指针（桌面浏览器）保持 Enter 发送的老习惯。
 */
const PREFER_SEND_BUTTON = typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches

/**
 * 三态权限模式，与桌面端那个下拉是同一套东西（auto=自动审批 / bypassPermissions=完全自动 / plan=计划模式）。
 *
 * 早期版本这里是个「自动批准」开关，只替这个网页点允许、不改会话模式 ——
 * 结果两端各有一个长得像同一个意思的开关，实际互不相干：桌面仍按原模式弹卡。
 * 现在统一成一份真实状态，改这里就等于改会话。
 */
const PERMISSION_MODES: ReadonlyArray<{
  mode: SendPermissionMode
  short: string
  label: string
  hint: string
}> = [
  { mode: 'auto', short: '确认', label: '自动审批', hint: '安全操作自动放行，危险操作仍需你确认' },
  { mode: 'bypassPermissions', short: '自动', label: '完全自动', hint: '全部工具直接执行，不再逐项确认' },
  { mode: 'plan', short: '计划', label: '计划模式', hint: '只出方案不动手，你批准后才执行' },
]

/**
 * 凭据的本地副本。这个 key 必须与主进程 `webui-service.ts` 里未授权自愈页的脚本一致
 * （那边硬编码了同名字符串），否则手机上 cookie 被回收后就自愈不回来了。
 */
const TOKEN_STORAGE_KEY = 'profer-webui-token'

/**
 * localStorage 在部分隐私模式/配额为 0 时会**直接抛异常**。
 * 读不到只该失去「刷新自愈」，绝不能让整页在挂载前崩掉（那会表现为白屏 + 连不上）。
 */
function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeToken(value: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, value)
  } catch {
    /* 隐私模式下写不进去：仍然可以用当前这次会话，只是刷新后要重带 token */
  }
}

const boot = window.__PROFER_WEBUI_BOOT__
const query = new URLSearchParams(window.location.search)
/** 片段只在本机可见，不会进服务端日志与 Referer —— 适合做「永久链接」那种带凭据的书签。 */
const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const pathMatch = window.location.pathname.match(/^\/s\/([^/]+)/)
const pathId = pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : ''
const sessionId = boot?.sessionId ?? query.get('session') ?? fragment.get('session') ?? pathId
const token = boot?.token ?? query.get('token') ?? fragment.get('token') ?? readStoredToken()

// 首屏凭据只用于过一次鉴权：立即从地址栏抹掉，避免留在浏览器历史 / Referer 里。
// 片段里的 token 不动 —— 用户是特意把它留在书签里的。
if (token) storeToken(token)
if (query.has('token')) {
  const clean = new URL(window.location.href)
  clean.searchParams.delete('token')
  window.history.replaceState(null, '', clean.pathname + clean.search)
}

function isPresetReference(value: unknown): value is PresetReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof (value as { presetId?: unknown }).presetId === 'string'
    && (value as { presetId: string }).presetId.length > 0
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
  const [goalProposals, setGoalProposals] = React.useState<GoalProposalItem[]>([])
  const [goal, setGoal] = React.useState<GoalState | null>(null)
  /** 归档 Goal：清除/完成后的历史，只在展开时才有内容可看，但仍然随清除动作刷新 */
  const [goalHistory, setGoalHistory] = React.useState<GoalState[]>([])
  const [goalEditorOpen, setGoalEditorOpen] = React.useState(false)
  const [visualizations, setVisualizations] = React.useState<VisualizationItem[]>([])
  const [attachments, setAttachments] = React.useState<StagedAttachment[]>([])
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false)
  const [switchingMode, setSwitchingMode] = React.useState(false)
  /** 模型 + 强度菜单；数据来自 list_channels（模型表）与 session_detail（当前选择） */
  const [settingsMenuOpen, setSettingsMenuOpen] = React.useState(false)
  /** 预设（岗位）：列表、默认值、管理面板。作用域由会话的 workspaceSlug 决定 */
  const [presets, setPresets] = React.useState<WebPreset[]>([])
  const [presetsLoaded, setPresetsLoaded] = React.useState(false)
  const [defaultPresetId, setDefaultPresetId] = React.useState('')
  const [presetPanelOpen, setPresetPanelOpen] = React.useState(false)
  const [channels, setChannels] = React.useState<RemoteChannel[] | null>(null)
  /** Pi 内核下模型自带的推理档位；Claude 内核为 null（走 effort 四档） */
  const [reasoningLevels, setReasoningLevels] = React.useState<string[] | null>(null)
  const [switchingModel, setSwitchingModel] = React.useState(false)
  const clientRef = React.useRef<WsClient | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  /** 上传回调里要读当前列表（闭包拿不到最新 state），与 heldRef 同一手法。 */
  const attachmentsRef = React.useRef<StagedAttachment[]>([])
  const lastCompletedRef = React.useRef(0)
  /** 是否贴着底部。用户上滑阅读时不跟随新内容，只露出「回到最新」。 */
  const atBottomRef = React.useRef(true)
  const [jumpVisible, setJumpVisible] = React.useState(false)
  const [pageStart, setPageStart] = React.useState(0)
  const [hasOlder, setHasOlder] = React.useState(false)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  /** reload 要按「当前持有多少条」决定取多少尾部，但不能因此把 messages 放进依赖。 */
  const heldRef = React.useRef(0)
  /** 前置拼接前记录「距底部距离」，插入后按它还原，否则视口会跳一下。 */
  const prependAnchorRef = React.useRef<number | null>(null)

  // session-core 的纯函数负责快照去重与 turn 分组，避免自己重抄一套口径。
  const groups = React.useMemo(() => groupIntoTurns(messages), [messages])
  const turns = React.useMemo(() => toTranscript(groups), [groups])
  const extras = React.useMemo(() => groups.map(extractTurnExtras), [groups])
  /** 过程时间线：把每轮拆成「最终正文 + 交织的叙述/工具/思考」。 */
  const timelines = React.useMemo(() => groups.map(buildAssistantTimeline), [groups])
  /**
   * 「这一轮还有事在跑」。running 只是传输层的猜测，两个方向都会错：
   * ① 收尾后迟到的 assistant 消息会把它顶回 true；② 3 秒内连发的 run_completed
   * 曾被节流整条吞掉（连 setRunning(false) 都不执行）。
   *
   * 所以对外表现统一叠一道数据判据：最后一轮已收尾，就不再当作运行中。
   * 注意 **WebUI 看不到顶层 result**：服务端 `projectSdkMessagesToPocketView`
   * 只保留 user/assistant/status，result 被整条过滤。旧实现只用 isTurnFinished
   * 判「已收尾」，在网页端恒为 false，等于没加这道判据 —— 这正是问题反复出现的原因。
   * 改用 isTurnSettled：有 result 就用 result，否则看「最终正文已抽出且没有未完成工具」。
   *
   * 只看「最后一条 user / assistant-turn」：尾部可能挂着 system 消息，它们既不属于
   * 对话也不算收尾；而刚发出新消息时最后一条是 user，必须判定为「在跑」。
   */
  const lastTurnFinished = React.useMemo(() => {
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index]
      if (!group || group.type === 'system') continue
      return group.type === 'assistant-turn' ? isTurnSettled(group, timelines[index]) : false
    }
    return false
  }, [groups, timelines])
  const sessionActive = running && !lastTurnFinished
  /** 内核决定用哪套推理档位；缺省按 claude 处理（历史会话与旧服务端都是这个默认） */
  const agentRuntime = meta?.agentRuntime ?? 'claude'
  /** 当前内核可切的模型（过滤规则与服务端 update_session_model 同一份） */
  const models = React.useMemo(
    () => normalizeChannelModels(channels, agentRuntime),
    [channels, agentRuntime],
  )
  const strength = React.useMemo(
    () => resolveStrengthState({
      levels: reasoningLevels,
      level: meta?.openAIThinkingLevel,
      effort: meta?.agentEffort,
    }),
    [reasoningLevels, meta?.openAIThinkingLevel, meta?.agentEffort],
  )
  /** 明确停用的预设不进菜单；当前预设优先按带作用域的 reference 匹配 */
  const availablePresets = React.useMemo(() => selectablePresets(presets), [presets])
  const currentPreset = React.useMemo(
    () => resolveCurrentPreset(availablePresets, meta?.presetId, meta?.presetReference),
    [availablePresets, meta?.presetId, meta?.presetReference],
  )
  // 会话绑定的预设被停用/删除时，桌面上会亮角标提醒先选一个；网页端在 chip 上提示
  const presetRequired = presetsLoaded && availablePresets.length > 0 && !currentPreset
  /**
   * 每轮的「模型 / 时间 / 来源 / token」。
   *
   * 一起算进同一个 memo：它们都只依赖分组（模型名再多一个 models 依赖），
   * 拆成几个 memo 只会让每帧多跑几遍 map。时钟字符串在这里定稿
   * （`Date.now()` 只在重算时取一次），避免每条消息各算各的。
   */
  const turnMetas = React.useMemo(() => groups.map((group) => {
    const usage = sumTurnUsage(group)
    const source = resolveTurnSource(group)
    return {
      at: resolveTurnTime(group),
      model: modelLabelFor(resolveTurnModel(group), models),
      clock: formatClock(resolveTurnTime(group)),
      sourceLabel: source ? SOURCE_LABELS[source] : '',
      usageText: usage ? describeUsage(usage) : '',
      usageDetail: usage ? describeUsageDetail(usage) : '',
    }
  }), [groups, models])
  const hasPending = permissions.length + askUsers.length + exitPlans.length > 0
  /** 提议不阻塞运行，所以只影响「是否渲染卡片区」，不锁输入框。 */
  const hasCards = hasPending || goalProposals.length > 0
  const permissionMode = meta?.permissionMode ?? 'bypassPermissions'
  const currentMode = PERMISSION_MODES.find((entry) => entry.mode === permissionMode) ?? PERMISSION_MODES[1]!
  /** 图表挂在工具调用行上，靠 toolCallId 关联（消息体里没有图表数据）。 */
  const vizByTool = React.useMemo(() => {
    const map = new Map<string, VisualizationItem>()
    for (const item of visualizations) map.set(item.toolCallId, item)
    return map
  }, [visualizations])
  /**
   * 没有任何已加载回合引用到的图表。分页只取尾部，较早回合的工具行可能不在窗口里；
   * 这时若直接丢弃，图表会凭空消失 —— 所以保留，但必须按时间插回它该在的位置。
   *
   * 旧实现统一追加到消息流末尾：一张很早的图会出现在所有对话之后，
   * 看起来像「图表自己跑到了最下面」。
   */
  const orphanVisualizations = React.useMemo(() => {
    const matched = new Set<string>()
    for (const timeline of timelines) {
      for (const item of timeline.items) {
        if (item.kind === 'tool') matched.add(item.tool.id)
      }
    }
    return visualizations.filter((item) => !matched.has(item.toolCallId))
  }, [timelines, visualizations])
  /** 插入位置 → 该位置要显示的孤儿图表；键为 turns.length 表示确实属于最新之后 */
  const vizSlots = React.useMemo(
    () => placeOrphanVisualizations(
      orphanVisualizations,
      turns.map((turn) => turnMetas[turn.index]?.at),
    ),
    [orphanVisualizations, turns, turnMetas],
  )

  // 标签页名字就是会话名：同时开多个会话页时，光看标签就能认出哪个是哪个。
  // 首屏标题已由服务端按会话名注入，所以会话信息没到之前什么都不做 —— 否则会先冲回兜底文案。
  React.useEffect(() => {
    if (!meta) return
    applyPageTitle(meta.title)
  }, [meta])

  // 菜单开着时能用 Esc 关掉，否则手机返回键/键盘都会觉得被卡住
  React.useEffect(() => {
    if (!modeMenuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModeMenuOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [modeMenuOpen])

  // 让 reload 读到「当前持有条数」，同时避免把它塞进回调依赖 —— 否则每条消息都会重建连接 effect。
  React.useEffect(() => { heldRef.current = messages.length }, [messages])
  React.useEffect(() => { attachmentsRef.current = attachments }, [attachments])

  /** 前置拼接后按距底距离还原滚动位置，否则视口会跳掉一大截。 */
  React.useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    if (anchor === null) return
    prependAnchorRef.current = null
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight - anchor
  }, [messages])

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
  }, [groups, hasPending, sessionActive, scrollToLatest])

  /** 输入框自增长；先归 auto 再取 scrollHeight，否则删字后高度不会回缩。 */
  React.useEffect(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`
  }, [input])

  const reload = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      // 只取尾部：多留 TAIL_HEADROOM 条余量，跑完一轮新消息落进来时窗口不会立刻往前滑动。
      const page = decodeMessagePage(
        await client.getSdkMessages(sessionId, { targetMessages: tailPageSize(heldRef.current) }),
      )
      setMessages(page.messages)
      setPageStart(page.startIndex)
      setHasOlder(page.hasMore)
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
      setGoalProposals(next.goalProposals)
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

  /** 归档 Goal（清除/完成的历史）。只在状态条展开时才有内容，但清除后必须刷新，否则列表是旧的。 */
  const loadGoalHistory = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      const result = await client.getGoalHistory(sessionId) as { goals?: unknown } | null
      setGoalHistory(normalizeGoalHistory(result?.goals))
    } catch {
      // 历史读不到不影响当前 Goal 的展示
    }
  }, [sessionId])

  /**
   * 会话内可视化记录：图表数据不在消息流里（WS 投影把 tool_use 入参压成 `{ file_path }`），
   * 只能按会话整体列出，再靠 `toolCallId` 挂回对应回合的工具调用行。
   */
  const loadVisualizations = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      const result = await client.listVisualizations(sessionId) as { records?: unknown } | null
      setVisualizations(normalizeVisualizations(result?.records))
    } catch {
      // 旧服务端不认这条命令时也走这里：图表缺失不该拦住消息阅读
    }
  }, [sessionId])

  /** 向上续页：只取更早的一页并前置拼接，不重拉尾部。 */  const loadOlder = React.useCallback(async (): Promise<void> => {
    const client = clientRef.current
    if (!client || loadingOlder || !hasOlder || pageStart <= 0) return
    const node = scrollRef.current
    // 记「距底部距离」而不是 scrollTop：插入内容后容器高度变了，scrollTop 会漂。
    prependAnchorRef.current = node ? node.scrollHeight - node.scrollTop : null
    setLoadingOlder(true)
    try {
      const page = decodeMessagePage(
        await client.getSdkMessages(sessionId, { before: pageStart, targetMessages: OLDER_PAGE }),
      )
      if (page.messages.length === 0) {
        // 服务端说到头了：收起入口，别让用户对着一个点了没反应的按钮
        setHasOlder(false)
        prependAnchorRef.current = null
        return
      }
      setMessages((previous) => mergePrepend(page.messages, previous))
      setPageStart(page.startIndex)
      setHasOlder(page.hasMore)
      // 正在翻历史，不该被新内容拽回底部
      atBottomRef.current = false
      setJumpVisible(true)
    } catch (error) {
      prependAnchorRef.current = null
      setNotice(`加载更早消息失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoadingOlder(false)
    }
  }, [sessionId, loadingOlder, hasOlder, pageStart])

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

  /**
   * 会话信息（标题 / 模型 / 工作区 / 权限模式）。
   *
   * 标题不是一次性的：新会话的标题由模型在首轮之后自动生成，页面在这一轮之前打开时
   * 拿到的是空标题，所以轮次结束后要重新取一次。
   */
  const loadSessionMeta = React.useCallback(async (client: WsClient): Promise<Record<string, unknown> | null> => {
    try {
      const detail = await client.sessionDetail(sessionId) as { meta?: Record<string, unknown>; data?: { meta?: Record<string, unknown> } } | null
      const raw = detail?.meta ?? detail?.data?.meta ?? null
      if (!raw) return null
      setMeta({
        // 空标题保持空串，由标题栏与标签页各自决定兜底文案（不要拿 sessionId 当名字）
        title: typeof raw.title === 'string' ? raw.title.trim() : '',
        channelId: typeof raw.channelId === 'string' ? raw.channelId : '',
        modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
        workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : undefined,
        permissionMode: normalizePermissionMode(raw.permissionMode),
        agentRuntime: typeof raw.agentRuntime === 'string' ? raw.agentRuntime : undefined,
        agentEffort: typeof raw.agentEffort === 'string' ? raw.agentEffort : null,
        openAIThinkingLevel: typeof raw.openAIThinkingLevel === 'string' ? raw.openAIThinkingLevel : null,
        presetId: typeof raw.presetId === 'string' ? raw.presetId : undefined,
        presetReference: isPresetReference(raw.presetReference) ? raw.presetReference : null,
        workspaceSlug: typeof raw.workspaceSlug === 'string' ? raw.workspaceSlug : undefined,
        revision: typeof raw.revision === 'number' ? raw.revision : undefined,
      })
      // 返回原始 meta：连接建立这一轮里 state 还没刷新，预设加载要直接用这份 workspaceSlug
      return raw
    } catch (error) {
      setNotice(`读取会话信息失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }, [sessionId])

  /**
   * 模型表：会话内可切换的模型集合，连接建立时取一次。
   *
   * 失败只降级、不打断：旧服务端没有这条命令时，菜单退化成「只有强度」，
   * 聊天本身不受影响 —— 模型标签则回退成「美化后的 id」。
   */
  const loadChannels = React.useCallback(async (client: WsClient): Promise<void> => {
    try {
      const data = await client.listChannels()
      setChannels(Array.isArray(data) ? data as RemoteChannel[] : null)
    } catch {
      setChannels(null)
    }
  }, [])

  /**
   * 预设列表 + 工作区默认预设。
   *
   * 作用域必须是会话所属工作区的 slug：不传 slug 时服务端只会返回内置默认配置，
   * 用户自己建的岗位会凭空消失。连接建立这一轮 state 还没刷新，所以允许显式传 slug。
   */
  const loadPresets = React.useCallback(async (client: WsClient, explicitSlug?: string): Promise<void> => {
    const slug = explicitSlug ?? meta?.workspaceSlug
    try {
      const [raw, fallback] = await Promise.all([
        client.listPresets(slug),
        client.getDefaultPreset(slug),
      ])
      setPresets(normalizePresets(raw))
      setDefaultPresetId(typeof fallback === 'string' ? fallback : '')
      setPresetsLoaded(true)
    } catch {
      // 旧服务端或权限不足：只影响预设菜单，聊天照常
      setPresetsLoaded(true)
    }
  }, [meta?.workspaceSlug])

  /**
   * Pi 内核的模型自带推理档位（off/minimal/low/…/max），Claude 内核只有 effort 四档。
   * 档位由服务端解析（renderer 没有 pi-ai 目录，本地推不出来），所以这里问一次并缓存。
   */
  React.useEffect(() => {
    const client = clientRef.current
    setReasoningLevels(null)
    if (!client || agentRuntime !== 'pi' || !meta?.modelId) return
    const channel = channels?.find((item) => item.id === meta.channelId)
    if (!channel?.provider) return
    let cancelled = false
    void client.getPiReasoningCapability(channel.provider, meta.modelId, channel.baseUrl)
      .then((capability) => {
        if (cancelled) return
        const levels = (capability as { levels?: unknown } | null)?.levels
        setReasoningLevels(Array.isArray(levels)
          ? levels.filter((level): level is string => typeof level === 'string' && level.length > 0)
          : null)
      })
      .catch(() => {
        // 拿不到能力表就按 Claude 的 effort 档兜底，不给用户一排选不中的选项
        if (!cancelled) setReasoningLevels(null)
      })
    return () => { cancelled = true }
  }, [agentRuntime, meta?.modelId, meta?.channelId, channels])

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
          event?: {
            type?: string
            request?: Record<string, unknown>
            requestId?: string
            goal?: unknown
            proposal?: unknown
            proposalId?: string
            mode?: unknown
            record?: unknown
          }
        } | null
        if (payload?.kind === 'sdk_message' && payload.message) {
          setMessages((previous) => upsertMessage(previous, payload.message as SDKMessage))
          // 只有真正的内容消息才算「又在跑了」。result / system / prompt_suggestion 这类
          // 收尾消息会在 run_completed 之后陆续到达（prompt_suggestion 甚至是跑完才生成），
          // 无条件 setRunning(true) 会把状态永久顶回运行中 —— 表现就是执行过程组再也不收起，
          // 正文被压在展开的过程组下面，看起来像「没有正式回复」。
          const messageType = (payload.message as { type?: string }).type
          if (messageType === 'assistant' || messageType === 'user') setRunning(true)
          return
        }
        if (payload?.kind !== 'profer_event') return
        const proferEvent = payload.event
        const type = proferEvent?.type
        const request = proferEvent?.request
        // Goal 每次状态变化主进程都会推一条完整状态，这里整体替换 ——
        // 状态机在电脑端，网页不做任何本地推断（重启/重连后也不会漂移）。
        if (type === 'goal_state') {
          const next = normalizeGoal(proferEvent?.goal)
          setGoal(next)
          // 清除/完成会把当前 Goal 归档：顺手刷一次历史，否则展开区里的归档列表还是旧的
          if (!next) void loadGoalHistory(client)
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
        } else if (type === 'goal_proposal' && proferEvent?.proposal) {
          // 提议不阻塞运行：模型提议后这一轮照常跑完，用户批准才由状态机接管后续轮次。
          const item = normalizeGoalProposals([proferEvent.proposal])[0]
          if (item) {
            setGoalProposals((previous) => previous.some((entry) => entry.id === item.id)
              ? previous.map((entry) => (entry.id === item.id ? item : entry))
              : [...previous, item])
          }
        } else if (type === 'goal_proposal_resolved') {
          setGoalProposals((previous) => previous.filter((item) => item.id !== proferEvent?.proposalId))
        } else if (type === 'permission_mode_changed') {
          // 批准计划时主进程会把会话切出 plan 模式。不同步 meta 的话，
          // 下一次发送仍带着 permissionMode:'plan' 这个 override，会立刻又进回计划模式。
          const mode = normalizePermissionMode(proferEvent?.mode)
          setMeta((previous) => (previous ? { ...previous, permissionMode: mode } : previous))
        } else if (type === 'visualization_updated' && proferEvent?.record) {
          // 主进程每次写入记录都会推一条完整 record：按 toolCallId 覆盖，不重新拉列表。
          const item = normalizeVisualizations([proferEvent.record])[0]
          if (item) {
            setVisualizations((previous) => previous.some((entry) => entry.id === item.id)
              ? previous.map((entry) => (entry.id === item.id ? item : entry))
              : [...previous, item])
          }
        }
        // run_completed 与 run_idle 会在同一轮先后到达，3 秒内只收敛一次「重拉」副作用。
        // 但 setRunning(false) 必须每次都执行：以前它也被节流吞掉，连着两轮时
        // 第二轮的 completion 不生效，过程组就一直保持展开。
        if (type === 'run_completed' || type === 'run_idle') {
          setRunning(false)
          const now = Date.now()
          if (now - lastCompletedRef.current > 3000) {
            lastCompletedRef.current = now
            void reload(client)
            void loadGoal(client)
            void loadVisualizations(client)
            // 首轮之后标题才会被自动生成，结束后重新取一次，标签页才不会一直停在兜底文案
            void loadSessionMeta(client)
          }
        }
      },
    })
    clientRef.current = client
    client.connect()
    /**
     * 手机上切到后台/锁屏后，系统会掐掉 WS，而重连定时器在后台被冻结 ——
     * 回到页面时可能一直停在「连接断开」。恢复前台或网络恢复时立刻补一次重连
     * （reconnectNow 对已连上的连接是 no-op，不会打断会话）。
     */
    const wake = (): void => {
      if (document.visibilityState === 'visible') client.reconnectNow()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
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
      // 会话信息失败不该拦住消息读取：loadSessionMeta 自己吞掉异常，只留一条 notice
      const rawMeta = await loadSessionMeta(client)
      await loadChannels(client)
      await loadPresets(client, typeof rawMeta?.workspaceSlug === 'string' ? rawMeta.workspaceSlug : undefined)
      await reload(client)
      await loadInteractions(client)
      await loadGoal(client)
      await loadGoalHistory(client)
      await loadVisualizations(client)
    })()
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.clearInterval(poll)
      client.disconnect()
      clientRef.current = null
    }
  }, [sessionId, token, reload, loadInteractions, loadGoal, loadGoalHistory, loadVisualizations, loadSessionMeta, loadPresets])

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
        // 清除 = 归档，立刻刷历史，展开区不用等下一次事件
        await loadGoalHistory(client)
        return
      }
      await loadGoal(client)
    } catch (error) {
      setNotice(`Goal 操作失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadGoal, loadGoalHistory, sessionId])

  /** 启动 Goal；契约是可选项，只有填了的字段才会带上。 */
  const startGoal = React.useCallback(async (text: string, contract?: GoalContract): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.startGoal({ sessionId, goal: text, ...(contract ? { contract } : {}) })
      await loadGoal(client)
    } catch (error) {
      setNotice(`设定目标失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadGoal, sessionId])

  /**
   * 保存目标/契约/预算；`resume` 为真时接着恢复。
   *
   * 顺序必须是「先保存再恢复」：预算耗尽的 Goal 不先扩容就恢复会被主进程拒绝，
   * 用户会以为改了没用。失败时保留编辑器，让用户能改完重试。
   */
  const saveGoal = React.useCallback(async (
    patch: { goal: string; contract: GoalContract; limits: GoalLimits },
    resume: boolean,
  ): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.updateGoal({
        sessionId,
        goal: patch.goal,
        contract: patch.contract,
        limits: {
          maxIterations: patch.limits.maxIterations ?? null,
          maxDurationMs: patch.limits.maxDurationMs ?? null,
          maxTokens: patch.limits.maxTokens ?? null,
          ...(patch.limits.maxConsecutiveFailures ? { maxConsecutiveFailures: patch.limits.maxConsecutiveFailures } : {}),
        },
      })
      if (resume) await client.resumeGoal(sessionId)
      await loadGoal(client)
      setGoalEditorOpen(false)
      setNotice(resume ? 'Goal 已更新并恢复' : 'Goal 已更新')
    } catch (error) {
      setNotice(`保存 Goal 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }, [acting, loadGoal, sessionId])

  /** 切换预设（岗位）。服务端按会话所属工作区解析作用域，下一轮生效。 */
  const applyPreset = async (presetId: string): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    if (presetId === currentPreset?.id) {
      setSettingsMenuOpen(false)
      setPresetPanelOpen(false)
      return
    }
    setActing(true)
    try {
      await client.updateSessionPreset(sessionId, presetId)
      await loadSessionMeta(client)
      setSettingsMenuOpen(false)
      setPresetPanelOpen(false)
      const name = presets.find((item) => item.id === presetId)?.name ?? presetId
      setNotice(`已切换到「${name}」 · 下一轮消息生效`)
    } catch (error) {
      setNotice(`切换预设失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }

  /** 新建 / 编辑预设。失败返回 false，编辑器保留表单让人改完重试。 */
  const savePreset = async (id: string | null, payload: PresetPatch | Record<string, unknown>): Promise<boolean> => {
    const client = clientRef.current
    if (!client || acting) return false
    setActing(true)
    try {
      const updates = payload as unknown as Record<string, unknown>
      if (id) await client.updatePreset(meta?.workspaceSlug, id, updates)
      else await client.createPreset(meta?.workspaceSlug, updates)
      await loadPresets(client)
      setNotice(id ? '预设已更新' : '预设已创建')
      return true
    } catch (error) {
      setNotice(`保存预设失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setActing(false)
    }
  }

  /** 内置预设不可编辑：复制是唯一能改它的方式，复制完直接打开编辑器。 */
  const copyPreset = async (fromId: string): Promise<WebPreset | null> => {
    const client = clientRef.current
    if (!client || acting) return null
    setActing(true)
    try {
      const created = normalizePresets([await client.copyPreset(meta?.workspaceSlug, fromId)])[0] ?? null
      await loadPresets(client)
      return created
    } catch (error) {
      setNotice(`复制预设失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      setActing(false)
    }
  }

  const deletePreset = async (presetId: string): Promise<boolean> => {
    const client = clientRef.current
    if (!client || acting) return false
    setActing(true)
    try {
      await client.deletePreset(meta?.workspaceSlug, presetId)
      await loadPresets(client)
      if (currentPreset?.id === presetId) await loadSessionMeta(client)
      setNotice('预设已删除')
      return true
    } catch (error) {
      setNotice(`删除预设失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setActing(false)
    }
  }

  const setPresetDefault = async (presetId: string): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.setDefaultPreset(meta?.workspaceSlug, presetId)
      setDefaultPresetId(presetId)
      setNotice('已设为工作区默认预设')
    } catch (error) {
      setNotice(`设置默认预设失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActing(false)
    }
  }

  /**
   * Goal 提议确认。
   *
   * 批准失败时主进程**故意保留**提议（不出队），所以这里不能乐观删卡片：
   * 只提示失败原因并重拉一次快照，用户可以直接重试。
   */
  const respondGoalProposal = React.useCallback(async (proposalId: string, accepted: boolean): Promise<void> => {
    const client = clientRef.current
    if (!client || acting) return
    setActing(true)
    try {
      await client.respondGoalProposal(proposalId, accepted)
      setGoalProposals((previous) => previous.filter((item) => item.id !== proposalId))
      await loadInteractions(client)
      await loadGoal(client)
    } catch (error) {
      setNotice(`Goal 提议处理失败：${error instanceof Error ? error.message : String(error)}`)
      await loadInteractions(client)
    } finally {
      setActing(false)
    }
  }, [acting, loadInteractions, loadGoal])

  const interactionHandlers = React.useMemo<InteractionHandlers>(() => ({
    onPermission: (id, behavior, alwaysAllow) => { void respondPermission(id, behavior, alwaysAllow) },
    onAskUser: (id, answers) => { void respondAskUser(id, answers) },
    onExitPlan: (id, action, feedback) => { void respondExitPlan(id, action, feedback) },
    onGoalProposal: (id, accepted) => { void respondGoalProposal(id, accepted) },
  }), [respondPermission, respondAskUser, respondExitPlan, respondGoalProposal])

  /**
   * 切换会话的权限模式。
   *
   * 这里必须走服务端命令，而不是在页面里「代用户点允许」：
   * 后者只影响这个网页，电脑端仍按原模式弹卡，两边状态会越走越远。
   */
  const switchPermissionMode = React.useCallback(async (mode: SendPermissionMode): Promise<void> => {
    const client = clientRef.current
    if (!client || switchingMode) return
    setModeMenuOpen(false)
    if ((meta?.permissionMode ?? 'bypassPermissions') === mode) return
    setSwitchingMode(true)
    try {
      await client.updatePermissionMode(sessionId, mode)
      // 成功后以本地切换为准（服务端也会广播 permission_mode_changed，两条路殊途同归）
      setMeta((previous) => (previous ? { ...previous, permissionMode: mode } : previous))
    } catch (error) {
      setNotice(`切换权限模式失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSwitchingMode(false)
    }
  }, [sessionId, switchingMode, meta])

  /** 附件：ready 的才随消息发出，uploading 或 error 的都挡在发送之前。 */
  const readyAttachments = attachments.filter((item) => item.status === 'ready')
  const uploadingAttachments = attachments.some((item) => item.status === 'uploading')
  /** 有正文或已就绪附件就能发；上传中不许发（否则会发出一条缺文件的消息）。 */
  const canSend = Boolean(
    (input.trim() || readyAttachments.length > 0) && connected && !busy && !hasPending && !uploadingAttachments,
  )

  const pickFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return
    const client = clientRef.current
    if (!client || !connected) {
      setNotice('连接未就绪，暂时无法上传附件')
      return
    }
    for (const file of Array.from(files)) {
      const staged = attachmentsRef.current.filter((item) => item.status !== 'error').length
      const invalid = validateAttachmentFile(file, staged)
      const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      if (invalid) {
        // 放进列表而不是只弹一条 notice：用户要能看出是哪个文件被拒了
        setAttachments((previous) => [...previous, {
          key, filename: file.name || '未命名文件', size: file.size, status: 'error', error: invalid,
        }])
        continue
      }
      setAttachments((previous) => [...previous, {
        key, filename: file.name, size: file.size, status: 'uploading',
      }])
      const reader = new FileReader()
      reader.onerror = () => {
        setAttachments((previous) => previous.map((item) => (item.key === key
          ? { ...item, status: 'error', error: '读取文件失败' }
          : item)))
      }
      reader.onload = () => {
        const base64 = base64FromDataUrl(String(reader.result ?? ''))
        if (!base64) {
          setAttachments((previous) => previous.map((item) => (item.key === key
            ? { ...item, status: 'error', error: '文件内容为空' }
            : item)))
          return
        }
        void client.saveAgentAttachment(sessionId, file.name, base64)
          .then((result) => {
            const saved = result as { filename?: unknown } | null
            const filename = typeof saved?.filename === 'string' && saved.filename ? saved.filename : file.name
            setAttachments((previous) => previous.map((item) => (item.key === key
              // 服务端遇到同名会加序号，必须记返回值里的文件名，否则发消息时解析不到
              ? { ...item, status: 'ready', filename }
              : item)))
          })
          .catch((error: unknown) => {
            setAttachments((previous) => previous.map((item) => (item.key === key
              ? { ...item, status: 'error', error: error instanceof Error ? error.message : '上传失败' }
              : item)))
          })
      }
      reader.readAsDataURL(file)
    }
  }

  const send = async (): Promise<void> => {
    const client = clientRef.current
    if (busy || !client) return
    if (uploadingAttachments) {
      setNotice('附件还在上传，请稍候')
      return
    }
    const text = resolveSendText(input, readyAttachments.length)
    if (!text) return
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
        // 让主进程把这条消息标成「网页发的」，桌面端与手机上都能看出处
        clientKind: 'webui',
        ...(readyAttachments.length > 0
          ? { attachments: readyAttachments.map((item) => ({ filename: item.filename })) }
          : {}),
      })
      setInput('')
      setAttachments([])
      setRunning(true)
      setNotice('')
    } catch (error) {
      // 失败保留附件与文案：重试时不该让用户重新挑一遍文件
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

  /**
   * 切换模型。服务端会同时更新全局默认（下次新建会话继承），所以这里不用自己记。
   * 成功后重取会话详情：`modelId`、`channelId` 与能力档位都跟着变。
   */
  const pickModel = async (option: ModelOption): Promise<void> => {
    const client = clientRef.current
    if (!client || switchingModel) return
    if (option.modelId === meta?.modelId && option.channelId === meta?.channelId) {
      setSettingsMenuOpen(false)
      return
    }
    setSwitchingModel(true)
    try {
      await client.updateSessionModel(sessionId, option.channelId, option.modelId)
      await loadSessionMeta(client)
      setSettingsMenuOpen(false)
      setNotice(`已切换到 ${option.name}`)
    } catch (error) {
      setNotice(`切换模型失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSwitchingModel(false)
    }
  }

  /** 切换推理强度；`FOLLOW_DEFAULT` 翻译成 null = 清除会话覆盖。菜单不关，方便连着调。 */
  const pickStrength = async (value: string): Promise<void> => {
    const client = clientRef.current
    if (!client || switchingModel) return
    if (value === strength.value) return
    const level = value === FOLLOW_DEFAULT ? null : value
    setSwitchingModel(true)
    try {
      if (strength.kind === 'thinking') await client.updateSessionThinkingLevel(sessionId, level)
      else await client.updateSessionAgentEffort(sessionId, level)
      await loadSessionMeta(client)
    } catch (error) {
      setNotice(`切换强度失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSwitchingModel(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <button
          className={`icon-btn ${permissionMode === 'bypassPermissions' ? '' : 'on'}`}
          onClick={() => setModeMenuOpen((previous) => !previous)}
          aria-expanded={modeMenuOpen}
          aria-haspopup="menu"
          title={`权限模式：${currentMode.label} —— ${currentMode.hint}`}
        >
          {currentMode.short}
        </button>
        <div className="title-pill" title={meta?.title || sessionId}>
          <span className="title-text">{meta?.title || 'Profer 会话'}</span>
          {/* 模型与强度聚在标题下：会话的「它是什么」比标题本身还常被查 */}
          <button
            className="model-chip"
            onClick={() => setSettingsMenuOpen((previous) => !previous)}
            aria-expanded={settingsMenuOpen}
            aria-haspopup="menu"
            disabled={!meta}
            title="切换模型与推理强度"
          >
            {describeSessionModel(meta?.modelId, models, strength, currentPreset, presetRequired)}
          </button>
        </div>
        <div className="conn" title={connection}>
          <span className={`conn-dot ${connected ? 'ok' : notice ? 'bad' : 'wait'}`} />
          <span className="label">{connected ? '在线' : connection}</span>
        </div>
      </header>
      {modeMenuOpen && (
        <>
          <div className="menu-scrim" onClick={() => setModeMenuOpen(false)} />
          <div className="menu" role="menu" aria-label="权限模式">
            {PERMISSION_MODES.map((entry) => (
              <button
                key={entry.mode}
                className={`menu-item ${entry.mode === permissionMode ? 'active' : ''}`}
                role="menuitemradio"
                aria-checked={entry.mode === permissionMode}
                disabled={switchingMode}
                onClick={() => void switchPermissionMode(entry.mode)}
              >
                <span className="menu-item-text">
                  <span className="menu-item-label">{entry.label}</span>
                  <span className="menu-item-hint">{entry.hint}</span>
                </span>
                {entry.mode === permissionMode && <span className="menu-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {settingsMenuOpen && (
        <SessionSettingsMenu
          models={models}
          currentModelId={meta?.modelId}
          strength={strength}
          presets={availablePresets}
          currentPresetId={currentPreset?.id}
          running={sessionActive}
          busy={switchingModel}
          onPickModel={(option) => void pickModel(option)}
          onPickStrength={(value) => void pickStrength(value)}
          onPickPreset={(id) => void applyPreset(id)}
          onManagePresets={() => { setSettingsMenuOpen(false); setPresetPanelOpen(true) }}
          onClose={() => setSettingsMenuOpen(false)}
        />
      )}
      {goal
        ? (
          <GoalBar
            goal={goal}
            archives={goalHistory.filter((item) => item.id !== goal.id)}
            busy={acting}
            waits={{ askUser: askUsers.length, permission: permissions.length }}
            onAction={(action) => void runGoalAction(action)}
            onEdit={() => setGoalEditorOpen(true)}
          />
        )
        : connected
          ? <GoalLauncher busy={acting} onStart={(text, contract) => void startGoal(text, contract)} />
          : null}
      {presetPanelOpen && (
        <PresetPanel
          presets={availablePresets}
          currentId={currentPreset?.id}
          defaultPresetId={defaultPresetId}
          models={models}
          busy={acting}
          onClose={() => setPresetPanelOpen(false)}
          onApply={(id) => void applyPreset(id)}
          onSave={(id, payload) => savePreset(id, payload)}
          onCopy={(id) => copyPreset(id)}
          onDelete={(id) => deletePreset(id)}
          onSetDefault={(id) => void setPresetDefault(id)}
        />
      )}
      {/* 编辑面板做成覆盖层：它比状态条高得多，塞进状态条会把消息区挤到没有 */}
      {goalEditorOpen && goal && (
        <GoalEditor
          goal={goal}
          busy={acting}
          onClose={() => setGoalEditorOpen(false)}
          onSave={(patch, resume) => void saveGoal(patch, resume)}
        />
      )}
      {notice && <div className="notice">{notice}</div>}
      <div className="stage">
        <div className="stream" ref={scrollRef} onScroll={handleStreamScroll}>
          {hasOlder && (
            <div className="load-older">
              <button className="load-older-btn" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? '加载中…' : '加载更早的消息'}
              </button>
            </div>
          )}
          {turns.length === 0 ? (
            <div className="empty">
              <div className="empty-title">{!token ? '需要访问凭据' : connected ? '开始对话' : '正在连接'}</div>
              <div className="empty-desc">
                {!token
                  // 走到这里说明 cookie、URL、localStorage 里都没有凭据了（例如清过站点数据）。
                  // 与其显示「正在连接」让人干等，不如直接说清楚下一步做什么。
                  ? '当前浏览器没有保存这个会话的凭据。请在电脑端 Profer 的「设置 → 远程连接 → Web 会话」里复制链接，重新打开一次。'
                  : connected
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
            const extra = extras[turn.index]
            const timeline = timelines[turn.index]
            const isAssistant = turn.role === 'assistant'
            // 过程条目挂在组里，正文只留「最终答复」——两段分开取，避免正文被折叠进执行过程
            const body = stripContextBlocks(isAssistant ? (timeline?.headline ?? '') : turn.text)
            // 图表按 toolCallId 挂回回合：tool_use 的 id 在 WS 投影里是保留的，这是唯一可靠的连接键。
            const turnViz = (timeline?.items ?? [])
              .flatMap((item) => (item.kind === 'tool' ? [vizByTool.get(item.tool.id)] : []))
              .filter((item): item is VisualizationItem => Boolean(item))
            // 过程组只在「这一轮还在跑」时自动展开：running 可能被迟到的收尾消息顶住，
            // 所以再叠一道数据判据，跑完的轮次一律收起，正文才能露出来。
            const live = sessionActive && turn.index === turns.length - 1
            const turnMeta = turnMetas[turn.index]
            const hasMeta = Boolean(turnMeta
              && (turnMeta.model || turnMeta.clock || turnMeta.sourceLabel || turnMeta.usageText))
            // 属于这一回合之前的孤儿图表（工具行还没加载进来），按时间就地补上，
            // 不集中丢到消息流末尾
            const leadingViz = vizSlots.get(turn.index) ?? []
            return (
              <React.Fragment key={turn.index}>
                {leadingViz.length > 0 && (
                  <div className="turn assistant viz-orphan">
                    <div className="viz-orphan-label">较早的图表</div>
                    <VisualizationList items={leadingViz} />
                  </div>
                )}
                <div className={`turn ${turn.role === 'user' ? 'user' : 'assistant'}`}>
                  {isAssistant && timeline && <TurnProcess timeline={timeline} live={live} />}
                  {(body || (turn.role === 'user' && (extra?.attachedFiles.length ?? 0) > 0)) && (
                    <div className="body">
                      {turn.role === 'user' && <TurnAttachments files={extra?.attachedFiles ?? []} />}
                      {body && <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>}
                    </div>
                  )}
                  <TurnImages imagePaths={extra?.imagePaths ?? []} loadImage={loadImage} />
                  <VisualizationList items={turnViz} />
                  {/* 来源与时间：只对「谁发的」有意义，助手回合省掉来源标签 */}
                  {hasMeta && turnMeta && (
                    <div className="turn-meta">
                      {turnMeta.model && <span className="tm-model">{turnMeta.model}</span>}
                      {turnMeta.sourceLabel && <span className="tm-src">{turnMeta.sourceLabel}</span>}
                      {turnMeta.clock && <span className="tm-clock">{turnMeta.clock}</span>}
                      {turnMeta.usageText && (
                        <span className="tm-usage" title={turnMeta.usageDetail}>{turnMeta.usageText}</span>
                      )}
                    </div>
                  )}
                </div>
              </React.Fragment>
            )
          })}
          {/* 只有确实比所有回合都新的图表才放在末尾 */}
          {(vizSlots.get(turns.length) ?? []).length > 0 && (
            <div className="turn assistant viz-orphan">
              {/* 这类图表比所有已加载回合都新（本轮刚生成、工具行还没到），不标「较早」 */}
              <VisualizationList items={vizSlots.get(turns.length) ?? []} />
            </div>
          )}
          {sessionActive && (
            <div className="running-hint">Profer 正在处理</div>
          )}
        </div>
        {jumpVisible && (
          <button className="jump-latest" onClick={() => scrollToLatest(true)}>
            ↓ 回到最新
          </button>
        )}
      </div>
      {hasCards && (
        <div className="interactions">
          <InteractionCards
            permissions={permissions}
            askUsers={askUsers}
            exitPlans={exitPlans}
            goalProposals={goalProposals}
            busy={acting}
            {...interactionHandlers}
          />
        </div>
      )}
      <div className="composer">
        {/* 附件条在输入框之上：它是「这一条消息的组成」，不是输入框的一部分 */}
        {attachments.length > 0 && (
          <div className="attach-bar">
            {attachments.map((item) => (
              <div className={`attach-chip ${item.status}`} key={item.key} title={item.error ?? item.filename}>
                <span className="attach-name">{item.filename}</span>
                <span className="attach-size">
                  {item.status === 'uploading' ? '上传中…' : item.status === 'error' ? item.error : formatBytes(item.size)}
                </span>
                <button
                  className="attach-remove"
                  onClick={() => setAttachments((previous) => previous.filter((entry) => entry.key !== item.key))}
                  aria-label={`移除附件 ${item.filename}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          className="attach-input"
          type="file"
          multiple
          onChange={(event) => {
            pickFiles(event.target.files)
            // 清空 value：同一个文件连选两次也要能触发 change
            event.target.value = ''
          }}
        />
        <div className={`composer-pill ${hasPending ? 'blocked' : ''}`}>
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={hasPending || !connected}
            title="添加附件"
            aria-label="添加附件"
          >
            +
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={hasPending}
            placeholder={hasPending
              ? '先处理上方的确认卡片'
              : PREFER_SEND_BUTTON ? '发送消息…' : '发送消息…（Enter 发送，Shift+Enter 换行）'}
            enterKeyHint={PREFER_SEND_BUTTON ? 'enter' : 'send'}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              // 截图/文件直接粘贴：桌面端最顺手的上传方式，不接反而显得「网页版少一块」
              const files = event.clipboardData?.files
              if (!files || files.length === 0) return
              event.preventDefault()
              pickFiles(files)
            }}
            onKeyDown={(event) => {
              // 触屏上 Enter 留给换行，发送一律走右侧圆键（换行后再按 Enter 也不会误发）。
              if (PREFER_SEND_BUTTON) return
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              // 中文输入法用 Enter 上屏，此时不能当成发送；isComposing 就是这道闸。
              event.preventDefault()
              void send()
            }}
          />
          {/* 一个位置一个主动作：能发就是发送，运行中且没内容才是停止 */}
          {sessionActive && !input.trim() && readyAttachments.length === 0 ? (
            <button className="send-btn run" onClick={() => void stop()} title="停止本轮运行">■</button>
          ) : (
            <button
              className={`send-btn ${canSend ? 'ready' : ''}`}
              disabled={!canSend}
              onClick={() => void send()}
              title={uploadingAttachments ? '附件上传中' : '发送（Enter）'}
            >
              {busy ? '…' : '↑'}
            </button>
          )}
        </div>
        <div className="composer-meta">
          <span>{hasPending ? '待确认' : sessionActive ? '运行中' : connected ? '空闲' : connection}</span>
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
