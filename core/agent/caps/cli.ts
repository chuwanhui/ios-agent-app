/**
 * 命令行能力：只放行白名单里的命令，一次一条，不支持管道 / 重定向 / 串联。
 */
import { Capability, fail } from "./types"
import {
  CLI_DEFAULT_TIMEOUT, CLI_MAX_TIMEOUT, clampInt, clip, displayWorkspacePath, ensureDir, resolveWorkspacePath,
} from "./common"

// —— 命令行 ——

/** 放行的命令（ios_system 在进程内注册的那批）。 */
export const CLI_COMMANDS = [
  "python3", "python", "pip3", "pip", "scripting-ts", "node", "npm", "pnpm",
  "ls", "cat", "head", "tail", "grep", "sed", "awk", "sort", "uniq", "wc",
  "find", "du", "stat", "md5", "cksum", "tr", "diff", "tee", "base64",
  "mkdir", "touch", "cp", "mv", "rm", "chmod", "ln", "readlink",
  "echo", "date", "env", "printenv", "which", "pwd", "say",
  "tar", "gzip", "gunzip", "zip", "unzip", "curl", "ffmpeg", "ffprobe",
]

/** 一眼就很危险的写法。 */
export const CLI_BLOCKED: RegExp[] = [
  /\brm\s+-[A-Za-z]*[rR][A-Za-z]*f?\s+(\/|~|\*)/,
  /\b(mv|cp)\s+[^\s]*\/\s*$/,
]

/** 参数一律使用 POSIX 单引号，避免双引号中的 `$()` / 反引号被 shell 展开。 */
export function quoteArg(s: string): string {
  const t = String(s ?? "")
  return "'" + t.replace(/'/g, "'\\\"'\\\"'") + "'"
}

/** 这条命令能不能跑；返回 null 表示放行。 */
export function checkCommand(cmd: string): string | null {
  const text = (cmd ?? "").trim()
  if (!text) return "命令是空的。"
  if (/[|;&><`]/.test(text) || /\$\(/.test(text)) {
    return "本机的命令行不支持管道 | 、重定向 > 、命令串联 && / ; 和命令替换 $( )，请改成一次跑一条简单命令。"
  }
  if (/(^|[\\/\s"'(=])\.\.(?=($|[\\/\s"'))]))/.test(text)) {
    return "命令不能用 .. 离开当前会话的工作区。"
  }
  const first = text.split(/\s+/)[0]
  const base = first.split("/").pop() || first
  if (CLI_COMMANDS.indexOf(base) < 0) {
    return `不允许执行「${base}」。可用的命令：${CLI_COMMANDS.join("、")}。`
  }
  for (const re of CLI_BLOCKED) {
    if (re.test(text)) return "这条命令看起来会大范围删改文件，已拒绝。真要删就用 delete_file 明确指定路径。"
  }
  return null
}

export function capRunCli(workspaceDir: string): Capability {
  return {
    toggle: "cliEnabled",
    kind: "cli",
    name: "run_cli",
    label: "命令行",
    description:
      "在手机本地跑一条命令行命令，并拿到它的输出（stdout + stderr 合在一起）。" +
      `可用的命令：${CLI_COMMANDS.join("、")}（都跑在 App 内部，没有 git、bash，也不支持管道 / 重定向 / 后台进程）。` +
      "工作目录默认是助手工作区；命令是相对工作区执行的。要算什么、转什么格式、批量改文件都可以用它，" +
      "但每次只跑一条命令，超时大约 " + CLI_DEFAULT_TIMEOUT + " 秒。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的完整命令，例如 python3 -c \"print(1+1)\"" },
        cwd: { type: "string", description: "工作目录（相对工作区），默认工作区根目录" },
        timeout: { type: "number", description: `超时秒数，默认 ${CLI_DEFAULT_TIMEOUT}，最多 ${CLI_MAX_TIMEOUT}` },
      },
      required: ["command"],
    },
    run: async (args) => {
      const command = String(args?.command ?? "").trim()
      const bad = checkCommand(command)
      if (bad) return fail(bad)
      const cwd = resolveWorkspacePath(args?.cwd ?? "", workspaceDir)
      if (!cwd) return fail("工作目录不允许：只能在当前会话的工作区内执行命令。")
      ensureDir(cwd)
      const timeout = clampInt(args?.timeout, 1, CLI_MAX_TIMEOUT, CLI_DEFAULT_TIMEOUT)
      let res: any
      try {
        res = await Shell.run(command, { cwd, timeout })
      } catch (e: any) {
        return fail(`执行失败：${e?.message ?? String(e)}`)
      }
      const out = String(res?.output ?? "")
      const code = Number(res?.exitCode ?? 0)
      const head =
        `$ ${command}` +
        (cwd === workspaceDir ? "" : `\n（工作目录：${displayWorkspacePath(cwd, workspaceDir)}）`)
      const tail = res?.timedOut
        ? `\n[超时 ${timeout} 秒被终止，输出可能不完整]`
        : `\nexit ${code}`
      return {
        text: clip(`${head}${tail}\n${out || "（没有任何输出）"}`),
        ok: !res?.timedOut && code === 0,
        target: command.length > 40 ? command.slice(0, 40) + "…" : command,
        argsText: cwd === workspaceDir ? command : `${command}  @ ${displayWorkspacePath(cwd, workspaceDir)}`,
      }
    },
  }
}
