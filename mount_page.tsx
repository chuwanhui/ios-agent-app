import {
  Button, Form, NavigationStack, Section, Text, Toggle, VStack, useState,
} from "scripting"
import { AgentConfig, SessionMounts, mountsFromConfig } from "./agent_store"
import { listSkills } from "./skills_store"
import { SettingsEmptyRow, SettingsSummaryRow } from "./settings_ui"

interface Props {
  /** 当前设置（决定「跟随设置」时能挂哪些东西）。 */
  cfg: AgentConfig
  /** 当前会话的挂载；undefined = 跟随设置页里的默认。 */
  mounts?: SessionMounts
  onChange: (mounts?: SessionMounts) => void
  /** 关闭本页（由聊天页控制 sheet 状态）。 */
  onClose?: () => void
}

/**
 * 会话级挂载面板：这一轮对话要用哪些能力。
 * 跟「设置页里的默认」是两码事——这里只影响当前会话，会跟历史一起存下来。
 */
export function MountPage({ cfg, mounts, onChange, onClose = () => {} }: Props) {
  const skills = listSkills().filter((s) => s.enabled)
  const usingDefault = mounts == null
  const eff = mounts ?? mountsFromConfig(cfg, skills.map((s) => s.id))

  function set(p: Partial<SessionMounts>) {
    onChange({ ...eff, ...p })
  }

  function flip(list: string[], id: string): string[] {
    return list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : [...list, id]
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle="会话能力"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          topBarTrailing: <Button title="完成" action={onClose} fontWeight="semibold" />,
        }}
      >
        <Form>
          <Section
            footer={<Text>单独设置只影响当前会话。</Text>}
          >
            <SettingsSummaryRow
              icon={{ name: "slider.horizontal.3", color: usingDefault ? "systemGray" : "systemBlue" }}
              title="配置模式"
              value={usingDefault ? "跟随默认" : "单独设置"}
            />
            <Button
              title="恢复跟随设置"
              systemImage="arrow.uturn.backward"
              disabled={usingDefault}
              action={() => onChange(undefined)}
            />
          </Section>

          <Section
            header={<Text>知识库</Text>}
            footer={
              <Text>
                {cfg.kbEnabled
                  ? "回答前检索已导入的资料。"
                  : "默认设置未开启知识库，挂载后也不会生效。"}
              </Text>
            }
          >
            <Toggle
              title="挂载知识库"
              value={eff.kb}
              onChanged={(v) => set({ kb: v })}
            />
          </Section>

          <Section
            header={<Text>技能</Text>}
            footer={<Text>仅向当前会话提供已选择的技能。</Text>}
          >
            {skills.length === 0 ? (
              <SettingsEmptyRow icon="shippingbox" title="没有启用中的技能" />
            ) : (
              skills.map((s) => (
                <Toggle
                  key={s.id}
                  title={s.name}
                  value={eff.skills.indexOf(s.id) >= 0}
                  onChanged={() => set({ skills: flip(eff.skills, s.id) })}
                />
              ))
            )}
          </Section>

          <Section
            header={<Text>本地快捷指令工具</Text>}
            footer={<Text>仅向当前会话提供已选择的快捷指令。</Text>}
          >
            {cfg.tools.length === 0 ? (
              <SettingsEmptyRow icon="bolt" title="没有快捷指令工具" />
            ) : (
              cfg.tools.map((t) => (
                <Toggle
                  key={t.name}
                  title={t.name}
                  value={eff.tools.indexOf(t.name) >= 0}
                  onChanged={() => set({ tools: flip(eff.tools, t.name) })}
                />
              ))
            )}
          </Section>

          <Section
            header={<Text>MCP 服务器</Text>}
            footer={<Text>仅连接当前会话需要的服务器。</Text>}
          >
            {cfg.mcpServers.length === 0 ? (
              <SettingsEmptyRow icon="server.rack" title="没有 MCP 服务器" />
            ) : (
              cfg.mcpServers.map((m) => (
                <Toggle
                  key={m.id}
                  title={m.name.trim() || m.id}
                  value={eff.mcp.indexOf(m.id) >= 0}
                  onChanged={() => set({ mcp: flip(eff.mcp, m.id) })}
                />
              ))
            )}
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

/** 聊天页 composer 上方的小标签：一眼看出这个会话挂载了什么。 */
export function mountChips(mounts?: SessionMounts): Array<{ key: string; label: string }> {
  if (!mounts) return []
  return [
    { key: "kb", label: mounts.kb ? "📚 知识库" : "🚫 知识库" },
    {
      key: "skills",
      label: mounts.skills.length > 0 ? `🧩 技能 ${mounts.skills.length}` : "🚫 技能",
    },
    {
      key: "tools",
      label: mounts.tools.length > 0 ? `⚡ 快捷指令 ${mounts.tools.length}` : "🚫 快捷指令",
    },
    { key: "mcp", label: mounts.mcp.length > 0 ? `🔌 MCP ${mounts.mcp.length}` : "🚫 MCP" },
  ]
}

export default MountPage
