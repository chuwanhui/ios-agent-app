import { Intent, Script } from "scripting"
import {
  deriveTitle, loadConfig, loadStore, saveStore, tryApplyConfigJson, upsertSession, withCurrentSession,
} from "./core/agent/store"
import { runAgent } from "./core/agent/core"
import { capMessagesForSend, withStampedMessages } from "./core/agent/memory"
import { drainNotifications } from "./core/notify/drain"
import { enqueueNotify, queueSize } from "./core/notify/queue"

type NotificationEnvelope = {
  app: string
  sender: string
  content: string
  messageId?: string
}

function parseNotificationEnvelope(text: string): NotificationEnvelope | null {
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

/**
 * 快捷指令入口：把传入的文本当一轮对话发给模型，结果作为快捷指令的返回值。
 * 输入为空就直接退出。
 */
function getInputText(): string {
  const sp = Intent.shortcutParameter
  if (sp != null) {
    if (sp.type === "text") {
      const t = sp.value.trim()
      if (t) return t
    }
    if (sp.type === "json") {
      try { return JSON.stringify(sp.value) } catch { return "" }
    }
    if (sp.type === "fileURL") {
      return sp.value
    }
  }
  const texts = Intent.textsParameter
  if (texts && texts.length > 0 && texts[0]) {
    return texts[0]
  }
  return ""
}

/** 通知入队后交给队列消费者；这一条处理完就把它的回复当返回值。 */
async function handleNotification(envelope: NotificationEnvelope): Promise<void> {
  const queued = enqueueNotify(envelope)
  if (!queued.queued && queued.reason === "duplicate") {
    Script.exit(Intent.text("已处理过同一条通知（去重）。"))
    return
  }

  const out = await drainNotifications({ preferredId: queued.item?.id })
  if (out.preferredReply) {
    Script.exit(Intent.text(out.preferredReply))
    return
  }
  Script.exit(Intent.text(`消息已入队（当前队列 ${queueSize()} 条），稍后自动处理。`))
}

async function run() {
  try {
    const inputText = getInputText()

    // 兼容路径：输入是一段含配置键的 JSON 时，当作「改配置」而不是聊天。
    if (inputText && tryApplyConfigJson(inputText)) {
      Script.exit(Intent.text("配置已更新"))
      return
    }

    const cfg = loadConfig()
    if (!cfg.apiKey) {
      Script.exit(Intent.text("请先在「智能体」里点右上角齿轮填写 API Key"))
      return
    }

    if (!inputText) {
      Script.exit(Intent.text("没有收到输入内容：给这个快捷指令传一段文本再试"))
      return
    }

    const envelope = parseNotificationEnvelope(inputText)
    if (envelope) {
      await handleNotification(envelope)
      return
    }

    const history = withCurrentSession(loadStore())
    const session = history.session
    const { reply, newHistory } = await runAgent(
      inputText,
      cfg,
      session.messages,
      undefined,
      { workspaceName: session.workspaceName },
    )

    const capped = withStampedMessages(capMessagesForSend(newHistory, cfg.maxHistory))
    saveStore(
      upsertSession(history.store, {
        ...session,
        messages: capped,
        updatedAt: Date.now(),
        title: session.messages.length === 0 ? deriveTitle(capped) : session.title,
      }),
    )

    Script.exit(Intent.text(reply))
  } catch (e: any) {
    Script.exit(Intent.text("出错：" + (e?.message ?? String(e))))
  }
}

run()
