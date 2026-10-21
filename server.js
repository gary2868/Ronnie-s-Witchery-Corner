const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const CONFIG = {
  port: Number(process.env.PORT || 3000),
  officialUrl: process.env.OFFICIAL_URL || 'https://example.com/',
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  slotMinutes: 30,
  maxAdvanceMonths: 3,
  services: [
    { id: 'tarot-numerology', name: '靈魂藍圖與塔羅諮詢', description: '完整約 60 分鐘（建議預留 70 分鐘，含前置靜心與整理）', price: 1400, durationMinutes: 60, active: true, sortOrder: 1 },
    { id: 'chakra', name: '脈輪清理與身心調頻', description: '完整約 60 分鐘（建議預留 70 分鐘，含前置說明與靜息落地）', price: 1900, durationMinutes: 60, active: true, sortOrder: 2 },
    { id: 'reiki-massage', name: '靈氣芳療身心流動按摩', description: '完整約 120 分鐘（建議預留 135 分鐘，含更衣靜息）', price: 2800, durationMinutes: 120, active: true, sortOrder: 3 }
  ],
  schedule: {
    0: [['09:00', '20:00']],
    1: [['09:00', '20:00']],
    2: [['09:00', '20:00']],
    3: [['09:00', '20:00']],
    4: [['09:00', '20:00']],
    5: [['09:00', '20:00']],
    6: [['09:00', '20:00']]
  }
};

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
if (fs.existsSync(SETTINGS_FILE)) {
  try {
    const savedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (Array.isArray(savedSettings.services)) CONFIG.services = savedSettings.services;
    if (savedSettings.schedule && typeof savedSettings.schedule === 'object') CONFIG.schedule = savedSettings.schedule;
    if (Number.isInteger(savedSettings.slotMinutes) && savedSettings.slotMinutes > 0) CONFIG.slotMinutes = savedSettings.slotMinutes;
    if (Number.isInteger(savedSettings.maxAdvanceMonths) && savedSettings.maxAdvanceMonths > 0) CONFIG.maxAdvanceMonths = savedSettings.maxAdvanceMonths;
    if (typeof savedSettings.officialUrl === 'string') CONFIG.officialUrl = savedSettings.officialUrl;
  } catch {}
}
const RESERVATIONS_FILE = path.join(DATA_DIR, 'reservations.json');
const CLOSURES_FILE = path.join(DATA_DIR, 'closures.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RESERVATIONS_FILE)) fs.writeFileSync(RESERVATIONS_FILE, '[]', 'utf8');
if (!fs.existsSync(CLOSURES_FILE)) fs.writeFileSync(CLOSURES_FILE, '[]', 'utf8');
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '[]', 'utf8');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '5144';

const sessions = new Map();
const loginAttempts = new Map();
const manageAttempts = new Map();
let writeQueue = Promise.resolve();
const STORAGE_MODE = String(process.env.STORAGE_MODE || 'local').toLowerCase();
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const INTEGRATION_WORKER_URL = String(process.env.INTEGRATION_WORKER_URL || '').replace(/\/$/, '');
const INTEGRATION_WORKER_SECRET = String(process.env.INTEGRATION_WORKER_SECRET || '');
const dirtyDatasets = new Set();

function datasetForFile(file) {
  if (file === RESERVATIONS_FILE) return 'reservations';
  if (file === CUSTOMERS_FILE) return 'customers';
  if (file === CLOSURES_FILE) return 'closures';
  return null;
}
function assertSupabaseConfig() {
  if (STORAGE_MODE === 'supabase' && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('STORAGE_MODE=supabase 時必須設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY');
  }
}
async function supabaseRequest(table, method='GET', body=null, query='') {
  assertSupabaseConfig();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${table} failed (${r.status}): ${text}`);
  return text ? JSON.parse(text) : [];
}
function normalizeRemoteDataset(key, value) {
  if (!Array.isArray(value)) return [];
  if (key === 'reservations') return value.map(r => ({
    ...r,
    bookingCode: r.bookingCode ?? r.booking_code ?? '',
    birthDate: r.birthDate ?? r.birth_date ?? '',
    lineId: r.lineId ?? r.line_id ?? '',
    serviceId: r.serviceId ?? r.service_id,
    serviceName: r.serviceName ?? r.service_name,
    durationMinutes: r.durationMinutes ?? r.duration_minutes,
    startTime: r.startTime ?? r.start_time,
    endTime: r.endTime ?? r.end_time,
    createdAt: r.createdAt ?? r.created_at,
    updatedAt: r.updatedAt ?? r.updated_at,
    cancelledAt: r.cancelledAt ?? r.cancelled_at,
    customerId: r.customerId ?? r.customer_id
  }));
  if (key === 'customers') return value.map(c => {
    const history = Array.isArray(c.history) ? c.history : [];
    const historyTags = [...new Set(
      history.flatMap(h => Array.isArray(h?.tags) ? h.tags : [])
        .map(x => String(x).trim())
        .filter(Boolean)
    )].slice(0, 30);
    return {
      ...c,
      birthDate: c.birthDate ?? c.birth_date ?? '',
      lineId: c.lineId ?? c.line_id ?? '',
      createdAt: c.createdAt ?? c.created_at,
      updatedAt: c.updatedAt ?? c.updated_at,
      history,
      tags: historyTags
    };
  });
  if (key === 'closures') return value.map(c => ({...c, startTime:c.startTime ?? c.start_time, endTime:c.endTime ?? c.end_time, createdAt:c.createdAt ?? c.created_at}));
  return value;
}
async function loadReservationMetaFromSupabase() {
  if (STORAGE_MODE !== 'supabase') return {};
  try {
    const rows = await supabaseRequest('app_state', 'GET', null, '?select=value&key=eq.reservation_meta&limit=1');
    const value = rows?.[0]?.value;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    console.warn('Reservation metadata state unavailable; continuing without it:', error.message);
    return {};
  }
}

async function saveReservationMetaToSupabase(reservations) {
  if (STORAGE_MODE !== 'supabase') return;
  const value = {};
  for (const item of (Array.isArray(reservations) ? reservations : [])) {
    const meta = {};
    if (item.myNote) meta.myNote = item.myNote;
    if (item.statusLabel) meta.statusLabel = item.statusLabel;
    if (item.otherStatus) meta.otherStatus = item.otherStatus;
    if (Array.isArray(item.tags) && item.tags.length) meta.tags = item.tags;
    if (Object.keys(meta).length) value[item.id] = meta;
  }
  await supabaseRequest('app_state', 'DELETE', null, '?key=eq.reservation_meta');
  await supabaseRequest('app_state', 'POST', {
    key: 'reservation_meta',
    value,
    updated_at: new Date().toISOString()
  });
}

function mergeReservationMeta(reservations, meta) {
  if (!Array.isArray(reservations) || !meta || typeof meta !== 'object') return reservations;
  for (const item of reservations) {
    const saved = meta[item.id];
    if (!saved || typeof saved !== 'object') continue;
    if (typeof saved.myNote === 'string') item.myNote = saved.myNote;
    if (typeof saved.statusLabel === 'string') item.statusLabel = saved.statusLabel;
    if (typeof saved.otherStatus === 'string') item.otherStatus = saved.otherStatus;
    if (Array.isArray(saved.tags)) item.tags = saved.tags;
  }
  return reservations;
}

async function hydrateFromSupabase() {
  if (STORAGE_MODE !== 'supabase') return;

  const reservationRows = await supabaseRequest('reservations', 'GET', null, '?select=*');
  const reservationMeta = await loadReservationMetaFromSupabase();
  const customerRows = await supabaseRequest('customers', 'GET', null, '?select=*');
  const closureRows = await supabaseRequest('closures', 'GET', null, '?select=*');

  const normalizedReservations = mergeReservationMeta(
    normalizeRemoteDataset('reservations', reservationRows),
    reservationMeta
  );
  atomicWrite(RESERVATIONS_FILE, normalizedReservations);
  atomicWrite(CUSTOMERS_FILE, normalizeRemoteDataset('customers', customerRows));
  atomicWrite(CLOSURES_FILE, normalizeRemoteDataset('closures', closureRows));

  dirtyDatasets.clear();
}

/*
 * SUPABASE WRITE WHITELIST
 * reservations: exactly 19 columns
 * id, booking_code, name, birth_date, phone, line_id, note,
 * service_id, service_name, duration_minutes, date, start_time, end_time,
 * service_slots, slots, status, created_at, updated_at, cancelled_at
 * customers: exactly 8 columns
 * id, name, birth_date, phone, line_id, created_at, updated_at, history
 * closures: exactly 5 columns
 * id, date, start_time, end_time, created_at
 * No other top-level fields are sent to these three tables.
 */
function supabaseRowFromReservation(item) {
  // IMPORTANT: public.reservations currently has exactly 19 columns.
  // Only send those 19 columns to Supabase. Do not send application-only
  // fields such as myNote, statusLabel, otherStatus, tags, or customerId.
  return {
    id: item.id,
    booking_code: item.bookingCode || '',
    name: item.name,
    birth_date: item.birthDate || item.birth_date || '',
    phone: item.phone || '',
    line_id: item.lineId || '',
    note: item.note || '',
    service_id: item.serviceId,
    service_name: item.serviceName,
    duration_minutes: item.durationMinutes,
    date: item.date,
    start_time: item.startTime,
    end_time: item.endTime,
    service_slots: Array.isArray(item.serviceSlots) ? item.serviceSlots : [],
    slots: Array.isArray(item.slots) ? item.slots : [],
    status: item.status || 'CONFIRMED',
    created_at: item.createdAt || new Date().toISOString(),
    updated_at: item.updatedAt || new Date().toISOString(),
    cancelled_at: item.cancelledAt || null
  };
}

function supabaseRowFromCustomer(item) {
  /*
   * public.customers whitelist: exactly 8 columns
   * id, name, birth_date, phone, line_id, created_at, updated_at, history
   *
   * tags are application data, not a top-level DB column. They are kept
   * inside each history entry's JSON so the existing admin tag feature
   * remains available without changing the Supabase schema.
   */
  const history = Array.isArray(item.history)
    ? item.history.map(h => ({
        ...h,
        tags: Array.isArray(h?.tags) ? h.tags : []
      }))
    : [];
  return {
    id: String(item.id || crypto.randomUUID()),
    name: String(item.name || ''),
    birth_date: item.birthDate || item.birth_date || '',
    phone: String(item.phone || ''),
    line_id: String(item.lineId || item.line_id || ''),
    created_at: item.createdAt || item.created_at || new Date().toISOString(),
    updated_at: item.updatedAt || item.updated_at || new Date().toISOString(),
    history
  };
}

function supabaseRowFromClosure(item) {
  /* public.closures whitelist: exactly 5 columns */
  return {
    id: String(item.id || crypto.randomUUID()),
    date: item.date || '',
    start_time: item.startTime || null,
    end_time: item.endTime || null,
    created_at: item.createdAt || item.created_at || new Date().toISOString()
  };
}

async function readSupabaseSnapshot(table) {
  const pageSize = 500;
  const rows = [];
  let offset = 0;

  while (true) {
    const page = await supabaseRequest(
      table,
      'GET',
      null,
      `?select=*&order=id.asc&limit=${pageSize}&offset=${offset}`
    );
    if (!Array.isArray(page)) {
      throw new Error(`Supabase ${table} snapshot returned a non-array response`);
    }
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
}

async function syncDataset(key, data) {
  if (STORAGE_MODE !== 'supabase') return;

  const table = key === 'reservations' ? 'reservations'
    : key === 'customers' ? 'customers'
    : key === 'closures' ? 'closures'
    : null;

  if (!table) return;

  const rows = Array.isArray(data) ? data : [];
  const mapped = key === 'reservations'
    ? rows.map(supabaseRowFromReservation)
    : key === 'customers'
      ? rows.map(supabaseRowFromCustomer)
      : rows.map(supabaseRowFromClosure);

  // Read the complete pre-sync snapshot before any destructive write.
  // If this read fails, leave the remote table untouched.
  const previousRows = await readSupabaseSnapshot(table);
  const previousMeta = key === 'reservations'
    ? await supabaseRequest('app_state', 'GET', null, '?select=*&key=eq.reservation_meta')
    : null;

  try {
    await supabaseRequest(table, 'DELETE', null, '?id=not.is.null');
    if (mapped.length) {
      await supabaseRequest(table, 'POST', mapped);
    }
    if (key === 'reservations') await saveReservationMetaToSupabase(rows);
    dirtyDatasets.delete(key);
  } catch (syncError) {
    const rollbackErrors = [];

    try {
      await supabaseRequest(table, 'DELETE', null, '?id=not.is.null');
      if (previousRows.length) await supabaseRequest(table, 'POST', previousRows);
    } catch (rollbackError) {
      rollbackErrors.push(`${table}: ${rollbackError.message}`);
    }

    if (key === 'reservations') {
      try {
        await supabaseRequest('app_state', 'DELETE', null, '?key=eq.reservation_meta');
        if (previousMeta.length) await supabaseRequest('app_state', 'POST', previousMeta);
      } catch (rollbackError) {
        rollbackErrors.push(`app_state.reservation_meta: ${rollbackError.message}`);
      }
    }

    if (rollbackErrors.length) {
      throw new Error(
        `Supabase sync failed: ${syncError.message}; rollback incomplete: ${rollbackErrors.join('; ')}`
      );
    }
    throw new Error(
      `Supabase sync failed; previous data restored: ${syncError.message}`
    );
  }
}

async function flushStorage() {
  if (STORAGE_MODE !== 'supabase') return;

  const keys = [...dirtyDatasets];
  for (const key of keys) {
    const file = key === 'reservations' ? RESERVATIONS_FILE
      : key === 'customers' ? CUSTOMERS_FILE
      : CLOSURES_FILE;

    await syncDataset(key, readJson(file, []));
  }
}
async function enqueueIntegrationJob(type, reservation) {
  if (STORAGE_MODE !== 'supabase') return;
  const payload = { reservation, eventType:type, emittedAt:new Date().toISOString() };
  const dedupeKey = `${type}:${reservation.id}:${reservation.updatedAt || reservation.createdAt}`;
  await supabaseRequest('integration_jobs','POST',{id:crypto.randomUUID(),type,reservation_id:reservation.id,payload,status:'pending',attempts:0,run_after:new Date().toISOString(),dedupe_key:dedupeKey,created_at:new Date().toISOString()},'?on_conflict=dedupe_key');
}

async function createLineBindToken(reservation) {
  if (STORAGE_MODE !== 'supabase') return null;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await supabaseRequest('line_bind_tokens','POST',{code,reservation_id:reservation.id,phone:reservation.phone,expires_at:expires},'?on_conflict=code');
  return code;
}
async function notifyWorkerWakeup() {
  if (!INTEGRATION_WORKER_URL || !INTEGRATION_WORKER_SECRET) return;
  try { await fetch(`${INTEGRATION_WORKER_URL}/wake`, { method:'POST', headers:{'X-Worker-Secret':INTEGRATION_WORKER_SECRET} }); } catch {}
}

/*
 * 後台操作事件（Google 日曆 / LINE 通知用），由環境變數 INTEGRATION_ADMIN_EVENTS 控制。
 * 預設關閉：未設定時行為與舊版完全相同。回退方式：移除該環境變數並重新部署即可。
 * 事件失敗只記錄警告，絕不影響後台操作本身。
 */
const INTEGRATION_ADMIN_EVENTS = ['1','on','true'].includes(String(process.env.INTEGRATION_ADMIN_EVENTS || '').toLowerCase());
async function emitAdminReservationEvent(type, reservation) {
  if (!INTEGRATION_ADMIN_EVENTS) return;
  try {
    await enqueueIntegrationJob(type, reservation);
    await notifyWorkerWakeup();
  } catch (error) {
    console.warn('integration event failed (non-fatal):', type, error.message);
  }
}
async function emitClosureChanged() {
  if (!INTEGRATION_ADMIN_EVENTS) return;
  try { await notifyWorkerWakeup(); }
  catch (error) { console.warn('integration wakeup failed (non-fatal):', error.message); }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  const dataset = datasetForFile(file);
  if (dataset) dirtyDatasets.add(dataset);
}
function queueWrite(file, data) {
  const task = writeQueue.then(async () => { atomicWrite(file, data); await flushStorage(); });
  // 佇列本身吞掉錯誤：一次 Supabase 暫時失敗後，後續寫入仍可繼續（髒資料旗標保留，下次寫入會整批重新同步）。
  // 呼叫端仍會從回傳的 task 收到這次的錯誤。
  writeQueue = task.catch(() => {});
  return task;
}
function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10_000_000) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const item of (req.headers.cookie || '').split(';')) {
    const i = item.indexOf('=');
    if (i > 0) out[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1));
  }
  return out;
}
function isAdmin(req) {
  const token = parseCookies(req).mh_admin;
  if (!token) return false;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function loginAllowed(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60_000 };
  if (item.resetAt < now) { item.count = 0; item.resetAt = now + 15 * 60_000; }
  return item.count < 8;
}
function registerLoginFailure(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60_000 };
  if (item.resetAt < now) { item.count = 0; item.resetAt = now + 15 * 60_000; }
  item.count++;
  loginAttempts.set(ip, item);
}
function manageAllowed(ip) {
  const now = Date.now();
  const item = manageAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60_000 };
  if (item.resetAt < now) { item.count = 0; item.resetAt = now + 15 * 60_000; }
  return item.count < 20;
}
function registerManageAttempt(ip) {
  const now = Date.now();
  const item = manageAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60_000 };
  if (item.resetAt < now) { item.count = 0; item.resetAt = now + 15 * 60_000; }
  item.count++;
  manageAttempts.set(ip, item);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}
function toMinutes(value) {
  const [h, m] = String(value).split(':').map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : NaN;
}
function fromMinutes(value) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function taiwanNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = type => Number(parts.find(x => x.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}
function todayISO() {
  const d = taiwanNowParts();
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
function maxBookingDateISO() {
  const d = new Date(`${todayISO()}T00:00:00`);
  d.setMonth(d.getMonth() + CONFIG.maxAdvanceMonths + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function currentTaiwanMinutes() {
  const d = taiwanNowParts();
  return d.hour * 60 + d.minute;
}
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function serviceById(id) { return CONFIG.services.find(s => s.id === id && s.active); }
function closureRecords(date) { return readJson(CLOSURES_FILE, []).filter(x => x.date === date); }
function isClosed(date) { return closureRecords(date).some(x => !x.startTime && !x.endTime); }
function closureBlocksSlot(date, slot) {
  if (isClosed(date)) return true;
  const start = toMinutes(slot), end = start + CONFIG.slotMinutes;
  return closureRecords(date).some(x => {
    if (!x.startTime || !x.endTime) return true;
    const a = toMinutes(x.startTime), b = toMinutes(x.endTime);
    return start < b && end > a;
  });
}
function closureOverlaps(date, slots) { return slots.some(slot => closureBlocksSlot(date, slot)); }

function baseSlotsForDate(date) {
  const d = new Date(`${date}T00:00:00`);
  const ranges = CONFIG.schedule[d.getDay()] || [];
  const result = [];
  for (const [start, end] of ranges) {
    const a = toMinutes(start), b = toMinutes(end);
    for (let m = a; m <= b; m += CONFIG.slotMinutes) result.push(fromMinutes(m));
  }
  return result;
}
function reservationIntervals(date, excludeReservationId = '') {
  return readJson(RESERVATIONS_FILE, [])
    .filter(x => x.date === date && x.status !== 'CANCELLED' && x.id !== excludeReservationId)
    .flatMap(x => x.slots.map(t => ({ start: toMinutes(t), end: toMinutes(t) + CONFIG.slotMinutes })));
}
function slotsAvailable(date, slots, excludeReservationId = '') {
  const intervals = reservationIntervals(date, excludeReservationId);
  return slots.every(slot => {
    const start = toMinutes(slot), end = start + CONFIG.slotMinutes;
    if (closureBlocksSlot(date, slot)) return false;
    return !intervals.some(x => start < x.end && end > x.start);
  });
}
function getAvailability(date, serviceId, excludeReservationId = '') {
  const base = baseSlotsForDate(date);
  const outOfRange = date < todayISO() || date > maxBookingDateISO();
  const closed = outOfRange || date <= todayISO() || isClosed(date);
  // Always return the configured time grid so the UI can explain why a date/time
  // cannot be booked instead of rendering a completely empty time panel.
  if (closed) {
    return {
      slots: base,
      available: [],
      booked: base,
      closed: true,
      reason: outOfRange ? 'OUT_OF_RANGE' : 'CLOSED',
      serviceDuration: serviceById(serviceId)?.durationMinutes || CONFIG.slotMinutes
    };
  }
  const intervals = reservationIntervals(date, excludeReservationId);
  const service = serviceById(serviceId);
  const needed = service ? Math.ceil((service.durationMinutes + CONFIG.slotMinutes) / CONFIG.slotMinutes) : 2;
  const available = [];
  const booked = [];
  for (const start of base) {
    // 09:00–20:00 are selectable START times. A service is allowed to
    // continue beyond 20:00; only the start time is bounded by the
    // selectable window. Existing reservations are still checked for
    // overlap even when they extend beyond 20:00.
    const startMin = toMinutes(start);
    // Same-day booking is allowed, but a start time that has already passed
    // is not. Compare against the local server clock and keep the next 30-minute
    // grid point as the earliest selectable start. Future dates remain unchanged.
    const isToday = date === todayISO();
    const now = new Date();
    const currentMinutes = currentTaiwanMinutes();
    const earliestTodayStart = Math.ceil(currentMinutes / CONFIG.slotMinutes) * CONFIG.slotMinutes;
    if (isToday && startMin < earliestTodayStart) {
      booked.push(start);
      continue;
    }
    const neededSlots = Array.from({ length: needed }, (_, i) => fromMinutes(startMin + i * CONFIG.slotMinutes));
    const free = !neededSlots.some(slot => {
      const a = toMinutes(slot), b = a + CONFIG.slotMinutes;
      return closureBlocksSlot(date, slot) || intervals.some(x => a < x.end && b > x.start);
    });
    if (free) available.push(start); else booked.push(start);
  }
  return { slots: base, available, booked, closed: false, serviceDuration: service?.durationMinutes || CONFIG.slotMinutes };
}

function getCalendarStatus(date, serviceId, reservations, closures) {
  const d = new Date(`${date}T00:00:00`);
  const ranges = CONFIG.schedule[d.getDay()] || [];
  const base = [];
  for (const [start, end] of ranges) {
    const a = toMinutes(start), b = toMinutes(end);
    for (let m = a; m <= b; m += CONFIG.slotMinutes) base.push(fromMinutes(m));
  }
  const outOfRange = date < todayISO() || date > maxBookingDateISO();
  const closedByDate = closures.some(x => x.date === date && !x.startTime && !x.endTime);
  const partialClosure = !closedByDate && closures.some(x => x.date === date && x.startTime && x.endTime);
  if (outOfRange || date <= todayISO() || closedByDate) {
    return { slots: base, available: [], closed: true, partialClosure: false };
  }
  const intervals = reservations
    .filter(x => x.date === date && x.status !== 'CANCELLED')
    .flatMap(x => (Array.isArray(x.slots) ? x.slots : []).map(t => ({start: toMinutes(t), end: toMinutes(t) + CONFIG.slotMinutes})));
  const service = serviceById(serviceId);
  const needed = service ? Math.ceil((service.durationMinutes + CONFIG.slotMinutes) / CONFIG.slotMinutes) : 2;
  const available = [];
  const currentMinutes = currentTaiwanMinutes();
  const earliestTodayStart = Math.ceil(currentMinutes / CONFIG.slotMinutes) * CONFIG.slotMinutes;
  for (const start of base) {
    const startMin = toMinutes(start);
    if (date === todayISO() && startMin < earliestTodayStart) continue;
    const neededSlots = Array.from({length: needed}, (_, i) => startMin + i * CONFIG.slotMinutes);
    const free = !neededSlots.some(m => {
      const a=m, b=m+CONFIG.slotMinutes;
      const closure = closures.some(x => {
        if (x.date !== date) return false;
        if (!x.startTime || !x.endTime) return true;
        return a < toMinutes(x.endTime) && b > toMinutes(x.startTime);
      });
      return closure || intervals.some(x => a < x.end && b > x.start);
    });
    if (free) available.push(start);
  }
  return { slots: base, available, closed: false, partialClosure };
}

function generateBookingCode(reservations) {
  const existing = new Set((Array.isArray(reservations) ? reservations : [])
    .map(x => String(x.bookingCode || '').trim())
    .filter(Boolean));
  for (let i = 0; i < 20; i++) {
    const code = `BK-${todayISO().replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    if (!existing.has(code)) return code;
  }
  return `BK-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function normalizeName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 100); }
function normalizeBirthDate(value) { return String(value || '').trim().slice(0, 10); }
function validBirthDate(value) { return validDate(value) && value >= '1900-01-01' && value <= todayISO(); }
function normalizeLineId(value) { return String(value || '').trim().slice(0, 100); }
function normalizeNote(value) { return String(value || '').trim().slice(0, 500); }
function normalizePhone(value) { return String(value || '').trim().replace(/[^0-9+()\- ]/g, '').slice(0, 30); }
function validPhone(value) { return value.length >= 8 && value.length <= 30; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function upsertCustomerFromReservation(item) {
  const customers = readJson(CUSTOMERS_FILE, []);
  const now = new Date().toISOString();
  const samePerson = c => (
    (item.customerId && c.id === item.customerId) ||
    (String(c.name || '').trim() === String(item.name || '').trim() &&
      String(c.birthDate || c.birth_date || '').trim() === String(item.birthDate || item.birth_date || '').trim())
  );
  let matches = customers.filter(samePerson);

  if (!matches.length) {
    const customer = {
      id: item.customerId || crypto.randomUUID(),
      name: item.name,
      birthDate: item.birthDate || item.birth_date || '',
      phone: item.phone || '',
      createdAt: now,
      updatedAt: now,
      history: [],
      tags: []
    };
    customers.push(customer);
    matches = [customer];
    item.customerId = customer.id;
  } else if (!item.customerId) {
    item.customerId = matches[0].id;
  }

  const h = {
    reservationId: item.id,
    date: item.date,
    startTime: item.startTime,
    endTime: item.endTime,
    serviceId: item.serviceId,
    serviceName: item.serviceName,
    durationMinutes: item.durationMinutes,
    status: item.status,
    note: item.note || '',
    myNote: item.myNote || '',
    statusLabel: item.statusLabel || '',
    otherStatus: item.otherStatus || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    updatedAt: item.updatedAt
  };

  // Update every matching profile so a legacy duplicate customer record
  // cannot retain a stale reservation status. The V1 merge key remains
  // name + birthDate; customerId is preferred once established.
  for (const customer of matches) {
    if (item.phone && customer.phone !== item.phone) customer.phone = item.phone;
    const history = Array.isArray(customer.history) ? customer.history : [];
    const idx = history.findIndex(x => x.reservationId === item.id);
    if (idx >= 0) history[idx] = h; else history.push(h);
    history.sort((a,b) => `${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`));
    customer.history = history;
    customer.updatedAt = now;
    customer.tags = [...new Set(history.flatMap(x => Array.isArray(x.tags) ? x.tags : []))].slice(0, 30);
  }

  atomicWrite(CUSTOMERS_FILE, customers);
  return matches[0];
}
function syncPersonTags(name, birthDate, tags) {
  const clean=[...new Set((Array.isArray(tags)?tags:[]).map(x=>String(x).trim()).filter(Boolean))].slice(0,30);
  const reservations=readJson(RESERVATIONS_FILE,[]);
  let changedReservations=false;
  for(const r of reservations){
    if(String(r.name||'').trim()===String(name||'').trim() && String(r.birthDate||'').trim()===String(birthDate||'').trim()){
      r.tags=[...clean];
      changedReservations=true;
    }
  }
  if(changedReservations) atomicWrite(RESERVATIONS_FILE,reservations);
  const customers=readJson(CUSTOMERS_FILE,[]);
  for(const c of customers){
    if(String(c.name||'').trim()===String(name||'').trim() && String(c.birthDate||'').trim()===String(birthDate||'').trim()){
      c.tags=[...clean];
      for(const h of (c.history||[])) h.tags=[...clean];
      c.updatedAt=new Date().toISOString();
    }
  }
  atomicWrite(CUSTOMERS_FILE,customers);
  return clean;
}
function synchronizeAllPersonTags(){
  const reservations=readJson(RESERVATIONS_FILE,[]);
  const customers=readJson(CUSTOMERS_FILE,[]);
  const people=new Map();
  for(const r of reservations){
    const key=`${r.name}\\u0000${r.birthDate||''}`;
    const set=people.get(key)||new Set();
    for(const t of (Array.isArray(r.tags)?r.tags:[])) set.add(String(t).trim());
    people.set(key,set);
  }
  for(const c of customers){
    const key=`${c.name}\\u0000${c.birthDate||''}`;
    const set=people.get(key)||new Set();
    for(const t of (Array.isArray(c.tags)?c.tags:[])) set.add(String(t).trim());
    people.set(key,set);
  }
  let changed=false;
  for(const r of reservations){
    const tags=[...(people.get(`${r.name}\\u0000${r.birthDate||''}`)||new Set())].filter(Boolean).slice(0,30);
    if(JSON.stringify(r.tags||[])!==JSON.stringify(tags)){r.tags=tags;changed=true;}
  }
  for(const c of customers){
    const tags=[...(people.get(`${c.name}\\u0000${c.birthDate||''}`)||new Set())].filter(Boolean).slice(0,30);
    c.tags=tags;
    for(const h of (c.history||[])) h.tags=[...tags];
  }
  if(changed) atomicWrite(RESERVATIONS_FILE,reservations);
  atomicWrite(CUSTOMERS_FILE,customers);
}
function rebuildCustomerHistory() {
  const oldCustomers = readJson(CUSTOMERS_FILE, []);
  const reservations = readJson(RESERVATIONS_FILE, []);
  const customers = [];
  for (const item of reservations) {
    let customer = customers.find(x => x.name === item.name && x.birthDate === item.birthDate);
    if (!customer) {
      customer = { id: crypto.randomUUID(), name: item.name, birthDate: item.birthDate || '', phone: item.phone || '', createdAt: item.createdAt || new Date().toISOString(), updatedAt: item.updatedAt || new Date().toISOString(), history: [], tags: [] };
      customers.push(customer);
    }
    if (item.phone) customer.phone = item.phone;
    customer.history.push({ reservationId:item.id, date:item.date, startTime:item.startTime, endTime:item.endTime, serviceId:item.serviceId, serviceName:item.serviceName, durationMinutes:item.durationMinutes, status:item.status, note:item.note || '', myNote:item.myNote || '', statusLabel:item.statusLabel || '', otherStatus:item.otherStatus || '', tags:Array.isArray(item.tags)?item.tags:[], updatedAt:item.updatedAt });
  }
  for (const c of customers) c.history.sort((a,b)=>`${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`));
  atomicWrite(CUSTOMERS_FILE, customers);
}
function isContiguous(slots) {
  const nums = slots.map(toMinutes).sort((a,b)=>a-b);
  return nums.every((n, i) => i === 0 || n === nums[i - 1] + CONFIG.slotMinutes);
}
function expectedSlots(startTime, durationMinutes) {
  const count = Math.ceil(durationMinutes / CONFIG.slotMinutes);
  const start = toMinutes(startTime);
  return Array.from({ length: count }, (_, i) => fromMinutes(start + i * CONFIG.slotMinutes));
}
function blockedSlots(startTime, durationMinutes) { return expectedSlots(startTime, durationMinutes + CONFIG.slotMinutes); }
function serveStatic(req, res, pathname) {
  const safe = pathname === '/' ? '/index.html' : pathname;
  const root = path.resolve(__dirname, 'public');
  const full = path.resolve(root, `.${safe}`);
  if (!full.startsWith(root + path.sep)) return json(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return json(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}

const calendarMonthCache = new Map();
const CALENDAR_CACHE_MS = 5000;
function invalidateCalendarCaches(){ calendarMonthCache.clear(); }

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || 'unknown';
  try {
    if (req.method === 'GET' && u.pathname === '/api/config') {
      return json(res, 200, {
        services: CONFIG.services.filter(x => x.active).sort((a,b)=>a.sortOrder-b.sortOrder),
        schedule: CONFIG.schedule,
        slotMinutes: CONFIG.slotMinutes,
        maxAdvanceDate: maxBookingDateISO(),
        officialUrl: CONFIG.officialUrl,
        manageUrl: `${CONFIG.appBaseUrl.replace(/\/$/, '')}/manage.html`,
        today: todayISO(),
        brandName: '蘿妮的療癒空間',
        cooldownMinutes: CONFIG.slotMinutes
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/calendar-status') {
      const month = u.searchParams.get('month');
      const serviceId = u.searchParams.get('serviceId') || CONFIG.services.find(x=>x.active)?.id;
      if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: '月份格式錯誤' });
      if (!serviceById(serviceId)) return json(res, 400, { error: '服務項目無效' });
      const [yy, mm] = month.split('-').map(Number);
      const days = new Date(yy, mm, 0).getDate();
      const cacheKey = `${month}|${serviceId}`;
      const cached = calendarMonthCache.get(cacheKey);
      if (cached && Date.now() - cached.time < CALENDAR_CACHE_MS) return json(res, 200, cached.data);
      const reservations = readJson(RESERVATIONS_FILE, []);
      const closures = readJson(CLOSURES_FILE, []);
      const statuses = {};
      for (let d = 1; d <= days; d++) {
        const date = `${yy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const x = getCalendarStatus(date, serviceId, reservations, closures);
        statuses[date] = { closed: x.closed, slots: x.slots, available: x.available, partialClosure: !!x.partialClosure };
      }
      const data = { month, serviceId, statuses };
      calendarMonthCache.set(cacheKey, {time: Date.now(), data});
      return json(res, 200, data);
    }
    if (req.method === 'GET' && u.pathname === '/api/availability') {
      const date = u.searchParams.get('date');
      const serviceId = u.searchParams.get('serviceId') || CONFIG.services.find(x=>x.active)?.id;
      if (!validDate(date)) return json(res, 400, { error: '日期格式錯誤' });
      if (!serviceById(serviceId)) return json(res, 400, { error: '服務項目無效' });
      return json(res, 200, { date, serviceId, ...getAvailability(date, serviceId) });
    }
    if (u.pathname === '/api/manage/lookup' || u.pathname.match(/^\/api\/manage\/reservations\/[^/]+\/(cancel|update)$/)) {
      if (!manageAllowed(ip)) return json(res, 429, { error: '操作嘗試過於頻繁，請稍後再試' });
      registerManageAttempt(ip);
    }
    if (req.method === 'GET' && u.pathname === '/api/manage/availability') {
      const date=u.searchParams.get('date');
      const serviceId=u.searchParams.get('serviceId') || CONFIG.services.find(x=>x.active)?.id;
      const reservationId=String(u.searchParams.get('reservationId')||'');
      const reservations=readJson(RESERVATIONS_FILE,[]);
      const item=reservations.find(x=>x.id===reservationId && x.status!=='CANCELLED');
      if(!item) return json(res,401,{error:'預約不存在或已取消'});
      if(!validDate(date)) return json(res,400,{error:'日期格式錯誤'});
      if(!serviceById(serviceId)) return json(res,400,{error:'服務項目無效'});
      return json(res,200,{date,serviceId,...getAvailability(date,serviceId,item.id)});
    }
    if (req.method === 'POST' && u.pathname === '/api/manage/lookup') {
      const data=await readBody(req);
      const phone=normalizePhone(data.phone);
      if(!validPhone(phone)) return json(res,400,{error:'請輸入電話'});
      const today = todayISO();
      const reservations=readJson(RESERVATIONS_FILE,[])
        .filter(x=>normalizePhone(x.phone)===phone && x.status!=='CANCELLED' && x.date >= today)
        .sort((a,b)=>`${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`));
      if(!reservations.length) return json(res,404,{error:'找不到此電話的預約'});
      return json(res,200,{reservations:reservations.map(item=>({
        id:item.id,name:item.name,birthDate:item.birthDate,phone:item.phone||'',
        serviceId:item.serviceId,serviceName:item.serviceName,durationMinutes:item.durationMinutes,
        date:item.date,startTime:item.startTime,endTime:item.endTime,status:item.status,note:item.note||''
      }))});
    }
    if (req.method === 'POST' && u.pathname === '/api/reservations') {
      const data = await readBody(req);
      const name = normalizeName(data.name);
      const birthDate = normalizeBirthDate(data.birthDate);
      const phone = normalizePhone(data.phone);
      const note = normalizeNote(data.note);
      const service = serviceById(data.serviceId);
      const missing = [];
      if (!validDate(data.date)) missing.push('日期');
      if (!service) missing.push('服務項目');
      if (!name) missing.push('姓名');
      if (!validBirthDate(birthDate)) missing.push('西元生日');
      if (!validPhone(phone)) missing.push('電話');
      if (typeof data.startTime !== 'string' || !data.startTime) missing.push('開始時間');
      if (missing.length) return json(res, 400, { error: `預約資料不完整：${missing.join('、')}` });
      const today = todayISO();
      if (data.date <= today) return json(res, 400, { error: '當日及過去日期不可預約，請選擇明日或之後' });
      if (data.date > maxBookingDateISO()) return json(res, 400, { error: `目前可預約至 ${maxBookingDateISO()}` });
      if (isClosed(data.date)) return json(res, 400, { error: '該日期為公休，無法預約' });
      const allowedStarts = new Set(baseSlotsForDate(data.date));
      const startMinutes = toMinutes(data.startTime);
      if (data.date === today && startMinutes < Math.ceil(currentTaiwanMinutes() / CONFIG.slotMinutes) * CONFIG.slotMinutes) {
        return json(res, 400, { error: '當日已過的時間無法預約，請選擇下一個可用時段' });
      }
      const serviceSlots = expectedSlots(data.startTime, service.durationMinutes);
      const blocked = blockedSlots(data.startTime, service.durationMinutes);
      if (!allowedStarts.has(data.startTime) || !isContiguous(serviceSlots)) return json(res, 400, { error: '所選開始時間不在可預約範圍內' });
      if (!slotsAvailable(data.date, blocked)) return json(res, 409, { error: '這個時段剛剛已被其他使用者預約，請重新選擇' });
      const reservations = readJson(RESERVATIONS_FILE, []);
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(),
        bookingCode: generateBookingCode(reservations),
        name, birthDate, phone, note,
        serviceId: service.id, serviceName: service.name, durationMinutes: service.durationMinutes,
        date: data.date, startTime: serviceSlots[0], endTime: fromMinutes(toMinutes(serviceSlots[serviceSlots.length - 1]) + CONFIG.slotMinutes),
        serviceSlots, slots: blocked, status: 'CONFIRMED', createdAt: now, updatedAt: now, cancelledAt: null
      };
      reservations.push(item);
      await queueWrite(RESERVATIONS_FILE, reservations);
      invalidateCalendarCaches();
      upsertCustomerFromReservation(item);
      await flushStorage();
      const lineBindCode = await createLineBindToken(item);
      await enqueueIntegrationJob('reservation.created', item);
      await notifyWorkerWakeup();
      return json(res, 201, { reservation: item, officialUrl: CONFIG.officialUrl, lineBindCode });
    }
    const manageMatch = u.pathname.match(/^\/api\/manage\/reservations\/([^/]+)\/(cancel|update)$/);
    if (req.method === 'PATCH' && manageMatch) {
      const reservationId=decodeURIComponent(manageMatch[1]);
      const action=manageMatch[2];
      const data=await readBody(req);
      const phone=normalizePhone(data.phone);
      const reservations=readJson(RESERVATIONS_FILE,[]);
      const item=reservations.find(x=>x.id===reservationId);
      if(!item || item.status==='CANCELLED' || !validPhone(phone) || normalizePhone(item.phone)!==phone)
        return json(res,401,{error:'電話與預約資料不符'});
      if(action==='cancel'){
        markReservationCancelled(item);
        await queueWrite(RESERVATIONS_FILE,reservations); invalidateCalendarCaches(); upsertCustomerFromReservation(item); await flushStorage();
        await enqueueIntegrationJob('reservation.cancelled', item); await notifyWorkerWakeup();
        return json(res,200,{ok:true,reservation:{id:item.id,status:item.status}});
      }
      const service=serviceById(data.serviceId);
      if(!validDate(data.date)||!service||typeof data.startTime!=='string') return json(res,400,{error:'新的日期、服務或時間不完整'});
      const today=todayISO();
      if(data.date<=today) return json(res,400,{error:'當日及過去日期不可預約，請選擇明日或之後'});
      if(data.date>maxBookingDateISO()) return json(res,400,{error:`目前可預約至 ${maxBookingDateISO()}`});
      if(isClosed(data.date)) return json(res,400,{error:'該日期為公休，無法預約'});
      const allowedStarts=new Set(baseSlotsForDate(data.date));
      const serviceSlots=expectedSlots(data.startTime,service.durationMinutes);
      const blocked=blockedSlots(data.startTime,service.durationMinutes);
      if(!allowedStarts.has(data.startTime)||!isContiguous(serviceSlots)) return json(res,400,{error:'所選開始時間不在可預約範圍內'});
      if(!slotsAvailable(data.date,blocked,item.id)) return json(res,409,{error:'新的時段剛剛已被其他使用者預約，請重新選擇'});
      item.serviceId=service.id; item.serviceName=service.name; item.durationMinutes=service.durationMinutes;
      item.date=data.date; item.startTime=serviceSlots[0];
      item.endTime=fromMinutes(toMinutes(serviceSlots[serviceSlots.length-1])+CONFIG.slotMinutes);
      item.serviceSlots=serviceSlots; item.slots=blocked; item.updatedAt=new Date().toISOString();
      await queueWrite(RESERVATIONS_FILE,reservations); invalidateCalendarCaches(); upsertCustomerFromReservation(item); await flushStorage();
      await enqueueIntegrationJob('reservation.updated', item); await notifyWorkerWakeup();
      return json(res,200,{ok:true,reservation:item});
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/login') {
      if (!ADMIN_PASSWORD) return json(res, 503, { error: '尚未設定 ADMIN_PASSWORD' });
      if (!loginAllowed(ip)) return json(res, 429, { error: '登入嘗試過於頻繁，請稍後再試' });
      const data = await readBody(req);
      if (!safeEqual(data.password || '', ADMIN_PASSWORD)) {
        registerLoginFailure(ip);
        return json(res, 401, { error: '後台密碼錯誤' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60_000 });
      return json(res, 200, { ok: true }, { 'Set-Cookie': `mh_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/logout') {
      const token = parseCookies(req).mh_admin;
      if (token) sessions.delete(token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'mh_admin=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/' });
    }
    if (req.method === 'GET' && u.pathname === '/magic-control') {
      return serveStatic(req, res, '/admin.html');
    }
    if (u.pathname === '/admin.html') {
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' && u.pathname === '/api/integration/export') {
      const secret = req.headers['x-integration-secret'] || '';
      if (!INTEGRATION_WORKER_SECRET || !safeEqual(secret, INTEGRATION_WORKER_SECRET)) {
        console.warn(`[integration] export denied ${new Date().toISOString()}`);   // 只記錄事件，不記錄任何密鑰內容
        return json(res, 401, {error:'Unauthorized'});
      }
      console.log(`[integration] export accessed ${new Date().toISOString()}`);     // 備份資料含個資：留下存取紀錄（不含資料內容）
      const reservations = readJson(RESERVATIONS_FILE, []);
      const customers = readJson(CUSTOMERS_FILE, []);
      const closures = readJson(CLOSURES_FILE, []);
      // 先組成完整字串再送出，讓回應帶有確定的 Content-Length 與筆數標頭：
      // Worker 因此可以「不解碼、不解析」直接把位元組串流到 Google Drive（Cloudflare 免費方案每次執行 CPU 只有 10ms），
      // 並用這些標頭驗證格式與上傳結果。標頭只含數量，不含任何個資。
      const exportBody = JSON.stringify({backupFormat:'RONNIE_HEALING_SPACE_BACKUP',backupVersion:'V2',exportedAt:new Date().toISOString(),data:{reservations,customers,closures}});
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(exportBody),
        'Cache-Control': 'no-store',
        'X-Export-Format': 'RONNIE_HEALING_SPACE_BACKUP',
        'X-Export-Counts': `reservations=${reservations.length};customers=${customers.length};closures=${closures.length}`
      });
      return res.end(exportBody);
    }
    if (u.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: '未登入' });
      if (req.method === 'GET' && u.pathname === '/api/admin/calendar') {
        const year = Number(u.searchParams.get('year')); const month = Number(u.searchParams.get('month'));
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return json(res,400,{error:'年月格式錯誤'});
        const cacheKey = `admin:${year}-${String(month).padStart(2,'0')}`;
        const cached = calendarMonthCache.get(cacheKey);
        if (cached && Date.now() - cached.time < 15000) return json(res,200,cached.data);
        const days = new Date(year, month, 0).getDate();
        const reservations = readJson(RESERVATIONS_FILE, []);
        const closures = readJson(CLOSURES_FILE, []);
        const activeByDate = new Map();
        for (const r of reservations) {
          if (r.status === 'CANCELLED') continue;
          if (!activeByDate.has(r.date)) activeByDate.set(r.date, []);
          activeByDate.get(r.date).push(r);
        }
        const out=[];
        for(let d=1;d<=days;d++){
          const date=`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dayReservations=activeByDate.get(date)||[];
          const reservationCount=dayReservations.length;
          const serviceStates=CONFIG.services.filter(x=>x.active).map(s=>getCalendarStatus(date,s.id,reservations,closures));
          const anyAvailable=serviceStates.some(x=>Array.isArray(x.available) && x.available.length>0);
          const fullClosure=closures.some(x=>x.date===date && !x.startTime && !x.endTime);
          const partialClosure=!fullClosure && closures.some(x=>x.date===date && x.startTime && x.endTime);
          // Reservation count is authoritative for the admin calendar.  Do not let
          // a service-level availability calculation erase an existing booking.
          let status='AVAILABLE';
          if(date<todayISO()) status='PAST';
          else if(date>maxBookingDateISO()) status='UNAVAILABLE';
          else if(date===todayISO()) status='TODAY';
          else if(fullClosure) status='CLOSED';
          else if(partialClosure) status='PARTIAL_CLOSED';
          else if(reservationCount>0) status=anyAvailable?'PARTIAL':'FULL';
          else status=anyAvailable?'AVAILABLE':'FULL';
          const bookedSlots=[...new Set(dayReservations.flatMap(x=>Array.isArray(x.serviceSlots)?x.serviceSlots:expectedSlots(x.startTime,x.durationMinutes||30)))].sort((a,b)=>toMinutes(a)-toMinutes(b));
          const closureSlots=[];
          for(const c of closures.filter(x=>x.date===date && x.startTime && x.endTime)){
            for(let mm=toMinutes(c.startTime); mm<toMinutes(c.endTime); mm+=CONFIG.slotMinutes) closureSlots.push(fromMinutes(mm));
          }
          out.push({date,status,reservationCount,bookedSlots,closureSlots:[...new Set(closureSlots)].sort((a,b)=>toMinutes(a)-toMinutes(b))});
        }
        calendarMonthCache.set(cacheKey,{time:Date.now(),data:out});
        return json(res,200,out);
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/backup-to-drive') {
        if (!INTEGRATION_WORKER_URL || !INTEGRATION_WORKER_SECRET) return json(res, 503, {error:'尚未設定 Worker 備份服務'});
        try {
          const r = await fetch(`${INTEGRATION_WORKER_URL}/backup-now`, {method:'POST',headers:{'X-Worker-Secret':INTEGRATION_WORKER_SECRET}});
          const body = await r.json().catch(()=>({}));
          if (!r.ok) return json(res, 502, {error:body.error || 'Google Drive 備份失敗'});
          return json(res,200,{ok:true,message:'已送出 Google Drive 備份'});
        } catch (e) { return json(res,502,{error:'無法連線到備份 Worker'}); }
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/export') {
        const reservations = readJson(RESERVATIONS_FILE, []);
        const customers = readJson(CUSTOMERS_FILE, []);
        const closures = readJson(CLOSURES_FILE, []);
        const payload = {
          backupFormat: 'RONNIE_HEALING_SPACE_BACKUP',
          backupVersion: 'V2',
          exportedAt: new Date().toISOString(),
          note: '完整後台資料備份。匯入時會覆蓋目前 reservations、customers、closures。網站設定、管理員密碼與登入工作階段不匯出。',
          data: { reservations, customers, closures },
          // 保留舊版欄位名稱，方便舊備份讀取工具辨識；實際匯入以 data 為準。
          reservations,
          customers,
          closures
        };
        return json(res, 200, payload, {
          'Content-Disposition': "attachment; filename=\"Ronnie-Witchery-Corner-backup-v2.json\"; filename*=UTF-8''Ronnie%E2%80%99s%20Witchery%20Corner-backup-v2.json"
        });
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/import') {
        let payload;
        try { payload = await readBody(req); }
        catch (e) { return json(res, 400, {error: e.message || '備份檔讀取失敗'}); }
        const isV2 = payload && payload.backupFormat === 'RONNIE_HEALING_SPACE_BACKUP';
        const isV1 = payload && payload.exportVersion === 'V1';
        if (!isV2 && !isV1) return json(res, 400, {error:'不是蘿妮的療癒空間有效備份檔'});
        const source = payload.data && typeof payload.data === 'object' ? payload.data : payload;
        const reservations = source.reservations;
        const customers = source.customers;
        const closures = source.closures;
        if (!Array.isArray(reservations) || !Array.isArray(customers) || !Array.isArray(closures)) return json(res, 400, {error:'備份資料不完整，必須包含 reservations、customers、closures'});
        // 網站設定不屬於資料備份範圍；即使舊版 V2 備份帶有 settings，也一律忽略。
        // 先保留目前資料；三份資料全部成功後才視為匯入完成。
        const old = {
          reservations: readJson(RESERVATIONS_FILE, []),
          customers: readJson(CUSTOMERS_FILE, []),
          closures: readJson(CLOSURES_FILE, [])
        };
        try {
          await queueWrite(RESERVATIONS_FILE, reservations);
          await queueWrite(CUSTOMERS_FILE, customers);
          await queueWrite(CLOSURES_FILE, closures);
          invalidateCalendarCaches();
          return json(res, 200, {ok:true, importedAt:new Date().toISOString(), reservations:reservations.length, customers:customers.length, closures:closures.length});
        } catch (e) {
          const rollbackFailures = [];
          const rollbackTasks = [
            ['reservations', RESERVATIONS_FILE, old.reservations],
            ['customers', CUSTOMERS_FILE, old.customers],
            ['closures', CLOSURES_FILE, old.closures]
          ];

          for (const [name, file, data] of rollbackTasks) {
            try {
              await queueWrite(file, data);
            } catch (rollbackError) {
              rollbackFailures.push(name);
            }
          }

          // 網站設定不在本次匯入範圍，因此不回復／刪除 settings.json。
          invalidateCalendarCaches();

          if (rollbackFailures.length > 0) {
            return json(res, 500, {
              error: '匯入失敗，部分資料回復失敗',
              rollbackFailed: rollbackFailures
            });
          }

          return json(res, 500, {error:'匯入失敗，已回復匯入前資料'});
        }
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/closures') {
        const list = readJson(CLOSURES_FILE, []).sort((a,b) => `${a.date}${a.startTime||''}`.localeCompare(`${b.date}${b.startTime||''}`));
        return json(res, 200, list);
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/closures') {
        const data = await readBody(req);
        const date = String(data.date || '').trim();
        const startTime = String(data.startTime || '').trim();
        const endTime = String(data.endTime || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validDate(date)) return json(res,400,{error:'公休日期格式錯誤'});
        const allDay = !startTime && !endTime;
        if (!allDay) {
          if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) return json(res,400,{error:'請選擇完整的公休開始與結束時間'});
          const a=toMinutes(startTime), b=toMinutes(endTime);
          if (a < 0 || b <= a || a % CONFIG.slotMinutes || b % CONFIG.slotMinutes) return json(res,400,{error:'公休時間必須為 30 分鐘單位，且結束時間須晚於開始時間'});
        }
        // 不允許把已有預約的日期／時段設定為公休。
        // 全天公休：該日只要有任何未取消預約就拒絕。
        // 時段公休：只要與既有預約實際時段重疊就拒絕。
        const reservations = readJson(RESERVATIONS_FILE, []);
        const activeReservations = reservations.filter(x => x.date === date && x.status !== 'CANCELLED');
        if (activeReservations.length) {
          if (allDay) {
            return json(res,409,{error:'該日期已有預約，無法設定全天公休'});
          }
          const closureStart = toMinutes(startTime);
          const closureEnd = toMinutes(endTime);
          const hasBookedOverlap = activeReservations.some(x => {
            const bookedStart = toMinutes(x.startTime);
            const bookedEnd = toMinutes(x.endTime || fromMinutes(bookedStart + (x.durationMinutes || CONFIG.slotMinutes)));
            return closureStart < bookedEnd && closureEnd > bookedStart;
          });
          if (hasBookedOverlap) {
            return json(res,409,{error:'所選公休時間已有預約，無法設定公休'});
          }
        }
        const closures = readJson(CLOSURES_FILE, []);
        const overlap = closures.some(x => x.date===date && (
          allDay || (!x.startTime && !x.endTime) || (toMinutes(startTime) < toMinutes(x.endTime) && toMinutes(endTime) > toMinutes(x.startTime))
        ));
        if (overlap) return json(res,409,{error:'這個日期／時段已有公休設定'});
        const item={id:crypto.randomUUID(),date,...(allDay?{}:{startTime,endTime}),createdAt:new Date().toISOString()};
        closures.push(item); await queueWrite(CLOSURES_FILE,closures); invalidateCalendarCaches(); await emitClosureChanged(); return json(res,201,{closure:item});
      }
      const closureMatch = u.pathname.match(/^\/api\/admin\/closures\/([^/]+)$/);
      if (req.method === 'DELETE' && closureMatch) {
        const id=decodeURIComponent(closureMatch[1]); const closures=readJson(CLOSURES_FILE,[]); const next=closures.filter(x=>x.id!==id);
        if (next.length===closures.length) return json(res,404,{error:'找不到公休設定'});
        await queueWrite(CLOSURES_FILE,next); invalidateCalendarCaches(); await emitClosureChanged(); return json(res,200,{ok:true});
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/customers') {
        const customers=readJson(CUSTOMERS_FILE,[]).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant')); return json(res,200,customers);
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/reservations') {
        const date = u.searchParams.get('date');
        const status = u.searchParams.get('status');
        let list = readJson(RESERVATIONS_FILE, []);
        if (date) list = list.filter(x => x.date === date);
        if (status) list = list.filter(x => x.status === status);
        list.sort((a,b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
        return json(res, 200, list);
      }
      const statusMatch = u.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/status$/);
      if (req.method === 'PATCH' && statusMatch) {
        const id=decodeURIComponent(statusMatch[1]); const data=await readBody(req);
        const allowed=['Finished','Cancel','No-show','Other'];
        if(!allowed.includes(data.statusLabel)) return json(res,400,{error:'預定狀態無效'});
        if(data.statusLabel==='Other' && !String(data.otherStatus||'').trim()) return json(res,400,{error:'請輸入 Other 的自定義狀態'});
        const reservations=readJson(RESERVATIONS_FILE,[]); const item=reservations.find(x=>x.id===id);
        if(!item) return json(res,404,{error:'找不到預約'});
        const wantsCancel = data.statusLabel==='Cancel';
        const wasCancelled = item.status==='CANCELLED';
        let integrationEvent = '';
        if(wantsCancel){
          if(!wasCancelled) integrationEvent='reservation.cancelled';
          // Cancel 與 CANCELLED 同義：同步設定 status，時段隨之釋放
          markReservationCancelled(item);
        } else {
          // 已取消的預約改成其他狀態 = 恢復預約：先確認時段仍可使用
          if(item.status==='CANCELLED'){
            const conflict=restoreConflictMessage(item);
            if(conflict) return json(res,409,{error:conflict});
            restoreReservation(item);
            integrationEvent='reservation.updated';
          }
          item.statusLabel=data.statusLabel; item.otherStatus=String(data.otherStatus||'').trim();
          item.updatedAt=new Date().toISOString();
        }
        await queueWrite(RESERVATIONS_FILE,reservations); invalidateCalendarCaches(); upsertCustomerFromReservation(item); await flushStorage();
        if(integrationEvent) await emitAdminReservationEvent(integrationEvent,item);
        return json(res,200,{ok:true,reservation:item});
      }
      const tagMatch = u.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/tags$/);
      if (req.method === 'PATCH' && tagMatch) {
        const id=decodeURIComponent(tagMatch[1]); const data=await readBody(req);
        const tags=Array.isArray(data.tags)?data.tags.map(x=>String(x).trim()).filter(Boolean).slice(0,30):[];
        const reservations=readJson(RESERVATIONS_FILE,[]); const item=reservations.find(x=>x.id===id);
        if(!item) return json(res,404,{error:'找不到預約'});
        item.tags=[...new Set(tags)].slice(0,30); item.updatedAt=new Date().toISOString();
        await queueWrite(RESERVATIONS_FILE,reservations);
        const synced=syncPersonTags(item.name,item.birthDate,item.tags);
        item.tags=[...synced];
        upsertCustomerFromReservation(item); await flushStorage();
        return json(res,200,{ok:true,reservation:item});
      }
      const customerTagMatch = u.pathname.match(/^\/api\/admin\/customers\/([^/]+)\/tags$/);
      if (req.method === 'PATCH' && customerTagMatch) {
        const id=decodeURIComponent(customerTagMatch[1]); const data=await readBody(req);
        const tags=Array.isArray(data.tags)?data.tags.map(x=>String(x).trim()).filter(Boolean).slice(0,30):[];
        const customers=readJson(CUSTOMERS_FILE,[]); const customer=customers.find(x=>x.id===id);
        if(!customer) return json(res,404,{error:'找不到客人檔案'});
        customer.tags=[...new Set(tags)].slice(0,30); customer.updatedAt=new Date().toISOString();
        await queueWrite(CUSTOMERS_FILE,customers);
        const synced=syncPersonTags(customer.name,customer.birthDate,customer.tags);
        customer.tags=[...synced];
        await flushStorage();
        return json(res,200,{ok:true,customer});
      }
      const noteMatch = u.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/note$/);
      if (req.method === 'PATCH' && noteMatch) {
        const id = decodeURIComponent(noteMatch[1]);
        const data = await readBody(req);
        const reservations = readJson(RESERVATIONS_FILE, []);
        const item = reservations.find(x => x.id === id);
        if (!item) return json(res, 404, { error: '找不到預約' });
        item.myNote = normalizeNote(data.myNote);
        item.updatedAt = new Date().toISOString();
        await queueWrite(RESERVATIONS_FILE, reservations);
        invalidateCalendarCaches();
        upsertCustomerFromReservation(item);
        return json(res, 200, { ok: true, reservation: item });
      }
      const match = u.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/cancel$/);
      if (req.method === 'PATCH' && match) {
        const id = decodeURIComponent(match[1]);
        const reservations = readJson(RESERVATIONS_FILE, []);
        const item = reservations.find(x => x.id === id);
        if (!item) return json(res, 404, { error: '找不到預約' });
        if (item.status === 'CANCELLED') return json(res, 200, { ok: true, reservation: item });
        markReservationCancelled(item);
        await queueWrite(RESERVATIONS_FILE, reservations);
        invalidateCalendarCaches();
        upsertCustomerFromReservation(item);
        await flushStorage();
        await emitAdminReservationEvent('reservation.cancelled', item);
        return json(res, 200, { ok: true, reservation: item });
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    return json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, POST, PATCH' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return json(res, 500, { error: '伺服器錯誤' });
  }
});

/*
 * 取消狀態統一規則：
 * status === 'CANCELLED' 與 statusLabel === 'Cancel' 代表同一件事。
 * 設定 Cancel 時兩邊一併同步；已取消的預約改選其他狀態則會恢復預約（見 restoreReservation）。
 */
function hasCancelLabel(item) {
  const label = String(item?.statusLabel || '').trim().toUpperCase();
  return label === 'CANCEL' || label === 'CANCELLED';
}
function markReservationCancelled(item, at = new Date().toISOString()) {
  item.status = 'CANCELLED';
  item.statusLabel = 'Cancel';
  item.otherStatus = '';
  if (!item.cancelledAt) item.cancelledAt = at;
  item.updatedAt = at;
  return item;
}
/*
 * 已取消的預約改選 Finished / No-show / Other 時，視為「恢復預約」：
 * status 改回 CONFIRMED、清除 cancelledAt，重新占用原本的時段。
 * 恢復前必須檢查時段：
 * 1. 與其他未取消預約重疊 → 不可恢復（時段可能已被別人預約）
 * 2. 預約尚未結束，且時段落在公休/不可預約區間 → 不可恢復
 *    （已結束的預約只是補記錄，不受公休限制）
 * 回傳錯誤訊息；可恢復則回傳空字串。
 */
function reservationHasEnded(item) {
  const today = todayISO();
  if (item.date < today) return true;
  if (item.date > today) return false;
  const end = toMinutes(item.endTime);
  return Number.isFinite(end) && end <= currentTaiwanMinutes();
}
function restoreConflictMessage(item) {
  const slots = Array.isArray(item.slots) && item.slots.length
    ? item.slots
    : blockedSlots(item.startTime, item.durationMinutes || 30);
  const taken = reservationIntervals(item.date, item.id);
  const overlaps = slots.some(slot => {
    const a = toMinutes(slot), b = a + CONFIG.slotMinutes;
    return taken.some(x => a < x.end && b > x.start);
  });
  if (overlaps) return '該時段已被其他預約占用，無法恢復此預約';
  if (!reservationHasEnded(item) && closureOverlaps(item.date, slots)) {
    return '該時段目前為公休或不可預約時段，無法恢復此預約';
  }
  return '';
}
function restoreReservation(item, at = new Date().toISOString()) {
  item.status = 'CONFIRMED';
  item.cancelledAt = null;
  item.updatedAt = at;
  return item;
}
/*
 * 啟動時修正舊資料：
 * 1. statusLabel 為 Cancel、但 status 仍是 CONFIRMED 的紀錄 → 改為 CANCELLED（時段隨之釋放）
 * 2. status 為 CANCELLED、但 statusLabel 為空的紀錄 → 補上 Cancel
 * 回傳修正筆數。
 */
async function migrateCancelStatusConsistency() {
  const reservations = readJson(RESERVATIONS_FILE, []);
  if (!Array.isArray(reservations)) return 0;
  const changed = [];
  for (const item of reservations) {
    if (!item || typeof item !== 'object') continue;
    if (item.status !== 'CANCELLED' && hasCancelLabel(item)) {
      markReservationCancelled(item, item.updatedAt || new Date().toISOString());
      changed.push(item);
    } else if (item.status === 'CANCELLED' && !String(item.statusLabel || '').trim()) {
      item.statusLabel = 'Cancel';
      changed.push(item);
    }
  }
  if (!changed.length) return 0;
  await queueWrite(RESERVATIONS_FILE, reservations);
  invalidateCalendarCaches();
  for (const item of changed) upsertCustomerFromReservation(item);
  await flushStorage();
  return changed.length;
}

async function startServer() {
  if (STORAGE_MODE === 'supabase') {
    await hydrateFromSupabase();
    console.log('Storage mode: Supabase');
  } else {
    console.log('Storage mode: Local JSON');
  }
  try {
    const fixed = await migrateCancelStatusConsistency();
    if (fixed) console.log(`Cancel status migration: ${fixed} reservation(s) normalized`);
  } catch (error) {
    console.warn('Cancel status migration failed; continuing:', error.message);
  }
  server.listen(CONFIG.port, () => console.log(`Ronnie's Witchery Corner booking system: http://localhost:${CONFIG.port}`));
}
startServer().catch(error => { console.error('Data store initialization failed:', error); process.exit(1); });
