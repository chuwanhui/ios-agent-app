/**
 * 模型供应商：多家的增删改，以及「当前使用」那家与扁平字段的同步。
 *
 * 为什么还要扁平字段：core / intent / widget 只认 cfg.apiKey / baseUrl / model，
 * 所以任何一次写配置或读配置都要经过 syncActiveProvider 把两边对齐。
 */
import { AgentConfig, ModelProvider } from "./types"

// ———————————————————————— 模型供应商 ————————————————————————

export function makeProvider(): ModelProvider {
  return {
    id: "p" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    name: "",
    baseUrl: "",
    apiPath: "/chat/completions",
    apiKey: "",
    model: "",
  }
}

/** 从接口地址猜个名字（只为了列表好看，用户随时能改）。 */
export function suggestProviderName(baseUrl: string): string {
  const host = (baseUrl ?? "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
    .toLowerCase()
  if (!host) return ""
  const known: Record<string, string> = {
    "api.deepseek.com": "DeepSeek",
    "api.openai.com": "OpenAI",
    "api.siliconflow.cn": "硅基流动",
    "api.moonshot.cn": "Moonshot",
    "openrouter.ai": "OpenRouter",
    "dashscope.aliyuncs.com": "阿里云百炼",
    "open.bigmodel.cn": "智谱",
    "api.mistral.ai": "Mistral",
    "api.x.ai": "xAI",
    "api.groq.com": "Groq",
  }
  if (known[host]) return known[host]
  const parts = host.split(".").filter((p) => p && p !== "api" && p !== "www")
  const label = parts[0] ?? host
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** 当前使用的供应商（activeProviderId 指不到就退回第一家）。 */
export function activeProvider(cfg: AgentConfig): ModelProvider | undefined {
  const list = cfg.providers ?? []
  if (list.length === 0) return undefined
  const hit = list.find((p) => p.id === cfg.activeProviderId)
  return hit ?? list[0]
}

/**
 * 没有供应商列表时，把扁平的模型字段搬成一家。
 *
 * 但**只在这份扁平字段里真的还有东西时**才搬：用户把供应商全删掉之后，扁平字段应该
 * 是空的，「空」就该老实表示「一家都没有」。以前这里无条件造一家，于是删掉的那家
 * （比如硅基流动）在下次启动时又从残留的 baseUrl / model 里原地复活，看起来像删不掉。
 */
export function withLegacyProvider(cfg: AgentConfig): AgentConfig {
  if (Array.isArray(cfg.providers) && cfg.providers.length > 0) return cfg
  const hasLegacy = !!((cfg.baseUrl ?? "").trim() || (cfg.apiKey ?? "").trim() || (cfg.model ?? "").trim())
  if (!hasLegacy) return cfg
  const p: ModelProvider = {
    id: makeProvider().id,
    name: suggestProviderName(cfg.baseUrl) || "默认",
    baseUrl: cfg.baseUrl ?? "",
    apiPath: cfg.apiPath || "/chat/completions",
    apiKey: cfg.apiKey ?? "",
    model: cfg.model ?? "",
    modelOptions: cfg.modelOptions,
    modelOptionsAt: cfg.modelOptionsAt,
    balanceText: cfg.balanceText,
    balanceDetail: cfg.balanceDetail,
    balanceSource: cfg.balanceSource,
    balanceAt: cfg.balanceAt,
  }
  return { ...cfg, providers: [p], activeProviderId: p.id }
}

/**
 * 把扁平模型字段清空（供应商一家都不剩时用）。
 *
 * 为什么必须清：`withLegacyProvider` 会拿这些字段「复活」一家供应商。删光之后它们还留着
 * 上一家的地址和模型，下次启动那家就原地回来了 —— 用户看到的就是「删了还在用硅基流动」。
 */
export function clearFlatModelFields(cfg: AgentConfig): AgentConfig {
  return {
    ...cfg,
    activeProviderId: "",
    apiKey: "",
    baseUrl: "",
    apiPath: "/chat/completions",
    model: "",
    modelOptions: undefined,
    modelOptionsAt: undefined,
    balanceText: undefined,
    balanceDetail: undefined,
    balanceSource: undefined,
    balanceAt: undefined,
  }
}

/**
 * 把「当前使用」那家的字段同步到扁平字段上 —— 老代码（core/agent/core / intent / widget）
 * 只认 apiKey / baseUrl / apiPath / model / 余额这几个扁平字段，靠这一步保持一致。
 */
export function syncActiveProvider(cfg: AgentConfig): AgentConfig {
  const p = activeProvider(cfg)
  // 一家都不剩（用户删光了）时，扁平字段必须一起清空，否则下次启动又会被复活成一家。
  if (!p) return clearFlatModelFields(cfg)
  return {
    ...cfg,
    activeProviderId: p.id,
    apiKey: p.apiKey ?? "",
    baseUrl: p.baseUrl ?? "",
    apiPath: p.apiPath || "/chat/completions",
    model: p.model ?? "",
    modelOptions: p.modelOptions,
    modelOptionsAt: p.modelOptionsAt,
    balanceText: p.balanceText,
    balanceDetail: p.balanceDetail,
    balanceSource: p.balanceSource,
    balanceAt: p.balanceAt,
  }
}

/**
 * 合并一段配置 JSON：老写法的扁平模型字段（apiKey / baseUrl / model …）落到「当前使用」
 * 的那家供应商上，其余键照旧合并 —— 这样快捷指令直接改配置的老路还能用。
 */
export function mergeConfigPatch(base: AgentConfig, obj: Record<string, any>): AgentConfig {
  const flat = [
    "apiKey", "baseUrl", "apiPath", "model", "modelOptions", "modelOptionsAt",
    "balanceText", "balanceDetail", "balanceSource", "balanceAt",
  ]
  const rest: Record<string, any> = {}
  let hasFlat = false
  for (const k of Object.keys(obj)) {
    if (flat.indexOf(k) >= 0) hasFlat = true
    else rest[k] = obj[k]
  }
  const cfg: AgentConfig = { ...base, ...rest }
  if (!hasFlat) return cfg
  const providers = (cfg.providers ?? []).map((p) => ({ ...p }))
  if (providers.length === 0) providers.push(makeProvider())
  let i = providers.findIndex((p) => p.id === cfg.activeProviderId)
  if (i < 0) i = 0
  for (const k of flat) {
    if (k in obj) (providers[i] as any)[k] = obj[k]
  }
  providers[i].name = providers[i].name || suggestProviderName(providers[i].baseUrl) || "默认"
  return { ...cfg, providers, activeProviderId: providers[i].id }
}
