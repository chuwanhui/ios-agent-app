/**
 * 一次性迁移：把老版本的 JSON 存储灌进 SQLite，**成功后删掉原文件**。
 *
 * 规则：
 *   - 每个文件单独处理，解析失败就跳过并保留原文件（宁可留着让人手工救，也不能丢数据）；
 *   - 全部处理完把 `meta.migrated_v1` 写进库，之后不再重复扫；
 *   - 老版本的 `history.json`（单会话）也会转成一个会话。
 */
import {
  LEGACY_CONFIG_FILE, LEGACY_HISTORY_FILE, LEGACY_KB_FOLDERS_FILE, LEGACY_KB_INDEX_FILE,
  LEGACY_PENDING_FILE, LEGACY_QUEUE_FILE, LEGACY_QUEUE_LOCK_FILE, LEGACY_RECORDS_FILE,
  LEGACY_RUNS_FILE, LEGACY_SESSIONS_FILE, LEGACY_SKILLS_FILE,
} from "../agent/paths"
import { deriveTitle, migrateSession } from "../agent/session_store"
import { kvStep, kvText, tx } from "./db"

const MIGRATED_FLAG = "meta.migrated_v1"

function readJson(path: string): any | null {
  try {
    if (!FileManager.existsSync(path)) return null
    const text = FileManager.readAsStringSync(path)
    if (!text) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function dropFile(path: string): void {
  try {
    if (FileManager.existsSync(path)) FileManager.removeSync(path)
  } catch {
    // 删不掉就留着，反正已经灌进库了，下次也不会再读它
  }
}

/** 老版本 diagnostics.json 是数组，也兼容 `{ entries: [] }` 的写法。 */
function runsArray(raw: any): any[] {
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.entries)) return raw.entries
  return []
}

interface SessionRow {
  id: string
  position: number
  updatedAt: number
  data: string
}

/** 把 sessions.json / history.json 归一化成要入库的会话行。 */
function sessionRows(rawSessions: any): { rows: SessionRow[]; currentId: string | null } {
  const sessions = Array.isArray(rawSessions) ? rawSessions : []
  const rows: SessionRow[] = []
  sessions.forEach((raw: any, i: number) => {
    if (!raw || typeof raw !== "object" || !raw.id) return
    const s = migrateSession(raw)
    rows.push({ id: s.id, position: i, updatedAt: Number(s.updatedAt) || 0, data: JSON.stringify(s) })
  })
  return { rows, currentId: null }
}

export async function migrateLegacyJson(): Promise<void> {
  if (await kvText(MIGRATED_FLAG)) return

  const steps: SQLite.TransactionStep[] = []
  const dropAfter: string[] = []

  // —— 配置 ——
  const config = readJson(LEGACY_CONFIG_FILE)
  if (config && typeof config === "object") {
    steps.push(kvStep("config", JSON.stringify(config)))
    dropAfter.push(LEGACY_CONFIG_FILE)
  }

  // —— 会话（含更老的 history.json） ——
  const sessionFile = readJson(LEGACY_SESSIONS_FILE)
  if (sessionFile && Array.isArray(sessionFile.sessions)) {
    const { rows } = sessionRows(sessionFile.sessions)
    for (const row of rows) {
      steps.push({
        sql: "INSERT INTO sessions (id, position, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [row.id, row.position, row.updatedAt, row.data],
      })
    }
    const currentId = rows.some((r) => r.id === sessionFile.currentId)
      ? String(sessionFile.currentId)
      : (rows[0]?.id ?? null)
    steps.push(kvStep("sessions.current", JSON.stringify(currentId)))
    dropAfter.push(LEGACY_SESSIONS_FILE)
  } else {
    const legacy = readJson(LEGACY_HISTORY_FILE)
    if (Array.isArray(legacy) && legacy.length > 0) {
      const id = "s" + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
      const now = Date.now()
      const session = migrateSession({
        id,
        title: deriveTitle(legacy),
        createdAt: now,
        updatedAt: now,
        messages: legacy,
        workspaceName: "",
      })
      steps.push({
        sql: "INSERT INTO sessions (id, position, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [session.id, 0, session.updatedAt, JSON.stringify(session)],
      })
      steps.push(kvStep("sessions.current", JSON.stringify(session.id)))
      dropAfter.push(LEGACY_HISTORY_FILE)
    }
  }

  // —— 通知记录 ——
  const records = readJson(LEGACY_RECORDS_FILE)
  if (records && Array.isArray(records.items)) {
    for (const item of records.items) {
      if (!item || !item.id) continue
      steps.push({
        sql: "INSERT INTO records (id, at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [String(item.id), Number(item.at) || 0, JSON.stringify(item)],
      })
    }
    dropAfter.push(LEGACY_RECORDS_FILE)
  }

  // —— 运行诊断 ——
  const runs = readJson(LEGACY_RUNS_FILE)
  if (Array.isArray(runs) || runs?.entries) {
    for (const entry of runsArray(runs)) {
      if (!entry || typeof entry.at !== "number") continue
      steps.push({
        sql: "INSERT INTO runs (at, data) VALUES (?, ?)",
        args: [Number(entry.at) || 0, JSON.stringify(entry)],
      })
    }
    dropAfter.push(LEGACY_RUNS_FILE)
  }

  // —— 通知队列 + 队列锁 ——
  const queue = readJson(LEGACY_QUEUE_FILE)
  if (queue && typeof queue === "object") {
    steps.push(kvStep("notify.queue", JSON.stringify({
      items: Array.isArray(queue.items) ? queue.items : [],
      seen: Array.isArray(queue.seen) ? queue.seen : [],
    })))
    dropAfter.push(LEGACY_QUEUE_FILE)
  }
  const lock = readJson(LEGACY_QUEUE_LOCK_FILE)
  if (lock && lock.owner) {
    steps.push({
      sql: `INSERT INTO locks (name, owner, until, updated_at) VALUES ('notify', ?, ?, ?)
            ON CONFLICT(name) DO NOTHING`,
      args: [String(lock.owner), Number(lock.until) || 0, Number(lock.updatedAt) || Date.now()],
    })
    dropAfter.push(LEGACY_QUEUE_LOCK_FILE)
  }

  // —— 快捷指令回传待办 ——
  const pending = readJson(LEGACY_PENDING_FILE)
  if (pending && typeof pending === "object") {
    steps.push(kvStep("tools.pending", JSON.stringify({
      pending: Array.isArray(pending.pending) ? pending.pending : [],
      done: Array.isArray(pending.done) ? pending.done : [],
    })))
    dropAfter.push(LEGACY_PENDING_FILE)
  }

  // —— 知识库索引 / 外部文件夹 ——
  const kbIndex = readJson(LEGACY_KB_INDEX_FILE)
  if (kbIndex && Array.isArray(kbIndex.chunks) && Array.isArray(kbIndex.docs)) {
    steps.push(kvStep("kb.index", JSON.stringify(kbIndex)))
    dropAfter.push(LEGACY_KB_INDEX_FILE)
  }
  const kbFolders = readJson(LEGACY_KB_FOLDERS_FILE)
  if (Array.isArray(kbFolders)) {
    steps.push(kvStep("kb.folders", JSON.stringify(kbFolders)))
    dropAfter.push(LEGACY_KB_FOLDERS_FILE)
  }

  // —— 技能注册表（技能正文在 skills/ 目录里，不动） ——
  const skills = readJson(LEGACY_SKILLS_FILE)
  if (skills && Array.isArray(skills.skills)) {
    steps.push(kvStep("skills.registry", JSON.stringify(skills)))
    dropAfter.push(LEGACY_SKILLS_FILE)
  }

  steps.push(kvStep(MIGRATED_FLAG, String(Date.now())))
  await tx(steps)
  for (const path of dropAfter) dropFile(path)
}
