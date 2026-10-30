/**
 * 智能体的「手脚」：文件读写 / 命令行 / 技能脚本执行 / 技能创建 / 快捷指令工具配置。
 *
 * 这一层只做两件事：
 *   ① `capabilitiesFor(cfg)` —— 按设置页的开关，告诉 core/agent/core 现在该挂哪些工具；
 *   ② 每个工具的 `run(args)` —— 真正干活，返回一段给模型看的文本（外加过程卡片的元信息）。
 *
 * 安全约定（默认全关，逐个在「设置 → 能力」里授权）：
 *   - 文件路径折叠 `..` 之后必须落在 App 的 Documents / App Group Documents 内，越界直接拒绝；
 *   - 命令行只放行白名单里的第一个命令词，管道 / 重定向 / 命令串联 / 命令替换一律拒绝
 *     （本机 iOS shell 本来也不支持），明显会大范围删文件的写法也拒绝；
 *   - 每次执行都有超时，输出统一截断，免得一次命令把上下文撑爆。
 */
import { AgentConfig, AgentConfigToggle, ensureWorkspace } from "./store"
import { Capability } from "./caps/types"
import { capListFiles, capReadFile, capWriteFile, capDeleteFile } from "./caps/files"
import { capRunCli } from "./caps/cli"
import { capRunSkillScript, capCreateSkill } from "./caps/skills"
import { capCreateShortcutTool } from "./caps/shortcut"

// 类型与路径常量继续从这里转出去，调用方（core.ts 等）不用改。
export { type CapKind, type CapResult, type Capability } from "./caps/types"
export { WORKSPACE_DIR } from "./caps/common"

// ———————————————————————— 对外 ——

/** 当前开着哪些能力（按设置页的开关过滤，默认全关）。 */
export function capabilitiesFor(cfg: AgentConfig, workspaceName = "default"): Capability[] {
  const on = (k: AgentConfigToggle): boolean => (cfg as any)?.[k] === true
  const workspaceDir = ensureWorkspace(workspaceName)
  const list: Capability[] = []
  if (on("fsEnabled")) {
    list.push(
      capListFiles(workspaceDir),
      capReadFile(workspaceDir),
      capWriteFile(workspaceDir),
      capDeleteFile(workspaceDir),
    )
  }
  if (on("cliEnabled")) list.push(capRunCli(workspaceDir))
  if (on("skillScriptEnabled") && cfg.skillsEnabled !== false) list.push(capRunSkillScript())
  if (on("skillCreateEnabled")) list.push(capCreateSkill())
  if (on("toolCreateEnabled")) list.push(capCreateShortcutTool())
  return list
}
