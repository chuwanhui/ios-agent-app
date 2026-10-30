import {
  Button, DirectoryBrowserView, HStack, Image, Navigation, NavigationStack, ScrollView, Spacer, Text, Toolbar, ToolbarItem, VStack, ZStack,
  useEffect, useState,
} from "scripting"
import {
  AgentConfig, ChatMessage, Session, SessionStore, activeProvider,
  deriveTitle, ensureWorkspace, loadConfig, loadStore, makeSession, removeSessionWithImages, saveChatImage,
  saveConfig, saveStore, subscribeConfig, upsertSession, withCurrentSession,
} from "../core/agent/store"
import { capMessagesForSend, compressHistory } from "../core/agent/memory"
import { continueAgentFromHistory, runAgent } from "../core/agent/core"
import { ConfigPage } from "../settings/page"
import { DRAWER_WIDTH, Sidebar } from "./sidebar"
import { AvatarSpec } from "../ui/avatar"
import { AssistantMessage, Bubble, EmptyState, LiveThinking } from "./message"
import { ChatInputBar } from "./input"
import { useCallbackAutoJob } from "./callback"
import { useAgentRun } from "./use_agent_run"

// 防止快捷指令回传链式触发：同一时间只允许一条 callback 续跑。
let callbackContinuationInProgress = false

interface Props {
  /** 作为应用底部标签使用时，不显示关闭按钮和重复的设置入口。 */
  embedded?: boolean
  /** 应用壳层可把设置入口切换到底部「设置」标签。 */
  onOpenSettings?: (route?: string) => void
}

export function ChatPage({ embedded = false, onOpenSettings }: Props) {
  const dismiss = Navigation.useDismiss()
  const [cfg, setCfg] = useState<AgentConfig>(() => loadConfig())
  // 设置页改了配置（头像 / 名字 / 模型…）立刻同步到这一页，不然界面还显示旧快照。
  useEffect(() => subscribeConfig(() => setCfg(loadConfig())), [])
  const [store, setStore] = useState<SessionStore>(() => withCurrentSession(loadStore()).store)
  const [input, setInput] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** 已选但还没发送的图片（落盘后的路径），发送后清空。 */
  const [pendingImages, setPendingImages] = useState<string[]>([])
  /** Scripting 会复用原生图片视图；发送后递增以强制重建输入器。 */
  const [draftRevision, setDraftRevision] = useState(0)
  /** 跑批状态机：busy / 停止开关 / 实时打字区都在里面（见 use_agent_run.ts）。 */
  const run = useAgentRun()
  const { busy, liveReasoning, liveSteps, liveText } = run

  // 快捷指令回传：两条入口（冷启动 URL / 被唤起 onResume）统一接在这里，
  // 回填工具 step 后，等不忙了按 role:"tool" 续跑模型。
  useCallbackAutoJob({
    onConsumed: () => {
      setCfg(loadConfig())
      setStore(loadStore())
    },
    onFire: (out) => void continueAfterCallback(out.sessionId),
    busy,
  })

  const current = store.sessions.find((s) => s.id === store.currentId) ?? null
  const messages = current?.messages ?? []
  /** 界面上画出来的消息：hidden 只用于兼容旧历史，不再写入新消息。 */
  const visible = messages.filter((m) => !m.hidden)

  /** 先落库再喂给界面：落库是异步的，但内存已即时更新，所以界面不会等它。 */
  function apply(next: SessionStore) {
    void saveStore(next)
    setStore(next)
  }

  async function continueAfterCallback(sessionId: string) {
    if (busy || callbackContinuationInProgress) return
    callbackContinuationInProgress = true
    const hooks = run.begin()

    try {
      const latestCfg = loadConfig()
      const latestStore = loadStore()
      const base = latestStore.sessions.find((s) => s.id === sessionId) ?? latestStore.sessions.find((s) => s.id === latestStore.currentId)
      if (!base) return
      const { newHistory } = await continueAgentFromHistory(latestCfg, base.messages, hooks, {
        workspaceName: base.workspaceName,
        control: run.control,
        source: "callback",
      })
      run.flush()
      const capped = capMessagesForSend(newHistory, latestCfg.maxHistory)
      apply(upsertSession(latestStore, { ...base, messages: capped, updatedAt: Date.now() }))
    } catch (e: any) {
      const latestStore = loadStore()
      const base = latestStore.sessions.find((s) => s.id === sessionId) ?? latestStore.sessions.find((s) => s.id === latestStore.currentId)
      if (base) {
        apply(
          upsertSession(latestStore, {
            ...base,
            messages: [...base.messages, { role: "assistant", content: "出错：" + (e?.message ?? String(e)), contextExcluded: true }],
            updatedAt: Date.now(),
          }),
        )
      }
    } finally {
      callbackContinuationInProgress = false
      run.finish()
    }
  }

  function closeSettings() {
    setShowSettings(false)
    setCfg(loadConfig())
  }

  /** 进入设置页（先收起抽屉）。 */
  function openSettings(route = "") {
    setDrawerOpen(false)
    if (onOpenSettings) {
      onOpenSettings(route)
      return
    }
    setShowSettings(true)
  }

  /** 从相册选图片（可多选），落盘后加进 pendingImages。 */
  async function pickImages() {
    if (busy) return
    try {
      const picked = await Photos.pick({ filter: PHPickerFilter.images(), limit: 9 })
      if (!picked || picked.length === 0) return
      const saved: string[] = []
      for (const r of picked) {
        let img: UIImage | null = null
        try {
          img = await r.uiImage()
        } catch {
          try {
            const path = await r.imagePath()
            if (path) img = UIImage.fromFile(path)
          } catch {
            img = null
          }
        }
        if (!img) continue
        const p = saveChatImage(img, cfg.imageMaxSize, cfg.imageQuality)
        if (p) saved.push(p)
      }
      if (saved.length > 0) setPendingImages((prev) => [...prev, ...saved])
    } catch (e: any) {
      Dialog.alert({ message: "选图失败：" + (e?.message ?? String(e)) })
    }
  }

  function removePendingImage(path: string) {
    setPendingImages((prev) => {
      if (path) {
        try {
          if (FileManager.existsSync(path)) FileManager.removeSync(path)
        } catch {
          // 草稿状态仍要移除；文件清理失败不阻塞交互。
        }
      }
      return prev.filter((item) => item !== path)
    })
  }

  /** 底部原生菜单切换模型，写盘后重新加载以同步扁平模型字段。 */
  function selectModel(id: string) {
    if (!id || id === cfg.activeProviderId) return
    const next: AgentConfig = { ...cfg, activeProviderId: id }
    void saveConfig(next)
    setCfg(loadConfig())
  }

  async function newSession() {
    setDrawerOpen(false)
    const workspaceName = await Dialog.prompt({
      title: "新建会话",
      message: "指定这个会话使用的工作区。多个会话可填写同一个名称来共享文件。",
      defaultValue: "default",
      placeholder: "default",
      cancelLabel: "取消",
      confirmLabel: "创建",
    })
    if (workspaceName === null) return
    const s = makeSession(workspaceName)
    ensureWorkspace(s.workspaceName)
    apply({ currentId: s.id, sessions: [s, ...store.sessions] })
  }

  function selectSession(id: string) {
    setDrawerOpen(false)
    apply({ ...store, currentId: id })
  }

  function deleteSession(id: string) {
    apply(withCurrentSession(removeSessionWithImages(store, id)).store)
  }

  /** 发送当前输入草稿：先同步移除缩略图，再把路径快照交给异步发送流程。 */
  function sendDraft() {
    if (busy || (!input.trim() && pendingImages.length === 0)) return
    const images = pendingImages.slice()
    if (!cfg.apiKey) {
      void send(input, { images })
      return
    }
    if (images.length > 0) {
      setPendingImages([])
      setDraftRevision((value) => value + 1)
    }
    void send(input, { images })
  }

  /**
   * 发消息。
   * opts.images：这次输入附带的图片（磁盘路径）。
   */
  async function send(text: string, opts?: { images?: string[] }) {
    const trimmed = text.trim()
    // 图片可以没有文字，但必须有图或有文字其一
    const images = opts?.images ?? []
    if ((!trimmed && images.length === 0) || busy) return

    if (!cfg.apiKey) {
      Dialog.alert({ message: "还没配置：点右上角齿轮填一下 API Key" })
      openSettings("models")
      return
    }

    const base = current ?? makeSession()
    const isFirst = base.messages.length === 0

    setInput("")
    const userMsg: ChatMessage = {
      role: "user",
      content: trimmed,
      images: images.length > 0 ? images : undefined,
    }
    apply(upsertSession(store, { ...base, messages: [...base.messages, userMsg], updatedAt: Date.now() }))
    const hooks = run.begin({ onToolsCreated: () => setCfg(loadConfig()) })

    try {
      // 工具 / MCP / 技能 / 知识库都按设置里的默认配置执行
      const { newHistory } = await runAgent(trimmed, cfg, base.messages, hooks, {
        images,
        workspaceName: base.workspaceName,
        control: run.control,
      })
      run.flush()
      const capped = capMessagesForSend(newHistory, cfg.maxHistory)
      // 攒够条数就把前面那段压成「记忆摘要」：以前聊天页只按条数硬截断，长对话会直接忘事。
      const sessionForStore: Session = run.control.aborted
        ? { ...base, messages: capped }
        : await compressHistory(cfg, { ...base, messages: capped })
      apply(
        upsertSession(store, {
          ...sessionForStore,
          updatedAt: Date.now(),
          title: isFirst ? deriveTitle(sessionForStore.messages) : base.title,
        }),
      )
    } catch (e: any) {
      const errMsg = "出错：" + (e?.message ?? String(e))
      const failed: ChatMessage[] = [
        ...base.messages,
        {
          role: "user",
          content: trimmed,
          images: images.length > 0 ? images : undefined,
          contextExcluded: true,
        },
        { role: "assistant", content: errMsg, contextExcluded: true },
      ]
      apply(
        upsertSession(store, {
          ...base,
          messages: failed,
          updatedAt: Date.now(),
          title: isFirst ? deriveTitle(failed) : base.title,
        }),
      )
    } finally {
      // 兜底清理本轮已发送的缩略图；保留请求期间新选择的其他图片。
      if (images.length > 0) {
        const sent = new Set(images)
        setPendingImages((prev) => prev.filter((path) => !sent.has(path)))
      }
      run.finish()
    }
  }

  // 有文字或有图片都能发
  const sendEnabled = !busy && (input.trim().length > 0 || pendingImages.length > 0)
  const avatar: AvatarSpec = { path: cfg.avatarPath }
  const currentProvider = activeProvider(cfg)
  const availableModels = (cfg.providers ?? [])
    .filter((p) => (p.baseUrl ?? "").trim() && (p.model ?? "").trim())
    .map((p) => ({
      id: p.id,
      label: `${p.name || p.baseUrl} · ${p.model}`,
      active: p.id === currentProvider?.id,
    }))
  const currentModelLabel = currentProvider?.model || "选择模型"

  return (
    <NavigationStack>
      <ZStack
        alignment="topLeading"
        navigationTitle={cfg.agentName || "智能体"}
        navigationBarTitleDisplayMode="inline"
        onAppear={() => setCfg(loadConfig())}
        toolbar={
          embedded ? (
            <Toolbar>
              <ToolbarItem placement="topBarLeading">
                <Button action={() => setDrawerOpen((v) => !v)}>
                  <Image systemName="sidebar.left" />
                </Button>
              </ToolbarItem>
              <ToolbarItem placement="topBarTrailing">
                <Button action={() => setShowWorkspace(true)}>
                  <Image systemName="folder" />
                </Button>
              </ToolbarItem>
            </Toolbar>
          ) : (
            <Toolbar>
              <ToolbarItem placement="topBarLeading">
                <Button action={() => setDrawerOpen((v) => !v)}>
                  <Image systemName="sidebar.left" />
                </Button>
              </ToolbarItem>
              <ToolbarItem placement="topBarTrailing">
                <Button action={() => setShowWorkspace(true)}>
                  <Image systemName="folder" />
                </Button>
              </ToolbarItem>
              <ToolbarItem placement="topBarTrailing">
                <Button action={openSettings}>
                  <Image systemName="gearshape" />
                </Button>
              </ToolbarItem>
              <ToolbarItem placement="topBarTrailing">
                <Button action={() => dismiss()}>
                  <Image systemName="xmark" />
                </Button>
              </ToolbarItem>
            </Toolbar>
          )
        }
        sheet={[
          {
            content: <ConfigPage onClose={closeSettings} />,
            isPresented: showSettings,
            onChanged: (v: boolean) => {
              setShowSettings(v)
              if (!v) setCfg(loadConfig())
            },
          },
          {
            content: (
              <NavigationStack>
                <DirectoryBrowserView
                  title={current?.workspaceName || "default"}
                  directoryPath={ensureWorkspace(current?.workspaceName)}
                />
              </NavigationStack>
            ),
            isPresented: showWorkspace,
            onChanged: setShowWorkspace,
          },
        ]}
      >
        {/* 主内容 */}
        <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <HStack
          spacing={10}
          padding={{ horizontal: 16, top: 10, bottom: 8 }}
          frame={{ maxWidth: "infinity" }}
        >
          <Spacer />
          <Button action={newSession} disabled={busy}>
            <HStack spacing={5} padding={{ horizontal: 10, vertical: 7 }} background="tertiarySystemFill" clipShape="capsule">
              <Image systemName="square.and.pencil" font="caption" />
              <Text font="caption" fontWeight="semibold">新建</Text>
            </HStack>
          </Button>
        </HStack>
        <ScrollView defaultScrollAnchor="bottom" scrollDismissesKeyboard="interactively">
          <VStack spacing={0} padding={{ top: 10, bottom: 20 }}>
            {visible.length === 0 ? (
              <EmptyState name={cfg.agentName || "智能体"} avatar={avatar} />
            ) : null}
            {visible.map((m, i) =>
              m.role === "user" ? (
                <Bubble key={"m" + i} message={m} avatar={avatar} />
              ) : (
                <AssistantMessage
                  key={"m" + i}
                  message={m}
                  avatar={avatar}
                  showSteps={cfg.showSteps !== false}
                />
              ),
            )}
            {busy ? (
              <LiveThinking
                avatar={avatar}
                reasoning={liveReasoning}
                steps={liveSteps}
                text={liveText}
                showSteps={cfg.showSteps !== false}
              />
            ) : null}
          </VStack>
        </ScrollView>

        <ChatInputBar
          key={`chat-input-${draftRevision}`}
          input={input}
          onInput={setInput}
          onSend={sendDraft}
          onStop={run.stop}
          sendEnabled={sendEnabled}
          busy={busy}
          imageEnabled={cfg.imageEnabled !== false}
          onPickImages={pickImages}
          images={pendingImages}
          onRemoveImage={removePendingImage}
          models={availableModels}
          modelLabel={currentModelLabel}
          onSelectModel={selectModel}
          onManageModels={() => openSettings("models")}
        />
        </VStack>

        {/* 遮罩：点一下关抽屉 */}
        <VStack
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          background="black"
          opacity={drawerOpen ? 0.28 : 0}
          allowsHitTesting={drawerOpen}
          onTapGesture={() => setDrawerOpen(false)}
          animation={{ animation: Animation.easeOut(0.22), value: drawerOpen }}
        />

        {/* 左侧抽屉（不要阴影：会与主内容之间拉出灰条）*/}
        <VStack
          offset={{ x: drawerOpen ? 0 : -DRAWER_WIDTH, y: 0 }}
          allowsHitTesting={drawerOpen}
          animation={{ animation: Animation.easeOut(0.22), value: drawerOpen }}
        >
          <Sidebar
            store={store}
            agentName={cfg.agentName || "小助"}
            avatar={avatar}
            onSelect={selectSession}
            onNew={newSession}
            onDelete={deleteSession}
            onSettings={openSettings}
          />
        </VStack>
      </ZStack>
    </NavigationStack>
  )
}

export default ChatPage
