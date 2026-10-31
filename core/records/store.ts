/**
 * 通知记录（「记录」页的数据）：按 App / 联系人看这段时间收到和回复了什么。
 *
 * 存在 `agent/data/records/`（一条记录一个文件）。读走内存，写先改内存再落盘，
 * 超出上限的老记录顺手删掉。
 */
import { clearItems, deleteItem, listItems, writeItem } from "../store/store"

export interface MessageRecord {
  id: string
  app: string
  sender: string
  content: string
  reply: string
  at: number
}

const MAX_RECORDS = 500

/** 内存副本（启动时由 hydrateRecords 填好），按时间倒序。 */
let cache: MessageRecord[] | null = null

function newId(): string {
  return "r" + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
}

function normalizeRecord(input: Partial<MessageRecord>): MessageRecord {
  return {
    id: String(input.id ?? "") || newId(),
    app: String(input.app ?? "").trim(),
    sender: String(input.sender ?? "").trim(),
    content: String(input.content ?? ""),
    reply: String(input.reply ?? ""),
    at: Number(input.at ?? Date.now()) || Date.now(),
  }
}

export async function hydrateRecords(): Promise<void> {
  const items: MessageRecord[] = []
  for (const raw of listItems<Partial<MessageRecord>>("records")) {
    if (!raw || !raw.id) continue
    items.push(normalizeRecord(raw))
  }
  items.sort((a, b) => b.at - a.at)
  cache = items.slice(0, MAX_RECORDS)
}

export function loadMessageRecords(): MessageRecord[] {
  return (cache ?? []).slice()
}

/** 记一条（返回记录本身，调用方不必等落库）。 */
export function appendMessageRecord(input: Omit<MessageRecord, "id" | "at"> & { at?: number }): MessageRecord {
  const rec = normalizeRecord({
    app: input.app,
    sender: input.sender,
    content: input.content,
    reply: input.reply,
    at: input.at,
  })
  const prev = cache ?? []
  cache = [rec, ...prev].slice(0, MAX_RECORDS)
  try {
    writeItem("records", rec.id, rec)
    // 被挤出上限的那几条一起删掉，不然文件只增不减
    for (const dropped of prev.slice(MAX_RECORDS - 1)) deleteItem("records", dropped.id)
  } catch (e: any) {
    console.log("保存通知记录失败：" + (e?.message ?? String(e)))
  }
  return rec
}

export function clearMessageRecords(): void {
  cache = []
  clearItems("records")
}
