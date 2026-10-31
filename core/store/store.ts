/**
 * 本地存储：`<AppGroup>/agent/data/` 下的一组文件。
 *
 * ## 为什么不是 SQLite
 *
 * 这个运行时里 `SQLite` 相关 API 需要 Scripting PRO。没解锁时 `SQLite.open` 直接抛错，
 * 整份数据（配置、聊天记录、索引）全部读不到 —— 快捷指令那条链路尤其明显：进程一起来
 * 就是「请先填 API Key」，因为配置根本没读出来。
 *
 * ## 为什么是「一个键一个文件」而不是一个大 JSON
 *
 *   - 写一半被杀不会留下半截内容：每个文件都是 `x.json.tmp` 写完再 `rename` 原子替换；
 *   - 改一条只重写它自己那一个文件，不是整份重写（会话多的时候差别很大）；
 *   - 坏一个文件只丢那一条，不会带着整个库一起打不开。
 *
 * ## 读写模型没变
 *
 * 读仍然是同步的（界面里 30 多处 `loadConfig()`，Widget 里连 `await` 的位置都没有）：
 * 启动时 `initStorage()` 把文件读进内存，之后读走内存。写则先改内存，再同步落盘 ——
 * 文件写入是同步 API，落盘发生在函数返回前，所以快捷指令进程退出也不会丢最后一次写。
 *
 * 唯一的例外是「锁」：它必须跨进程可见，所以永远直接读文件，不走内存。
 */
import {
  DATA_DIR, KV_DIR, LOCKS_DIR, RECORDS_DIR, RUNS_DIR, SESSIONS_DIR,
} from "../agent/paths"
import {
  dirSize, ensureDir, listJsonFiles, readJsonFile, readTextFile, removePath, safeName, writeJsonAtomic,
} from "./files"

export function dataPath(): string {
  return DATA_DIR
}

// ———————————————————————— 键值（整体替换的数据） ————————————————————————

function kvFile(key: string): string {
  return KV_DIR + "/" + safeName(key) + ".json"
}

/** 读一段原始文本（我们一直用 kvWriteJson 存，所以内容是 JSON）。 */
export function kvText(key: string): string | null {
  return readTextFile(kvFile(key))
}

export function kvJson<T = any>(key: string): T | null {
  return readJsonFile<T>(kvFile(key))
}

/**
 * 最近一次落盘失败。
 *
 * 为什么要记：写盘抛错原来只 console.log，用户完全看不见 —— 于是出现最难查的一类毛病：
 * 设置页改完了、聊天也能用（内存是对的），可快捷指令 / URL 冷启动是新进程、只读磁盘，
 * 那份还是旧的，于是一条入口正常、另一条报「余额不足」之类莫名其妙的错。
 */
let lastWriteError: { key: string; at: number; detail: string } | null = null

export function storageWriteError(): { key: string; at: number; detail: string } | null {
  return lastWriteError
}

export function kvWrite(key: string, value: string): void {
  ensureDir(KV_DIR)
  try {
    const path = kvFile(key)
    const tmp = path + ".tmp"
    FileManager.writeAsStringSync(tmp, value)
    FileManager.renameSync(tmp, path)
    // 写完读回来对一遍：磁盘满 / 只读挂载这类问题，写入 API 不一定抛错。
    const back = readTextFile(path)
    if (back !== value) {
      lastWriteError = { key, at: Date.now(), detail: "写完读回来不一致（可能是空间不足）" }
      console.log(`保存 ${key} 后校验不一致`)
      return
    }
    lastWriteError = null
  } catch (e: any) {
    const detail = e?.message ?? String(e)
    lastWriteError = { key, at: Date.now(), detail }
    console.log(`保存 ${key} 失败：` + detail)
  }
}

export function kvWriteJson(key: string, value: any): void {
  kvWrite(key, JSON.stringify(value ?? null))
}

// ———————————————————————— 集合（一条一个文件） ————————————————————————

/** 会一条条增删的数据：每个集合一个目录，每条一个文件。 */
export type Collection = "sessions" | "records" | "runs"

const COLLECTION_DIRS: Record<Collection, string> = {
  sessions: SESSIONS_DIR,
  records: RECORDS_DIR,
  runs: RUNS_DIR,
}

function collectionDir(coll: Collection): string {
  return COLLECTION_DIRS[coll]
}

function itemFile(coll: Collection, id: string): string {
  return collectionDir(coll) + "/" + safeName(id) + ".json"
}

/** 读一个集合的全部条目（顺序按文件名；要排序请调用方自己排）。坏文件跳过。 */
export function listItems<T = any>(coll: Collection): T[] {
  const dir = collectionDir(coll)
  const out: T[] = []
  for (const path of listJsonFiles(dir)) {
    const parsed = readJsonFile<T>(path)
    if (parsed != null) out.push(parsed)
  }
  return out
}

/** 写一条（原子替换）。落盘在函数返回前完成。 */
export function writeItem(coll: Collection, id: string, value: any): void {
  const dir = collectionDir(coll)
  ensureDir(dir)
  writeJsonAtomic(itemFile(coll, id), value)
}

/** 写一条，但已存在就跳过（迁移老数据时用，等价于 SQL 的 ON CONFLICT DO NOTHING）。 */
export function writeItemIfAbsent(coll: Collection, id: string, value: any): boolean {
  if (FileManager.existsSync(itemFile(coll, id))) return false
  writeItem(coll, id, value)
  return true
}

export function deleteItem(coll: Collection, id: string): void {
  removePath(itemFile(coll, id))
}

/** 清空一个集合（删目录再建，比逐个删快）。 */
export function clearItems(coll: Collection): void {
  const dir = collectionDir(coll)
  removePath(dir)
  ensureDir(dir)
}

export function countItems(coll: Collection): number {
  return listJsonFiles(collectionDir(coll)).length
}

// ———————————————————————— 跨进程锁 ————————————————————————
//
// 目录本身就是锁：`createDirectorySync(dir, false)` 在目录已存在时会抛错，
// 这是一个原子的「测试并占用」。持锁人往目录里写 lease.json 记 owner + 到期时间，
// 心跳就是重写这个文件；进程被杀导致锁没过期就没了主人时，到期后会被下一个抢锁的人清掉。

const LEASE_FILE = "lease.json"
/** 锁目录建好了但 lease 还没写进去的宽限：超过这么久就当成废弃物。 */
const NO_LEASE_GRACE_MS = 5000

interface Lease {
  owner: string
  until: number
}

function lockDir(name: string): string {
  return LOCKS_DIR + "/" + safeName(name)
}

function readLease(dir: string): Lease | null {
  const lease = readJsonFile<Lease>(dir + "/" + LEASE_FILE)
  if (!lease || typeof lease.owner !== "string") return null
  return { owner: lease.owner, until: Number(lease.until) || 0 }
}

function writeLease(dir: string, owner: string, until: number): void {
  writeJsonAtomic(dir + "/" + LEASE_FILE, { owner, until })
}

/** 目录存在多久了（毫秒）。拿不到 mtime 就返回 Infinity（当成很老的废弃物）。 */
function dirAgeMs(dir: string): number {
  try {
    const stat = FileManager.statSync(dir)
    const raw = Number(stat.modificationDate) || 0
    const ms = raw > 1e12 ? raw : raw * 1000
    if (!ms) return Infinity
    return Math.max(0, Date.now() - ms)
  } catch {
    return Infinity
  }
}

/** 抢锁：抢到 true，被别人占着 false。不抛错。 */
export async function acquireLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const dir = lockDir(name)
  const ttl = Math.max(1000, Number(ttlMs) || 0)
  try {
    ensureDir(LOCKS_DIR)
  } catch {
    return false
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 目录已存在会抛错 —— 这就是原子的「占位」。
      FileManager.createDirectorySync(dir, false)
      writeLease(dir, owner, Date.now() + ttl)
      return true
    } catch {
      // 已被占：看一眼是不是过期了
    }
    const lease = readLease(dir)
    const now = Date.now()
    if (lease && lease.owner === owner) {
      // 自己已经持有（重复抢锁）：直接续期
      writeLease(dir, owner, now + ttl)
      return true
    }
    const stale = lease ? lease.until <= now : dirAgeMs(dir) >= NO_LEASE_GRACE_MS
    if (!stale) return false
    // 过期 / 废弃物：清掉再试一次
    removePath(dir + "/" + LEASE_FILE)
    removePath(dir)
  }
  return false
}

/** 续期：只有持锁人才能续。返回是否还持有。 */
export async function refreshLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const dir = lockDir(name)
  try {
    const lease = readLease(dir)
    if (!lease || lease.owner !== owner) return false
    writeLease(dir, owner, Date.now() + Math.max(1000, Number(ttlMs) || 0))
    return true
  } catch {
    return false
  }
}

/** 释放：只有持锁人能删，别人的锁不会被动到。 */
export async function releaseLock(name: string, owner: string): Promise<void> {
  const dir = lockDir(name)
  try {
    const lease = readLease(dir)
    if (lease && lease.owner !== owner) return
    removePath(dir + "/" + LEASE_FILE)
    removePath(dir)
  } catch {
    // ignore
  }
}

// ———————————————————————— 维护 ————————————————————————

export interface StoreStats {
  /** 数据目录总大小（字节）。 */
  bytes: number
  sessions: number
  records: number
  runs: number
  /** 残留的 .tmp 文件数（写一半被打断留下的）。 */
  tempFiles: number
}

export async function storeStats(): Promise<StoreStats> {
  return {
    bytes: dirSize(DATA_DIR),
    sessions: countItems("sessions"),
    records: countItems("records"),
    runs: countItems("runs"),
    tempFiles: countTempFiles(DATA_DIR),
  }
}

function countTempFiles(dir: string): number {
  let n = 0
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
      if (stat.type === "directory") n += countTempFiles(path)
      else if (path.endsWith(".tmp")) n += 1
    } catch {
      // ignore
    }
  }
  return n
}

/**
 * 整理数据目录：删掉写一半被打断留下的 `.tmp`，以及过期的锁目录。
 * 不是 VACUUM —— 文件系统本来就没有「空洞」要回收，这里只是清扫垃圾。
 * 返回清掉的条目数。
 */
export async function compactStore(): Promise<number> {
  let removed = 0
  for (const dir of [KV_DIR, SESSIONS_DIR, RECORDS_DIR, RUNS_DIR, LOCKS_DIR]) {
    let names: string[] = []
    try {
      if (!FileManager.existsSync(dir)) continue
      names = FileManager.readDirectorySync(dir)
    } catch {
      continue
    }
    const base = dir.replace(/\/+$/, "")
    for (const name of names) {
      const path = name.startsWith("/") || name.indexOf("/") >= 0 ? name : base + "/" + name
      if (path.endsWith(".tmp")) {
        removePath(path)
        removed += 1
      }
    }
  }
  // 过期的锁目录
  try {
    if (FileManager.existsSync(LOCKS_DIR)) {
      for (const name of FileManager.readDirectorySync(LOCKS_DIR)) {
        const dir = name.startsWith("/") || name.indexOf("/") >= 0 ? name : LOCKS_DIR + "/" + name
        const lease = readLease(dir)
        const stale = lease ? lease.until <= Date.now() : dirAgeMs(dir) >= NO_LEASE_GRACE_MS
        if (!stale) continue
        removePath(dir + "/" + LEASE_FILE)
        removePath(dir)
        removed += 1
      }
    }
  } catch {
    // ignore
  }
  return removed
}
