import { AgentConfig, Session, loadConfig, loadStore, makeSession, saveStore, upsertSession } from "../agent/store"
import { runAgent } from "../agent/core"
import { appendMessageRecord } from "../records/store"
import {
  capMessagesForSend, compressHistory, expireSessionIfNeeded, withStampedMessages,
} from "../agent/memory"
import {
  LOCK_HEARTBEAT_MS, NotifyEnvelope, acquireQueueLock, dueQueueItems, markQueueRetry,
  markQueueSuccess, refreshQueueLock, releaseQueueLock,
} from "./queue"
import { memoryKeyOf, notifyTitle, notifyUserText, senderSessionFor } from "./session"

/**
 * 通知队列的消费者。
 *
 * 两条入口共用这一份逻辑：
 *   - 快捷指令 / Siri 触发（`intent.tsx`）：处理完把首选那条的回复当返回值；
 *   - App 打开时（`index.tsx`）：异步把积压清掉，不需要新通知来「顺带」触发。
 *
 * 处理一条期间会持续给锁续期（心跳），所以单条慢请求不会让锁过期、被另一个消费者
 * 抢进来重复回复同一条通知。
 */

/** 一次 drain 最长跑多久（iOS 后台时间有限，剩下的留给下次）。 */
const DRAIN_DEADLINE_MS = 80_000
/** 一轮取几条。 */
const DRAIN_BATCH = 8
/** 等别的消费者放手最多等多久。 */
const LOCK_WAIT_MS = 20_000
const LOCK_SPIN_MS = 350

/* App+发件人 → 会话的那套绑定关系搬去 ./session 了，两个入口共用一份。 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

async function waitQueueLock(owner: string, timeoutMs = LOCK_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await acquireQueueLock(owner)) return true
    await sleep(LOCK_SPIN_MS)
  }
  return false
}

/** 处理一条通知：找到（或新建）该发件人的会话 → 压缩记忆 → 跑一轮 → 落库 + 记记录。 */
export async function processNotification(cfg: AgentConfig, envelope: NotifyEnvelope): Promise<string> {
  const store = loadStore()
  const key = memoryKeyOf(envelope.app, envelope.sender)
  const session = expireSessionIfNeeded(senderSessionFor(store, envelope.app, envelope.sender))

  const compressed = await compressHistory(cfg, session)
  const runtimeCfg: AgentConfig = compressed.memorySummary
    ? {
        ...cfg,
        persona:
          (cfg.persona ?? "") +
          "\n\n【该发件人的历史记忆摘要】\n" +
          compressed.memorySummary +
          "\n请将其作为背景，优先响应最后一条消息。",
      }
    : cfg

  const { reply, newHistory } = await runAgent(
    notifyUserText(envelope),
    runtimeCfg,
    compressed.messages,
    undefined,
    { workspaceName: compressed.workspaceName, source: "notify" },
  )

  const capped = withStampedMessages(capMessagesForSend(newHistory, cfg.maxHistory))
  await saveStore(
    upsertSession({ ...store, currentId: compressed.id }, {
      ...compressed,
      title: notifyTitle(envelope.app, envelope.sender),
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

export interface DrainResult {
  /** 本次调用「送进来的那条」通知的回复（快捷指令要把它当返回值）。 */
  preferredReply?: string
  /** 这一轮成功处理了几条。 */
  processed: number
  /** 没跑起来的原因（没配 Key / 别人正在处理 / 队列本来就是空的）。 */
  skipped?: "no-api-key" | "locked" | "empty"
}

/**
 * 把到期的通知逐条处理完。默认由 App 打开时调用；快捷指令入口会额外传 preferredId。
 * 拿不到锁就直接返回，不阻塞调用方。
 */
export async function drainNotifications(opts?: {
  preferredId?: string
  /** 本次最长跑多久（默认 80 秒）。 */
  deadlineMs?: number
  /** 最多处理几条（不传就没有上限，跑到队列空或超时）。 */
  maxItems?: number
}): Promise<DrainResult> {
  const cfg = loadConfig()
  if (!cfg.apiKey) return { processed: 0, skipped: "no-api-key" }

  const owner = "drainer_" + Math.random().toString(36).slice(2, 10)
  if (!(await waitQueueLock(owner))) return { processed: 0, skipped: "locked" }

  // 处理一条可能跑一两分钟，靠心跳把锁续上，避免另一个消费者抢锁重复处理。
  // 运行时没有 setInterval，用自排队的 setTimeout 实现。
  let beating = true
  let heartbeat: any = null
  const beat = () => {
    if (!beating) return
    void refreshQueueLock(owner)
    heartbeat = setTimeout(beat, LOCK_HEARTBEAT_MS)
  }
  heartbeat = setTimeout(beat, LOCK_HEARTBEAT_MS)
  const deadline = Date.now() + Math.max(5_000, opts?.deadlineMs ?? DRAIN_DEADLINE_MS)
  const maxItems = opts?.maxItems != null ? Math.max(1, opts.maxItems) : Infinity
  let processed = 0
  let preferredReply = ""
  let sawAny = false

  try {
    while (Date.now() < deadline && processed < maxItems) {
      const due = dueQueueItems(DRAIN_BATCH)
      if (due.length === 0) break
      sawAny = true
      for (const item of due) {
        if (Date.now() >= deadline || processed >= maxItems) break
        try {
          const reply = await processNotification(cfg, item)
          markQueueSuccess(item)
          processed += 1
          if (opts?.preferredId && item.id === opts.preferredId) preferredReply = reply
        } catch (e: any) {
          markQueueRetry(item, e?.message ?? String(e))
        }
      }
    }
  } finally {
    beating = false
    if (heartbeat != null) clearTimeout(heartbeat)
    await releaseQueueLock(owner)
  }

  return {
    preferredReply: preferredReply || undefined,
    processed,
    skipped: !sawAny && processed === 0 ? "empty" : undefined,
  }
}
