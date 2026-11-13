/**
 * 消息分页纯函数层。
 *
 * 抽出来的理由：解析与合并是「错了就静默丢历史」的地方，必须有单测钉住；
 * 而 main.tsx 一 import 就会挂载 React 根节点，不适合放进测试进程。
 */
import type { SDKMessage } from '@profer/shared'

/** 首屏与续页的条数。首屏只取尾部：长会话整份拉回来会拖慢首屏，也让 DOM 无谓膨胀。 */
export const INITIAL_PAGE = 60
export const OLDER_PAGE = 40

/** reload 时额外多取的余量：跑完一轮新消息落进来时，尾部窗口不会立刻往前滑动。 */
export const TAIL_HEADROOM = 20

export interface MessagePage {
  messages: SDKMessage[]
  /** 本页首条在完整消息数组里的下标；续页用它当 before。 */
  startIndex: number
  hasMore: boolean
}

/**
 * 解析 get_sdk_messages 的返回。
 *
 * 三种形态都要认：分页结构（`{messages,total,startIndex,hasMore}`）、
 * 裸数组（旧服务端 / 未传分页参数时的全文），以及外层 `data` 包裹。
 * 任何形态解析失败都返回空页而不是抛错 —— 会话读不出来比页面白屏好排查。
 */
export function decodeMessagePage(raw: unknown): MessagePage {
  const value = raw as { messages?: unknown; startIndex?: unknown; hasMore?: unknown; data?: unknown } | null
  if (Array.isArray(raw)) return { messages: raw as SDKMessage[], startIndex: 0, hasMore: false }
  if (Array.isArray(value?.messages)) {
    return {
      messages: value.messages as SDKMessage[],
      startIndex: typeof value.startIndex === 'number' ? value.startIndex : 0,
      hasMore: value.hasMore === true,
    }
  }
  const data = value?.data as { messages?: unknown; startIndex?: unknown; hasMore?: unknown } | unknown[] | null
  if (Array.isArray(data)) return { messages: data as SDKMessage[], startIndex: 0, hasMore: false }
  if (Array.isArray(data?.messages)) {
    return {
      messages: data.messages as SDKMessage[],
      startIndex: typeof data.startIndex === 'number' ? data.startIndex : 0,
      hasMore: data.hasMore === true,
    }
  }
  return { messages: [], startIndex: 0, hasMore: false }
}

function messageUuid(message: SDKMessage): string {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : ''
}

/**
 * 前置拼接更早的一页。
 *
 * 服务端会把页起点向前扩展到 turn 的 user-input 边界（保证不切断一轮对话），
 * 相邻两页因此可能重叠；按 uuid 去重，避免同一轮被渲染两遍。
 */
export function mergePrepend(older: SDKMessage[], current: SDKMessage[]): SDKMessage[] {
  const seen = new Set(current.map(messageUuid).filter(Boolean))
  const fresh = older.filter((message) => {
    const uuid = messageUuid(message)
    return !uuid || !seen.has(uuid)
  })
  return [...fresh, ...current]
}

/** 尾部窗口按当前持有量决定，至少 INITIAL_PAGE。 */
export function tailPageSize(held: number): number {
  return Math.max(INITIAL_PAGE, held + TAIL_HEADROOM)
}

/**
 * 消息身份：优先 `_provenance`（runId+messageId），uuid 只作兜底。
 *
 * **不能用 uuid 当主键**：流式 partial 帧的 uuid 不可靠 —— coordinator 明言
 * 「部分帧可能没有 UUID，终稿才有」，且为同一条回复按 `message.id` 归一身份
 * （`pendingAssistantId` / `logicalMessageIds` 机制）。partial 与 final 稳定共享的
 * 只有 `_provenance.messageId`。只按 uuid 合并会把每条 partial 增量全部堆进列表
 * （残条）：text 残条之后挂着 tool_use 残条，`findHeadlineRange` 判「正文之后还有
 * 工具」直接收空 headline —— 表现就是「正文一输出完就消失，刷新后又出现」
 * （刷新拉的是按 messageId 合并后的干净 JSONL）。
 */
export function messageIdentity(message: SDKMessage): string | undefined {
  const record = message as { uuid?: unknown; _provenance?: { runId?: unknown; messageId?: unknown } }
  const provenance = record._provenance
  if (provenance && typeof provenance.runId === 'string' && typeof provenance.messageId === 'string') {
    return `p:${provenance.runId}:${provenance.messageId}`
  }
  if (typeof record.uuid === 'string' && record.uuid) return `u:${record.uuid}`
  return undefined
}

/** 流式期间同一回合会落多行快照；按身份覆盖而不是追加，避免重复气泡与残条。 */
export function upsertMessage(list: SDKMessage[], incoming: SDKMessage): SDKMessage[] {
  const identity = messageIdentity(incoming)
  if (identity) {
    const index = list.findIndex((item) => messageIdentity(item) === identity)
    if (index >= 0) {
      const next = list.slice()
      next[index] = incoming
      return next
    }
  }
  return [...list, incoming]
}
