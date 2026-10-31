/**
 * 后台模式下「不能自己拉起的快捷指令」先攒起来，交给外层快捷指令执行。
 *
 * ## 为什么需要这一层
 *
 * 快捷指令里用「运行脚本」调用智能体时，脚本是**后台进程**。iOS 不允许后台进程
 * 把另一个 App（包括「快捷指令」）拉到前台，所以 `Safari.openURL("shortcuts://…")`
 * 必然失败 —— 这不是名字写错，也不是权限问题，是平台限制。
 *
 * 聊天页在前台，所以同一套工具在那儿能正常触发。
 *
 * ## 怎么绕过去
 *
 * 让**外层快捷指令**自己跑：智能体把「要跑哪条、传什么参数」攒下来，作为返回值
 * 交给外面那条快捷指令，由它用「运行快捷指令」动作执行（这个动作后台可用）。
 *
 * 只有 `cfg.deferShortcuts` 打开时才会走到这里 —— 关着的时候行为完全不变，
 * 尝试直接打开，失败就报错。
 */

export interface DeferredShortcut {
  /** 真实的快捷指令名（要在「快捷指令」App 里能找到）。 */
  name: string
  /** 传给这条快捷指令的输入文本（有参数时是 JSON，可能带 callId）。 */
  input: string
}

/** 本次运行是否处于「后台交给外层执行」模式。 */
let enabled = false
/** 本次运行攒下的待执行动作（进程内，运行结束由入口取走）。 */
let items: DeferredShortcut[] = []

/** 每次运行开始时调一次：重置队列并设定模式。 */
export function setDeferShortcuts(on: boolean): void {
  enabled = on
  items = []
}

export function deferShortcutsEnabled(): boolean {
  return enabled
}

/** 记一条待执行动作（同名同参数重复调用只留一条）。 */
export function deferShortcut(name: string, input: string): void {
  const n = (name ?? "").trim()
  if (!n) return
  const exists = items.some((it) => it.name === n && it.input === input)
  if (!exists) items.push({ name: n, input })
}

export function takeDeferredShortcuts(): DeferredShortcut[] {
  const out = items
  items = []
  return out
}
