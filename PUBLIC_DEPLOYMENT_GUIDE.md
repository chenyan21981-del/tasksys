# TaskSys 公网部署操作指引

> 适用场景：把 `tasksys` 任务管理系统部署到一台可公网访问的 Linux 服务器，并通过 `http://服务器IP:8090` 或后续反向代理域名访问 Web 管理台。

## 0. 安装前准备：服务器信息与账号

部署前请准备以下信息。**不要把密码、Token 明文发到群聊或聊天窗口**，建议只在服务器终端或安全密码管理器中使用。

| 项目 | 说明 | 示例 |
|---|---|---|
| 服务器公网 IP | 要部署的服务器外网 IP，用于 SSH 登录和浏览器访问 | `1.2.3.4` |
| SSH 账号 | 有部署权限的服务器账号，建议普通用户 + sudo 权限 | `root` 或 `ubuntu` |
| SSH 密码或密钥 | 用于登录服务器。优先使用 SSH key；如使用密码，请只在 SSH 客户端输入 | `~/.ssh/id_rsa` 或密码 |
| sudo 权限 | 安装 API systemd 服务需要 sudo/root 权限 | `sudo -v` 可验证 |
| Telegram Bot Token | 如需 Telegram Bot，准备 BotFather 生成的 Token | 不要写入文档/群聊 |
| 访问端口 | 默认 Web/API 端口 | `8090` |
| 部署目录 | 任务系统安装目录 | `/root/.openclaw/workspace/task_system` |

公网部署前建议确认：

```bash
ssh <账号>@<服务器公网IP>
```

登录后确认系统环境：

```bash
uname -a
node -v
npm -v || true
systemctl --version | head -1
sudo -v
```

如果服务器未安装 Node.js 18+，请先安装 Node.js 18 或更新版本。

## 1. 安全说明：公网部署的风险

公网部署会让服务从外部网络可访问，风险高于本机/局域网部署。建议至少做到：

1. 首次登录后立即修改 admin 初始密码；
2. 服务器安全组/防火墙只开放必要端口；
3. 生产环境优先使用 HTTPS + 反向代理；
4. Telegram Bot Token 只写入服务器本地 env 文件，不要提交到代码或发到群聊；
5. 如果只是测试，建议限制来源 IP，而不是完全开放全网访问。

## 2. 上传并解压 tasksys 包

在本地把最新版 skill 包上传到服务器：

```bash
scp tasksys-skill-latest-20260507T092420Z.zip <账号>@<服务器公网IP>:/tmp/
```

登录服务器：

```bash
ssh <账号>@<服务器公网IP>
```

解压：

```bash
cd /tmp
unzip tasksys-skill-latest-20260507T092420Z.zip
cd tasksys
```

如果服务器没有 `unzip`，可以用 Python 解压：

```bash
cd /tmp
python3 - <<'PY'
import zipfile
zipfile.ZipFile('tasksys-skill-latest-20260507T092420Z.zip').extractall('.')
PY
cd tasksys
```

## 3. 执行一键安装

默认安装：

```bash
bash scripts/install_tasksys.sh
```

或指定部署目录：

```bash
bash scripts/install_tasksys.sh /root/.openclaw/workspace/task_system
```

安装脚本会：

1. 复制 API/Bot/Web 模板到目标目录；
2. 首次初始化时创建 `data.json`；
3. 生成随机强 admin 初始密码，仅保存 PBKDF2 hash；
4. 创建 Bot 环境文件：`~/.openclaw/task-system-bot.env`；
5. 安装并启动 user service：`task-system-bot.service`；
6. 生成 API systemd 草案：`/tmp/task-system-api.service`，不会自动 sudo 安装。

请记录安装脚本首次输出的：

- 管理地址；
- admin 用户名；
- 一次性初始密码。

> 注意：一次性初始密码通常只在首次初始化时输出。首次登录后请立即修改。

## 4. 配置公网监听

默认情况下，API 只绑定本机 `127.0.0.1:8090`。公网部署需要把 API 绑定到 `0.0.0.0`，并显式允许公网绑定。

先查看脚本生成的 API service 草案：

```bash
cat /tmp/task-system-api.service
```

编辑草案：

```bash
nano /tmp/task-system-api.service
```

在 `[Service]` 段增加或确认以下环境变量：

```ini
Environment=TASK_BIND_HOST=0.0.0.0
Environment=TASK_ALLOW_PUBLIC_BIND=1
Environment=PORT=8090
```

如果 service 已经有 `Environment=TASK_BIND_HOST=127.0.0.1`，请改成：

```ini
Environment=TASK_BIND_HOST=0.0.0.0
```

## 5. 安装并启动 API systemd 服务

确认 service 草案无误后安装：

```bash
sudo mv /tmp/task-system-api.service /etc/systemd/system/task-system-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now task-system-api.service
sudo systemctl status task-system-api.service --no-pager
```

验证本机访问：

```bash
curl -fsS http://127.0.0.1:8090/health
curl -fsS http://127.0.0.1:8090/ -o /tmp/tasksys-index-check.html
```

验证监听地址：

```bash
ss -ltnp | grep ':8090'
```

期望看到类似：

```text
LISTEN 0 511 0.0.0.0:8090 0.0.0.0:* users:(("node",pid=...,fd=...))
```

如果仍是 `127.0.0.1:8090`，公网无法访问，需要回到第 4 步检查 `TASK_BIND_HOST` 和 `TASK_ALLOW_PUBLIC_BIND`。

## 6. 配置防火墙/云安全组

### 6.1 服务器本机防火墙

如果使用 UFW：

```bash
sudo ufw status
sudo ufw allow 8090/tcp
sudo ufw reload
```

如果使用 iptables/nftables，请确认 `8090/tcp` 允许入站。

### 6.2 云厂商安全组

在云厂商控制台开放入站规则：

```text
协议：TCP
端口：8090
来源：建议先限制为你的办公/测试 IP；测试通过后再决定是否开放 0.0.0.0/0
```

## 7. 浏览器访问验证

在本地浏览器访问：

```text
http://<服务器公网IP>:8090
```

例如：

```text
http://1.2.3.4:8090
```

登录信息：

- 用户名：安装脚本输出的 admin 用户名；
- 密码：安装脚本首次初始化时输出的一次性初始密码。

登录后立即修改密码。

## 8. 配置 Telegram Bot

编辑服务器上的 Bot env 文件：

```bash
nano ~/.openclaw/task-system-bot.env
```

设置：

```bash
TG_TASK_BOT_TOKEN=<你的BotToken>
TASK_API_BASE=http://127.0.0.1:8090
```

说明：Bot 和 API 在同一台服务器上时，`TASK_API_BASE` 建议继续用 `127.0.0.1`，不必让 Bot 走公网 IP。

重启 Bot：

```bash
systemctl --user restart task-system-bot.service
systemctl --user status task-system-bot.service --no-pager
```

查看日志：

```bash
journalctl --user -u task-system-bot.service -n 100 --no-pager
```

## 9. 可选：使用 HTTPS 和反向代理

生产环境建议不要直接暴露 `:8090`，而是使用 Nginx/Caddy 做 HTTPS 反向代理。

示例 Nginx 反代片段：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置 HTTPS 后，建议关闭云安全组中直接暴露的 `8090`，只开放 `80/443`。

## 10. 验证清单

完成部署后逐项检查：

```bash
systemctl is-active task-system-api.service
systemctl --user is-active task-system-bot.service
curl -fsS http://127.0.0.1:8090/health
ss -ltnp | grep ':8090'
```

浏览器检查：

```text
http://<服务器公网IP>:8090
```

应确认：

- API service 为 active；
- Bot service 为 active；
- `health` 返回正常；
- `ss` 显示 `0.0.0.0:8090` 或服务器公网网卡 IP；
- 浏览器可打开管理台；
- admin 可登录；
- 已修改初始密码。

## 11. 常见问题

### 11.1 本机 curl 正常，但公网打不开

检查三点：

```bash
ss -ltnp | grep ':8090'
sudo ufw status
curl -fsS http://127.0.0.1:8090/health
```

如果 `ss` 显示 `127.0.0.1:8090`，说明没有公网监听，回到第 4 步。

如果 `ss` 显示 `0.0.0.0:8090`，但公网仍打不开，重点检查云安全组和服务器防火墙。

### 11.2 API 启动失败

查看日志：

```bash
sudo journalctl -u task-system-api.service -n 100 --no-pager
```

常见原因：

- `TASK_ALLOW_PUBLIC_BIND=1` 未设置；
- `8090` 端口被占用；
- Node.js 版本过低；
- 部署目录权限不正确。

### 11.3 忘记 admin 初始密码

如果已经初始化过，安装脚本不会再次输出旧密码。建议通过系统内置账号管理能力重置，或在确认备份后由管理员执行数据修复。不要直接修改 hash，除非明确知道当前版本的数据结构。

## 12. 最终交付信息模板

部署完成后，建议记录以下信息：

```text
系统地址：http://<服务器公网IP>:8090
服务器IP：<服务器公网IP>
部署目录：/root/.openclaw/workspace/task_system
API服务：task-system-api.service active
Bot服务：task-system-bot.service active
admin用户名：<安装输出>
初始密码：已交付给负责人，首次登录后需修改
公网访问验证：通过/未通过
HTTPS反代：已配置/未配置
```
