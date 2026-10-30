/**
 * 快捷指令工具的参数声明 → 给模型看的 JSON schema / 说明文案 / 合法函数名。
 */
import { AgentTool, ToolParamSpec } from "./types"

/** 解析「参数」文本：每行一个 `字段名=说明`。 */
export function parseToolParams(hint?: string): ToolParamSpec[] {
  const out: ToolParamSpec[] = []
  for (const line of (hint ?? "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[=＝:：]\s*(.*)$/)
    if (!m) continue
    out.push({ name: m[1], description: m[2].trim() })
  }
  return out
}

/** 一个工具最终生效的参数声明：结构化 params 优先，退回「一行一个」的文本写法。 */
export function toolParamSpecs(t: AgentTool): ToolParamSpec[] {
  if (t.params && t.params.length > 0) return t.params
  return parseToolParams(t.paramsHint)
}

const PARAM_TYPES = ["string", "number", "integer", "boolean"]

/** 单个参数 → JSON schema 片段。 */
function paramToSchema(s: ToolParamSpec): Record<string, any> {
  const ty = PARAM_TYPES.indexOf(String(s.type ?? "string")) >= 0 ? String(s.type ?? "string") : "string"
  const out: Record<string, any> = { type: ty }
  const bits: string[] = []
  if (s.description) bits.push(s.description)
  if (s.enum && s.enum.length > 0) {
    out.enum = s.enum.slice()
    bits.push("取值：" + s.enum.join(" / "))
  }
  if (s.default !== undefined && s.default !== null && String(s.default) !== "") {
    out.default = s.default
    bits.push("默认：" + String(s.default))
  }
  if (s.required === false) bits.push("可选，没提到就别传")
  out.description = bits.join("；")
  return out
}

/** 送给模型看的 JSON schema（无参数时是一个空对象）。 */
export function toolParameters(t: AgentTool): Record<string, any> {
  if (t.parameters && Object.keys(t.parameters).length > 0) return t.parameters
  const specs = toolParamSpecs(t)
  if (specs.length === 0) return { type: "object", properties: {} }
  const properties: Record<string, any> = {}
  const required: string[] = []
  for (const s of specs) {
    properties[s.name] = paramToSchema(s)
    if (s.required !== false) required.push(s.name)
  }
  const out: Record<string, any> = { type: "object", properties }
  if (required.length > 0) out.required = required
  return out
}

/** 参数在说明里的简写：name / name? / name:number。 */
function paramSummary(s: ToolParamSpec): string {
  const ty = s.type && s.type !== "string" ? ":" + s.type : ""
  const opt = s.required === false ? "?" : ""
  return s.name + opt + ty
}

/** 送给模型看的工具说明（含参数名提醒 + 单向/回传声明）。 */
export function toolDescription(t: AgentTool): string {
  const desc = (t.description ?? "").trim()
  const specs = toolParamSpecs(t)
  const params =
    specs.length === 0
      ? ""
      : "\n调用时以 JSON 对象返回参数，字段名：" + specs.map(paramSummary).join("、")
  const tail = t.returns
    ? "\n（这个快捷指令会把执行结果回传：先说明「已触发、结果稍后到」，收到回传内容再作答；不要编造结果。）"
    : "\n（单向触发：没有返回值，只说明已执行，不要编造结果。）"
  return desc + params + tail
}

const FUNC_NAME_CHARS = /[^A-Za-z0-9_-]+/g

/** 生成模型看到的函数名（只允许 [A-Za-z0-9_-]，去重，≤ 64 字符）。 */
export function makeToolFunctionName(
  rawName: string,
  shortcutName: string,
  index: number,
  used: Set<string>,
): { name: string; note?: string } {
  const clean = (s: string) => s.replace(FUNC_NAME_CHARS, "_").replace(/^[_-]+|[_-]+$/g, "")
  let base = clean(rawName)
  let note: string | undefined
  if (!base) {
    base = clean(shortcutName)
    if (base) note = `${shortcutName}：没写 name，用「${base}」做函数名`
  }
  if (!base) base = "tool" + (index + 1)
  if (base.length > 64) base = base.slice(0, 64)
  let name = base
  let i = 2
  while (used.has(name)) {
    name = base + "_" + i
    i += 1
  }
  used.add(name)
  if (name !== base && !note) note = `${rawName}：函数名重复，改用「${name}」`
  return { name, note }
}

/** 快捷指令侧要两次配置 —— 给用户复制到「快捷指令」编辑器里的协议说明。 */
export function shortcutProtocolText(scriptName: string): string {
  const name = (scriptName ?? "").trim() || "智能体"
  return [
    "【智能体 → 快捷指令：怎么接参数】",
    "1. 快捷指令开头加「接收输入」（输入类型：文本）。",
    "2. 加「从输入获取词典」，输入取「快捷指令输入」。",
    "3. 每个参数加一个「获取词典值」，键名就是参数名（destination、mode…）。",
    "",
    "【快捷指令 → 智能体：怎么把结果传回来（可选）】",
    "最后加三个动作：",
    "1. 「URL 编码」：输入 = 要回传的内容（文本）。",
    "2. 「文本」：内容写 ",
    "   scripting://run/" + name + "?result=",
    "   紧接着插入上一步「URL 编码」的结果（中间不要有空格或换行）。",
    "3. 「打开 URL」：输入取上一步的文本。",
    "",
    "对应地把工具的 returns 打开（或“回传结果”开关）。",
    "注意：整条 URL 越短越好（建议 2000 字符以内），结果太长就只回传摘要。",
    "注意：回调会同时把 Scripting 拉回前台；结果到达后智能体会自动接着回复你。",
    "注意：回传必须带本次输入中的 callId；它用于精确匹配等待中的工具调用。",
    "      tool=快捷指令名 仅用于展示，不能替代 callId。",
    "注意：回传记录会在磁盘上留 10 分钟，App 中途被关掉也接得上。",
  ].join("\n")
}
