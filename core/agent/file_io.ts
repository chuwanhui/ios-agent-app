/**
 * 底层文件与钥匙串读写：原子写 JSON、Keychain 存密钥。
 * 这里只关心「怎么安全地落盘」，不关心存的是什么。
 */

/** 密钥不应随 config.json（及设备备份）明文保存。 */
const KEYCHAIN_PREFIX = "scripting-agent/v1/"
const KEYCHAIN_OPTIONS = { accessibility: "unlocked_this_device" as const }

export function keychainGet(key: string, fallback = ""): string {
  try {
    const saved = Keychain.get(KEYCHAIN_PREFIX + key)
    if (saved != null) return saved
    if (fallback) Keychain.set(KEYCHAIN_PREFIX + key, fallback, KEYCHAIN_OPTIONS)
  } catch {
    // 兼容没有 Keychain 的旧运行时：暂时保留旧配置值，不能因此让应用不可用。
  }
  return fallback
}

export function keychainSet(key: string, value?: string): void {
  try {
    if (value) Keychain.set(KEYCHAIN_PREFIX + key, value, KEYCHAIN_OPTIONS)
    else Keychain.remove(KEYCHAIN_PREFIX + key)
  } catch {
    // 兼容旧运行时，配置文件仍可作为回退。
  }
}

/** 进程被杀时尽量不留下半截 JSON；下次读取会尝试恢复上一份完整文件。 */
export function recoverAtomicFile(path: string): void {
  const backup = path + ".bak"
  try {
    if (!FileManager.existsSync(path) && FileManager.existsSync(backup)) FileManager.renameSync(backup, path)
  } catch {
    // 后续读取会走原有的损坏文件降级逻辑。
  }
}

export function writeJsonAtomically(path: string, value: any): void {
  const temp = path + ".tmp"
  const backup = path + ".bak"
  const text = JSON.stringify(value, null, 2)
  FileManager.writeAsStringSync(temp, text)
  try {
    if (FileManager.existsSync(backup)) FileManager.removeSync(backup)
    if (FileManager.existsSync(path)) FileManager.renameSync(path, backup)
    FileManager.renameSync(temp, path)
    if (FileManager.existsSync(backup)) FileManager.removeSync(backup)
  } catch (e) {
    try {
      if (!FileManager.existsSync(path) && FileManager.existsSync(backup)) FileManager.renameSync(backup, path)
    } catch {}
    try {
      if (FileManager.existsSync(temp)) FileManager.removeSync(temp)
    } catch {}
    throw e
  }
}
