/**
 * 「为什么没有 API Key」的诊断文案。
 *
 * 快捷指令入口和聊天页都会在发消息前检查 Key，但只丢一句「去填 API Key」是最没用的：
 * 真实原因常常根本不是没填。至少有两种完全不同的情况：
 *
 *   - **配置根本没读出来**：数据目录写不进去（磁盘满 / 权限），
 *     于是 loadConfig() 整份是出厂默认值，Key 自然是空；
 *   - **配置读出来了，但 Key 是空串**：Key 只存钥匙串，而快捷指令 / 小组件是独立进程，
 *     钥匙串写不进或读不回时，磁盘上那份脱敏配置永远是空的。
 *
 * 这里把「配置读到了多少」和「钥匙串能不能用」都实测一遍，说清楚是哪一种。
 */
import { AgentConfig } from "./types"
import { activeProvider } from "./provider"
import { keychainSelfTest } from "./keychain"
import { storageDegraded } from "../store/init"

export function keyProblemText(cfg: AgentConfig): string {
  const provider = activeProvider(cfg)
  const baseUrl = (provider?.baseUrl ?? cfg.baseUrl ?? "").trim()
  const model = (provider?.model ?? cfg.model ?? "").trim()

  // ① 整份配置没读到：数据目录写不进去，任何设置都只是内存里的临时值。
  if (storageDegraded()) {
    return [
      "这次运行写不进本机数据目录（多半是空间满或权限问题），所以设置里存的东西（包括 Key）都是空的。",
      "去「设置 → 诊断 → 数据存在哪」能看到具体路径和大小；腾点空间或重启 App 再试。",
    ].join("\n")
  }

  // ② 连供应商都没有：确实是没配置。
  if (!provider) {
    return "还没有配置模型：打开「智能体」→ 设置 → 模型配置 → 模型 → 添加供应商，填接口地址和 API Key 再回来。"
  }

  // ③ 供应商在，但缺地址 / 模型：发请求也发不出去，和 Key 无关。
  if (!baseUrl || !model) {
    const missing = !baseUrl && !model ? "接口地址和模型都" : !baseUrl ? "接口地址" : "模型"
    return `供应商「${provider.name || "未命名"}」读到了，但${missing}是空的，没法发请求。回设置里补一下。`
  }

  // ④ 配置齐全、只有 Key 空：现场测一下钥匙串，分清「没存住」和「读不到」。
  const probe = keychainSelfTest()
  return [
    `供应商「${provider.name || "未命名"}」的配置读到了（${baseUrl} · ${model}），但 API Key 是空的。`,
    probe.ok
      ? "钥匙串在这台设备上读写正常，说明只是这家供应商的 Key 没存住：回设置里重新填一次 Key（改完自动保存），再从快捷指令试。"
      : `钥匙串在这个运行环境里用不了（${probe.detail}），Key 存进去也读不回来 —— 快捷指令这类独立进程常见这种限制。先把 Key 填回 App 里能用的那份，我可以再给一个不依赖钥匙串的兜底方案。`,
  ].join("\n")
}
