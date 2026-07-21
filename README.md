# opencode-wecom-notify

opencode 企业微信通知插件 v1.0.5

## 安装

```bash
npm install opencode-wecom-notify
```

## 配置

在 `~/.config/opencode/opencode.json` 中添加：

```json
"plugin": ["opencode-wecom-notify"]
```

设置环境变量：

```bash
export OPENCODE_NOTIFY_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

Webhook URL 获取：企业微信 → 群聊 → 群机器人 → 添加机器人。

## 功能

| 通知类型 | 触发时机 | 说明 |
|---------|---------|------|
| ✅ 阶段完成 | session.idle | 包含用户消息和 AI 回复摘要（300字） |
| 🔐 需要授权 | permission.ask | 需要用户确认权限时通知 |
| ❌ 工具执行错误 | 工具返回 error 状态 | 失败的工具名称和错误信息 |
| ❌ 任务出错 | session.error | 会话级别的错误信息 |

所有通知均包含主机名和工作目录，60 秒内同类通知自动去重。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENCODE_NOTIFY_WECOM_WEBHOOK` | 是 | 企业微信群机器人 Webhook URL |
| `OPENCODE_NOTIFY_HOSTNAME` | 否 | 显示的主机名（默认系统 hostname） |
| `OPENCODE_NOTIFY_ENABLED` | 否 | 设为 `false` 可临时关闭插件 |

## 通知示例

```
✅ 阶段完成

**重构用户模块**
> 🖥 my-server | /home/user/project

💬 我：
> 测试插件是否正常工作

🤖 opencode：
已重构用户模块，修改了 service 层和 controller 层...

📁 变更文件：
- src/user/service.ts
- src/user/controller.ts

> 🕐 2026-07-21 20:00:00
```