import { Intent, Script } from "scripting"
import { ChatMessage, Session, capMessages, deriveTitle, loadConfig, loadStore, makeSession, saveStore, tryApplyConfigJson, upsertSession, withCurrentSession } from "./core/agent/store"
import { runAgent } from "./core/agent/core"
import { appendMessageRecord } from "./core/records/store"
import {
  NotifyEnvelope,
  acquireQueueLock,
  dueQueueItems,
  enqueueNotify,
  markQueueRetry,
  markQueueSuccess,
  queueSize,
  refreshQueueLock,
  releaseQueueLock,
} from "./core/notify/queue"

const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000
const COMPRESS_TRIGGER = 36
const COMPRESS_KEEP_TAIL = 14
const SUMMARY_MAX = 1600
const DRAIN_DEADLINE_MS = 80_000
const DRAIN_BATCH = 8
const LOCK_WAIT_MS = 20_000
const LOCK_SPIN_MS = 350

type NotificationEnvelope = {
  app: string
  sender: string
  content: string
  messageId?: string
}

function normalizeKeyPart(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function memoryKeyOf(app: string, sender: string): string {
  return `${normalizeKeyPart(app)}:${normalizeKeyPart(sender)}`
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `…（已截断，共 ${s.length} 字）`
}

function withStampedMessages(messages: ChatMessage[]): ChatMessage[] {
  const now = Date.now()
  return messages.map((m, i) => ({ ...m, at: m.at ?? now - (messages.length - i) * 1000 }))
}

function expireSessionIfNeeded(s: Session): Session {
  if (Date.now() - (s.updatedAt || 0) <= MEMORY_TTL_MS) return s
  return {
    ...s,
    messages: [],
    memorySummary: undefined,
    memorySummaryAt: undefined,
    updatedAt: Date.now(),
  }
}

function isSummaryMessage(m: ChatMessage): boolean {
  return m.role === "assistant" && (m.content ?? "").startsWith("【历史记忆摘要】")
}

async function compressSessionIfNeeded(cfg: ReturnType<typeof loadConfig>, s: Session): Promise<Session> {
  const msgs = withStampedMessages(s.messages ?? []).filter((m) => !m.contextExcluded)
  if (msgs.length < COMPRESS_TRIGGER) return { ...s, messages: msgs }
  const head = msgs.slice(0, Math.max(1, msgs.length - COMPRESS_KEEP_TAIL)).filter((m) => !isSummaryMessage(m))
  const tail = msgs.slice(-COMPRESS_KEEP_TAIL)
  if (head.length === 0) return { ...s, messages: msgs }
  const transcript = head
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n\n")
  if (!transcript.trim()) return { ...s, messages: msgs }

  const sumCfg = {
    ...cfg,
    systemPrompt: "你是对话记忆压缩器。把对话压缩成便于后续回答的长期记忆。只保留事实、偏好、约束、待办与未解决问题。输出中文要点。",
    persona: "",
    tools: [],
    mcpServers: [],
    kbEnabled: false,
    skillsEnabled: false,
    onlySkillIds: [],
    maxToolRounds: 1,
    thinkingEnabled: false,
    reasoningEffort: "",
  }
  const prompt =
    "请压缩下面这段历史对话为“后续可用的记忆摘要”。\n" +
    "要求：\n" +
    "1) 保留人设偏好、业务事实、约束规则、当前目标；\n" +
    "2) 删除寒暄和重复内容；\n" +
    "3) 用 8~15 条要点输出。\n\n" +
    "历史对话：\n" +
    transcript
  let summary = ""
  try {
    const out = await runAgent(prompt, sumCfg as any, [])
    summary = (out.reply ?? "").trim()
  } catch {
    summary = ""
  }
  if (!summary) return { ...s, messages: msgs }

  const merged = truncate([s.memorySummary ?? "", summary].filter(Boolean).join("\n\n"), SUMMARY_MAX)
  const summaryMsg: ChatMessage = {
    role: "assistant",
    content: "【历史记忆摘要】\n" + merged,
    at: Date.now(),
  }
  return {
    ...s,
    messages: [summaryMsg, ...tail],
    memorySummary: merged,
    memorySummaryAt: Date.now(),
  }
}

function titleForNotification(app: string, sender: string): string {
  return `${sender}（${app}）`
}

function userTextForNotification(n: NotificationEnvelope): string {
  return [
    "【通知消息】",
    `来源应用：${n.app}`,
    `发件人：${n.sender}`,
    `消息内容：${n.content}`,
    "",
    "请结合该发件人的历史记忆与可用知识库/工具进行回复；需要发送时调用对应发送工具。",
  ].join("\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

async function waitQueueLock(owner: string, timeoutMs = LOCK_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (acquireQueueLock(owner)) return true
    await sleep(LOCK_SPIN_MS)
  }
  return false
}

async function processOneNotification(cfg: ReturnType<typeof loadConfig>, envelope: NotifyEnvelope): Promise<string> {
  let store = loadStore()
  let session: Session
  const key = memoryKeyOf(envelope.app, envelope.sender)
  const found = store.sessions.find((s) => s.memoryKey === key)
  if (found) {
    session = expireSessionIfNeeded(found)
  } else {
    const s = makeSession("default")
    s.memoryKey = key
    s.title = titleForNotification(envelope.app, envelope.sender)
    s.updatedAt = Date.now()
    session = s
  }

  const compressed = await compressSessionIfNeeded(cfg, session)
  const runtimeCfg = compressed.memorySummary
    ? {
        ...cfg,
        systemPrompt:
          cfg.systemPrompt +
          "\n\n【该发件人的历史记忆摘要】\n" +
          compressed.memorySummary +
          "\n请将其作为背景，优先响应最后一条消息。",
      }
    : cfg

  const { reply, newHistory } = await runAgent(
    userTextForNotification(envelope),
    runtimeCfg as any,
    compressed.messages,
    undefined,
    { workspaceName: compressed.workspaceName },
  )

  const capped = withStampedMessages(capMessages(newHistory, cfg.maxHistory))
  saveStore(
    upsertSession({ ...store, currentId: compressed.id }, {
      ...compressed,
      title: titleForNotification(envelope.app, envelope.sender),
      messages: capped,
      updatedAt: Date.now(),
      memoryKey: key,
    }),
  )

  appendMessageRecord({
    app: envelope.app,
    sender: envelope.sender,
    content: envelope.content,
    reply,
  })
  return reply
}

async function drainNotificationQueue(
  cfg: ReturnType<typeof loadConfig>,
  owner: string,
  preferredId?: string,
): Promise<{ preferredReply?: string }> {
  const started = Date.now()
  let preferredReply = ""
  while (Date.now() - started < DRAIN_DEADLINE_MS) {
    const due = dueQueueItems(DRAIN_BATCH)
    if (due.length === 0) break
    for (const item of due) {
      refreshQueueLock(owner)
      try {
        const reply = await processOneNotification(cfg, item)
        markQueueSuccess(item)
        if (preferredId && item.id === preferredId) preferredReply = reply
      } catch (e: any) {
        markQueueRetry(item, e?.message ?? String(e))
      }
    }
  }
  return preferredReply ? { preferredReply } : {}
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
      const queued = enqueueNotify(envelope)
      if (!queued.queued && queued.reason === "duplicate") {
        Script.exit(Intent.text("已处理过同一条通知（去重）。"))
        return
      }

      const owner = "drainer_" + Math.random().toString(36).slice(2, 10)
      const locked = await waitQueueLock(owner)
      if (!locked) {
        Script.exit(Intent.text(`消息已入队（当前队列 ${queueSize()} 条），稍后自动处理。`))
        return
      }
      try {
        const out = await drainNotificationQueue(cfg, owner, queued.item?.id)
        if (out.preferredReply) {
          Script.exit(Intent.text(out.preferredReply))
          return
        }
        Script.exit(Intent.text(`消息已入队（当前队列 ${queueSize()} 条），稍后自动处理。`))
        return
      } finally {
        releaseQueueLock(owner)
      }
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

    const capped = withStampedMessages(capMessages(newHistory, cfg.maxHistory))
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
