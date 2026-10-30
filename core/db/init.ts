/**
 * 存储初始化：**每个入口的第一件事**。
 *
 *   App（index.tsx） / 快捷指令（intent.tsx） / 小组件（widget.tsx）都先 await initStorage()，
 *   之后所有 `loadConfig()` / `loadStore()` / `loadKbIndex()` 才能同步读到正确数据。
 *
 * 流程：开库 → 建表 → 迁移老 JSON → 把各块数据水合进内存。
 * 每一步都单独兜底：某一块坏了只影响那一块，不能让整个 App 打不开。
 */
import { openAgentDb } from "./db"
import { ensureSchema } from "./schema"
import { migrateLegacyJson } from "./migrate"
import { hydrateConfig } from "../agent/config_store"
import { hydrateSessions } from "../agent/session_store"
import { hydratePending } from "../agent/tool_callback"
import { hydrateRecords } from "../records/store"
import { hydrateRunLog } from "../diagnostics/store"
import { hydrateQueue } from "../notify/queue"
import { hydrateKb, hydrateKbFolders } from "../kb/store"
import { hydrateSkills } from "../skills/store"

let starting: Promise<void> | null = null
/** 库整体没打开（磁盘满 / 权限问题）：这时一切只在内存里，界面照常能用。 */
let degraded = false

export function storageDegraded(): boolean {
  return degraded
}

export function initStorage(): Promise<void> {
  if (!starting) starting = boot()
  return starting
}

async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e: any) {
    console.log(`存储初始化失败（${label}）：` + (e?.message ?? String(e)))
  }
}

async function boot(): Promise<void> {
  try {
    const db = await openAgentDb()
    await ensureSchema(db)
  } catch (e: any) {
    degraded = true
    console.log("打开数据库失败，本次运行不会持久化：" + (e?.message ?? String(e)))
    // 库开不了也别卡住启动：下面的水合都会失败，各模块自动退回默认值。
    return
  }

  await safely("迁移老数据", migrateLegacyJson)
  await safely("配置", hydrateConfig)
  await safely("会话", hydrateSessions)
  await safely("通知记录", hydrateRecords)
  await safely("运行诊断", hydrateRunLog)
  await safely("通知队列", hydrateQueue)
  await safely("回传待办", hydratePending)
  await safely("知识库", hydrateKb)
  await safely("知识库文件夹", hydrateKbFolders)
  await safely("技能", hydrateSkills)
}
