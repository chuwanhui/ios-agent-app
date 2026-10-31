import { Script } from "scripting"
import { loadStore, saveStore, upsertSession } from "./store"
import { NotificationEnvelope, parseNotificationEnvelope } from "../notify/envelope"
import { dropQueueItem, enqueueNotify, markNotificationSeen } from "../notify/queue"
import { notifyUserText, senderSessionFor } from "../notify/session"

/**
 * URL 入口：`scripting://run/智能体?message=<URL 编码后的文本>`。
 *
 * 为什么走这条路：快捷指令里用「运行脚本」调智能体时，进程在**后台**，而 iOS 不允许
 * 后台进程把别的 App（包括「快捷指令」）拉到前台 —— 于是 AI 想调用快捷指令工具必然失败。
 * 换成「打开 URL」，Scripting 被拉到前台跑脚本，AI 就能正常拉起快捷指令，用户也看得见。
 *
 * 参数名除了 `message`，也认 `msg` / `text` / `content`；值按「宽松解码」处理：
 * 系统一般已经解过码，重复解码会把 `%` 吃掉，所以只在「确实是合法编码」时才解第二次。
 */

/** 只解一次，解不动就原样返回（不会因为一个孤独的 % 把整条消息弄坏）。 */
function decodeLoose(raw: string): string {
  const v = raw ?? ""
  if (!v || v.indexOf("%") < 0) return v
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function pick(params: any): string {
  if (!params || typeof params !== "object") return ""
  for (const key of ["message", "msg", "text", "content"]) {
    const v = params[key]
    if (v == null) continue
    const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : ""
    if (s.trim()) return decodeLoose(s)
  }
  return ""
}

/** 从一份 queryParameters 里取入口消息（没有就返回空串）。 */
export function messageFrom(params: any): string {
  return pick(params)
}

/** 取本轮的入口消息（冷启动读 `Script.queryParameters`）。 */
export function messageParam(): string {
  return pick((Script as any)?.queryParameters)
}

/** 给快捷指令/文档用的入口链接。 */
export function messageRunURL(scriptName: string, message: string): string {
  const name = (scriptName ?? "").trim() || "智能体"
  if (!message) return `scripting://run/${encodeURIComponent(name)}`
  return `scripting://run/${encodeURIComponent(name)}?message=` + encodeURIComponent(message)
}

/**
 * 一条 URL 入口消息 → 聊天页要执行的动作。
 *
 * - 有 `sessionId`：跳到那条会话；「App + 发件人」锁定一个会话，张三和李四互不串味；
 * - `text` 为空：只跳过去看历史，不发（比如同一条通知被去重挡下了）；
 * - `notify`：这一轮来自通知，跑完要写进「记录」页并记下去重。
 */
export interface ChatSeed {
  /** 目标会话；不传就是当前会话。 */
  sessionId?: string
  /** 要发出去的话。 */
  text: string
  /** 这条来自通知时的元信息。 */
  notify?: { app: string; sender: string; content: string }
}

/**
 * 把一段入口消息变成聊天页的动作。
 *
 * 通知（JSON 信封）→ 找/建「App + 发件人」会话，压进队列（去重）再立刻从队列里摘掉 ——
 * 这一轮就在前台跑，别让后台消费者同时再跑一遍。重复的通知只跳过去看历史。
 */
export async function seedFromMessage(text: string): Promise<ChatSeed | null> {
  const entry = (text ?? "").trim()
  if (!entry) return null

  const envelope: NotificationEnvelope | null = parseNotificationEnvelope(entry)
  if (!envelope) return { text: entry }

  const store = loadStore()
  const target = senderSessionFor(store, envelope.app, envelope.sender)
  if (!store.sessions.some((x) => x.id === target.id)) {
    // 新会话要先落盘（等写完），聊天页才在磁盘上找得到它。
    await saveStore(upsertSession(store, target))
  }

  const queued = enqueueNotify(envelope)
  if (!queued.queued || !queued.item) {
    // 同一条已经处理过（去重）：只跳过去看历史，不重复回一遍。
    return { sessionId: target.id, text: "" }
  }
  // 先记「处理过了」再从队列摘掉：这一轮会不会跑成，都算已经见过。
  // 两个入口（冷启动 / 唤起）可能同时接到同一条，靠这条记录挡住重复回复。
  markNotificationSeen(envelope)
  dropQueueItem(queued.item.id)
  return {
    sessionId: target.id,
    text: notifyUserText(envelope),
    notify: { app: envelope.app, sender: envelope.sender, content: envelope.content },
  }
}
