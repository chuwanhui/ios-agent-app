import { Button, EmptyView, Form, NavigationStack, Section, Text, VStack, useEffect, useRef, useState } from "scripting"
import { AgentConfig, McpServer, loadConfig, saveConfig } from "../core/agent/store"
import { kbStats } from "../core/kb/store"
import { skillCounts } from "../core/skills/store"
import { KbPage } from "./kb"
import { McpPage } from "./mcp"
import { SkillsPage } from "./skills"
import { ToolRow, ToolsPage, toToolRow, toAgentTools } from "./tools"
import {
  activateNavPath, buildRoute, clearToRoot, popRoute, pushRoute, registerNavPath, registerRoute,
} from "../app/nav_route"
import { SettingsNavRow } from "../ui/settings"

function RouteMissing({ route }: { route: string }) {
  return (
    <VStack spacing={12} navigationTitle="打不开这一页">
      <Text foregroundStyle="secondaryLabel">{`没有登记的路由「${route}」。`}</Text>
      <Button title="返回上一级" action={() => popRoute()} />
    </VStack>
  )
}

const NAV_KEY = "capabilities"

export function CapabilitiesPage({ active = true }: { active?: boolean }) {
  const [cfg, setCfg] = useState<AgentConfig>(() => loadConfig())
  const [navPath, setNavPath] = useState<string[]>([])
  /** 给导航总线读的“最新 path”，避免闭包里拿到旧快照。 */
  const pathRef = useRef<string[]>(navPath)
  pathRef.current = navPath
  const kb = kbStats()
  const skills = skillCounts()
  const tools = cfg.tools ?? []
  const servers = cfg.mcpServers ?? []

  useEffect(() => {
    if (!active) {
      registerNavPath(NAV_KEY, null)
      return
    }
    registerNavPath(NAV_KEY, {
      get: () => pathRef.current,
      set: (v) => setNavPath((prev) => (typeof v === "function" ? (v as (p: string[]) => string[])(prev) : v)),
    })
    activateNavPath(NAV_KEY)
    return () => registerNavPath(NAV_KEY, null)
  }, [active])

  function patch(p: Partial<AgentConfig>) {
    const next = { ...loadConfig(), ...p }
    void saveConfig(next)
    setCfg(loadConfig())
  }

  registerRoute("cap-kb", () => <KbPage onChanged={() => setCfg(loadConfig())} />)
  registerRoute("cap-skills", () => (
    <SkillsPage onChanged={() => setCfg(loadConfig())} detailRoutePrefix="cap-skill:" />
  ))
  registerRoute("cap-tools", () => (
    <ToolsPage
      rows={(cfg.tools ?? []).map((t) => toToolRow(t))}
      detailRoutePrefix="cap-tool:"
      onChange={(rows: ToolRow[]) => {
        const complete = rows.filter((r) => {
          const empty = !(r.name ?? "").trim() && !(r.shortcutName ?? "").trim() && !(r.description ?? "").trim()
          return empty || !!(r.shortcutName ?? "").trim()
        })
        const toolsNext = toAgentTools(complete).tools
        patch({ tools: toolsNext })
      }}
    />
  ))
  registerRoute("cap-mcp", () => (
    <McpPage
      servers={(cfg.mcpServers ?? []).map((m) => ({ ...m }))}
      onChange={(next: McpServer[]) => patch({ mcpServers: next })}
    />
  ))

  const firstRoute = navPath[0] ?? ""
  const secondRoute = navPath[1] ?? ""
  const secondDestination = (
    <VStack key={"lvl2:" + secondRoute} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {secondRoute ? buildRoute(secondRoute) ?? <RouteMissing route={secondRoute} /> : <EmptyView />}
    </VStack>
  )
  const firstDestination = (
    <VStack
      key={"lvl1:" + firstRoute}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      navigationDestination={{
        isPresented: secondRoute !== "",
        onChanged: (presented) => {
          if (!presented) setNavPath((path) => path.slice(0, 1))
        },
        content: secondDestination,
      }}
    >
      {firstRoute ? buildRoute(firstRoute) ?? <RouteMissing route={firstRoute} /> : <EmptyView />}
    </VStack>
  )

  return (
    <NavigationStack>
      <VStack
        navigationTitle="能力"
        navigationBarTitleDisplayMode="large"
        onAppear={() => setCfg(loadConfig())}
        navigationDestination={{
          isPresented: firstRoute !== "",
          onChanged: (presented) => {
            if (!presented) clearToRoot()
          },
          content: firstDestination,
        }}
      >
        <Form>
          <Section title="智能体">
            <SettingsNavRow
              icon={{ name: "books.vertical.fill", color: "systemPurple" }}
              title="知识库"
              detail={kb.docs > 0 ? `${kb.docs} 份资料 · ${kb.chunks} 个片段` : "导入资料供智能体检索"}
              onOpen={() => pushRoute("cap-kb")}
            />
            <SettingsNavRow
              icon={{ name: "shippingbox.fill", color: "systemIndigo" }}
              title="技能"
              detail={skills.total > 0 ? `${skills.total} 个技能 · 启用 ${skills.enabled} 个` : "导入并管理技能"}
              onOpen={() => pushRoute("cap-skills")}
            />
          </Section>

          <Section title="工具">
            <SettingsNavRow
              icon={{ name: "bolt.fill", color: "systemOrange" }}
              title="快捷指令"
              detail={tools.length > 0 ? `已配置 ${tools.length} 个工具` : "连接本地快捷指令"}
              onOpen={() => pushRoute("cap-tools")}
            />
            <SettingsNavRow
              icon={{ name: "server.rack", color: "systemBlue" }}
              title="MCP 服务器"
              detail={
                servers.length > 0
                  ? `${servers.length} 台服务器 · 启用 ${servers.filter((item) => item.enabled).length} 台`
                  : "连接外部工具服务"
              }
              onOpen={() => pushRoute("cap-mcp")}
            />
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default CapabilitiesPage
