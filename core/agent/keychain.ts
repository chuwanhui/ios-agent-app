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
