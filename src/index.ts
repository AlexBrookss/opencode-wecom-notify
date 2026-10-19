import os from "os"
import { Plugin } from "@opencode/plugin"

/*
 * opencode 企业微信通知插件 v4.0（适配 opencode V2 插件 API）
 *
 * 功能：任务完成、权限请求、工具执行错误等关键事件推送通知到企业微信群。
 *
 * 环境变量：
 *   OPENCODE_NOTIFY_WECOM_WEBHOOK   企业微信群机器人 Webhook URL（必填）
 *   OPENCODE_NOTIFY_HOSTNAME        显示的主机名（可选，默认系统 hostname）
 *   OPENCODE_NOTIFY_ENABLED         设为 false 可临时关闭插件（默认 true）
 *
 * 兼容性：opencode >= 2.0（V2 插件 API）。V1 请使用 npm 上的 1.x 版本。
 */

function getWebhookUrl(): string | null {
  return process.env.OPENCODE_NOTIFY_WECOM_WEBHOOK || process.env.WECOM_WEBHOOK_URL || null
}

async function sendWecom(content: string): Promise<void> {
  const url = getWebhookUrl()
  if (!url) return
  if (content.length > 4000) content = content.slice(0, 4000) + "\n\n...（内容较长，请查看终端）"
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown_v2", markdown_v2: { content } }),
    })
    if (!res.ok) console.error(`[wecom] HTTP ${res.status}: ${await res.text()}`)
  } catch (err) {
    console.error("[wecom] send failed:", err)
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

// V2 事件信封：{ id, created, type, location?, data }
type V2Event = { id?: string; type: string; data?: Record<string, any> }

export default Plugin.define({
  id: "opencode-wecom-notify",
  async setup(ctx) {
    if (!getWebhookUrl()) {
      console.warn("[wecom] 请设置环境变量 OPENCODE_NOTIFY_WECOM_WEBHOOK")
      return
    }
    if (process.env.OPENCODE_NOTIFY_ENABLED === "false") return

    const HOSTNAME = process.env.OPENCODE_NOTIFY_HOSTNAME || os.hostname()
    const directory = ctx.location.directory

    const sessionTexts = new Map<string, string[]>()
    const sessionUserTexts = new Map<string, string[]>()
    const sessionTitles = new Map<string, string>()
    const sessionEditedFiles = new Map<string, Set<string>>()
    const callNames = new Map<string, string>()

    function header(title: string): string {
      return `> 🖥 ${HOSTNAME} | ${directory}\n\n`
    }

    function push<T>(map: Map<string, T[]>, key: string, value: T): void {
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(value)
    }

    function addEditedFile(sessionID: string, file: string): void {
      let set = sessionEditedFiles.get(sessionID)
      if (!set) {
        set = new Set()
        sessionEditedFiles.set(sessionID, set)
      }
      set.add(file)
    }

    // ---- 跨实例去重 ----
    // V2 会按 location 加载多份插件实例，同一事件每个实例都会收到。
    // 借助共享的 ctx.storage 抢占“发送权”，保证同一事件只发一条通知。
    let seq = 0
    async function claim(key: string): Promise<boolean> {
      const token = `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try {
        if (await ctx.storage.get(key)) return false
        await ctx.storage.set(key, { token, at: Date.now() })
        // 确认窗口：并发实例几乎同时抢标记，后写入者获胜，只有它继续发送
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 120))
        const now = (await ctx.storage.get(key)) as unknown as { token?: string } | undefined
        return !!now && now.token === token
      } catch (err) {
        console.error("[wecom] 去重检查失败，按原逻辑发送:", err)
        return true
      }
    }

    function hash(s: string): string {
      let h = 2166136261
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return (h >>> 0).toString(36)
    }

    // 优先用事件全局唯一 id 作为去重键；没有 id 时退回“内容指纹 + 10 秒时间桶”
    function dedupKey(event: V2Event, extra: string): string {
      return event.id ? `sent/evt/${event.id}` : `sent/fp/${hash(`${extra}|${Math.floor(Date.now() / 10000)}`)}`
    }

    async function sendOnce(key: string, content: string): Promise<void> {
      if (!(await claim(key))) return
      await sendWecom(content)
      if (Math.random() < 0.05) void prune()
    }

    // 定期清理 6 小时前的去重标记，避免 ctx.storage 无限增长
    async function prune(): Promise<void> {
      try {
        const cutoff = Date.now() - 6 * 60 * 60 * 1000
        let after: string | undefined
        for (;;) {
          const page = await ctx.storage.scan({ prefix: "sent/", after, limit: 200 })
          for (const entry of page.entries) {
            const v = entry.value as { at?: number } | undefined
            if (!v || typeof v.at !== "number" || v.at < cutoff) await ctx.storage.remove(entry.key)
          }
          if (!page.next) break
          after = page.next
        }
      } catch (err) {
        console.error("[wecom] 去重标记清理失败:", err)
      }
    }

    // 权限请求通知（V1 的 permission.ask）
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask") return
      try {
        const title = sessionTitles.get(event.sessionID) || "opencode 会话"
        const resources = event.resources ?? []
        let text = `## 🔐 需要授权\n\n**${title}**\n${header(title)}`
        text += `- 类型：\`${event.action}\`\n`
        if (resources.length > 0) text += `- 匹配：\`${resources.join(", ")}\`\n`
        text += `\n> 请返回终端确认操作\n`
        text += `> 🕐 ${fmtTime(Date.now())}\n`
        const key = `sent/perm/${hash(`${event.sessionID}|${event.action}|${resources.join(",")}|${Math.floor(Date.now() / 10000)}`)}`
        await sendOnce(key, text)
      } catch (err) {
        console.error("[wecom] 权限通知出错:", err)
      }
    })

    const controller = new AbortController()
    void (async () => {
      const stream = ctx.event.subscribe({ signal: controller.signal }) as unknown as AsyncIterable<V2Event>
      for await (const event of stream) {
        const d = event.data ?? {}
        try {
          switch (event.type) {
            case "session.created": {
              sessionTexts.set(d.sessionID, [])
              sessionUserTexts.set(d.sessionID, [])
              break
            }

            case "session.renamed": {
              if (d.title) sessionTitles.set(d.sessionID, String(d.title))
              break
            }

            case "session.inbox.enqueued": {
              const item = d.item
              if (item?.type === "user" && item.payload?.text) {
                push(sessionUserTexts, d.sessionID, String(item.payload.text))
              }
              break
            }

            case "session.text.ended": {
              if (d.text) push(sessionTexts, d.sessionID, String(d.text))
              break
            }

            case "session.tool.input.started": {
              if (d.id && d.name) callNames.set(String(d.id), String(d.name))
              break
            }

            case "session.tool.called": {
              const name = callNames.get(String(d.id))
              if (name === "edit" || name === "write" || name === "patch") {
                const input = (d.input ?? {}) as Record<string, unknown>
                const file = String(input.filePath || input.file || input.path || "")
                if (file) addEditedFile(d.sessionID, file)
              }
              break
            }

            case "session.tool.failed": {
              const title = sessionTitles.get(d.sessionID) || "opencode 会话"
              const toolName = callNames.get(String(d.id)) || "unknown"
              const err = (d.error ?? {}) as Record<string, any>
              const errMsg = String(err.message || err.data?.message || JSON.stringify(err)).slice(0, 1500)
              let text = `## ❌ 工具执行错误\n\n**${title}**\n${header(title)}`
              text += `> 🛠 **${toolName}**\n> ${errMsg}\n`
              text += `\n> 🕐 ${fmtTime(Date.now())}\n`
              await sendOnce(dedupKey(event, `${d.sessionID}|tool.failed|${d.id}|${errMsg}`), text)
              if (d.id) callNames.delete(String(d.id))
              break
            }

            case "session.execution.succeeded": {
              // 等待一小段时间确保 text.ended 等事件已到达（与 V1 行为一致）
              await new Promise((r) => setTimeout(r, 100))
              const sessionID = d.sessionID
              const assistantText = (sessionTexts.get(sessionID) ?? []).join("\n").trim()
              const userText = (sessionUserTexts.get(sessionID) ?? []).join("\n").trim()
              const editedFiles = sessionEditedFiles.get(sessionID)
              const title = sessionTitles.get(sessionID) || "opencode 会话"
              if (!assistantText && !userText && (!editedFiles || editedFiles.size === 0)) {
                sessionTexts.set(sessionID, [])
                sessionUserTexts.set(sessionID, [])
                sessionEditedFiles.delete(sessionID)
                break
              }

              let text = `## ✅ 阶段完成\n\n**${title}**\n${header(title)}`

              if (userText) {
                text += `💬 **我：**\n> ${userText}\n\n`
              }

              if (assistantText) {
                const snippet = assistantText.length > 300 ? assistantText.slice(0, 300) + "..." : assistantText
                text += `🤖 **opencode：**\n${snippet}\n\n`
              }

              if (editedFiles && editedFiles.size > 0) {
                text += `---\n\n📁 **变更文件：**\n`
                for (const file of editedFiles) {
                  text += `- \`${file}\`\n`
                }
                text += `\n`
              }

              text += `> 🕐 ${fmtTime(Date.now())}\n`
              await sendOnce(dedupKey(event, `${sessionID}|execution.succeeded`), text)
              sessionTexts.set(sessionID, [])
              sessionUserTexts.set(sessionID, [])
              sessionEditedFiles.delete(sessionID)
              break
            }

            case "session.execution.failed": {
              const sessionID = d.sessionID
              const title = sessionTitles.get(sessionID) || "opencode 会话"
              const err = (d.error ?? d) as Record<string, any>
              const errMsg = String(err.data?.message ?? err.message ?? JSON.stringify(err)).slice(0, 1500)
              let text = `## ❌ 任务出错\n\n**${title}**\n${header(title)}`
              text += "```\n" + errMsg + "\n```\n"
              text += `\n> 🕐 ${fmtTime(Date.now())}\n`
              await sendOnce(dedupKey(event, `${sessionID}|execution.failed|${errMsg}`), text)
              break
            }

            case "session.deleted": {
              const id = d.sessionID ?? d.info?.id
              if (id) {
                sessionTexts.delete(id)
                sessionUserTexts.delete(id)
                sessionTitles.delete(id)
                sessionEditedFiles.delete(id)
              }
              break
            }
          }
        } catch (err) {
          console.error("[wecom] 事件处理出错:", err)
        }
      }
    })()

    return () => controller.abort()
  },
})
