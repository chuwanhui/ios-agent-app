/**
 * 快捷指令工具能力：帮用户在配置里登记一条新的本地快捷指令工具。
 */
import { Script } from "scripting"
import { AgentTool } from "../types"
import { loadConfig, saveConfig } from "../config_store"
import { makeToolFunctionName, shortcutProtocolText } from "../tool_schema"
import { Capability, fail, normalizeParams } from "./types"

/** 回传 URL 里用的脚本名（就是本脚本在 Scripting 里的名字，兜底「智能体」）。 */
export const CALLBACK_SCRIPT_NAME = (() => {
  try {
    const n: any = (Script as any)?.name
    // CLI 调试时 name 是「scripting-ts run」，只有真机上才是脚本名
    if (typeof n === "string" && n.trim() && n.indexOf("scripting-ts") < 0) return n.trim()
    return "智能体"
  } catch {
    return "智能体"
  }
})()

// —— 快捷指令工具配置 ——

export function capCreateShortcutTool(): Capability {
  return {
    toggle: "toolCreateEnabled",
    kind: "shortcut",
    name: "create_shortcut_tool",
    label: "快捷指令工具",
    description:
      "帮用户在助手里登记一个「本地快捷指令工具」，登记完你就能像调用其它工具那样调用它。" +
      "注意：这一步只是写配置，用户手机里那条快捷指令还得用户自己在『快捷指令』App 里建出来（名字必须一模一样），" +
      "所以调用这个工具之后，你必须把「怎么在快捷指令 App 里建这条快捷指令」的步骤讲给用户听。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "工具名（模型调用时用的函数名，英文 / 拼音最好）" },
        shortcutName: { type: "string", description: "对应的快捷指令名（要跟用户手机里那条一模一样）" },
        description: { type: "string", description: "这个工具干什么、什么时候用" },
        params: {
          type: "array",
          description: "参数声明（可选）：快捷指令会收到一个 JSON 文本输入",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "参数名" },
              description: { type: "string", description: "参数说明" },
              type: { type: "string", description: "string / number / integer / boolean" },
              required: { type: "boolean", description: "是否必填，默认 true" },
              enum: { type: "array", description: "限定取值", items: { type: "string" } },
            },
            required: ["name"],
          },
        },
        returns: { type: "boolean", description: "这条快捷指令末尾会不会把结果回传给助手（需要用户按协议配回调 URL），默认否" },
      },
      required: ["name", "shortcutName", "description"],
    },
    run: async (args) => {
      const rawName = String(args?.name ?? "").trim()
      const shortcutName = String(args?.shortcutName ?? "").trim() || rawName
      const description = String(args?.description ?? "").trim()
      if (!rawName) return fail("工具得有名字。")
      if (!description) return fail("要给一句说明，否则模型以后不知道该在什么时候调用它。")

      const cfg = loadConfig()
      const used = new Set((cfg.tools ?? []).map((t) => t.name))
      // makeToolFunctionName 已负责去重并登记最终名字；再次检查会把新名字误判为重复。
      const { name, note } = makeToolFunctionName(rawName, shortcutName, used.size, used)

      const tool: AgentTool = { name, shortcutName, description }
      const params = normalizeParams(args?.params)
      if (params) tool.params = params
      if (args?.returns === true) tool.returns = true

      try {
        await saveConfig({ ...cfg, tools: [...(cfg.tools ?? []), tool] })
      } catch (e: any) {
        return fail(`写配置失败：${e?.message ?? String(e)}`)
      }

      const detail = [
        `- 工具名（模型看到）：${name}`,
        `- 对应快捷指令：${shortcutName}`,
        params ? `- 参数：${params.map((p) => p.name + (p.required === false ? "（可选）" : "")).join("、")}` : "- 参数：无",
        `- 等回传：${tool.returns ? "会（用户要按协议配回调）" : "不会（单向触发）"}`,
      ].join("\n")

      const guide = [
        "【接下来用户要做的（务必转述给用户）】",
        "1. 打开『快捷指令』App → 右上角 + → 新建一条快捷指令。",
        `2. 把它重命名为「${shortcutName}」（必须和上面一模一样，差一个字都调不到）。`,
        "3. 按下面的协议接线：",
        "",
        shortcutProtocolText(CALLBACK_SCRIPT_NAME),
        "",
        tool.returns
          ? "（这条工具标了「等回传」：用户必须把末尾三个动作加上，否则助手会一直等不到结果。）"
          : "（这条工具是单向触发：用户不用配回调，助手也不会拿到结果。）",
      ].join("\n")

      return {
        text:
          `✅ 已把快捷指令工具登记进助手配置（用户下次打开设置页也能看到、能改）。\n` +
          detail +
          (note ? `\n（提示：${note}）` : "") +
          `\n\n${guide}`,
        ok: true,
        target: shortcutName,
        argsText: name,
        createdTools: [name],
      }
    },
  }
}
