/**
 * 配置的读 / 写 / 迁移。
 *
 * 配置在 `agent/data/kv/config.json`。读走内存（启动时水合），
 * 写先改内存再落库。密钥不进库也不进文件，只进 Keychain，库里存的是脱敏版本。
 */
import { AgentConfig } from "./types"
import { DEFAULT_CONFIG } from "./defaults"
import { DEFAULT_PERSONA } from "./prompts"
import { keychainGet, keychainSet } from "./keychain"
import {
  clearFlatModelFields, mergeConfigPatch, syncActiveProvider, withLegacyProvider,
} from "./provider"
import { kvJson, kvWriteJson } from "../store/store"

const KV_KEY = "config"

/** 配置的内存副本（启动时由 hydrateConfig 填好）。 */
let cache: AgentConfig | null = null

/**
 * 配置变化的订阅者。
 *
 * 为什么需要：配置是「一个进程一份内存缓存」，但同进程里多个页面各自 useState 存了
 * 一份快照。设置页改了头像 / 名字，聊天页那份快照就是旧的，看起来像「没保存」。
 * 谁改了配置，就通过这里通知所有还活着的页面重新 loadConfig()。
 */
const listeners = new Set<() => void>()

/** 订阅配置变化，返回取消订阅的函数。 */
export function subscribeConfig(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function notifyConfigChanged(): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb()
    } catch (e: any) {
      console.log("配置订阅回调失败：" + (e?.message ?? String(e)))
    }
  }
}

/** 从 Keychain 注入密钥，并兼容迁移旧版配置里的明文密钥。 */
function hydrateSecrets(cfg: AgentConfig): AgentConfig {
  return {
    ...cfg,
    providers: (cfg.providers ?? []).map((p) => ({
      ...p,
      apiKey: keychainGet("provider/" + p.id, p.apiKey ?? ""),
    })),
    mcpServers: (cfg.mcpServers ?? []).map((s) => ({
      ...s,
      token: keychainGet("mcp/" + s.id, s.token ?? ""),
    })),
    gitToken: keychainGet("git", cfg.gitToken ?? ""),
  }
}

/** 上一次保存时的供应商 id：用来认出「哪些已经被删了」，顺手清掉它们的 Key。 */
let lastProviderIds: string[] = []

/** 先写 Keychain，再返回可安全落库的脱敏对象。 */
function redactSecrets(cfg: AgentConfig): AgentConfig {
  const ids = (cfg.providers ?? []).map((p) => p.id)
  for (const id of lastProviderIds) {
    // 删掉的供应商不该把 Key 留在钥匙串里（以后同 id 复活也不会突然「有 Key」）。
    if (ids.indexOf(id) < 0) keychainSet("provider/" + id, "")
  }
  lastProviderIds = ids
  for (const p of cfg.providers ?? []) keychainSet("provider/" + p.id, p.apiKey)
  for (const s of cfg.mcpServers ?? []) keychainSet("mcp/" + s.id, s.token)
  // 语义检索功能已下线：顺手把遗留的向量服务密钥从 Keychain 清掉。
  keychainSet("embed", "")
  keychainSet("git", cfg.gitToken)
  return {
    ...cfg,
    apiKey: "",
    gitToken: "",
    providers: (cfg.providers ?? []).map((p) => ({ ...p, apiKey: "" })),
    mcpServers: (cfg.mcpServers ?? []).map((s) => ({ ...s, token: "" })),
  }
}

function withDefaults(cfg: AgentConfig): AgentConfig {
  return syncActiveProvider(hydrateSecrets(withLegacyProvider(cfg)))
}

/** 出厂配置（还没有库 / 库还没水合时用）。 */
function factoryConfig(): AgentConfig {
  return withDefaults({ ...DEFAULT_CONFIG })
}

/**
 * 启动时把配置从库里装进内存，并就地升级老字段：
 *   - 已下线的向量服务字段直接丢掉（别把明文密钥留在盘上）；
 *   - 老的 systemPrompt 并进 persona（提示词只有「性格与角色」一处）。
 */
export async function hydrateConfig(): Promise<void> {
  let parsed: any = null
  try {
    parsed = kvJson<Record<string, any>>(KV_KEY)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== "object") {
    cache = factoryConfig()
    return
  }

  let merged: any = { ...DEFAULT_CONFIG, ...parsed }
  let changed = false

  // 盘上明确写着「一家供应商都没有」= 用户自己删光过。这时扁平字段里残留的上一家
  // 不能再被当成「老配置」复活，否则删掉的供应商下次启动又回来（用户看到的就是
  // 「明明删了，怎么还在用硅基流动」）。
  //
  // 判断看的是**盘上那份**（parsed）有没有 providers 键：真的老配置里根本没这个键，
  // 那种才该从扁平字段迁移出一家来。
  if (Array.isArray((parsed as any).providers) && (parsed as any).providers.length === 0) {
    const stale = !!((merged.baseUrl ?? "").trim() || (merged.model ?? "").trim())
    if (stale) {
      merged = clearFlatModelFields(merged)
      changed = true
    }
  }
  for (const key of ["embedEnabled", "embedBaseUrl", "embedPath", "embedApiKey", "embedModel"]) {
    if (key in merged) {
      delete merged[key]
      changed = true
    }
  }
  // 提示词只有「性格与角色」一处：老配置里的 systemPrompt 读出来就并过去，
  // 用户没写过性格时把那段旧文本原样接过来当性格（内容不丢）。
  const hadSystemPromptField = typeof merged.systemPrompt === "string"
  const storedPrompt = hadSystemPromptField ? String(merged.systemPrompt).trim() : ""
  if (typeof merged.persona !== "string") {
    merged.persona = storedPrompt || DEFAULT_PERSONA
    changed = true
  }
  if (hadSystemPromptField) {
    delete merged.systemPrompt
    changed = true
  }
  // 老配置 / 迁移过来的配置可能把明文密钥留在库里：读进 Keychain 后必须立刻写回脱敏版本。
  const hasPlaintextSecrets =
    !!merged.apiKey ||
    !!merged.gitToken ||
    (Array.isArray(merged.providers) && merged.providers.some((p: any) => !!p?.apiKey)) ||
    (Array.isArray(merged.mcpServers) && merged.mcpServers.some((s: any) => !!s?.token))
  if (hasPlaintextSecrets) changed = true

  cache = withDefaults(merged)
  // 记下「启动时盘上有哪些供应商」，之后第一次保存就能认出被删掉的那些、清掉它们的 Key。
  lastProviderIds = (cache.providers ?? []).map((p) => p.id)
  // 升级过的老配置顺手写回去，库里就不再留着废弃字段。
  if (changed) await saveConfig(cache)
}

/** 读配置（同步，走内存）。 */
export function loadConfig(): AgentConfig {
  if (!cache) cache = factoryConfig()
  return cache
}

/** 存配置：先写 Keychain，再落盘。文件写入是同步的，返回时已经写完。 */
export async function saveConfig(cfg: AgentConfig): Promise<void> {
  const out = syncActiveProvider(cfg)
  cache = out
  // 先通知（内存已经是新值），再落盘。
  notifyConfigChanged()
  kvWriteJson(KV_KEY, redactSecrets(out))
}

/** 配置项的键名，供快捷指令传 JSON 时识别。 */
export const CONFIG_KEYS: string[] = [
  "apiKey", "baseUrl", "apiPath", "model",
  "maxHistory", "maxToolRounds", "thinkingEnabled",
  "reasoningEffort", "tools", "mcpServers", "kbEnabled", "skillsEnabled",
  "showSteps", "imageEnabled", "imageMaxSize", "imageQuality", "agentName", "persona", "avatarPath", "gitToken", "modelOptions", "modelOptionsAt",
  "balanceText", "balanceDetail", "balanceSource", "balanceAt",
  "providers", "activeProviderId",
  "fsEnabled", "cliEnabled", "skillScriptEnabled", "skillCreateEnabled", "toolCreateEnabled",
]

/**
 * 若 text 是一段包含配置键的 JSON 对象，则合并保存并返回 true。
 * 用于「快捷指令直接改配置」的兼容路径；调用方请 await（否则进程可能先退出）。
 */
export async function tryApplyConfigJson(text: string): Promise<boolean> {
  const t = (text ?? "").trim()
  if (!t || t[0] !== "{") return false
  let obj: any
  try {
    obj = JSON.parse(t)
  } catch {
    return false
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
  const keys = Object.keys(obj)
  if (keys.length === 0 || !keys.some((k) => CONFIG_KEYS.indexOf(k) >= 0)) return false
  await saveConfig(mergeConfigPatch(loadConfig(), obj))
  return true
}
