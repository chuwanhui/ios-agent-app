/**
 * 表结构。
 *
 * 分两种存法，按数据的「形状」选，而不是硬套范式：
 *   - `kv`：整体替换的数据（配置、知识库索引、技能注册表、通知队列…）。它们要么很小，
 *     要么每次都是整份重建，塞进一张键值表最简单，也省得为每种数据写一套表。
 *   - 独立的表：会一条条追加、需要单独增删的数据（会话、通知记录、运行诊断、锁）。
 *
 * 会话为什么按「一个会话一行」而不是「一条消息一行」：读的时候永远是整个会话一起读
 * （聊天页、记忆压缩、通知回复都要上下文），拆成消息行只会让每次读多一次 JOIN。
 * 好处在于写入粒度——改一条消息只重写这个会话那一行，不再重写全部会话。
 */
export const SCHEMA_VERSION = 1

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (
     key        TEXT PRIMARY KEY NOT NULL,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS sessions (
     id         TEXT PRIMARY KEY NOT NULL,
     position   INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_position ON sessions (position)`,

  `CREATE TABLE IF NOT EXISTS records (
     id   TEXT PRIMARY KEY NOT NULL,
     at   INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_records_at ON records (at DESC)`,

  `CREATE TABLE IF NOT EXISTS runs (
     id   INTEGER PRIMARY KEY AUTOINCREMENT,
     at   INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_at ON runs (at DESC)`,

  `CREATE TABLE IF NOT EXISTS locks (
     name       TEXT PRIMARY KEY NOT NULL,
     owner      TEXT NOT NULL,
     until      INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
]

export async function ensureSchema(db: SQLite.Database): Promise<void> {
  for (const sql of DDL) await db.execute(sql)
  await db.execute(
    `INSERT INTO kv (key, value, updated_at) VALUES ('meta.schema', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(SCHEMA_VERSION), Date.now()],
  )
}
