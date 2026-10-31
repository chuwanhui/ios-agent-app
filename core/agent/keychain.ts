/**
 * Keychain：API Key / MCP Token / Git Token 只存在系统钥匙串里。
 *
 * 为什么不用数据库：库文件会被 iCloud / iTunes 备份带走，也会随「导出数据」一起
 * 被发出去；钥匙串绑在「本机 + 已解锁」上，换个设备就解不开，正好符合「密钥不该
 * 跟着数据走」的预期。所以 config 表里存的 Key 一律是空串，读取时从钥匙串注入。
 */
const KEYCHAIN_PREFIX = "scripting-agent/v1/"
const KEYCHAIN_OPTIONS = { accessibility: "unlocked_this_device" as const }

export function keychainGet(key: string, fallback = ""): string {
  try {
    const saved = Keychain.get(KEYCHAIN_PREFIX + key)
    if (saved != null) return saved
    if (fallback) Keychain.set(KEYCHAIN_PREFIX + key, fallback, KEYCHAIN_OPTIONS)
  } catch {
    // 兼容没有 Keychain 的旧运行时：暂时保留旧值，不能因此让应用不可用。
  }
  return fallback
}

export function keychainSet(key: string, value?: string): void {
  try {
    if (value) Keychain.set(KEYCHAIN_PREFIX + key, value, KEYCHAIN_OPTIONS)
    else Keychain.remove(KEYCHAIN_PREFIX + key)
  } catch {
    // 兼容旧运行时。
  }
}

/** 自检用的探针键；每次用完立刻删掉，不占地方。 */
const SELF_TEST_KEY = KEYCHAIN_PREFIX + "selftest"

/**
 * 钥匙串自检：写一个探针，再读回来比对。
 *
 * 为什么要它：快捷指令、小组件都是独立进程，钥匙串的可用性未必和主 App 一致。
 * 光看 `Keychain.get` 返回 null 分不清「从没存过」和「存过但读不到」，
 * 这两者的修法完全不同，所以这里实测一次「写→读→删」。
 */
export function keychainSelfTest(): { ok: boolean; detail: string } {
  try {
    const probe = "ok-" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
    const wrote = Keychain.set(SELF_TEST_KEY, probe, KEYCHAIN_OPTIONS)
    if (wrote === false) return { ok: false, detail: "写入被系统拒绝" }
    const back = Keychain.get(SELF_TEST_KEY)
    if (back !== probe) return { ok: false, detail: "写得进去，但读不回来" }
    Keychain.remove(SELF_TEST_KEY)
    return { ok: true, detail: "" }
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) }
  }
}
