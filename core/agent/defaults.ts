/**
 * 完整默认配置（出厂值）。
 * 提示词原文在 ./prompts.ts，这里只负责把它们装进默认配置。
 */
import { AgentConfig } from "./types"
import { DEFAULT_PERSONA } from "./prompts"

export const DEFAULT_CONFIG: AgentConfig = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  apiPath: "/chat/completions",
  model: "deepseek-flash",
  // 没有供应商列表的老配置 / 全新配置，会在 loadConfig() 里由扁平字段自动生成一家
  providers: [],
  activeProviderId: "",
  maxHistory: 50,
  maxToolRounds: 3,
  thinkingEnabled: true,
  reasoningEffort: "high",
  tools: [],
  mcpServers: [],
  kbEnabled: true,
  skillsEnabled: true,
  showSteps: true,
  imageEnabled: true,
  imageMaxSize: 1024,
  imageQuality: 0.8,
  agentName: "小助",
  persona: DEFAULT_PERSONA,
  gitToken: "",
  // 能力默认全关：装了什么工具就有什么权限，让用户自己决定什么时候给。
  fsEnabled: false,
  cliEnabled: false,
  skillScriptEnabled: false,
  skillCreateEnabled: false,
  toolCreateEnabled: false,
}
