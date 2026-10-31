import { Session, SessionStore, makeSession } from "../agent/store"
import { NotifyEnvelope } from "./envelope"

/**
 * 「App + 发件人」锁定一个会话。
 *
 * 这套绑定关系是通知流的根：微信里张三和李四各有一段记忆，互不串味；
 * 也从这里派生出「同一个来源 → 同一个聊天标签页里的会话」这个规则 ——
 * `scripting://run/智能体?message=…` 进来时，App 会直接跳到这条会话。
 */

/** 记忆绑定键：同一个 App 的同一个人共用一段记忆。 */
export function memoryKeyOf(app: string, sender: string): string {
  const norm = (s: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  return `${norm(app)}:${norm(sender)}`
}

/** 会话标题：张三（微信）。 */
export function notifyTitle(app: string, sender: string): string {
  return `${sender}（${app}）`
}

/**
 * 通知在会话里长这样（就是那条用户消息的正文）。
 *
 * 抬头写成「【通知消息】」是为了让模型分得清：这是别人发来的一手消息，
 * 不是用户在 App 里跟它聊天。
 */
export function notifyUserText(n: NotifyEnvelope): string {
  return [
    "【通知消息】",
    `来源应用：${n.app}`,
    `发件人：${n.sender}`,
    `消息内容：${n.content}`,
    "",
    "请结合该发件人的历史记忆与可用知识库/工具进行回复；需要发送时调用对应发送工具。",
  ].join("\n")
}

/** 在已有会话里找这个 App+发件人的那条；找不到就造一条（还没落盘）。 */
export function senderSessionFor(store: SessionStore, app: string, sender: string): Session {
  const key = memoryKeyOf(app, sender)
  const found = store.sessions.find((s) => s.memoryKey === key)
  if (found) return found
  const s = makeSession("default")
  s.memoryKey = key
  s.title = notifyTitle(app, sender)
  s.updatedAt = Date.now()
  return s
}
