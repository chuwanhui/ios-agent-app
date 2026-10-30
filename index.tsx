import { Label, Navigation, Script, TabView, VStack, useState } from "scripting"
import { CapabilitiesPage } from "./capabilities/page"
import { ChatPage } from "./chat/page"
import { ConfigPage } from "./settings/page"
import { RecordsPage } from "./records/page"
import { openRootRoute, willSwitchTabOnRoot } from "./app/nav_route"

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
  await Navigation.present({
    element: <AgentApp />,
    modalPresentationStyle: "fullScreen",
  })
  Script.exit()
}

run()
