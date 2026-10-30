/**
 * 本地数据库：`<AppGroup>/agent/agent.sqlite`（WAL 模式）。
 *
 * 为什么是 SQLite 而不是一堆 JSON：
 *   - 一个文件装全部状态，备份 / 迁移只拷这一个文件；
 *   - 写入是事务，不会再出现「写一半被杀留下半截 JSON」（.tmp / .bak 那套可以退休）；
 *   - 改一条数据只重写它自己那一行，不再整文件重写。
 *
 * 读为什么还是同步的：SQLite 的接口全是 Promise，而界面里 35 处 `loadConfig()`
 * 是同步调用的（Widget 甚至没有 await 的位置）。所以数据在启动时被「水合」进内存，
 * 读一律走内存（同步、零开销），写则先改内存、再落库（返回 Promise，调用方按需 await）。
 * 内存里的东西和库里一致，不存在两份真相。
 *
 * 唯一的例外是「锁」：它必须跨进程可见，所以永远直接读写库，不走内存。
 */
import { AGENT_DIR, DB_FILE } from "../agent/paths"

/** 打开参数：WAL 让读写不打架；busyMode 给 5 秒，抢不到锁时重试而不是立刻报错。 */
const DB_CONFIG: SQLite.Configuration = {
  foreignKeysEnabled: true,
  readonly: false,
  label: "agent",
  busyMode: 5,
  journalMode: "wal",
  maximumReaderCount: 4,
}

let db: SQLite.Database | null = null
let opening: Promise<SQLite.Database> | null = null

export function dbPath(): string {
  return DB_FILE
}

export function openAgentDb(): Promise<SQLite.Database> {
  if (db) return Promise.resolve(db)
  if (opening) return opening
  opening = (async () => {
    FileManager.createDirectorySync(AGENT_DIR, true)
    const opened = SQLite.open(DB_FILE, DB_CONFIG)
    // 外键 + WAL 都是开库后确认一次；对已存在的库也生效。
    await opened.execute("PRAGMA journal_mode = WAL")
    await opened.execute("PRAGMA foreign_keys = ON")
    db = opened
    return opened
  })()
  return opening
}

// ———————————————————————— 基础执行 ————————————————————————

export async function exec(sql: string, args?: SQLite.Arguments): Promise<void> {
  const d = await openAgentDb()
  await d.execute(sql, args)
}

export async function all<T = any>(sql: string, args?: SQLite.Arguments): Promise<T[]> {
  const d = await openAgentDb()
  const rows = await d.fetchAll<T>(sql, args)
  return Array.isArray(rows) ? rows : []
}

/** 取第一行；没有就返回 null。 */
export async function first<T = any>(sql: string, args?: SQLite.Arguments): Promise<T | null> {
  const d = await openAgentDb()
  const row = await d.fetchOne<T>(sql, args)
  return (row ?? null) as T | null
}

export async function tx(steps: SQLite.TransactionStep[]): Promise<void> {
  if (steps.length === 0) return
  const d = await openAgentDb()
  await d.transaction(steps, { kind: "immediate" })
}

// ———————————————————————— 键值表（配置 / 索引这类整体替换的数据） ————————————————————————

export async function kvText(key: string): Promise<string | null> {
  const row = await first<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key])
  return row?.value ?? null
}

export async function kvJson<T = any>(key: string): Promise<T | null> {
  const text = await kvText(key)
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function kvWrite(key: string, value: string): Promise<void> {
  await exec(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  )
}

export async function kvWriteJson(key: string, value: any): Promise<void> {
  await kvWrite(key, JSON.stringify(value ?? null))
}

/** 拼一个「写入键值」的事务步骤（要和别的写操作一起提交时用）。 */
export function kvStep(key: string, value: string): SQLite.TransactionStep {
  return {
    sql: `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, Date.now()],
  }
}

// ———————————————————————— 跨进程锁 ————————————————————————

/**
 * 抢锁：三步放进一个事务里，所以两个消费者同时抢只有一个能拿到。
 * 过期的锁（持锁进程被杀）会被顺手清掉。
 */
export async function acquireLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const now = Date.now()
  await tx([
    { sql: "DELETE FROM locks WHERE name = ? AND until <= ?", args: [name, now] },
    {
      sql: `INSERT INTO locks (name, owner, until, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO NOTHING`,
      args: [name, owner, now + Math.max(1000, ttlMs), now],
    },
  ])
  const row = await first<{ owner: string }>("SELECT owner FROM locks WHERE name = ?", [name])
  return String(row?.owner ?? "") === owner
}

/** 续期：只有持锁人才能续。返回是否续上。 */
export async function refreshLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const now = Date.now()
  await exec("UPDATE locks SET until = ?, updated_at = ? WHERE name = ? AND owner = ?", [
    now + Math.max(1000, ttlMs), now, name, owner,
  ])
  const row = await first<{ owner: string }>("SELECT owner FROM locks WHERE name = ?", [name])
  return String(row?.owner ?? "") === owner
}

export async function releaseLock(name: string, owner: string): Promise<void> {
  await exec("DELETE FROM locks WHERE name = ? AND owner = ?", [name, owner])
}

// ———————————————————————— 维护 ————————————————————————

/** 库里所有数据的体量（设置页「诊断」用）。 */
export async function dbStats(): Promise<{ bytes: number; sessions: number; records: number; runs: number }> {
  let bytes = 0
  try {
    for (const p of [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"]) {
      if (FileManager.existsSync(p)) bytes += FileManager.statSync(p).size || 0
    }
  } catch {
    // 拿不到大小就当 0
  }
  const count = async (sql: string): Promise<number> => {
    const row = await first<{ n: number }>(sql)
    return Number(row?.n) || 0
  }
  return {
    bytes,
    sessions: await count("SELECT COUNT(*) AS n FROM sessions"),
    records: await count("SELECT COUNT(*) AS n FROM records"),
    runs: await count("SELECT COUNT(*) AS n FROM runs"),
  }
}

/** 把库压回一个干净文件（VACUUM 不能放进事务）。 */
export async function compactDb(): Promise<void> {
  await exec("VACUUM")
}
