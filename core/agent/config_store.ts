/**
 * 配置的读 / 写 / 迁移：
 *   - 密钥进 Keychain，config.json 里只留脱敏版本；
 *   - 读出来把老配置（没有供应商列表、旧默认提示词）就地升级；
 *   - 支持快捷指令直接传一段配置 JSON 来改。
 */
import { AgentConfig } from "./types"
import { DEFAULT_CONFIG, DEFAULT_PERSONA, DEFAULT_SYSTEM_PROMPT } from "./defaults"
import { AGENT_DIR, CONFIG_FILE } from "./paths"
import { keychainGet, keychainSet, recoverAtomicFile, writeJsonAtomically } from "./file_io"
import {
  mergeConfigPatch, syncActiveProvider, withLegacyProvider,
} from "./provider"

/** 从 Keychain 注入密钥，并兼容迁移旧版 config.json 中的明文密钥。 */
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

/** 先写 Keychain，再返回可安全写入 config.json 的脱敏对象。 */
function redactSecrets(cfg: AgentConfig): AgentConfig {
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

/**
 * 历史版的默认系统提示词：老配置里存的还是它们，加载时静默换成新的
 * （用户自己改过的提示词不动）。
 */
const LEGACY_DEFAULT_SYSTEM_PROMPTS = [
  "你是一个运行在用户手机上的智能体助手，可以调用用户的快捷指令和 MCP 工具来帮他完成任务。工具返回的结果就是事实，不要编造执行结果。回答请简洁、友好，使用中文。",
  "你是一个运行在用户手机上的智能体助手，可以调用用户的快捷指令、MCP 工具和本地知识库来帮他完成任务。工具返回的结果就是事实，不要编造。回答用中文，简洁一点，可以用 Markdown 排版。",
  "你是一个运行在用户手机上的智能体助手，能调用用户的快捷指令、MCP 工具、本地知识库和技能来帮他完成任务，也能读写文件、跑本机命令行、把结果落成文件交给他保存。\n\n【工作方式 — 必须严格遵循】\n每一轮回答必须按这个流程走：\n1️⃣ 先分析用户意图：他想做什么？需要哪些信息或操作？\n2️⃣ 决定调用什么工具：看看有哪些可用工具，选出能完成任务的。\n3️⃣ 逐个调用工具：真的去调，不要只说「我来做」。必须产生 tool_calls 去执行。\n4️⃣ 拿到结果后再回答：用工具返回的实际结果来组织最终答案。\n\n【关键规则】\n- 需要操作手机或获取信息时，必须调用工具，不要凭空编造。\n- 能用工具真正做完的事就直接做完（写文件、跑脚本、建技能），不要只在回答里描述步骤。\n- 工具返回的结果就是事实，不要编造执行结果。\n- 回答用中文，简洁一点，可以用 Markdown 排版。\n- 报告 / 代码 / 表格这种长内容写成文件交给用户，而不是塞进回复。",
]

export function loadConfig(): AgentConfig {
  try {
    recoverAtomicFile(CONFIG_FILE)
    const raw = FileManager.readAsStringSync(CONFIG_FILE)
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    // 语义检索（向量服务）已下线：老配置里的这几个字段读到就丢弃，别把明文密钥继续留在盘上。
    delete (merged as any).embedEnabled
    delete (merged as any).embedBaseUrl
    delete (merged as any).embedPath
    delete (merged as any).embedApiKey
    delete (merged as any).embedModel
    if (
      !merged.systemPrompt ||
      LEGACY_DEFAULT_SYSTEM_PROMPTS.indexOf(merged.systemPrompt.trim()) >= 0
    ) {
      merged.systemPrompt = DEFAULT_SYSTEM_PROMPT
    }
    // 老配置没有 persona：补上默认性格；用户显式清空（""）则保持为空。
    if (typeof merged.persona !== "string") merged.persona = DEFAULT_PERSONA
    const hydrated = hydrateSecrets(syncActiveProvider(withLegacyProvider(merged)))
    // 首次升级时读取旧明文（含已下线的向量服务 Key），再立即覆盖为脱敏版本。
    const hasLegacySecrets =
      !!(parsed.apiKey || parsed.embedApiKey || parsed.gitToken) ||
      (parsed.providers ?? []).some((p: any) => !!p?.apiKey) ||
      (parsed.mcpServers ?? []).some((s: any) => !!s?.token)
    if (hasLegacySecrets) saveConfig(hydrated)
    return syncActiveProvider(hydrated)
  } catch {
    return syncActiveProvider(hydrateSecrets(withLegacyProvider({ ...DEFAULT_CONFIG })))
  }
}

/**
 * 存盘：先把「当前使用」那家的字段同步到扁平字段再写，保证两边永远不会打架。
 */
export function saveConfig(cfg: AgentConfig): void {
  const out = syncActiveProvider(cfg)
  FileManager.createDirectorySync(AGENT_DIR, true)
  writeJsonAtomically(CONFIG_FILE, redactSecrets(out))
}

/** 配置项的键名，供快捷指令传 JSON 时识别。 */
export const CONFIG_KEYS: string[] = [
  "apiKey", "baseUrl", "apiPath", "model", "systemPrompt",
  "maxHistory", "maxToolRounds", "thinkingEnabled",
  "reasoningEffort", "tools", "mcpServers", "kbEnabled", "skillsEnabled",
  "showSteps", "imageEnabled", "imageMaxSize", "imageQuality", "agentName", "persona", "avatarPath", "gitToken", "modelOptions", "modelOptionsAt",
  "balanceText", "balanceDetail", "balanceSource", "balanceAt",
  "providers", "activeProviderId",
  "fsEnabled", "cliEnabled", "skillScriptEnabled", "skillCreateEnabled", "toolCreateEnabled",
]

/**
 * 若 text 是一段包含配置键的 JSON 对象，则合并保存并返回 true。
 * 用于「快捷指令直接改配置」的兼容路径。
 */
export function tryApplyConfigJson(text: string): boolean {
  const t = (text ?? "").trim()
  if (!t.startsWith("{")) return false
  try {
    const obj = JSON.parse(t)
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
    if (!Object.keys(obj).some((k) => CONFIG_KEYS.includes(k))) return false
    saveConfig(mergeConfigPatch(loadConfig(), obj))
    return true
  } catch {
    return false
  }
}
