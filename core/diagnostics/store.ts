import { clearItems, deleteItem, listItems, writeItem } from "../store/store"

/**
 * 运行诊断：每跑一轮（聊天 / 通知 / 回传续跑 / 记忆压缩）就在本地记一条。
 *
 * 只记「结构化的数字」——耗时、轮次、工具数、token、错误摘要，不记正文，
 * 所以没有隐私风险，也不会把磁盘撑大（只留最近 MAX_ENTRIES 条）。
 * 用途：出问题时回答「是哪一步慢 / 花了多少 token / 哪个工具总失败」。
 */

export type RunSource = "chat" | "notify" | "callback" | "compress" | "other"

export interface RunLogEntry {
  /** 这次运行结束的时间。 */
  at: number
  source: RunSource
  /** 是否正常跑完（用户中止也算跑完）。 */
  ok: boolean
  /** 总耗时（毫秒）。 */
  ms: number
  /** 模型往返了几次（含工具轮）。 */
  rounds: number
  /** 工具调用次数。 */
  tools: number
  /** 其中失败了几次。 */
  failedTools: number
  /** 是否被用户中止。 */
  aborted?: boolean
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  /** 用的哪个模型（换模型后对比耗时用）。 */
  model?: string
  /** 出错时的第一行摘要。 */
  error?: string
}

/** 只留最近这么多条：诊断是给「刚刚出了什么事」用的，不做长期留存。 */
const MAX_ENTRIES = 120
/** 错误摘要的长度上限。 */
const ERROR_CLIP = 200

/** 内存副本（启动时由 hydrateRunLog 填好），按时间倒序。 */
let cache: RunLogEntry[] | null = null

/**
 * 一条诊断在磁盘上的文件名。
 *
 * 条目本身没有 id（它是「一次运行」，天然由时间戳区分），所以文件名用
 * 「时间 + 来源 + 耗时」拼一个稳定的串：既够唯一，又能在裁剪时算出该删哪个。
 */
export function runIdOf(entry: RunLogEntry): string {
  return `run-${Number(entry.at) || 0}-${entry.source || "other"}-${Number(entry.ms) || 0}`
}

export async function hydrateRunLog(): Promise<void> {
  const list: RunLogEntry[] = []
  for (const entry of listItems<RunLogEntry>("runs")) {
    if (entry && typeof entry.at === "number") list.push(entry)
  }
  list.sort((a, b) => b.at - a.at)
  cache = list.slice(0, MAX_ENTRIES)
}

export function loadRunLog(): RunLogEntry[] {
  return (cache ?? []).slice()
}

/** 记一条。永远不抛错：诊断写失败不能影响正常对话。 */
export function logRun(entry: RunLogEntry): void {
  const prev = cache ?? []
  cache = [entry, ...prev].slice(0, MAX_ENTRIES)
  try {
    writeItem("runs", runIdOf(entry), entry)
    for (const dropped of prev.slice(MAX_ENTRIES - 1)) deleteItem("runs", runIdOf(dropped))
  } catch {
    // 写不进去就算了：诊断失败不能影响正常对话
  }
}

export function clearRunLog(): void {
  cache = []
  clearItems("runs")
}

/** 错误信息压成一行，避免把整段堆栈写进诊断文件。 */
export function clipError(e: any): string {
  const msg = String(e?.message ?? e ?? "").replace(/\s+/g, " ").trim()
  return msg.length > ERROR_CLIP ? msg.slice(0, ERROR_CLIP) + "…" : msg
}

export interface RunLogStats {
  total: number
  okRate: number
  /** 平均耗时（毫秒）。 */
  avgMs: number
  /** 最慢一次（毫秒）。 */
  maxMs: number
  /** 工具调用总数 / 失败总数。 */
  tools: number
  failedTools: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** 错误次数（按 error 去重后的前几条）。 */
  topErrors: Array<{ message: string; count: number }>
}

/** 汇总一段日志（默认全部）。 */
export function runLogStats(entries: RunLogEntry[]): RunLogStats {
  const total = entries.length
  let ok = 0
  let sumMs = 0
  let maxMs = 0
  let tools = 0
  let failedTools = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  const errors = new Map<string, number>()

  for (const e of entries) {
    if (e.ok) ok += 1
    sumMs += Number(e.ms) || 0
    maxMs = Math.max(maxMs, Number(e.ms) || 0)
    tools += Number(e.tools) || 0
    failedTools += Number(e.failedTools) || 0
    inputTokens += Number(e.inputTokens) || 0
    outputTokens += Number(e.outputTokens) || 0
    cachedInputTokens += Number(e.cachedInputTokens) || 0
    if (e.error) errors.set(e.error, (errors.get(e.error) ?? 0) + 1)
  }

  const topErrors = Array.from(errors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([message, count]) => ({ message, count }))

  return {
    total,
    okRate: total > 0 ? ok / total : 0,
    avgMs: total > 0 ? Math.round(sumMs / total) : 0,
    maxMs,
    tools,
    failedTools,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    topErrors,
  }
}
