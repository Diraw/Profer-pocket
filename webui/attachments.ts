/**
 * 附件的客户端判定（纯函数，便于测试）。
 *
 * 服务端 `save_agent_attachment` 有两道硬限制：单个 10 MB、文件名会被 basename 化。
 * 这里提前挡一遍只是为了让用户**立刻**看到原因，而不是等一轮 WS 往返后收到一句
 * 「附件不能超过 10 MB」却不知道是哪个文件。
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT = 10

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 校验一个待上传文件。返回 null 表示可以上传，否则返回给用户看的原因。
 *
 * @param staged 当前已就绪 + 上传中的数量，用于卡总数上限
 */
export function validateAttachmentFile(
  file: { name: string; size: number },
  staged: number,
): string | null {
  const name = file.name.trim()
  if (!name) return '文件名为空'
  if (file.size === 0) return '空文件'
  if (file.size > MAX_ATTACHMENT_BYTES) return `超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}（${formatBytes(file.size)}）`
  if (staged >= MAX_ATTACHMENT_COUNT) return `最多 ${MAX_ATTACHMENT_COUNT} 个附件`
  return null
}

/** FileReader 给的是 data URL，服务端要裸 base64。 */
export function base64FromDataUrl(dataUrl: string): string {
  const index = dataUrl.indexOf(',')
  if (index < 0) return ''
  const head = dataUrl.slice(0, index)
  if (!head.includes(';base64')) return ''
  return dataUrl.slice(index + 1)
}

/**
 * 附件-only 发送时的兜底文案。
 *
 * 不能把 `<attached_files>` 块当正文发出去：那块是给模型看的路径清单，
 * 用户气泡里出现一堆绝对路径既难看也没意义（`rawUserMessage` 会保留这段文案）。
 */
export function resolveSendText(text: string, attachmentCount: number): string {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  if (attachmentCount > 0) return '请查看我上传的附件。'
  return ''
}
