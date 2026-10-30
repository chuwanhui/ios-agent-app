/**
 * 通知记录（「记录」页的数据）：按 App / 联系人看这段时间收到和回复了什么。
 *
 * 存在 `agent.sqlite` 的 `records` 表（一条记录一行）。读走内存，写先改内存再落库，
 * 超出上限的老记录顺手删掉。
 */
import { all, exec, tx } from "../db/db"

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
  const rows = await all<{ data: string }>(
    "SELECT data FROM records ORDER BY at DESC LIMIT ?",
    [MAX_RECORDS],
  )
  const items: MessageRecord[] = []
  for (const row of rows) {
    try {
      items.push(normalizeRecord(JSON.parse(row.data)))
    } catch {
      // 坏行跳过
    }
  }
  cache = items
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
  cache = [rec, ...(cache ?? [])].slice(0, MAX_RECORDS)
  void tx([
    {
      sql: `INSERT INTO records (id, at, data) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data`,
      args: [rec.id, rec.at, JSON.stringify(rec)],
    },
    {
      sql: "DELETE FROM records WHERE id NOT IN (SELECT id FROM records ORDER BY at DESC LIMIT ?)",
      args: [MAX_RECORDS],
    },
  ]).catch((e) => {
    console.log("保存通知记录失败：" + (e?.message ?? String(e)))
  })
  return rec
}

export function clearMessageRecords(): void {
  cache = []
  void exec("DELETE FROM records").catch(() => {})
}
