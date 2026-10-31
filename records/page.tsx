import {
  Button, DisclosureGroup, Form, HStack, Label, Markdown, Menu, NavigationStack, Section, Script, Spacer, Text,
  TextField, VStack, useState,
} from "scripting"
import { MessageRecord, clearMessageRecords, loadMessageRecords } from "../core/records/store"
import {
  NotifyQueueItem, clearQueue, dropQueueItem, failedQueueItems, queueSize, retryQueueItem,
} from "../core/notify/queue"
import { SettingsEmptyRow } from "../ui/settings"
import { NOTIFY_TEMPLATE_JSON, notifyDocMarkdown, urlEntryDoc } from "./notify_doc"

/** 本脚本在「快捷指令」里的名字（说明文档里要写它）。 */
function scriptName(): string {
  try {
    return (Script as any)?.name || "智能体"
  } catch {
    return "智能体"
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "…"
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

type SenderGroup = {
  sender: string
  count: number
  lastAt: number
  last: MessageRecord
}

type AppGroup = {
  app: string
  count: number
  lastAt: number
  senders: SenderGroup[]
}

function grouped(items: MessageRecord[]): AppGroup[] {
  const appMap = new Map<string, MessageRecord[]>()
  for (const item of items) {
    const app = item.app || "（未知 App）"
    const list = appMap.get(app) ?? []
    list.push(item)
    appMap.set(app, list)
  }

  const apps: AppGroup[] = []
  for (const [app, list] of appMap.entries()) {
    const senderMap = new Map<string, MessageRecord[]>()
    for (const item of list) {
      const sender = item.sender || "（未知发件人）"
      const rows = senderMap.get(sender) ?? []
      rows.push(item)
      senderMap.set(sender, rows)
    }

    const senders: SenderGroup[] = []
    for (const [sender, rows] of senderMap.entries()) {
      rows.sort((a, b) => b.at - a.at)
      senders.push({
        sender,
        count: rows.length,
        lastAt: rows[0]?.at ?? 0,
        last: rows[0],
      })
    }
    senders.sort((a, b) => b.lastAt - a.lastAt)

    apps.push({
      app,
      count: list.length,
      lastAt: list.reduce((m, it) => Math.max(m, it.at || 0), 0),
      senders,
    })
  }
  apps.sort((a, b) => b.lastAt - a.lastAt)
  return apps
}

/** 搜索 / 筛选：命中正文、回复、发件人、App 任意一项就算。 */
function matches(item: MessageRecord, query: string, app: string): boolean {
  if (app && item.app !== app) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [item.app, item.sender, item.content, item.reply].join("\n").toLowerCase()
  return hay.indexOf(q) >= 0
}

function SenderRow({ item }: { item: SenderGroup }) {
  return (
    <VStack spacing={6} padding={{ vertical: 6 }}>
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Text fontWeight="semibold">{item.sender}</Text>
        <Text font="footnote" foregroundStyle="secondaryLabel">{item.count} 条</Text>
        <Spacer />
        <Text font="footnote" foregroundStyle="secondaryLabel">{formatTime(item.lastAt)}</Text>
      </HStack>

      <Text font="footnote" foregroundStyle="secondaryLabel">最近收到：{clip(item.last?.content || "", 160) || "（空）"}</Text>
      <Text font="footnote">最近回复：{clip(item.last?.reply || "", 220) || "（空）"}</Text>
    </VStack>
  )
}

/** 一条「重试用尽」的通知：可以手动重试，也可以直接丢掉。 */
function FailedRow({
  item, onRetry, onDiscard,
}: {
  item: NotifyQueueItem
  onRetry: (id: string) => void
  onDiscard: (id: string) => void
}) {
  return (
    <VStack spacing={6} padding={{ vertical: 6 }}>
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Text fontWeight="semibold">{item.sender || "（未知发件人）"}</Text>
        <Text font="footnote" foregroundStyle="secondaryLabel">{item.app}</Text>
        <Spacer />
        <Text font="footnote" foregroundStyle="secondaryLabel">{formatTime(item.receivedAt)}</Text>
      </HStack>
      <Text font="footnote" foregroundStyle="secondaryLabel">{clip(item.content || "", 160)}</Text>
      <Text font="caption2" foregroundStyle="systemRed">
        试了 {item.attempts} 次仍失败：{clip(item.lastError || "未知原因", 120)}
      </Text>
      <HStack spacing={10}>
        <Button title="重试" systemImage="arrow.clockwise" action={() => onRetry(item.id)} />
        <Button title="丢掉" systemImage="trash" role="destructive" action={() => onDiscard(item.id)} />
      </HStack>
    </VStack>
  )
}

export function RecordsPage() {
  const [items, setItems] = useState<MessageRecord[]>(() => loadMessageRecords())
  const [failed, setFailed] = useState<NotifyQueueItem[]>(() => failedQueueItems())
  const [pending, setPending] = useState(() => queueSize())
  const [query, setQuery] = useState("")
  const [appFilter, setAppFilter] = useState("")
  /** 「怎么接微信 / 钉钉」那份说明默认收起，要看才展开。 */
  const [docOpen, setDocOpen] = useState(false)
  const [docNote, setDocNote] = useState("")
  const [runDocOpen, setRunDocOpen] = useState(false)

  function refresh() {
    setItems(loadMessageRecords())
    setFailed(failedQueueItems())
    setPending(queueSize())
  }

  /**
   * 一次清干净：已完成的记录 + 还在排队的 + 处理失败的。
   *
   * 只清记录会留下一个怪现象：本页看着空了，可队列里还压着几条，
   * 下次打开 App 它们又冒出来继续跑。
   */
  async function clearAll() {
    const parts: string[] = []
    if (items.length > 0) parts.push(`${items.length} 条记录`)
    if (pending > 0) parts.push(`${pending} 条等待处理的通知`)
    if (failed.length > 0) parts.push(`${failed.length} 条处理失败的通知`)
    const ok = await Dialog.confirm({
      title: "清空记录",
      message: `会清掉${parts.join("、") || "所有记录"}，队列里等着的一条也不留。清完再跑同一条消息，会当成新消息重新处理。`,
      confirmLabel: "清空",
    })
    if (!ok) return
    clearMessageRecords()
    clearQueue()
    refresh()
  }

  async function copyTemplate() {
    try {
      await Pasteboard.setString(NOTIFY_TEMPLATE_JSON)
      setDocNote("已拷贝 JSON 模板，粘到快捷指令的「运行脚本」输入里就能用。")
    } catch (e: any) {
      setDocNote("写剪贴板失败：" + (e?.message ?? String(e)))
    }
  }

  function handleRetry(id: string) {
    retryQueueItem(id)
    refresh()
  }

  function handleDrop(id: string) {
    dropQueueItem(id)
    refresh()
  }

  const apps = Array.from(new Set(items.map((it) => it.app).filter(Boolean))).sort()
  const shown = items.filter((it) => matches(it, query, appFilter))
  const groups = grouped(shown)

  return (
    <NavigationStack>
      <VStack
        navigationTitle="消息记录"
        navigationBarTitleDisplayMode="large"
        onAppear={refresh}
      >
        <Form>
          <Section title="概览">
            <HStack>
              <Text>总记录数</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{String(items.length)}</Text>
            </HStack>
            <HStack>
              <Text>等待处理的通知</Text>
              <Spacer />
              <Text foregroundStyle={pending > 0 ? "systemOrange" : "secondaryLabel"}>{String(pending)}</Text>
            </HStack>
            <HStack>
              <Text>处理失败的通知</Text>
              <Spacer />
              <Text foregroundStyle={failed.length > 0 ? "systemRed" : "secondaryLabel"}>{String(failed.length)}</Text>
            </HStack>
            <Button title="刷新" systemImage="arrow.clockwise" action={refresh} />
            <Button
              title="清空记录"
              role="destructive"
              systemImage="trash"
              action={clearAll}
              disabled={items.length === 0 && pending === 0 && failed.length === 0}
            />
          </Section>

          <Section
            header={<Text>怎么把消息送进来</Text>}
            footer={
              <Text>
                推荐用「打开 URL」调 `scripting://run/{scriptName()}?message=…`：App 会被拉到前台，AI 才能正常触发快捷指令。用「运行脚本」是后台进程，iOS 不允许后台拉别的 App。
              </Text>
            }
          >
            <DisclosureGroup
              isExpanded={runDocOpen}
              onChanged={setRunDocOpen}
              label={<Label title="message 链接怎么拼" systemImage="link" />}
            >
              <Markdown
                content={urlEntryDoc(scriptName())}
                theme="github"
                useDefaultHighlighterTheme
                scrollable={false}
              />
            </DisclosureGroup>
          </Section>

          {failed.length > 0 ? (
            <Section
              header={<Text>处理失败</Text>}
              footer={<Text>这些通知自动重试已经用尽（网络或模型出错）。可以重试一次，或直接丢掉。</Text>}
            >
              {failed.map((item) => (
                <FailedRow key={item.id} item={item} onRetry={handleRetry} onDiscard={handleDrop} />
              ))}
            </Section>
          ) : null}

          <Section title="查找">
            <TextField
              title=""
              prompt="搜发件人 / 内容 / 回复"
              value={query}
              onChanged={setQuery}
            />
            <Menu
              label={
                <HStack>
                  <Text>只看</Text>
                  <Spacer />
                  <Text foregroundStyle="secondaryLabel">{appFilter || "全部 App"}</Text>
                </HStack>
              }
            >
              <Button title="全部 App" action={() => setAppFilter("")} />
              {apps.map((app) => (
                <Button key={app} title={app} action={() => setAppFilter(app)} />
              ))}
            </Menu>
          </Section>

          {items.length === 0 ? (
            <Section title="分类记录">
              <SettingsEmptyRow icon="tray" title="还没有记录" detail="当通知通过快捷指令触发脚本后，会自动出现在这里。" />
            </Section>
          ) : shown.length === 0 ? (
            <Section title="分类记录">
              <SettingsEmptyRow icon="magnifyingglass" title="没有匹配的记录" detail="换个关键词，或把「只看」切回全部 App。" />
            </Section>
          ) : (
            groups.map((appGroup) => (
              <Section
                key={appGroup.app}
                header={<Text>{`${appGroup.app} · ${appGroup.count} 条`}</Text>}
                footer={<Text>最近：{formatTime(appGroup.lastAt)}</Text>}
              >
                {appGroup.senders.map((sender) => (
                  <SenderRow key={`${appGroup.app}:${sender.sender}`} item={sender} />
                ))}
              </Section>
            ))
          )}
          <Section
            header={<Text>怎么接微信 / 钉钉</Text>}
            footer={
              <Text>
                iOS 不允许脚本读别的 App 的通知，所以消息原文要由快捷指令交进来；这份说明里是完整的输入格式和配置步骤。
              </Text>
            }
          >
            <DisclosureGroup
              isExpanded={docOpen}
              onChanged={setDocOpen}
              label={<Label title="通知协议与快捷指令配置" systemImage="text.book.closed.fill" />}
            >
              <Markdown
                content={notifyDocMarkdown(scriptName())}
                theme="github"
                useDefaultHighlighterTheme
                scrollable={false}
              />
              <Button title="拷贝 JSON 模板" systemImage="doc.on.clipboard" action={copyTemplate} />
              {docNote ? (
                <Text font="footnote" foregroundStyle="secondaryLabel">
                  {docNote}
                </Text>
              ) : null}
            </DisclosureGroup>
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default RecordsPage
