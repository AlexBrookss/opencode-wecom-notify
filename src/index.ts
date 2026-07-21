import type { Plugin } from "@opencode-ai/plugin"
import os from "os"

/*
 * opencode 企业微信通知插件 v3.0
 *
 * 功能：任务完成、权限请求、工具执行错误等关键事件推送通知到企业微信群。
 *
 * 环境变量：
 *   OPENCODE_NOTIFY_WECOM_WEBHOOK   企业微信群机器人 Webhook URL（必填）
 *   OPENCODE_NOTIFY_HOSTNAME        显示的主机名（可选，默认系统 hostname）
 *   OPENCODE_NOTIFY_ENABLED         设为 false 可临时关闭插件（默认 true）
 */

const HOSTNAME = process.env.OPENCODE_NOTIFY_HOSTNAME || os.hostname()
const ENABLED = process.env.OPENCODE_NOTIFY_ENABLED !== "false"

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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`
}

const plugin: Plugin = async ({ directory }) => {
  if (!getWebhookUrl()) {
    console.warn("[wecom] 请设置环境变量 OPENCODE_NOTIFY_WECOM_WEBHOOK")
    return {}
  }
  if (!ENABLED) return {}

  const sessionParts = new Map<string, string[]>()
  const sessionUserParts = new Map<string, string[]>()
  const sessionUserMsgIds = new Set<string>()
  const sessionTitles = new Map<string, string>()
  const sessionEditedFiles = new Map<string, Set<string>>()

  function header(title: string): string {
    return `> 🖥 ${HOSTNAME} | ${directory}\n\n`
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          const info = event.properties.info
          sessionParts.set(info.id, [])
          sessionUserParts.set(info.id, [])
          sessionTitles.set(info.id, info.title || "未命名")
        }

        if (event.type === "session.updated") {
          const info = event.properties.info
          if (info.title) sessionTitles.set(info.id, info.title)
        }

        if (event.type === "message.updated") {
          const info = event.properties.info
          if (info.role === "user") {
            sessionUserMsgIds.add(info.id)
          }
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part
          const sessionID = part.sessionID
          if (!sessionParts.has(sessionID)) sessionParts.set(sessionID, [])
          if (!sessionUserParts.has(sessionID)) sessionUserParts.set(sessionID, [])

          if (part.type === "text" && part.text && !part.synthetic) {
            if (sessionUserMsgIds.has(part.messageID)) {
              sessionUserParts.get(sessionID)!.push(part.text)
            } else {
              sessionParts.get(sessionID)!.push(part.text)
            }
          }

          if (part.type === "tool" && part.state.status === "error") {
            const title = sessionTitles.get(sessionID) || "opencode 会话"
            let text = `## ❌ 工具执行错误\n\n**${title}**\n${header(title)}`
            text += `> 🛠 **${part.tool}**\n> ${part.state.error}\n`
            text += `\n> 🕐 ${fmtTime(Date.now())}\n`
            await sendWecom(text)
            return
          }

          if (part.type === "tool" && part.tool === "edit" && part.state.status === "completed") {
            const input = part.state.input as Record<string, unknown>
            const file = String(input.filePath || input.file || input.path || part.state.title || "")
            if (file) {
              if (!sessionEditedFiles.has(sessionID)) sessionEditedFiles.set(sessionID, new Set())
              sessionEditedFiles.get(sessionID)!.add(file)
            }
          }
        }

        if (event.type === "session.idle") {
          const sessionID = event.properties.sessionID
          const assistantParts = sessionParts.get(sessionID)
          const userParts = sessionUserParts.get(sessionID)
          const title = sessionTitles.get(sessionID) || "opencode 会话"
          const assistantText = assistantParts?.join("\n").trim() || ""
          const userText = userParts?.join("\n").trim() || ""
          const editedFiles = sessionEditedFiles.get(sessionID)
          if (!assistantText && !userText && (!editedFiles || editedFiles.size === 0)) {
            // 清空状态，避免累积到下一次
            sessionParts.set(sessionID, [])
            sessionUserParts.set(sessionID, [])
            sessionUserMsgIds.clear()
            sessionEditedFiles.delete(sessionID)
            return
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
          await sendWecom(text)

          sessionParts.set(sessionID, [])
          sessionUserParts.set(sessionID, [])
          sessionUserMsgIds.clear()
          sessionEditedFiles.delete(sessionID)
        }

        if (event.type === "session.error") {
          const { sessionID, error } = event.properties
          const title = sessionTitles.get(sessionID || "") || "opencode 会话"
          const errMsg = (error?.data && typeof error.data === "object" && "message" in error.data ? String(error.data.message) : JSON.stringify(error)) || ""
          let text = `## ❌ 任务出错\n\n**${title}**\n${header(title)}`
          text += `\`\`\`\n${errMsg.slice(0, 1500)}\n\`\`\`\n`
          text += `\n> 🕐 ${fmtTime(Date.now())}\n`
          await sendWecom(text)
        }

        if (event.type === "session.deleted") {
          sessionParts.delete(event.properties.info.id)
          sessionUserParts.delete(event.properties.info.id)
          sessionUserMsgIds.clear()
          sessionTitles.delete(event.properties.info.id)
          sessionEditedFiles.delete(event.properties.info.id)
        }
      } catch (err) {
        console.error("[wecom] 事件处理出错:", err)
      }
    },

    "permission.ask": async (input, output) => {
        const permType = (input as any).permission || input.type || "未知"
        const permPatterns = (input as any).patterns || (input.pattern ? [input.pattern].flat() : [])
        const title = input.title || sessionTitles.get(input.sessionID) || "opencode 会话"
        let text = `## 🔐 需要授权\n\n**${title}**\n${header(title)}`
        text += `- 类型：\`${permType}\`\n`
        if (permPatterns.length > 0) text += `- 匹配：\`${permPatterns.join(", ")}\`\n`
        text += `\n> 请返回终端确认操作\n`
        text += `> 🕐 ${fmtTime(Date.now())}\n`
        await sendWecom(text)
    },
  }
}

export default plugin