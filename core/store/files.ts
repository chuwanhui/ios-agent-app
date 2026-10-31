/**
 * 文件层的三件小工具：建目录、原子写、读 JSON。
 *
 * **为什么一定要原子写**：直接 `writeAsStringSync` 到目标文件，写到一半进程被杀
 * （快捷指令超时、App 被系统回收）就会留下半截 JSON，下次读它就是坏数据。
 * 这里的做法是先写 `x.json.tmp`，写完之后 `rename` 成 `x.json` —— 同一卷上的
 * rename 是原子的，读的人要么看到旧内容，要么看到完整的新内容，不会看到中间态。
 */

/** 建目录（已存在不报错）。 */
export function ensureDir(path: string): void {
  if (!path) return
  try {
    FileManager.createDirectorySync(path, true)
  } catch {
    // 建不出来就让后面的写操作自己失败，这里不吞错
  }
}

/**
 * 把一个值写成 JSON 文件（原子替换）。
 * 序列化失败（循环引用）会抛错，调用方自己决定怎么记日志。
 */
export function writeJsonAtomic(path: string, value: any): void {
  ensureDir(dirOf(path))
  const text = JSON.stringify(value)
  const tmp = path + ".tmp"
  FileManager.writeAsStringSync(tmp, text)
  try {
    FileManager.renameSync(tmp, path)
  } catch (e) {
    // 极少数文件系统上 rename 覆盖已存在的文件会失败：删掉再改名，仍然是原子的（有极短空窗）
    try {
      if (FileManager.existsSync(path)) FileManager.removeSync(path)
      FileManager.renameSync(tmp, path)
    } catch {
      throw e
    }
  }
}

/** 读 JSON 文件；不存在 / 解析失败都返回 null（坏文件不该让整个页面打不开）。 */
export function readJsonFile<T = any>(path: string): T | null {
  try {
    if (!FileManager.existsSync(path)) return null
    const text = FileManager.readAsStringSync(path)
    if (!text) return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** 读文本文件；读不到返回 null。 */
export function readTextFile(path: string): string | null {
  try {
    if (!FileManager.existsSync(path)) return null
    return FileManager.readAsStringSync(path)
  } catch {
    return null
  }
}

/** 取所在目录（只处理 `/` 分隔，够用）。 */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i > 0 ? path.slice(0, i) : ""
}

/** 列目录下所有 `.json` 文件（返回完整路径）。目录不存在返回空数组。 */
export function listJsonFiles(dir: string): string[] {
  let names: string[] = []
  try {
    if (!FileManager.existsSync(dir)) return []
    names = FileManager.readDirectorySync(dir)
  } catch {
    return []
  }
  const base = dir.replace(/\/+$/, "")
  return names
    .filter((n) => n && !n.endsWith(".tmp"))
    .map((n) => (n.startsWith("/") || n.indexOf("/") >= 0 ? n : base + "/" + n))
    .filter((p) => p.endsWith(".json"))
}

/** 删文件 / 目录；删不掉就算了。 */
export function removePath(path: string): void {
  try {
    if (path && FileManager.existsSync(path)) FileManager.removeSync(path)
  } catch {
    // 删不掉就留着，下次启动再试
  }
}

/** 目录总大小（递归，单位字节）。拿不到的部分按 0 算。 */
export function dirSize(dir: string): number {
  let total = 0
  let names: string[] = []
  try {
    if (!FileManager.existsSync(dir)) return 0
    names = FileManager.readDirectorySync(dir)
  } catch {
    return 0
  }
  const base = dir.replace(/\/+$/, "")
  for (const name of names) {
    const path = name.startsWith("/") || name.indexOf("/") >= 0 ? name : base + "/" + name
    try {
      const stat = FileManager.statSync(path)
      if (stat.type === "directory") total += dirSize(path)
      else total += Number(stat.size) || 0
    } catch {
      // 拿不到大小就当 0
    }
  }
  return total
}

/**
 * 文件名安全化：encodeURIComponent 之后只剩 `A-Za-z0-9-_.!~*'()` 和 `%`，
 * 没有 `/`，也不会出现 `.` / `..` 这种会逃出目录的名字。
 */
export function safeName(raw: string): string {
  const s = encodeURIComponent(String(raw ?? "")).replace(/^\.+/, "_")
  return s || "_"
}
