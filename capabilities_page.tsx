import { Form, NavigationStack, Section, VStack, useState } from "scripting"
import { AgentConfig, loadConfig } from "./agent_store"
import { kbStats } from "./kb_store"
import { skillCounts } from "./skills_store"
import { SettingsNavRow } from "./settings_ui"

export function CapabilitiesPage({ onOpen }: { onOpen: (route: string) => void }) {
  const [cfg, setCfg] = useState<AgentConfig>(() => loadConfig())
  const kb = kbStats()
  const skills = skillCounts()
  const tools = cfg.tools ?? []
  const servers = cfg.mcpServers ?? []

  return (
    <NavigationStack>
      <VStack
        navigationTitle="能力"
        navigationBarTitleDisplayMode="large"
        onAppear={() => setCfg(loadConfig())}
      >
        <Form>
          <Section title="智能体">
            <SettingsNavRow
              icon={{ name: "books.vertical.fill", color: "systemPurple" }}
              title="知识库"
              detail={kb.docs > 0 ? `${kb.docs} 份资料 · ${kb.chunks} 个片段` : "导入资料供智能体检索"}
              onOpen={() => onOpen("kb")}
            />
            <SettingsNavRow
              icon={{ name: "shippingbox.fill", color: "systemIndigo" }}
              title="技能"
              detail={skills.total > 0 ? `${skills.total} 个技能 · 启用 ${skills.enabled} 个` : "导入并管理技能"}
              onOpen={() => onOpen("skills")}
            />
          </Section>

          <Section title="工具">
            <SettingsNavRow
              icon={{ name: "bolt.fill", color: "systemOrange" }}
              title="快捷指令"
              detail={tools.length > 0 ? `已配置 ${tools.length} 个工具` : "连接本地快捷指令"}
              onOpen={() => onOpen("tools")}
            />
            <SettingsNavRow
              icon={{ name: "server.rack", color: "systemBlue" }}
              title="MCP 服务器"
              detail={
                servers.length > 0
                  ? `${servers.length} 台服务器 · 启用 ${servers.filter((item) => item.enabled).length} 台`
                  : "连接外部工具服务"
              }
              onOpen={() => onOpen("mcp")}
            />
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default CapabilitiesPage
