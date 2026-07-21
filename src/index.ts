import type { Plugin } from "@opencode-ai/plugin"

/*
 * opencode 企业微信通知插件 v2.2
 *
 * 监听 opencode 会话周期（busy → idle），任务完成后推送通知到企业微信群。
 *
 * 快速开始：
 *   1. 企业微信 → 群聊 → 群机器人 → 添加机器人，复制 Webhook URL
 *   2. export WECOM_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
 *   3. 重启 opencode
 *
 * 推送内容：
 *   💬 用户消息 → 🤖 AI 回复 → 📁 变更文件 → 🕐 完成时间
 */

function getWebhookUrl(): string | null {
  return process.env.WECOM_WEBHOOK_URL || null
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

const plugin: Plugin = async () => {
  if (!getWebhookUrl()) {
    console.warn("[wecom] 请设置环境变量 WECOM_WEBHOOK_URL")
    return {}
  }

  const sessionParts = new Map<string, string[]>()
  const sessionUserParts = new Map<string, string[]>()
  const sessionUserMsgIds = new Set<string>()
  const sessionTitles = new Map<string, string>()
  const sessionEditedFiles = new Map<string, Map<string, { additions: number; deletions: number; modifications: number }>>()

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

          if (part.type === "tool" && part.tool === "edit" && part.state.status === "completed") {
            const input = part.state.input as Record<string, unknown>
            const file = String(input.filePath || input.file || input.path || part.state.title || "")
            if (file) {
              if (!sessionEditedFiles.has(sessionID)) sessionEditedFiles.set(sessionID, new Map())
              const files = sessionEditedFiles.get(sessionID)!
              const prev = files.get(file) || { additions: 0, deletions: 0, modifications: 0 }
              files.set(file, prev)
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
          if (!assistantText && !userText && (!editedFiles || editedFiles.size === 0)) return

          let text = `## ✅ 任务完成\n\n**${title}**\n\n`

          if (userText) {
            text += `💬 **我：**\n> ${userText}\n\n`
          }

          if (assistantText) {
            text += `🤖 **opencode：**\n${assistantText}\n\n`
          }

          if (editedFiles && editedFiles.size > 0) {
            text += `---\n\n📁 **变更文件：**\n`
            for (const [file] of editedFiles) {
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
          let text = `## ❌ 任务出错\n\n**${title}**\n\n`
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
  }
}

export default plugin