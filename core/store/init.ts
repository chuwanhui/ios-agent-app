/**
 * 存储初始化：**每个入口的第一件事**。
 *
 *   App（index.tsx） / 快捷指令（intent.tsx） / 小组件（widget.tsx）都先 await initStorage()，
 *   之后所有 `loadConfig()` / `loadStore()` / `loadKbIndex()` 才能同步读到正确数据。
 *
 * 流程：准备目录（并实测能不能写）→ 迁移旧库 / 旧 JSON → 把各块数据读进内存。
 * 每一步都单独兜底：某一块坏了只影响那一块，不能让整个 App 打不开。
 */
import { DATA_DIR, KV_DIR, LOCKS_DIR, RECORDS_DIR, RUNS_DIR, SESSIONS_DIR } from "../agent/paths"
import { ensureDir, removePath } from "./files"
import { migrateFromSqlite, migrateLegacyJson } from "./migrate"
import { hydrateConfig } from "../agent/config_store"
import { hydrateSessions } from "../agent/session_store"
import { hydratePending } from "../agent/tool_callback"
import { hydrateRecords } from "../records/store"
import { hydrateRunLog } from "../diagnostics/store"
import { hydrateQueue } from "../notify/queue"
import { hydrateKb, hydrateKbFolders } from "../kb/store"
import { hydrateSkills } from "../skills/store"

let starting: Promise<void> | null = null
/** 数据目录写不进去（磁盘满 / 权限问题）：这时一切只在内存里，界面照常能用。 */
let degraded = false

export interface BootPhase {
  label: string
  ms: number
}

export interface BootReport {
  at: number
  /** 从开始准备目录到水合完成（不含脚本引擎启动）。 */
  totalMs: number
  phases: BootPhase[]
  degraded: boolean
}

/**
 * 上一次启动各阶段花了多久。
 *
 * 为什么要记：快捷指令 / 小组件每次都是**新进程**，用户体感的「慢」里有一大块是
 * 「把数据从磁盘读进内存」。不拆开看就分不清是读盘慢、还是网络/模型慢 ——
 * 诊断页把这一段列出来，一眼能看出瓶颈在哪个阶段。
 */
let lastBoot: BootReport | null = null

export function bootTimings(): BootReport | null {
  return lastBoot
}

export function storageDegraded(): boolean {
  return degraded
}

export function initStorage(): Promise<void> {
  if (!starting) starting = boot()
  return starting
}

let phaseSink: BootPhase[] = []

async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now()
  try {
    await fn()
  } catch (e: any) {
    console.log(`存储初始化失败（${label}）：` + (e?.message ?? String(e)))
  }
  phaseSink.push({ label, ms: Date.now() - t0 })
}

/**
 * 目录能不能真的写：建好目录不等于能写（可能是只读挂载 / 没空间）。
 * 写一个探针文件再删掉，是唯一可靠的办法。
 */
function prepareDirs(): void {
  for (const dir of [DATA_DIR, KV_DIR, SESSIONS_DIR, RECORDS_DIR, RUNS_DIR, LOCKS_DIR]) ensureDir(dir)
  const probe = DATA_DIR + "/.write-probe"
  FileManager.writeAsStringSync(probe, String(Date.now()))
  removePath(probe)
}

async function boot(): Promise<void> {
  const startedAt = Date.now()
  phaseSink = []
  const prepT0 = Date.now()
  try {
    prepareDirs()
  } catch (e: any) {
    degraded = true
    console.log("数据目录不可写，本次运行不会持久化：" + (e?.message ?? String(e)))
    phaseSink.push({ label: "准备目录", ms: Date.now() - prepT0 })
    lastBoot = { at: startedAt, totalMs: Date.now() - startedAt, phases: phaseSink, degraded }
    // 目录都不能写就别再往下走了：下面的读取只会拿到空数据，界面照样能开。
    return
  }
  phaseSink.push({ label: "准备目录", ms: Date.now() - prepT0 })

  await safely("旧数据库迁移", migrateFromSqlite)
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
  lastBoot = { at: startedAt, totalMs: Date.now() - startedAt, phases: phaseSink, degraded }
}
