import { fetch } from "scripting"
import {
  AgentConfig, AgentTool, ChatMessage, McpServer, TokenUsage, ToolStep, imageToDataUrl, toolDescription, toolParameters,
} from "./store"
import { McpTool, callMcpTool, collectMcpTools } from "../mcp/client"
import { formatKbHits, kbStats, searchKb } from "../kb/store"
import { listSkills, readSkill, skillsPrompt } from "../skills/store"
import { addPending, finishPending } from "./tool_callback"
import { describeRequest, httpErrorText } from "./http_error"
import { activeProvider } from "./provider"
import { CapResult, Capability, capabilitiesFor } from "./capabilities"
import { RunSource, clipError, logRun } from "../diagnostics/store"

// Scripting runtime provides this Web API, but its generated type bundle omits the declaration.
declare const TextDecoder: {
  new (): { decode(input?: any, options?: { stream?: boolean }): string }
}

type LLMMessage = {
  role: string
  content?: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** 接口地址里的主机名（诊断里用来分辨「是不是打了另一家」）。 */
function hostOf(url: string): string {
  return (url ?? "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
}

function endpoint(cfg: AgentConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, "")
  const path = (cfg.apiPath || "/chat/completions").replace(/^\/+/, "")
  return base + "/" + path
}

async function callDeepSeek(
  messages: LLMMessage[],
  cfg: AgentConfig,
  toolsSpec: any[] | null,
  control?: RunControl,
): Promise<any> {
  const resp = await postChat(cfg, buildBody(messages, cfg, toolsSpec, false), control)
  return await resp.json()
}

/** 请求体（流式 / 非流式共用）。 */
function buildBody(
  messages: LLMMessage[],
  cfg: AgentConfig,
  toolsSpec: any[] | null,
  stream: boolean,
): Record<string, any> {
  const body: Record<string, any> = {
    model: cfg.model,
    messages,
    stream,
  }
  // 让服务端在最后一帧带上 usage（OpenAI 兼容协议）；不认这个字段的服务端会被上层退回非流式。
  if (stream) body.stream_options = { include_usage: true }
  if (cfg.thinkingEnabled) body.thinking = { type: "enabled" }
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort
  if (toolsSpec && toolsSpec.length > 0) body.tools = toolsSpec
  return body
}

/**
 * 发一次 POST。HTTP 层出错时给 error 挂上 `httpStatus`：
 * 上层据此区分「接口本身报错」（直接抛给用户）和「这个服务端不支持流式」（退回一次性请求）。
 *
 * 这里的重试只针对「稍等再试就好」的情况：网络抖一下、限流 429、网关 5xx。
 * 认证错 / 模型名错这类配置问题会立刻抛出，不浪费时间。
 */
const CHAT_CONNECT_TIMEOUT = 45000
/** 值得重试的状态码。 */
const RETRYABLE_STATUS = [429, 500, 502, 503, 504]
/** 一次请求最多连几次（含第一次）。 */
const RETRY_ATTEMPTS = 3
const RETRY_BASE_MS = 800
/** 生成过程中轮询「用户有没有点停止」的间隔。 */
const ABORT_POLL_MS = 250

/** 用户能不能中途喊停：页面把它设成 true，正在跑的请求与后续工具调用都会尽快退出。 */
export type RunControl = { aborted: boolean }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 400)
}

function abortError(): Error {
  const err: any = new Error("已停止生成")
  err.aborted = true
  return err
}

/** 连一次，只管拿到响应头；超时或用户中止都会 reject。 */
async function connectOnce(cfg: AgentConfig, body: Record<string, any>, control?: RunControl): Promise<any> {
  const controller = new AbortController()
  let timer: any = null
  let aborter: any = null
  // 运行时没有 setInterval（只有 setTimeout），所以停止信号用自排队的 setTimeout 轮询。
  let polling = !!control
  const pollAbort = () => {
    if (!polling) return
    if (control && control.aborted) {
      try { controller.abort() } catch {}
      return
    }
    aborter = setTimeout(pollAbort, ABORT_POLL_MS)
  }
  try {
    // 运行时不一定支持 signal.addEventListener，这里用轮询实现「随时可停」。
    if (control) aborter = setTimeout(pollAbort, ABORT_POLL_MS)
    const request = fetch(endpoint(cfg), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal as any,
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { controller.abort() } catch {}
        reject(new Error(`连接模型服务超时（${Math.round(CHAT_CONNECT_TIMEOUT / 1000)} 秒）`))
      }, CHAT_CONNECT_TIMEOUT)
    })
    return await Promise.race([request, timeout])
  } finally {
    polling = false
    if (timer != null) clearTimeout(timer)
    if (aborter != null) clearTimeout(aborter)
  }
}

async function postChat(
  cfg: AgentConfig,
  body: Record<string, any>,
  control?: RunControl,
): Promise<any> {
  let lastErr: any = null
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (control?.aborted) throw abortError()

    let resp: any
    try {
      resp = await connectOnce(cfg, body, control)
    } catch (e: any) {
      if (control?.aborted) throw abortError()
      lastErr = e
      // 网络层错误（DNS / 断流 / 超时）重试；HTTP 错误在下面按状态码判断。
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw e
    }

    if (!resp.ok) {
      const text = await resp.text()
      const provider = activeProvider(cfg)
      // 末尾多带一行「这次用的是谁」：两条入口（聊天页 / URL 唤起）结果不一样时，
      // 第一件要排除的就是「是不是用了另一家 / 另一个模型 / 另一把 Key」。
      const err: any = new Error(
        httpErrorText(resp.status, text) +
          "\n" +
          describeRequest({
            name: provider?.name,
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            apiKey: cfg.apiKey,
          }),
      )
      err.httpStatus = resp.status
      if (RETRYABLE_STATUS.indexOf(resp.status) >= 0 && attempt < RETRY_ATTEMPTS - 1) {
        lastErr = err
        await sleep(backoffMs(attempt))
        continue
      }
      throw err
    }

    return resp
  }
  throw lastErr ?? new Error("请求失败")
}

/** 流式增量：正文与推理分开推给 UI（打字机效果）。 */
export type AgentDelta = {
  type: "text" | "reasoning"
  content: string
  /** 推理的新段落：多轮工具调用时每轮一段，UI 用它决定要不要插空行。 */
  newSegment?: boolean
  /** 丢弃已经画出来的内容（流式中途失败、退回一次性请求时用）。 */
  reset?: boolean
}

type StreamOutcome = {
  message: any
  /** 本轮拼起来的推理全文。 */
  reasoning: string
  usage?: TokenUsage
}

/** 把各家不同的 usage 字段归一化。 */
function readUsage(raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0)
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0)
  if (!input && !output) return undefined
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: Number(raw.total_tokens ?? input + output),
  }
  const think = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0)
  if (think > 0) usage.reasoningTokens = think
  const cached = Number(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0)
  if (cached > 0) usage.cachedInputTokens = cached
  return usage
}

/** 逐行取 SSE 的 `data:` 负载（忽略别的行和 [DONE]）。 */
function eachSsePayload(frame: string, fn: (payload: string) => void) {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const payload = trimmed.slice(5).trim()
    if (payload && payload !== "[DONE]") fn(payload)
  }
}

/**
 * 流式请求：边收边把增量回调出去，最后把分片拼回一条完整的 message。
 * 工具调用是分片下发的（id / name / arguments 拆在不同帧里），按 `index` 拼装。
 *
 * 超时机制：
 *   - chunk 间最长等 STREAM_CHUNK_TIMEOUT（30 秒），超时就认为服务端挂了，结束读取；
 *   - 整次流式传输不超过 STREAM_TOTAL_TIMEOUT（120 秒）,
 *     防止服务端一直发碎片（实际上 DeepSeek 一次回答通常在 30 秒内完成）。
 */
const STREAM_CHUNK_TIMEOUT = 30000
const STREAM_TOTAL_TIMEOUT = 120000

async function callDeepSeekStream(
  messages: LLMMessage[],
  cfg: AgentConfig,
  toolsSpec: any[] | null,
  onDelta?: (d: AgentDelta) => void,
  control?: RunControl,
): Promise<StreamOutcome> {
  const resp = await postChat(cfg, buildBody(messages, cfg, toolsSpec, true), control)

  const content: string[] = []
  const calls: any[] = []
  const reasonings: string[] = []
  let usage: TokenUsage | undefined

  const consumeJson = (payload: string) => {
    let j: any = null
    try {
      j = JSON.parse(payload)
    } catch {
      return // 半截帧，忽略
    }
    if (!j || typeof j !== "object") return
    const u = readUsage(j.usage)
    if (u) usage = u
    const choice = j.choices?.[0]
    const delta = choice?.delta ?? choice?.message
    if (!delta) return

    // DeepSeek 思考模式：reasoning_content；有的兼容实现叫 reasoning。
    const think =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : ""
    if (think) {
      reasonings.push(think)
      onDelta?.({ type: "reasoning", content: think })
    }

    if (typeof delta.content === "string" && delta.content) {
      content.push(delta.content)
      onDelta?.({ type: "text", content: delta.content })
    }

    for (const tc of delta.tool_calls ?? []) {
      const index = typeof tc?.index === "number" ? tc.index : 0
      while (calls.length <= index) {
        calls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
      }
      const slot = calls[index]
      if (tc.id) slot.id = tc.id
      if (tc.type) slot.type = tc.type
      if (tc.function?.name) slot.function.name += tc.function.name
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
    }
  }

  const reader: any = (resp.body as any)?.getReader?.()
  if (reader) {
    const decoder = new TextDecoder()
    let buffer = ""
    const tStart = Date.now()
    while (true) {
      if (control?.aborted) {
        try { reader.cancel?.() } catch {}
        throw abortError()
      }
      const elapsed = Date.now() - tStart
      if (elapsed >= STREAM_TOTAL_TIMEOUT) {
        try { reader.cancel?.() } catch {}
        break
      }
      const chunkBudget = Math.min(STREAM_CHUNK_TIMEOUT, STREAM_TOTAL_TIMEOUT - elapsed)
      let chunk: any = null
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("CHUNK_TIMEOUT")), chunkBudget)),
        ])
      } catch {
        try { reader.cancel?.() } catch {}
        break
      }
      if (!chunk || chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let cut = buffer.indexOf("\n\n")
      while (cut >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        eachSsePayload(frame, consumeJson)
        cut = buffer.indexOf("\n\n")
      }
    }
    // 收尾：把解码器里残留的半个多字节字符和最后一段没带空行的帧吐出来
    buffer += decoder.decode()
    eachSsePayload(buffer, consumeJson)
  } else {
    // 服务端没给流式响应体：整段文本可能仍是 SSE，也可能就是一段 JSON。
    const raw = await resp.text()
    if (raw.indexOf("data:") >= 0) {
      for (const frame of raw.split("\n\n")) eachSsePayload(frame, consumeJson)
    } else {
      consumeJson(raw)
    }
  }

  const message: any = { role: "assistant", content: content.join("") }
  const toolCalls = calls.filter((c) => c.function.name || c.function.arguments)
  if (toolCalls.length > 0) {
    for (const c of toolCalls) {
      if (!c.id) c.id = "call_" + Math.random().toString(36).slice(2, 10)
    }
    message.tool_calls = toolCalls
  }
  return { message, reasoning: reasonings.join(""), usage }
}

/**
 * 把一条带图片的用户消息转成 OpenAI 多模态 content 数组：
 *   [ { type:"text", text:"…" }, { type:"image_url", image_url:{ url:"data:image/jpeg;base64,…" } }, … ]
 * 图片读不到时跳过，不报错（让模型至少看到文字）。没有图片就退回纯字符串。
 */
function multimodalContent(text: string, images?: string[]): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const valid = (images ?? []).map((p) => imageToDataUrl(p)).filter((u): u is string => !!u)
  if (valid.length === 0) return text
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  if (text) parts.push({ type: "text", text })
  for (const url of valid) parts.push({ type: "image_url", image_url: { url } })
  return parts.length > 0 ? parts : text
}

/**
 * 只给最近几轮的消息带图片。
 * 历史图片每轮都重新读盘 + base64 重发的话，token 是线性翻倍的；老图换成一行占位文字。
 */
const IMAGE_TURNS = 2
/** 单次请求的输入预算（token）。超了就从最老的整轮开始丢。 */
const INPUT_TOKEN_BUDGET = 24_000
/** 一张图按多少 token 估（各厂商 700~1200 不等，取偏保守的值）。 */
const IMAGE_TOKEN_ESTIMATE = 900

/** 粗估 token：中文按一个字约 0.8 token，其余按 4 字符 1 token。 */
function estimateTokens(text: string): number {
  const s = text ?? ""
  if (!s) return 0
  let wide = 0
  let narrow = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x2e80) wide += 1
    else narrow += 1
  }
  return Math.ceil(wide * 0.8 + narrow / 4)
}

function contentTokens(content: LLMMessage["content"]): number {
  if (typeof content === "string") return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const part of content) {
    if (part.type === "text") n += estimateTokens(part.text ?? "")
    else n += IMAGE_TOKEN_ESTIMATE
  }
  return n
}

function messageTokens(m: LLMMessage): number {
  let n = contentTokens(m.content)
  for (const tc of m.tool_calls ?? []) {
    n += estimateTokens(tc.function?.name ?? "") + estimateTokens(tc.function?.arguments ?? "")
  }
  return n + 4
}

/**
 * 输入预算守卫：超了就从最老的整轮开始丢（system 一直留着，最后一条一定留着）。
 * 一个「整轮」= 一条带 tool_calls 的 assistant + 紧跟其后的 tool 结果，避免拆散协议结构。
 */
function trimToBudget(msgs: LLMMessage[], budget = INPUT_TOKEN_BUDGET): LLMMessage[] {
  if (msgs.length === 0) return msgs
  const head: LLMMessage[] = msgs[0]?.role === "system" ? [msgs[0]] : []
  const rest = head.length > 0 ? msgs.slice(1) : msgs

  const groups: LLMMessage[][] = []
  for (const m of rest) {
    const cur = groups[groups.length - 1]
    const prev = cur ? cur[cur.length - 1] : null
    if (m.role === "tool" && prev && (prev.tool_calls?.length ?? 0) > 0) {
      cur.push(m)
      continue
    }
    groups.push([m])
  }

  let used = head.reduce((n, m) => n + messageTokens(m), 0)
  const keep: LLMMessage[][] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((n, m) => n + messageTokens(m), 0)
    // 至少保留最近一轮，哪怕它自己就超预算（否则请求必然空着历史发出）
    if (keep.length > 0 && used + cost > budget) break
    keep.push(groups[i])
    used += cost
  }
  keep.reverse()

  const out: LLMMessage[] = head.slice()
  for (const g of keep) for (const m of g) out.push(m)
  return out
}

function buildMessages(
  cfg: AgentConfig,
  history: ChatMessage[],
  userText?: string,
): LLMMessage[] {
  const msgs: LLMMessage[] = []
  const sys: string[] = []
  // 名字单独说一句：性格里不写死名字，用户改了名字也不会和旧设定打架。
  const agentName = (cfg.agentName ?? "").trim()
  if (agentName) sys.push(`你的名字是「${agentName}」，用户这样称呼你。`)
  // 「性格与角色」是唯一的人设来源：身份、说话方式、做事规则全在这一段里。
  if (cfg.persona && cfg.persona.trim()) sys.push(cfg.persona.trim())
  if (cfg.skillsEnabled) {
    const sp = skillsPrompt()
    if (sp) sys.push(sp)
  }
  if (sys.length > 0) {
    msgs.push({ role: "system", content: sys.join("\n\n") })
  }
  // 只有最近几轮的图片会被真的发出去。
  const imageAllowed = new Set<number>()
  let imageTurns = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if ((history[i].images ?? []).length === 0) continue
    imageTurns += 1
    if (imageTurns <= IMAGE_TURNS) imageAllowed.add(i)
  }
  for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
    const m = history[historyIndex]
    const next = history[historyIndex + 1]
    const isFailureMessage = m.role === "assistant" && m.content.startsWith("出错：")
    const isLegacyFailedInput =
      m.role === "user" &&
      next?.role === "assistant" &&
      next.content.startsWith("出错：")
    if (m.contextExcluded || isFailureMessage || isLegacyFailedInput) continue

    if (m.role === "assistant") {
      const content = m.content ?? ""
      // 有工具调用记录 → 还原成 tool_calls + role:"tool" 结构
      const steps = m.steps ?? []
      if (steps.length > 0) {
        if (steps.some((s) => s.pending && !s.callback)) continue
        const toolCalls: any[] = []
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i]
          const id = s.cid || "h_" + i
          toolCalls.push({
            id,
            type: "function",
            function: { name: s.name, arguments: s.args || "{}" },
          })
        }
        msgs.push({ role: "assistant", content, tool_calls: toolCalls })
        for (let i = 0; i < steps.length; i++) {
          const id = steps[i].cid || "h_" + i
          msgs.push({
            role: "tool",
            tool_call_id: id,
            content: steps[i].result || "",
          })
        }
      } else {
        msgs.push({ role: m.role, content })
      }
    } else {
      const imageCount = (m.images ?? []).length
      if (imageCount > 0 && !imageAllowed.has(historyIndex)) {
        const note = `\n（这条消息原本附带 ${imageCount} 张图片，为节省额度只发送最近 ${IMAGE_TURNS} 轮的图片，更早的已省略）`
        msgs.push({ role: m.role, content: (m.content ?? "") + note })
      } else {
        msgs.push({ role: m.role, content: multimodalContent(m.content, m.images) })
      }
    }
  }
  if (userText !== undefined) msgs.push({ role: "user", content: userText })
  return trimToBudget(msgs)
}

/** 工具调用时抛给 UI 的事件（用于在灵动岛 / 语音页显示进度）。 */
export type AgentEvent = {
  type: "tool"
  /** 工具类别：快捷指令 / MCP / 知识库 / 技能 / 助手自带的手脚（文件、命令行）。 */
  kind: ToolStep["kind"]
  /** 模型看到的函数名。 */
  name: string
  /** 执行目标：快捷指令名，或「服务器 · 工具」。 */
  target: string
  argsText: string
}

/** 工具类别在界面上的统一叫法（聊天页过程面板、设置页说明共用一处）。 */
export const TOOL_KIND_LABEL: Record<ToolStep["kind"], string> = {
  shortcut: "本地快捷指令工具",
  mcp: "MCP 工具",
  kb: "本地知识库",
  skill: "技能",
  fs: "文件",
  cli: "命令行",
  other: "未知工具",
}

export function toolKindLabel(kind: ToolStep["kind"]): string {
  return TOOL_KIND_LABEL[kind] ?? "工具"
}

/** runAgent 的回调钩子；聊天页用它把 AI 的过程实时画出来。 */
export type RunAgentHooks = {
  /** 即将调用某个工具（灵动岛 / 语音页拿它写进度文案）。 */
  onEvent?: (e: AgentEvent) => void
  /** 一次工具调用结束，带完整记录（参数 / 结果 / 成败 / 耗时）。 */
  onStep?: (s: ToolStep) => void
  /** 模型吐出的整段推理（每轮一次；流式下用 onDelta 更好，别两个都接）。 */
  onReasoning?: (text: string) => void
  /** 流式增量：正文与推理边生成边回调（打字机效果）。 */
  onDelta?: (d: AgentDelta) => void
  /**
   * 助手刚给自己登记了新工具（快捷指令工具）。
   * 会话挂载会把这些名字之外的快捷指令工具过滤掉，所以聊天页收到后要把它们并进当前会话。
   */
  onToolsCreated?: (names: string[]) => void
}

/** 兼容旧写法：第 4 个参数也可以直接传一个 onEvent 回调。 */
export type HooksArg = RunAgentHooks | ((e: AgentEvent) => void) | undefined

function normalizeHooks(arg: HooksArg): RunAgentHooks {
  if (!arg) return {}
  if (typeof arg === "function") return { onEvent: arg }
  return arg
}

/** 存进历史前先截断，免得会话数据被推理文本和长文档撑爆。 */
const ARGS_CLIP = 300
const RESULT_CLIP = 800
const REASONING_CLIP = 1600

function clip(text: string, max: number): string {
  const s = text ?? ""
  if (s.length <= max) return s
  return s.slice(0, max) + `…（已截断，共 ${s.length} 字）`
}

function makeStep(
  kind: ToolStep["kind"],
  name: string,
  target: string,
  argsText: string,
  rawResult: string,
  ok: boolean,
  ms: number,
): ToolStep {
  return {
    kind,
    name,
    target,
    args: clip(argsText, ARGS_CLIP),
    result: clip(rawResult, RESULT_CLIP),
    ok,
    ms,
  }
}

/** 工具返回给模型的正文上限：一个 200KB 的 MCP 结果能把上下文直接打爆。 */
const TOOL_RESULT_MAX = 16000

function clipToolResult(text: string): string {
  const s = text ?? ""
  if (s.length <= TOOL_RESULT_MAX) return s
  return (
    s.slice(0, TOOL_RESULT_MAX) +
    `\n…（工具输出过长，已截断；原文共 ${s.length} 字。需要完整内容时请缩小范围，或让用户从工作区文件里看。）`
  )
}

/** 模型看到的函数名 → 实际执行目标。 */
type ToolRoute =
  | { kind: "shortcut"; tool: AgentTool }
  | { kind: "mcp"; server: McpServer; tool: McpTool }
  | { kind: "kb" }
  | { kind: "skill" }
  /** 助手自带的能力（文件 / 命令行 / 技能脚本 / 建技能 / 建工具）。 */
  | { kind: "builtin"; cap: Capability }

const FUNC_NAME_BAD = /[^A-Za-z0-9_-]/g

function sanitizeFuncName(s: string, max: number): string {
  const cleaned = (s ?? "").replace(FUNC_NAME_BAD, "_").replace(/^_+/, "")
  return (cleaned || "x").slice(0, max)
}

/** MCP 工具在模型眼里的函数名（带服务器前缀，避免和快捷指令工具重名）。 */
export function mcpFunctionName(server: McpServer, toolName: string): string {
  return sanitizeFuncName(`mcp_${server.id || server.name}_${toolName}`, 64)
}

/**
 * 合并各路工具，生成发给模型的 tools 数组，并记下函数名到执行目标的映射：
 *   - 快捷指令工具（单向触发；配了回传才有结果）
 *   - MCP 工具（远程 HTTP，有真返回值）
 *   - 内置的本地知识库检索（离线全文检索，有真返回值）
 *   - 内置的技能读取（渐进式披露，有真返回值）
 *   - 助手自带的能力（文件读写 / 命令行 / 技能脚本 / 建技能 / 建快捷指令工具），
 *     在设置页「能力」里逐个授权后才会出现
 * 连不上的 MCP 服务器只跳过它的工具，不会打断本轮对话。
 */
async function buildToolSpecs(
  cfg: AgentConfig,
  workspaceName = "default",
): Promise<{ specs: any[]; routes: Map<string, ToolRoute> }> {
  const specs: any[] = []
  const routes = new Map<string, ToolRoute>()
  const used = new Set<string>()

  const take = (base: string): string => {
    let name = base
    let i = 2
    while (used.has(name)) {
      name = (base.slice(0, 60) + "_" + i).slice(0, 64)
      i += 1
    }
    used.add(name)
    return name
  }

  for (const t of cfg.tools ?? []) {
    if (!t?.name) continue
    const name = take(t.name)
    routes.set(name, { kind: "shortcut", tool: t })
    specs.push({
      type: "function",
      function: { name, description: toolDescription(t), parameters: toolParameters(t) },
    })
  }

  const lists = await collectMcpTools(cfg.mcpServers)
  for (const list of lists) {
    if (list.error) continue
    const server = (cfg.mcpServers ?? []).find((s) => s.id === list.serverId)
    if (!server) continue
    for (const tool of list.tools) {
      const name = take(mcpFunctionName(server, tool.name))
      routes.set(name, { kind: "mcp", server, tool })
      specs.push({
        type: "function",
        function: {
          name,
          description: `[MCP · ${server.name || server.id}] ${tool.description || tool.name}`.slice(0, 1024),
          // MCP 服务器可能返回 null / {} / 无效 schema；补全为合法 OpenAPI schema 防止 LLM 传入非法参数
          parameters: (tool.inputSchema && typeof tool.inputSchema === "object" && Object.keys(tool.inputSchema).length > 0)
            ? tool.inputSchema
            : { type: "object", properties: {}, required: [] },
        },
      })
    }
  }

  // —— 内置工具：本地知识库（没导入过资料就不挂出来） ——
  if (cfg.kbEnabled) {
    const stats = kbStats()
    if (stats.chunks > 0) {
      const name = take("search_knowledge")
      routes.set(name, { kind: "kb" })
      specs.push({
        type: "function",
        function: {
          name,
          description:
            `在用户的本地知识库里检索资料（共 ${stats.docs} 份资料、${stats.chunks} 个片段），` +
            "离线全文检索（关键词匹配），" +
            "返回最相关的几段原文。用户的问题可能和他自己的资料有关时先查一下，再以原文为准回答，并说明来自哪份文件；查不到就说没找到。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "检索用的关键词或问题，中文自然语言即可" },
              topK: { type: "number", description: "返回几段，默认 5" },
            },
            required: ["query"],
          },
        },
      })
    }
  }

  // —— 内置工具：读取用户上传的 skill 详情 ——
  if (cfg.skillsEnabled && skillsPrompt()) {
    const name = take("read_skill")
    routes.set(name, { kind: "skill" })
    specs.push({
      type: "function",
      function: {
        name,
        description:
          "读出用户上传的某个技能的完整说明（SKILL.md 全文 + 附件清单）。" +
          "要用某个技能时先用这个工具读全文，再严格照做。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "技能名，取系统提示里列出的名称" },
          },
          required: ["name"],
        },
      },
    })
  }

  // —— 助手自带的能力（文件 / 命令行 / 技能脚本 / 建技能 / 建工具）——
  // 在设置页「能力」里逐个授权后才会挂出来，默认一个都没有。
  let caps: Capability[] = []
  try {
    caps = capabilitiesFor(cfg, workspaceName)
  } catch {
    caps = []
  }
  for (const cap of caps) {
    const name = take(cap.name)
    routes.set(name, { kind: "builtin", cap })
    specs.push({
      type: "function",
      function: { name, description: cap.description, parameters: cap.parameters },
    })
  }

  return { specs, routes }
}

/**
 * 构造触发真实快捷指令的 URL。
 * 官方形式是 `shortcuts://run-shortcut?name=X&input=text&text=Y`：
 * 只有 `input=text` 才会把 `text` 当作「快捷指令输入」传进去；
 * 直接写 `input=<内容>`（早期版本）是收不到的。
 * 无参数时不带 input，快捷指令就以「无输入」运行。
 *
 * 设置页的「试跑」也走这里，保证两处拼出来的链接永远一样。
 */
export function shortcutRunURL(shortcutName: string, inputText?: string): string {
  const name = (shortcutName ?? "").trim()
  if (!name) return ""
  const base = "shortcuts://run-shortcut?name=" + encodeURIComponent(name)
  if (!inputText) return base
  return base + "&input=text&text=" + encodeURIComponent(inputText)
}

/** 链接超过这个长度就改用剪贴板传输入（中文编码后会膨胀，长消息很容易撑爆）。 */
const MAX_INLINE_URL = 1900

/**
 * 真正把快捷指令拉起来。
 *
 * 四个坑都在这里兜住：
 *   ① `Safari.openURL` 返回 true 只代表「系统收下了链接」，名字差一个字时 iOS 是
 *      **静默失败**的（界面什么都不发生，返回仍然 true）；
 *   ② 脚本在**后台**跑（快捷指令里用「运行脚本」）时，iOS 不允许后台进程把别的
 *      App 拉到前台，`openURL` 直接失败 —— 所以快捷指令要用
 *      `scripting://run/智能体?message=…` 把 App 拉到前台再跑（见下）；
 *   ③ 输入太长（中文经 URL 编码膨胀 9 倍，几百字就上万字符）时系统会丢掉链接，
 *      所以超长输入改走 `input=clipboard`（先把 JSON 写进剪贴板）；
 *   ④ 少数 iOS 版本只认 `shortcuts://x-callback-url/run-shortcut` 形式。
 */
async function triggerShortcut(
  tool: AgentTool,
  inputText: string,
): Promise<{ ok: boolean; url: string; error: string; viaClipboard: boolean }> {
  const inline = shortcutRunURL(tool.shortcutName ?? "", inputText)
  if (!inline) return { ok: false, url: "", error: "缺少快捷指令名", viaClipboard: false }

  const viaClipboard = !!inputText && inline.length > MAX_INLINE_URL
  const primary = viaClipboard
    ? shortcutRunURL(tool.shortcutName ?? "") + "&input=clipboard"
    : inline
  if (viaClipboard) {
    try {
      await Pasteboard.setString(inputText)
    } catch {
      // 写不进剪贴板就只能赌 URL 形式
    }
  }

  const candidates = [primary]
  if (primary.indexOf("shortcuts://run-shortcut") === 0) {
    candidates.push(primary.replace("shortcuts://run-shortcut", "shortcuts://x-callback-url/run-shortcut"))
  }

  let lastError = ""
  for (const candidate of candidates) {
    try {
      if (await Safari.openURL(candidate)) return { ok: true, url: candidate, error: "", viaClipboard }
      lastError = "系统拒绝了这条链接"
    } catch (e: any) {
      lastError = e?.message ?? String(e)
    }
  }
  console.log("打开快捷指令失败：" + lastError + " · " + primary)
  return { ok: false, url: primary, error: lastError, viaClipboard }
}

async function executeTool(
  toolCall: any,
  routes: Map<string, ToolRoute>,
  hooks: RunAgentHooks,
): Promise<{ text: string; step: ToolStep }> {
  const name = String(toolCall?.function?.name ?? "")
  const route = routes.get(name)
  if (!route) {
    const text = `未找到名为「${name}」的工具`
    return { text, step: makeStep("other", name, name, "", text, false, 0) }
  }

  let args: any = {}
  try {
    args = JSON.parse(toolCall?.function?.arguments || "{}")
  } catch {
    args = {}
  }
  if (args == null || typeof args !== "object" || Array.isArray(args)) args = {}
  const keys = Object.keys(args)

  // —— 助手自带的能力：文件 / 命令行 / 技能脚本 / 建技能 / 建工具 ——
  if (route.kind === "builtin") {
    const cap = route.cap
    const argsText = keys.length > 0 ? JSON.stringify(args) : ""
    hooks.onEvent?.({ type: "tool", kind: cap.kind, name, target: cap.label, argsText })
    const t0 = Date.now()
    let res: CapResult
    try {
      res = await cap.run(args)
    } catch (e: any) {
      res = { ok: false, text: `执行失败：${e?.message ?? String(e)}` }
    }
    const step = makeStep(
      cap.kind,
      name,
      res.target || cap.label,
      res.argsText ?? argsText,
      res.text,
      res.ok,
      Date.now() - t0,
    )
    if (res.files && res.files.length > 0) step.files = res.files
    hooks.onStep?.(step)
    if (res.createdTools && res.createdTools.length > 0) hooks.onToolsCreated?.(res.createdTools)
    return { text: clipToolResult(res.text), step }
  }

  // —— MCP 工具：真的有返回值，直接原样交给模型 ——
  if (route.kind === "mcp") {
    const target = `${route.server.name || route.server.id} · ${route.tool.name}`
    const argsText = keys.length > 0 ? JSON.stringify(args) : ""
    hooks.onEvent?.({ type: "tool", kind: "mcp", name, target, argsText })
    const t0 = Date.now()
    const res = await callMcpTool(route.server, route.tool.name, args)
    const step = makeStep("mcp", name, target, argsText, res.text, res.ok, Date.now() - t0)
    hooks.onStep?.(step)
    return { text: clipToolResult(res.text), step }
  }

  // —— 本地知识库检索：真结果 ——
  if (route.kind === "kb") {
    const query = String(args.query ?? "").trim()
    const rawTop = Number(args.topK)
    const topK = rawTop > 0 ? Math.min(10, Math.floor(rawTop)) : 5
    hooks.onEvent?.({ type: "tool", kind: "kb", name, target: "本地知识库", argsText: query })
    const t0 = Date.now()
    let text = "没有给出检索关键词。"
    if (query) {
      const hits = searchKb(query, topK)
      text = formatKbHits(query, hits)
    }
    const step = makeStep("kb", name, "本地知识库", query, text, !!query, Date.now() - t0)
    hooks.onStep?.(step)
    return { text: clipToolResult(text), step }
  }

  // —— 技能：读全文 ——
  if (route.kind === "skill") {
    const key = String(args.name ?? args.skill ?? "").trim()
    const target = key || "技能"
    hooks.onEvent?.({ type: "tool", kind: "skill", name, target, argsText: key })
    const t0 = Date.now()
    const hit = readSkill(key)
    let text: string
    if (!hit) {
      const names = listSkills()
        .filter((s) => s.enabled)
        .map((s) => s.name)
      text = `没有找到名为「${key}」的技能。可用技能：${names.join("、") || "（无）"}`
    } else {
      const files = hit.files.filter((f) => f.toLowerCase() !== "skill.md")
      const parts = [`技能「${hit.meta.name}」的完整说明：`, hit.content]
      if (files.length > 0) parts.push(`\n该技能目录里的附件：${files.join("、")}`)
      text = parts.join("\n")
    }
    const step = makeStep("skill", name, target, key, text, !!hit, Date.now() - t0)
    hooks.onStep?.(step)
    return { text: clipToolResult(text), step }
  }

  // —— 快捷指令工具：默认单向触发；配了 returns 的会把结果回传回来 ——
  const tool = route.tool
  let cid: string | undefined
  let inputText = keys.length > 0 ? JSON.stringify(args) : ""
  if (tool.returns) {
    cid = String(toolCall?.id ?? "")
    if (!cid) {
      const text = "模型返回的工具调用缺少 tool_call_id，无法等待快捷指令回传。"
      const step = makeStep("shortcut", name, tool.shortcutName, inputText, text, false, 0)
      hooks.onStep?.(step)
      return { text, step }
    }
    const payload = { ...args, callId: cid }
    inputText = JSON.stringify(payload)
    addPending({ cid, toolName: name, shortcutName: tool.shortcutName, args: inputText })
  }
  hooks.onEvent?.({ type: "tool", kind: "shortcut", name, target: tool.shortcutName, argsText: inputText })

  const t0 = Date.now()
  // shortcutName 为空时 Safari.openURL("") 会静默「成功」，这里主动拦截
  if (!(tool.shortcutName ?? "").trim()) {
    if (cid) finishPending(cid)
    const step = makeStep("shortcut", name, "(空)", inputText, "快捷指令工具缺少 shortcutName，无法调用。", false, Date.now() - t0)
    hooks.onStep?.(step)
    return { text: "快捷指令工具缺少 shortcutName，无法调用。", step }
  }
  const opened = await triggerShortcut(tool, inputText)
  const ok = opened.ok
  let text: string
  if (!ok) {
    if (cid) finishPending(cid)
    text = `执行快捷指令「${tool.shortcutName}」失败（${opened.error || "打不开链接"}）。`
      + `如果名字和「快捷指令」App 里差一个字，系统是静默失败；`
      + `如果是用「运行脚本」在后台跑的，后台本来就打不开别的 App，`
      + `请让快捷指令用「打开 URL」调 \`scripting://run/智能体?message=…\` 把 App 拉到前台再跑。`
  } else if (tool.returns) {
    // 配了回调 URL：pending 已先落盘，快捷指令末尾「打开 URL」把结果送回来时再回填。
    // 这里不向模型补假的 role:"tool" 结果；本轮直接挂起，等 callback 带真实结果回来后再续跑。
    text = keys.length > 0
      ? `已触发快捷指令「${tool.shortcutName}」，传入参数：${inputText}，等待回传结果`
      : `已触发快捷指令「${tool.shortcutName}」（无参数），等待回传结果`
  } else {
    // 快捷指令是单向触发：这里必须明确告诉模型「拿不到结果」，
    // 否则它会顺着上下文编造一个执行结果。
    const tail = "。注意：这是单向触发，没有返回值：只说明已执行，不要编造结果。"
    text = keys.length > 0
      ? `已触发快捷指令「${tool.shortcutName}」，传入参数：${inputText}` + tail
      : `已触发快捷指令「${tool.shortcutName}」（无参数）` + tail
  }
  const step = makeStep("shortcut", name, tool.shortcutName, inputText, text, ok, Date.now() - t0)
  step.url = opened.url
  // 输入太长走了剪贴板：卡片上要说明白，否则用户不知道剪贴板被占用了
  if (opened.viaClipboard) step.args = inputText + "\n（这段是通过剪贴板传进去的）"
  if (cid) {
    step.cid = cid
    if (ok && tool.returns) step.pending = true
  }
  hooks.onStep?.(step)
  return { text, step }
}

async function runAgentLoop(
  messages: LLMMessage[],
  cfg: AgentConfig,
  hooksArg?: HooksArg,
  opts?: { workspaceName?: string; control?: RunControl },
): Promise<{ reply: string; assistant: ChatMessage; steps: ToolStep[]; reasoning: string; rounds: number }> {
  const hooks = normalizeHooks(hooksArg)
  const control = opts?.control
  const maxRounds = Math.max(1, cfg.maxToolRounds || 3)
  // 全局截止时间：单次 runAgent 最长不超过 3 分钟（防止任何环节挂死）
  const deadline = Date.now() + 180_000
  // 工具清单在每轮对话开始时取一次（MCP 那边有 5 分钟缓存）。
  const { specs, routes } = await buildToolSpecs(cfg, opts?.workspaceName)
  const steps: ToolStep[] = []
  const reasonings: string[] = []
  let reply = ""
  let resolved = false
  let interrupted = false
  /** 流式已吐出的正文：用户中途点停止时用它当这一轮的回复，别把已生成的内容丢掉。 */
  let streamedText = ""
  /** 服务端一旦表现出不支持流式，本轮剩下的请求就都退回一次性。 */
  let streaming = true
  let usage: TokenUsage | undefined
  let awaitingExternalTool = false
  /** 模型往返次数（含工具轮），诊断页用它看「这个问题模型绕了几圈」。 */
  let rounds = 0

  const addUsage = (u?: TokenUsage) => {
    if (!u) return
    if (!usage) {
      usage = { ...u }
      return
    }
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      totalTokens: usage.totalTokens + u.totalTokens,
      reasoningTokens: (usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0) || undefined,
      cachedInputTokens: (usage.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0) || undefined,
    }
  }

  // DeepSeek 思考模式把推理放在 reasoning_content（有的兼容实现叫 reasoning）。
  const noteReasoning = (msg: any) => {
    const chunk = msg?.reasoning_content ?? msg?.reasoning
    if (typeof chunk === "string" && chunk.trim()) {
      const t = chunk.trim()
      reasonings.push(t)
      hooks.onReasoning?.(t)
    }
  }

  /** 向模型要一轮回复：优先流式（打字机），服务端不支持就退回一次性请求。 */
  const ask = async (toolSpecs: any[] | null): Promise<any> => {
    if (streaming) {
      let firstSegment = true
      try {
        const out = await callDeepSeekStream(messages, cfg, toolSpecs, (d) => {
          if (d.type === "reasoning") {
            const newSegment = firstSegment
            firstSegment = false
            hooks.onDelta?.({ type: "reasoning", content: d.content, newSegment })
            return
          }
          streamedText += d.content
          hooks.onDelta?.(d)
        }, control)
        addUsage(out.usage)
        const t = out.reasoning.trim()
        if (t) {
          reasonings.push(t)
          hooks.onReasoning?.(t)
        }
        return out.message ?? {}
      } catch (e: any) {
        // 用户点了停止：往上抛，由外层收尾（保留已经生成的内容）。
        if (e?.aborted) throw e
        // 接口本身报错（401 / 模型名不对…）直接抛给用户；其余当成「这个服务端不支持流式」。
        if (e?.httpStatus) throw e
        streaming = false
        hooks.onDelta?.({ type: "text", content: "", reset: true })
      }
    }

    const data = await callDeepSeek(messages, cfg, toolSpecs, control)
    addUsage(readUsage(data?.usage))
    const msg = data?.choices?.[0]?.message ?? {}
    noteReasoning(msg)
    return msg
  }

  // 同一个工具 + 同一套参数，最多真的执行 3 次；模型原地打转时打断它，避免烧额度。
  const MAX_SAME_CALL = 3
  const callCounts = new Map<string, number>()

  try {
    for (let i = 0; i < maxRounds; i++) {
      if (control?.aborted) {
        interrupted = true
        break
      }
      if (Date.now() > deadline) break

      const msg = await ask(specs)
      rounds += 1
      const toolCalls: any[] = msg.tool_calls ?? []

      if (toolCalls.length === 0) {
        reply = msg.content ?? ""
        resolved = true
        break
      }

      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls,
      })

      let blockedAll = true
      for (const tc of toolCalls) {
        if (control?.aborted) {
          interrupted = true
          break
        }
        if (Date.now() > deadline) break
        const sig = `${tc?.function?.name ?? ""}:${tc?.function?.arguments ?? "{}"}`
        const used = callCounts.get(sig) ?? 0
        if (used >= MAX_SAME_CALL) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `同一个工具用同样的参数已经调用过 ${MAX_SAME_CALL} 次，这次跳过。请换参数、换工具，或直接回答用户。`,
          })
          continue
        }
        callCounts.set(sig, used + 1)
        blockedAll = false
        const { text, step } = await executeTool(tc, routes, hooks)
        steps.push(step)
        if (step.pending && !step.callback) {
          awaitingExternalTool = true
          continue
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: text })
      }
      if (interrupted) break
      if (awaitingExternalTool) {
        reply = ""
        resolved = true
        break
      }
      // 所有工具调用都被「重复调用守卫」挡下了：别再让模型空转，直接收尾。
      if (blockedAll) break
    }
  } catch (e: any) {
    if (!e?.aborted) throw e
    interrupted = true
  }

  if (interrupted) {
    reply = streamedText.trim() || "（已停止生成）"
    resolved = true
  }

  if (!resolved) {
    if (Date.now() > deadline) {
      reply = "执行超时，已自动中止。"
      resolved = true
    } else {
      const msg = await ask(null)
      reply = msg.content ?? ""
    }
  }

  const reasoning = clip(reasonings.join("\n\n"), REASONING_CLIP)
  const assistant: ChatMessage = { role: "assistant", content: reply, at: Date.now() }
  if (reasoning) assistant.reasoning = reasoning
  if (steps.length > 0) {
    assistant.steps = steps
  }
  if (usage) assistant.usage = usage

  return { reply, assistant, steps, reasoning, rounds }
}

/** 跑一轮的公共出口：计时、统计工具成败、写诊断（成功失败都记），再把结果交回调用方。 */
async function runLogged(
  cfg: AgentConfig,
  messages: LLMMessage[],
  hooksArg: HooksArg,
  opts: { workspaceName?: string; control?: RunControl; source?: RunSource } | undefined,
  wrap: (out: { reply: string; assistant: ChatMessage; steps: ToolStep[]; reasoning: string }) => {
    reply: string
    newHistory: ChatMessage[]
  },
): Promise<{ reply: string; newHistory: ChatMessage[]; steps: ToolStep[]; reasoning: string }> {
  const startedAt = Date.now()
  try {
    const out = await runAgentLoop(messages, cfg, hooksArg, opts)
    logRun({
      at: Date.now(),
      source: opts?.source ?? "chat",
      ok: true,
      ms: Date.now() - startedAt,
      rounds: out.rounds,
      tools: out.steps.length,
      failedTools: out.steps.filter((s) => !s.ok).length,
      aborted: opts?.control?.aborted || undefined,
      inputTokens: out.assistant.usage?.inputTokens,
      outputTokens: out.assistant.usage?.outputTokens,
      cachedInputTokens: out.assistant.usage?.cachedInputTokens,
      model: cfg.model,
      provider: activeProvider(cfg)?.name,
      host: hostOf(cfg.baseUrl),
    })
    const { reply, newHistory } = wrap(out)
    return { reply, newHistory, steps: out.steps, reasoning: out.reasoning }
  } catch (e: any) {
    logRun({
      at: Date.now(),
      source: opts?.source ?? "chat",
      ok: false,
      ms: Date.now() - startedAt,
      rounds: 0,
      tools: 0,
      failedTools: 0,
      aborted: opts?.control?.aborted || undefined,
      model: cfg.model,
      provider: activeProvider(cfg)?.name,
      host: hostOf(cfg.baseUrl),
      error: clipError(e),
    })
    throw e
  }
}

export async function runAgent(
  userText: string,
  cfg: AgentConfig,
  history: ChatMessage[],
  hooksArg?: HooksArg,
  /** images：这次输入附带的图片（磁盘路径），会转成 data URL 一起发给模型。 */
  /** workspaceName：当前会话绑定的工作区目录名。 */
  /** control：用户在界面上点「停止」时把 aborted 置 true。 */
  /** source：谁发起的（聊天 / 通知 / 记忆压缩），只用于诊断统计。 */
  opts?: { images?: string[]; workspaceName?: string; control?: RunControl; source?: RunSource },
): Promise<{ reply: string; newHistory: ChatMessage[]; steps: ToolStep[]; reasoning: string }> {
  const messages = buildMessages(cfg, history, userText)
  // 把当前这条用户消息的图片塞进 buildMessages 末尾那条 plain text user 消息：
  // 如果有图片就把 content 换成多模态数组。
  if (opts?.images && opts.images.length > 0 && messages.length > 0) {
    const last = messages[messages.length - 1]
    if (last.role === "user" && typeof last.content === "string") {
      last.content = multimodalContent(last.content, opts.images)
    }
  }

  return runLogged(cfg, messages, hooksArg, opts, (out) => {
    const userMsg: ChatMessage = { role: "user", content: userText, at: Date.now() }
    if (opts?.images && opts.images.length > 0) userMsg.images = opts.images
    return {
      reply: out.reply,
      newHistory: [...history, userMsg, out.assistant],
    }
  })
}

/** 快捷指令 callback 已把结果回填到历史 step 后，用标准 tool role 继续生成最终答复。 */
export async function continueAgentFromHistory(
  cfg: AgentConfig,
  history: ChatMessage[],
  hooksArg?: HooksArg,
  opts?: { workspaceName?: string; control?: RunControl; source?: RunSource },
): Promise<{ reply: string; newHistory: ChatMessage[]; steps: ToolStep[]; reasoning: string }> {
  const messages = buildMessages(cfg, history)
  return runLogged(cfg, messages, hooksArg, opts, (out) => ({
    reply: out.reply,
    newHistory: [...history, out.assistant],
  }))
}
