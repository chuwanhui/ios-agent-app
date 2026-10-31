import {
  Button, HStack, ScrollView, Spacer, Text, VStack,
} from "scripting"
import { MessageRecord } from "../core/records/store"
import { ChatMessage, loadConfig, loadStore } from "../core/agent/store"
import { memoryKeyOf } from "../core/notify/session"
import { AssistantMessage, Bubble } from "../chat/message"

/**
 * 一个发件人的完整往来。
 *
 * 记录页列表只放得下一行「最近收到 / 最近回复」，想看清到底聊了什么就得进来：
 * 这里按时间从早到晚，把每条「收到的原文」和「当时的回复」一对一对摊开，
 * 长得和聊天页一模一样（同一套气泡），看起来不用重新适应。
 */

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n)
}

/** 「10-31 14:07」——同一年不写年份，省地方。 */
function stamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const day = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return d.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${d.getFullYear()}-${day} ${time}`
}

/** 这个发件人在「聊天」里的那条会话（「App + 发件人」锁定一个会话）。 */
function sessionIdOf(app: string, sender: string): string {
  try {
    const key = memoryKeyOf(app, sender)
    return loadStore().sessions.find((s) => s.memoryKey === key)?.id ?? ""
  } catch {
    return ""
  }
}

export function SenderThreadPage({
  app, sender, items, onOpenChat,
}: {
  app: string
  sender: string
  /** 这个发件人的全部记录（顺序随意，这里自己排）。 */
  items: MessageRecord[]
  /** 跳到「聊天」里那条会话继续聊。 */
  onOpenChat?: (sessionId: string) => void
}) {
  const cfg = loadConfig()
  const avatar = { path: cfg.avatarPath }
  const ordered = items.slice().sort((a, b) => (a.at || 0) - (b.at || 0))
  const sessionId = sessionIdOf(app, sender)

  return (
    <VStack
      navigationTitle={sender}
      navigationBarTitleDisplayMode="inline"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
    >
      <ScrollView>
        <VStack spacing={0} padding={{ top: 12, bottom: 24 }} frame={{ maxWidth: "infinity" }}>
          <HStack spacing={0} padding={{ horizontal: 16, bottom: 6 }} frame={{ maxWidth: "infinity" }}>
            <Spacer />
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              {`来自 ${app} · 共 ${ordered.length} 条`}
            </Text>
            <Spacer />
          </HStack>

          {ordered.length === 0 ? (
            <HStack padding={{ horizontal: 16, vertical: 24 }} frame={{ maxWidth: "infinity" }}>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">这个发件人还没有留下记录。</Text>
              <Spacer />
            </HStack>
          ) : null}

          {ordered.map((r) => (
            <VStack key={r.id} spacing={0} frame={{ maxWidth: "infinity" }}>
              <HStack spacing={0} padding={{ top: 10, bottom: 2 }} frame={{ maxWidth: "infinity" }}>
                <Spacer />
                <Text font="caption2" foregroundStyle="tertiaryLabel">{stamp(r.at)}</Text>
                <Spacer />
              </HStack>
              <Bubble message={{ role: "user", content: r.content } as ChatMessage} avatar={avatar} />
              {r.reply ? (
                <AssistantMessage
                  message={{ role: "assistant", content: r.reply } as ChatMessage}
                  avatar={avatar}
                  showSteps={false}
                />
              ) : (
                <HStack spacing={0} padding={{ horizontal: 16, vertical: 4 }} frame={{ maxWidth: "infinity" }}>
                  <Text font="footnote" foregroundStyle="tertiaryLabel">（这一轮没有回复）</Text>
                  <Spacer />
                </HStack>
              )}
            </VStack>
          ))}
        </VStack>
      </ScrollView>

      {sessionId && onOpenChat ? (
        <VStack spacing={0} padding={{ horizontal: 16, top: 8, bottom: 16 }}>
          <Button
            title="打开和 TA 的聊天"
            systemImage="bubble.left.and.bubble.right.fill"
            action={() => onOpenChat(sessionId)}
          />
        </VStack>
      ) : null}
    </VStack>
  )
}
