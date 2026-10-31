import { Intent, Script } from "scripting"

/**
 * 把智能体唤到前台，再干「只有前台才能干的事」。
 *
 * ## 为什么需要
 *
 * 快捷指令里用「运行脚本」调用智能体时，脚本跑在**后台进程**里。iOS 不允许后台进程
 * 把别的 App（包括「快捷指令」）拉到前台，所以 `Safari.openURL("shortcuts://…")` 必然失败 ——
 * 这不是名字写错，也不是权限问题。
 *
 * 好消息是系统留了一个**正式**的口子：`Intent.continueInForeground()`。
 * 调用它之后，快捷指令暂停、Scripting 被拉到前台、脚本在前台继续跑；这时再打开
 * `shortcuts://` 就完全合法了。用户第一次会看到系统确认框（之后不再问）。
 *
 * ## 边界
 *
 * - 在 App 里聊天（`Script.env === "index"`）本来就是前台，直接放行，不做任何跳转；
 * - 这个 API 需要 Scripting PRO 且 iOS 26+，拿不到就返回 false，由调用方给用户
 *   一句能照做的提示（把动作换成「在 App 中运行脚本」）；
 * - 一次运行只请求一次，后面的调用直接用上次的结果。
 */

/** 当前是不是「用户在 App 里」跑的。widget / intent / 富通知等都是扩展进程。 */
export function inAppForeground(): boolean {
  try {
    return String((Script as any)?.env ?? "") === "index"
  } catch {
    // 连 env 都读不到就当成前台：宁可不去请求跳转，也别在 App 里弹一个莫名其妙的框。
    return true
  }
}

/** 本次运行是否已经成功切到前台过（切过就一直算前台，不再重复请求）。 */
let granted = false

/** 用户在这一轮里拒绝过：别再反复弹框。 */
let denied = false

/**
 * 确保接下来这一步在前台执行。返回 false 表示「办不到，调用方要给出替代方案」。
 *
 * @param reason 给用户看的一句话，说明为什么要跳（系统确认框里显示）。
 */
export async function ensureForeground(reason: string): Promise<boolean> {
  if (inAppForeground() || granted) return true
  if (denied) return false

  const call = (Intent as any)?.continueInForeground
  if (typeof call !== "function") {
    // 老版本没有这个 API：只能让用户自己把快捷指令的动作换掉。
    return false
  }
  try {
    await call(reason, { alwaysConfirm: false })
    granted = true
    return true
  } catch (e: any) {
    denied = true
    console.log("切换到前台失败：" + (e?.message ?? String(e)))
    return false
  }
}
