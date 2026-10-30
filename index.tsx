import { Label, Navigation, Script, TabView, VStack, useState } from "scripting"
import { CapabilitiesPage } from "./capabilities_page"
import { ChatPage } from "./chat_page"
import { ConfigPage } from "./config_page"
import { openRootRoute, willSwitchTabOnRoot } from "./nav_route"

function AgentApp() {
  const [tabIndex, setTabIndex] = useState(0)

  function openSettings(route = "") {
    willSwitchTabOnRoot(null) // 清除能力标签的回调
    setTabIndex(2)
    setTimeout(() => openRootRoute(route), 0)
  }

  function openCapability(route: string) {
    // 切到设置标签打开目标管理页；注册一次性回调，保存返回设置首页后自动切回能力标签。
    willSwitchTabOnRoot(() => setTabIndex(1))
    setTabIndex(2)
    setTimeout(() => openRootRoute(route), 0)
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
        tabItem={<Label title="能力" systemImage="sparkles" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <CapabilitiesPage onOpen={openCapability} />
      </VStack>
      <VStack
        tag={2}
        tabItem={<Label title="设置" systemImage="gearshape.fill" />}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <ConfigPage embedded showManagementSections={false} />
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
