const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PUBLIC_DIR = path.join(__dirname, 'public');
const EXPORTS_DIR = path.join(__dirname, 'exports');

const PORT = process.env.PORT || 8090;
const BIND_HOST = process.env.TASK_BIND_HOST || process.env.HOST || '127.0.0.1';
const DB_FILE = path.join(__dirname, 'data.json');
const SQLITE_FILE = path.join(__dirname, 'data.sqlite3');
const TZ = 'Asia/Shanghai';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const ENABLE_DAILY_PUSH = process.env.TASK_ENABLE_DAILY_PUSH === '1';

const DEFAULT_ADMIN = {
  username: 'admin',
  name: '管理员',
  position: '产品',
  tgUsername: null,
  role: 'superadmin',
  enabled: true
};

const ADMIN_BOOTSTRAP_PASSWORD = process.env.TASK_ADMIN_BOOTSTRAP_PASSWORD || '';
const LOGIN_MAX_FAILS = Number(process.env.TASK_LOGIN_MAX_FAILS || 5);
const LOGIN_LOCK_MINUTES = Number(process.env.TASK_LOGIN_LOCK_MINUTES || 15);
const loginThrottle = new Map();

function dateInTZ(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(d).replace(' ', 'T');
}

function beijingTodayDate() {
  return dateInTZ().slice(0, 10);
}

function beijingWeekdayShort(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
}

function isBeijingWorkday(d = new Date()) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(beijingWeekdayShort(d));
}

function parseTZDateToEpoch(v) {
  if (!v) return NaN;
  const s = String(v).trim().replace(' ', 'T');
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s).getTime();
  return new Date(`${s}+08:00`).getTime();
}

function randomId(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iter = 120000;
  const hash = crypto.pbkdf2Sync(String(plain), salt, iter, 32, 'sha256').toString('hex');
  return `pbkdf2$${iter}$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  const s = String(stored || '');
  if (s.startsWith('pbkdf2$')) {
    const parts = s.split('$');
    if (parts.length !== 4) return false;
    const iter = Number(parts[1] || 0);
    const salt = parts[2] || '';
    const expected = parts[3] || '';
    if (!iter || !salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(String(plain), salt, iter, 32, 'sha256').toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }
  return s === String(plain || '');
}

function isPasswordHashed(v) {
  return String(v || '').startsWith('pbkdf2$');
}

function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows = [], headers = []) {
  const head = headers.map(csvCell).join(',');
  const body = rows.map(r => headers.map(h => csvCell(r[h])).join(',')).join('\n');
  return `\ufeff${head}\n${body}`;
}

function parseCsv(text = '') {
  const s = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let cur = '';
  let row = [];
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const nx = s[i + 1];
    if (inQuote) {
      if (ch === '"' && nx === '"') { cur += '"'; i += 1; continue; }
      if (ch === '"') { inQuote = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',') { row.push(cur); cur = ''; continue; }
    if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    if (ch === '\r') continue;
    cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h || '').trim());
  return rows.slice(1).filter(r => r.some(c => String(c || '').trim())).map(r => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] || '').trim(); });
    return o;
  });
}

function ensureDefaults(db) {
  if (!db.accounts) db.accounts = [];
  if (!db.sessions) db.sessions = {};
  if (!db.tasks) db.tasks = [];
  if (!db.remarks) db.remarks = [];
  if (!db.flows) db.flows = [];
  if (!db.subtasks) db.subtasks = [];
  if (!db.subtaskLogs) db.subtaskLogs = [];
  if (!db.subSeq) db.subSeq = 1;
  if (!db.seq) db.seq = 1000;
  if (!('lastReportDate' in db)) db.lastReportDate = null;
  if (!('subtasksMigrated' in db)) db.subtasksMigrated = false;

  for (const a of db.accounts) {
    if (!a.name) a.name = a.username;
    if (!a.position) a.position = '产品';
  }

  for (const t of db.tasks) {
    hydrateTaskTiming(t);
    if (t.note === undefined || t.note === null) t.note = '';
    const execUsers = splitUsers(t.executor || t.currentResponsible || '');
    if (execUsers.length > 1) {
      const extras = execUsers.slice(1).map(u => normalizeToTgAccount(u, db));
      t.ccList = [...new Set([...(t.ccList || []), ...extras])];
    }
    const one = normalizeSingleUserToTg(t.currentResponsible || t.executor || '', db);
    if (one) {
      t.executor = one;
      t.currentResponsible = one;
    }
    t.ccList = normalizeCcListToTg(t.ccList || [], db);
  }

  const hasAdmin = db.accounts.some(a => a.username === DEFAULT_ADMIN.username);
  if (!hasAdmin) {
    const initPassword = ADMIN_BOOTSTRAP_PASSWORD || randomId('init_');
    db.accounts.push({
      ...DEFAULT_ADMIN,
      password: hashPassword(initPassword),
      mustChangePassword: true,
      createdAt: dateInTZ(),
      createdBy: 'system'
    });
    if (!ADMIN_BOOTSTRAP_PASSWORD) {
      console.warn(`[SECURITY] admin bootstrap password generated: ${initPassword}`);
      console.warn('[SECURITY] please login as admin and change password immediately.');
    }
  }

  for (const a of db.accounts) {
    if (a.password && !isPasswordHashed(a.password)) {
      a.password = hashPassword(a.password);
      if (a.username === DEFAULT_ADMIN.username) a.mustChangePassword = true;
    }
  }
}

let sqlite = null;

function getSqlite() {
  if (sqlite) return sqlite;
  sqlite = new DatabaseSync(SQLITE_FILE);
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv_store (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const row = sqlite.prepare(`SELECT v FROM kv_store WHERE k='db'`).get();
  if (!row) {
    let seed = {};
    if (fs.existsSync(DB_FILE)) {
      try { seed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { seed = {}; }
    }
    const now = dateInTZ();
    sqlite.prepare(`INSERT OR REPLACE INTO kv_store(k,v,updated_at) VALUES('db', ?, ?)`)
      .run(JSON.stringify(seed), now);
  }
  return sqlite;
}

function loadDB() {
  const dbConn = getSqlite();
  const row = dbConn.prepare(`SELECT v FROM kv_store WHERE k='db'`).get();
  let db = {};
  try { db = row?.v ? JSON.parse(row.v) : {}; } catch { db = {}; }
  ensureDefaults(db);
  migrateFlowsToSubtasksIfNeeded(db);
  return db;
}

function saveDB(db) {
  const dbConn = getSqlite();
  const now = dateInTZ();
  const payload = JSON.stringify(db);
  dbConn.prepare(`BEGIN IMMEDIATE`).run();
  try {
    dbConn.prepare(`INSERT OR REPLACE INTO kv_store(k,v,updated_at) VALUES('db', ?, ?)`).run(payload, now);
    dbConn.prepare(`COMMIT`).run();
  } catch (e) {
    try { dbConn.prepare(`ROLLBACK`).run(); } catch {}
    throw e;
  }
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function delayedFlag(completedAt, expectedReleaseDate) {
  if (!completedAt) return null;
  const expectedEnd = new Date(`${expectedReleaseDate}T23:59:59+08:00`);
  return new Date(completedAt) > expectedEnd;
}

function parseCycleSpec(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  if (/[分钟mM分]/.test(s)) return { unit: 'minute', value: n };
  if (/[小时hH]/.test(s)) return { unit: 'hour', value: n };
  if (/[周wW]/.test(s)) return { unit: 'workday', value: n * 5 };
  // 默认按工作日（天）处理，自动跳过周末
  return { unit: 'workday', value: n };
}

function addBusinessDaysKeepTime(baseDate, days) {
  const whole = Math.floor(days);
  const fraction = days - whole;
  const d = new Date(baseDate.getTime());

  let added = 0;
  while (added < whole) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }

  if (fraction > 0) {
    d.setTime(d.getTime() + Math.round(fraction * 24 * 3600 * 1000));
  }
  return d;
}

function calcDueAtFrom(receivedAt, completedCycle) {
  const spec = parseCycleSpec(completedCycle);
  if (!receivedAt || !spec) return null;
  const t = new Date(receivedAt).getTime();
  if (!Number.isFinite(t)) return null;

  let out;
  if (spec.unit === 'minute') out = new Date(t + Math.round(spec.value * 60 * 1000));
  else if (spec.unit === 'hour') out = new Date(t + Math.round(spec.value * 3600 * 1000));
  else out = addBusinessDaysKeepTime(new Date(t), spec.value);

  return dateInTZ(out);
}

function stepResultByDue(finishedAt, dueAt) {
  if (!finishedAt || !dueAt) return 'unknown';
  const f = new Date(finishedAt).getTime();
  const d = new Date(dueAt).getTime();
  if (!Number.isFinite(f) || !Number.isFinite(d)) return 'unknown';
  return f <= d ? 'on_time' : 'delayed';
}

function flowStatusLabel(completionStatus) {
  if (completionStatus === 'on_time') return '按时完成';
  if (completionStatus === 'delayed') return '延期完成';
  return '处理中';
}

function hydrateTaskTiming(task) {
  if (!task.currentResponsibleReceivedAt) {
    task.currentResponsibleReceivedAt = task.createdAt || dateInTZ();
  }
  if (!task.dueAt) {
    task.dueAt = calcDueAtFrom(task.currentResponsibleReceivedAt, task.completedCycle) || null;
  }
}

function round2(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function getYmdInTZ(v) {
  const ts = parseTZDateToEpoch(v);
  if (!Number.isFinite(ts)) return '';
  return dateInTZ(new Date(ts)).slice(0, 10);
}

function periodKeyByGranularity(v, granularity = 'day') {
  const ymd = getYmdInTZ(v);
  if (!ymd) return '';
  if (granularity === 'month') return ymd.slice(0, 7);
  if (granularity === 'week') {
    const d = new Date(`${ymd}T00:00:00+08:00`);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(d.getTime() + diff * 86400000);
    const mon = dateInTZ(monday).slice(0, 10);
    return `${mon}~${dateInTZ(new Date(monday.getTime() + 6 * 86400000)).slice(0, 10)}`;
  }
  return ymd;
}

function displayNameForActor(raw, db) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const n = normUser(s);
  const a = (db.accounts || []).find(acc => normUser(acc.username) === n || normUser(acc.tgUsername) === n);
  return (a && String(a.name || '').trim()) || s;
}

function toHours(startAt, endAt) {
  const s = parseTZDateToEpoch(startAt);
  const e = parseTZDateToEpoch(endAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return round2((e - s) / 3600000);
}

function toDays(startAt, endAt) {
  const h = toHours(startAt, endAt);
  if (h === null) return null;
  return round2(h / 24);
}

function normalizeDateTimeInput(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const normalized = s.replace(' ', 'T');
  return Number.isFinite(parseTZDateToEpoch(normalized)) ? normalized : '';
}

function calcDurationDisplay(startAt, endAt) {
  const s = parseTZDateToEpoch(startAt);
  const e = parseTZDateToEpoch(endAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return '';
  const ms = e - s;
  const dayMs = 24 * 3600 * 1000;
  const hourMs = 3600 * 1000;
  const days = Math.floor(ms / dayMs);
  const hours = Math.floor((ms % dayMs) / hourMs);
  return `${days}天${hours}小时`;
}

function buildDashboardStats(db, { project = '18game', from = '', to = '', granularity = 'day' } = {}) {
  granularity = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
  const fromTs = from ? parseTZDateToEpoch(`${from}T00:00:00`) : null;
  const toTs = to ? parseTZDateToEpoch(`${to}T23:59:59`) : null;

  const accountByActor = (actor) => {
    const raw = String(actor || '').trim();
    const n = normUser(raw);
    const byLogin = (db.accounts || []).find(a => normUser(a.username) === n || normUser(a.tgUsername) === n);
    if (byLogin) return byLogin;
    const lower = raw.toLowerCase();
    return (db.accounts || []).find(a => String(a.name || '').trim().toLowerCase() === lower) || null;
  };

  const taskList = (db.tasks || []).filter(t => {
    if (project && t.project !== project) return false;
    const createdTs = parseTZDateToEpoch(t.createdAt);
    if (Number.isFinite(fromTs) && createdTs < fromTs) return false;
    if (Number.isFinite(toTs) && createdTs > toTs) return false;
    return true;
  });

  const flowList = (db.flows || []).filter(f => {
    const task = taskList.find(t => t.taskNo === f.taskNo);
    return !!task;
  });

  const flowCountByTask = {};
  for (const f of flowList) {
    flowCountByTask[f.taskNo] = (flowCountByTask[f.taskNo] || 0) + 1;
  }

  const tasks = taskList.map(t => {
    const completed = t.status === '已完成' || !!t.completedAt;
    const flowCount = flowCountByTask[t.taskNo] || 0;
    const efficiencyHours = completed ? toHours(t.createdAt, t.completedAt) : null;
    const delayed = completed ? !!delayedFlag(t.completedAt, t.expectedReleaseDate) : null;
    const overdueDays = (completed && delayed)
      ? Math.max(0, round2((parseTZDateToEpoch(t.completedAt) - parseTZDateToEpoch(`${t.expectedReleaseDate}T23:59:59`)) / 86400000))
      : 0;
    const onTime = completed ? !delayed : null;
    const score = completed
      ? Math.max(0, Math.min(100, 70 + (onTime ? 30 : 0) - Math.max(0, Math.ceil(overdueDays || 0)) * 10 - Math.max(0, flowCount - 2) * 5))
      : null;

    return {
      taskNo: t.taskNo,
      name: t.name,
      status: completed ? '已完成' : '进行中',
      requester: t.requester,
      creator: t.creator,
      currentResponsible: t.currentResponsible || t.executor,
      createdAt: t.createdAt,
      expectedReleaseDate: t.expectedReleaseDate,
      completedAt: t.completedAt || null,
      flowCount,
      efficiencyHours,
      onTime,
      delayed: completed ? delayed : null,
      overdueDays,
      score,
      docLink: t.docLink || ''
    };
  });

  const completedTasks = tasks.filter(t => t.status === '已完成');
  const inProgressTasks = tasks.filter(t => t.status === '进行中');
  const onTimeCompleted = completedTasks.filter(t => t.onTime === true).length;
  const highFlowTasks = tasks.filter(t => t.flowCount >= 4).length;

  const efficiencyVals = completedTasks.map(t => t.efficiencyHours).filter(v => Number.isFinite(v));
  const avgEfficiencyHours = efficiencyVals.length ? round2(efficiencyVals.reduce((a, b) => a + b, 0) / efficiencyVals.length) : 0;
  const avgFlowCount = tasks.length ? round2(tasks.reduce((a, t) => a + (t.flowCount || 0), 0) / tasks.length) : 0;

  const statusDistribution = {
    进行中: inProgressTasks.length,
    已完成: completedTasks.length
  };

  const flowDistribution = {
    '0-1': tasks.filter(t => t.flowCount <= 1).length,
    '2-3': tasks.filter(t => t.flowCount >= 2 && t.flowCount <= 3).length,
    '4+': tasks.filter(t => t.flowCount >= 4).length
  };

  const byDay = {};
  for (const t of tasks) {
    const cday = periodKeyByGranularity(t.createdAt, granularity);
    if (cday) {
      byDay[cday] = byDay[cday] || { date: cday, created: 0, completed: 0, completedEfficiencyHours: [], completedFlowCount: [] };
      byDay[cday].created += 1;
    }
    const fday = periodKeyByGranularity(t.completedAt, granularity);
    if (fday) {
      byDay[fday] = byDay[fday] || { date: fday, created: 0, completed: 0, completedEfficiencyHours: [], completedFlowCount: [] };
      byDay[fday].completed += 1;
      if (Number.isFinite(t.efficiencyHours)) byDay[fday].completedEfficiencyHours.push(t.efficiencyHours);
      byDay[fday].completedFlowCount.push(t.flowCount || 0);
    }
  }

  const trend = Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      date: d.date,
      created: d.created,
      completed: d.completed,
      avgEfficiencyHours: d.completedEfficiencyHours.length
        ? round2(d.completedEfficiencyHours.reduce((x, y) => x + y, 0) / d.completedEfficiencyHours.length)
        : 0,
      avgFlowCount: d.completedFlowCount.length
        ? round2(d.completedFlowCount.reduce((x, y) => x + y, 0) / d.completedFlowCount.length)
        : 0
    }));

  const peopleMap = {};
  function ensurePerson(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    if (!peopleMap[n]) {
      peopleMap[n] = {
        person: n,
        totalTasks: 0,
        inProgressTasks: 0,
        completedTasks: 0,
        onTimeCompleted: 0,
        delayedCompleted: 0,
        avgEfficiencyHours: 0,
        currentWip: 0,
        flowParticipation: 0,
        highFlowTaskCount: 0,
        taskSet: new Set(),
        highFlowTaskSet: new Set(),
        efficiencyList: []
      };
    }
    return peopleMap[n];
  }

  for (const t of tasks) {
    const owners = new Set();
    owners.add(t.currentResponsible || '');
    for (const f of flowList.filter(f => f.taskNo === t.taskNo)) {
      if (f.fromResponsible) owners.add(f.fromResponsible);
      if (f.toResponsible) owners.add(f.toResponsible);
    }

    for (const owner of owners) {
      const p = ensurePerson(owner);
      if (!p) continue;
      if (!p.taskSet.has(t.taskNo)) {
        p.taskSet.add(t.taskNo);
        p.totalTasks += 1;
        if (t.status === '进行中') p.inProgressTasks += 1;
        if (t.status === '已完成') p.completedTasks += 1;
        if (t.status === '已完成' && t.onTime) p.onTimeCompleted += 1;
        if (t.status === '已完成' && t.delayed) p.delayedCompleted += 1;
        if (t.status === '进行中' && sameUser(owner, t.currentResponsible)) p.currentWip += 1;
        if (t.flowCount >= 4) {
          p.highFlowTaskSet.add(t.taskNo);
          p.highFlowTaskCount = p.highFlowTaskSet.size;
        }
        if (t.status === '已完成' && Number.isFinite(t.efficiencyHours)) p.efficiencyList.push(t.efficiencyHours);
      }
    }
  }

  for (const f of flowList) {
    const from = ensurePerson(f.fromResponsible);
    const toP = ensurePerson(f.toResponsible);
    if (from) from.flowParticipation += 1;
    if (toP) toP.flowParticipation += 1;
  }

  const people = Object.values(peopleMap)
    .map(p => {
      const avgEfficiency = p.efficiencyList.length
        ? round2(p.efficiencyList.reduce((a, b) => a + b, 0) / p.efficiencyList.length)
        : 0;
      return {
        person: displayNameForActor(p.person, db),
        totalTasks: p.totalTasks,
        inProgressTasks: p.inProgressTasks,
        completedTasks: p.completedTasks,
        completionRate: p.totalTasks ? round2(p.completedTasks / p.totalTasks) : 0,
        onTimeCompleted: p.onTimeCompleted,
        delayedCompleted: p.delayedCompleted,
        onTimeRate: p.completedTasks ? round2(p.onTimeCompleted / p.completedTasks) : 0,
        delayedRate: p.completedTasks ? round2(p.delayedCompleted / p.completedTasks) : 0,
        avgEfficiencyHours: avgEfficiency,
        currentWip: p.currentWip,
        avgFlowCountPerTask: p.totalTasks ? round2(p.flowParticipation / p.totalTasks) : 0,
        highFlowTaskRatio: p.totalTasks ? round2(p.highFlowTaskCount / p.totalTasks) : 0,
        flowParticipation: p.flowParticipation
      };
    })
    .sort((a, b) => b.totalTasks - a.totalTasks);

  const problemTasks = [...tasks]
    .sort((a, b) => (b.overdueDays - a.overdueDays) || (b.flowCount - a.flowCount))
    .slice(0, 20);

  const subtasks = (db.subtasks || []).filter(s => {
    const task = taskList.find(t => t.taskNo === s.taskNo);
    return !!task;
  });
  const subCompleted = subtasks.filter(s => s.status === '已完成');
  const subOnTime = subCompleted.filter(s => {
    if (!s.dueAt || !s.completedAt) return false;
    return parseTZDateToEpoch(s.completedAt) <= parseTZDateToEpoch(s.dueAt);
  }).length;
  const subEffVals = subCompleted
    .map(s => toHours(s.receivedAt || s.createdAt, s.completedAt))
    .filter(v => Number.isFinite(v));
  const avgSubtaskPerTask = tasks.length ? round2(subtasks.length / tasks.length) : 0;
  const subtaskCompletionRate = subtasks.length ? round2(subCompleted.length / subtasks.length) : 0;
  const subtaskOnTimeRate = subCompleted.length ? round2(subOnTime / subCompleted.length) : 0;
  const avgSubtaskEfficiencyHours = subEffVals.length ? round2(subEffVals.reduce((a, b) => a + b, 0) / subEffVals.length) : 0;

  const subByDay = {};
  for (const s of subtasks) {
    const cday = periodKeyByGranularity(s.createdAt, granularity);
    if (cday) {
      subByDay[cday] = subByDay[cday] || { date: cday, created: 0, completed: 0, delayed: 0 };
      subByDay[cday].created += 1;
    }
    const fday = periodKeyByGranularity(s.completedAt, granularity);
    if (fday) {
      subByDay[fday] = subByDay[fday] || { date: fday, created: 0, completed: 0, delayed: 0 };
      subByDay[fday].completed += 1;
      const delayed = s.dueAt && s.completedAt && parseTZDateToEpoch(s.completedAt) > parseTZDateToEpoch(s.dueAt);
      if (delayed) subByDay[fday].delayed += 1;
    }
  }
  const subTrend = Object.values(subByDay).sort((a, b) => a.date.localeCompare(b.date));

  const peopleSubMap = {};
  function ensurePS(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    if (!peopleSubMap[n]) peopleSubMap[n] = { person: n, total: 0, completed: 0, onTime: 0, wip: 0, eff: [] };
    return peopleSubMap[n];
  }
  for (const s of subtasks) {
    const p = ensurePS(s.assignee);
    if (!p) continue;
    p.total += 1;
    if (s.status === '进行中' || s.status === '待启动' || s.status === '待处理' || s.status === '阻塞') p.wip += 1;
    if (s.status === '已完成') {
      p.completed += 1;
      if (s.dueAt && s.completedAt && parseTZDateToEpoch(s.completedAt) <= parseTZDateToEpoch(s.dueAt)) p.onTime += 1;
      const eh = toHours(s.receivedAt || s.createdAt, s.completedAt);
      if (Number.isFinite(eh)) p.eff.push(eh);
    }
  }
  for (const a of (db.accounts || [])) {
    if (!a?.username) continue;
    ensurePS(a.tgUsername || a.username);
  }
  const peopleSubtask = Object.values(peopleSubMap).map(p => ({
    person: displayNameForActor(p.person, db),
    totalSubtasks: p.total,
    completedSubtasks: p.completed,
    subtaskCompletionRate: p.total ? round2(p.completed / p.total) : 0,
    subtaskOnTimeRate: p.completed ? round2(p.onTime / p.completed) : 0,
    avgSubtaskEfficiencyHours: p.eff.length ? round2(p.eff.reduce((a,b)=>a+b,0)/p.eff.length) : 0,
    currentWipSubtasks: p.wip
  })).sort((a,b)=>b.totalSubtasks-a.totalSubtasks);

  const subtaskStatusDistribution = subtasks.reduce((acc, s) => {
    const k = s.status || '未知';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const problemSubtasks = [...subtasks]
    .map(s => {
      const overdueHours = (s.dueAt && s.status !== '已完成')
        ? Math.max(0, toHours(s.dueAt, dateInTZ()))
        : 0;
      return {
        id: s.id,
        taskNo: s.taskNo,
        title: s.title,
        assignee: displayNameForActor(s.assignee, db),
        status: s.status,
        dueAt: s.dueAt,
        completedAt: s.completedAt,
        efficiencyHours: s.completedAt ? toHours(s.receivedAt || s.createdAt, s.completedAt) : null,
        overdueHours: round2(overdueHours)
      };
    })
    .sort((a, b) => (b.overdueHours - a.overdueHours) || ((b.efficiencyHours || 0) - (a.efficiencyHours || 0)))
    .slice(0, 20);

  const userPeriodMap = {};
  for (const s of subtasks) {
    const actorSource = (s.assignee || '').trim();
    if (!actorSource) continue; // 跳过无负责人的子任务
    const actor = displayNameForActor(actorSource, db) || actorSource;
    const acc = accountByActor(actorSource) || accountByActor(actor);
    if (!acc) continue; // 找不到账号的跳过
    const position = (acc.position || '').trim() || '未知';
    const actorKey = normUser(acc.tgUsername || acc.username || actorSource || actor);

    const inProgressStatus = ['待处理', '待启动', '进行中', '阻塞'];
    const inProgressKey = periodKeyByGranularity(s.receivedAt || s.createdAt, granularity);
    if (inProgressKey && inProgressStatus.includes(String(s.status || '').trim())) {
      const k = `${position}__${actorKey}__${inProgressKey}`;
      userPeriodMap[k] = userPeriodMap[k] || { person: actor, position, period: inProgressKey, inProgress: 0, completed: 0 };
      userPeriodMap[k].inProgress += 1;
    }

    const completedKey = periodKeyByGranularity(s.completedAt, granularity);
    if (completedKey && s.status === '已完成') {
      const k = `${position}__${actorKey}__${completedKey}`;
      userPeriodMap[k] = userPeriodMap[k] || { person: actor, position, period: completedKey, inProgress: 0, completed: 0 };
      userPeriodMap[k].completed += 1;
    }
  }
  const userPeriodStats = Object.values(userPeriodMap)
    .sort((a, b) => a.period.localeCompare(b.period) || a.person.localeCompare(b.person));

  const positionMap = {};
  for (const t of tasks) {
    const actorSource = (t.currentResponsible || t.executor || '').trim();
    if (!actorSource) continue; // 跳过无处理人的任务
    const actorName = displayNameForActor(actorSource, db) || actorSource;
    const acc = accountByActor(actorSource) || accountByActor(actorName);
    if (!acc) continue; // 找不到账号的跳过
    const pos = (acc.position || '').trim() || '未知';
    if (!positionMap[pos]) positionMap[pos] = { position: pos, inProgress: 0, completed: 0, total: 0 };
    positionMap[pos].total += 1;
    if (t.status === '进行中') positionMap[pos].inProgress += 1;
    if (t.status === '已完成') positionMap[pos].completed += 1;
  }
  const positionStats = Object.values(positionMap).sort((a, b) => b.total - a.total);

  return {
    filters: { project, from: from || null, to: to || null, granularity },
    overview: {
      totalTasks: tasks.length,
      completedTasks: completedTasks.length,
      inProgressTasks: inProgressTasks.length,
      completionRate: tasks.length ? round2(completedTasks.length / tasks.length) : 0,
      onTimeRate: completedTasks.length ? round2(onTimeCompleted / completedTasks.length) : 0,
      avgEfficiencyHours,
      avgFlowCount,
      highFlowTasks,
      avgSubtaskPerTask,
      subtaskTotal: subtasks.length,
      subtaskCompletionRate,
      subtaskOnTimeRate,
      avgSubtaskEfficiencyHours
    },
    distributions: { statusDistribution, subtaskStatusDistribution },
    trend,
    subTrend,
    tasks,
    subtasks,
    people,
    peopleSubtask,
    userPeriodStats,
    positionStats,
    problemTasks,
    problemSubtasks
  };
}

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(/[，,\s]+/).map(s => s.trim()).filter(Boolean);
}

function normUser(v) {
  return String(v || '').trim().replace(/^@/, '').toLowerCase();
}

function normalizeToTgAccount(v, db) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (raw.startsWith('@')) return `@${raw.replace(/^@+/, '')}`;

  const n = normUser(raw);
  const a = (db.accounts || []).find(acc => normUser(acc.username) === n || normUser(acc.tgUsername) === n);
  if (a) {
    if (a.tgUsername) return `@${String(a.tgUsername).replace(/^@+/, '')}`;
    return `@${String(a.username || raw).replace(/^@+/, '')}`;
  }
  return `@${raw.replace(/^@+/, '')}`;
}

function normalizeCcListToTg(list, db) {
  return toList(list).map(v => normalizeToTgAccount(v, db));
}

function splitUsers(v) {
  return toList(v);
}

function hasMultipleUsers(v) {
  return splitUsers(v).length > 1;
}

function normalizeSingleUserToTg(v, db) {
  const arr = splitUsers(v);
  if (!arr.length) return '';
  return normalizeToTgAccount(arr[0], db);
}

function sameUser(a, b) {
  const na = normUser(a);
  const nb = normUser(b);
  return !!na && !!nb && na === nb;
}

function identityMatchesActor(identity, actor, db) {
  if (sameUser(identity, actor)) return true;
  const idNorm = normUser(identity);
  const actorNorm = normUser(actor);
  const actorAccount = db.accounts.find(a => normUser(a.username) === actorNorm || normUser(a.tgUsername) === actorNorm);
  if (!actorAccount) return false;
  return normUser(actorAccount.username) === idNorm || normUser(actorAccount.tgUsername) === idNorm;
}

function normalizeSubtaskStatus(v) {
  const s = String(v || '').trim();
  const map = {
    '待处理': '待处理',
    '待启动': '待启动',
    '进行中': '进行中',
    '已完成': '已完成',
    '已取消': '已取消',
    '阻塞': '阻塞',
    pending: '待处理',
    todo: '待处理',
    ready: '待启动',
    blocked: '阻塞',
    doing: '进行中',
    done: '已完成',
    canceled: '已取消'
  };
  return map[s] || '待处理';
}

function addSubtaskLog(db, { subtaskId, action, actor, note = '', meta = null }) {
  db.subtaskLogs.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    subtaskId,
    action,
    actor,
    note,
    meta,
    createdAt: dateInTZ()
  });
}

function latestSubtaskNote(db, subtaskId) {
  const logs = (db.subtaskLogs || [])
    .filter(l => Number(l.subtaskId) === Number(subtaskId) && String(l.note || '').trim())
    .sort((a, b) => (parseTZDateToEpoch(b.createdAt || '') || 0) - (parseTZDateToEpoch(a.createdAt || '') || 0));
  return logs[0]?.note || '';
}

function recomputeTaskBySubtasks(taskNo, db) {
  const task = db.tasks.find(t => t.taskNo === taskNo);
  if (!task) return null;
  // 业务规则：子任务状态变化不自动驱动主任务完结。
  // 主任务是否完成必须由人工显式执行（/tasks/:taskNo/advance 或 /tasks/:taskNo/force-close）。
  task.updatedAt = dateInTZ();
  return task;
}

function hasUnfinishedDependencies(subtask, db) {
  const deps = Array.isArray(subtask.dependsOn) ? subtask.dependsOn : (subtask.dependsOn ? [subtask.dependsOn] : []);
  if (!deps.length) return false;
  const depSet = new Set(deps.map(x => String(x)));
  const depSubtasks = db.subtasks.filter(s => depSet.has(String(s.id)));
  if (!depSubtasks.length) return false;
  return depSubtasks.some(s => s.status !== '已完成');
}

function migrateFlowsToSubtasksIfNeeded(db) {
  if (db.subtasksMigrated) return;
  const existingFlowMap = new Set(db.subtasks.filter(s => s.sourceFlowId).map(s => String(s.sourceFlowId)));

  for (const f of db.flows || []) {
    if (existingFlowMap.has(String(f.id))) continue;
    const task = db.tasks.find(t => t.taskNo === f.taskNo);
    if (!task) continue;

    const createdAt = f.receivedAt || task.createdAt || dateInTZ();
    const completedAt = f.finishedAt || null;
    const status = completedAt ? '已完成' : '待处理';

    const subtask = {
      id: db.subSeq++,
      taskNo: f.taskNo,
      title: `历史流转-${f.id}`,
      description: f.note || '由flows迁移',
      assignee: f.toResponsible || f.fromResponsible || task.currentResponsible || task.creator,
      watchers: [],
      status,
      priority: 'P2',
      needDependencyCheck: false,
      dependsOn: [],
      expectedCycle: f.completedCycle || task.completedCycle || null,
      receivedAt: createdAt,
      dueAt: f.dueAt || null,
      completedAt,
      actualHours: completedAt ? toHours(createdAt, completedAt) : null,
      isDelayed: completedAt && f.dueAt ? (parseTZDateToEpoch(completedAt) > parseTZDateToEpoch(f.dueAt)) : null,
      sortOrder: db.subSeq,
      createdBy: 'system_migration',
      createdAt,
      updatedAt: dateInTZ(),
      sourceFlowId: f.id,
      source: 'flow_migration'
    };
    db.subtasks.push(subtask);
    addSubtaskLog(db, {
      subtaskId: subtask.id,
      action: 'migrate_from_flow',
      actor: 'system_migration',
      note: `flow#${f.id} -> subtask#${subtask.id}`
    });
  }

  for (const t of db.tasks) recomputeTaskBySubtasks(t.taskNo, db);
  db.subtasksMigrated = true;
}

function buildDailySummary(db, project = '18game') {
  const processing = db.tasks.filter(t => t.project === project && t.status === '处理中');
  const lines = [`📌 每日进行中任务（${project}） ${beijingTodayDate()}`];
  if (!processing.length) {
    lines.push('今天没有进行中的任务');
  } else {
    for (const t of processing) {
      const cc = (t.ccList || []).join('、') || '-';
      lines.push(`- ${t.taskNo} | ${t.name} | 提出人:${t.requester} | 执行人:${t.executor || t.currentResponsible} | 抄送:${cc} | 完成周期:${t.completedCycle || '-'} | 任务到期时间:${t.dueAt || '-'} | 预计上线:${t.expectedReleaseDate}`);
    }
  }
  return { project, count: processing.length, text: lines.join('\n') };
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true })
    });
  } catch (e) {
    console.error('sendTelegram failed:', e.message);
  }
}

function getAuthUser(req, db) {
  const token = req.headers['x-auth-token'];
  if (!token || !db.sessions[token]) return null;
  const s = db.sessions[token];
  if (!s || s.expiresAt < Date.now()) return null;
  const account = db.accounts.find(a => a.username === s.username && a.enabled !== false);
  return account || null;
}

function getActor(req, db) {
  const explicit = req.headers['x-user'];
  if (explicit) return explicit;
  const user = getAuthUser(req, db);
  return user ? user.username : null;
}

function requireLogin(req, res, db) {
  const user = getAuthUser(req, db);
  if (!user) {
    json(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return user;
}

function loginKey(req, username) {
  const ip = (req.socket?.remoteAddress || '').trim();
  return `${String(username || '').trim().toLowerCase()}|${ip}`;
}

function getLoginLockState(req, username) {
  const key = loginKey(req, username);
  const rec = loginThrottle.get(key);
  if (!rec) return { locked: false, waitSeconds: 0 };
  const now = Date.now();
  if (rec.lockUntil && now < rec.lockUntil) {
    return { locked: true, waitSeconds: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  if (rec.lockUntil && now >= rec.lockUntil) loginThrottle.delete(key);
  return { locked: false, waitSeconds: 0 };
}

function recordLoginFail(req, username) {
  const key = loginKey(req, username);
  const now = Date.now();
  const rec = loginThrottle.get(key) || { fails: 0, lockUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockUntil = now + LOGIN_LOCK_MINUTES * 60 * 1000;
    rec.fails = 0;
  }
  loginThrottle.set(key, rec);
}

function clearLoginFail(req, username) {
  loginThrottle.delete(loginKey(req, username));
}

function isAdminRole(role) {
  return role === 'superadmin' || role === 'admin';
}

function requireSuperAdmin(req, res, db) {
  const user = requireLogin(req, res, db);
  if (!user) return null;
  if (!isAdminRole(user.role)) {
    json(res, 403, { error: 'Only admin/superadmin allowed' });
    return null;
  }
  return user;
}

function actorIdentityList(actor) {
  if (!actor) return [];
  if (typeof actor === 'string') return [actor];
  if (typeof actor === 'object') {
    return [actor.username, actor.tgUsername, actor.name].filter(Boolean);
  }
  return [String(actor)];
}

function hasGlobalTaskPrivilege(req, db, actor) {
  const loginUser = getAuthUser(req, db);
  if (loginUser && isAdminRole(loginUser.role)) return true;
  const actors = actorIdentityList(actor);
  if (!actors.length) return false;
  return actors.some(a => {
    const actorNorm = normUser(a);
    const acc = db.accounts.find(x =>
      x.enabled !== false &&
      (normUser(x.username) === actorNorm || normUser(x.tgUsername) === actorNorm)
    );
    return !!(acc && isAdminRole(acc.role));
  });
}

function canOperateSubtask(req, db, actor, subtask) {
  if (hasGlobalTaskPrivilege(req, db, actor)) return true;
  const actors = actorIdentityList(actor);
  return actors.some(a => identityMatchesActor(subtask?.assignee || '', a, db));
}

function isSuperAdminActor(req, db, actor) {
  const loginUser = getAuthUser(req, db);
  if (loginUser && loginUser.role === 'superadmin') return true;
  const actorNorm = normUser(actor || '');
  if (!actorNorm) return false;
  const acc = db.accounts.find(a =>
    a.enabled !== false &&
    (normUser(a.username) === actorNorm || normUser(a.tgUsername) === actorNorm)
  );
  return !!(acc && acc.role === 'superadmin');
}

function isProductActor(req, db, actor) {
  const loginUser = getAuthUser(req, db);
  if (loginUser && String(loginUser.position || '').trim() === '产品') return true;
  const actorNorm = normUser(actor || '');
  if (!actorNorm) return false;
  const acc = db.accounts.find(a =>
    a.enabled !== false &&
    (normUser(a.username) === actorNorm || normUser(a.tgUsername) === actorNorm)
  );
  return !!(acc && String(acc.position || '').trim() === '产品');
}

function checkAndPrintDailyReport() {
  const db = loadDB();
  const ts = dateInTZ();
  const hhmm = ts.slice(11, 16);
  const today = ts.slice(0, 10);
  if (hhmm === '10:00' && db.lastReportDate !== today) {
    const summary = buildDailySummary(db, '18game');
    console.log(summary.text);

    // 避免与 bot.js 的群提醒重复：默认关闭 server 侧 Telegram 推送。
    // 如需启用，显式设置 TASK_ENABLE_DAILY_PUSH=1。
    if (ENABLE_DAILY_PUSH && isBeijingWorkday()) {
      sendTelegram(summary.text);
    }

    db.lastReportDate = today;
    saveDB(db);
  }
}

setInterval(checkAndPrintDailyReport, 30000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const db = loadDB();

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const p = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(p));
    }
  }

  if (method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, time: dateInTZ() });
  }

  if (method === 'GET' && url.pathname.startsWith('/exports/')) {
    let user = getAuthUser(req, db);
    if (!user) {
      const qt = String(url.searchParams.get('token') || '');
      const s = qt ? db.sessions[qt] : null;
      if (s && s.expiresAt > Date.now()) {
        user = db.accounts.find(a => a.username === s.username && a.enabled !== false) || null;
      }
    }
    if (!user) return json(res, 401, { error: 'Unauthorized' });

    const filename = decodeURIComponent(url.pathname.replace('/exports/', ''));
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return json(res, 400, { error: 'Invalid filename' });
    }
    const p = path.join(EXPORTS_DIR, filename);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return json(res, 404, { error: 'File not found' });
    }
    const ext = path.extname(filename).toLowerCase();
    const contentType = (ext === '.csv' || ext === '.cav')
      ? 'text/csv; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${path.basename(filename)}"`
    });
    return fs.createReadStream(p).pipe(res);
  }

  // Auth
  if (method === 'POST' && url.pathname === '/auth/login') {
    try {
      const body = await parseBody(req);
      const username = String(body.username || '').trim();
      const lock = getLoginLockState(req, username);
      if (lock.locked) {
        return json(res, 429, { error: `登录失败次数过多，请在 ${lock.waitSeconds} 秒后重试` });
      }

      const account = db.accounts.find(a => a.username === username && a.enabled !== false);
      const ok = !!account && verifyPassword(body.password, account.password);
      if (!ok) {
        recordLoginFail(req, username);
        return json(res, 401, { error: '用户名或密码错误' });
      }

      clearLoginFail(req, username);
      const token = randomId('tok_');
      db.sessions[token] = { username: account.username, role: account.role, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 };
      saveDB(db);
      return json(res, 200, { ok: true, token, user: { username: account.username, name: account.name || account.username, position: account.position || '产品', role: account.role, tgUsername: account.tgUsername || null, mustChangePassword: !!account.mustChangePassword } });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'GET' && url.pathname === '/auth/me') {
    const user = requireLogin(req, res, db);
    if (!user) return;
    return json(res, 200, { username: user.username, name: user.name || user.username, position: user.position || '产品', role: user.role, tgUsername: user.tgUsername || null, mustChangePassword: !!user.mustChangePassword });
  }

  if (method === 'POST' && url.pathname === '/auth/change-password') {
    const user = requireLogin(req, res, db);
    if (!user) return;
    try {
      const body = await parseBody(req);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!newPassword || newPassword.length < 8) {
        return json(res, 400, { error: '新密码至少8位' });
      }
      if (!verifyPassword(oldPassword, user.password)) {
        return json(res, 400, { error: '旧密码不正确' });
      }
      user.password = hashPassword(newPassword);
      user.mustChangePassword = false;
      user.updatedAt = dateInTZ();
      user.updatedBy = user.username;
      saveDB(db);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'POST' && url.pathname === '/auth/logout') {
    const token = req.headers['x-auth-token'];
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      saveDB(db);
    }
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && url.pathname === '/auth/resolve-tg') {
    const tgUsername = (url.searchParams.get('tgUsername') || '').trim();
    const account = db.accounts.find(a => a.enabled !== false && a.tgUsername && a.tgUsername.toLowerCase() === tgUsername.toLowerCase());
    return json(res, 200, {
      ok: true,
      username: account ? account.username : null,
      role: account ? account.role : null,
      tgUsername: account ? (account.tgUsername || null) : tgUsername || null
    });
  }

  if (method === 'GET' && url.pathname === '/accounts/suggest') {
    const user = requireLogin(req, res, db);
    if (!user) return;
    const q = normUser(url.searchParams.get('q') || '');
    const list = (db.accounts || [])
      .filter(a => a.enabled !== false)
      .map(a => ({ username: a.username, name: a.name || a.username, tgUsername: a.tgUsername || `@${a.username}` }))
      .filter(a => !q || normUser(a.username).includes(q) || normUser(a.tgUsername).includes(q) || String(a.name || '').toLowerCase().includes(q))
      .slice(0, 20);
    return json(res, 200, list);
  }

  // Admin account management
  if (method === 'GET' && url.pathname === '/admin/accounts') {
    const admin = requireSuperAdmin(req, res, db);
    if (!admin) return;
    return json(res, 200, db.accounts.map(a => ({
      username: a.username,
      name: a.name || a.username,
      position: a.position || '产品',
      tgUsername: a.tgUsername || null,
      role: a.role,
      enabled: a.enabled !== false,
      createdAt: a.createdAt
    })));
  }

  if (method === 'PATCH' && url.pathname.startsWith('/admin/accounts/')) {
    const admin = requireSuperAdmin(req, res, db);
    if (!admin) return;
    const username = decodeURIComponent(url.pathname.split('/')[3] || '');
    const account = db.accounts.find(a => a.username === username);
    if (!account) return json(res, 404, { error: '账号不存在' });

    try {
      const body = await parseBody(req);
      const allowedRoles = new Set(['member', 'admin', 'superadmin']);
      const allowedPositions = new Set(['产品', '前端', '后端', '安卓', 'iOS', '运维', '运营', 'QA']);
      if (body.password !== undefined && body.password !== '') {
        if (String(body.password).length < 8) return json(res, 400, { error: 'password 至少8位' });
        account.password = hashPassword(body.password);
        account.mustChangePassword = false;
      }
      if (body.name !== undefined) account.name = String(body.name || '').trim() || account.username;
      if (body.position !== undefined) {
        const p = String(body.position || '').trim();
        if (!allowedPositions.has(p)) return json(res, 400, { error: 'position must be one of: 产品, 前端, 后端, 安卓, iOS, 运维, 运营, QA' });
        account.position = p;
      }
      if (body.tgUsername !== undefined) account.tgUsername = body.tgUsername || null;
      if (body.role !== undefined) {
        const role = String(body.role || 'member').trim();
        if (!allowedRoles.has(role)) return json(res, 400, { error: 'role must be one of: member, admin, superadmin' });
        account.role = role;
      }
      if (body.enabled !== undefined) account.enabled = !!body.enabled;
      account.updatedAt = dateInTZ();
      account.updatedBy = admin.username;
      saveDB(db);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'POST' && url.pathname === '/admin/accounts') {
    const admin = requireSuperAdmin(req, res, db);
    if (!admin) return;
    try {
      const body = await parseBody(req);
      const allowedRoles = new Set(['member', 'admin', 'superadmin']);
      const allowedPositions = new Set(['产品', '前端', '后端', '安卓', 'iOS', '运维', '运营', 'QA']);
      const required = ['username', 'password'];
      for (const k of required) if (!body[k]) return json(res, 400, { error: `Missing field: ${k}` });
      if (db.accounts.some(a => a.username === body.username)) return json(res, 400, { error: '用户名已存在' });
      const role = String(body.role || 'member').trim();
      if (!allowedRoles.has(role)) return json(res, 400, { error: 'role must be one of: member, admin, superadmin' });
      const position = String(body.position || '产品').trim();
      if (!allowedPositions.has(position)) return json(res, 400, { error: 'position must be one of: 产品, 前端, 后端, 安卓, iOS, 运维, 运营, QA' });

      if (String(body.password).length < 8) return json(res, 400, { error: 'password 至少8位' });

      const account = {
        username: body.username,
        name: String(body.name || '').trim() || body.username,
        position,
        password: hashPassword(body.password),
        mustChangePassword: false,
        tgUsername: body.tgUsername || null,
        role,
        enabled: body.enabled !== false,
        createdAt: dateInTZ(),
        createdBy: admin.username
      };
      db.accounts.push(account);
      saveDB(db);
      return json(res, 200, { ok: true, username: account.username });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  // Subtasks
  if (method === 'POST' && /\/tasks\/[^/]+\/subtasks$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const task = db.tasks.find(t => t.taskNo === taskNo);
    if (!task) return json(res, 404, { error: 'Task not found' });

    try {
      const body = await parseBody(req);
      if (!body.title) return json(res, 400, { error: 'Missing field: title' });
      if (!body.assignee) return json(res, 400, { error: 'Missing field: assignee' });
      if (hasMultipleUsers(body.assignee)) return json(res, 400, { error: 'assignee只允许1人' });

      const assignee = normalizeSingleUserToTg(body.assignee, db);
      const needDependencyCheck = body.needDependencyCheck === true || body.needDependencyCheck === '是';
      const dependsOn = Array.isArray(body.dependsOn)
        ? body.dependsOn.map(x => Number(x)).filter(Boolean)
        : (body.dependsOn ? [Number(body.dependsOn)].filter(Boolean) : []);

      const receivedAt = normalizeDateTimeInput(body.receivedAt || body.startTime || '');
      const dueAt = normalizeDateTimeInput(body.dueAt || body.endTime || '');
      if (!receivedAt) return json(res, 400, { error: '新增子任务必须填写 receivedAt/startTime(开始时间)' });
      if (!dueAt) return json(res, 400, { error: '新增子任务必须填写 dueAt/endTime(结束时间)' });
      if (parseTZDateToEpoch(dueAt) < parseTZDateToEpoch(receivedAt)) {
        return json(res, 400, { error: '结束时间不能早于开始时间' });
      }
      const expectedCycle = calcDurationDisplay(receivedAt, dueAt);

      db.subSeq += 1;
      const now = dateInTZ();
      const nowEpoch = parseTZDateToEpoch(now);
      const startEpoch = parseTZDateToEpoch(receivedAt);
      const autoStatus = (Number.isFinite(nowEpoch) && Number.isFinite(startEpoch) && nowEpoch >= startEpoch) ? '进行中' : '待处理';

      const subtask = {
        id: db.subSeq,
        taskNo,
        title: body.title,
        description: body.description || '',
        assignee,
        watchers: normalizeCcListToTg(body.watchers || body.ccList || [], db),
        status: autoStatus,
        priority: body.priority || 'P2',
        needDependencyCheck,
        dependsOn,
        expectedCycle,
        receivedAt,
        dueAt,
        completedAt: null,
        actualHours: null,
        isDelayed: null,
        sortOrder: Number(body.sortOrder || db.subSeq),
        createdBy: user,
        createdAt: now,
        updatedAt: now,
        source: 'manual'
      };

      if (subtask.needDependencyCheck && hasUnfinishedDependencies(subtask, db)) {
        subtask.status = '待启动';
      }

      db.subtasks.push(subtask);
      addSubtaskLog(db, { subtaskId: subtask.id, action: 'create', actor: user, note: body.note || '' });
      recomputeTaskBySubtasks(taskNo, db);
      saveDB(db);
      return json(res, 200, { ok: true, subtask });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'GET' && /\/tasks\/[^/]+\/subtasks$/.test(url.pathname)) {
    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const list = db.subtasks
      .filter(s => s.taskNo === taskNo)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map(s => ({ ...s, latestNote: latestSubtaskNote(db, s.id) }));
    return json(res, 200, list);
  }

  if (method === 'GET' && url.pathname === '/subtasks') {
    const assignee = (url.searchParams.get('assignee') || '').trim();
    const project = (url.searchParams.get('project') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const activeOnly = ['1', 'true', 'yes'].includes((url.searchParams.get('activeOnly') || '').toLowerCase());
    const activeStatuses = new Set(['待处理', '待启动', '进行中']);

    let list = db.subtasks.filter(s => {
      if (assignee && !sameUser(s.assignee || '', assignee)) return false;
      if (status && s.status !== status) return false;
      if (activeOnly && !activeStatuses.has(s.status)) return false;
      if (project) {
        const task = db.tasks.find(t => t.taskNo === s.taskNo);
        if (!task || task.project !== project) return false;
      }
      return true;
    });

    list = list
      .map(s => {
        const task = db.tasks.find(t => t.taskNo === s.taskNo) || null;
        return {
          ...s,
          latestNote: latestSubtaskNote(db, s.id),
          taskName: task?.name || null,
          taskProject: task?.project || null,
          taskStatus: task?.status || null
        };
      })
      .sort((a, b) => (parseTZDateToEpoch(b.createdAt || '') || 0) - (parseTZDateToEpoch(a.createdAt || '') || 0));

    return json(res, 200, list);
  }

  if (method === 'PATCH' && /\/subtasks\/[^/]+$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const subtask = db.subtasks.find(s => s.id === id);
    if (!subtask) return json(res, 404, { error: 'Subtask not found' });
    if (!hasGlobalTaskPrivilege(req, db, user)) {
      return json(res, 403, { error: 'Only admin/superadmin can edit subtask' });
    }

    try {
      const body = await parseBody(req);
      if (body.title !== undefined) subtask.title = body.title;
      if (body.description !== undefined) subtask.description = body.description;
      if (body.priority !== undefined) subtask.priority = body.priority;
      if (body.assignee !== undefined) {
        if (hasMultipleUsers(body.assignee)) return json(res, 400, { error: 'assignee只允许1人' });
        subtask.assignee = normalizeSingleUserToTg(body.assignee, db);
      }
      if (body.watchers !== undefined || body.ccList !== undefined) {
        subtask.watchers = normalizeCcListToTg(body.watchers || body.ccList || [], db);
      }
      if (body.dependsOn !== undefined) {
        subtask.dependsOn = Array.isArray(body.dependsOn)
          ? body.dependsOn.map(x => Number(x)).filter(Boolean)
          : (body.dependsOn ? [Number(body.dependsOn)].filter(Boolean) : []);
      }
      if (body.needDependencyCheck !== undefined) {
        subtask.needDependencyCheck = body.needDependencyCheck === true || body.needDependencyCheck === '是';
      }

      if (body.expectedCycle !== undefined) {
        return json(res, 400, { error: 'expectedCycle 为系统自动计算字段，不可修改' });
      }

      if (body.receivedAt !== undefined) {
        const v = normalizeDateTimeInput(body.receivedAt);
        if (!v) return json(res, 400, { error: 'receivedAt 时间格式无效' });
        subtask.receivedAt = v;
      }

      if (body.dueAt !== undefined) {
        const v = normalizeDateTimeInput(body.dueAt);
        if (!v) return json(res, 400, { error: 'dueAt 时间格式无效' });
        subtask.dueAt = v;
      }

      if (body.completedAt !== undefined) {
        const v = normalizeDateTimeInput(body.completedAt);
        if (!v) return json(res, 400, { error: 'completedAt 时间格式无效' });
        subtask.completedAt = v;
      }

      if (body.receivedAt !== undefined || body.dueAt !== undefined) {
        if (parseTZDateToEpoch(subtask.dueAt) < parseTZDateToEpoch(subtask.receivedAt)) {
          return json(res, 400, { error: 'dueAt 不能早于开始时间' });
        }
        subtask.expectedCycle = calcDurationDisplay(subtask.receivedAt, subtask.dueAt);
      }

      if (body.receivedAt !== undefined || body.completedAt !== undefined) {
        if (parseTZDateToEpoch(subtask.completedAt) < parseTZDateToEpoch(subtask.receivedAt)) {
          return json(res, 400, { error: 'completedAt 不能早于开始时间' });
        }
      }

      if (subtask.receivedAt && subtask.completedAt) {
        subtask.actualHours = toHours(subtask.receivedAt, subtask.completedAt);
        subtask.isDelayed = subtask.dueAt ? (parseTZDateToEpoch(subtask.completedAt) > parseTZDateToEpoch(subtask.dueAt)) : null;
      }

      if (body.status !== undefined) {
        return json(res, 400, { error: 'status 由后台动作流转处理，不支持直接修改' });
      }

      if (subtask.needDependencyCheck && hasUnfinishedDependencies(subtask, db)) {
        subtask.status = '待启动';
      }

      subtask.updatedAt = dateInTZ();
      addSubtaskLog(db, { subtaskId: subtask.id, action: 'patch', actor: user, note: body.note || '', meta: body });
      recomputeTaskBySubtasks(subtask.taskNo, db);
      saveDB(db);
      return json(res, 200, { ok: true, subtask });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'POST' && /\/subtasks\/[^/]+\/start$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const subtask = db.subtasks.find(s => s.id === id);
    if (!subtask) return json(res, 404, { error: 'Subtask not found' });
    if (!canOperateSubtask(req, db, user, subtask)) {
      return json(res, 403, { error: 'Only admin/superadmin or subtask assignee can operate' });
    }

    if (subtask.needDependencyCheck && hasUnfinishedDependencies(subtask, db)) {
      subtask.status = '待启动';
      saveDB(db);
      return json(res, 400, { error: '前置任务未完成，当前子任务保持待启动' });
    }

    subtask.status = '进行中';
    if (!subtask.receivedAt) subtask.receivedAt = dateInTZ();
    // 重新进入进行中时，清空完成态字段
    subtask.completedAt = null;
    subtask.actualHours = null;
    subtask.isDelayed = null;
    subtask.updatedAt = dateInTZ();
    addSubtaskLog(db, { subtaskId: subtask.id, action: 'start', actor: user });
    saveDB(db);
    return json(res, 200, { ok: true, subtask });
  }

  if (method === 'POST' && /\/subtasks\/[^/]+\/complete$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const subtask = db.subtasks.find(s => s.id === id);
    if (!subtask) return json(res, 404, { error: 'Subtask not found' });
    if (!canOperateSubtask(req, db, user, subtask)) {
      return json(res, 403, { error: 'Only admin/superadmin or subtask assignee can operate' });
    }
    if (subtask.needDependencyCheck && hasUnfinishedDependencies(subtask, db)) {
      subtask.status = '待启动';
      saveDB(db);
      return json(res, 400, { error: '前置任务未完成，不能完成该子任务' });
    }

    subtask.status = '已完成';
    if (!subtask.receivedAt) subtask.receivedAt = dateInTZ();
    subtask.completedAt = dateInTZ();
    subtask.actualHours = toHours(subtask.receivedAt, subtask.completedAt);
    subtask.isDelayed = subtask.dueAt ? (parseTZDateToEpoch(subtask.completedAt) > parseTZDateToEpoch(subtask.dueAt)) : null;
    subtask.updatedAt = dateInTZ();
    addSubtaskLog(db, { subtaskId: subtask.id, action: 'complete', actor: user });
    recomputeTaskBySubtasks(subtask.taskNo, db);
    saveDB(db);
    return json(res, 200, { ok: true, subtask, task: db.tasks.find(t => t.taskNo === subtask.taskNo) });
  }

  if (method === 'POST' && /\/subtasks\/[^/]+\/cancel$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const subtask = db.subtasks.find(s => s.id === id);
    if (!subtask) return json(res, 404, { error: 'Subtask not found' });
    if (!canOperateSubtask(req, db, user, subtask)) {
      return json(res, 403, { error: 'Only admin/superadmin or subtask assignee can operate' });
    }

    let body = {};
    try { body = await parseBody(req); } catch {}
    subtask.status = '已取消';
    subtask.updatedAt = dateInTZ();
    addSubtaskLog(db, { subtaskId: subtask.id, action: 'cancel', actor: user, note: body.reason || '' });
    recomputeTaskBySubtasks(subtask.taskNo, db);
    saveDB(db);
    return json(res, 200, { ok: true, subtask });
  }

  if (method === 'POST' && /\/subtasks\/[^/]+\/remark$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const subtask = db.subtasks.find(s => s.id === id);
    if (!subtask) return json(res, 404, { error: 'Subtask not found' });
    if (!canOperateSubtask(req, db, user, subtask)) {
      return json(res, 403, { error: 'Only admin/superadmin or subtask assignee can operate' });
    }
    let body = {};
    try { body = await parseBody(req); } catch {}
    const note = String(body.note || body.content || '').trim();
    if (!note) return json(res, 400, { error: 'note is required' });
    subtask.updatedAt = dateInTZ();
    addSubtaskLog(db, { subtaskId: subtask.id, action: 'remark', actor: user, note });
    saveDB(db);
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && /\/subtasks\/[^/]+\/logs$/.test(url.pathname)) {
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const logs = db.subtaskLogs.filter(l => Number(l.subtaskId) === id);
    return json(res, 200, logs);
  }

  if (method === 'POST' && /\/subtasks\/[^/]+\/delete$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    if (!hasGlobalTaskPrivilege(req, db, user)) {
      return json(res, 403, { error: 'Only admin/superadmin can delete subtask' });
    }
    const id = Number(decodeURIComponent(url.pathname.split('/')[2]));
    const idx = db.subtasks.findIndex(s => s.id === id);
    if (idx < 0) return json(res, 404, { error: 'Subtask not found' });

    const subtask = db.subtasks[idx];
    db.subtasks.splice(idx, 1);
    db.subtaskLogs = db.subtaskLogs.filter(l => Number(l.subtaskId) !== id);
    recomputeTaskBySubtasks(subtask.taskNo, db);
    saveDB(db);
    return json(res, 200, { ok: true, deletedSubtaskId: id, taskNo: subtask.taskNo });
  }

  if (method === 'POST' && /\/tasks\/[^/]+\/delete$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    if (!hasGlobalTaskPrivilege(req, db, user)) {
      return json(res, 403, { error: 'Only admin/superadmin can delete task' });
    }

    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const idx = db.tasks.findIndex(t => t.taskNo === taskNo);
    if (idx < 0) return json(res, 404, { error: 'Task not found' });

    db.tasks.splice(idx, 1);
    const subIds = new Set(db.subtasks.filter(s => s.taskNo === taskNo).map(s => Number(s.id)));
    db.subtasks = db.subtasks.filter(s => s.taskNo !== taskNo);
    db.subtaskLogs = db.subtaskLogs.filter(l => !subIds.has(Number(l.subtaskId)));
    db.flows = db.flows.filter(f => f.taskNo !== taskNo);
    db.remarks = db.remarks.filter(r => r.taskNo !== taskNo);

    saveDB(db);
    return json(res, 200, { ok: true, deletedTaskNo: taskNo, deletedSubtaskCount: subIds.size });
  }

  if (method === 'POST' && /\/tasks\/[^/]+\/force-close$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });
    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const task = db.tasks.find(t => t.taskNo === taskNo);
    if (!task) return json(res, 404, { error: 'Task not found' });

    let body = {};
    try { body = await parseBody(req); } catch {}
    if (!body.reason) return json(res, 400, { error: '强制关闭必须提供reason' });

    task.status = '已完成';
    task.completedAt = dateInTZ();
    task.isDelayed = delayedFlag(task.completedAt, task.expectedReleaseDate);
    task.updatedAt = dateInTZ();

    db.subtasks
      .filter(s => s.taskNo === taskNo && s.status !== '已完成' && s.status !== '已取消')
      .forEach(s => {
        s.status = '已取消';
        s.updatedAt = dateInTZ();
        addSubtaskLog(db, { subtaskId: s.id, action: 'auto_cancel_by_force_close', actor: user, note: body.reason });
      });

    db.remarks.push({
      id: Date.now(),
      taskNo,
      author: user,
      content: `【强制关闭】${body.reason}`,
      createdAt: dateInTZ()
    });

    saveDB(db);
    return json(res, 200, { ok: true, task });
  }

  // Tasks
  if (method === 'POST' && url.pathname === '/tasks') {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });

    try {
      const body = await parseBody(req);
      const required = ['name', 'requester', 'startTime', 'endTime'];
      for (const k of required) if (!body[k]) return json(res, 400, { error: `Missing field: ${k}` });

      const startTime = normalizeDateTimeInput(body.startTime);
      const endTime = normalizeDateTimeInput(body.endTime);
      if (!startTime || !endTime) return json(res, 400, { error: 'startTime/endTime 格式无效，需为 YYYY-MM-DD HH:mm 或 YYYY-MM-DDTHH:mm' });
      if (parseTZDateToEpoch(endTime) < parseTZDateToEpoch(startTime)) return json(res, 400, { error: 'endTime 不能早于 startTime' });

      const project = body.project || '18game';
      const allowedTaskTypes = new Set(['新需求', 'bug修复', '优化']);
      const taskType = String(body.taskType || '新需求').trim();
      if (!allowedTaskTypes.has(taskType)) {
        return json(res, 400, { error: 'taskType must be one of: 新需求, bug修复, 优化' });
      }
      const allowedPriority = new Set(['P0', 'P1', 'P2', 'P3']);
      const priority = String(body.priority || 'P2').trim().toUpperCase();
      if (!allowedPriority.has(priority)) {
        return json(res, 400, { error: 'priority must be one of: P0, P1, P2, P3' });
      }
      const executor = normalizeSingleUserToTg(user, db);
      const ccList = normalizeCcListToTg(body.ccList || body.cc || body.watchers, db);
      const completedCycle = calcDurationDisplay(startTime, endTime);
      const expectedReleaseDate = endTime.slice(0, 10);

      // Duplicate-create guard: if same creator + core fields within a short window, return existing task.
      const nowMs = Date.now();
      const duplicate = [...db.tasks].reverse().find(t =>
        sameUser(t.creator, user) &&
        t.project === project &&
        (t.name || '') === (body.name || '') &&
        (t.docLink || '') === (body.docLink || '') &&
        (t.requester || '') === (body.requester || '') &&
        (t.completedCycle || '') === (completedCycle || '') &&
        (t.currentResponsibleReceivedAt || '') === startTime &&
        (t.dueAt || '') === endTime &&
        (t.currentResponsible || t.executor || '') === (executor || '') &&
        JSON.stringify(t.ccList || []) === JSON.stringify(ccList) &&
        Math.abs(nowMs - parseTZDateToEpoch(t.createdAt)) <= 15000
      );
      if (duplicate) {
        return json(res, 200, {
          ok: true,
          duplicated: true,
          taskNo: duplicate.taskNo,
          status: duplicate.status,
          dueAt: duplicate.dueAt,
          message: '检测到15秒内重复提交，已返回已创建任务'
        });
      }

      db.seq += 1;
      const prefix = project === '18game' ? '18G' : project.slice(0, 3).toUpperCase();
      const taskNo = `${prefix}-${db.seq}`;
      const createdAt = dateInTZ();
      const currentResponsibleReceivedAt = startTime;
      const task = {
        id: db.seq,
        taskNo,
        project,
        name: body.name,
        taskType,
        priority,
        docLink: body.docLink || '',
        note: body.note || '',
        requester: body.requester,
        completedCycle,
        expectedReleaseDate,
        status: '处理中',
        creator: user,
        executor,
        currentResponsible: executor,
        currentResponsibleReceivedAt,
        dueAt: endTime,
        ccList,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        isDelayed: null
      };
      db.tasks.push(task);
      db.flows.push({
        id: Date.now(),
        taskNo,
        fromResponsible: null,
        toResponsible: executor,
        receivedAt: currentResponsibleReceivedAt,
        completedCycle,
        dueAt: endTime,
        finishedAt: null,
        completionStatus: null,
        status: '处理中',
        note: body.note || null
      });
      if (body.note) db.remarks.push({ id: Date.now(), taskNo, author: user, content: body.note, createdAt: dateInTZ() });
      saveDB(db);
      return json(res, 200, { ok: true, taskNo, status: task.status, dueAt: task.dueAt, completedCycle: task.completedCycle, message: '主任务已创建，请分配子任务' });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'PATCH' && url.pathname.startsWith('/tasks/')) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });

    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const task = db.tasks.find(t => t.taskNo === taskNo);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const canEdit =
      hasGlobalTaskPrivilege(req, db, user) ||
      identityMatchesActor(task.creator, user, db) ||
      identityMatchesActor(task.requester, user, db);
    if (!canEdit) return json(res, 403, { error: 'Only creator/requester/admin/superadmin can edit core fields' });

    try {
      const body = await parseBody(req);
      if (body.expectedReleaseDate !== undefined) {
        return json(res, 400, { error: 'expectedReleaseDate 创建后不可修改' });
      }
      const editable = ['name', 'docLink', 'requester', 'project', 'note'];
      for (const k of editable) if (body[k] !== undefined) task[k] = body[k];
      if (body.docLink !== undefined && !task.docLink) task.docLink = '';
      if (body.taskType !== undefined) {
        const allowedTaskTypes = new Set(['新需求', 'bug修复', '优化']);
        const taskType = String(body.taskType || '').trim();
        if (!allowedTaskTypes.has(taskType)) return json(res, 400, { error: 'taskType must be one of: 新需求, bug修复, 优化' });
        task.taskType = taskType;
      }

      if (body.completedCycle !== undefined) {
        return json(res, 400, { error: 'completedCycle 为系统自动计算字段，不可修改' });
      }

      if (body.currentResponsibleReceivedAt !== undefined) {
        const v = normalizeDateTimeInput(body.currentResponsibleReceivedAt);
        if (!v) {
          return json(res, 400, { error: 'currentResponsibleReceivedAt 时间格式无效' });
        }
        task.currentResponsibleReceivedAt = v;
      }

      if (body.dueAt !== undefined) {
        const v = normalizeDateTimeInput(body.dueAt);
        if (!v) return json(res, 400, { error: 'dueAt 时间格式无效' });
        task.dueAt = v;
      }

      if (body.priority !== undefined) {
        const allowedPriority = new Set(['P0', 'P1', 'P2', 'P3']);
        const priority = String(body.priority || '').trim().toUpperCase();
        if (!allowedPriority.has(priority)) return json(res, 400, { error: 'priority must be one of: P0, P1, P2, P3' });
        task.priority = priority;
      }
      if (body.executor !== undefined || body.currentResponsible !== undefined) {
        const rawNext = body.currentResponsible || body.executor || '';
        if (hasMultipleUsers(rawNext)) return json(res, 400, { error: '当前执行人只能填写1人' });
        const nextResponsible = normalizeSingleUserToTg(rawNext, db);
        if (nextResponsible) {
          task.executor = nextResponsible;
          task.currentResponsible = nextResponsible;
          task.currentResponsibleReceivedAt = dateInTZ();
        }
      }
      if (body.ccList !== undefined) {
        task.ccList = normalizeCcListToTg(body.ccList, db);
      }
      if (body.currentResponsibleReceivedAt !== undefined || body.dueAt !== undefined || body.executor !== undefined || body.currentResponsible !== undefined) {
        if (parseTZDateToEpoch(task.dueAt) < parseTZDateToEpoch(task.currentResponsibleReceivedAt || task.createdAt)) {
          return json(res, 400, { error: 'dueAt 不能早于开始时间' });
        }
        task.completedCycle = calcDurationDisplay(task.currentResponsibleReceivedAt || task.createdAt, task.dueAt);
        task.expectedReleaseDate = String(task.dueAt || '').slice(0, 10);
        const currentOpenFlow = [...db.flows].reverse().find(f =>
          f.taskNo === taskNo &&
          sameUser(f.toResponsible || f.fromResponsible, task.currentResponsible) &&
          (!f.finishedAt || f.status === '处理中')
        );
        if (currentOpenFlow) {
          currentOpenFlow.completedCycle = task.completedCycle;
          currentOpenFlow.receivedAt = task.currentResponsibleReceivedAt || currentOpenFlow.receivedAt;
          currentOpenFlow.dueAt = task.dueAt || null;
        }
      }
      task.updatedAt = dateInTZ();
      saveDB(db);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'POST' && /\/tasks\/[^/]+\/advance$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });

    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const task = db.tasks.find(t => t.taskNo === taskNo);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const canOperate =
      hasGlobalTaskPrivilege(req, db, user) ||
      identityMatchesActor(task.currentResponsible, user, db) ||
      identityMatchesActor(task.requester, user, db);
    if (!canOperate) {
      return json(res, 403, {
        error: 'Only requester/current responsible/admin/superadmin can transfer/complete',
        requester: task.requester,
        currentResponsible: task.currentResponsible,
        yourIdentity: user
      });
    }
    if (task.status === '已完成') return json(res, 400, { error: 'Task already completed' });

    try {
      const body = await parseBody(req);
      if (body.nextResponsible && hasMultipleUsers(body.nextResponsible)) {
        return json(res, 400, { error: '流转目标只能填写1人' });
      }
      const nextResponsible = body.nextResponsible ? normalizeSingleUserToTg(body.nextResponsible, db) : null;
      const stepCompletedCycle = (body.stepCompletedCycle || body.completedCycle || body.flowCompletedCycle || '').toString().trim() || null;

      const stepFinishedAt = dateInTZ();
      const currentFlow = [...db.flows].reverse().find(f =>
        f.taskNo === taskNo &&
        sameUser(f.toResponsible || f.fromResponsible, task.currentResponsible) &&
        (!f.finishedAt || f.status === '处理中')
      );

      if (currentFlow) {
        if (stepCompletedCycle) {
          currentFlow.completedCycle = stepCompletedCycle;
          currentFlow.dueAt = calcDueAtFrom(currentFlow.receivedAt || task.currentResponsibleReceivedAt || task.createdAt, stepCompletedCycle) || currentFlow.dueAt || task.dueAt;
        } else if (!currentFlow.completedCycle) {
          currentFlow.completedCycle = task.completedCycle;
        }
        currentFlow.finishedAt = stepFinishedAt;
        currentFlow.completionStatus = stepResultByDue(stepFinishedAt, currentFlow.dueAt || task.dueAt);
        currentFlow.status = flowStatusLabel(currentFlow.completionStatus);
        if (body.note) currentFlow.note = body.note;
      }

      const stepCompletionStatus = currentFlow
        ? currentFlow.completionStatus
        : stepResultByDue(stepFinishedAt, task.dueAt);
      const stepStatus = flowStatusLabel(stepCompletionStatus);

      if (!currentFlow) {
        db.flows.push({
          id: Date.now(),
          taskNo,
          fromResponsible: task.currentResponsible,
          toResponsible: nextResponsible,
          receivedAt: task.currentResponsibleReceivedAt || task.createdAt || null,
          completedCycle: stepCompletedCycle || task.completedCycle || null,
          dueAt: task.dueAt || null,
          finishedAt: stepFinishedAt,
          completionStatus: stepCompletionStatus,
          status: stepStatus,
          note: body.note || null
        });
      }

      if (nextResponsible) {
        const previousResponsible = task.currentResponsible;
        const receivedAt = stepFinishedAt;
        const nextStepCycle = stepCompletedCycle || task.completedCycle;
        task.currentResponsible = nextResponsible;
        task.executor = nextResponsible;
        task.currentResponsibleReceivedAt = receivedAt;
        task.completedCycle = nextStepCycle;
        task.dueAt = calcDueAtFrom(receivedAt, nextStepCycle);
        task.updatedAt = receivedAt;

        db.flows.push({
          id: Date.now() + 1,
          taskNo,
          fromResponsible: previousResponsible,
          toResponsible: nextResponsible,
          receivedAt,
          completedCycle: nextStepCycle,
          dueAt: task.dueAt || null,
          finishedAt: null,
          completionStatus: null,
          status: '处理中',
          note: null
        });

        saveDB(db);
        return json(res, 200, {
          ok: true,
          message: `已流转给 ${nextResponsible}`,
          status: task.status,
          dueAt: task.dueAt,
          completedCycle: task.completedCycle,
          stepCompletionStatus,
          stepStatus,
          stepNote: body.note || null
        });
      }

      const taskSubtasks = db.subtasks.filter(s => s.taskNo === taskNo);
      if (taskSubtasks.length > 0) {
        const incomplete = taskSubtasks.filter(s => s.status !== '已完成');
        if (incomplete.length > 0) {
          return json(res, 400, {
            error: '子任务未全部完成，主任务不可完成',
            taskNo,
            totalSubtasks: taskSubtasks.length,
            incompleteCount: incomplete.length,
            incompleteSubtasks: incomplete.slice(0, 20).map(s => ({ id: s.id, title: s.title, status: s.status }))
          });
        }
      }

      task.status = '已完成';
      task.completedAt = stepFinishedAt;
      task.isDelayed = delayedFlag(task.completedAt, task.expectedReleaseDate);
      task.updatedAt = stepFinishedAt;
      saveDB(db);
      return json(res, 200, {
        ok: true,
        message: '任务已完成',
        status: task.status,
        isDelayed: task.isDelayed,
        completedCycle: stepCompletedCycle || currentFlow?.completedCycle || task.completedCycle,
        stepCompletionStatus,
        stepStatus,
        stepNote: body.note || null
      });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'POST' && /\/tasks\/[^/]+\/remarks$/.test(url.pathname)) {
    const user = getActor(req, db);
    if (!user) return json(res, 401, { error: 'Missing X-User or X-Auth-Token' });

    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const task = db.tasks.find(t => t.taskNo === taskNo);
    if (!task) return json(res, 404, { error: 'Task not found' });

    try {
      const body = await parseBody(req);
      if (!body.content) return json(res, 400, { error: 'Missing content' });
      db.remarks.push({ id: Date.now(), taskNo, author: user, content: body.content, createdAt: dateInTZ() });
      saveDB(db);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
  }

  if (method === 'GET' && url.pathname === '/tasks/export-template') {
    const user = requireLogin(req, res, db);
    if (!user) return;

    const taskHeaders = ['任务名称', '任务类型', '优先级', '文档链接', '提出人', '抄送', '开始时间', '结束时间', '项目', '备注'];
    const subtaskHeaders = ['主任务ID', '子任务名称', '子任务描述', '负责人', '关注人/抄送', '优先级', '开始时间', '结束时间', '前置子任务ID', '备注'];

    const refTask = (db.tasks || []).find(t => String(t.taskNo || '').trim() === '18G-1051');
    const refSubtask = (db.subtasks || []).find(s => String(s.taskNo || '').trim() === '18G-1051');

    const taskExample = {
      '任务名称': refTask?.name || '示例：支付链路联调优化',
      '任务类型': refTask?.taskType || '新需求',
      '优先级': refTask?.priority || 'P2',
      '文档链接': refTask?.docLink || 'https://docs.example.com/xxx',
      '提出人': refTask?.requester || '@chenyan219',
      '抄送': Array.isArray(refTask?.ccList) ? refTask.ccList.join(',') : '@pm,@qa',
      '开始时间': refTask?.currentResponsibleReceivedAt || '2026-04-07 10:00',
      '结束时间': refTask?.dueAt || '2026-04-09 18:00',
      '项目': refTask?.project || '18game',
      '备注': refTask?.note || '示例：这里填写主任务备注'
    };

    const subtaskExample = {
      '主任务ID': '18G-1051',
      '子任务名称': refSubtask?.title || '示例：回调签名校验',
      '子任务描述': refSubtask?.description || '示例：完成支付回调签名校验与重试逻辑',
      '负责人': refSubtask?.assignee || '@dev01',
      '关注人/抄送': Array.isArray(refSubtask?.watchers) ? refSubtask.watchers.join(',') : '@pm,@qa',
      '优先级': refSubtask?.priority || 'P2',
      '开始时间': refSubtask?.receivedAt || '2026-04-07 10:00',
      '结束时间': refSubtask?.dueAt || '2026-04-08 18:00',
      '前置子任务ID': Array.isArray(refSubtask?.dependsOn) ? refSubtask.dependsOn.join(',') : '',
      '备注': latestSubtaskNote(db, refSubtask?.id) || '示例：这里填写子任务备注'
    };

    const taskTipRow = { '任务名称': '模板格式仅供参考，使用后请删除' };
    const subtaskTipRow = { '主任务ID': '模板格式仅供参考，使用后请删除' };

    const taskCsv = toCsv([taskExample, taskTipRow], taskHeaders);
    const subtaskCsv = toCsv([subtaskExample, subtaskTipRow], subtaskHeaders);

    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXPORTS_DIR, 'task.csv'), taskCsv, 'utf8');
    fs.writeFileSync(path.join(EXPORTS_DIR, 'subtask.csv'), subtaskCsv, 'utf8');

    const dlToken = encodeURIComponent(String(req.headers['x-auth-token'] || ''));
    return json(res, 200, {
      ok: true,
      files: {
        task: `/exports/task.csv?token=${dlToken}`,
        subtask: `/exports/subtask.csv?token=${dlToken}`
      }
    });
  }

  if (method === 'POST' && url.pathname === '/tasks/import-batch') {
    const user = requireLogin(req, res, db);
    if (!user) return;
    try {
      const body = await parseBody(req);
      const taskFilename = String(body.taskFilename || '').trim();
      const subtaskFilename = String(body.subtaskFilename || '').trim();
      if (taskFilename && !['task.xlsx', 'task.csv'].includes(taskFilename)) {
        return json(res, 400, { error: '任务文件名仅允许 task.xlsx / task.csv' });
      }
      if (subtaskFilename && !['subtask.xlsx', 'subtask.csv'].includes(subtaskFilename)) {
        return json(res, 400, { error: '子任务文件名仅允许 subtask.xlsx / subtask.csv' });
      }

      const taskRows = Array.isArray(body.tasks) ? body.tasks : parseCsv(body.tasksCsv || '');
      const subtaskRows = Array.isArray(body.subtasks) ? body.subtasks : parseCsv(body.subtasksCsv || '');
      const dbNext = JSON.parse(JSON.stringify(db));

      const pick = (row, keys = []) => {
        for (const k of keys) {
          const v = row?.[k];
          if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
      };

      const existingTaskNames = new Set((dbNext.tasks || []).map(t => String(t.name || '').trim()));
      const incomingTaskNames = new Set();
      for (const r of taskRows) {
        const name = pick(r, ['任务名称', 'name']);
        const requester = pick(r, ['提出人', 'requester']);
        const startTime = normalizeDateTimeInput(pick(r, ['开始时间', 'startTime']));
        const endTime = normalizeDateTimeInput(pick(r, ['结束时间', 'endTime']));
        if (!name || !requester || !startTime || !endTime) {
          return json(res, 400, { error: 'task 导入失败：name/requester/startTime/endTime 为必填且格式正确' });
        }
        if (incomingTaskNames.has(name) || existingTaskNames.has(name)) {
          return json(res, 400, { error: `task 导入失败：任务标题重复 ${name}` });
        }
        incomingTaskNames.add(name);
      }

      for (const r of taskRows) {
        dbNext.seq += 1;
        const project = pick(r, ['项目', 'project']) || '18game';
        const prefix = project === '18game' ? '18G' : project.slice(0, 3).toUpperCase();
        const taskNo = `${prefix}-${dbNext.seq}`;
        const startTime = normalizeDateTimeInput(pick(r, ['开始时间', 'startTime']));
        const endTime = normalizeDateTimeInput(pick(r, ['结束时间', 'endTime']));
        const task = {
          id: dbNext.seq,
          taskNo,
          project,
          name: pick(r, ['任务名称', 'name']),
          taskType: pick(r, ['任务类型', 'taskType']) || '新需求',
          priority: (pick(r, ['优先级', 'priority']) || 'P2').toUpperCase(),
          docLink: pick(r, ['文档链接', 'docLink']),
          note: pick(r, ['备注', 'note']),
          requester: pick(r, ['提出人', 'requester']),
          completedCycle: calcDurationDisplay(startTime, endTime),
          expectedReleaseDate: endTime.slice(0, 10),
          status: '处理中',
          creator: user.username,
          executor: normalizeSingleUserToTg(user.username, dbNext),
          currentResponsible: normalizeSingleUserToTg(user.username, dbNext),
          currentResponsibleReceivedAt: startTime,
          dueAt: endTime,
          ccList: normalizeCcListToTg(pick(r, ['抄送', 'ccList']).split(/[，,\s]+/).filter(Boolean), dbNext),
          createdAt: dateInTZ(),
          updatedAt: dateInTZ(),
          completedAt: null,
          isDelayed: null
        };
        dbNext.tasks.push(task);
        dbNext.flows.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          taskNo,
          fromResponsible: null,
          toResponsible: task.currentResponsible,
          receivedAt: startTime,
          completedCycle: task.completedCycle,
          dueAt: endTime,
          finishedAt: null,
          completionStatus: null,
          status: '处理中',
          note: task.note || null
        });
      }

      for (const r of subtaskRows) {
        const taskNo = pick(r, ['主任务ID', 'taskNo']);
        const resolvedTaskNo = (dbNext.tasks.find(t => t.taskNo === taskNo) && taskNo) || '';
        if (!resolvedTaskNo) return json(res, 400, { error: `subtask 导入失败：主任务ID不存在 ${taskNo}` });
        const startTime = normalizeDateTimeInput(pick(r, ['开始时间', 'startTime']));
        const endTime = normalizeDateTimeInput(pick(r, ['结束时间', 'endTime']));
        if (!startTime || !endTime) return json(res, 400, { error: 'subtask 导入失败：startTime/endTime 必填' });

        dbNext.subSeq += 1;
        const subtask = {
          id: dbNext.subSeq,
          taskNo: resolvedTaskNo,
          title: pick(r, ['子任务名称', 'title']),
          description: pick(r, ['子任务描述', 'description']),
          assignee: normalizeSingleUserToTg(pick(r, ['负责人', 'assignee']), dbNext),
          watchers: normalizeCcListToTg(pick(r, ['关注人/抄送', 'watchers']).split(/[，,\s]+/).filter(Boolean), dbNext),
          status: '待处理',
          priority: (pick(r, ['优先级', 'priority']) || 'P2').toUpperCase(),
          needDependencyCheck: false,
          dependsOn: pick(r, ['前置子任务ID', 'dependsOn']).split(/[，,\s]+/).map(x => Number(x)).filter(Boolean),
          expectedCycle: calcDurationDisplay(startTime, endTime),
          receivedAt: startTime,
          dueAt: endTime,
          completedAt: null,
          actualHours: null,
          isDelayed: null,
          sortOrder: dbNext.subSeq,
          createdBy: user.username,
          createdAt: dateInTZ(),
          updatedAt: dateInTZ(),
          source: 'import'
        };
        if (!subtask.title || !subtask.assignee) return json(res, 400, { error: 'subtask 导入失败：title/assignee 必填' });
        dbNext.subtasks.push(subtask);
      }

      saveDB(dbNext);
      return json(res, 200, { ok: true, importedTasks: taskRows.length, importedSubtasks: subtaskRows.length });
    } catch {
      return json(res, 400, { error: 'Invalid import payload' });
    }
  }

  if (method === 'GET' && url.pathname === '/tasks/export-all') {
    const user = requireLogin(req, res, db);
    if (!user) return;

    const project = url.searchParams.get('project') || '18game';
    const tasks = (db.tasks || []).filter(t => t.project === project);
    const taskNos = new Set(tasks.map(t => t.taskNo));
    const subtasks = (db.subtasks || []).filter(s => taskNos.has(s.taskNo));

    const taskHeaders = ['任务名称', '任务类型', '优先级', '文档链接', '提出人', '抄送', '开始时间', '结束时间', '项目', '备注'];
    const subtaskHeaders = ['主任务ID', '子任务名称', '子任务描述', '负责人', '关注人/抄送', '优先级', '开始时间', '结束时间', '前置子任务ID', '备注'];

    const taskRows = tasks.map(t => ({
      '任务名称': t.name || '',
      '任务类型': t.taskType || '新需求',
      '优先级': t.priority || 'P2',
      '文档链接': t.docLink || '',
      '提出人': t.requester || '',
      '抄送': Array.isArray(t.ccList) ? t.ccList.join(',') : '',
      '开始时间': t.currentResponsibleReceivedAt || t.createdAt || '',
      '结束时间': t.dueAt || '',
      '项目': t.project || '',
      '备注': t.note || ''
    }));
    const subtaskRows = subtasks.map(s => ({
      '主任务ID': s.taskNo || '',
      '子任务名称': s.title || '',
      '子任务描述': s.description || '',
      '负责人': s.assignee || '',
      '关注人/抄送': Array.isArray(s.watchers) ? s.watchers.join(',') : '',
      '优先级': s.priority || 'P2',
      '开始时间': s.receivedAt || '',
      '结束时间': s.dueAt || '',
      '前置子任务ID': Array.isArray(s.dependsOn) ? s.dependsOn.join(',') : '',
      '备注': latestSubtaskNote(db, s.id)
    }));

    const taskCsv = toCsv(taskRows, taskHeaders);
    const subtaskCsv = toCsv(subtaskRows, subtaskHeaders);

    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXPORTS_DIR, 'task.csv'), taskCsv, 'utf8');
    fs.writeFileSync(path.join(EXPORTS_DIR, 'subtask.csv'), subtaskCsv, 'utf8');

    const dlToken = encodeURIComponent(String(req.headers['x-auth-token'] || ''));
    return json(res, 200, {
      ok: true,
      files: {
        task: `/exports/task.csv?token=${dlToken}`,
        subtask: `/exports/subtask.csv?token=${dlToken}`
      }
    });
  }

  if (method === 'GET' && url.pathname === '/tasks') {
    const project = url.searchParams.get('project') || '18game';
    const status = url.searchParams.get('status');
    const creator = url.searchParams.get('creator');
    const requester = url.searchParams.get('requester');
    const currentResponsible = url.searchParams.get('currentResponsible');
    const subtaskAssignee = url.searchParams.get('subtaskAssignee');
    const taskName = (url.searchParams.get('taskName') || '').trim();
    const subtaskName = (url.searchParams.get('subtaskName') || '').trim();
    const watcher = url.searchParams.get('watcher');
    const view = url.searchParams.get('view'); // history

    const tasks = db.tasks.filter(t => {
      const ccList = t.ccList || [];
      const basicWatchHit = !watcher || [t.creator, t.requester, t.currentResponsible, t.executor, ...ccList].some(u => sameUser(u, watcher));
      const subtaskWatchHit = !!watcher && db.subtasks.some(s =>
        s.taskNo === t.taskNo && (
          sameUser(s.assignee || '', watcher) ||
          (Array.isArray(s.watchers) && s.watchers.some(w => sameUser(w, watcher))) ||
          sameUser(s.createdBy || '', watcher)
        )
      );
      const watchHit = basicWatchHit || subtaskWatchHit;

      if (!watchHit) return false;
      if (t.project !== project) return false;
      if (status && t.status !== status) return false;
      if (creator && !(sameUser(t.creator, creator) || identityMatchesActor(t.creator, creator, db))) return false;
      if (requester && !(sameUser(t.requester, requester) || identityMatchesActor(t.requester, requester, db))) return false;
      if (currentResponsible && !(sameUser(t.currentResponsible, currentResponsible) || identityMatchesActor(t.currentResponsible, currentResponsible, db))) return false;
      if (taskName) {
        const tn = String(t.name || '').toLowerCase();
        if (!tn.includes(taskName.toLowerCase())) return false;
      }
      if (subtaskAssignee) {
        const hit = db.subtasks.some(s => s.taskNo === t.taskNo && (sameUser(s.assignee || '', subtaskAssignee) || identityMatchesActor(s.assignee || '', subtaskAssignee, db)));
        if (!hit) return false;
      }
      if (subtaskName) {
        const hit = db.subtasks.some(s => s.taskNo === t.taskNo && String(s.title || '').toLowerCase().includes(subtaskName.toLowerCase()));
        if (!hit) return false;
      }

      if (view === 'history' && watcher) {
        const done = t.status === '已完成';
        const handedOver = t.status === '处理中' && !sameUser(t.currentResponsible, watcher);
        return done || handedOver;
      }

      return true;
    }).map(t => {
      const currentFlow = [...db.flows].reverse().find(f =>
        f.taskNo === t.taskNo &&
        sameUser(f.toResponsible || f.fromResponsible, t.currentResponsible) &&
        (!f.finishedAt || f.status === '处理中')
      );
      const currentFlowStatus = currentFlow?.status || '处理中';
      return { ...t, ccList: normalizeCcListToTg(t.ccList || [], db), currentFlowStatus };
    }).sort((a, b) => {
      const bt = parseTZDateToEpoch(b.createdAt || '') || 0;
      const at = parseTZDateToEpoch(a.createdAt || '') || 0;
      return bt - at;
    });
    return json(res, 200, tasks);
  }

  if (method === 'GET' && url.pathname.startsWith('/tasks/')) {
    const taskNo = decodeURIComponent(url.pathname.split('/')[2]);
    const task = db.tasks.find(t => t.taskNo === taskNo);
    if (!task) return json(res, 404, { error: 'Task not found' });
    const taskOut = { ...task, ccList: normalizeCcListToTg(task.ccList || [], db) };
    return json(res, 200, {
      task: taskOut,
      remarks: db.remarks.filter(r => r.taskNo === taskNo),
      flows: db.flows.filter(f => f.taskNo === taskNo),
      subtasks: db.subtasks
        .filter(s => s.taskNo === taskNo)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .map(s => ({ ...s, latestNote: latestSubtaskNote(db, s.id) }))
    });
  }

  if (method === 'GET' && url.pathname === '/reports/daily') {
    const project = url.searchParams.get('project') || '18game';
    return json(res, 200, buildDailySummary(db, project));
  }

  if (method === 'GET' && url.pathname === '/reports/dashboard') {
    const project = url.searchParams.get('project') || '18game';
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const granularity = (url.searchParams.get('granularity') || 'day').trim();
    return json(res, 200, buildDashboardStats(db, { project, from, to, granularity }));
  }

  return json(res, 404, { error: 'Not Found' });
});

server.listen(PORT, BIND_HOST, () => {
  const db = loadDB();
  saveDB(db);
  console.log(`Task system running on http://${BIND_HOST}:${PORT}`);
});
