/**
 * 技能能力：跑技能自带的脚本、让助手自己创建新技能。
 */
import { Capability, fail } from "./types"
import { CLI_MAX_TIMEOUT, baseName, clip, displayPath, ensureDir, foldPath } from "./common"
import { quoteArg } from "./cli"
import { SKILL_INBOX, findSkill, importSkills, listSkills, skillDirOf } from "../../skills/store"

// —— 技能脚本 ——

export function capRunSkillScript(): Capability {
  let names: string[] = []
  try {
    names = listSkills().slice(0, 20).map((s) => s.name)
  } catch {
    names = []
  }
  return {
    toggle: "skillScriptEnabled",
    kind: "skill",
    name: "run_skill_script",
    label: "技能脚本",
    description:
      "运行某个技能自带的脚本（技能目录里的 .py 用 python3 跑，.ts/.tsx/.js 用 scripting-ts 跑），并拿到它的输出。" +
      (names.length > 0 ? `现在装着这些技能：${names.join("、")}。` : "") +
      "PATH 相对技能目录，例如 scripts/main.py。跑之前先用 read_skill 把技能说明读完，再按它说的方式调用，" +
      "不要盲跑、也不要自己编造运行结果。",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "技能名" },
        path: { type: "string", description: "脚本在技能目录里的相对路径，例如 scripts/main.py" },
        args: {
          type: "array",
          description: "传给脚本的参数，按顺序（Python 脚本会进 sys.argv）",
          items: { type: "string" },
        },
      },
      required: ["skill", "path"],
    },
    run: async (args) => {
      const key = String(args?.skill ?? "").trim()
      const meta = findSkill(key)
      if (!meta) return fail(`没找到技能「${key}」。`)
      const dir = skillDirOf(meta)
      const rel = String(args?.path ?? "").trim()
      if (!rel) return fail("要告诉我是哪个脚本，比如 scripts/main.py。")
      const abs = foldPath(dir + "/" + rel)
      if (!(abs === dir || abs.startsWith(dir + "/"))) return fail("脚本路径必须在这个技能目录里面。")
      if (!FileManager.existsSync(abs) || FileManager.isDirectorySync(abs)) {
        return fail(`技能里没有这个文件：${rel}`)
      }
      const ext = (baseName(abs).split(".").pop() ?? "").toLowerCase()
      const list: string[] = Array.isArray(args?.args)
        ? args.args.map((x: any) => String(x))
        : args?.args === undefined || args?.args === null || args?.args === ""
          ? []
          : [String(args.args)]
      let command: string
      if (ext === "py") {
        command = ["python3", quoteArg(abs)].concat(list.map(quoteArg)).join(" ")
      } else if (ext === "ts" || ext === "tsx" || ext === "js") {
        const payload = list.length > 0 ? JSON.stringify({ args: list }) : "{}"
        command = `scripting-ts run ${quoteArg(abs)} --queryparameters ${quoteArg(payload)}`
      } else {
        return fail("只支持技能里的 .py / .ts / .tsx / .js 脚本。")
      }
      let res: any
      try {
        res = await Shell.run(command, { cwd: dir, timeout: CLI_MAX_TIMEOUT })
      } catch (e: any) {
        return fail(`执行失败：${e?.message ?? String(e)}`)
      }
      const out = String(res?.output ?? "")
      const code = Number(res?.exitCode ?? 0)
      const head = `技能「${meta.name}」· ${rel}`
      const tail = res?.timedOut ? `\n[超时 ${CLI_MAX_TIMEOUT} 秒被终止]` : `\nexit ${code}`
      return {
        text: clip(`${head}${tail}\n${out || "（没有任何输出）"}`),
        ok: !res?.timedOut && code === 0,
        target: `${meta.name} · ${rel}`,
        argsText: list.length > 0 ? list.map(quoteArg).join(" ") : rel,
      }
    },
  }
}

// —— 创建技能 ——

export function safeDirName(name: string): string {
  const cleaned = (name ?? "")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 40)
  return cleaned || "skill-" + Date.now().toString(36)
}

export function uniqueDirName(dir: string, name: string): string {
  if (!FileManager.existsSync(dir + "/" + name)) return name
  let i = 2
  while (FileManager.existsSync(`${dir}/${name}-${i}`)) i += 1
  return `${name}-${i}`
}

export function capCreateSkill(): Capability {
  return {
    toggle: "skillCreateEnabled",
    kind: "skill",
    name: "create_skill",
    label: "技能",
    description:
      "把一套做事方法固化成一条新技能（会在助手技能库里建号，用户能在「设置 → 技能」里看到、停用或删除）。" +
      "什么时候用：用户让你「记住以后都这么做」「把这个流程做成技能」；或者你发现某个做法以后还会反复用。" +
      "content 就是 SKILL.md 的正文，要写清「什么时候用 / 一步步怎么做 / 有哪些坑」，别写空话；" +
      "需要配套脚本时用 files 一起写进去（例如 scripts/main.py），正文里写清怎么调用它。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（短、能一眼看懂）" },
        description: { type: "string", description: "一句话说明它干什么、什么时候该用（会出现在技能列表里）" },
        content: { type: "string", description: "SKILL.md 正文（Markdown）" },
        files: {
          type: "array",
          description: "要一起写进技能目录的附加文件（可选）",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "相对技能目录的路径，例如 scripts/main.py" },
              content: { type: "string", description: "文件内容" },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["name", "description", "content"],
    },
    run: async (args) => {
      const name = String(args?.name ?? "").trim()
      const description = String(args?.description ?? "").trim()
      const content = typeof args?.content === "string" ? args.content : String(args?.content ?? "")
      if (!name) return fail("技能得有个名字。")
      if (!description) return fail("技能要有一句话说明，否则模型以后不知道什么时候用它。")
      if (!content.trim()) return fail("SKILL.md 正文不能是空的，写清具体步骤。")

      const inbox = SKILL_INBOX
      ensureDir(inbox)
      const dirName = uniqueDirName(inbox, safeDirName(name))
      const dest = inbox + "/" + dirName
      const md = [
        "---",
        "name: " + name.replace(/[\r\n]/g, " "),
        "description: " + description.replace(/[\r\n]/g, " "),
        "---",
        "",
        content.replace(/\r\n?/g, "\n"),
        "",
      ].join("\n")

      const written: string[] = []
      try {
        ensureDir(dest)
        FileManager.writeAsStringSync(dest + "/SKILL.md", md)
        written.push(dest + "/SKILL.md")
      } catch (e: any) {
        return fail(`写技能文件失败：${e?.message ?? String(e)}`)
      }

      const extra = Array.isArray(args?.files) ? args.files : []
      for (const f of extra) {
        const rel = String(f?.path ?? "").trim()
        if (!rel) continue
        const target = foldPath(dest + "/" + rel)
        if (!target.startsWith(dest + "/")) continue
        const parent = target.slice(0, target.lastIndexOf("/"))
        ensureDir(parent)
        try {
          FileManager.writeAsStringSync(target, typeof f?.content === "string" ? f.content : String(f?.content ?? ""))
          written.push(target)
        } catch {
          // 单个附件失败不影响技能本体
        }
      }

      let added = ""
      let note = ""
      try {
        const res = await importSkills()
        if (res.added.length > 0) {
          added = res.added.map((s) => s.name).join("、")
        }
        if (res.errors.length > 0) note = `（有文件没装上：${res.errors[0]}）`
        if (res.added.length === 0 && res.skipped.length > 0) note = `（${res.skipped[0]}）`
      } catch (e: any) {
        note = `（导入时出错：${e?.message ?? String(e)}）`
      }

      const okText = added
        ? `已创建技能「${added}」，现在在「设置 → 技能」里能看到，用户随时可以停用或删掉它。`
        : `技能文件已经写好（${dirName}），但没能在技能库里注册${note}。`
      return {
        text: `${okText}\n描述：${description}\n目录：${displayPath(dest)}（${written.length} 个文件）`,
        ok: true,
        target: name,
        argsText: name + "（" + written.length + " 个文件）",
      }
    },
  }
}
