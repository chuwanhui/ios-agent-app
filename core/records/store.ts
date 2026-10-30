import { AGENT_DIR } from "../agent/store"

export interface MessageRecord {
  id: string
  app: string
  sender: string
  content: string
  reply: string
  at: number
}

interface MessageRecordFile {
  items: MessageRecord[]
}

const RECORD_FILE = AGENT_DIR + "/message_records.json"
const MAX_RECORDS = 500

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

function readFile(): MessageRecordFile {
  try {
    const raw = JSON.parse(FileManager.readAsStringSync(RECORD_FILE))
    const list = Array.isArray(raw?.items) ? raw.items : []
    return { items: list.map((item: Partial<MessageRecord>) => normalizeRecord(item)) }
  } catch {
    return { items: [] }
  }
}

function writeFile(next: MessageRecordFile): void {
  try {
    FileManager.createDirectorySync(AGENT_DIR, true)
    FileManager.writeAsStringSync(RECORD_FILE, JSON.stringify(next, null, 2))
  } catch {
    // ignore
  }
}

export function loadMessageRecords(): MessageRecord[] {
  return readFile().items.slice().sort((a, b) => b.at - a.at)
}

export function appendMessageRecord(input: Omit<MessageRecord, "id" | "at"> & { at?: number }): MessageRecord {
  const file = readFile()
  const rec = normalizeRecord({
    app: input.app,
    sender: input.sender,
    content: input.content,
    reply: input.reply,
    at: input.at,
  })
  const items = [rec, ...file.items].slice(0, MAX_RECORDS)
  writeFile({ items })
  return rec
}

export function clearMessageRecords(): void {
  writeFile({ items: [] })
}
