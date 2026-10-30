import {
  Button, DisclosureGroup, Form, HStack, Image, Section, SecureField, Spacer, Text, TextField,
  Toggle, VStack, useState,
} from "scripting"
import { McpServer, makeMcpServer, mcpServersToJson, parseMcpServersJson } from "./agent_store"
import { listMcpTools } from "./mcp_client"
import { SettingsEmptyRow, SettingsSummaryRow } from "./settings_ui"

// —— 工具函数 ——

function hostOf(url: string): string {
  const t = (url ?? "").trim()
  if (!t) return "还没填地址"
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(t)
  return m ? m[1] : t
}

function serverTitle(m: McpServer): string {
  const name = (m.name ?? "").trim()
  return name || (m.url?.trim() ? hostOf(m.url) : "（未命名）")
}

function serverSubtitle(m: McpServer): string {
  const url = (m.url ?? "").trim()
  if (!url) return "还没填地址"
  const bits: string[] = [hostOf(url), m.enabled ? "已启用" : "已停用"]
  if ((m.token ?? "").trim()) bits.push("带令牌")
  return bits.join(" · ")
}

function matchesServer(m: McpServer, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase()
  if (!needle) return true
  return [m.name, m.url].some((s) => ((s ?? "") as string).toLowerCase().indexOf(needle) >= 0)
}

// —— MCP 列表页 ——

interface Props {
  servers: McpServer[]
  onChange: (servers: McpServer[]) => void
}

export function McpPage({ servers, onChange }: Props) {
  const [draft, setDraft] = useState<McpServer[]>(servers.map((s) => ({ ...s })))
  const [query, setQuery] = useState("")
  const [json, setJson] = useState("")
  const [note, setNote] = useState("")
  const [testingId, setTestingId] = useState("")
  const [expandedId, setExpandedId] = useState("")

  function push(next: McpServer[]) {
    setDraft(next)
    onChange(next)
  }

  function update(id: string, p: Partial<McpServer>) {
    push(draft.map((m) => (m.id === id ? { ...m, ...p } : m)))
  }

  function addServer() {
    const server = makeMcpServer()
    push([...draft, server])
    setExpandedId(server.id)
  }

  function removeServer(m: McpServer) {
    push(draft.filter((item) => item.id !== m.id))
    if (expandedId === m.id) setExpandedId("")
    setNote(`已删除「${serverTitle(m)}」。`)
  }

  async function testServer(m: McpServer) {
    const url = (m.url ?? "").trim()
    if (!url) { Dialog.alert({ message: "先填服务器地址。"}); return }
    setTestingId(m.id)
    try {
      const list = await listMcpTools(
        { ...m, url, name: (m.name ?? "").trim() || m.id, enabled: true }, true,
      )
      if (list.error) { Dialog.alert({ title: "连接失败", message: list.error }); return }
      if (list.tools.length === 0) { Dialog.alert({ title: "连接成功", message: "连上了，但服务器没有提供任何工具。" }); return }
      const names = list.tools.slice(0, 12).map((t) => "· " + t.name).join("\n")
      const more = list.tools.length > 12 ? `\n…另外 ${list.tools.length - 12} 个` : ""
      Dialog.alert({ title: "连接成功", message: `拿到 ${list.tools.length} 个工具：\n${names}${more}` })
    } catch (e: any) {
      Dialog.alert({ title: "测试失败", message: e?.message ?? String(e) })
    } finally {
      setTestingId("")
    }
  }

  // JSON 导入
  async function pasteFromClipboard() {
    try {
      const t = await Pasteboard.getString()
      if (!t || !t.trim()) { setNote("剪贴板里没有文本。"); return }
      setJson(t)
      setNote("已从剪贴板读入，点「导入」解析。")
    } catch (e: any) {
      setNote("读剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  function importJson() {
    let res
    try { res = parseMcpServersJson(json) } catch (e: any) {
      setNote(String(e?.message ?? e)); return
    }
    const exists = new Set(draft.map((s) => (s.url ?? "").trim()))
    const fresh = res.servers.filter((s) => !exists.has(s.url.trim()))
    if (fresh.length > 0) push([...draft, ...fresh])
    const lines: string[] = []
    if (fresh.length > 0) lines.push(`导入 ${fresh.length} 台服务器`)
    if (res.servers.length - fresh.length > 0) lines.push(`跳过 ${res.servers.length - fresh.length} 台（地址已存在）`)
    if (res.skipped.length > 0) lines.push("未导入：\n" + res.skipped.map((s) => "· " + s).join("\n"))
    setNote(lines.join("\n"))
  }

  async function copyJson() {
    try {
      await Pasteboard.setString(mcpServersToJson(draft))
      setNote("已复制当前配置的 JSON（含令牌）。")
    } catch (e: any) {
      setNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  const shown = draft.filter((m) => matchesServer(m, query))
  const enabledCount = draft.filter((m) => m.enabled && (m.url ?? "").trim()).length

  return (
    <VStack
      navigationTitle="MCP 服务器"
      navigationBarTitleDisplayMode="inline"
      searchable={{
        value: query, onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay", prompt: "搜名称 / 地址",
      }}
    >
      <Form>
        <Section title="概览">
          <SettingsSummaryRow
            icon={{ name: "network", color: enabledCount > 0 ? "systemGreen" : "systemGray" }}
            title="连接状态"
            value={`${enabledCount}/${draft.length} 台启用`}
          />
          <Button title="添加 MCP 服务器" systemImage="plus.circle.fill" action={addServer} />
        </Section>

        <Section title="服务器">
          {draft.length === 0 ? (
            <SettingsEmptyRow icon="server.rack" title="还没有 MCP 服务器" detail="连接远程 HTTP MCP 服务，为模型提供工具。" />
          ) : shown.length === 0 ? (
            <SettingsEmptyRow icon="magnifyingglass" title="没有匹配的服务器" detail={query.trim()} />
          ) : (
            shown.map((m) => <McpServerEditor
              key={m.id}
              server={m}
              expanded={expandedId === m.id}
              testing={testingId === m.id}
              onExpanded={(value) => setExpandedId(value ? m.id : "")}
              onChange={(p) => update(m.id, p)}
              onTest={() => testServer(m)}
              onDelete={() => removeServer(m)}
            />)
          )}
        </Section>

        <Section title="从 JSON 导入">
          <TextField
            title="配置 JSON"
            value={json}
            prompt={'{"mcpServers":{"demo":{"url":"https://..."}}}'}
            axis="vertical"
            lineLimit={{ min: 3, max: 10 }}
            autocorrectionDisabled
            textInputAutocapitalization="never"
            onChanged={setJson}
          />
          <Button title="从剪贴板粘贴" systemImage="doc.on.clipboard" action={pasteFromClipboard} />
          <Button title="导入" systemImage="square.and.arrow.down" disabled={!json.trim()} action={importJson} />
          <Button title="导出当前配置" systemImage="doc.on.doc" action={copyJson} />
          {note ? <Text font="footnote" foregroundStyle="secondaryLabel">{note}</Text> : null}
        </Section>
      </Form>
    </VStack>
  )
}

function McpServerEditor({
  server: m, expanded, testing, onExpanded, onChange, onTest, onDelete,
}: {
  server: McpServer
  expanded: boolean
  testing: boolean
  onExpanded: (value: boolean) => void
  onChange: (p: Partial<McpServer>) => void
  onTest: () => void
  onDelete: () => void
}) {
  return (
    <DisclosureGroup
      isExpanded={expanded}
      onChanged={onExpanded}
      trailingSwipeActions={{
        actions: [
          <Button title="删除" systemImage="trash" role="destructive" action={onDelete} />,
        ],
      }}
      label={
        <HStack spacing={12} padding={{ vertical: 3 }} frame={{ maxWidth: "infinity" }}>
          <Image
            systemName="server.rack"
            font="headline"
            foregroundStyle="white"
            frame={{ width: 34, height: 34 }}
            background={m.enabled ? "systemBlue" : "systemGray"}
            clipShape={{ type: "rect", cornerRadius: 8 }}
          />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text>{serverTitle(m)}</Text>
            <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={1}>
              {serverSubtitle(m)}
            </Text>
          </VStack>
          <Spacer />
          <Text font="footnote" foregroundStyle={m.enabled ? "systemGreen" : "secondaryLabel"}>
            {m.enabled ? "启用" : "停用"}
          </Text>
        </HStack>
      }
    >
      <TextField title="名称" value={m.name} prompt="如 deepwiki" onChanged={(v) => onChange({ name: v })} />
      <TextField title="地址" value={m.url} prompt="https://example.com/mcp"
        autocorrectionDisabled textInputAutocapitalization="never" onChanged={(v) => onChange({ url: v })} />
      <SecureField title="令牌" value={m.token ?? ""} prompt="可选，Bearer Token"
        autocorrectionDisabled textInputAutocapitalization="never" onChanged={(v) => onChange({ token: v })} />
      <TextField title="额外请求头" value={m.headersHint ?? ""}
        prompt="可选，每行一个\nHeader: Value"
        axis="vertical" lineLimit={{ min: 1, max: 4 }}
        autocorrectionDisabled textInputAutocapitalization="never" onChanged={(v) => onChange({ headersHint: v })} />
      <Toggle title="启用" value={m.enabled} onChanged={(v) => onChange({ enabled: v })} />
      <Button title={testing ? "正在测试…" : "测试连接"} systemImage="bolt.horizontal.circle"
        disabled={testing} action={onTest} />
    </DisclosureGroup>
  )
}

export default McpPage
