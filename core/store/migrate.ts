/**
 * 一次性迁移。两种来源，都只跑一次，成功后删掉原文件。
 *
 *   ① `agent.sqlite`（上一版的 SQLite 存储）→ `agent/data/` 下的文件；
 *   ② 更早的散装 JSON（config.json / sessions.json / …）→ 同上。
 *
 * 规则：
 *   - 每个文件单独处理，解析失败就跳过并**保留原文件**（宁可留着让人手工救，也不丢数据）；
 *   - 已经存在的目标文件绝不覆盖（可能比源数据新）；
 *   - 全部处理完写一个标记，之后不再重复扫。
 */
import {
  DB_FILE,
  LEGACY_CONFIG_FILE, LEGACY_HISTORY_FILE, LEGACY_KB_FOLDERS_FILE, LEGACY_KB_INDEX_FILE,
  LEGACY_PENDING_FILE, LEGACY_QUEUE_FILE, LEGACY_QUEUE_LOCK_FILE, LEGACY_RECORDS_FILE,
  LEGACY_RUNS_FILE, LEGACY_SESSIONS_FILE, LEGACY_SKILLS_FILE,
} from "../agent/paths"
import { deriveTitle, migrateSession } from "../agent/session_store"
import { runIdOf, type RunLogEntry } from "../diagnostics/store"
import { readJsonFile, removePath } from "./files"
import { kvText, kvWrite, kvWriteJson, writeItemIfAbsent } from "./store"

const MIGRATED_JSON_FLAG = "meta.migrated_v1"
const MIGRATED_SQLITE_FLAG = "meta.migrated_sqlite"

function dropDbFiles(): void {
  for (const p of [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"]) removePath(p)
}

function parseOrNull<T = any>(text: any): T | null {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    return null
  }
}

// ———————————————————————— ① 旧 SQLite ————————————————————————

/**
 * 把旧的 `agent.sqlite` 灌进文件目录，然后删库。
 *
 * 打不开库（绝大多数情况是没解锁 Scripting PRO）就**什么都不做、也不删文件**：
 * 用户以后解锁了还能再迁一次。
 */
export async function migrateFromSqlite(): Promise<void> {
  if (!FileManager.existsSync(DB_FILE)) return
  if (kvText(MIGRATED_SQLITE_FLAG)) {
    // 已经迁过，只是上次没删干净
    dropDbFiles()
    return
  }
  let db: SQLite.Database
  try {
    db = SQLite.open(DB_FILE, {
      foreignKeysEnabled: false,
      readonly: true,
      label: "agent-migrate",
      busyMode: 5,
      journalMode: "default",
      maximumReaderCount: 2,
    })
  } catch (e: any) {
    console.log(
      "旧数据库打不开，跳过迁移（用不了 SQLite 时多半是没解锁 Scripting PRO），文件先留着：" +
      (e?.message ?? String(e)),
    )
    return
  }

  // —— 键值 ——
  try {
    const rows = await db.fetchAll<{ key: string; value: string }>("SELECT key, value FROM kv")
    for (const row of rows) {
      const key = String(row?.key ?? "")
      if (!key) continue
      if (kvText(key) != null) continue // 文件里已经有更新的版本，别覆盖
      kvWrite(key, String(row?.value ?? ""))
    }
  } catch (e: any) {
    console.log("迁移配置失败：" + (e?.message ?? String(e)))
  }

  // —— 会话 ——
  try {
    const rows = await db.fetchAll<{ id: string; data: string }>("SELECT id, data FROM sessions")
    for (const row of rows) {
      const raw = parseOrNull<any>(row?.data)
      if (!raw || typeof raw !== "object" || !raw.id) continue
      const session = migrateSession(raw)
      if (!Array.isArray(session.messages)) session.messages = []
      writeItemIfAbsent("sessions", session.id, session)
    }
  } catch (e: any) {
    console.log("迁移会话失败：" + (e?.message ?? String(e)))
  }

  // —— 通知记录 ——
  try {
    const rows = await db.fetchAll<{ id: string; data: string }>("SELECT id, data FROM records")
    for (const row of rows) {
      const raw = parseOrNull<any>(row?.data)
      if (!raw || !raw.id) continue
      writeItemIfAbsent("records", String(raw.id), raw)
    }
  } catch (e: any) {
    console.log("迁移通知记录失败：" + (e?.message ?? String(e)))
  }

  // —— 运行诊断 ——
  try {
    const rows = await db.fetchAll<{ id: number; at: number; data: string }>("SELECT id, at, data FROM runs")
    rows.forEach((row) => {
      const raw = parseOrNull<RunLogEntry>(row?.data)
      if (!raw || typeof raw.at !== "number") return
      writeItemIfAbsent("runs", runIdOf(raw), raw)
    })
  } catch (e: any) {
    console.log("迁移诊断失败：" + (e?.message ?? String(e)))
  }

  kvWrite(MIGRATED_SQLITE_FLAG, String(Date.now()))
  dropDbFiles()
}

// ———————————————————————— ② 更早的散装 JSON ————————————————————————

/** 老版本 diagnostics.json 是数组，也兼容 `{ entries: [] }` 的写法。 */
function runsArray(raw: any): any[] {
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.entries)) return raw.entries
  return []
}

/** 把 sessions.json / history.json 里的会话写成条目。 */
function importSessions(rawSessions: any): { ids: string[] } {
  const sessions = Array.isArray(rawSessions) ? rawSessions : []
  const ids: string[] = []
  for (const raw of sessions) {
    if (!raw || typeof raw !== "object" || !raw.id) continue
    const session = migrateSession(raw)
    if (!Array.isArray(session.messages)) session.messages = []
    writeItemIfAbsent("sessions", session.id, session)
    ids.push(session.id)
  }
  return { ids }
}

export async function migrateLegacyJson(): Promise<void> {
  if (kvText(MIGRATED_JSON_FLAG)) return

  const dropAfter: string[] = []

  // —— 配置 ——
  const config = readJsonFile(LEGACY_CONFIG_FILE)
  if (config && typeof config === "object") {
    if (kvText("config") == null) kvWriteJson("config", config)
    dropAfter.push(LEGACY_CONFIG_FILE)
  }

  // —— 会话（含更老的 history.json） ——
  const sessionFile = readJsonFile<any>(LEGACY_SESSIONS_FILE)
  if (sessionFile && Array.isArray(sessionFile.sessions)) {
    const { ids } = importSessions(sessionFile.sessions)
    const currentId = ids.indexOf(String(sessionFile.currentId)) >= 0
      ? String(sessionFile.currentId)
      : (ids[0] ?? null)
    if (kvText("sessions.current") == null) kvWriteJson("sessions.current", currentId)
    dropAfter.push(LEGACY_SESSIONS_FILE)
  } else {
    const legacy = readJsonFile<any[]>(LEGACY_HISTORY_FILE)
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
      writeItemIfAbsent("sessions", session.id, session)
      if (kvText("sessions.current") == null) kvWriteJson("sessions.current", session.id)
      dropAfter.push(LEGACY_HISTORY_FILE)
    }
  }

  // —— 通知记录 ——
  const records = readJsonFile<any>(LEGACY_RECORDS_FILE)
  if (records && Array.isArray(records.items)) {
    for (const item of records.items) {
      if (!item || !item.id) continue
      writeItemIfAbsent("records", String(item.id), item)
    }
    dropAfter.push(LEGACY_RECORDS_FILE)
  }

  // —— 运行诊断 ——
  const runs = readJsonFile<any>(LEGACY_RUNS_FILE)
  if (Array.isArray(runs) || runs?.entries) {
    runsArray(runs).forEach((entry: RunLogEntry) => {
      if (!entry || typeof entry.at !== "number") return
      writeItemIfAbsent("runs", runIdOf(entry), entry)
    })
    dropAfter.push(LEGACY_RUNS_FILE)
  }

  // —— 通知队列 ——
  const queue = readJsonFile<any>(LEGACY_QUEUE_FILE)
  if (queue && typeof queue === "object") {
    if (kvText("notify.queue") == null) {
      kvWriteJson("notify.queue", {
        items: Array.isArray(queue.items) ? queue.items : [],
        seen: Array.isArray(queue.seen) ? queue.seen : [],
      })
    }
    dropAfter.push(LEGACY_QUEUE_FILE)
  }

  // —— 快捷指令回传待办 ——
  const pending = readJsonFile<any>(LEGACY_PENDING_FILE)
  if (pending && typeof pending === "object") {
    if (kvText("tools.pending") == null) {
      kvWriteJson("tools.pending", {
        pending: Array.isArray(pending.pending) ? pending.pending : [],
        done: Array.isArray(pending.done) ? pending.done : [],
      })
    }
    dropAfter.push(LEGACY_PENDING_FILE)
  }

  // —— 知识库索引 / 外部文件夹 ——
  const kbIndex = readJsonFile<any>(LEGACY_KB_INDEX_FILE)
  if (kbIndex && Array.isArray(kbIndex.chunks) && Array.isArray(kbIndex.docs)) {
    if (kvText("kb.index") == null) kvWriteJson("kb.index", kbIndex)
    dropAfter.push(LEGACY_KB_INDEX_FILE)
  }
  const kbFolders = readJsonFile<any>(LEGACY_KB_FOLDERS_FILE)
  if (Array.isArray(kbFolders)) {
    if (kvText("kb.folders") == null) kvWriteJson("kb.folders", kbFolders)
    dropAfter.push(LEGACY_KB_FOLDERS_FILE)
  }

  // —— 技能注册表（技能正文在 skills/ 目录里，不动） ——
  const skills = readJsonFile<any>(LEGACY_SKILLS_FILE)
  if (skills && Array.isArray(skills.skills)) {
    if (kvText("skills.registry") == null) kvWriteJson("skills.registry", skills)
    dropAfter.push(LEGACY_SKILLS_FILE)
  }

  kvWrite(MIGRATED_JSON_FLAG, String(Date.now()))
  for (const path of dropAfter) removePath(path)
  // 老版本的队列锁文件已经没有意义了（锁现在用目录实现），顺手删掉。
  removePath(LEGACY_QUEUE_LOCK_FILE)
}
