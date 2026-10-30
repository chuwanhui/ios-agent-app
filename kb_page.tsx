import {
  Button, Form, HStack, Image, Section, Spacer, Text, VStack, useEffect, useState,
} from "scripting"
import {
  KB_DONE, KB_INBOX, KB_VECTORS, KbDoc, KbFolder, addKbFolder, clearKb, deleteKbDoc, importKbFiles,
  importKbFolder, importKbInbox, kbStats, listKbFolders, loadKbIndex, removeKbFolder,
} from "./kb_store"
import {
  autoEmbedAfterImport, buildKbVectors, dropKbVectors, kbSemanticEnabled, kbVectorStatus,
} from "./kb_embed"
import { SettingsEmptyRow, SettingsSummaryRow } from "./settings_ui"

interface Props {
  /** 资料或文件夹有变化时通知设置页刷新统计。 */
  onChanged?: () => void
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 知识库管理页：设置页里的子页（由设置页用 path 路由推进来，见 nav_route.ts，所以自己不带导航栈）。
 * 三种放资料的方式：手动丢进「知识库」文件夹、从「文件」App 上传、挂一个外部文件夹（只读索引）。
 */
export function KbPage({ onChanged = () => {} }: Props) {
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [stat, setStat] = useState(kbStats())
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")
  /** 向量覆盖面（配了向量服务才有意义）。 */
  const [vec, setVec] = useState(kbVectorStatus())
  const [vecNote, setVecNote] = useState("")

  const semanticOn = kbSemanticEnabled()

  const refresh = () => {
    const idx = loadKbIndex(true)
    setDocs(idx.docs.slice().sort((a, b) => b.addedAt - a.addedAt))
    setStat(kbStats())
    setFolders(listKbFolders().slice())
    setVec(kbVectorStatus())
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

  /** 开了语义检索就把新片段的向量补上（失败不打断导入结果）。 */
  async function autoEmbed(lines: string[], addedCount: number) {
    if (addedCount === 0 || !semanticOn) return
    const auto = await autoEmbedAfterImport((done, total) => setBusy(`正在生成向量 ${done}/${total}…`))
    refresh()
    if (auto) lines.push(auto)
  }

  async function runImport() {
    setBusy("正在扫描…")
    setNote("")
    try {
      const res = await importKbInbox(setBusy)
      refresh()
      const lines = linesOf(res)
      if (lines.length === 0) lines.push("「知识库」文件夹里没有新文件。")
      await autoEmbed(lines, res.added.length)
      setNote(lines.join("\n\n"))
      if (res.added.length > 0) onChanged()
    } catch (e: any) {
      setNote("导入失败：" + (e?.message ?? String(e)))
    } finally {
      setBusy("")
    }
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
      await autoEmbed(lines, res.added.length)
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
      await autoEmbed(lines, res.added.length)
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

  /** 给缺向量的片段补向量（已有的不重算）。 */
  async function runBuildVectors() {
    setVecNote("")
    setBusy("准备生成向量…")
    try {
      const r = await buildKbVectors((done, total) => setBusy(`正在生成向量 ${done}/${total}…`))
      refresh()
      const after = kbVectorStatus()
      setVecNote(
        r.embedded > 0
          ? `✅ 新算 ${r.embedded} 段，现有向量 ${after.embedded}/${after.total} 段 · ${after.dim} 维 · 用时 ${r.seconds}s`
          : "所有片段都已有向量，不需要重建。",
      )
    } catch (e: any) {
      setVecNote("❌ " + String(e?.message ?? e))
    } finally {
      setBusy("")
    }
  }

  async function dropVectors() {
    const ok = await Dialog.confirm({
      title: "清空向量",
      message: "只删本机存的向量（资料不受影响），再想用语义检索需要重建一次。",
      confirmLabel: "清空",
    })
    if (!ok) return
    dropKbVectors()
    refresh()
    setVecNote("已清空向量。")
  }

  return (
    <VStack
      navigationTitle="知识库"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>上传文件</Text>}
          footer={<Text>支持 txt、md、json、csv、log 和可选中文字的 PDF。</Text>}
        >
          <Button
            title={busy && busy.indexOf("正在读取") >= 0 ? busy : "选择文件上传"}
            systemImage="doc.badge.plus"
            disabled={busy !== ""}
            action={uploadFiles}
          />
        </Section>

        <Section
          header={<Text>挂外部文件夹</Text>}
          footer={<Text>只读索引外部目录；更新索引会同步文件变化，最多扫描 300 个文件。</Text>}
        >
          {folders.length === 0 ? (
            <SettingsEmptyRow
              icon="folder"
              title="还没有挂载文件夹"
              detail="挂载后可随时重新索引更新内容。"
            />
          ) : (
            folders.map((f) => (
              <HStack key={f.bookmark} spacing={12} padding={{ vertical: 4 }}>
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
                <Button
                  action={() => indexFolder(f)}
                  disabled={busy !== ""}
                >
                  <Image systemName="arrow.clockwise" foregroundStyle="systemBlue" />
                </Button>
                <Button action={() => forgetFolder(f)} role="destructive">
                  <Image systemName="xmark.circle" />
                </Button>
              </HStack>
            ))
          )}
          <Button
            title="挂载一个文件夹"
            systemImage="folder.badge.plus"
            disabled={busy !== ""}
            action={pickFolder}
          />
        </Section>

        <Section
          header={<Text>手动放资料</Text>}
          footer={<Text>导入后的来源文件会移入「已导入」目录，避免重复处理。</Text>}
        >
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {KB_INBOX}
          </Text>
          <Button
            title={busy && busy.indexOf("正在扫描") >= 0 ? busy : "扫描并导入"}
            systemImage="square.and.arrow.down"
            disabled={busy !== ""}
            action={runImport}
          />
          {note ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {note}
            </Text>
          ) : null}
        </Section>

        <Section
          header={<Text>状态</Text>}
          footer={<Text>{semanticOn ? "当前使用关键词与语义混合检索。" : "当前使用本机关键词检索。"}</Text>}
        >
          <SettingsSummaryRow
            icon={{ name: "books.vertical.fill", color: "systemPurple" }}
            title="资料"
            value={`${stat.docs} 份 · ${stat.chunks} 个片段`}
          />
          <SettingsSummaryRow
            icon={{ name: "text.alignleft", color: "systemOrange" }}
            title="文本规模"
            value={stat.chars > 0 ? `约 ${Math.round(stat.chars / 1000)} 千字` : "暂无内容"}
          />
        </Section>

        <Section
          header={<Text>语义索引</Text>}
          footer={<Text>{`向量保存在本机：${KB_VECTORS}`}</Text>}
        >
          {semanticOn ? (
            <SettingsSummaryRow
              icon={{ name: "point.3.connected.trianglepath.dotted", color: "systemTeal" }}
              title="向量覆盖"
              value={`${vec.embedded}/${vec.total} 段` + (vec.dim ? ` · ${vec.dim} 维` : "")}
            />
          ) : (
            <Text foregroundStyle="secondaryLabel">
              未启用。想用就到「设置 → 知识库语义检索」填好向量服务与模型。
            </Text>
          )}
          {semanticOn && vec.model && vec.stale ? (
            <Text font="footnote" foregroundStyle="systemOrange">
              {`本机存的向量是用「${vec.model}」算的，与当前配置的模型不同，需要重建一次。`}
            </Text>
          ) : null}
          {semanticOn ? (
            <Button
              title={busy && busy.indexOf("向量") >= 0 ? busy : "为知识库建向量"}
              systemImage="wand.and.stars"
              disabled={busy !== "" || stat.chunks === 0}
              action={runBuildVectors}
            />
          ) : null}
          {semanticOn && vec.embedded > 0 ? (
            <Button title="清空向量" role="destructive" action={dropVectors} />
          ) : null}
          {vecNote ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {vecNote}
            </Text>
          ) : null}
        </Section>

        <Section header={<Text>资料列表</Text>}>
          {docs.length === 0 ? (
            <SettingsEmptyRow icon="doc.text" title="还没有资料" detail="从上方选择文件或挂载文件夹。" />
          ) : (
            docs.map((d) => (
              <HStack key={d.id} spacing={12} padding={{ vertical: 3 }}>
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
                <Spacer />
                <Button action={() => removeDoc(d)} role="destructive">
                  <Image systemName="trash" />
                </Button>
              </HStack>
            ))
          )}
        </Section>

        <Section header={<Text>文件位置</Text>}>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {"归档目录：" + KB_DONE}
          </Text>
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
