import { acquireLock, kvJson, kvWriteJson, refreshLock, releaseLock } from "../store/store"

export interface NotifyEnvelope {
  app: string
  sender: string
  content: string
  messageId?: string
}

export interface NotifyQueueItem extends NotifyEnvelope {
  id: string
  attempts: number
  receivedAt: number
  nextAttemptAt: number
  lastError?: string
  /** 重试次数用尽：不再自动处理，等用户手动重试或删除。 */
  failed?: boolean
}

interface SeenItem {
  key: string
  at: number
}

interface QueueFile {
  items: NotifyQueueItem[]
  seen: SeenItem[]
}

/** 队列在 kv 里的键。锁是 `data/locks/` 下的目录（跨进程可见，所以不走内存）。 */
const QUEUE_KEY = "notify.queue"
const LOCK_NAME = "notify"
const MAX_ITEMS = 300
const MAX_SEEN = 1000
const SEEN_TTL = 7 * 24 * 60 * 60 * 1000
const RAW_DEDUPE_TTL = 2 * 60 * 1000
const LOCK_TTL = 60 * 1000
/** 处理中的心跳间隔：比锁 TTL 短得多，保证一条慢消息跑再久也不会让锁过期。 */
export const LOCK_HEARTBEAT_MS = LOCK_TTL / 4
/** 同一条通知最多自动重试几次；到上限就转成「失败」留在队列里等人工处理。 */
export const MAX_ATTEMPTS = 4
const RETRY_DELAYS = [15_000, 60_000, 180_000, 600_000]

function newId(): string {
  return "q" + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
}

function normalize(v: string): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

export function dedupeKeyOf(input: NotifyEnvelope): string {
  const mid = (input.messageId ?? "").trim()
  if (mid) return "id:" + mid
  return `raw:${normalize(input.app)}|${normalize(input.sender)}|${normalize(input.content)}`
}

/** 队列的内存副本（启动时由 hydrateQueue 填好）。 */
let queueCache: QueueFile | null = null

export async function hydrateQueue(): Promise<void> {
  const parsed = kvJson<Partial<QueueFile>>(QUEUE_KEY)
  queueCache = {
    items: Array.isArray(parsed?.items) ? (parsed!.items as NotifyQueueItem[]) : [],
    seen: Array.isArray(parsed?.seen) ? (parsed!.seen as SeenItem[]) : [],
  }
}

function readQueue(): QueueFile {
  return queueCache ?? { items: [], seen: [] }
}

function writeQueue(file: QueueFile): void {
  queueCache = file
  kvWriteJson(QUEUE_KEY, file)
}

function prune(file: QueueFile, now = Date.now()): QueueFile {
  const seen = (file.seen ?? []).filter((x) => !!x?.key && now - Number(x.at || 0) <= SEEN_TTL).slice(-MAX_SEEN)
  const items = (file.items ?? [])
    .filter((x) => !!x?.id && !!x?.app && !!x?.sender && !!x?.content)
    .slice(-MAX_ITEMS)
  return { items, seen }
}

function hasSeen(file: QueueFile, key: string): boolean {
  const now = Date.now()
  return (file.seen ?? []).some((x) => {
    if (x.key !== key) return false
    const age = now - Number(x.at || 0)
    if (key.indexOf("raw:") === 0) return age <= RAW_DEDUPE_TTL
    return age <= SEEN_TTL
  })
}

function hasQueued(file: QueueFile, key: string): boolean {
  return (file.items ?? []).some((x) => dedupeKeyOf(x) === key)
}

export function enqueueNotify(input: NotifyEnvelope): { queued: boolean; item?: NotifyQueueItem; reason?: string } {
  const app = String(input.app ?? "").trim()
  const sender = String(input.sender ?? "").trim()
  const content = String(input.content ?? "").trim()
  if (!app || !sender || !content) return { queued: false, reason: "invalid" }

  const file = prune(readQueue())
  const key = dedupeKeyOf({ app, sender, content, messageId: input.messageId })
  if (hasSeen(file, key) || hasQueued(file, key)) return { queued: false, reason: "duplicate" }

  const item: NotifyQueueItem = {
    id: newId(),
    app,
    sender,
    content,
    messageId: input.messageId,
    attempts: 0,
    receivedAt: Date.now(),
    nextAttemptAt: Date.now(),
  }
  file.items = [...file.items, item].slice(-MAX_ITEMS)
  writeQueue(file)
  return { queued: true, item }
}

export function dueQueueItems(limit = 10, now = Date.now()): NotifyQueueItem[] {
  const file = prune(readQueue(), now)
  const due = file.items
    .filter((x) => !x.failed && Number(x.nextAttemptAt || 0) <= now)
    .sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0))
    .slice(0, Math.max(1, limit))
  return due
}

export function markQueueSuccess(item: NotifyQueueItem): void {
  const file = prune(readQueue())
  file.items = file.items.filter((x) => x.id !== item.id)
  file.seen = [...file.seen, { key: dedupeKeyOf(item), at: Date.now() }].slice(-MAX_SEEN)
  writeQueue(file)
}

/**
 * 只写「已处理过」的去重记录，不碰队列。
 *
 * 给「前台直接跑掉」的那条收尾用：`scripting://run/智能体?message=…` 会把通知从队列里
 * 取出来、在聊天页里跑，收尾时只需要记住「这条处理过了」，免得下次又被当成新消息。
 */
export function markNotificationSeen(input: NotifyEnvelope): void {
  const file = prune(readQueue())
  file.seen = [...file.seen, { key: dedupeKeyOf(input), at: Date.now() }].slice(-MAX_SEEN)
  writeQueue(file)
}

export function markQueueRetry(item: NotifyQueueItem, err: string): void {
  const file = prune(readQueue())
  const idx = file.items.findIndex((x) => x.id === item.id)
  if (idx < 0) return
  const attempts = Math.max(0, Number(file.items[idx].attempts || 0)) + 1
  const exhausted = attempts >= MAX_ATTEMPTS
  const delay = exhausted
    ? 0
    : RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
  file.items[idx] = {
    ...file.items[idx],
    attempts,
    failed: exhausted || undefined,
    nextAttemptAt: exhausted ? 0 : Date.now() + delay,
    lastError: String(err || "unknown"),
  }
  writeQueue(file)
}

/** 待处理条数（不含已经失败的）。 */
export function queueSize(): number {
  return prune(readQueue()).items.filter((x) => !x.failed).length
}

/** 已经重试用尽、需要人工处理的通知。 */
export function failedQueueItems(): NotifyQueueItem[] {
  return prune(readQueue())
    .items.filter((x) => x.failed)
    .sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0))
}

/** 手动重试：次数清零、立刻到期。 */
export function retryQueueItem(id: string): void {
  const file = prune(readQueue())
  const idx = file.items.findIndex((x) => x.id === id)
  if (idx < 0) return
  file.items[idx] = { ...file.items[idx], failed: undefined, attempts: 0, nextAttemptAt: Date.now() }
  writeQueue(file)
}

/**
 * 清空队列：等待处理的、处理失败的，连同「已处理过」的去重记录一起清掉。
 *
 * 为什么要连去重记录一起清：界面上这个按钮叫「清空记录」，用户点完再跑一次同一条通知，
 * 期待的是「重新处理一遍」。只清 items 的话，`seen` 里那条还在，会立刻被当成重复丢掉，
 * 表现就是「点了清空，再跑还是说处理过」。
 */
export function clearQueue(): void {
  writeQueue({ items: [], seen: [] })
}

/** 手动丢弃一条通知（成功或失败都能删）。 */
export function dropQueueItem(id: string): void {
  const file = prune(readQueue())
  file.items = file.items.filter((x) => x.id !== id)
  writeQueue(file)
}

/** 抢锁（跨进程）。抢不到返回 false，不抛错。 */
export async function acquireQueueLock(owner: string, ttlMs = LOCK_TTL): Promise<boolean> {
  try {
    return await acquireLock(LOCK_NAME, owner, Math.max(5000, ttlMs))
  } catch {
    return false
  }
}

/** 心跳续期：只有持锁人才能续。 */
export async function refreshQueueLock(owner: string, ttlMs = LOCK_TTL): Promise<void> {
  try {
    await refreshLock(LOCK_NAME, owner, Math.max(5000, ttlMs))
  } catch {
    // ignore
  }
}

export async function releaseQueueLock(owner: string): Promise<void> {
  try {
    await releaseLock(LOCK_NAME, owner)
  } catch {
    // ignore
  }
}
