/**
 * 会话存储：会话 CRUD、工作区目录、聊天图片的落盘与清理。
 */
import { ChatMessage, Session, SessionStore } from "./types"
import {
  AGENT_DIR, IMAGES_DIR, LEGACY_HISTORY_FILE, NEW_SESSION_TITLE, SESSIONS_FILE, WORKSPACES_DIR,
} from "./paths"
import { recoverAtomicFile, writeJsonAtomically } from "./file_io"

// ———————————————————————— 会话 ————————————————————————

function newSessionId(): string {
  return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
}

/** 工作区名只作为单层目录名使用；空值统一落到 default。 */
export function normalizeWorkspaceName(raw?: string): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[\u0000-\u001f/\\:]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 64)
  return cleaned || "default"
}

/** 返回并确保工作区目录存在。 */
export function ensureWorkspace(workspaceName?: string): string {
  const path = WORKSPACES_DIR + "/" + normalizeWorkspaceName(workspaceName)
  FileManager.createDirectorySync(path, true)
  return path
}

function migratedWorkspaceName(session: Session): string {
  if (session?.workspaceName) return normalizeWorkspaceName(session.workspaceName)
  const legacyName = normalizeWorkspaceName(session?.id)
  const legacyPath = WORKSPACES_DIR + "/" + legacyName
  return FileManager.existsSync(legacyPath) ? legacyName : "default"
}

export function makeSession(workspaceName = "default"): Session {
  const now = Date.now()
  return {
    id: newSessionId(),
    title: NEW_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
    workspaceName: normalizeWorkspaceName(workspaceName),
  }
}

/**
 * 把一张 UIImage 按配置缩放 / 压缩后存进 IMAGES_DIR，返回写入的绝对路径。
 * 失败返回 null。文件名用时间戳 + 随机串，避免重名。
 */
export function saveChatImage(img: UIImage, maxSize: number, quality: number): string | null {
  try {
    const w = img.width
    const h = img.height
    if (!(w > 0 && h > 0)) return null
    let out = img
    if (maxSize > 0) {
      const longSide = Math.max(w, h)
      if (longSide > maxSize) {
        const scale = maxSize / longSide
        const tw = Math.round(w * scale)
        const th = Math.round(h * scale)
        const rendered = img.renderedIn({ width: tw, height: th })
        if (rendered) out = rendered
      }
    }
    const q = quality > 0 && quality <= 1 ? quality : 0.8
    const data = out.toJPEGData(q)
    if (!data) return null
    FileManager.createDirectorySync(IMAGES_DIR, true)
    const name =
      "img_" +
      Date.now().toString(36) +
      "_" +
      Math.floor(Math.random() * 46656).toString(36) +
      ".jpg"
    const path = IMAGES_DIR + "/" + name
    FileManager.writeAsDataSync(path, data)
    return FileManager.existsSync(path) ? path : null
  } catch {
    return null
  }
}

/**
 * 把磁盘上的图片读出来转成 data URL（data:image/jpeg;base64,...）。
 * 发给模型时用；读不到返回 null。
 */
export function imageToDataUrl(path: string): string | null {
  try {
    if (!FileManager.existsSync(path)) return null
    const data = FileManager.readAsDataSync(path)
    const b64 = data.toBase64String()
    if (!b64) return null
    return "data:image/jpeg;base64," + b64
  } catch {
    return null
  }
}

/** 用第一条用户消息生成会话标题（工具回传那种隐藏消息不算）。 */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && !m.hidden)
  const t = (first?.content ?? "").trim().replace(/\s+/g, " ")
  if (!t) return NEW_SESSION_TITLE
  return t.length > 18 ? t.slice(0, 18) + "…" : t
}

export function loadStore(): SessionStore {
  try {
    recoverAtomicFile(SESSIONS_FILE)
    const parsed = JSON.parse(FileManager.readAsStringSync(SESSIONS_FILE))
    if (parsed && Array.isArray(parsed.sessions)) {
      const sessions: Session[] = parsed.sessions.map((session: Session) => ({
        ...session,
        workspaceName: migratedWorkspaceName(session),
      }))
      const hasCurrent = sessions.some((s) => s.id === parsed.currentId)
      return { currentId: hasCurrent ? parsed.currentId : (sessions[0]?.id ?? null), sessions }
    }
  } catch {
    // 文件不存在或损坏，尝试下面迁移
  }
  // 兼容旧版：把单会话 history.json 迁移成一个会话
  try {
    const legacy = JSON.parse(FileManager.readAsStringSync(LEGACY_HISTORY_FILE))
    if (Array.isArray(legacy) && legacy.length > 0) {
      const s = makeSession()
      s.messages = legacy
      s.title = deriveTitle(legacy)
      return { currentId: s.id, sessions: [s] }
    }
  } catch {
    // 没有旧数据
  }
  return { currentId: null, sessions: [] }
}

export function saveStore(store: SessionStore): void {
  FileManager.createDirectorySync(AGENT_DIR, true)
  writeJsonAtomically(SESSIONS_FILE, store)
}

/** 保证 store 里有一个可用的当前会话（没有就新建一个并放到最前）。 */
export function withCurrentSession(store: SessionStore): { store: SessionStore; session: Session } {
  const found = store.sessions.find((s) => s.id === store.currentId)
  if (found) return { store, session: found }
  const s = makeSession()
  return { store: { currentId: s.id, sessions: [s, ...store.sessions] }, session: s }
}

export function upsertSession(store: SessionStore, session: Session): SessionStore {
  const exists = store.sessions.some((s) => s.id === session.id)
  const sessions = exists
    ? store.sessions.map((s) => (s.id === session.id ? session : s))
    : [session, ...store.sessions]
  return { currentId: session.id, sessions }
}

export function removeSession(store: SessionStore, id: string): SessionStore {
  const sessions = store.sessions.filter((s) => s.id !== id)
  const currentId = store.currentId === id ? (sessions[0]?.id ?? null) : store.currentId
  return { currentId, sessions }
}

// ———————————————————————— 图片文件清理 ————————————————————————

/** 列目录，统一返回完整路径（`readDirectorySync` 只给文件名）。 */
function listDir(dir: string): string[] {
  let names: string[] = []
  try {
    names = FileManager.readDirectorySync(dir)
  } catch {
    return []
  }
  const d = dir.replace(/\/+$/, "")
  return names.map((n) => (n.startsWith("/") || n.indexOf("/") >= 0 ? n : d + "/" + n))
}

function dropFile(path: string): void {
  try {
    if (path && FileManager.existsSync(path)) FileManager.removeSync(path)
  } catch {
    // 删不掉就留着，下次启动再扫一遍
  }
}

/** 某个会话引用到的图片。 */
export function imagesOfSession(session: Session | null | undefined): string[] {
  const out: string[] = []
  for (const m of session?.messages ?? []) {
    for (const p of m.images ?? []) if (p) out.push(p)
  }
  return out
}

/** 整个 store 里还被引用的图片（任何一个会话用到都算“有用”）。 */
export function referencedImages(store: SessionStore): Set<string> {
  const set = new Set<string>()
  for (const s of store.sessions ?? []) {
    for (const p of imagesOfSession(s)) set.add(p)
  }
  return set
}

/**
 * 删会话，顺手删掉只有它引用的图片。
 * 聊天图片从来没被自动清理过，不删就只增不减。
 */
export function removeSessionWithImages(store: SessionStore, id: string): SessionStore {
  const target = store.sessions.find((s) => s.id === id)
  const next = removeSession(store, id)
  const stillUsed = referencedImages(next)
  for (const p of imagesOfSession(target)) {
    if (!stillUsed.has(p)) dropFile(p)
  }
  return next
}

/**
 * 清掉 `agent/images/` 里没人引用的文件（删会话、裁剪历史、过期会话都会留下孤儿）。
 * 返回删掉的文件数。
 */
export function pruneOrphanImages(store: SessionStore): number {
  const alive = referencedImages(store)
  let removed = 0
  for (const path of listDir(IMAGES_DIR)) {
    if (alive.has(path)) continue
    dropFile(path)
    removed += 1
  }
  return removed
}
