import {
  Button, DirectoryBrowserView, HStack, Image, Navigation, NavigationStack, ScrollView, Spacer, Text, Toolbar, ToolbarItem, VStack, ZStack,
  useEffect, useState,
} from "scripting"
import {
  AgentConfig, ChatMessage, SessionMounts, SessionStore, ToolStep, activeProvider, capMessages,
  deriveTitle, effectiveConfig, ensureWorkspace, loadConfig, loadStore, makeSession, removeSession, saveChatImage,
  saveConfig, saveStore, upsertSession, withCurrentSession,
} from "./agent_store"
import { continueAgentFromHistory, runAgent } from "./agent_core"
import { ConfigPage } from "./config_page"
import { MountPage } from "./mount_page"
import { DRAWER_WIDTH, Sidebar } from "./sidebar"
import { AvatarSpec } from "./avatar"
import { AssistantMessage, Bubble, EmptyState, LiveThinking } from "./message_bubble"
import { ChatInputBar } from "./chat_input"
import { useCallbackAutoJob } from "./callback"

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
  const [store, setStore] = useState<SessionStore>(() => withCurrentSession(loadStore()).store)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showMounts, setShowMounts] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** 已选但还没发送的图片（落盘后的路径），发送后清空。 */
  const [pendingImages, setPendingImages] = useState<string[]>([])
  /** Scripting 会复用原生图片视图；发送后递增以强制重建输入器。 */
  const [draftRevision, setDraftRevision] = useState(0)
  // 正在跑的这一轮的过程（实时画在聊天流里，结束后随消息落库）。
  const [liveReasoning, setLiveReasoning] = useState("")
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([])
  const [liveText, setLiveText] = useState("")

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

  function apply(next: SessionStore) {
    saveStore(next)
    setStore(next)
  }

  async function continueAfterCallback(sessionId: string) {
    if (busy || callbackContinuationInProgress) return
    callbackContinuationInProgress = true
    setBusy(true)
    setLiveReasoning("")
    setLiveSteps([])
    setLiveText("")

    let pendingText = ""
    let pendingReasoning = ""
    let pendingSegment = false
    let lastFlush = 0
    const flush = () => {
      lastFlush = Date.now()
      if (pendingText) {
        const t = pendingText
        pendingText = ""
        setLiveText((prev) => prev + t)
      }
      if (pendingReasoning) {
        const r = pendingReasoning
        const sep = pendingSegment ? "\n\n" : ""
        pendingReasoning = ""
        pendingSegment = false
        setLiveReasoning((prev) => (prev ? prev + sep + r : r))
      }
    }

    try {
      const latestCfg = loadConfig()
      const latestStore = loadStore()
      const base = latestStore.sessions.find((s) => s.id === sessionId) ?? latestStore.sessions.find((s) => s.id === latestStore.currentId)
      if (!base) return
      const eff = effectiveConfig(latestCfg, base.mounts)
      const { newHistory } = await continueAgentFromHistory(eff, base.messages, {
        onEvent: () => {
          pendingText = ""
          setLiveText("")
        },
        onStep: (s) => setLiveSteps((prev) => [...prev, s]),
        onDelta: (d) => {
          if (d.reset) {
            pendingText = ""
            pendingReasoning = ""
            pendingSegment = false
            setLiveText("")
            setLiveReasoning("")
            return
          }
          if (d.type === "text") {
            pendingText += d.content
          } else {
            if (d.newSegment) pendingSegment = true
            pendingReasoning += d.content
          }
          if (Date.now() - lastFlush >= 60) flush()
        },
      }, { workspaceName: base.workspaceName })
      flush()
      const capped = capMessages(newHistory, latestCfg.maxHistory)
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
      setBusy(false)
      setLiveReasoning("")
      setLiveSteps([])
      setLiveText("")
    }
  }

  function closeSettings() {
    setShowSettings(false)
    setCfg(loadConfig())
  }

  /** 会话级挂载：改了就跟着这个会话一起存（历史 / 挂载都在一起）。 */
  function setMounts(next?: SessionMounts) {
    const base = current ?? makeSession()
    apply(upsertSession(store, { ...base, mounts: next }))
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
    saveConfig(next)
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
    apply(withCurrentSession(removeSession(store, id)).store)
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
    // 这个会话的挂载：助手中途给自己登记了新工具的话，要把新工具并进来，
    // 否则会话挂载会把它过滤掉，下一轮它就看不见了。
    let mountsNow = base.mounts

    setBusy(true)
    setInput("")
    const userMsg: ChatMessage = {
      role: "user",
      content: trimmed,
      images: images.length > 0 ? images : undefined,
    }
    apply(upsertSession(store, { ...base, messages: [...base.messages, userMsg], updatedAt: Date.now() }))
    setLiveReasoning("")
    setLiveSteps([])
    setLiveText("")

    // 流式增量一秒能来几十次，合并到 ~60ms 刷一次，免得把界面刷爆。
    let pendingText = ""
    let pendingReasoning = ""
    let pendingSegment = false
    let lastFlush = 0
    const flush = () => {
      lastFlush = Date.now()
      if (pendingText) {
        const t = pendingText
        pendingText = ""
        setLiveText((prev) => prev + t)
      }
      if (pendingReasoning) {
        const r = pendingReasoning
        const sep = pendingSegment ? "\n\n" : ""
        pendingReasoning = ""
        pendingSegment = false
        setLiveReasoning((prev) => (prev ? prev + sep + r : r))
      }
    }

    try {
      // 会话级挂载在这里生效：工具 / MCP / 技能 / 知识库都按这个会话挂的来
      const eff = effectiveConfig(cfg, base.mounts)
      const { reply, newHistory } = await runAgent(trimmed, eff, base.messages, {
        onEvent: () => {
          // 调工具前可能擦过一句开场白，它不在最终回答里，清掉免得一闪就没
          pendingText = ""
          setLiveText("")
        },
        onStep: (s) => setLiveSteps((prev) => [...prev, s]),
        onToolsCreated: (names) => {
          setCfg(loadConfig())
          if (!mountsNow) return // 没单独挂载过 = 用设置里的全部工具，新工具自然可见
          const set = new Set(mountsNow.tools)
          let changed = false
          for (const n of names) {
            if (!set.has(n)) {
              set.add(n)
              changed = true
            }
          }
          if (changed) mountsNow = { ...mountsNow, tools: Array.from(set) }
        },
        onDelta: (d) => {
          if (d.reset) {
            pendingText = ""
            pendingReasoning = ""
            pendingSegment = false
            setLiveText("")
            setLiveReasoning("")
            return
          }
          if (d.type === "text") {
            pendingText += d.content
          } else {
            if (d.newSegment) pendingSegment = true
            pendingReasoning += d.content
          }
          if (Date.now() - lastFlush >= 60) flush()
        },
      }, {
        images,
        workspaceName: base.workspaceName,
      })
      flush()
      const capped = capMessages(newHistory, cfg.maxHistory)
      apply(
        upsertSession(store, {
          ...base,
          mounts: mountsNow,
          messages: capped,
          updatedAt: Date.now(),
          title: isFirst ? deriveTitle(capped) : base.title,
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
      setBusy(false)
      setLiveReasoning("")
      setLiveSteps([])
      setLiveText("")
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
              <MountPage
                cfg={cfg}
                mounts={current?.mounts}
                onChange={setMounts}
                onClose={() => setShowMounts(false)}
              />
            ),
            isPresented: showMounts,
            onChanged: setShowMounts,
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
          <VStack spacing={2} alignment="leading">
            <Text font="caption" fontWeight="semibold" foregroundStyle="secondaryLabel">当前对话</Text>
            <Text font="title3" fontWeight="bold">{current?.title || "新对话"}</Text>
          </VStack>
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
          sendEnabled={sendEnabled}
          busy={busy}
          hasMounts={!!current?.mounts}
          onOpenMounts={() => setShowMounts(true)}
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
