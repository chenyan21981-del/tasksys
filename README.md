# tasksys

18game Task Management System source code (API + Telegram bot + Web UI).

## Security-first defaults

- No plaintext default admin password in code
- Password hashing (PBKDF2)
- Login lockout / throttling
- Session token with expiration
- Default bind host is `127.0.0.1`

## Quick start

```bash
cp .env.example .env
# edit .env with strong password and bot token if needed
cd task_system
npm install
node server.js
```

Open: `http://127.0.0.1:8090/`

## Repo policy

This repo contains **code only**. It does not include:

- databases (`*.sqlite3`, `*.db`)
- runtime exports/backups
- secrets (`.env`, keys, tokens)
