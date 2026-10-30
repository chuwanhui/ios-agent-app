import {
  Button, Form, HStack, Image, Markdown, Picker, SecureField, Section, Text, TextField, Toggle,
  VStack, useEffect, useState,
} from "scripting"
import {
  SKILL_DONE, SKILL_INBOX, SkillMeta, deleteSkill, importSkills, listSkills, readSkill,
  parseFrontMatter, setSkillEnabled, skillDirOf, skillsPrompt, stageSkillFile, updateSkillContent,
} from "./skills_store"
import { loadConfig } from "./agent_store"
import { importSkillFromRepo } from "./repo_import"
import { pushRoute, registerRoute } from "./nav_route"
import { SettingsEmptyRow, SettingsListRow, SettingsSummaryRow } from "./settings_ui"

/** 搜索匹配：技能名 / 描述，大小写不敏感。 */
function matchesSkill(s: SkillMeta, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase()
  if (!needle) return true
  return [s.name, s.description].some((x) => ((x ?? "") as string).toLowerCase().indexOf(needle) >= 0)
}

interface Props {
  /** 技能有增减 / 启停变化时通知设置页刷新统计。 */
  onChanged?: () => void
}

/**
 * 技能管理页：设置页里的子页（由设置页用 path 路由推进来，见 nav_route.ts，所以自己不带导航栈）。
 * 上面搜索框 + 技能列表，点一条进详情页看完整说明 / 启停 / 删除；导入方式都收在列表下面。
 */
export function SkillsPage({ onChanged = () => {} }: Props) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")
  /** 上次用的是哪个仓库 / 令牌（令牌存在配置里，下次进来还有）。 */
  const [repoUrl, setRepoUrl] = useState("")
  const [token, setToken] = useState(loadConfig().gitToken ?? "")

  const refresh = () => {
    setSkills(listSkills().slice().sort((a, b) => b.addedAt - a.addedAt))
  }

  useEffect(() => {
    refresh()
  }, [])

  function linesOf(res: { added: SkillMeta[]; skipped: string[]; errors: string[] }): string[] {
    const lines: string[] = []
    if (res.added.length > 0) {
      lines.push(
        `导入成功 ${res.added.length} 个：\n` +
          res.added.map((s) => `· ${s.name}（${s.files.length} 个文件）`).join("\n"),
      )
    }
    if (res.skipped.length > 0) {
      lines.push("跳过：\n" + res.skipped.map((s) => "· " + s).join("\n"))
    }
    if (res.errors.length > 0) {
      lines.push("出错：\n" + res.errors.map((s) => "· " + s).join("\n"))
    }
    return lines
  }

  /** 扫描「技能」文件夹（上传和手动丢文件都走这里）。 */
  async function runImport(extra: string[] = []) {
    setBusy("正在扫描…")
    setNote("")
    try {
      const res = await importSkills(setBusy)
      refresh()
      const lines = linesOf(res).concat(extra)
      if (lines.length === 0) lines.push("「技能」文件夹里没有新文件。")
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  /** 从「文件」App 挑 zip / md 上传：拷进「技能」文件夹后走普通扫描。 */
  async function uploadPackages() {
    setNote("")
    let picked: string[] = []
    try {
      picked = await DocumentPicker.pickFiles({ allowsMultipleSelection: true })
    } catch (e: any) {
      setNote("选择文件失败：" + (e?.message ?? String(e)))
      return
    }
    if (!picked || picked.length === 0) return
    const extra: string[] = []
    let staged = 0
    for (const p of picked) {
      if (stageSkillFile(p)) staged += 1
    }
    if (staged < picked.length) extra.push(`有 ${picked.length - staged} 个文件没能拷进来。`)
    if (staged === 0) {
      setNote("没能把文件拷进来。")
      return
    }
    await runImport(extra)
  }

  /** 从 git 仓库（GitHub / GitLab）下载 zip 装一个技能。 */
  async function importFromRepo() {
    const url = (repoUrl ?? "").trim()
    if (!url) {
      Dialog.alert({ message: "先填仓库地址，比如 https://github.com/owner/repo" })
      return
    }
    setBusy("正在下载…")
    setNote("")
    try {
      const res = await importSkillFromRepo(url, token, setBusy)
      refresh()
      if (res.added) {
        setNote(
          `✅ 从 ${res.refLabel || "仓库"} 装好了技能「${res.added.name}」（${res.added.files.length} 个文件）。`,
        )
        onChanged()
      } else {
        setNote("导入失败：" + (res.error ?? "未知错误"))
      }
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  // 详情页的路由：path 里出现 "skill:<id>" 就造这一条的详情页。
  registerRoute("skill:", (id) => {
    const s = skills.find((x) => x.id === id)
    if (!s) return null
    return (
      <SkillDetail
        meta={s}
        onChanged={() => {
          refresh()
          onChanged()
        }}
        onDeleted={() => {
          refresh()
          onChanged()
        }}
      />
    )
  })

  const promptSize = skillsPrompt()?.length ?? 0
  const enabledCount = skills.filter((s) => s.enabled).length
  const shown = skills.filter((s) => matchesSkill(s, query))

  return (
    <VStack
      navigationTitle="技能"
      navigationBarTitleDisplayMode="inline"
      searchable={{
        value: query,
        onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay",
        prompt: "搜技能名 / 描述",
      }}
    >
      <Form>
        <Section
          header={<Text>{skills.length > 0 ? `技能 ${skills.length} 个` : "技能列表"}</Text>}
        >
          {skills.length === 0 ? (
            <SettingsEmptyRow
              icon="shippingbox"
              title="还没有技能"
              detail="上传技能包或从 Git 仓库导入。"
            />
          ) : shown.length === 0 ? (
            <SettingsEmptyRow icon="magnifyingglass" title="没有匹配的技能" detail={query.trim()} />
          ) : (
            shown.map((s) => (
              <SettingsListRow
                key={s.id}
                icon={{ name: "shippingbox.fill", color: s.enabled ? "systemIndigo" : "systemGray" }}
                title={s.name}
                detail={s.description || "没有写描述"}
                status={s.enabled ? "启用" : "停用"}
                statusColor={s.enabled ? "systemGreen" : "secondaryLabel"}
                onOpen={() => pushRoute("skill:" + s.id)}
              />
            ))
          )}
        </Section>

        <Section
          header={<Text>使用状态</Text>}
          footer={<Text>启用的技能可在对话中按需读取完整说明。</Text>}
        >
          <SettingsSummaryRow
            icon={{ name: "checkmark.circle.fill", color: enabledCount > 0 ? "systemGreen" : "systemGray" }}
            title="已启用"
            value={`${enabledCount}/${skills.length} 个`}
          />
          <SettingsSummaryRow
            icon={{ name: "text.word.spacing", color: "systemOrange" }}
            title="提示词占用"
            value={promptSize > 0 ? `约 ${promptSize} 字` : "无"}
          />
        </Section>

        <Section
          header={<Text>上传技能包</Text>}
          footer={<Text>支持含 SKILL.md 的 zip，或带 YAML 元信息的单个 md 文件。</Text>}
        >
          <Button
            title={busy && busy.indexOf("扫描") >= 0 ? busy : "选择 zip / md 上传"}
            systemImage="doc.badge.plus"
            disabled={busy !== ""}
            action={uploadPackages}
          />
        </Section>

        <Section
          header={<Text>从 git 仓库导入</Text>}
          footer={<Text>支持 GitHub、GitLab 仓库和子目录；私有仓库需要访问令牌。</Text>}
        >
          <TextField
            title="仓库地址"
            value={repoUrl}
            prompt="https://github.com/owner/repo"
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setRepoUrl}
          />
          <SecureField
            title="访问令牌"
            value={token}
            prompt="可选，私有仓库才要"
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setToken}
          />
          <Button
            title={busy && busy.indexOf("下载") >= 0 ? busy : "下载并导入"}
            systemImage="arrow.down.circle"
            disabled={busy !== ""}
            action={importFromRepo}
          />
        </Section>

        <Section
          header={<Text>手动放技能</Text>}
          footer={<Text>扫描后，已处理的来源会移入「已导入」目录。</Text>}
        >
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {SKILL_INBOX}
          </Text>
          <Button
            title={busy && busy.indexOf("扫描") >= 0 ? busy : "扫描并导入"}
            systemImage="square.and.arrow.down"
            disabled={busy !== ""}
            action={() => runImport()}
          />
        </Section>

        {busy || note ? (
          <Section header={<Text>进度</Text>}>
            {busy ? <Text>{busy}</Text> : null}
            {note ? (
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {note}
              </Text>
            ) : null}
          </Section>
        ) : null}

        <Section header={<Text>文件位置</Text>}>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {"已导入归档：" + SKILL_DONE}
          </Text>
        </Section>
      </Form>
    </VStack>
  )
}

interface DetailProps {
  meta: SkillMeta
  /** 启停 / 删除后通知列表页刷新（启停是直接写盘的）。 */
  onChanged: () => void
  /** 删除成功：列表页刷新自己。 */
  onDeleted: () => void
}

/**
 * 技能详情页：完整说明（SKILL.md 全文，不再截断）、附件清单、启停、删除。
 * 启停和删除都直接写盘，不用回设置页保存。
 */
export function SkillDetail({ meta, onChanged, onDeleted }: DetailProps) {
  const [skill, setSkill] = useState(meta)
  const [enabled, setEnabled] = useState(meta.enabled)
  const [content, setContent] = useState<string | null>(null)
  const [mode, setMode] = useState<"preview" | "edit">("preview")
  const [files, setFiles] = useState<string[]>(meta.files ?? [])
  const [dir, setDir] = useState(skillDirOf(meta))
  const [note, setNote] = useState("")

  useEffect(() => {
    const hit = readSkill(meta.id)
    if (!hit) {
      setContent("")
      setNote("读不到 SKILL.md：可能已经被删掉了。")
      return
    }
    setSkill(hit.meta)
    setContent(hit.content)
    setFiles(hit.files)
    setDir(skillDirOf(hit.meta))
  }, [])

  function toggle(v: boolean) {
    setEnabled(v)
    setSkill((current) => ({ ...current, enabled: v }))
    setSkillEnabled(meta.id, v)
    onChanged()
  }

  function editContent(next: string) {
    setContent(next)
    const updated = updateSkillContent(meta.id, next)
    if (!updated) {
      setNote("保存 SKILL.md 失败。")
      return
    }
    setSkill(updated)
    setNote("")
    if (updated.name !== skill.name || updated.description !== skill.description) onChanged()
  }

  async function copyContent() {
    if (!content) return
    try {
      await Pasteboard.setString(content)
      setNote("已拷贝 SKILL.md 全文。")
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  async function remove() {
    const ok = await Dialog.confirm({
      title: "删除技能",
      message: `确定删掉技能「${skill.name}」吗？它的所有文件都会被删。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    deleteSkill(meta.id)
    onDeleted()
  }

  return (
    <VStack
      navigationTitle={skill.name}
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>使用状态</Text>}
          footer={<Text>{enabled ? "该技能可在对话中使用。" : "该技能不会提供给模型。"}</Text>}
        >
          <SettingsSummaryRow
            icon={{ name: "shippingbox.fill", color: enabled ? "systemIndigo" : "systemGray" }}
            title="技能状态"
            value={enabled ? "已启用" : "已停用"}
          />
          <Text>{skill.description || "（没有写描述）"}</Text>
          <Toggle title="启用" value={enabled} onChanged={toggle} />
        </Section>

        <Section
          header={<Text>说明（SKILL.md）</Text>}
        >
          <Picker
            title="显示模式"
            pickerStyle="segmented"
            value={mode}
            onChanged={(v: string) => setMode(v as "preview" | "edit")}
          >
            <Text tag="preview">预览</Text>
            <Text tag="edit">编辑</Text>
          </Picker>
          {content === null ? (
            <Text foregroundStyle="secondaryLabel">正在读取…</Text>
          ) : mode === "edit" ? (
            <TextField
              title="Markdown"
              value={content}
              axis="vertical"
              lineLimit={{ min: 14, max: 30, reservesSpace: true }}
              autocorrectionDisabled
              onChanged={editContent}
            />
          ) : content ? (
            <Markdown
              content={parseFrontMatter(content).body || "（正文为空）"}
              theme="github"
              useDefaultHighlighterTheme
              scrollable={false}
            />
          ) : (
            <Text foregroundStyle="secondaryLabel">（没读到 SKILL.md 的内容）</Text>
          )}
          {content ? <Button title="拷贝全文" systemImage="doc.on.doc" action={copyContent} /> : null}
        </Section>

        <Section header={<Text>{`附件 ${files.length} 个`}</Text>}>
          {files.length === 0 ? (
            <Text foregroundStyle="secondaryLabel">没有额外文件。</Text>
          ) : (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {files.join("\n")}
            </Text>
          )}
        </Section>

        <Section header={<Text>文件位置</Text>}>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {dir}
          </Text>
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
        </Section>
        <Section title="危险操作">
          <Button title="删除这个技能" systemImage="trash" role="destructive" action={remove} />
        </Section>
      </Form>
    </VStack>
  )
}

export default SkillsPage
