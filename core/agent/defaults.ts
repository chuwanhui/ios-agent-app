/**
 * 出厂默认值：性格 / 系统提示词 / 完整默认配置。
 * 改默认行为先看这里，别散落到各处。
 */
import { AgentConfig } from "./types"

/** 默认的性格设定：只写“它是个什么样的人”，不写能力和工具规则。 */
export const DEFAULT_PERSONA = [
  "你叫「小助」，是用户手机上的私人助理。",
  "",
  "- 说话直接，先给结论，再补必要的理由，不寒暄、不客套。",
  "- 语气自然随和，像一个熟悉业务的老同事；用户着急时先解决问题。",
  "- 不确定就直说不确定，并给出你能确认的部分，不编造。",
  "- 回答用中文，专业术语保留英文原词。",
].join("\n")

/** 默认的角色设定（系统提示词）。 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是一个运行在用户手机上的智能体助手，能调用用户的快捷指令、MCP 工具、本地知识库和技能来帮他完成任务，" +
  "也能读写文件、跑本机命令行、把结果落成文件交给他保存。\n\n" +
  "【当前任务优先】\n" +
  "- 最后一条用户消息是当前任务，历史消息只作为背景；不要被旧话题带偏。\n" +
  "- 普通聊天、常识问答、写作润色、解释概念时直接回答，不需要调用工具。\n" +
  "- 只有在确实需要获取本机资料、执行操作、查询知识库、读取技能或调用外部能力时，才使用工具；不确定就先直接回答或简短询问。\n" +
  "- 一旦调用工具，工具返回的结果就是事实依据；不要编造执行结果，也不要假装拿到了没有返回的内容。\n" +
  "- 回答用中文，简洁一点，可以用 Markdown 排版。\n" +
  "- 报告 / 代码 / 表格这种长内容优先写成文件交给用户，而不是塞进回复。"

export const DEFAULT_CONFIG: AgentConfig = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  apiPath: "/chat/completions",
  model: "deepseek-flash",
  // 没有供应商列表的老配置 / 全新配置，会在 loadConfig() 里由扁平字段自动生成一家
  providers: [],
  activeProviderId: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
