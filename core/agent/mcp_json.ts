/**
 * MCP 服务器配置：导入 / 导出。
 * 各家的 JSON 写法五花八门，这里统一收敛成 McpServer。
 */
import { McpServer } from "./types"

export function makeMcpServer(): McpServer {
  return {
    id: "s" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    name: "",
    url: "",
    token: "",
    headersHint: "",
    enabled: true,
  }
}

// ———————————————————————— MCP：JSON 导入 / 导出 ————————————————————————

/** 从一段 MCP 配置 JSON 里解析出的结果。 */
export interface McpParseResult {
  /** 解析出来的服务器（id 已生成，未去重）。 */
  servers: McpServer[]
  /** 被跳过条目的原因说明，可直接展示给用户。 */
  skipped: string[]
}

function asRecord(v: any): Record<string, any> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null
}

function entriesOf(o: Record<string, any>): [string, any][] {
  return Object.keys(o).map((k) => [k, o[k]] as [string, any])
}

/** 把任意写法里的 id 部分清洗成合法标识符（模型看到的函数名要带上它）。 */
function slugifyId(raw: string, prefix: string, used: Set<string>): string {
  let base = (raw ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "")
  if (!base || !/^[A-Za-z_]/.test(base)) base = prefix + base
  let id = base
  let i = 2
  while (used.has(id)) {
    id = base + "_" + i
    i += 1
  }
  used.add(id)
  return id
}

/**
 * 从各种常见的 MCP 配置写法里取出「服务器名 → 配置」映射：
 * `{mcpServers:{…}}` / `{servers:{…}}` / `{mcp:{servers:{…}}}` / 裸映射 `{名字:{url}}`。
 */
function pickServerMap(root: any): Record<string, any> | null {
  const obj = asRecord(root)
  if (!obj) return null
  for (const key of ["mcpServers", "mcp_servers", "servers", "mcpServersList"]) {
    const m = asRecord(obj[key])
    if (m && Object.keys(m).length > 0) return m
  }
  const nested = asRecord(obj.mcp)
  if (nested) {
    const m = asRecord(nested.servers) ?? asRecord(nested.mcpServers)
    if (m && Object.keys(m).length > 0) return m
  }
  // 裸映射：值全是对象（或全是字符串形式的地址）时，认为整个对象就是名字 → 配置
  const values = Object.keys(obj).map((k) => obj[k])
  if (values.length > 0 && values.every((v) => asRecord(v) !== null)) return obj
  if (values.length > 0 && values.every((v) => typeof v === "string" && v.indexOf("/") >= 0)) return obj
  return null
}

/**
 * 解析用户粘贴的 MCP 配置 JSON。
 * 支持 `{"mcpServers":{名字:{url,headers}}}`（Claude / Cherry Studio 等）与 VS Code 的
 * `{"mcp":{"servers":{…}}}`；`command` / `args` 的 stdio 型会明确跳过并说明原因，
 * 而不是静默丢掉（iOS 上跑不了本地子进程）。
 */
export function parseMcpServersJson(text: string): McpParseResult {
  const raw = (text ?? "").trim()
  if (!raw) throw new Error("请先粘贴 MCP 配置 JSON")
  let root: any
  try {
    root = JSON.parse(raw)
  } catch (e: any) {
    throw new Error("JSON 格式不对：" + (e?.message ?? "解析失败"))
  }
  const map = pickServerMap(root)
  if (!map) {
    throw new Error(
      "没找到 mcpServers 字段。支持 {\"mcpServers\":{…}}、{\"mcp\":{\"servers\":{…}}}，或 {\"名字\":{\"url\":…}}",
    )
  }

  const out: McpParseResult = { servers: [], skipped: [] }
  const used = new Set<string>()
  const seenUrl = new Set<string>()

  for (const [key, value] of entriesOf(map)) {
    const label = key || "未命名"
    // 名字 → 地址 的简写
    if (typeof value === "string") {
      const url = value.trim()
      if (!url) {
        out.skipped.push(`${label}：地址是空的`)
        continue
      }
      if (seenUrl.has(url)) {
        out.skipped.push(`${label}：地址重复，只留第一条`)
        continue
      }
      seenUrl.add(url)
      const s = makeMcpServer()
      s.id = slugifyId(key, "s", used)
      s.name = label
      s.url = url
      out.servers.push(s)
      continue
    }

    const rec = asRecord(value)
    if (!rec) {
      out.skipped.push(`${label}：配置看不懂（应该是一个对象）`)
      continue
    }
    const type = String(rec.type ?? rec.transport ?? "").toLowerCase()
    const url = String(rec.url ?? rec.endpoint ?? rec.serverUrl ?? rec.httpUrl ?? "").trim()
    const command = rec.command
    if (!url) {
      out.skipped.push(
        command
          ? `${label}：stdio 型（command: ${command}），iOS 上没法起本地进程，需要换成 http/sse 地址`
          : `${label}：没写 url`,
      )
      continue
    }
    if (type === "stdio") {
      out.skipped.push(`${label}：stdio 型跑不了（iOS 没有子进程管道）`)
      continue
    }
    if (seenUrl.has(url)) {
      out.skipped.push(`${label}：地址重复，只留第一条`)
      continue
    }
    seenUrl.add(url)

    const s = makeMcpServer()
    s.id = slugifyId(key || url, "s", used)
    s.name = String(rec.title ?? "") || label
    s.url = url

    const lines: string[] = []
    const headers = asRecord(rec.headers)
    if (headers) {
      for (const [hk, hv] of entriesOf(headers)) {
        const val = typeof hv === "string" ? hv : String(hv ?? "")
        if (/^authorization$/i.test(hk)) {
          // Authorization: Bearer xxx → 归到「令牌」，其余写法原样留在请求头里
          const m = val.match(/^\s*bearer\s+(.+)$/i)
          if (m) s.token = m[1].trim()
          else lines.push(`${hk}: ${val}`)
        } else {
          lines.push(`${hk}: ${val}`)
        }
      }
    }
    if (typeof rec.token === "string" && !s.token) s.token = rec.token.trim()
    if (typeof rec.apiKey === "string" && !s.token) s.token = rec.apiKey.trim()
    s.headersHint = lines.join("\n")
    if (rec.enabled === false || rec.disabled === true) s.enabled = false
    out.servers.push(s)
  }

  return out
}

/** 把当前服务器列表导出成标准 MCP 配置 JSON（方便复制给别的客户端）。 */
export function mcpServersToJson(servers: McpServer[]): string {
  const obj: Record<string, any> = {}
  for (const s of servers) {
    const entry: Record<string, any> = { url: s.url ?? "" }
    const headers: Record<string, string> = {}
    const tk = (s.token ?? "").trim()
    if (tk) headers["Authorization"] = "Bearer " + tk
    for (const line of (s.headersHint ?? "").split(/\r?\n/)) {
      const i = line.indexOf(":")
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      if (!k) continue
      headers[k] = line.slice(i + 1).trim()
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    if (!s.enabled) entry.disabled = true
    obj[s.name || s.id] = entry
  }
  return JSON.stringify({ mcpServers: obj }, null, 2)
}
