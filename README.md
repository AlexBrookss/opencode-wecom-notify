# opencode-wecom-notify

opencode 企业微信通知插件。任务完成后自动推送通知到企业微信群。

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
export WECOM_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

Webhook URL 获取：企业微信 → 群聊 → 群机器人 → 添加机器人。

## 推送内容

- 💬 用户消息
- 🤖 AI 回复
- 📁 变更文件列表
- 🕐 完成时间