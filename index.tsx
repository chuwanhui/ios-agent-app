import { Label, Navigation, Script, TabView, VStack, useState } from "scripting"
import { CapabilitiesPage } from "./capabilities/page"
import { ChatPage } from "./chat/page"
import { ConfigPage } from "./settings/page"
import { RecordsPage } from "./records/page"
import { loadStore, pruneOrphanImages } from "./core/agent/store"
import { drainNotifications } from "./core/notify/drain"
import { openRootRoute, willSwitchTabOnRoot } from "./app/nav_route"
import { initStorage } from "./core/db/init"

function AgentApp() {
  const [tabIndex, setTabIndex] = useState(0)

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
        <ChatPage embedded onOpenSettings={openSettings} />
      </VStack>
      <VStack
        tag={1}
        tabItem={<Label title="记录" systemImage="clock.arrow.circlepath" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <RecordsPage />
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

  // 打开就把积压的通知排空（以前只有「下一条通知到达」时才会顺带触发）。
  // 不 await：界面先出来，队列在后台跑。
  try {
    void drainNotifications({ deadlineMs: 60_000 })
  } catch {
    // 排队失败不影响使用
  }

  await Navigation.present({
    element: <AgentApp />,
    modalPresentationStyle: "fullScreen",
  })
  Script.exit()
}

run()
