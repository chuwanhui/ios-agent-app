import { Button, Form, HStack, ProgressView, Section, Spacer, Text, VStack, useEffect, useState } from "scripting"
import {
  RunLogEntry, RunSource, clearRunLog, loadRunLog, runLogStats,
} from "../core/diagnostics/store"
import { compactStore, dataPath, storeStats } from "../core/store/store"
import { bootTimings, storageDegraded } from "../core/store/init"
import { SettingsEmptyRow, SettingsSummaryRow } from "../ui/settings"

/**
 * 诊断：最近每一轮跑得怎么样。
 *
 * 出问题时先看这一页，能立刻回答三个问题：
 *   ① 慢在哪 —— 平均 / 最慢耗时、模型往返了几次；
 *   ② 花在哪 —— 输入 / 输出 / 缓存命中的 token 合计；
 *   ③ 错在哪 —— 失败原因汇总 + 每次的工具成败。
 * 只记数字不记正文，所以可以放心留着。
 */

const SOURCE_LABEL: Record<RunSource, string> = {
  chat: "聊天",
  notify: "通知",
  callback: "回传续跑",
  compress: "记忆压缩",
  other: "其它",
}

/** 只展示最近这么多条，多了看不过来（文件里最多留 120 条）。 */
const SHOW_LATEST = 25

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n)
}

function stamp(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 毫秒 → 「1.2 秒」/「840 毫秒」。 */
function fmtMs(ms: number): string {
  if (ms < 1000) return ms + " 毫秒"
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " 秒"
}

/** 字节 → 「1.2 MB」。 */
function fmtBytes(n: number): string {
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
  return (n / 1024 / 1024).toFixed(1) + " MB"
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k"
}

function RunRow({ entry }: { entry: RunLogEntry }) {
  const tokens =
    entry.inputTokens || entry.outputTokens
      ? `↑${fmtTokens(entry.inputTokens ?? 0)} ↓${fmtTokens(entry.outputTokens ?? 0)}`
      : "无用量"
  const cached = entry.cachedInputTokens ?? 0
  const toolText = entry.tools > 0 ? `工具 ${entry.tools} 次${entry.failedTools > 0 ? `（失败 ${entry.failedTools}）` : ""}` : "没调工具"
  const detail = [
    entry.model || "未知模型",
    `${entry.rounds} 轮对话`,
    toolText,
    tokens + (cached > 0 ? ` 缓存 ${fmtTokens(cached)}` : ""),
    entry.aborted ? "已手动停止" : "",
  ].filter(Boolean).join(" · ")

  return (
    <VStack spacing={4} padding={{ vertical: 5 }}>
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Text fontWeight="semibold">{SOURCE_LABEL[entry.source] ?? "其它"}</Text>
        {entry.ok ? <Text font="caption" foregroundStyle="secondaryLabel">成功</Text> : null}
        {entry.ok ? null : <Text font="caption" foregroundStyle="systemRed">失败</Text>}
        <Spacer />
        <Text font="footnote" foregroundStyle="secondaryLabel">{fmtMs(entry.ms)}</Text>
        <Text font="caption2" foregroundStyle="tertiaryLabel">{stamp(entry.at)}</Text>
      </HStack>
      <Text font="caption2" foregroundStyle="secondaryLabel">{detail}</Text>
      {entry.error ? (
        <Text font="caption2" foregroundStyle="systemRed" lineLimit={3}>{entry.error}</Text>
      ) : null}
    </VStack>
  )
}

interface StorageInfo {
  bytes: number
  sessions: number
  records: number
  runs: number
  tempFiles: number
}

export function DiagnosticsPage() {
  const [entries, setEntries] = useState<RunLogEntry[]>(() => loadRunLog())
  const [storage, setStorage] = useState<StorageInfo | null>(null)

  function refresh() {
    setEntries(loadRunLog())
    void storeStats()
      .then((s) => setStorage(s))
      .catch(() => setStorage(null))
  }

  useEffect(() => {
    refresh()
  }, [])

  async function compact() {
    try {
      const removed = await compactStore()
      refresh()
      Dialog.alert({
        message: removed > 0 ? `清掉了 ${removed} 个残留文件。` : "没有找到残留文件，不需要清理。",
      })
    } catch (e: any) {
      Dialog.alert({ message: "整理失败：" + (e?.message ?? String(e)) })
    }
  }

  async function clearAll() {
    const ok = await Dialog.confirm({
      title: "清空诊断记录",
      message: "只删本地这些运行统计，不影响聊天记录和配置。",
      confirmLabel: "清空",
    })
    if (!ok) return
    clearRunLog()
    refresh()
  }

  const stats = runLogStats(entries)
  const latest = entries.slice(0, SHOW_LATEST)

  return (
    <VStack
      navigationTitle="诊断"
      navigationBarTitleDisplayMode="inline"
      onAppear={refresh}
    >
      <Form>
        <Section
          header={<Text>概览</Text>}
          footer={<Text>只记耗时、轮次和 token 这些数字，不记对话内容。</Text>}
        >
          {stats.total === 0 ? (
            <SettingsEmptyRow
              icon="waveform.path.ecg"
              title="还没有运行记录"
              detail="聊一句、或让通知跑一轮之后，这里就会出现统计。"
            />
          ) : (
            <VStack spacing={2}>
              <SettingsSummaryRow
                icon={{ name: "number", color: "systemBlue" }}
                title="最近运行"
                value={`${stats.total} 次 · 成功 ${Math.round(stats.okRate * 100)}%`}
              />
              <SettingsSummaryRow
                icon={{ name: "stopwatch", color: "systemOrange" }}
                title="耗时"
                value={`平均 ${fmtMs(stats.avgMs)} · 最慢 ${fmtMs(stats.maxMs)}`}
              />
              <SettingsSummaryRow
                icon={{ name: "arrow.up.arrow.down", color: "systemPurple" }}
                title="Token"
                value={`↑${fmtTokens(stats.inputTokens)} ↓${fmtTokens(stats.outputTokens)}`}
              />
              <SettingsSummaryRow
                icon={{ name: "bolt.horizontal.fill", color: "systemGreen" }}
                title="缓存命中"
                value={stats.cachedInputTokens > 0
                  ? `${fmtTokens(stats.cachedInputTokens)}（占总输入 ${Math.round((stats.cachedInputTokens / Math.max(1, stats.inputTokens)) * 100)}%）`
                  : "没有命中"}
              />
              <SettingsSummaryRow
                icon={{ name: "wrench.and.screwdriver.fill", color: "systemIndigo" }}
                title="工具调用"
                value={stats.tools === 0 ? "没有调用" : `${stats.tools} 次 · 失败 ${stats.failedTools} 次`}
              />
            </VStack>
          )}
        </Section>

        {stats.topErrors.length > 0 ? (
          <Section header={<Text>最常见的问题</Text>}>
            {stats.topErrors.map((e) => (
              <VStack key={e.message} spacing={3} padding={{ vertical: 4 }}>
                <Text font="footnote" foregroundStyle="systemRed" lineLimit={3}>{e.message}</Text>
                <Text font="caption2" foregroundStyle="secondaryLabel">{`出现 ${e.count} 次`}</Text>
              </VStack>
            ))}
          </Section>
        ) : null}

        {latest.length > 0 ? (
          <Section
            header={<Text>{`最近 ${latest.length} 次`}</Text>}
            footer={<Text>点右上角刷新可以看最新的运行。</Text>}
          >
            {latest.map((e, i) => (
              <RunRow key={`${e.at}-${i}`} entry={e} />
            ))}
          </Section>
        ) : null}

        <Section
          header={<Text>数据存在哪</Text>}
          footer={
            <Text>
              配置、聊天记录、通知记录、索引、队列全在这一个目录里（一个键一个文件，备份就拷它）；Key 不在这里，它在系统钥匙串。
            </Text>
          }
        >
          <VStack spacing={3} padding={{ vertical: 4 }}>
            <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={2}>
              {dataPath()}
            </Text>
            {storageDegraded() ? (
              <Text font="caption2" foregroundStyle="systemRed">
                本次写不进数据目录，改动只在内存里，退出后就没了。检查一下手机存储空间。
              </Text>
            ) : null}
            {storage ? (
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                {`${fmtBytes(storage.bytes)} · 会话 ${storage.sessions} 个 · 通知记录 ${storage.records} 条 · 诊断 ${storage.runs} 条${storage.tempFiles > 0 ? ` · 残留 ${storage.tempFiles} 个` : ""}`}
              </Text>
            ) : (
              <Text font="caption2" foregroundStyle="tertiaryLabel">读取中…</Text>
            )}
          </VStack>
          <Button
            title="清理残留文件"
            systemImage="arrow.triangle.2.circlepath"
            action={compact}
          />
        </Section>

        <Section
          header={<Text>启动耗时</Text>}
          footer={
            <Text>
              快捷指令 / 小组件每次都是新进程，这里是把数据从磁盘读进内存花的时间（不含模型请求）。哪一段特别大，就说明那一块该瘦身。
            </Text>
          }
        >
          {(() => {
            const boot = bootTimings()
            if (!boot) {
              return <SettingsEmptyRow icon="stopwatch" title="还没有记录" detail="重启一次 App 就能看到。" />
            }
            const slow = Math.max(1, ...boot.phases.map((p) => p.ms))
            return (
              <VStack spacing={6} padding={{ vertical: 4 }} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font="footnote" foregroundStyle="secondaryLabel">
                  {`合计 ${boot.totalMs}ms${boot.degraded ? "（数据目录不可写）" : ""}`}
                </Text>
                {boot.phases.map((p) => (
                  <HStack key={p.label} spacing={8}>
                    <Text font="caption" foregroundStyle="label" frame={{ width: 96, alignment: "leading" }} lineLimit={1}>
                      {p.label}
                    </Text>
                    <ProgressView value={p.ms / slow} />
                    <Text font="caption2" foregroundStyle="tertiaryLabel" frame={{ width: 56, alignment: "trailing" }}>
                      {`${p.ms}ms`}
                    </Text>
                  </HStack>
                ))}
              </VStack>
            )
          })()}
        </Section>

        <Section>
          <Button title="刷新" systemImage="arrow.clockwise" action={refresh} />
          <Button
            title="清空诊断记录"
            role="destructive"
            systemImage="trash"
            action={clearAll}
            disabled={entries.length === 0}
          />
        </Section>
      </Form>
    </VStack>
  )
}

export default DiagnosticsPage
