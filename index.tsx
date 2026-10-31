import { Label, Navigation, Script, TabView, VStack, useEffect, useState } from "scripting"
import { CapabilitiesPage } from "./capabilities/page"
import { ChatPage } from "./chat/page"
import { ChatSeed, messageFrom, messageParam, seedFromMessage } from "./core/agent/url_entry"
import { ConfigPage } from "./settings/page"
import { RecordsPage } from "./records/page"
import { loadStore, pruneOrphanImages } from "./core/agent/store"
import { drainNotifications } from "./core/notify/drain"
import { openRootRoute, willSwitchTabOnRoot } from "./app/nav_route"
import { initStorage } from "./core/store/init"

function AgentApp({ initialSeed = null }: { initialSeed?: ChatSeed | null }) {
  const [tabIndex, setTabIndex] = useState(0)
  /** 交给聊天页执行的一条入口动作（URL 入口 / 从记录页点进来）。 */
  const [seed, setSeed] = useState<ChatSeed | null>(initialSeed)

  /** 从「记录」页点进某个发件人后，跳回聊天标签并落到 TA 的那条会话。 */
  function openChatSession(sessionId: string) {
    setTabIndex(0)
    setSeed({ sessionId, text: "" })
  }

  /**
   * Scripting 已经开着时，`scripting://run/智能体?message=…` 是一次「唤起」，不是冷启动。
   * 入口必须在 App 壳层接：先把用户带回「聊天」标签，再解析通知并切到对应会话。
   *
   * 以前在 ChatPage 内接也能处理消息，但若用户当时停在「记录」或「设置」，底部标签不切，
   * 看起来就像「打开了 Scripting，却没展示聊天」。回传 URL 没有 message，不会进这条。
   */
  useEffect(() => {
    const off = Script.onResume((event: any) => {
      const text = messageFrom(event?.queryParameters ?? null)
      if (!text.trim()) return
      setTabIndex(0)
      void (async () => {
        try {
          const incoming = await seedFromMessage(text)
          if (incoming) setSeed(incoming)
        } catch (e: any) {
          console.log("处理 URL 唤起消息失败：" + (e?.message ?? String(e)))
        }
      })()
    })
    return () => {
      if (typeof off === "function") off()
    }
  }, [])

  function openSettings(route = "") {
    willSwitchTabOnRoot(null) // 清除能力标签的回调
    setTabIndex(3)
    // 设置页的导航 path 是在切标签后的 effect 里才登记上的，这里重试几次保证路由生效。
    const tryOpen = (left: number) => {
      if (!route) {
        openRootRoute("")
        return
      }
      openRootRoute(route)
      if (left > 0) setTimeout(() => tryOpen(left - 1), 80)
    }
    setTimeout(() => tryOpen(2), 0)
  }

  return (
    <TabView tabIndex={tabIndex} onTabIndexChanged={setTabIndex}>
      <VStack
        tag={0}
        tabItem={<Label title="聊天" systemImage="bubble.left.and.bubble.right.fill" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <ChatPage
          embedded
          onOpenSettings={openSettings}
          seed={seed}
          onSeedConsumed={() => setSeed(null)}
        />
      </VStack>
      <VStack
        tag={1}
        tabItem={<Label title="记录" systemImage="clock.arrow.circlepath" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <RecordsPage active={tabIndex === 1} onOpenChat={openChatSession} />
      </VStack>
      <VStack
        tag={2}
        tabItem={<Label title="能力" systemImage="sparkles" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <CapabilitiesPage active={tabIndex === 2} />
      </VStack>
      <VStack
        tag={3}
        tabItem={<Label title="设置" systemImage="gearshape.fill" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <ConfigPage embedded active={tabIndex === 3} showManagementSections={false} />
      </VStack>
    </TabView>
  )
}

async function run() {
  // 第一件事：把数据库里的配置 / 会话 / 索引读进内存，后面所有同步读才拿得到数据。
  await initStorage()

  // 启动清理：删会话 / 裁剪历史不会自动删聊天图片，这里扫一遍没人引用的文件。
  try {
    pruneOrphanImages(loadStore())
  } catch {
    // 清理失败不影响启动
  }

  // —— URL 入口：scripting://run/智能体?message=… ——
  // 快捷指令用「打开 URL」把 App 拉到前台再跑，AI 才是真的在前台，
  // 需要时能正常拉起别的快捷指令（后台进程做不到，这是 iOS 的限制）。
  // 通知会落到「App + 发件人」那条会话上，普通文本就落在当前会话。
  let seed: ChatSeed | null = null
  try {
    seed = await seedFromMessage(messageParam())
  } catch (e: any) {
    console.log("处理 URL 入口消息失败：" + (e?.message ?? String(e)))
  }

  // 打开就把积压的通知排空（以前只有「下一条通知到达」时才会顺带触发）。
  // 不 await：界面先出来，队列在后台跑。
  try {
    void drainNotifications({ deadlineMs: 60_000 })
  } catch {
    // 排队失败不影响使用
  }

  await Navigation.present({
    element: <AgentApp initialSeed={seed} />,
    modalPresentationStyle: "fullScreen",
  })
  Script.exit()
}

run()
