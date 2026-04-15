# 18game Task System MVP

## Run

```bash
cd /root/.openclaw/workspace/task_system
node server.js
```

Service default port: `8090`

Web UI: `http://127.0.0.1:8090/`

Security/network defaults:
- Default bind host: `127.0.0.1`
- Override (if needed): `TASK_BIND_HOST=0.0.0.0 node server.js`
- Public exposure requires reverse proxy + HTTPS

Dependency policy:
- Runtime uses Node built-in modules only (no third-party runtime deps)
- `package-lock.json` is included for reproducible project metadata/package-manager behavior

Default superadmin account:
- username: `admin`
- password: install-time generated random password (one-time display only)

Auth/account APIs:
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /admin/accounts` (superadmin)
- `POST /admin/accounts` (superadmin)
- `PATCH /admin/accounts/:username` (superadmin, reset/disable/bind tg)
- `GET /auth/resolve-tg?tgUsername=@xxx` (bot mapping)

## Test

Health:

```bash
curl http://127.0.0.1:8090/health
```

Create task (`X-User` = creator/responsible):

```bash
curl -X POST http://127.0.0.1:8090/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-User: @rock' \
  -d '{
    "name":"支付接口联调",
    "docLink":"https://example.com/doc/1",
    "requester":"@pm",
    "estimatedDevCycle":"3天",
    "estimatedTestTime":"1天",
    "expectedReleaseDate":"2026-03-20",
    "project":"18game"
  }'
```

Flow transfer with next responsible (keeps status=处理中):

```bash
curl -X POST http://127.0.0.1:8090/tasks/18G-1001/advance \
  -H 'Content-Type: application/json' \
  -H 'X-User: @rock' \
  -d '{"nextResponsible":"@alice", "note":"开发完成交给测试"}'
```

Complete task (if `nextResponsible` omitted):

```bash
curl -X POST http://127.0.0.1:8090/tasks/18G-1001/advance \
  -H 'Content-Type: application/json' \
  -H 'X-User: @rock' \
  -d '{"note":"最终完成"}'
```

Add remark (anyone can):

```bash
curl -X POST http://127.0.0.1:8090/tasks/18G-1001/remarks \
  -H 'Content-Type: application/json' \
  -H 'X-User: @anyone' \
  -d '{"content":"补充说明：已和产品确认"}'
```

List processing tasks:

```bash
curl 'http://127.0.0.1:8090/tasks?project=18game&status=处理中'
```

Daily processing summary:

```bash
curl 'http://127.0.0.1:8090/reports/daily?project=18game'
```

Data file: `task_system/data.json`

> Scheduler checks every 30s and prints daily summary at 10:00 (Asia/Shanghai).
> Server-side Telegram push is disabled by default to avoid duplicate sends with `bot.js`.
> If you really need server push, set `TASK_ENABLE_DAILY_PUSH=1` and provide `TG_BOT_TOKEN` + `TG_CHAT_ID`.

## Telegram Bot Command Layer

Run bot polling:

```bash
cd /root/.openclaw/workspace/task_system
TG_BOT_TOKEN=xxxxx TASK_API_BASE=http://127.0.0.1:8090 node bot.js
```

Supported commands in group:

- `新建任务 名称=... 文档=... 提出人=@... 开发周期=... 测试时间=... 上线日期=YYYY-MM-DD [项目=18game] [备注=...]`
- `流转任务 #18G-1001 给 @alice`
- `完成任务 #18G-1001`
- `添加备注 #18G-1001 备注内容`
- `查看进行中`
