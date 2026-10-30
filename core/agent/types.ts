/**
 * 所有数据结构定义（纯类型，不碰磁盘、不发请求）。
 * 存储、请求、UI 都从这里取类型，避免各自定义一份。
 */

export interface AgentTool {
  name: string
  description: string
  shortcutName: string
  /**
   * 参数声明，每行一个 `字段名=说明`（也支持全角 `＝` / `：`）。
   * 例：`destination=目的地名称`。写在这里的字段会被转成函数调用的 JSON schema。
   */
  paramsHint?: string
  /**
   * 结构化参数声明（粘贴 JSON 导入时写的完整版）：可以标类型、可选、取值枚举、默认值。
   * 有它时就优先于 paramsHint。
   */
  params?: ToolParamSpec[]
  /**
   * 这个快捷指令末尾配了「回调 URL」、会把执行结果传回来。
   * 只影响给模型看的说明措辞（别再一律说「没有返回值」）。
   */
  returns?: boolean
  /** 高级：直接给 JSON schema（配置 JSON 里手写，优先级最高）。 */
  parameters?: Record<string, any>
}

/**
 * 一个远程 MCP 服务器（JSON-RPC over Streamable HTTP）。
 * 沙箱里没有子进程管道，所以只支持 HTTP 型 MCP，不支持 stdio 型。
 */
export interface McpServer {
  /** 内部 id，用于生成模型看到的函数名，建议只含字母数字下划线。 */
  id: string
  /** 显示名，会作为工具名前缀。 */
  name: string
  /** Streamable HTTP 端点，例如 https://example.com/mcp */
  url: string
  /** 可选 Bearer Token。 */
  token?: string
  /** 额外请求头，每行一个 `Header: Value`。 */
  headersHint?: string
  enabled: boolean
}


/**
 * 一家模型供应商：地址 / Key / 请求路径 / 选中的模型 / 上次拉到的模型列表 / 上次查到的余额。
 * 每家一套自己的 Key，互相独立；聊天真正用的是「当前使用」那一家。
 */
export interface ModelProvider {
  id: string
  /** 你自己起的名字（列表里区分用），如「DeepSeek」「公司中转」。 */
  name: string
  baseUrl: string
  apiPath: string
  apiKey: string
  model: string
  /** 上次从 `<地址>/models` 拉回来的可用模型（只能从这里选，不给手输）。 */
  modelOptions?: string[]
  /** 上次拉取模型列表的时间（毫秒）。 */
  modelOptionsAt?: number
  /** 上次查到的余额：结论行 / 明细 / 来源端点 / 时间。 */
  balanceText?: string
  balanceDetail?: string
  balanceSource?: string
  balanceAt?: number
}

export interface AgentConfig {
  apiKey: string
  baseUrl: string
  apiPath: string
  model: string
  /**
   * 上次从 `<接口地址>/models` 拉回来的可用模型。设置页只能从这里选，不给手输；
   * 存进配置是为了重启后列表还在（不用每次重新拉）。
   */
  modelOptions?: string[]
  /** 上次拉取模型列表的时间（毫秒）。 */
  modelOptionsAt?: number
  /**
   * 上次查到的余额：结论行 / 明细 / 来源端点 / 时间。
   * 跟配置一起存，下次打开设置页不用再查就能看见上次的结果。
   */
  balanceText?: string
  balanceDetail?: string
  balanceSource?: string
  balanceAt?: number
  /**
   * 配置过的模型供应商。聊天真正用的是「当前使用」那一家：
   * saveConfig 会把它的字段同步到上面的扁平字段（apiKey / baseUrl / apiPath / model / 余额），
   * 所以 core/agent/core、intent、widget 这些地方继续读扁平字段就行，不用改。
   */
  providers?: ModelProvider[]
  /** 当前使用的供应商 id。 */
  activeProviderId?: string
  maxHistory: number
  maxToolRounds: number
  thinkingEnabled: boolean
  reasoningEffort: string
  tools: AgentTool[]
  /** 远程 MCP 服务器列表。 */
  mcpServers: McpServer[]
  /** 开启本地知识库检索工具。 */
  kbEnabled: boolean
  /** 开启用户上传的技能。 */
  skillsEnabled: boolean
  /** 在聊天页展示 AI 的思考与工具调用过程。 */
  showSteps: boolean
  // —— 图片输入 ——
  /** 允许在聊天里发图片（多模态）。关掉则输入栏不出现图片按钮。 */
  imageEnabled: boolean
  /** 发给模型前把图片长边缩到这么大像素（0 = 不缩放）。默认 1024。 */
  imageMaxSize: number
  /** JPEG 压缩质量 0~1。默认 0.8。 */
  imageQuality: number
  // —— 助手能力（「手脚」）——
  // 全部默认关闭，在设置页的「能力」里逐个授权；关掉时对应的工具根本不会挂给模型。
  /** 读写文件：列目录 / 读 / 写 / 删（工作区在「文件」App → Scripting 里可见）。 */
  fsEnabled: boolean
  /** 执行命令行（本机精简命令：Python / scripting-ts / curl / ffmpeg 等）。 */
  cliEnabled: boolean
  /** 运行技能自带的脚本（.py / .ts）。 */
  skillScriptEnabled: boolean
  /** 让助手自己创建 / 注册新技能。 */
  skillCreateEnabled: boolean
  /** 让助手自己登记快捷指令工具（写完配置后由它引导用户去『快捷指令』App 建）。 */
  toolCreateEnabled: boolean
  // —— 角色形象 ——
  agentName: string
  /** 用户上传的头像图片路径（图片存在 appGroup，这里只存路径）；为空就显示占位图。 */
  avatarPath?: string
  /**
   * 助手的性格与角色（Markdown 纯文本）——**唯一**的人设 / 行为说明来源。
   *
   * 这里写什么，模型就当什么：身份、说话方式、做事规则都在这一段里。
   * 代码里没有另外的「系统提示词」跟它拼在一起（只有助手名字和技能清单）。
   * 空字符串 = 只靠技能清单与名字，等于没有任何人设约束。
   */
  persona: string
  /**
   * 私有 Git 仓库的访问令牌（可选），只用于「技能 → 从 Git 仓库导入」。
   * 留空就只能拉公开仓库。
   */
  gitToken?: string
}

/** 「能力」开关的字段名（capabilities.ts 用它声明每个工具归哪个开关管）。 */
export type AgentConfigToggle =
  | "fsEnabled"
  | "cliEnabled"
  | "skillScriptEnabled"
  | "skillCreateEnabled"
  | "toolCreateEnabled"

/** AI 调用一次工具的完整记录（聊天页用它回放 AI 的决策过程）。 */
export interface ToolStep {
  /**
   * 工具类别：本地快捷指令 / MCP / 本地知识库 / 技能 / 助手自带的手脚（文件、命令行）；
   * other = 模型点了一个不存在的工具。
   */
  kind: "shortcut" | "mcp" | "kb" | "skill" | "fs" | "cli" | "other"
  /** 模型看到的函数名。 */
  name: string
  /** 展示用目标：快捷指令名 / 「服务器 · 工具」/ 本地知识库 / 技能名。 */
  target: string
  /** 调用参数（JSON 文本或查询词），过长会截断。 */
  args: string
  /** 返回结果，过长会截断。 */
  result: string
  /** 是否成功。 */
  ok: boolean
  /** 耗时（毫秒）。 */
  ms: number
  /**
   * 调用编号：带 returns 的快捷指令工具会先记一条 pending，
   * 快捷指令回传时靠它对上号（回填真实结果）。
   */
  cid?: string
  /** 是否还在等待快捷指令 callback。pending 时不会还原成 role:"tool" 发给模型。 */
  pending?: boolean
  /** 是否已经收到快捷指令的回传（此时 result 是回传内容，不再是「等待回传」）。 */
  callback?: boolean
  /**
   * 这次调用产出 / 改动的文件（绝对路径）。聊天页会给它们画「产出文件」卡片，
   * 点一下就能用系统菜单存到「文件」App 或分享出去。
   */
  files?: string[]
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  /** 消息时间（毫秒时间戳），用于记忆管理。 */
  at?: number
  /** 请求失败时保留消息用于界面展示，但不再把这条消息发给模型。 */
  contextExcluded?: boolean
  /**
   * 附带的图片：存的是磁盘上的绝对路径（存在 agent/images/ 下），
   * 发给模型时再读出来转成 data URL。不把 base64 塞进会话数据，免得库膨胀。
   */
  images?: string[]
  /**
   * 旧版隐藏消息兼容字段；新链路不再写入。
   */
  hidden?: boolean
  /** 模型的推理过程（DeepSeek 思考模式返回的 reasoning_content）。 */
  reasoning?: string
  /** 这一轮里 AI 调用过的工具，按时间顺序。 */
  steps?: ToolStep[]
  /** 这一轮的 token 用量（流式响应最后一帧带回来的 usage）。 */
  usage?: TokenUsage
}

/** 一次请求的 token 用量（不同厂商字段名不一，读回来时归一化）。 */
export interface TokenUsage {
  /** 输入 token（prompt_tokens）。 */
  inputTokens: number
  /** 输出 token（completion_tokens）。 */
  outputTokens: number
  /** 合计 token。 */
  totalTokens: number
  /** 其中属于思考（reasoning_tokens）的部分。 */
  reasoningTokens?: number
  /** 命中缓存的输入 token。 */
  cachedInputTokens?: number
}

/** 一个会话（一段独立的对话，各自带历史）。 */
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** 记忆绑定键（例如 app:sender），用于按人维度找会话。 */
  memoryKey?: string
  /** 历史压缩后的摘要（给后续轮次当记忆）。 */
  memorySummary?: string
  /** 最近一次摘要更新时间。 */
  memorySummaryAt?: number
  /** 这个会话使用的工作区目录名；不同会话可以共享同一个工作区。 */
  workspaceName: string
}

export interface SessionStore {
  currentId: string | null
  sessions: Session[]
}

export interface ToolParamSpec {
  name: string
  description: string
  /** 参数类型，默认 string（快捷指令收到的都是文本，这里只影响模型怎么生成）。 */
  type?: "string" | "number" | "integer" | "boolean"
  /** 是否必填，默认 true —— 快捷指令里「获取词典值」少了键会取不到，宁缺毋滥。 */
  required?: boolean
  /** 限定取值，可以让模型只在几种模式里选。 */
  enum?: string[]
  /** 默认值（可写成提示）。 */
  default?: string | number | boolean
}
