/**
 * 把 HTTP 状态码翻成人话。
 *
 * 各家接口出错时回的都是 `{"error":{"message":"Insufficient Balance"}}` 这种，
 * 直接扔给用户就是「接口错误 402：{...json...}」，等于什么都没说。
 * 这里做两件事：给出**这是什么意思**、**下一步该干什么**，再把原始回复附在后面（方便排查）。
 */

/** 从错误体里挑一句供应商自己的说明（OpenAI 兼容格式，各家都差不多）。 */
function providerMessage(body: string): string {
  const raw = (body ?? "").trim()
  if (!raw) return ""
  try {
    const o = JSON.parse(raw)
    const e = o?.error ?? o
    const msg = typeof e === "string" ? e : (e?.message ?? o?.message ?? "")
    if (typeof msg === "string" && msg.trim()) return msg.trim()
  } catch {
    // 不是 JSON：多半是网关的 HTML 错误页，下面统一切成一行
  }
  return raw.replace(/\s+/g, " ").slice(0, 160)
}

/** 状态码 → 「怎么了 / 怎么办」。没收录的就说不知道，别乱猜。 */
function adviceOf(status: number): { what: string; todo: string } | null {
  switch (status) {
    case 400:
      return { what: "请求被拒（参数不对）", todo: "多半是模型名或图片格式不对：回设置的供应商页重新拉一次模型再选。" }
    case 401:
      return { what: "API Key 不对或已经失效", todo: "回供应商页重新贴一次 Key（被删除、被重置、复制时少了字符都会这样）。" }
    case 402:
      return {
        what: "余额不足（欠费）",
        todo: "这家是预付费，账户余额为 0 或额度用完就一律返回 402。去供应商官网充值，再回来发一次；充值后仍报 402 就回供应商页点「重新查询余额」看看到账没有。",
      }
    case 403:
      return { what: "这个 Key 没有权限", todo: "可能没开通这个模型，或 Key 被限制了来源 / 额度。去供应商控制台确认这个模型对这把 Key 可用。" }
    case 404:
      return { what: "接口地址或请求路径不对", todo: "检查供应商页的「接口地址」（如 https://api.deepseek.com）和「请求路径」（一般是 /chat/completions），别多带一段 /v1 之类的。" }
    case 413:
      return { what: "这一轮内容太长", todo: "消息、知识库或图片塞得太多了：删掉一点，或把「最大历史条数」调小。" }
    case 422:
      return { what: "参数不合法", todo: "通常是模型名不对或图片格式不支持：重新拉模型列表选一个，图片换成 jpg / png 再试。" }
    case 429:
      return { what: "请求太频繁，被限流了", todo: "等几秒再发；如果一直这样，多半是这把 Key 的并发 / 每日额度用完了。" }
    case 500:
    case 502:
    case 503:
    case 504:
      return { what: "供应商服务端出问题了", todo: "不是你这边的错，稍等一会儿再试（已经自动重试过几次了）。" }
    default:
      return null
  }
}

/**
 * 拼一句给用户看的错误文案。
 *
 * 例：`余额不足（欠费）：去供应商官网充值后再试……（供应商原话：Insufficient Balance）`
 */
export function httpErrorText(status: number, body: string): string {
  const said = providerMessage(body)
  const advice = adviceOf(status)
  if (!advice) {
    return `接口错误 ${status}${said ? "：" + said : ""}（这是供应商返回的状态码，不是 App 自己的报错）`
  }
  const bits = [`接口错误 ${status}（${advice.what}）：${advice.todo}`]
  if (said) bits.push(`（供应商原话：${said}）`)
  return bits.join("")
}

/**
 * Key 的「指纹」：只露头尾几位，够用来分辨「这是不是同一把 Key」，又不算泄密。
 *
 * 为什么要它：同一个 App 有两条入口（聊天页 / URL 唤起），用户看到两边结果不同时，
 * 第一件要排除的事就是「是不是用了两把不同的 Key」。
 */
export function keyFingerprint(key?: string): string {
  const k = (key ?? "").trim()
  if (!k) return "（空）"
  if (k.length <= 10) return k.slice(0, 2) + "…"
  return `${k.slice(0, 5)}…${k.slice(-4)}（${k.length} 位）`
}

/** 这一轮请求用的是哪家、哪个模型、哪把 Key —— 出错时附在最后一行，方便对比两条入口。 */
export function describeRequest(cfg: { name?: string; baseUrl?: string; model?: string; apiKey?: string }): string {
  const bits = [
    (cfg.name ?? "").trim() || "未命名供应商",
    (cfg.baseUrl ?? "").trim() || "（没填接口地址）",
    (cfg.model ?? "").trim() || "（没选模型）",
    "Key " + keyFingerprint(cfg.apiKey),
  ]
  return `这次用的是：${bits.join(" · ")}`
}
