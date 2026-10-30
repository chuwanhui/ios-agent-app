/**
 * 能力层共用的路径与文本工具：
 *   - 所有文件 / 命令 / 脚本都只能待在「当前会话工作区」里，越界一律拒绝；
 *   - 输出统一截断，别让一次调用把上下文撑爆。
 */
import { WORKSPACES_DIR } from "../store"

export function trimSlash(p: string): string {
  return String(p ?? "").replace(/\/+$/, "")
}

/** 助手干活的默认目录（在「文件」App → Scripting 里能看到，用户可以直接拖文件进去）。 */
export const WORKSPACE_DIR = WORKSPACES_DIR

/** 允许助手触碰的两个根目录。 */
export const ROOTS = [
  trimSlash(FileManager.documentsDirectory),
  trimSlash(FileManager.appGroupDocumentsDirectory),
].filter((p) => !!p)

/** 命令 / 脚本的超时（秒）。 */
export const CLI_DEFAULT_TIMEOUT = 30
export const CLI_MAX_TIMEOUT = 120
/** 返回给模型的输出上限（字符）。 */
export const OUT_CLIP = 8000
/** 一次读文件的上限（字符）。 */
export const READ_CLIP = 20000
/** 列目录最多列多少条。 */
export const LIST_MAX = 300

// ———————————————————————— 路径 ————————————————————————

/** 折叠 `.` 与 `..`，得到规范化的绝对路径。 */
export function foldPath(input: string): string {
  const segs: string[] = []
  for (const seg of input.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      segs.pop()
      continue
    }
    segs.push(seg)
  }
  return "/" + segs.join("/")
}

/** 文件与 CLI 能力只能访问当前会话工作区，不能用相对或绝对路径越界。 */
export function resolveWorkspacePath(raw: any, workspaceDir: string): string | null {
  const text = String(raw ?? "").trim()
  if (text.indexOf("\u0000") >= 0) return null
  const abs = foldPath(text.startsWith("/") ? text : workspaceDir + "/" + text)
  return abs === workspaceDir || abs.startsWith(workspaceDir + "/") ? abs : null
}

/** 展示用的短路径（在工作区里的显示相对路径，方便模型接着用小路径干活）。 */
export function displayPath(abs: string): string {
  const roots = [WORKSPACE_DIR].concat(ROOTS)
  for (const root of roots) {
    if (abs === root) return "/"
    if (abs.startsWith(root + "/")) return abs.slice(root.length + 1)
  }
  return abs
}

export function displayWorkspacePath(abs: string, workspaceDir: string): string {
  if (abs === workspaceDir) return "/"
  if (abs.startsWith(workspaceDir + "/")) return abs.slice(workspaceDir.length + 1)
  return abs
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

export function ensureDir(dir: string): void {
  try {
    FileManager.createDirectorySync(dir, true)
  } catch {
    // ignore
  }
}

export function sizeText(path: string): string {
  try {
    const st = FileManager.statSync(path)
    return humanSize(st?.size ?? 0)
  } catch {
    return "?"
  }
}

export function humanSize(n: number): string {
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
  return (n / 1024 / 1024).toFixed(1) + " MB"
}

export function clip(text: string, max = OUT_CLIP): string {
  const s = text ?? ""
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…（输出太长，已截断，共 ${s.length} 字）`
}

export function clampInt(raw: any, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw))
  if (!isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, n))
}
