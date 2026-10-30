/**
 * 文件能力：列目录 / 读 / 写 / 删。全部限制在当前会话的工作区内。
 */
import { Capability, fail } from "./types"
import {
  LIST_MAX, READ_CLIP, baseName, clampInt, displayWorkspacePath, ensureDir, resolveWorkspacePath, sizeText,
} from "./common"

// —— 文件：列目录 ——

export function capListFiles(workspaceDir: string): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "list_files",
    label: "文件",
    description:
      "列出助手工作区里的文件和目录。path 写相对路径（相对工作区，例如 \"报告\"），留空就是工作区根目录；" +
      "所有路径都限制在当前会话的工作区内。" +
      "要用别的目录就先 list_files 看一眼再操作，不要凭猜路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要列出的目录，留空 = 工作区根目录" },
        depth: { type: "number", description: "往下展开几层，默认 2，最多 4" },
      },
    },
    run: async (args) => {
      const abs = resolveWorkspacePath(args?.path, workspaceDir)
      if (!abs) return fail("路径不允许：只能读写当前会话的工作区。")
      if (!FileManager.existsSync(abs)) {
        return fail(`没有这个路径：${displayWorkspacePath(abs, workspaceDir)}（工作区默认是空的，可以先用 write_file 建文件）`)
      }
      if (!FileManager.isDirectorySync(abs)) {
        return fail(`${displayWorkspacePath(abs, workspaceDir)} 是文件，用 read_file 读它。`)
      }
      const maxDepth = clampInt(args?.depth, 1, 4, 2)
      const lines: string[] = []
      let truncated = false
      const walk = (dir: string, depth: number, prefix: string) => {
        if (truncated) return
        let names: string[] = []
        try {
          names = FileManager.readDirectorySync(dir)
        } catch {
          return
        }
        // readDirectorySync 返回的是纯名字，得自己拼全路径
        const full = names
          .map((n: string) => (n.startsWith("/") ? n : dir.replace(/\/+$/, "") + "/" + n))
          .sort()
        for (const p of full) {
          if (lines.length >= LIST_MAX) {
            truncated = true
            return
          }
          let isDir = false
          try {
            isDir = FileManager.isDirectorySync(p)
          } catch {
            isDir = false
          }
          lines.push(prefix + baseName(p) + (isDir ? "/" : "  (" + sizeText(p) + ")"))
          if (isDir && depth < maxDepth) walk(p, depth + 1, prefix + baseName(p) + "/")
        }
      }
      walk(abs, 1, "")
      const head =
        lines.length === 0
          ? `${displayWorkspacePath(abs, workspaceDir) || "工作区"}是空的。`
          : `${displayWorkspacePath(abs, workspaceDir) || "工作区"}（${lines.length} 个条目${truncated ? "，只列了前 " + LIST_MAX + " 个" : ""}）：`
      return {
        text: [head, ...lines].join("\n"),
        ok: true,
        target: displayWorkspacePath(abs, workspaceDir) || "工作区",
        argsText: String(args?.path ?? "") || "（根目录）",
      }
    },
  }
}

// —— 文件：读 ——

export function capReadFile(workspaceDir: string): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "read_file",
    label: "文件",
    description:
      "读一个文本文件的内容（Markdown / txt / json / csv / 代码都行）。" +
      "path 相对工作区，也可以用绝对路径。文件很长时用 offset 接着往下读。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区）" },
        offset: { type: "number", description: "从第几个字符开始读，默认 0" },
        maxChars: { type: "number", description: `最多读多少字，默认 ${READ_CLIP}` },
      },
      required: ["path"],
    },
    run: async (args) => {
      const abs = resolveWorkspacePath(args?.path, workspaceDir)
      if (!abs) return fail("路径不允许：只能读写当前会话的工作区。")
      if (!FileManager.existsSync(abs)) return fail(`文件不存在：${displayWorkspacePath(abs, workspaceDir)}`)
      if (FileManager.isDirectorySync(abs)) return fail(`${displayWorkspacePath(abs, workspaceDir)} 是目录，用 list_files 看里面。`)
      let binary = false
      try {
        binary = FileManager.isBinaryFileSync(abs)
      } catch {
        binary = false
      }
      if (binary) return fail(`${displayWorkspacePath(abs, workspaceDir)} 看起来是二进制文件（图片 / 压缩包等），读不了文本内容。`)
      let raw = ""
      try {
        raw = FileManager.readAsStringSync(abs)
      } catch (e: any) {
        return fail(`读取失败：${e?.message ?? String(e)}`)
      }
      const offset = Math.max(0, Math.floor(Number(args?.offset) || 0))
      const max = clampInt(args?.maxChars, 200, READ_CLIP, READ_CLIP)
      const body = raw.slice(offset, offset + max)
      const more =
        raw.length > offset + body.length
          ? `\n…（还有 ${raw.length - offset - body.length} 字没读完，接着读就用 offset=${offset + body.length}）`
          : ""
      return {
        text: `文件：${displayWorkspacePath(abs, workspaceDir)}（共 ${raw.length} 字）\n\n` + body + more,
        ok: true,
        target: displayWorkspacePath(abs, workspaceDir),
        argsText: displayWorkspacePath(abs, workspaceDir),
      }
    },
  }
}

// —— 文件：写 ——

export function capWriteFile(workspaceDir: string): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "write_file",
    label: "文件",
    description:
      "把内容写进一个文本文件（已存在就整个覆盖，父目录会自动建）。" +
      "写完这个文件会作为「产出文件」显示在聊天里，用户可以一键存到「文件」App 或分享出去。" +
      "要给用户一份报告 / 代码 / 表格时，用这个工具落成文件，而不是把长内容全塞进回复。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区），例如 报告/月报.md" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
    },
    run: async (args) => {
      const abs = resolveWorkspacePath(args?.path, workspaceDir)
      if (!abs) return fail("路径不允许：只能写在当前会话的工作区。")
      const content = typeof args?.content === "string" ? args.content : String(args?.content ?? "")
      const parent = abs.slice(0, abs.lastIndexOf("/"))
      ensureDir(parent)
      try {
        FileManager.writeAsStringSync(abs, content)
      } catch (e: any) {
        return fail(`写入失败：${e?.message ?? String(e)}`)
      }
      return {
        text: `已写入 ${displayWorkspacePath(abs, workspaceDir)}（${content.length} 字）。这个文件已经出现在聊天里，用户可以直接保存或分享。`,
        ok: true,
        target: displayWorkspacePath(abs, workspaceDir),
        argsText: displayWorkspacePath(abs, workspaceDir),
        files: [abs],
      }
    },
  }
}

// —— 文件：删 ——

export function capDeleteFile(workspaceDir: string): Capability {
  return {
    toggle: "fsEnabled",
    kind: "fs",
    name: "delete_file",
    label: "文件",
    description:
      "删除工作区里的一个文件或目录（目录会连同里面的东西一起删，不可恢复）。删之前先 list_files 确认，不要删用户自己放进去的东西。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的文件 / 目录路径" },
      },
      required: ["path"],
    },
    run: async (args) => {
      const abs = resolveWorkspacePath(args?.path, workspaceDir)
      if (!abs) return fail("路径不允许：只能删除当前会话工作区里的内容。")
      if (abs === workspaceDir) return fail("不能删除工作区根目录。")
      if (!FileManager.existsSync(abs)) return fail(`不存在：${displayWorkspacePath(abs, workspaceDir)}`)
      try {
        FileManager.removeSync(abs)
      } catch (e: any) {
        return fail(`删除失败：${e?.message ?? String(e)}`)
      }
      return {
        text: `已删除 ${displayWorkspacePath(abs, workspaceDir)}。`,
        ok: true,
        target: displayWorkspacePath(abs, workspaceDir),
        argsText: displayWorkspacePath(abs, workspaceDir),
      }
    },
  }
}
