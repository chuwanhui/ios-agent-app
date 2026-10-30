import {
  Button, Form, HStack, Image, Section, Text, VStack, useEffect, useState,
} from "scripting"
import {
  KB_INBOX, KbDoc, KbFolder, addKbFolder, clearKb, deleteKbDoc, importKbFiles,
  importKbFolder, kbStats, listKbFolders, loadKbIndex, removeKbFolder,
} from "../core/kb/store"
import { SettingsEmptyRow, SettingsSummaryRow } from "../ui/settings"

interface Props {
  /** 资料或文件夹有变化时通知设置页刷新统计。 */
  onChanged?: () => void
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 知识库管理页：设置页里的子页（由设置页用 path 路由推进来，见 app/nav_route.ts，所以自己不带导航栈）。
 * 两种放资料的方式：从「文件」App 上传、挂一个外部文件夹（只读索引）。
 */
export function KbPage({ onChanged = () => {} }: Props) {
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [stat, setStat] = useState(kbStats())
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")

  const refresh = () => {
    const idx = loadKbIndex(true)
    setDocs(idx.docs.slice().sort((a, b) => b.addedAt - a.addedAt))
    setStat(kbStats())
    setFolders(listKbFolders().slice())
  }

  useEffect(() => {
    refresh()
  }, [])

  /** 导入结果 → 几行能看懂的话。 */
  function linesOf(res: { added: KbDoc[]; skipped: string[]; errors: string[] }): string[] {
    const lines: string[] = []
    if (res.added.length > 0) {
      lines.push(
        `导入成功 ${res.added.length} 份：\n` +
          res.added
            .slice(0, 15)
            .map((d) => `· ${d.title}（${d.chunks} 段）`)
            .join("\n") +
          (res.added.length > 15 ? `\n…另外 ${res.added.length - 15} 份` : ""),
      )
    }
    if (res.skipped.length > 0) {
      const head = res.skipped.slice(0, 12).map((s) => "· " + s).join("\n")
      lines.push(
        "跳过：\n" + head + (res.skipped.length > 12 ? `\n…另外 ${res.skipped.length - 12} 条` : ""),
      )
    }
    if (res.errors.length > 0) {
      const head = res.errors.slice(0, 8).map((s) => "· " + s).join("\n")
      lines.push("出错：\n" + head + (res.errors.length > 8 ? `\n…另外 ${res.errors.length - 8} 条` : ""))
    }
    return lines
  }

  /** 从「文件」App 挑文件上传：先拷进「知识库」文件夹，再走普通导入。 */
  async function uploadFiles() {
    setNote("")
    let picked: string[] = []
    try {
      picked = await DocumentPicker.pickFiles({ allowsMultipleSelection: true })
    } catch (e: any) {
      setNote("选择文件失败：" + (e?.message ?? String(e)))
      return
    }
    if (!picked || picked.length === 0) return
    setBusy("正在导入…")
    try {
      const res = await importKbFiles(picked, setBusy)
      refresh()
      const lines = linesOf(res)
      if (lines.length === 0) lines.push("没有可导入的内容。")
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  /** 挂一个外部文件夹：书签持久化，之后可以随时"更新索引"（只读，不动原文件）。 */
  async function pickFolder() {
    setNote("")
    let picked: DocumentPickerBookmarkResult | null = null
    try {
      picked = await DocumentPicker.pickDirectoryBookmark({
        preferredName: "kb-" + Date.now().toString(36),
      })
    } catch (e: any) {
      setNote("选择文件夹失败：" + (e?.message ?? String(e)))
      return
    }
    if (!picked) return
    const folder = addKbFolder(picked.bookmarkName, baseName(picked.path), picked.path)
    refresh()
    await indexFolder(folder, true)
  }

  async function indexFolder(folder: KbFolder, first = false) {
    setBusy(`正在索引「${folder.label}」…`)
    setNote("")
    try {
      const res = await importKbFolder(folder, setBusy)
      refresh()
      const lines = linesOf(res)
      if (lines.length === 0) lines.push(`「${folder.label}」还是空的（没有能读的文档）。`)
      if (first) lines.unshift("已挂上这个文件夹，以后它变了点「更新索引」就行。")
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("索引失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
  }

  async function forgetFolder(folder: KbFolder) {
    const ok = await Dialog.confirm({
      title: "取消挂载",
      message: `从知识库里删掉「${folder.label}」索引的资料吗？原文件夹不会被改动。`,
      confirmLabel: "取消挂载",
    })
    if (!ok) return
    removeKbFolder(folder.bookmark)
    refresh()
    setNote(`已取消挂载「${folder.label}」。`)
    onChanged()
  }

  async function removeDoc(d: KbDoc) {
    const ok = await Dialog.confirm({
      title: "删除资料",
      message: `确定把「${d.title}」从知识库里删掉吗？`,
      confirmLabel: "删除",
    })
    if (!ok) return
    deleteKbDoc(d.id)
    refresh()
    onChanged()
  }

  async function clearAll() {
    const ok = await Dialog.confirm({
      title: "清空知识库",
      message: "会删掉全部资料索引（原始文件仍留在「已导入」文件夹里）。",
      confirmLabel: "清空",
    })
    if (!ok) return
    clearKb()
    refresh()
    onChanged()
  }

  async function quickImport() {
    const picked = await Dialog.actionSheet({
      title: "导入知识库",
      message: "选择导入方式",
      cancelButton: true,
      actions: [
        { label: "从文件导入" },
        { label: "挂载外部文件夹" },
      ],
    })
    if (picked === 0) {
      await uploadFiles()
      return
    }
    if (picked === 1) {
      await pickFolder()
    }
  }

  return (
    <VStack
      navigationTitle="知识库"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarTrailing: (
          <Button
            title={busy ? "处理中…" : "导入"}
            action={quickImport}
            disabled={busy !== ""}
          />
        ),
      }}
    >
      <Form>
        <Section
          header={<Text>知识库概览</Text>}
          footer={<Text>当前基于本地关键词检索，结果命中更可控。</Text>}
        >
          <SettingsSummaryRow
            icon={{ name: "books.vertical.fill", color: "systemPurple" }}
            title="已收录资料"
            value={`${stat.docs} 份 · ${stat.chunks} 个片段`}
          />
          <SettingsSummaryRow
            icon={{ name: "text.alignleft", color: "systemOrange" }}
            title="知识量级"
            value={stat.chars > 0 ? `约 ${Math.round(stat.chars / 1000)} 千字` : "暂无内容"}
          />
          <SettingsSummaryRow
            icon={{ name: "tray.full.fill", color: "systemBlue" }}
            title="资料位置"
            value={KB_INBOX}
          />
        </Section>

        {note ? (
          <Section header={<Text>导入结果</Text>}>
            <Text font="footnote" foregroundStyle="secondaryLabel">{note}</Text>
          </Section>
        ) : null}

        <Section
          header={<Text>已挂载文件夹</Text>}
          footer={<Text>左滑可取消挂载；点刷新可更新索引。</Text>}
        >
          {folders.length === 0 ? (
            <SettingsEmptyRow icon="folder" title="还没有挂载文件夹" detail="可在右上角「导入」里添加。" />
          ) : (
            folders.map((f) => (
              <HStack
                key={f.bookmark}
                spacing={12}
                padding={{ vertical: 4 }}
                trailingSwipeActions={{
                  allowsFullSwipe: false,
                  actions: [<Button title="取消挂载" role="destructive" action={() => forgetFolder(f)} />],
                }}
              >
                <Image
                  systemName="folder.fill"
                  foregroundStyle="white"
                  frame={{ width: 34, height: 34 }}
                  background="systemBlue"
                  clipShape={{ type: "rect", cornerRadius: 8 }}
                />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text>{f.label}</Text>
                  <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={1}>{f.path}</Text>
                </VStack>
                <Button action={() => indexFolder(f)} disabled={busy !== ""}>
                  <Image systemName="arrow.clockwise" foregroundStyle="systemBlue" />
                </Button>
              </HStack>
            ))
          )}
        </Section>

        <Section header={<Text>已导入资料</Text>} footer={<Text>左滑可删除单条资料。</Text>}>
          {docs.length === 0 ? (
            <SettingsEmptyRow icon="doc.text" title="还没有资料" detail="点右上角「导入」添加知识库内容。" />
          ) : (
            docs.map((d) => (
              <HStack
                key={d.id}
                spacing={12}
                padding={{ vertical: 3 }}
                trailingSwipeActions={{
                  allowsFullSwipe: false,
                  actions: [<Button title="删除" role="destructive" action={() => removeDoc(d)} />],
                }}
              >
                <Image
                  systemName="doc.text.fill"
                  foregroundStyle="white"
                  frame={{ width: 34, height: 34 }}
                  background="systemPurple"
                  clipShape={{ type: "rect", cornerRadius: 8 }}
                />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text>{d.title}</Text>
                  <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={1}>
                    {`${d.chunks} 段 · ${d.source}`}
                  </Text>
                </VStack>
              </HStack>
            ))
          )}
        </Section>

        <Section title="危险操作">
          <Button
            title="清空知识库"
            systemImage="trash"
            role="destructive"
            disabled={stat.docs === 0}
            action={clearAll}
          />
        </Section>
      </Form>
    </VStack>
  )
}

export default KbPage
