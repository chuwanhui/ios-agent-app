/**
 * 能力（工具）的公共类型与参数整理。
 */
import { AgentConfigToggle, ToolParamSpec } from "../store"

/** 一次能力调用的结果。 */
export interface CapResult {
  /** 交给模型看的文本。 */
  text: string
  ok: boolean
  /** 过程卡片上的执行目标（不传就用工具标签）。 */
  target?: string
  /** 过程卡片上的参数摘要（不传就用 JSON）。 */
  argsText?: string
  /** 这次动作产出 / 改动的文件（绝对路径）：聊天页据此画「产出文件」卡片。 */
  files?: string[]
  /** 新建的快捷指令工具名：聊天页要把它并进当前会话的挂载。 */
  createdTools?: string[]
}

/** 能力的类别（决定过程卡片上的小标题）。 */
export type CapKind = "fs" | "cli" | "skill" | "shortcut"

export interface Capability {
  /** 控制它的设置开关。 */
  toggle: AgentConfigToggle
  kind: CapKind
  /** 模型看到的函数名。 */
  name: string
  description: string
  parameters: Record<string, any>
  /** 过程卡片上的默认目标文案。 */
  label: string
  run: (args: any) => Promise<CapResult>
}

const TYPES = ["string", "number", "integer", "boolean"]

/** 模型给的工具参数声明 → ToolParamSpec[]（坏数据直接丢掉，不报错）。 */
export function normalizeParams(raw: any): ToolParamSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ToolParamSpec[] = []
  for (const item of raw) {
    const p: any = typeof item === "string" ? { name: item } : item
    const name = String(p?.name ?? "").trim()
    if (!name) continue
    const spec: ToolParamSpec = {
      name,
      description: String(p?.description ?? "").trim(),
    }
    const ty = String(p?.type ?? "")
    if (TYPES.indexOf(ty) >= 0) spec.type = ty as ToolParamSpec["type"]
    if (p?.required === false) spec.required = false
    if (Array.isArray(p?.enum) && p.enum.length > 0) spec.enum = p.enum.map((x: any) => String(x))
    out.push(spec)
  }
  return out.length > 0 ? out : undefined
}

export function fail(text: string): CapResult {
  return { text, ok: false }
}
