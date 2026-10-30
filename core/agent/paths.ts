/**
 * 磁盘位置常量。所有落盘的地方都从这里取路径，别各自拼字符串。
 */
const AGENT_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
export { AGENT_DIR }
export const CONFIG_FILE = AGENT_DIR + "/config.json"
export const SESSIONS_FILE = AGENT_DIR + "/sessions.json"
/** 用户在聊天里发的图片（缩放 / 压缩后落在这里，sessions.json 只存路径）。 */
export const IMAGES_DIR = AGENT_DIR + "/images"
/** 会话工作区根目录（在「文件」App → Scripting → 工作区中可见）。 */
export const WORKSPACES_DIR =
  String(FileManager.documentsDirectory ?? "").replace(/\/+$/, "") + "/工作区"
/** 旧版单会话历史文件，仅用于迁移。 */
export const LEGACY_HISTORY_FILE = AGENT_DIR + "/history.json"

export const NEW_SESSION_TITLE = "新对话"
