import { Script, useEffect, useState } from "scripting"
import { CallbackOutcome, handleCallback } from "../core/agent/tool_callback"

/**
 * 快捷指令回传有一条冷启动入口（queryParameters）和一条被唤起入口（onResume），
 * 两条都要接。这里统一成「解析 → 刷新 config/store → 排队续跑」的 hook：
 *   - 解析出回传（handleCallback）就触发 onConsumed（父级刷新 cfg/store）；
 *   - 续跑不能忙时发，等不忙了才 onFire。
 * 续跑时不新增用户消息，而是用已回填的工具 step 还原 role:"tool"。
 */
export function useCallbackAutoJob({
  onConsumed, onFire, busy,
}: {
  /** 回传落盘后刷新 config/store。 */
  onConsumed: () => void
  /** 不忙时真正发出去的那一轮。 */
  onFire: (out: CallbackOutcome) => void
  busy: boolean
}) {
  const [autoJob, setAutoJob] = useState<CallbackOutcome | null>(null)

  useEffect(() => {
    const consume = (params: any) => {
      let out: ReturnType<typeof handleCallback> = null
      try {
        out = handleCallback(params)
      } catch {
        out = null
      }
      if (!out) return
      onConsumed()
      setAutoJob(out)
    }
    consume(Script.queryParameters)
    const off = Script.onResume((d) => consume(d?.queryParameters ?? null))
    return () => {
      if (typeof off === "function") off()
    }
  }, [])

  useEffect(() => {
    if (!autoJob || busy) return
    const job = autoJob
    setAutoJob(null)
    onFire(job)
  }, [autoJob, busy])
}
