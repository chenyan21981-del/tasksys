# TaskSys 安装引导（最新版）

> 版本基线：`v1.0.0`  
> 适用内容：`task_system/server.js` + `task_system/bot.js` + `task_system/public/index.html`

## 1. 环境要求

- Linux 服务器（推荐 Ubuntu 22.04+）
- Node.js 20+（当前环境建议 Node 22）
- 可访问 Telegram Bot API（若需启用机器人）

## 2. 获取代码

```bash
git clone https://github.com/chenyan21981-del/tasksys.git
cd tasksys
```

## 3. 配置环境变量

先复制模板：

```bash
cp .env.example .env
```

按需编辑 `.env`（至少关注以下变量）：

- `PORT`：默认 8090
- `TASK_BIND_HOST`：默认建议 `127.0.0.1`（内网/本机访问更安全）
- `TASK_ADMIN_BOOTSTRAP_PASSWORD`：建议设置一次性强密码
- `TG_TASK_BOT_TOKEN`：启用机器人时必填
- `TASK_API_BASE`：机器人访问 API 地址（例如 `http://127.0.0.1:8090`）

## 4. 启动 Web/API 服务

```bash
cd task_system
npm install
node server.js
```

健康检查：

```bash
curl http://127.0.0.1:8090/health
```

浏览器访问：

- 本机：`http://127.0.0.1:8090/`
- 局域网：`http://<服务器IP>:8090/`（前提是你把 `TASK_BIND_HOST` 改为 `0.0.0.0`）

## 5. 启动 Telegram Bot（可选）

新开终端：

```bash
cd task_system
TG_TASK_BOT_TOKEN=你的token TASK_API_BASE=http://127.0.0.1:8090 node bot.js
```

建议生产环境使用 `systemd --user` 或 PM2 守护 bot。

## 6. 首次登录与安全动作

- 默认管理员账号：`admin`
- 若设置了 `TASK_ADMIN_BOOTSTRAP_PASSWORD`，用该密码登录
- 首次登录后立即修改管理员密码
- 生产环境请在反向代理层加 HTTPS + 访问控制

## 7. 常见问题

### Q1: 页面能打开但登录失败
- 检查 `.env` 是否生效
- 检查 `task_system/data.json` 或 `data.sqlite3` 初始化状态

### Q2: Bot 没反应
- 检查 `TG_TASK_BOT_TOKEN` 是否正确
- 确认没有重复启动多个 bot 进程（bot 有锁文件机制）

### Q3: 外网访问风险
- 不建议裸露 8090 到公网
- 推荐：Nginx/Caddy + HTTPS + IP 白名单 + 认证
