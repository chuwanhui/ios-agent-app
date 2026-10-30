import {
  Button, EmptyView, Form, HStack, Markdown, NavigationStack, Picker, Section,
  Spacer, Text, TextField, Toggle, VStack, useEffect, useRef, useState,
} from "scripting"
import {
  AgentConfig, DEFAULT_PERSONA, DEFAULT_SYSTEM_PROMPT, McpServer, ModelProvider, loadConfig, makeMcpServer, saveConfig,
} from "../core/agent/store"
import { kbStats } from "../core/kb/store"
import { ModelsPage, providerLabel, providerSubtitle, toProviders } from "./models"
import { DiagnosticsPage } from "./diagnostics"
import { skillCounts } from "../core/skills/store"
import { KbPage } from "../capabilities/kb"
import { SkillsPage } from "../capabilities/skills"
import { ToolRow, ToolsPage, toAgentTools, toToolRow } from "../capabilities/tools"
import { FieldRow } from "../ui/forms"
import { McpPage } from "../capabilities/mcp"
import { buildRoute, clearToRoot, popRoute, pushRoute, registerNavPath, registerRoute, activateNavPath } from "../app/nav_route"
import { SettingsNavRow, SettingsSummaryRow } from "../ui/settings"
import {
  AVATAR_PATH, Avatar, chooseAvatarFromPhotos, commitAvatar,
} from "../ui/avatar"

// ———————————————————————— 思考深度 ————————————————————————

type ThinkingTier = "off" | "low" | "medium" | "high"

const TIERS: { key: ThinkingTier; label: string; desc: string; cost: string }[] = [
  { key: "off", label: "关闭", desc: "不做额外推理，直接给答案", cost: "最快、最省 token" },
  { key: "low", label: "浅层", desc: "想一点点，适合简单问答", cost: "较快、消耗少" },
  { key: "medium", label: "标准", desc: "先理一遍再回答，日常够用", cost: "适中" },
  { key: "high", label: "深度", desc: "反复斟酌，多步任务更稳", cost: "最慢、最费 token" },
]


/** 列表里显示性格摘要：取第一行有内容的文字，去掉 Markdown 记号。 */
function personaSummary(text: string): string {
  const line = (text || "")
    .split("\n")
    .map((s) => s.replace(/^[#>*\-+\s]+/, "").trim())
    .find((s) => s.length > 0)
  if (!line) return "还没有设定性格"
  return line.length > 26 ? line.slice(0, 26) + "…" : line
}

/** 把配置里的 thinkingEnabled + reasoningEffort 反解成档位。 */
function tierOf(cfg: AgentConfig): ThinkingTier {
  if (!cfg.thinkingEnabled) return "off"
  const effort = (cfg.reasoningEffort || "").toLowerCase()
  return effort === "low" || effort === "medium" ? effort : "high"
}

export interface FormState {
  // 角色
  agentName: string
  /** 头像图片路径；空 = 显示占位图。选择照片时先指向暂存文件，保存时才转正。 */
  avatarPath: string
  /** 助手的性格 / 角色（Markdown）；空 = 不加额外性格。 */
  persona: string
  // 模型供应商：每家一套地址 / Key / 模型，聊天用 activeProviderId 那一家
  providers: ModelProvider[]
  activeProviderId: string
  // 对话
  /** 智能体设定：发给模型的系统提示词。 */
  systemPrompt: string
  /** 上下文聊天记录数量（以文本保存，空值在保存时兜底 50）。 */
  maxHistory: string
  /** 思考深度档位，保存时映射回 thinkingEnabled + reasoningEffort。 */
  thinking: ThinkingTier
  /** 聊天页是否展示 AI 思考 / 工具调用过程。 */
  showSteps: boolean
  // 图片输入
  imageEnabled: boolean
  imageMaxSize: string
  imageQuality: string
  // 工具
  tools: ToolRow[]
  // MCP
  mcpServers: McpServer[]
  // 知识库 / 技能
  kbEnabled: boolean
  skillsEnabled: boolean
  // 能力（助手自己动手的权限，默认全关）
  fsEnabled: boolean
  cliEnabled: boolean
  skillScriptEnabled: boolean
  skillCreateEnabled: boolean
  toolCreateEnabled: boolean
}

function toFormState(cfg: AgentConfig): FormState {
  return {
    agentName: cfg.agentName,
    avatarPath: cfg.avatarPath ?? "",
    persona: cfg.persona ?? "",
    providers: (cfg.providers ?? []).map((p) => ({ ...p, modelOptions: (p.modelOptions ?? []).slice() })),
    activeProviderId: cfg.activeProviderId ?? "",
    systemPrompt: cfg.systemPrompt,
    maxHistory: String(cfg.maxHistory),
    thinking: tierOf(cfg),
    showSteps: cfg.showSteps !== false,
    imageEnabled: cfg.imageEnabled !== false,
    imageMaxSize: String(cfg.imageMaxSize ?? 1024),
    imageQuality: String(cfg.imageQuality ?? 0.8),
    tools: (cfg.tools ?? []).map((t) => toToolRow(t)),
    mcpServers: (cfg.mcpServers ?? []).map((m) => ({ ...m })),
    kbEnabled: cfg.kbEnabled,
    skillsEnabled: cfg.skillsEnabled,
    fsEnabled: cfg.fsEnabled === true,
    cliEnabled: cfg.cliEnabled === true,
    skillScriptEnabled: cfg.skillScriptEnabled === true,
    skillCreateEnabled: cfg.skillCreateEnabled === true,
    toolCreateEnabled: cfg.toolCreateEnabled === true,
  }
}

/** path 里出现了一个没人登记的 id（正常不会发生）：给个能退回上一级的提示。 */
function RouteMissing({ route }: { route: string }) {
  return (
    <VStack spacing={12} navigationTitle="打不开这一页">
      <Text foregroundStyle="secondaryLabel">{`没有登记的路由「${route}」。`}</Text>
      <Button title="返回上一级" action={() => popRoute()} />
    </VStack>
  )
}

interface Props {
  /** 关闭独立展示的设置页；底部标签模式不使用。 */
  onClose?: () => void
  /** 作为应用底部标签常驻时，不显示“完成”按钮。 */
  embedded?: boolean
  /** 能力管理已有独立标签时，可隐藏重复的工具、知识库和技能入口。 */
  showManagementSections?: boolean
  /** 作为标签页时是否处于当前可见标签；false 时不占用导航总线。 */
  active?: boolean
}

/** 设置页：角色 / 模型 / 对话 / 工具。以 sheet 形式从聊天页打开。 */
/**
 * 「能力」开关组：助手自己动手的权限（默认全关，打开哪项才能做哪件事）。
 * 单独抽出来是为了能单独预览 / 复用。
 */
export function AbilitySection({
  state, patch,
}: {
  state: FormState
  patch: (p: Partial<FormState>) => void
}) {
  return (
    <>
      <Toggle
        title="读写文件"
        value={state.fsEnabled}
        onChanged={(v) => patch({ fsEnabled: v })}
      />
      <Toggle
        title="执行命令行"
        value={state.cliEnabled}
        onChanged={(v) => patch({ cliEnabled: v })}
      />
      <Toggle
        title="运行技能脚本"
        value={state.skillScriptEnabled}
        onChanged={(v) => patch({ skillScriptEnabled: v })}
      />
      <Toggle
        title="创建技能"
        value={state.skillCreateEnabled}
        onChanged={(v) => patch({ skillCreateEnabled: v })}
      />
      <Toggle
        title="配置快捷指令工具"
        value={state.toolCreateEnabled}
        onChanged={(v) => patch({ toolCreateEnabled: v })}
      />
    </>
  )
}

/** 本页在导航总线里的 key（和能力页分开，互不覆盖）。 */
const NAV_KEY = "settings"

export function ConfigPage({
  onClose = () => {},
  embedded = false,
  showManagementSections = true,
  active = true,
}: Props) {
  const [state, setState] = useState<FormState>(() => toFormState(loadConfig()))
  const stateRef = useRef(state)
  /** 知识库 / 技能子页改完数据回来后，用它强制本页重算统计数字。 */
  const [, setTick] = useState(0)
  const [promptMode, setPromptMode] = useState<"edit" | "preview">("edit")
  const [personaMode, setPersonaMode] = useState<"edit" | "preview">("edit")
  const patch = (p: Partial<FormState>) => {
    const next = { ...stateRef.current, ...p }
    stateRef.current = next
    setState(next)
    persist(next)
  }

  /** 当前使用的那家供应商（列表空 / 指针失效时退回到第一家）。 */
  const activeRow =
    state.providers.find((p) => p.id === state.activeProviderId) ??
    state.providers.find((p) => (p.baseUrl ?? "").trim()) ??
    state.providers[0]

  /**
   * 自动拉取（模型 + 余额）挪到了「供应商与模型」子页：那一页打开时会给
   * 「当前使用」那家静默拉一次，失败只留一行提示、不弹窗。
   */

  // 统计数字：管理页关闭时本页会重渲染，直接重算即可
  const kbStat = kbStats()
  const skillStat = skillCounts()

  // 入口行的副标题
  const toolDetail =
    state.tools.length > 0 ? `已配置 ${state.tools.length} 个` : "还没有，进去加一个"
  const mcpDetail =
    state.mcpServers.length > 0
      ? `${state.mcpServers.length} 台服务器 · 启用 ${state.mcpServers.filter((m) => m.enabled && (m.url ?? "").trim()).length} 台`
      : "还没有，可以粘贴 JSON 导入"

  // 思考深度 footer 只显示当前档位一句话说明
  const thinkingTier = TIERS.find((x) => x.key === state.thinking) ?? TIERS[0]
  const thinkingDetail = `${thinkingTier.desc}（${thinkingTier.cost}）`

  // —— 导航 ——

  /**
   * 设置页里的所有跳转都走这一个 path：进下一层 = 末尾加一条 id，返回上一级 = 去掉末尾那条
   * （脚本没有别的编程式返回手段，原因见 app/nav_route.ts）。
   *
   * path 里的 id 由两处登记：本页登记 5 个一级入口，各子页登记自己下一层的详情页。
   * navigationDestination 的处理器只在导航栈根视图生效（真机验证过），所以只能集中在这里查表。
   */
  const [navPath, setNavPath] = useState<string[]>([])
  /** 给导航总线读的“最新 path”，避免闭包里拿到旧快照。 */
  const pathRef = useRef<string[]>(navPath)
  pathRef.current = navPath
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

  // 一级入口的路由工厂：写在渲染里，保证闭包拿到的是本页最新的 state。
  registerRoute("diagnostics", () => <DiagnosticsPage />)
  registerRoute("models", () => (
    <ModelsPage
      rows={state.providers}
      activeId={state.activeProviderId}
      onChange={(rows) => patch({ providers: rows })}
      onActiveChange={(id) => patch({ activeProviderId: id })}
    />
  ))
  registerRoute("settings-model-config", () => (
    <VStack navigationTitle="模型配置" navigationBarTitleDisplayMode="inline">
      <Form>
        <Section
          header={<Text>模型</Text>}
          footer={<Text>选择模型供应商、接口地址、密钥和默认模型。</Text>}
        >
          <SettingsNavRow
            icon={{ name: "cpu.fill", color: "systemBlue" }}
            title="模型"
            detail={activeRow ? providerSubtitle(activeRow) : "添加并配置模型供应商"}
            value={activeRow ? providerLabel(activeRow) : "未配置"}
            onOpen={() => pushRoute("models")}
          />
        </Section>

        <Section header={<Text>回答与交互</Text>}>
          <SettingsNavRow
            icon={{ name: "brain.head.profile", color: "systemOrange" }}
            title="行为与思考"
            detail="系统提示词与推理深度"
            value={thinkingTier.label}
            onOpen={() => pushRoute("settings-agent")}
          />
          <SettingsNavRow
            icon={{ name: "bubble.left.and.bubble.right.fill", color: "systemGreen" }}
            title="对话"
            detail={state.showSteps ? "显示怎么回答的" : "只显示最终回答"}
            value={`记得 ${state.maxHistory.trim() || "50"} 条`}
            onOpen={() => pushRoute("settings-chat")}
          />
          <SettingsNavRow
            icon={{ name: "photo.fill", color: "systemPink" }}
            title="图片输入"
            detail={state.imageEnabled ? `长边 ${state.imageMaxSize || "1024"} px · 质量 ${state.imageQuality || "0.8"}` : "聊天中不显示图片按钮"}
            value={state.imageEnabled ? "已开启" : "已关闭"}
            onOpen={() => pushRoute("settings-images")}
          />
        </Section>
      </Form>
    </VStack>
  ))
  registerRoute("tools", () => (
    <ToolsPage rows={state.tools} onChange={(rows) => patch({ tools: rows })} />
  ))
  registerRoute("mcp", () => (
    <McpPage servers={state.mcpServers} onChange={(servers) => patch({ mcpServers: servers })} />
  ))
  registerRoute("kb", () => <KbPage onChanged={() => setTick(Date.now())} />)
  registerRoute("skills", () => <SkillsPage onChanged={() => setTick(Date.now())} />)

  // —— 头像 ——

  async function pickAvatar() {
    try {
      const path = await chooseAvatarFromPhotos()
      if (path && commitAvatar()) patch({ avatarPath: AVATAR_PATH })
    } catch (e: any) {
      Dialog.alert({ message: "选择照片失败：" + (e?.message ?? String(e)) })
    }
  }

  /** 「记住多少条聊天记录」的说明弹窗（表单里放不下 tooltip，用弹窗替代）。 */
  function showHistoryTip() {
    Dialog.alert({
      title: "记住多少条聊天记录",
      message: [
        "每次回复前，助手最多会翻看你俩最近的这么多条消息（你发的和它回的都会算）。",
        "",
        "调大：记得更久，适合长对话；代价是回复更慢、更费额度。",
        "调小：回复更快更省，但助手容易忘掉前面说过的话。",
        "",
        "默认 50 条，一般不用改。",
      ].join("\n"),
    })
  }

  /** 把当前编辑状态转换成运行配置并立即写盘；未填关键字段的草稿条目暂不进入运行配置。 */
  function persist(next: FormState): void {
    const providers = toProviders(next.providers)
    const activeId = providers.some((p) => p.id === next.activeProviderId)
      ? next.activeProviderId
      : providers[0]?.id ?? ""

    const completeToolRows = next.tools.filter((row) => {
      const empty =
        !(row.name ?? "").trim() &&
        !(row.shortcutName ?? "").trim() &&
        !(row.description ?? "").trim()
      return empty || !!(row.shortcutName ?? "").trim()
    })
    const tools = toAgentTools(completeToolRows).tools

    const mcpServers: McpServer[] = []
    for (const m of next.mcpServers) {
      const url = (m.url ?? "").trim()
      if (!url) continue
      mcpServers.push({
        ...m,
        id: m.id || makeMcpServer().id,
        name: (m.name ?? "").trim() || url.replace(/^https?:\/\//, "").split("/")[0],
        url,
        token: (m.token ?? "").trim(),
        headersHint: m.headersHint ?? "",
      })
    }

    const cfg: AgentConfig = {
      ...loadConfig(),
      agentName: next.agentName.trim() || "小助",
      avatarPath: next.avatarPath === AVATAR_PATH ? AVATAR_PATH : undefined,
      persona: next.persona.trim(),
      providers,
      activeProviderId: activeId,
      systemPrompt: next.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
      maxHistory: Math.max(1, parseInt(next.maxHistory, 10) || 50),
      thinkingEnabled: next.thinking !== "off",
      reasoningEffort: next.thinking === "off" ? "" : next.thinking,
      showSteps: next.showSteps,
      imageEnabled: next.imageEnabled,
      imageMaxSize: Math.max(0, parseInt(next.imageMaxSize, 10) || 1024),
      imageQuality: Math.min(1, Math.max(0.1, parseFloat(next.imageQuality) || 0.8)),
      tools,
      mcpServers,
      kbEnabled: next.kbEnabled,
      skillsEnabled: next.skillsEnabled,
      fsEnabled: next.fsEnabled,
      cliEnabled: next.cliEnabled,
      skillScriptEnabled: next.skillScriptEnabled,
      skillCreateEnabled: next.skillCreateEnabled,
      toolCreateEnabled: next.toolCreateEnabled,
    }

    saveConfig(cfg)
  }

  registerRoute("settings-profile", () => (
    <VStack
      navigationTitle="角色与外观"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>身份</Text>}
          footer={<Text>名称和头像会显示在聊天页、会话列表以及助手回复旁。</Text>}
        >
          <FieldRow label="助手名字">
            <TextField
              title="小助"
              value={state.agentName}
              onChanged={(v) => patch({ agentName: v })}
            />
          </FieldRow>
          <HStack spacing={14} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity" }}>
            <Avatar spec={{ path: state.avatarPath }} size={64} />
            <VStack alignment="leading" spacing={3}>
              <Text fontWeight="semibold">助手头像</Text>
              <Text font="footnote" foregroundStyle="secondaryLabel">
                {state.avatarPath ? "使用自定义照片" : "使用默认头像"}
              </Text>
            </VStack>
            <Spacer />
          </HStack>
          <Button
            title={state.avatarPath ? "更换头像" : "选择头像"}
            systemImage="photo.on.rectangle"
            action={pickAvatar}
          />
        </Section>

        <Section
          header={<Text>性格与角色</Text>}
          footer={
            <Text>
              只写「它是个什么样的人」：性格、说话方式、习惯。这段会排在系统提示词最前面；能力和工具规则仍在「模型配置 → 行为与思考 → 系统提示词」里。
            </Text>
          }
        >
          <SettingsNavRow
            icon={{ name: "theatermasks.fill", color: "systemPink" }}
            title="性格与角色"
            detail={personaSummary(state.persona)}
            value="Markdown"
            onOpen={() => pushRoute("settings-persona")}
          />
        </Section>
      </Form>
    </VStack>
  ))

  registerRoute("settings-persona", () => (
    <VStack
      navigationTitle="性格与角色"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>它是谁、怎么说话</Text>}
          footer={
            <Text>
              建议写 3~8 行：身份、语气、习惯、拿不准时怎么办。留空就只按系统提示词回答。
            </Text>
          }
        >
          <Picker
            title="显示模式"
            pickerStyle="segmented"
            value={personaMode}
            onChanged={(v: string) => setPersonaMode(v as "edit" | "preview")}
          >
            <Text tag="edit">编辑</Text>
            <Text tag="preview">预览</Text>
          </Picker>
          {personaMode === "edit" ? (
            <TextField
              title="Markdown"
              value={state.persona}
              axis="vertical"
              lineLimit={{ min: 10, max: 24, reservesSpace: true }}
              onChanged={(v) => patch({ persona: v })}
            />
          ) : (
            <Markdown
              content={state.persona || "（暂无内容）"}
              theme="github"
              useDefaultHighlighterTheme
              scrollable={false}
            />
          )}
        </Section>

        <Section
          header={<Text>想换个说法？</Text>}
          footer={<Text>改完立刻生效，下一轮回复就按新性格来。</Text>}
        >
          <Button
            title="恢复默认性格"
            systemImage="arrow.counterclockwise"
            action={() => patch({ persona: DEFAULT_PERSONA })}
          />
          <Button
            title="清空（不加额外性格）"
            systemImage="trash"
            role="destructive"
            action={() => patch({ persona: "" })}
          />
        </Section>
      </Form>
    </VStack>
  ))

  registerRoute("settings-agent", () => (
    <VStack
      navigationTitle="行为与思考"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section header={<Text>思考深度</Text>} footer={<Text>{thinkingDetail}</Text>}>
          <Picker
            title="思考深度"
            pickerStyle="segmented"
            value={state.thinking}
            onChanged={(v: string) => patch({ thinking: v as ThinkingTier })}
          >
            {TIERS.map((t) => (
              <Text key={t.key} tag={t.key}>{t.label}</Text>
            ))}
          </Picker>
        </Section>
        <Section
          header={<Text>系统提示词（能力与规则）</Text>}
          footer={<Text>这里写能力、工具和回答规则；「它是个什么样的人」请到「角色与外观 → 性格与角色」里写。支持 Markdown。</Text>}
        >
          <Picker
            title="显示模式"
            pickerStyle="segmented"
            value={promptMode}
            onChanged={(v: string) => setPromptMode(v as "edit" | "preview")}
          >
            <Text tag="edit">编辑</Text>
            <Text tag="preview">预览</Text>
          </Picker>
          {promptMode === "edit" ? (
            <TextField
              title="Markdown"
              value={state.systemPrompt}
              axis="vertical"
              lineLimit={{ min: 10, max: 24, reservesSpace: true }}
              onChanged={(v) => patch({ systemPrompt: v })}
            />
          ) : (
            <Markdown
              content={state.systemPrompt || "（暂无内容）"}
              theme="github"
              useDefaultHighlighterTheme
              scrollable={false}
            />
          )}
          <Button
            title="恢复默认设定"
            systemImage="arrow.counterclockwise"
            action={() => patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
          />
        </Section>
      </Form>
    </VStack>
  ))

  registerRoute("settings-chat", () => (
    <VStack
      navigationTitle="对话"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>记忆</Text>}
          footer={<Text>条数越多，助手记得越久，但回复更慢、更费额度。</Text>}
        >
          <FieldRow label="记住多少条">
            <TextField
              title="50"
              value={state.maxHistory}
              prompt="50"
              keyboardType="numberPad"
              onChanged={(v) => patch({ maxHistory: v })}
            />
          </FieldRow>
          <Button title="这是怎么算的？" systemImage="info.circle" action={showHistoryTip} />
        </Section>
        <Section
          header={<Text>回复显示</Text>}
          footer={<Text>打开后，能看到助手在回答前的思考和对工具的调用过程。</Text>}
        >
          <Toggle
            title="显示怎么回答的"
            value={state.showSteps}
            onChanged={(v) => patch({ showSteps: v })}
          />
        </Section>
      </Form>
    </VStack>
  ))

  registerRoute("settings-images", () => (
    <VStack
      navigationTitle="图片输入"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>发送图片</Text>}
          footer={<Text>图片会先在本机压缩，再发送给支持视觉能力的模型。</Text>}
        >
          <Toggle
            title="允许发送图片"
            value={state.imageEnabled}
            onChanged={(v) => patch({ imageEnabled: v })}
          />
        </Section>
        {state.imageEnabled ? (
          <Section
            header={<Text>压缩质量</Text>}
            footer={<Text>长边填 0 表示保留原尺寸。JPEG 质量范围为 0.1 到 1.0。</Text>}
          >
            <FieldRow label="长边像素">
              <TextField
                title="1024"
                value={state.imageMaxSize}
                prompt="1024"
                keyboardType="numberPad"
                onChanged={(v) => patch({ imageMaxSize: v })}
              />
            </FieldRow>
            <FieldRow label="JPEG 质量">
              <TextField
                title="0.8"
                value={state.imageQuality}
                prompt="0.8"
                keyboardType="decimalPad"
                onChanged={(v) => patch({ imageQuality: v })}
              />
            </FieldRow>
          </Section>
        ) : null}
      </Form>
    </VStack>
  ))

  registerRoute("settings-permissions", () => (
    <VStack
      navigationTitle="能力权限"
      navigationBarTitleDisplayMode="inline"
    >
      <Form>
        <Section
          header={<Text>默认能力</Text>}
          footer={<Text>这些开关决定新会话默认可以使用哪些能力。每个会话还可以在聊天输入栏单独调整挂载。</Text>}
        >
          <Toggle
            title="知识库检索"
            value={state.kbEnabled}
            onChanged={(v) => patch({ kbEnabled: v })}
          />
          <Toggle
            title="技能"
            value={state.skillsEnabled}
            onChanged={(v) => patch({ skillsEnabled: v })}
          />
        </Section>
        <Section
          header={<Text>本机操作</Text>}
          footer={<Text>默认全部关闭。文件能力仅能访问 Scripting App 自己的工作区。</Text>}
        >
          <AbilitySection state={state} patch={patch} />
        </Section>
      </Form>
    </VStack>
  ))

  const firstRoute = navPath[0] ?? ""
  const secondRoute = navPath[1] ?? ""
  const thirdRoute = navPath[2] ?? ""
  const thirdDestination = (
    <VStack key={"lvl3:" + thirdRoute} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {thirdRoute ? buildRoute(thirdRoute) ?? <RouteMissing route={thirdRoute} /> : <EmptyView />}
    </VStack>
  )
  const secondDestination = (
    <VStack
      key={"lvl2:" + secondRoute}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      navigationDestination={{
        isPresented: thirdRoute !== "",
        onChanged: (presented) => {
          if (!presented) setNavPath((path) => path.slice(0, 2))
        },
        content: thirdDestination,
      }}
    >
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
        navigationTitle="设置"
        navigationBarTitleDisplayMode={embedded ? "large" : "inline"}
        navigationDestination={{
          isPresented: firstRoute !== "",
          onChanged: (presented) => {
            if (!presented) clearToRoot()
          },
          content: firstDestination,
        }}
        toolbar={
          embedded
            ? undefined
            : { topBarTrailing: <Button title="完成" action={onClose} fontWeight="semibold" /> }
        }
      >
        <Form>
          <Section title="角色与外观">
            <SettingsNavRow
              icon={{ name: "person.crop.circle.fill", color: "systemPurple" }}
              title="角色与外观"
              detail={`${state.avatarPath ? "自定义头像" : "默认头像"} · 性格${state.persona.trim() ? "已设定" : "未设定"}`}
              value={state.agentName.trim() || "小助"}
              onOpen={() => pushRoute("settings-profile")}
            />
          </Section>

          <Section title="模型与回答">
            <SettingsNavRow
              icon={{ name: "cpu.fill", color: "systemBlue" }}
              title="模型配置"
              detail={activeRow ? `${providerLabel(activeRow)} · ${thinkingTier.label}思考` : "配置模型、回答方式和图片输入"}
              value={activeRow ? "已配置" : "未配置"}
              onOpen={() => pushRoute("settings-model-config")}
            />
          </Section>

          <Section title="能力与检索">
            <SettingsNavRow
              icon={{ name: "lock.shield.fill", color: "systemIndigo" }}
              title="能力权限"
              detail="知识库、技能与本机操作权限"
              value={
                [
                  state.kbEnabled,
                  state.skillsEnabled,
                  state.fsEnabled,
                  state.cliEnabled,
                  state.skillScriptEnabled,
                  state.skillCreateEnabled,
                  state.toolCreateEnabled,
                ].filter(Boolean).length + " 项开启"
              }
              onOpen={() => pushRoute("settings-permissions")}
            />
          </Section>

          {showManagementSections ? (
            <Section title="能力管理">
              <SettingsNavRow
                icon={{ name: "books.vertical.fill", color: "systemPurple" }}
                title="知识库"
                detail={kbStat.docs > 0 ? `${kbStat.docs} 份资料 · ${kbStat.chunks} 个片段` : "导入资料供智能体检索"}
                onOpen={() => pushRoute("kb")}
              />
              <SettingsNavRow
                icon={{ name: "shippingbox.fill", color: "systemIndigo" }}
                title="技能"
                detail={skillStat.total > 0 ? `${skillStat.total} 个技能 · 启用 ${skillStat.enabled} 个` : "导入并管理技能"}
                onOpen={() => pushRoute("skills")}
              />
              <SettingsNavRow
                icon={{ name: "bolt.fill", color: "systemOrange" }}
                title="快捷指令"
                detail={toolDetail}
                onOpen={() => pushRoute("tools")}
              />
              <SettingsNavRow
                icon={{ name: "server.rack", color: "systemBlue" }}
                title="MCP 服务器"
                detail={mcpDetail}
                onOpen={() => pushRoute("mcp")}
              />
            </Section>
          ) : null}

          <Section title="当前配置">
            <SettingsSummaryRow
              icon={{ name: "checkmark.seal.fill", color: "systemGreen" }}
              title="配置状态"
              value={activeRow ? `${state.providers.length} 家供应商` : "需要配置模型"}
            />
            <SettingsNavRow
              icon={{ name: "waveform.path.ecg", color: "systemTeal" }}
              title="诊断"
              detail="最近每轮跑多快、花了多少 token、哪里出错"
              value="运行统计"
              onOpen={() => pushRoute("diagnostics")}
            />
          </Section>
        </Form>
      </VStack>
    </NavigationStack>
  )
}

export default ConfigPage
