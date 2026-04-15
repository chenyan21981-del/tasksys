const fs = require('fs');
const path = require('path');

const TG_BOT_TOKEN = process.env.TG_TASK_BOT_TOKEN || process.env.TG_BOT_TOKEN;
const API_BASE = process.env.TASK_API_BASE || 'http://127.0.0.1:8090';
const PROJECT_DEFAULT = '18game';
const STATE_PATH = process.env.TASK_BOT_STATE_PATH || '/root/.openclaw/task-system-bot-state.json';
const DEFAULT_GROUP_ID = process.env.TASK_TG_GROUP_ID || '';
const CONFIG_GROUP_IDS = (process.env.TASK_TG_GROUP_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
if (!TG_BOT_TOKEN) {
  console.error('Missing TG_TASK_BOT_TOKEN/TG_BOT_TOKEN');
  process.exit(1);
}

const BOT_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;
const LOCK_PATH = process.env.TASK_BOT_LOCK_PATH || '/tmp/task-system-bot.lock';
let lockFd = null;
let offset = 0;

function acquireSingletonLock() {
  try {
    lockFd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(lockFd, String(process.pid));
    return true;
  } catch {
    try {
      const oldPid = Number(fs.readFileSync(LOCK_PATH, 'utf-8').trim());
      if (oldPid && Number.isFinite(oldPid)) {
        process.kill(oldPid, 0);
        console.error(`Another bot instance is running (pid=${oldPid}), exit.`);
        return false;
      }
    } catch {
      // stale lock or unreadable lock, continue to recreate
    }

    try { fs.unlinkSync(LOCK_PATH); } catch {}
    try {
      lockFd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeFileSync(lockFd, String(process.pid));
      return true;
    } catch {
      console.error('Failed to acquire singleton lock, exit.');
      return false;
    }
  }
}

function releaseSingletonLock() {
  try { if (lockFd) fs.closeSync(lockFd); } catch {}
  try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch {}
}

if (!acquireSingletonLock()) process.exit(1);
process.on('exit', releaseSingletonLock);
process.on('SIGINT', () => { releaseSingletonLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseSingletonLock(); process.exit(0); });

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { groups: {}, lastReminderDate: '', lastMainReminderDate: '', dueSoonNotified: {}, mainDueSoonNotified: {} };
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      groups: parsed.groups || {},
      lastReminderDate: parsed.lastReminderDate || '',
      lastMainReminderDate: parsed.lastMainReminderDate || '',
      dueSoonNotified: parsed.dueSoonNotified || {},
      mainDueSoonNotified: parsed.mainDueSoonNotified || {}
    };
  } catch {
    return { groups: {}, lastReminderDate: '', lastMainReminderDate: '', dueSoonNotified: {}, mainDueSoonNotified: {} };
  }
}

function saveState() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const state = loadState();
const seedGroupIds = new Set([DEFAULT_GROUP_ID, ...CONFIG_GROUP_IDS].filter(Boolean).map(String));
let seeded = false;
for (const groupId of seedGroupIds) {
  if (!state.groups[groupId]) {
    state.groups[groupId] = { title: '', type: 'supergroup', updatedAt: new Date().toISOString() };
    seeded = true;
  }
}
if (seeded) saveState();

function trackGroup(chat) {
  const chatId = String(chat.id);
  state.groups[chatId] = {
    title: chat.title || state.groups[chatId]?.title || '',
    type: chat.type || state.groups[chatId]?.type || 'group',
    updatedAt: new Date().toISOString()
  };
  saveState();
}

function nowInBeijing() {
  const now = new Date();
  const bjText = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
  const [datePart, timePart] = bjText.split(' ');
  const [hourStr, minuteStr] = timePart.split(':');
  const weekDayText = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
  return { datePart, hour: Number(hourStr), minute: Number(minuteStr), weekDayText };
}


function parseShanghaiLocalToEpoch(v) {
  if (!v) return NaN;
  const s = String(v).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const withSec = s.length === 16 ? `${s}:00` : s;
    return Date.parse(`${withSec}+08:00`);
  }
  return Date.parse(s);
}

function parseHm(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

function parseSilentRange(text) {
  const m = String(text || '').match(/(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  const a = parseHm(m[1]);
  const b = parseHm(m[2]);
  if (!a || !b) return null;
  return { startMin: minuteOfDay(a.h, a.m), endMin: minuteOfDay(b.h, b.m), startLabel: m[1], endLabel: m[2] };
}


function cnWeekdayToIndex(ch) {
  const map = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  return map[ch];
}




async function sendDailyReminderToGroups() {
  const ret = await api(`/subtasks?project=${PROJECT_DEFAULT}&activeOnly=1`);
  if (!Array.isArray(ret)) return;

  const nowTs = Date.now();
  const overdue = ret.filter(s => {
    const dueTs = parseShanghaiLocalToEpoch(s.dueAt);
    return Number.isFinite(dueTs) && dueTs < nowTs;
  });

  const total = ret.length;
  const lines = [
    `⏰ 每日子任务提醒（北京时间10:00）`,
    `进行中子任务(${PROJECT_DEFAULT})：${total}`,
    ''
  ];

  lines.push(`🚨 逾期子任务（${overdue.length}）`);
  if (overdue.length) {
    overdue.slice(0, 20).forEach(s => {
      lines.push(`- #${s.id}｜${s.title || '-'}｜主任务:${s.taskNo || '-'}｜负责人:${s.assignee || '-'}｜到期:${fmtTime(s.dueAt)}`);
    });
    if (overdue.length > 20) lines.push(`… 其余 ${overdue.length - 20} 条逾期子任务请在系统中查看。`);
  } else {
    lines.push('- 无');
  }
  lines.push('');

  lines.push(`📌 子任务明细（最多20条）`);
  ret.slice(0, 20).forEach(s => {
    lines.push(
      [
        `子任务ID: #${s.id}`,
        `标题: ${s.title || '-'}`,
        `主任务: ${s.taskNo || '-'}`,
        `负责人: ${s.assignee || '-'}`,
        `状态: ${s.status || '-'}`,
        `到期: ${fmtTime(s.dueAt)}`
      ].join('\n')
    );
    lines.push('');
  });

  if (total > 20) lines.push(`… 其余 ${total - 20} 条请用 /task 查看。`);

  const text = lines.join('\n').trim();
  for (const chatId of Object.keys(state.groups)) {
    await tg('sendMessage', { chat_id: Number(chatId), text, disable_web_page_preview: true });
  }
}

function startDailyReminderLoop() {
  setInterval(async () => {
    try {
      const { datePart, hour, minute, weekDayText } = nowInBeijing();
      if (hour === 10 && minute < 2 && state.lastReminderDate !== datePart) {
        await sendDailyReminderToGroups();
        state.lastReminderDate = datePart;
        saveState();
      }
    } catch (e) {
      console.error('daily reminder error:', e.message);
    }
  }, 30 * 1000);
}

// ── 子任务提醒：到期前 6 小时逐条发群提醒 ──────────────────────────────
function startSubtaskDueSoonLoop() {
  const WINDOW_MS = 6 * 3600 * 1000;
  const KEEP_MS = 7 * 24 * 3600 * 1000;

  setInterval(async () => {
    try {
      const nowTs = Date.now();
      const chatIds = Object.keys(state.groups);
      if (!chatIds.length) return;

      const ret = await api(`/subtasks?activeOnly=1`);
      if (!Array.isArray(ret)) return;

      let changed = false;
      for (const s of ret) {
        if (!s.dueAt) continue;
        const dueTs = parseShanghaiLocalToEpoch(s.dueAt);
        if (!Number.isFinite(dueTs)) continue;
        const left = dueTs - nowTs;
        if (left <= 0 || left > WINDOW_MS) continue;

        const key = `subtask|${s.id}|${s.dueAt}`;
        if (state.dueSoonNotified[key]) continue;

        const assignee = s.assignee || '@unknown';
        const text = [
          '⏳ 子任务即将到期（6小时内）',
          `子任务: #${s.id} ${s.title || '-'}`,
          `主任务: ${s.taskNo || '-'}`,
          `负责人: ${assignee}`,
          `到期时间: ${fmtTime(s.dueAt)}`,
          `${assignee} 请及时处理。`
        ].join('\n');

        let delivered = 0;
        for (const chatId of chatIds) {
          try {
            await tg('sendMessage', { chat_id: Number(chatId), text, disable_web_page_preview: true });
            delivered += 1;
          } catch (err) {
            const msg = String(err?.message || err || '');
            // 无效群直接从订阅列表移除，避免每分钟重试导致重复提醒
            if (/chat not found|bot was kicked|forbidden|not enough rights/i.test(msg)) {
              delete state.groups[String(chatId)];
              changed = true;
            }
            console.error(`subtask due soon send failed chat=${chatId}:`, msg);
          }
        }

        // 至少成功投递到一个群才记为已提醒，避免全量失败时静默丢提醒
        if (delivered > 0) {
          state.dueSoonNotified[key] = nowTs;
          changed = true;
        }
      }

      // 清理过期的已通知记录
      for (const [k, ts] of Object.entries(state.dueSoonNotified || {})) {
        if (!Number.isFinite(Number(ts)) || nowTs - Number(ts) > KEEP_MS) {
          delete state.dueSoonNotified[k];
          changed = true;
        }
      }

      if (changed) saveState();
    } catch (e) {
      console.error('subtask due soon reminder error:', e.message);
    }
  }, 60 * 1000);
}

// ── 主任务提醒：每周一和周五各发一次，提醒1天内到期的主任务 ────────────────
function startMainTaskWeeklyReminderLoop() {
  const KEEP_MS = 8 * 24 * 3600 * 1000;

  if (!state.mainTaskNotified) state.mainTaskNotified = {};

  setInterval(async () => {
    try {
      const { datePart, hour, minute, weekDayText } = nowInBeijing();
      const isReminderDay = weekDayText === 'Mon' || weekDayText === 'Fri';
      // 每周一/周五 09:30 触发
      if (!isReminderDay || hour !== 9 || minute > 1) return;

      const fireKey = `mainWeekly|${datePart}`;
      if (state.mainTaskNotified[fireKey]) return;

      const chatIds = Object.keys(state.groups);
      if (!chatIds.length) return;

      const nowTs = Date.now();
      const ret = await api(`/tasks?project=${PROJECT_DEFAULT}&status=${encodeURIComponent('处理中')}`);
      if (!Array.isArray(ret)) return;

      const overdue = ret.filter(t => {
        const dueTs = parseShanghaiLocalToEpoch(t.dueAt);
        return Number.isFinite(dueTs) && dueTs < nowTs;
      });

      const dayLabel = weekDayText === 'Mon' ? '（周一）' : '（周五）';
      const lines = [
        `📋 主任务明细提醒 ${dayLabel}`,
        `进行中主任务(${PROJECT_DEFAULT})：${ret.length}`,
        ''
      ];

      lines.push(`🚨 逾期主任务（${overdue.length}）`);
      if (overdue.length) {
        overdue.slice(0, 20).forEach(t => {
          lines.push(`- ${t.taskNo}｜${t.name || '-'}｜负责人:${t.currentResponsible || t.executor || '-'}｜到期:${fmtTime(t.dueAt)}`);
        });
        if (overdue.length > 20) lines.push(`… 其余 ${overdue.length - 20} 条逾期主任务请在系统中查看。`);
      } else {
        lines.push('- 无');
      }
      lines.push('');

      lines.push('📌 主任务明细（最多20条）');
      ret.slice(0, 20).forEach(t => {
        lines.push(
          [
            `任务号: ${t.taskNo}`,
            `名称: ${t.name || '-'}`,
            `负责人: ${t.currentResponsible || t.executor || '-'}`,
            `状态: ${t.status || '-'}`,
            `到期: ${fmtTime(t.dueAt)}`,
            `预计上线: ${t.expectedReleaseDate || '-'}`
          ].join('\n')
        );
        lines.push('');
      });
      if (ret.length > 20) lines.push(`… 其余 ${ret.length - 20} 条请用 /task 查看。`);

      const text = lines.join('\n').trim();
      for (const chatId of chatIds) {
        await tg('sendMessage', { chat_id: Number(chatId), text, disable_web_page_preview: true });
      }

      state.mainTaskNotified[fireKey] = nowTs;
      for (const [k, ts] of Object.entries(state.mainTaskNotified || {})) {
        if (!Number.isFinite(Number(ts)) || nowTs - Number(ts) > KEEP_MS) delete state.mainTaskNotified[k];
      }
      saveState();
    } catch (e) {
      console.error('main task weekly reminder error:', e.message);
    }
  }, 30 * 1000);
}




async function tg(method, body = {}) {
  const r = await fetch(`${BOT_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok || !data?.ok) {
    const detail = data?.description || `${r.status} ${r.statusText}`;
    throw new Error(`Telegram API ${method} failed: ${detail}`);
  }
  return data;
}

async function sendTextInChunks(chatId, text, replyToMessageId, extra = {}) {
  const MAX = 3500;
  const raw = String(text || '').trim();
  if (!raw) return;

  if (raw.length <= MAX) {
    await tg('sendMessage', { chat_id: chatId, text: raw, reply_to_message_id: replyToMessageId, ...extra });
    return;
  }

  let buf = '';
  const blocks = raw.split('\n\n');
  let first = true;
  for (const b of blocks) {
    const piece = (buf ? '\n\n' : '') + b;
    if ((buf + piece).length > MAX) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: buf,
        reply_to_message_id: first ? replyToMessageId : undefined,
        ...extra
      });
      first = false;
      buf = b;
      if (buf.length > MAX) {
        for (let i = 0; i < buf.length; i += MAX) {
          const part = buf.slice(i, i + MAX);
          await tg('sendMessage', {
            chat_id: chatId,
            text: part,
            reply_to_message_id: first ? replyToMessageId : undefined,
            ...extra
          });
          first = false;
        }
        buf = '';
      }
    } else {
      buf += piece;
    }
  }

  if (buf) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: buf,
      reply_to_message_id: first ? replyToMessageId : undefined,
      ...extra
    });
  }
}

function extractUrlFromMarkdown(v='') {
  const m = String(v).match(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
  if (m) return m[1];
  return v;
}

function fmtTime(v) {
  if (!v) return '-';
  return String(v).replace('T', ' ');
}

function normalizeCreateText(text) {
  const knownKeys = [
    // 主任务
    '名称', '文档', '文档链接', '提出人', '任务处理人', '抄送给', '完成周期', '预计上线日期', '上线日期', '项目', '备注',
    'name', 'doc', 'docLink', 'requester', 'executor', 'ccList', 'completedCycle', 'expectedReleaseDate', 'project', 'note',
    // 子任务
    '标题', '负责人', '周期', '开始时间', '结束时间', '子任务描述', '描述', '抄送', '关注人', '校验', '依赖', '优先级', '状态',
    'title', 'assignee', 'expectedCycle', 'receivedAt', 'dueAt', 'endTime', 'description', 'watchers', 'needDependencyCheck', 'dependsOn', 'priority', 'status'
  ];

  let out = text.replace(/，/g, '\n').replace(/：/g, ':');
  for (const k of knownKeys) {
    const re = new RegExp(`\\s*${k}=`, 'g');
    out = out.replace(re, `\n${k}=`);
  }
  return out;
}

function parseKV(text) {
  const out = {};
  const normalized = normalizeCreateText(text);
  const lines = normalized.split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

async function api(path, method = 'GET', body, user = '@unknown') {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-User': user
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

async function resolveTaskUser(tgUsername) {
  try {
    const r = await fetch(`${API_BASE}/auth/resolve-tg?tgUsername=${encodeURIComponent(tgUsername)}`);
    const j = await r.json();
    if (j && j.username) {
      return { actor: j.username, role: j.role || 'member', tgUsername: j.tgUsername || tgUsername, bound: true };
    }
    return { actor: tgUsername, role: 'member', tgUsername, bound: false };
  } catch {
    return { actor: tgUsername, role: 'member', tgUsername, bound: false };
  }
}

async function handleMessage(msg) {
  const chatId = Number(msg.chat.id);
  const chatType = String(msg.chat?.type || '');
  let text = (msg.text || '').trim();
  if (!text) return;

  const isGroupChat = chatType === 'group' || chatType === 'supergroup';
  const isPrivateChat = chatType === 'private';

  // Allow task commands in group and private chats only.
  if (!isGroupChat && !isPrivateChat) {
    await tg('sendMessage', { chat_id: chatId, text: '无权限', reply_to_message_id: msg.message_id });
    return;
  }

  if (isGroupChat) trackGroup(msg.chat);

  // Hard gate: only /task and /help commands are allowed
  const isTaskCmd = /^\/task(?:@\w+)?/i.test(text);
  const isHelpCmd = /^\/help(?:@\w+)?/i.test(text);
  if (!isTaskCmd && !isHelpCmd) {
    await tg('sendMessage', { chat_id: chatId, text: '无权限', reply_to_message_id: msg.message_id });
    return;
  }

  if (isHelpCmd) {
    const helpText = [
      '📘 task bot 可用命令',
      '',
      '1) /task 查看进行中',
      '2) /task 历史任务',
      '3) /task 完成任务 #18G-1001',
      '4) /task 新增子任务 #18G-1001 标题=联调 负责人=@alice 开始时间=2026-03-30 16:30 结束时间=2026-03-31 18:00 子任务描述=联调范围 抄送=@bob 备注=可选 校验=是 依赖=12,13',
      '5) /task 启动子任务 #12',
      '6) /task 完成子任务 #12',
      '7) /task 取消子任务 #12 原因=需求变更',
      '8) /task 强制关闭 #18G-1001 原因=紧急上线',
      '9) /task 添加备注 #18G-1001 这里是备注内容',
      '10) /task 创建主任务 名称=... 类型=新需求|bug修复|优化 文档=https://... 提出人=@xxx 抄送=@a,@b 开始时间=2026-03-13 10:00 结束时间=2026-03-15 18:00 项目=18game',
      '11) /task 任务详情 #18G-1001',
      '12) /task 删除子任务 #12（仅管理员）',
      '13) /task 删除主任务 #18G-1001（仅管理员）',
      '',
      '说明：仅支持 /task 与 /help，其他指令一律无权限。'
    ].join('\n');
    await tg('sendMessage', { chat_id: chatId, text: helpText, reply_to_message_id: msg.message_id });
    return;
  }

  // strip "/task" prefix and keep original command body for existing handlers
  text = text.replace(/^\/task(?:@\w+)?\s*/i, '').trim();
  if (!text) {
    text = '查看进行中';
  }

  const username = msg.from?.username ? `@${msg.from.username}` : `tg_${msg.from?.id}`;
  const identity = await resolveTaskUser(username);
  if (isPrivateChat && !identity.bound) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '无权限：私聊仅限已绑定账号用户。请先在系统中绑定你的 TG 账号。',
      reply_to_message_id: msg.message_id
    });
    return;
  }
  const actor = identity.actor;
  const isAdmin = identity.role === 'superadmin' || identity.role === 'admin';



  if (text.includes('新建任务') || text.includes('创建任务') || text.includes('创建主任务')) {
    const kv = parseKV(text);
    const payload = {
      name: kv['名称'] || kv['name'],
      docLink: extractUrlFromMarkdown(kv['文档'] || kv['doc'] || kv['文档链接'] || kv['docLink']),
      requester: kv['提出人'] || kv['requester'] || username,
      ccList: kv['抄送给'] || kv['抄送'] || kv['ccList'] || '',
      startTime: kv['开始时间'] || kv['startTime'],
      endTime: kv['结束时间'] || kv['endTime'],
      project: kv['项目'] || kv['project'] || PROJECT_DEFAULT,
      taskType: kv['类型'] || kv['taskType'] || '新需求',
      note: kv['备注'] || kv['note'] || undefined
    };

    const missing = [];
    if (!payload.name) missing.push('名称');
    if (!payload.docLink) missing.push('文档');
    if (!payload.requester) missing.push('提出人');
    if (!payload.startTime) missing.push('开始时间');
    if (!payload.endTime) missing.push('结束时间');

    if (missing.length > 0) {
      const tpl = [
        '🧩 创建主任务模板（每个参数一行）',
        '@agentfriend_bot 创建主任务',
        '名称=联调测试',
        '类型=新需求（可选：新需求/bug修复/优化）',
        '文档=https://example.com',
        `提出人=${username}`,
        '抄送给=@alice,@bob（可多人，逗号分隔）',
        '开始时间=2026-03-13 10:00',
        '结束时间=2026-03-15 18:00',
        `项目=${PROJECT_DEFAULT}`,
        '备注=可选',
        '',
        `缺少字段：${missing.join('、')}`
      ].join('\n');
      await tg('sendMessage', { chat_id: chatId, text: tpl, reply_to_message_id: msg.message_id });
      return;
    }

    if (!['新需求', 'bug修复', '优化'].includes(payload.taskType)) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ 类型仅支持：新需求 / bug修复 / 优化', reply_to_message_id: msg.message_id });
      return;
    }

    const ret = await api('/tasks', 'POST', payload, actor);
    const txt = ret.ok
      ? `✅ 主任务已创建 ${ret.taskNo}\n名称: ${payload.name}\n类型: ${payload.taskType}\n文档: ${payload.docLink}\n提出人: ${payload.requester}\n抄送人: ${payload.ccList || '-'}\n开始时间: ${fmtTime(payload.startTime)}\n结束时间: ${fmtTime(payload.endTime)}\n周期(自动): ${ret.completedCycle || '-'}\n项目: ${payload.project}\n\n👉 请分配子任务（示例）\n/task 新增子任务 #${ret.taskNo} 标题=联调 负责人=@alice 开始时间=2026-03-30 16:30 结束时间=2026-03-31 18:00 子任务描述=联调范围 抄送=@bob 备注=可选 校验=是 依赖=12,13`
      : `❌ 创建失败: ${ret.error || ret.detail || '参数不完整'}`;
    await tg('sendMessage', { chat_id: chatId, text: txt, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('新增子任务')) {
    const m = text.match(/#([A-Za-z0-9-]+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带任务号，如 #18G-1001', reply_to_message_id: msg.message_id });
    const kv = parseKV(text);
    const title = kv['标题'] || kv['title'] || kv['名称'] || kv['name'];
    const assignee = kv['负责人'] || kv['assignee'];
    const receivedAt = (kv['开始时间'] || kv['receivedAt'] || kv['startTime'] || '').trim();
    const dueAt = (kv['结束时间'] || kv['dueAt'] || kv['endTime'] || '').trim();
    const depCheck = (kv['校验'] || kv['needDependencyCheck'] || '否').trim();
    const depRaw = (kv['依赖'] || kv['dependsOn'] || '').trim();
    if (!title || !assignee || !receivedAt || !dueAt) {
      return tg('sendMessage', { chat_id: chatId, text: '格式: /task 新增子任务 #18G-1001 标题=联调 负责人=@alice 开始时间=2026-03-30 16:30 结束时间=2026-03-31 18:00 子任务描述=联调范围 抄送=@bob 备注=可选 校验=是 依赖=12,13\n说明: 标题、负责人、开始时间、结束时间必填；周期由系统自动计算。', reply_to_message_id: msg.message_id });
    }
    const dependsOn = depRaw ? depRaw.split(/[，,\s]+/).map(x => Number(x)).filter(Boolean) : [];
    const watchers = (kv['关注人'] || kv['抄送'] || kv['watchers'] || kv['ccList'] || '').trim();
    const ret = await api(`/tasks/${m[1]}/subtasks`, 'POST', {
      title,
      assignee,
      description: kv['子任务描述'] || kv['描述'] || kv['description'] || '',
      priority: kv['优先级'] || kv['priority'] || 'P2',
      receivedAt,
      dueAt,
      watchers: watchers ? watchers.split(/[，,\s]+/).filter(Boolean) : [],
      note: kv['备注'] || kv['note'] || '',
      needDependencyCheck: depCheck === '是',
      dependsOn
    }, actor);
    const txt = ret.ok ? `✅ 已新增子任务 #${ret.subtask.id}\n任务: ${m[1]}\n标题: ${ret.subtask.title}\n负责人: ${ret.subtask.assignee}\n开始: ${fmtTime(ret.subtask.receivedAt)}\n结束: ${fmtTime(ret.subtask.dueAt)}\n周期(自动): ${ret.subtask.expectedCycle || '-'}\n状态(后台): ${ret.subtask.status}` : `❌ ${ret.error || ret.detail}`;
    await tg('sendMessage', { chat_id: chatId, text: txt, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('启动子任务')) {
    const m = text.match(/#(\d+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带子任务ID，如 #12', reply_to_message_id: msg.message_id });
    const ret = await api(`/subtasks/${m[1]}/start`, 'POST', {}, actor);
    await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 子任务 #${m[1]} 已启动` : `❌ ${ret.error || ret.detail}`, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('完成子任务')) {
    const m = text.match(/#(\d+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带子任务ID，如 #12', reply_to_message_id: msg.message_id });
    const ret = await api(`/subtasks/${m[1]}/complete`, 'POST', {}, actor);
    await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 子任务 #${m[1]} 已完成` : `❌ ${ret.error || ret.detail}`, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('取消子任务')) {
    const m = text.match(/#(\d+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带子任务ID，如 #12', reply_to_message_id: msg.message_id });
    const kv = parseKV(text);
    const reason = kv['原因'] || kv['reason'] || 'TG取消';
    const ret = await api(`/subtasks/${m[1]}/cancel`, 'POST', { reason }, actor);
    await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 子任务 #${m[1]} 已取消` : `❌ ${ret.error || ret.detail}`, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('删除子任务')) {
    if (!isAdmin) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ 仅管理员可删除子任务', reply_to_message_id: msg.message_id });
      return;
    }
    const m = text.match(/#(\d+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带子任务ID，如 #12', reply_to_message_id: msg.message_id });
    const ret = await api(`/subtasks/${m[1]}/delete`, 'POST', {}, actor);
    await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 已删除子任务 #${m[1]}` : `❌ ${ret.error || ret.detail}`, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('删除主任务')) {
    if (!isAdmin) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ 仅管理员可删除主任务', reply_to_message_id: msg.message_id });
      return;
    }
    const m = text.match(/#([A-Za-z0-9-]+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带任务号，如 #18G-1001', reply_to_message_id: msg.message_id });
    const ret = await api(`/tasks/${m[1]}/delete`, 'POST', {}, actor);
    await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 已删除主任务 ${m[1]}（连带删除子任务 ${ret.deletedSubtaskCount || 0} 条）` : `❌ ${ret.error || ret.detail}`, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('强制关闭')) {
    const m = text.match(/#([A-Za-z0-9-]+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带任务号，如 #18G-1001', reply_to_message_id: msg.message_id });
    const kv = parseKV(text);
    const reason = kv['原因'] || kv['reason'];
    if (!reason) return tg('sendMessage', { chat_id: chatId, text: '必须填写原因，如：/task 强制关闭 #18G-1001 原因=紧急上线', reply_to_message_id: msg.message_id });
    const ret = await api(`/tasks/${m[1]}/force-close`, 'POST', { reason }, actor);
    await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 任务 ${m[1]} 已强制关闭` : `❌ ${ret.error || ret.detail}`, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('完成任务')) {
    const m = text.match(/#([A-Za-z0-9-]+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带任务号，如 #18G-1001', reply_to_message_id: msg.message_id });
    const kv = parseKV(text);
    const stepCycle = kv['完成周期'] || kv['completedCycle'] || kv['步骤完成周期'] || kv['flowCompletedCycle'];
    const ret = await api(`/tasks/${m[1]}/advance`, 'POST', { note: 'TG指令完成', completedCycle: stepCycle || undefined }, actor);
    const stepState = ret.stepCompletionStatus === 'delayed' ? '延期完成' : (ret.stepCompletionStatus === 'on_time' ? '按期完成' : '完成');
    const txt = ret.ok ? `✅ ${m[1]} 已完成${ret.isDelayed ? '（延期）' : ''}\n本步骤状态: ${stepState}\n本步骤完成周期: ${ret.completedCycle || stepCycle || '-'}\n步骤备注: ${ret.stepNote || 'TG指令完成'}` : `❌ ${ret.error || ret.detail}`;
    await tg('sendMessage', { chat_id: chatId, text: txt, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('流转任务')) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '❌ “流转任务”命令已下线，请改用子任务命令：\n1) /task 新增子任务 #任务号 标题=... 负责人=@... 开始时间=YYYY-MM-DD HH:mm 结束时间=YYYY-MM-DD HH:mm 子任务描述=... 抄送=@a,@b 备注=...\n2) /task 启动子任务 #子任务ID\n3) /task 完成子任务 #子任务ID',
      reply_to_message_id: msg.message_id
    });
    return;
  }

  if (text.includes('添加备注')) {
    const m = text.match(/#([A-Za-z0-9-]+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带任务号，如 #18G-1001', reply_to_message_id: msg.message_id });
    const content = text.replace(/.*添加备注\s*#?[A-Za-z0-9-]+\s*/, '').trim();
    if (!content) return tg('sendMessage', { chat_id: chatId, text: '备注内容不能为空', reply_to_message_id: msg.message_id });
    const ret = await api(`/tasks/${m[1]}/remarks`, 'POST', { content }, actor);
    const txt = ret.ok ? `✅ 已添加备注到 ${m[1]}` : `❌ ${ret.error || ret.detail}`;
    await tg('sendMessage', { chat_id: chatId, text: txt, reply_to_message_id: msg.message_id });
    return;
  }

  if (text.includes('查看进行中') || text.includes('进行中任务') || text.includes('当日任务')) {
    const q = isAdmin
      ? `/tasks?project=${PROJECT_DEFAULT}&status=${encodeURIComponent('处理中')}`
      : `/tasks?project=${PROJECT_DEFAULT}&status=${encodeURIComponent('处理中')}&currentResponsible=${encodeURIComponent(identity.tgUsername || actor)}`;
    const ret = await api(q);
    if (!Array.isArray(ret)) return tg('sendMessage', { chat_id: chatId, text: '查询失败', reply_to_message_id: msg.message_id });

    const lines = [isAdmin ? `📌 全部进行中任务(${PROJECT_DEFAULT})：${ret.length}` : `📌 我当前执行中的主任务(${PROJECT_DEFAULT})：${ret.length}`];
    for (const t of ret.slice(0, 20)) {
      const cc = (t.ccList || []).join(',') || '-';
      lines.push(
        [
          `任务号: ${t.taskNo}`,
          `名称: ${t.name}`,
          `类型: ${t.taskType || '新需求'}`,
          `文档: ${t.docLink || '-'}`,
          `提出人: ${t.requester || '-'}`,
          `当前执行: ${t.currentResponsible || t.executor || '-'}`,
          `抄送: ${cc}`,
          `完成周期: ${t.completedCycle || '-'}`,
          `任务到期时间: ${fmtTime(t.dueAt)}`,
          `当前流转状态: ${t.currentFlowStatus || '处理中'}`,
          `预计上线: ${t.expectedReleaseDate || '-'}`,
          `创建时间: ${fmtTime(t.createdAt)}`
        ].join('\n')
      );
      lines.push('');
    }

    if (!isAdmin) {
      const subQ = `/subtasks?project=${PROJECT_DEFAULT}&assignee=${encodeURIComponent(identity.tgUsername || actor)}&activeOnly=1`;
      const subs = await api(subQ);
      if (Array.isArray(subs)) {
        lines.push(`🧩 我当前执行中的子任务(${PROJECT_DEFAULT})：${subs.length}`);
        for (const s of subs.slice(0, 20)) {
          lines.push(
            [
              `子任务ID: #${s.id}`,
              `所属任务: ${s.taskNo} ${s.taskName || ''}`.trim(),
              `标题: ${s.title || '-'}`,
              `状态: ${s.status || '-'}`,
              `开始: ${fmtTime(s.receivedAt)}`,
              `到期: ${fmtTime(s.dueAt)}`
            ].join('\n')
          );
          lines.push('');
        }
      }
    }

    await sendTextInChunks(chatId, lines.join('\n').trim(), msg.message_id, { disable_web_page_preview: true });
    return;
  }

  if (text.includes('历史任务') || text.includes('已完成任务')) {
    const q = isAdmin
      ? `/tasks?project=${PROJECT_DEFAULT}&status=${encodeURIComponent('已完成')}`
      : `/tasks?project=${PROJECT_DEFAULT}&view=history&watcher=${encodeURIComponent(identity.tgUsername || actor)}`;
    const ret = await api(q);
    if (!Array.isArray(ret)) return tg('sendMessage', { chat_id: chatId, text: '查询失败', reply_to_message_id: msg.message_id });

    const lines = [isAdmin ? `📚 全部历史任务(${PROJECT_DEFAULT})：${ret.length}` : `📚 与你相关的历史任务(${PROJECT_DEFAULT})：${ret.length}`];
    const showList = ret.slice(0, 3);
    for (const t of showList) {
      const cc = (t.ccList || []).join(',') || '-';
      lines.push(`┏━━━━━━━━ 任务 ${t.taskNo} ━━━━━━━━`);
      lines.push(`┃ 名称: ${t.name}`);
      lines.push(`┃ 文档: ${t.docLink || '-'}`);
      lines.push(`┃ 提出人: ${t.requester || '-'}`);
      lines.push(`┃ 最后执行: ${t.currentResponsible || t.executor || '-'}`);
      lines.push(`┃ 抄送: ${cc}`);
      lines.push(`┃ 完成周期: ${t.completedCycle || '-'}`);
      lines.push(`┃ 任务到期: ${fmtTime(t.dueAt)}`);
      lines.push(`┃ 预计上线: ${t.expectedReleaseDate || '-'}`);
      lines.push(`┃ 创建时间: ${fmtTime(t.createdAt)}`);
      lines.push(`┃ 完成时间: ${fmtTime(t.completedAt)}`);

      const detail = await api(`/tasks/${t.taskNo}`);
      const flows = Array.isArray(detail?.flows) ? detail.flows : [];
      if (!flows.length) {
        lines.push('┃ 流转网格: 暂无记录');
      } else {
        lines.push('┃ 流转网格:');
        for (const [i, f] of flows.entries()) {
          const st = f.status || (f.completionStatus === 'on_time' ? '按时完成' : (f.completionStatus === 'delayed' ? '延期完成' : '处理中'));
          lines.push(`┃  ${i + 1}) ${f.fromResponsible || '-'} → ${f.toResponsible || '完成'}`);
          lines.push(`┃     状态: ${st}`);
          lines.push(`┃     完成周期: ${f.completedCycle || '-'}`);
          lines.push(`┃     开始: ${fmtTime(f.receivedAt)}`);
          lines.push(`┃     到期: ${fmtTime(f.dueAt)}`);
          lines.push(`┃     完成: ${fmtTime(f.finishedAt)}`);
          lines.push(`┃     备注: ${f.note || '-'}`);
        }
      }
      lines.push('┗━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('');
    }

    if (ret.length > showList.length) {
      lines.push(`… 仅展示最近 ${showList.length} 条历史任务。`);
      lines.push(`更多历史任务请登录管理后台查看。`);
      lines.push(`如需单条详情，可用：/task 任务详情 #任务号`);
    }

    await sendTextInChunks(chatId, lines.join('\n').trim(), msg.message_id, { disable_web_page_preview: true });
    return;
  }

  if (text.includes('任务详情')) {
    const m = text.match(/#([A-Za-z0-9-]+)/);
    if (!m) return tg('sendMessage', { chat_id: chatId, text: '请带任务号，如 /task 任务详情 #18G-1001', reply_to_message_id: msg.message_id });

    const ret = await api(`/tasks/${m[1]}`);
    if (!ret || !ret.task) return tg('sendMessage', { chat_id: chatId, text: '任务不存在或查询失败', reply_to_message_id: msg.message_id });

    const t = ret.task;
    const cc = (t.ccList || []).join(',') || '-';
    const lines = [
      `🧾 任务详情 ${t.taskNo}`,
      `名称: ${t.name || '-'}`,
      `类型: ${t.taskType || '新需求'}`,
      `状态: ${t.status || '-'}`,
      `文档: ${t.docLink || '-'}`,
      `提出人: ${t.requester || '-'}`,
      `当前执行: ${t.currentResponsible || t.executor || '-'}`,
      `抄送: ${cc}`,
      `完成周期: ${t.completedCycle || '-'}`,
      `任务到期时间: ${fmtTime(t.dueAt)}`,
      `预计上线: ${t.expectedReleaseDate || '-'}`,
      `创建时间: ${fmtTime(t.createdAt)}`,
      `完成时间: ${fmtTime(t.completedAt)}`,
      '',
      '🔄 流转时间线'
    ];

    const flows = Array.isArray(ret.flows) ? ret.flows : [];
    if (!flows.length) {
      lines.push('暂无流转记录');
    } else {
      for (const [i, f] of flows.entries()) {
        const st = f.status || (f.completionStatus === 'on_time' ? '按时完成' : (f.completionStatus === 'delayed' ? '延期完成' : '处理中'));
        lines.push([
          `${i + 1}. ${f.fromResponsible || '-'} -> ${f.toResponsible || '完成'}`,
          `开始: ${fmtTime(f.receivedAt)}`,
          `到期: ${fmtTime(f.dueAt)}`,
          `结束: ${fmtTime(f.finishedAt)}`,
          `状态: ${st}`,
          `完成周期: ${f.completedCycle || '-'}`,
          `备注: ${f.note || '-'}`
        ].join('\n'));
        lines.push('');
      }
    }

    lines.push('🧩 子任务列表');
    const subs = Array.isArray(ret.subtasks) ? ret.subtasks : [];
    if (!subs.length) {
      lines.push('暂无子任务');
    } else {
      for (const s of subs.slice(0, 20)) {
        lines.push(`#${s.id} ${s.title || '-'} | 负责人:${s.assignee || '-'} | 状态:${s.status || '-'} | 开始:${fmtTime(s.receivedAt)} | 完成:${fmtTime(s.completedAt)}`);
      }
    }

    const reply = { chat_id: chatId, text: lines.join('\n').trim(), reply_to_message_id: msg.message_id, disable_web_page_preview: true };
    if (isAdmin) {
      const buttons = [
        [{ text: `🗑 删除主任务 ${t.taskNo}`, callback_data: `del_task:${t.taskNo}` }]
      ];
      for (const s of subs.slice(0, 10)) {
        buttons.push([{ text: `🗑 删除子任务 #${s.id}`, callback_data: `del_sub:${s.id}` }]);
      }
      reply.reply_markup = { inline_keyboard: buttons };
    }

    await tg('sendMessage', reply);
    return;
  }
}

async function handleCallbackQuery(q) {
  const data = String(q?.data || '');
  if (!data) return;
  const chatId = q.message?.chat?.id;
  const fromUsername = q.from?.username ? `@${q.from.username}` : `tg_${q.from?.id}`;
  const identity = await resolveTaskUser(fromUsername);
  const actor = identity.actor;
  const isAdmin = identity.role === 'superadmin' || identity.role === 'admin';

  const answer = async (text, alert = false) => tg('answerCallbackQuery', {
    callback_query_id: q.id,
    text,
    show_alert: alert
  });

  if (!isAdmin) {
    await answer('仅管理员可删除', true);
    return;
  }

  if (data.startsWith('del_sub:')) {
    const id = data.split(':')[1];
    const ret = await api(`/subtasks/${id}/delete`, 'POST', {}, actor);
    await answer(ret.ok ? `已删除子任务 #${id}` : `删除失败: ${ret.error || ret.detail || '未知错误'}`, !ret.ok);
    if (chatId) {
      await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 已删除子任务 #${id}` : `❌ 删除子任务 #${id} 失败：${ret.error || ret.detail || '未知错误'}` });
    }
    return;
  }

  if (data.startsWith('del_task:')) {
    const taskNo = data.split(':')[1];
    const ret = await api(`/tasks/${taskNo}/delete`, 'POST', {}, actor);
    await answer(ret.ok ? `已删除主任务 ${taskNo}` : `删除失败: ${ret.error || ret.detail || '未知错误'}`, !ret.ok);
    if (chatId) {
      await tg('sendMessage', { chat_id: chatId, text: ret.ok ? `✅ 已删除主任务 ${taskNo}（连带删除子任务 ${ret.deletedSubtaskCount || 0} 条）` : `❌ 删除主任务 ${taskNo} 失败：${ret.error || ret.detail || '未知错误'}` });
    }
  }
}

async function loop() {
  try {
    const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    if (r.ok) {
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.message) await handleMessage(u.message);
        if (u.callback_query) await handleCallbackQuery(u.callback_query);
      }
    }
  } catch (e) {
    console.error('poll error:', e.message);
  } finally {
    setImmediate(loop);
  }
}

console.log('Telegram bot polling started...');
startDailyReminderLoop();
startSubtaskDueSoonLoop();
startMainTaskWeeklyReminderLoop();
loop();
