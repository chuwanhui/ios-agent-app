import { Intent, Script } from "scripting"
import {
  deriveTitle, loadConfig, loadStore, saveStore, tryApplyConfigJson, upsertSession, withCurrentSession,
} from "./core/agent/store"
import { continueAgentFromHistory, runAgent } from "./core/agent/core"
import { capMessagesForSend, withStampedMessages } from "./core/agent/memory"
import { handleCallback } from "./core/agent/tool_callback"
import { drainNotifications } from "./core/notify/drain"
import { enqueueNotify, failedQueueItems, queueSize } from "./core/notify/queue"
import { messageParam } from "./core/agent/url_entry"
import { NotificationEnvelope, parseNotificationEnvelope } from "./core/notify/envelope"
import { initStorage } from "./core/store/init"
import { keyProblemText } from "./core/agent/config_problem"

/**
 * 快捷指令入口：把传入的文本当一轮对话发给模型，结果作为快捷指令的返回值。
 * 输入为空就直接退出。
 */
function getInputText(): string {
  // 用「打开 URL」调起来时（scripting://run/智能体?message=…）没有快捷指令参数，
  // 只有 queryParameters，所以先看这条。
  const fromURL = messageParam()
  if (fromURL.trim()) return fromURL

  const sp = Intent.shortcutParameter
  if (sp != null) {
    if (sp.type === "text") {
      const t = sp.value.trim()
      if (t) return t
    }
    if (sp.type === "json") {
      try { return JSON.stringify(sp.value) } catch { return "" }
    }
    if (sp.type === "fileURL") {
      return sp.value
    }
  }
  const texts = Intent.textsParameter
  if (texts && texts.length > 0 && texts[0]) {
    return texts[0]
  }
  return ""
}

/**
 * 唯一的退出点。
 *
 * 为什么包一层：快捷指令里「运行脚本」动作只要脚本抛异常，动作标题就变红，
 * 用户只能看到一个看不懂的系统错误。宁可把异常变成一段能读的文字交回去，
 * 也别让整条快捷指令挂在那儿。
 */
function exitText(text: string): void {
  try {
    Script.exit(Intent.text(text ?? ""))
  } catch (e: any) {
    console.log("退出时失败：" + (e?.message ?? String(e)))
  }
}

/**
 * 把这一轮的结论交回给调用方。
 *
 * 永远返回**纯文本**，「运行脚本」动作的输出类型不变。
 * 需要动手的快捷指令由 `core/agent/foreground.ts` 先把 App 唤到前台再自己触发。
 */
function finishWith(reply: string): void {
  exitText(reply ?? "")
}

/** 通知入队后交给队列消费者；这一条处理完就把它的回复当返回值。 */
async function handleNotification(envelope: NotificationEnvelope): Promise<void> {
  const queued = enqueueNotify(envelope)
  if (!queued.queued && queued.reason === "duplicate") {
    finishWith("已处理过同一条通知（去重）。")
    return
  }

  const id = queued.item?.id ?? ""
  const out = await drainNotifications({ preferredId: id })
  if (out.preferredReply) {
    finishWith(out.preferredReply)
    return
  }

  // 没拿到这条的回复要分情况说，别一律「已入队」—— 那句话在四种完全不同的处境下都会出现：
  //   ① 刚入队就失败了（模型 / 网络报错）；
  //   ② 别的消费者拿着锁（App 正开着在清队列），这一轮根本没轮到它；
  //   ③ 这条跑了，但回复要等快捷指令把结果传回来（工具配了「回传」）；
  //   ④ 后台时间到了，前面几条吃掉了预算。
  const failed = id ? failedQueueItems().find((it) => it.id === id) : undefined
  if (failed) {
    finishWith(`这条通知处理失败：${failed.lastError || "未知错误"}。已自动重试过，也留在「消息记录」页的「处理失败」里，可以手动重试。`)
    return
  }
  if (out.skipped === "locked") {
    finishWith(`另一条消息正在处理，这条已经排队（队列 ${queueSize()} 条），处理完会接着跑。`)
    return
  }
  if (out.processed > 0) {
    finishWith("这条已经处理，正在等快捷指令把结果传回来；结果到了会在 App 里接着回复你。")
    return
  }
  finishWith(`后台时间到了，消息已排队（队列 ${queueSize()} 条），下次触发或打开 App 会接着处理。`)
}

/**
 * 快捷指令把工具结果回传回来时，接着把这一轮说完，并把最终答复返回给快捷指令。
 *
 * 为什么快捷指令入口也要接：从通知触发的这一轮是在 intent 进程里跑的，
 * 它触发「等回传」的快捷指令后进程就结束了；回调 `scripting://run/智能体?callId=…`
 * 再启动的就是这里。不接的话结果只能落盘、没人接着说，用户看到的就是「没下文」。
 * 返回 true 表示「这确实是一次回传，已经处理完」。
 */
async function finishCallback(params: any): Promise<boolean> {
  const hit = handleCallback(params)
  if (!hit) return false

  const cfg = loadConfig()
  if (!cfg.apiKey) {
    exitText(keyProblemText(cfg))
    return true
  }
  const store = loadStore()
  const base = store.sessions.find((s) => s.id === hit.sessionId)
  if (!base) {
    exitText("收到快捷指令的回传，但没找到对应的会话。")
    return true
  }
  // 不新增用户消息：会话里那一步已经从「等待回传」变成真实结果，这里直接接着生成答复。
  const { reply, newHistory } = await continueAgentFromHistory(cfg, base.messages, undefined, {
    workspaceName: base.workspaceName,
    source: "callback",
  })
  const capped = withStampedMessages(capMessagesForSend(newHistory, cfg.maxHistory))
  await saveStore(upsertSession(store, { ...base, messages: capped, updatedAt: Date.now() }))
  finishWith(reply || "已收到快捷指令的结果。")
  return true
}

async function run() {
  try {
    // 快捷指令入口同样是独立进程，先把库里的数据读进内存。
    await initStorage()

    // 回传优先：这种进入方式没有普通输入，只有 queryParameters。
    if (await finishCallback(Script.queryParameters)) return

    const inputText = getInputText()

    // 兼容路径：输入是一段含配置键的 JSON 时，当作「改配置」而不是聊天。
    if (inputText && (await tryApplyConfigJson(inputText))) {
      exitText("配置已更新")
      return
    }

    const cfg = loadConfig()
    if (!cfg.apiKey) {
      // 别只说「去填 Key」：没读到配置 / 钥匙串读不到，都是不同的病。
      exitText(keyProblemText(cfg))
      return
    }

    if (!inputText) {
      exitText("没有收到输入内容：给这个快捷指令传一段文本再试")
      return
    }

    const envelope = parseNotificationEnvelope(inputText)
    if (envelope) {
      await handleNotification(envelope)
      return
    }

    const history = withCurrentSession(loadStore())
    const session = history.session
    const { reply, newHistory } = await runAgent(
      inputText,
      cfg,
      session.messages,
      undefined,
      { workspaceName: session.workspaceName },
    )

    const capped = withStampedMessages(capMessagesForSend(newHistory, cfg.maxHistory))
    await saveStore(
      upsertSession(history.store, {
        ...session,
        messages: capped,
        updatedAt: Date.now(),
        title: session.messages.length === 0 ? deriveTitle(capped) : session.title,
      }),
    )

    finishWith(reply)
  } catch (e: any) {
    exitText("出错：" + (e?.message ?? String(e)))
  }
}

// run() 里已经兜过 try/catch，但模块加载阶段（import 求值）如果抛错就轮不到它，
// 所以最外面再兜一层，保证任何情况下都是一段文本而不是一个红叉。
run().catch((e: any) => {
  exitText("启动失败：" + (e?.message ?? String(e)))
})
