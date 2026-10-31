/**
 * 通知信封的解析 —— 快捷指令交进来的那段 JSON。
 *
 * 两个入口都要用：`intent.tsx`（快捷指令直接调脚本）和 `index.tsx`
 * （`scripting://run/智能体?message=…` 把 App 拉到前台时）。所以单独放一份，
 * 免得两处的字段别名各认一半。
 */

export interface NotificationEnvelope {
  app: string
  sender: string
  content: string
  messageId?: string
}

/** 队列侧沿用的老名字（`NotifyEnvelope` 就是同一个东西）。 */
export type NotifyEnvelope = NotificationEnvelope

/**
 * 认 `app / sender / content` 三个必需字段（带几个常见别名），缺任何一个都返回 null ——
 * 那不是通知，而是普通聊天文本。
 */
export function parseNotificationEnvelope(text: string): NotificationEnvelope | null {
  if (!text || text[0] !== "{") return null
  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const app = String(obj.app ?? obj.sourceApp ?? obj.bundle ?? obj.package ?? obj["发件app"] ?? obj["来源应用"] ?? "").trim()
  const sender = String(obj.sender ?? obj.from ?? obj.user ?? obj.name ?? obj["发件人"] ?? obj["发送人"] ?? "").trim()
  const content = String(obj.content ?? obj.message ?? obj.text ?? obj.body ?? obj["发件内容"] ?? obj["内容"] ?? "").trim()
  const messageId = String(obj.messageId ?? obj.msgId ?? obj.notificationId ?? obj.id ?? obj["消息ID"] ?? "").trim() || undefined
  if (!app || !sender || !content) return null
  return { app, sender, content, messageId }
}
