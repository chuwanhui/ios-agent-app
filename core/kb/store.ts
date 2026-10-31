/**
 * 本地知识库（离线、纯 JS，不依赖任何端上模型 / 付费能力）。
 *
 * 导入：把资料丢进「文件」App → 我的 iPhone → Scripting → 知识库，
 * 然后在设置页点「扫描并导入」。导入时就把文本切好片存进索引，
 * 原始文件会被移到同目录下的「已导入」，避免重复导入。
 *
 * 检索：中文按 bigram（双字）+ 英文按单词建倒排，BM25 排序，
 * 再对「整句原样命中」加分。全部在主线程里做，几千个片段也就几十毫秒；
 * 不联网、不依赖任何端上模型或付费能力。
 */

/** 用户丢资料的目录（在「文件」App 里可见）。 */
export const KB_INBOX = FileManager.documentsDirectory + "/知识库"
/** 导入完成的资料归档目录。 */
export const KB_DONE = KB_INBOX + "/已导入"

import { kvJson, kvWriteJson } from "../store/store"

/** 索引在 kv 里的键（正文分块比较大，但仍然是一个文件整体替换）。 */
const KB_INDEX_KEY = "kb.index"
const KB_FOLDERS_KEY = "kb.folders"

export interface KbChunk {
  id: string
  docId: string
  title: string
  text: string
}

export interface KbDoc {
  id: string
  title: string
  source: string
  chars: number
  chunks: number
  addedAt: number
  /** `folder:<书签名>` = 来自外挂文件夹；空 = 从「知识库」文件夹导入的。 */
  origin?: string
  /** 外挂文件夹里的原始路径（只读，不动原文件）。 */
  path?: string
}

export interface KbIndex {
  version: number
  docs: KbDoc[]
  chunks: KbChunk[]
  updatedAt: number
}

export interface KbHit {
  title: string
  text: string
  score: number
}

export interface KbImportResult {
  added: KbDoc[]
  skipped: string[]
  errors: string[]
}

const CHUNK_TARGET = 500
const CHUNK_MAX = 900
const TEXT_EXT = ["txt", "text", "md", "markdown", "json", "csv", "log"]
const K1 = 1.2
/** 标题命中加分（相对 BM25 分数的量级）。 */
const TITLE_BOOST = 2
/** 同一份资料在一次检索里最多贡献几段。 */
const MAX_PER_DOC = 2
const B = 0.7

function emptyIndex(): KbIndex {
  return { version: 1, docs: [], chunks: [], updatedAt: 0 }
}

// —— 索引读写（带进程内缓存） ——

let cache: KbIndex | null = null
let termMemo = new Map<string, Map<string, number>>()

/** 启动时把索引从库里装进内存。 */
export async function hydrateKb(): Promise<void> {
  let idx = emptyIndex()
  try {
    const parsed = kvJson<KbIndex>(KB_INDEX_KEY)
    if (parsed && Array.isArray(parsed.chunks) && Array.isArray(parsed.docs)) {
      idx = {
        version: 1,
        docs: parsed.docs,
        chunks: parsed.chunks,
        updatedAt: parsed.updatedAt ?? 0,
      }
    }
  } catch {
    idx = emptyIndex()
  }
  cache = idx
  termMemo = new Map()
}

/**
 * 读索引（同步，走内存）。`force` 保留是为了兼容老调用点：
 * 现在所有写入都会即时更新内存，不存在「内存比库旧」的情况。
 */
export function loadKbIndex(_force = false): KbIndex {
  return cache ?? emptyIndex()
}

export function saveKbIndex(idx: KbIndex): void {
  idx.updatedAt = Date.now()
  cache = idx
  termMemo = new Map()
  // 写不进去也不该让对话崩掉
  kvWriteJson(KB_INDEX_KEY, idx)
}

export function kbStats(): { docs: number; chunks: number; chars: number } {
  const idx = loadKbIndex()
  let chars = 0
  for (const d of idx.docs) chars += d.chars
  return { docs: idx.docs.length, chunks: idx.chunks.length, chars }
}

// —— 分词 / 切片 ——

/** 中文 bigram + 英文数字单词。不依赖 NaturalLanguage（那是付费能力）。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = (text ?? "").toLowerCase()
  const latin = lower.match(/[a-z0-9]+/g) ?? []
  for (const w of latin) {
    if (w.length > 1) out.push(w)
  }
  const cjk = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

function splitSentences(text: string): string[] {
  const out: string[] = []
  const breaks = "。！？；!?;\n"
  let buf = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    if (breaks.indexOf(ch) >= 0) {
      out.push(buf)
      buf = ""
    }
  }
  if (buf) out.push(buf)
  return out
}

/** 把整篇文本切成「约 500 字一段」的片段，长段落按句子边界切。 */
export function chunkText(text: string): string[] {
  const norm = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!norm) return []

  const chunks: string[] = []
  const paras = norm.split(/\n{2,}/)
  let cur = ""
  const flush = () => {
    const t = cur.trim()
    if (t) chunks.push(t)
    cur = ""
  }

  for (const raw of paras) {
    const p = raw.trim()
    if (!p) continue
    if (p.length > CHUNK_MAX) {
      flush()
      let buf = ""
      for (const s of splitSentences(p)) {
        if (buf.length > 0 && buf.length + s.length > CHUNK_TARGET) {
          chunks.push(buf.trim())
          buf = ""
        }
        buf += s
        if (buf.length >= CHUNK_MAX) {
          chunks.push(buf.trim())
          buf = ""
        }
      }
      if (buf.trim()) chunks.push(buf.trim())
      continue
    }
    if (cur.length > 0 && cur.length + p.length + 1 > CHUNK_TARGET) flush()
    cur += (cur ? "\n" : "") + p
  }
  flush()
  return chunks.filter((c) => c.trim().length > 0)
}

// —— 导入 ——

function extOf(path: string): string {
  const i = path.lastIndexOf(".")
  return i < 0 ? "" : path.slice(i + 1).toLowerCase()
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 列目录，统一返回**完整路径**。
 * 坑：`FileManager.readDirectorySync` 实际返回的是纯文件名（不是文档里写的完整路径），
 * 拿去 isDirectorySync / readAsStringSync 会按当前目录解析而失败，必须自己拼。
 */
function ls(dir: string): string[] {
  let names: string[] = []
  try {
    names = FileManager.readDirectorySync(dir)
  } catch {
    return []
  }
  const d = dir.replace(/\/+$/, "")
  return names.map((n) => (n.startsWith("/") || n.indexOf("/") >= 0 ? n : d + "/" + n))
}

async function readDocText(path: string): Promise<string | null> {
  const ext = extOf(path)
  if (ext === "pdf") {
    try {
      const doc = PDFDocument.fromFilePath(path)
      if (!doc || doc.isLocked) return null
      // PDFDocument.text 或 .string 任意一个有内容即可；都没有就跳过
      const s = (doc as any).text ?? (doc as any).string
      if (!s || typeof s !== "string") return null
      return s
    } catch {
      return null
    }
  }
  if (TEXT_EXT.indexOf(ext) < 0) return null
  try {
    return FileManager.readAsStringSync(path)
  } catch {
    return null
  }
}

function uniqueName(dir: string, name: string): string {
  if (!FileManager.existsSync(dir + "/" + name)) return name
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let i = 2
  while (FileManager.existsSync(`${dir}/${stem}-${i}${ext}`)) i += 1
  return `${stem}-${i}${ext}`
}

function rand36(len: number): string {
  return Math.random().toString(36).slice(2, 2 + len)
}

/**
 * 扫描「知识库」目录，把支持的文件读成文本、切片、写进索引，
 * 然后把源文件移到「已导入」。
 */
export async function importKbInbox(
  onProgress?: (text: string) => void,
): Promise<KbImportResult> {
  const res: KbImportResult = { added: [], skipped: [], errors: [] }
  try {
    FileManager.createDirectorySync(KB_DONE, true)
  } catch {
    // ignore
  }

  const idx = loadKbIndex(true)
  const paths = ls(KB_INBOX).sort()

  for (const p of paths) {
    const name = baseName(p)
    if (name.startsWith(".")) continue
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (isDir) continue

    onProgress?.(`正在读取「${name}」…`)
    let text: string | null = null
    try {
      text = await readDocText(p)
    } catch (e: any) {
      res.errors.push(`${name}：${e?.message ?? "读取失败"}`)
      continue
    }
    if (text == null) {
      res.skipped.push(`${name}（不支持的格式，只支持 txt/md/json/csv/log/pdf）`)
      continue
    }
    const chunks = chunkText(text)
    if (chunks.length === 0) {
      res.skipped.push(`${name}（没提取到文字，扫描版 PDF 需要一个字一个字的识别，暂时不支持）`)
      continue
    }

    const docId = "d" + Date.now().toString(36) + rand36(4)
    const title = name.replace(/\.[^.]+$/, "")
    for (let i = 0; i < chunks.length; i++) {
      idx.chunks.push({ id: `${docId}_${i}`, docId, title, text: chunks[i] })
    }
    const doc: KbDoc = {
      id: docId,
      title,
      source: name,
      chars: text.length,
      chunks: chunks.length,
      addedAt: Date.now(),
    }
    idx.docs.push(doc)
    res.added.push(doc)

    try {
      FileManager.renameSync(p, KB_DONE + "/" + uniqueName(KB_DONE, name))
    } catch {
      // 移动失败不影响导入结果
    }
  }

  saveKbIndex(idx)
  return res
}

export function deleteKbDoc(docId: string): void {
  const idx = loadKbIndex(true)
  idx.docs = idx.docs.filter((d) => d.id !== docId)
  idx.chunks = idx.chunks.filter((c) => c.docId !== docId)
  saveKbIndex(idx)

}

export function clearKb(): void {
  saveKbIndex(emptyIndex())

}

// —— 导入：从「文件」App 选文件 / 挂一个外部文件夹（只读） ——

/** 外挂文件夹：书签持久化，重启后仍能读到（书签失效就要重新选一次）。 */
export interface KbFolder {
  /** 书签名（`FileManager.bookmarkedPath(bookmark)` 取回路径）。 */
  bookmark: string
  label: string
  path: string
  addedAt: number
}

const FOLDER_SKIP = ["node_modules", ".git", ".obsidian", ".trash", "已导入", "Library"]
const FOLDER_MAX_FILES = 300
const FOLDER_MAX_DEPTH = 5

let folderCache: KbFolder[] | null = null

export async function hydrateKbFolders(): Promise<void> {
  let out: KbFolder[] = []
  try {
    const parsed = kvJson<KbFolder[]>(KB_FOLDERS_KEY)
    if (Array.isArray(parsed)) out = parsed
  } catch {
    out = []
  }
  folderCache = out
}

export function listKbFolders(): KbFolder[] {
  return folderCache ?? []
}

function saveKbFolders(list: KbFolder[]): void {
  folderCache = list
  kvWriteJson(KB_FOLDERS_KEY, list)
}

export function addKbFolder(bookmark: string, label: string, path: string): KbFolder {
  const list = listKbFolders().filter((f) => f.bookmark !== bookmark)
  const folder: KbFolder = { bookmark, label: label || bookmark, path, addedAt: Date.now() }
  list.push(folder)
  saveKbFolders(list)
  return folder
}

/** 忘掉一个外挂文件夹：连同它索引进去的资料一起删（原文件夹不动）。 */
export function removeKbFolder(bookmark: string): void {
  saveKbFolders(listKbFolders().filter((f) => f.bookmark !== bookmark))
  dropOriginDocs("folder:" + bookmark)
  try {
    FileManager.removeFileBookmark(bookmark)
  } catch {
    // ignore
  }
}

/** 删掉某个来源（外挂文件夹）上一次索引的资料。 */
function dropOriginDocs(origin: string): void {
  const idx = loadKbIndex(true)
  const dead: string[] = []
  for (const d of idx.docs) if (d.origin === origin) dead.push(d.id)
  if (dead.length === 0) return
  idx.docs = idx.docs.filter((d) => d.origin !== origin)
  idx.chunks = idx.chunks.filter((c) => dead.indexOf(c.docId) < 0)
  saveKbIndex(idx)

}

function walkFolder(dir: string, out: string[], depth: number): void {
  if (depth > FOLDER_MAX_DEPTH || out.length >= FOLDER_MAX_FILES) return
  for (const p of ls(dir).sort()) {
    const name = baseName(p)
    if (!name || name.startsWith(".") || FOLDER_SKIP.indexOf(name) >= 0) continue
    let isDir = false
    try {
      isDir = FileManager.isDirectorySync(p)
    } catch {
      isDir = false
    }
    if (isDir) walkFolder(p, out, depth + 1)
    else out.push(p)
    if (out.length >= FOLDER_MAX_FILES) return
  }
}

/**
 * 重新索引一个外挂文件夹（只读、不动原文件）：
 * 先把它上一次索引的资料删掉，再按当前内容重建 —— 改了、删了文件都会反映过来。
 */
export async function importKbFolder(
  folder: KbFolder,
  onProgress?: (text: string) => void,
): Promise<KbImportResult> {
  const res: KbImportResult = { added: [], skipped: [], errors: [] }
  const root = FileManager.bookmarkedPath(folder.bookmark)
  if (!root) {
    res.errors.push(`「${folder.label}」的书签已失效，删掉重新选一次文件夹吧。`)
    return res
  }

  const idx = loadKbIndex(true)
  const origin = "folder:" + folder.bookmark
  const dead: string[] = []
  for (const d of idx.docs) if (d.origin === origin) dead.push(d.id)
  idx.docs = idx.docs.filter((d) => d.origin !== origin)
  idx.chunks = idx.chunks.filter((c) => dead.indexOf(c.docId) < 0)

  const files: string[] = []
  walkFolder(root, files, 0)
  if (files.length >= FOLDER_MAX_FILES) {
    res.skipped.push(`文件夹里文件太多，这次只索引前 ${FOLDER_MAX_FILES} 个`)
  }

  const prefix = root.replace(/\/+$/, "") + "/"
  for (const p of files) {
    const shown = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : baseName(p)
    onProgress?.(`正在读取「${shown}」…`)
    let text: string | null = null
    try {
      text = await readDocText(p)
    } catch (e: any) {
      res.errors.push(`${shown}：${e?.message ?? "读取失败"}`)
      continue
    }
    if (text == null) {
      res.skipped.push(`${shown}（格式不支持或扫描版 PDF）`)
      continue
    }
    const chunks = chunkText(text)
    if (chunks.length === 0) {
      res.skipped.push(`${shown}（没提取到文字）`)
      continue
    }
    const docId = "d" + Date.now().toString(36) + rand36(4)
    const title = shown.replace(/\.[^.]+$/, "")
    for (let i = 0; i < chunks.length; i++) {
      idx.chunks.push({ id: `${docId}_${i}`, docId, title, text: chunks[i] })
    }
    const doc: KbDoc = {
      id: docId,
      title,
      source: `${folder.label} / ${shown}`,
      chars: text.length,
      chunks: chunks.length,
      addedAt: Date.now(),
      origin,
      path: p,
    }
    idx.docs.push(doc)
    res.added.push(doc)
  }

  saveKbIndex(idx)

  return res
}

/** 把用户在「文件」App 选中的文件拷进「知识库」文件夹，再走一遍普通导入。 */
export async function importKbFiles(
  paths: string[],
  onProgress?: (text: string) => void,
): Promise<KbImportResult> {
  const res: KbImportResult = { added: [], skipped: [], errors: [] }
  try {
    FileManager.createDirectorySync(KB_INBOX, true)
  } catch {
    // ignore
  }
  let staged = 0
  for (const p of paths) {
    const name = baseName(p)
    if (!name) continue
    const ext = extOf(name)
    if (TEXT_EXT.indexOf(ext) < 0 && ext !== "pdf") {
      res.skipped.push(`${name}（不支持的格式，只支持 txt/md/json/csv/log/pdf）`)
      continue
    }
    const dest = KB_INBOX + "/" + uniqueName(KB_INBOX, name)
    try {
      await FileManager.copyFile(p, dest)
      staged += 1
    } catch (e: any) {
      res.errors.push(`${name}：拷贝失败（${e?.message ?? e}）`)
    }
  }
  if (staged === 0) return res
  onProgress?.("正在导入…")
  const done = await importKbInbox(onProgress)
  res.added.push(...done.added)
  res.skipped.push(...done.skipped)
  res.errors.push(...done.errors)
  return res
}

// —— 检索（BM25） ——

function chunkTerms(c: KbChunk): Map<string, number> {
  const hit = termMemo.get(c.id)
  if (hit) return hit
  const m = new Map<string, number>()
  const tokens = tokenize(c.title + "。 " + c.text)
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  termMemo.set(c.id, m)
  return m
}

/**
 * BM25 原始分（与 idx.chunks 一一对应；含「整句原样命中」加分）。
 * 返回数组长度 = 片段数，没命中的片段是 0。
 */
function bm25Scores(idx: KbIndex, query: string): number[] {
  const q = (query ?? "").trim()
  const N = idx.chunks.length
  const scores: number[] = []
  for (let i = 0; i < N; i++) scores.push(0)
  if (!q || N === 0) return scores

  const qTerms = Array.from(new Set(tokenize(q)))
  if (qTerms.length === 0) return scores
  const terms: Array<Map<string, number>> = []
  const lens: number[] = []
  const df = new Map<string, number>()
  let total = 0

  for (const c of idx.chunks) {
    const m = chunkTerms(c)
    terms.push(m)
    let len = 0
    m.forEach((v) => {
      len += v
    })
    lens.push(len)
    total += len
    for (const t of qTerms) {
      if (m.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const avg = total / N || 1
  const low = q.toLowerCase()

  for (let i = 0; i < N; i++) {
    const m = terms[i]
    const len = lens[i] || 1
    let score = 0
    for (const t of qTerms) {
      const f = m.get(t)
      if (!f) continue
      const dfi = df.get(t) ?? 0
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5))
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / avg))
    }
    // 整句原样出现 = 强信号
    if (score > 0 && idx.chunks[i].text.toLowerCase().indexOf(low) >= 0) score += 3
    // 标题 / 文件名命中比正文命中更有价值：同一份资料的正文常常反复出现同样的词。
    if (score > 0) {
      const titleLower = idx.chunks[i].title.toLowerCase()
      let hits = 0
      for (const t of qTerms) if (titleLower.indexOf(t) >= 0) hits += 1
      if (hits > 0) score += TITLE_BOOST * (hits / qTerms.length)
    }
    scores[i] = score
  }
  return scores
}

// —— 检索结果 ——

/**
 * 关键词检索：BM25 排序（含「整句原样命中」与标题命中加分）。
 *
 * 光按分数取前 N 段的话，5 段很可能全来自同一份资料的相邻片段，上下文里全是重复文字。
 * 所以这里再补两条规则：
 *   - 同一份资料最多贡献 MAX_PER_DOC 段；
 *   - 同一份资料里紧挨着的片段直接并进已选中的那一段。
 */
export function searchKb(query: string, topK = 5): KbHit[] {
  const idx = loadKbIndex()
  const q = (query ?? "").trim()
  if (!q || idx.chunks.length === 0) return []
  const scores = bm25Scores(idx, q)

  const order: number[] = []
  for (let i = 0; i < scores.length; i++) if (scores[i] > 0) order.push(i)
  order.sort((a, b) => scores[b] - scores[a])

  const limit = Math.max(1, topK)
  const perDoc = new Map<string, number>()
  const picked: Array<{ pos: number; hit: KbHit }> = []

  for (const pos of order) {
    if (picked.length >= limit) break
    const chunk = idx.chunks[pos]

    // 相邻片段：并进已经选中的那一段，不另外占名额（也避免原文被切碎后重复）。
    let merged = false
    for (const p of picked) {
      if (idx.chunks[p.pos].docId !== chunk.docId) continue
      if (Math.abs(p.pos - pos) !== 1) continue
      if (p.hit.text.indexOf(chunk.text) < 0) p.hit.text += "\n…\n" + chunk.text
      merged = true
      break
    }
    if (merged) continue

    const used = perDoc.get(chunk.docId) ?? 0
    if (used >= MAX_PER_DOC) continue
    perDoc.set(chunk.docId, used + 1)
    picked.push({
      pos,
      hit: { title: chunk.title, text: chunk.text, score: scores[pos] },
    })
  }

  return picked.map((p) => p.hit)
}

/** 把检索结果拼成给模型看的文本。 */
export function formatKbHits(query: string, hits: KbHit[]): string {
  if (hits.length === 0) {
    return `知识库里没有找到和「${query}」相关的内容。可以告诉用户知识库里没有这份资料，不要凭空回答。`
  }
  const parts = hits.map((h, i) => `【${i + 1}】来源：${h.title}\n${h.text}`)
  return `知识库检索「${query}」命中 ${hits.length} 段：\n\n${parts.join("\n\n")}\n\n（以上是知识库原文，回答时以它为准并说明来源文件。）`
}
