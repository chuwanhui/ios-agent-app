/**
 * 页面内「进下一层 / 返回上一级」的总线。
 *
 * 为什么要有这个文件——脚本里没有编程式 pop 的 API：
 *   · Navigation.useDismiss() 关掉的是**整个 sheet**（真机探针验证），不是上一层；
 *   · EnvironmentValuesReader 给出来的 dismiss 在被 push 的页面里是空操作；
 *   · Navigation 命名空间只有 present / useDismiss 两个函数。
 * 唯一可靠的返回手段是给 NavigationStack 绑一个 path（string[]），
 * 「返回上一级」= path 去掉末尾一条。
 *
 * 而 navigationDestination 的处理器只在导航栈**根视图**那一层生效：被 push 的页面自己
 * 声明的处理器不会被问到（真机探针验证），path 里的每个 id 都得由根组件造页面。
 * 为了不让根页认识所有子页的细节，子页在渲染时把「自己下一层怎么造」登记在这里
 * （registerRoute），根组件只负责查表（buildRoute）。
 *
 * 多个页面（能力页、设置页）各有自己的 NavigationStack，所以 path 要**按页面分开存**：
 *   · 每个页面用 registerNavPath(key, path) 登记自己的 path；
 *   · 页面变可见时调用 activateNavPath(key)，之后 pushRoute / popRoute 只作用于这一份。
 * 注意：**不要在 onDisappear 里清空 path**——NavigationStack 推入新页面时根视图也会
 * 触发 onDisappear，清空 path 会让刚推进去的页面立刻被弹回来（真机踩过）。
 */

type PathState = string[]
/** 兼容 React 的 setState：既接受数组，也接受 updater。 */
type PathSetter = (v: PathState | ((prev: PathState) => PathState)) => void
/** path 里存的是字符串 id，id 用「前缀 + 冒号」分成不同子页的地盘（如 "skill:abc"）。 */
export interface PathLike {
  /** 读**当前**path（别缓存：push / pop 后要拿到最新一层）。 */
  get: () => PathState
  set: PathSetter
}
/** rest 是 id 去掉前缀之后的部分（比如 "skill:abc" → "abc"）。 */
type RouteBuilder = (rest: string) => any

const stacks: Record<string, PathLike> = {}
let activeKey = ""
const builders: { prefix: string; build: RouteBuilder }[] = []
/** 当 path 退回到根（length === 0）时触发，一次性回调。 */
let onRootReached: (() => void) | null = null

/** 页面登记 / 注销自己的 path（传 null 表示卸载）。key 用页面自己的常量。 */
export function registerNavPath(key: string, p: PathLike | null) {
  if (p) stacks[key] = p
  else delete stacks[key]
}

/** 页面变可见时调用，之后所有导航操作都作用于这一份 path。 */
export function activateNavPath(key: string) {
  activeKey = key
}

function current(): PathLike | null {
  return stacks[activeKey] ?? null
}

/** 进下一层：往 path 末尾加一条 id。 */
export function pushRoute(route: string) {
  const c = current()
  if (!c) return
  c.set((prev) => [...prev, route])
}

/** 从一级入口直达某页：丢掉旧的子页层级，只保留目标页。 */
export function openRootRoute(route: string) {
  const c = current()
  if (!c) return
  c.set(route ? [route] : [])
}

/** 登记一次性回调：下次 path 退回到根时触发。传 null 表示清空。 */
export function willSwitchTabOnRoot(cb: (() => void) | null) {
  onRootReached = cb
}

/** 返回上一级；已经在根上（或没有 path）返回 false，什么也不做。 */
export function popRoute(): boolean {
  const c = current()
  if (!c) return false
  const len = c.get().length
  if (len === 0) return false
  c.set((prev) => prev.slice(0, -1))
  if (len === 1 && onRootReached) {
    const cb = onRootReached
    onRootReached = null
    setTimeout(cb, 0)
  }
  return true
}

/**
 * 清空整个导航栈并触发 root 回调（如果已注册）。
 * 用于 NavigationStack 的 onChanged 回调：系统返回按钮会直接改 NavigationStack 的内部状态，
 * 而不是走 popRoute，所以需要在 onChanged 里同步 navPath。
 */
export function clearToRoot() {
  const c = current()
  if (!c || c.get().length === 0) return
  c.set([])
  if (onRootReached) {
    const cb = onRootReached
    onRootReached = null
    setTimeout(cb, 0)
  }
}

/**
 * 子页登记「id 以 prefix 开头时，这一层页面怎么造」。
 * 每次渲染都登记一遍，保证工厂闭包拿到的是这一页最新的草稿。
 */
export function registerRoute(prefix: string, build: RouteBuilder) {
  const i = builders.findIndex((b) => b.prefix === prefix)
  if (i >= 0) builders[i] = { prefix, build }
  else builders.push({ prefix, build })
}

/** 根组件用：把 path 里的一层 id 变成页面；没人登记过就返回 null。 */
export function buildRoute(route: string): any | null {
  let best: { prefix: string; build: RouteBuilder } | null = null
  for (const b of builders) {
    if (route.indexOf(b.prefix) !== 0) continue
    // 取最长前缀，避免 "cap-skills" 之类互相遮挡。
    if (!best || b.prefix.length > best.prefix.length) best = b
  }
  if (!best) return null
  return best.build(route.slice(best.prefix.length))
}
