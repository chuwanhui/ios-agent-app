import { useRef, useState } from "scripting"
import { AgentDelta, RunAgentHooks, RunControl } from "../core/agent/core"
import { ToolStep } from "../core/agent/store"

/**
 * 一轮对话的「运行时状态机」：busy 开关、停止开关、实时打字区、增量合并刷新。
 *
 * 聊天页有两条跑批入口（发消息 / 快捷指令回传后自动续跑），以前两条都各自抄了一遍
 * 「攒增量 + 60ms 刷一次 + 出错清屏 + finally 复位」这套逻辑。抽到这里之后：
 *   - 页面只管「跑谁、跑完存哪儿」；
 *   - 这里管「过程怎么画、怎么停、跑完怎么收摊」。
 *
 * 用法：
 *   const run = useAgentRun()
 *   const hooks = run.begin()                 // 清空实时区、置 busy，拿到回调
 *   await runAgent(text, cfg, history, hooks, { control: run.control })
 *   run.flush()                               // 把还没刷出去的增量补上
 *   run.finish()                              // 复位（放在 finally 里）
 */

/** 流式增量一秒能来几十次，合并到这个间隔刷一次，免得把界面刷爆。 */
const FLUSH_INTERVAL_MS = 60

/** 增量缓冲：放在 ref 里，跨渲染保留（普通局部变量每次渲染都会被重置）。 */
interface DeltaBuffer {
  text: string
  reasoning: string
  /** 下一段推理前要不要插空行（多轮工具调用时每轮一段）。 */
  newSegment: boolean
  lastFlushAt: number
}

export interface AgentRunHandle {
  busy: boolean
  /** 传给 core 的中止开关：跑的过程中把它置 true 就会尽快停。 */
  control: RunControl
  liveText: string
  liveReasoning: string
  liveSteps: ToolStep[]
  /** 开始一轮：复位实时区、置 busy，返回要交给 core 的 hooks。 */
  begin: (extra?: { onToolsCreated?: (names: string[]) => void }) => RunAgentHooks
  /** 把缓冲里攒着的增量立刻刷到界面（一轮结束时补一刀）。 */
  flush: () => void
  /** 结束一轮：复位 busy 与实时区。 */
  finish: () => void
  /** 用户点「停止」：已生成的内容会保留。 */
  stop: () => void
}

export function useAgentRun(): AgentRunHandle {
  const [busy, setBusy] = useState(false)
  const [liveText, setLiveText] = useState("")
  const [liveReasoning, setLiveReasoning] = useState("")
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([])
  const [control] = useState<RunControl>(() => ({ aborted: false }))
  const buf = useRef<DeltaBuffer>({ text: "", reasoning: "", newSegment: false, lastFlushAt: 0 })

  function flush() {
    const b = buf.current
    b.lastFlushAt = Date.now()
    if (b.text) {
      const chunk = b.text
      b.text = ""
      setLiveText((prev) => prev + chunk)
    }
    if (b.reasoning) {
      const chunk = b.reasoning
      const sep = b.newSegment ? "\n\n" : ""
      b.reasoning = ""
      b.newSegment = false
      setLiveReasoning((prev) => (prev ? prev + sep + chunk : chunk))
    }
  }

  function onDelta(d: AgentDelta) {
    const b = buf.current
    if (d.reset) {
      // 流式中途失败 / 退回一次性请求：已经画出来的内容作废。
      b.text = ""
      b.reasoning = ""
      b.newSegment = false
      setLiveText("")
      setLiveReasoning("")
      return
    }
    if (d.type === "text") {
      b.text += d.content
    } else {
      if (d.newSegment) b.newSegment = true
      b.reasoning += d.content
    }
    if (Date.now() - b.lastFlushAt >= FLUSH_INTERVAL_MS) flush()
  }

  function begin(extra?: { onToolsCreated?: (names: string[]) => void }): RunAgentHooks {
    control.aborted = false
    buf.current = { text: "", reasoning: "", newSegment: false, lastFlushAt: 0 }
    setBusy(true)
    setLiveText("")
    setLiveReasoning("")
    setLiveSteps([])
    return {
      // 调工具前模型可能擦过一句开场白，它不在最终回答里，清掉免得一闪就没。
      onEvent: () => {
        buf.current.text = ""
        setLiveText("")
      },
      onStep: (s) => setLiveSteps((prev) => [...prev, s]),
      onToolsCreated: extra?.onToolsCreated,
      onDelta,
    }
  }

  function finish() {
    buf.current = { text: "", reasoning: "", newSegment: false, lastFlushAt: 0 }
    setBusy(false)
    setLiveReasoning("")
    setLiveSteps([])
    setLiveText("")
  }

  function stop() {
    control.aborted = true
  }

  return { busy, control, liveText, liveReasoning, liveSteps, begin, flush, finish, stop }
}
