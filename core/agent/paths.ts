/**
 * 磁盘位置常量。所有落盘的地方都从这里取路径，别各自拼字符串。
 *
 * 结构化数据（配置 / 聊天 / 记录 / 索引 / 队列）全部在 `agent/data/` 一个目录里，
 * 备份只需要拷这一个目录。下面那些 `LEGACY_*` 是老版本的 JSON，只在首次升级时读一次，读完就删。
 */
const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
export { AGENT_DIR }

/**
 * 所有结构化数据的根目录。
 *
 * 为什么不是一个 JSON 文件：写一半被杀会留下半截内容；也不是 SQLite：它的 API 需要
 * Scripting PRO，没解锁时整份数据都读不到。所以拆成「一个键一个文件」，每个文件都
 * 用「写临时文件 + rename」原子替换（见 core/store/files.ts）。
 */
export const DATA_DIR = AGENT_DIR + "/data"
/** 单键整块 JSON（配置、通知队列、知识库索引、技能注册表、回传待办…）。 */
export const KV_DIR = DATA_DIR + "/kv"
/** 一个会话一个文件。 */
export const SESSIONS_DIR = DATA_DIR + "/sessions"
/** 一条通知记录一个文件。 */
export const RECORDS_DIR = DATA_DIR + "/records"
/** 一条运行诊断一个文件。 */
export const RUNS_DIR = DATA_DIR + "/runs"
/** 跨进程锁：一个锁一个目录（目录本身是锁）。 */
export const LOCKS_DIR = DATA_DIR + "/locks"

/** 老版本的数据库文件，只在升级时读一次，迁移完就删。 */
export const DB_FILE = AGENT_DIR + "/agent.sqlite"

/** 用户在聊天里发的图片（缩放 / 压缩后落在这里，会话数据里只存路径）。 */
export const IMAGES_DIR = AGENT_DIR + "/images"

/** 会话工作区根目录（在「文件」App → Scripting → 工作区中可见）。 */
export const WORKSPACES_DIR =
  String(FileManager.documentsDirectory ?? "").replace(/\/+$/, "") + "/工作区"

export const NEW_SESSION_TITLE = "新对话"

// ———————————————————————— 老版本 JSON（仅迁移用） ————————————————————————

export const LEGACY_CONFIG_FILE = AGENT_DIR + "/config.json"
export const LEGACY_SESSIONS_FILE = AGENT_DIR + "/sessions.json"
/** 更老的单会话历史文件。 */
export const LEGACY_HISTORY_FILE = AGENT_DIR + "/history.json"
export const LEGACY_RECORDS_FILE = AGENT_DIR + "/message_records.json"
export const LEGACY_RUNS_FILE = AGENT_DIR + "/diagnostics.json"
export const LEGACY_QUEUE_FILE = AGENT_DIR + "/notify_queue.json"
export const LEGACY_QUEUE_LOCK_FILE = AGENT_DIR + "/notify_queue.lock.json"
export const LEGACY_PENDING_FILE = AGENT_DIR + "/pending.json"
export const LEGACY_KB_INDEX_FILE = AGENT_DIR + "/kb/index.json"
export const LEGACY_KB_FOLDERS_FILE = AGENT_DIR + "/kb/folders.json"
export const LEGACY_SKILLS_FILE = AGENT_DIR + "/skills.json"
