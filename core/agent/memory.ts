import { AgentConfig, ChatMessage, Session } from "./store"
import { runAgent } from "./core"

/**
 * 会话记忆：给模型看的历史怎么截、太长了怎么压缩。
 *
 * 聊天页和通知链路共用这一套（以前只有通知链路有压缩，聊天页长对话会直接忘掉最早的内容）：
 *   - `capMessagesForSend`：条数 + 字符数双重上限，超了从最老的开始丢；
 *   - `compressHistory`：条数过阈值后，把前面那段压成一份「记忆摘要」放在最前面。
 */

/** 记忆保留期：超过这么久没动静的会话清空重来。 */
export const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 攒够这么多条就压缩一次。 */
const COMPRESS_TRIGGER = 36
/** 压缩后原样保留的最近条数。 */
const COMPRESS_KEEP_TAIL = 14
/** 摘要本身的长度上限（字符）。 */
const SUMMARY_MAX = 1600
/** 历史整体字符预算：图片按路径长度算，长文档 / 长工具结果也算在这里。 */
const STORE_CHAR_BUDGET = 60_000
/** 摘要消息的固定抬头，用来识别「这条是摘要，不是真回复」。 */
export const SUMMARY_PREFIX = "【历史记忆摘要】"

export function isSummaryMessage(m: ChatMessage): boolean {
  return m.role === "assistant" && (m.content ?? "").startsWith(SUMMARY_PREFIX)
}

/** 老消息没有时间戳：按原始顺序补一个，便于后续按时间管理。 */
export function withStampedMessages(messages: ChatMessage[]): ChatMessage[] {
  const now = Date.now()
  return messages.map((m, i) => ({ ...m, at: m.at ?? now - (messages.length - i) * 1000 }))
}

/** 太久没聊过的会话清空（记忆过期）。 */
export function expireSessionIfNeeded(s: Session): Session {
  if (Date.now() - (s.updatedAt || 0) <= MEMORY_TTL_MS) return s
  return {
    ...s,
    messages: [],
    memorySummary: undefined,
    memorySummaryAt: undefined,
    updatedAt: Date.now(),
  }
}

function clip(text: string, max: number): string {
  const s = text ?? ""
  if (s.length <= max) return s
  return s.slice(0, max) + `…（已截断，共 ${s.length} 字）`
}

/** 一条消息在预算里的「体积」：正文 + 工具结果 + 图片占位。 */
function messageWeight(m: ChatMessage): number {
  let n = (m.content ?? "").length
  n += (m.reasoning ?? "").length > 0 ? Math.min((m.reasoning ?? "").length, 200) : 0
  for (const s of m.steps ?? []) n += (s.result ?? "").length + (s.args ?? "").length
  n += (m.images ?? []).length * 2000
  return n
}

/**
 * 发消息前对历史做双重截断：先按条数，再按字符预算。
 * 只丢最老的，且至少保留最后两条（当前这轮的用户消息与上一条回复）。
 */
export function capMessagesForSend(messages: ChatMessage[], maxHistory: number): ChatMessage[] {
  const byCount = messages.slice(-Math.max(1, maxHistory))
  let total = 0
  for (const m of byCount) total += messageWeight(m)
  let start = 0
  while (total > STORE_CHAR_BUDGET && byCount.length - start > 2) {
    total -= messageWeight(byCount[start])
    start += 1
  }
  return start > 0 ? byCount.slice(start) : byCount
}

/** 压缩历史用的极简配置：只要模型能说话，别挂任何工具。 */
function summarizerConfig(cfg: AgentConfig): AgentConfig {
  return {
    ...cfg,
    systemPrompt:
      "你是对话记忆压缩器。把对话压缩成便于后续回答的长期记忆。只保留事实、偏好、约束、待办与未解决问题。输出中文要点。",
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
}

/**
 * 条数超过阈值时把前面那段压成摘要，留下最近的若干条原文。
 * 压缩失败（没网 / 模型报错）就原样返回，不阻塞这一轮。
 */
export async function compressHistory(
  cfg: AgentConfig,
  session: Session,
): Promise<Session> {
  const msgs = withStampedMessages(session.messages ?? []).filter((m) => !m.contextExcluded)
  if (msgs.length < COMPRESS_TRIGGER) return { ...session, messages: msgs }

  const head = msgs
    .slice(0, Math.max(1, msgs.length - COMPRESS_KEEP_TAIL))
    .filter((m) => !isSummaryMessage(m))
  const tail = msgs.slice(-COMPRESS_KEEP_TAIL)
  if (head.length === 0) return { ...session, messages: msgs }

  const transcript = head
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n\n")
  if (!transcript.trim()) return { ...session, messages: msgs }

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
    const out = await runAgent(prompt, summarizerConfig(cfg), [], undefined, { source: "compress" })
    summary = (out.reply ?? "").trim()
  } catch {
    summary = ""
  }
  if (!summary) return { ...session, messages: msgs }

  const merged = clip(
    [session.memorySummary ?? "", summary].filter(Boolean).join("\n\n"),
    SUMMARY_MAX,
  )
  const summaryMsg: ChatMessage = {
    role: "assistant",
    content: SUMMARY_PREFIX + "\n" + merged,
    at: Date.now(),
  }
  return {
    ...session,
    messages: [summaryMsg, ...tail],
    memorySummary: merged,
    memorySummaryAt: Date.now(),
  }
}
