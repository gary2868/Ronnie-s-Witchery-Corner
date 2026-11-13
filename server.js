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
const RECYCLE_FILE = path.join(DATA_DIR, 'recycle_bin.json');   // 資源回收桶（本機模式）；Supabase 模式存在 app_state 的 recycle_bin 一列
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RESERVATIONS_FILE)) fs.writeFileSync(RESERVATIONS_FILE, '[]', 'utf8');
if (!fs.existsSync(CLOSURES_FILE)) fs.writeFileSync(CLOSURES_FILE, '[]', 'utf8');
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '[]', 'utf8');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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
async function supabaseRequest(table, method='GET', body=null, query='', prefer='return=representation') {
  assertSupabaseConfig();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: prefer },
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
/** 已完成 LINE 綁定的預約 id 集合（讀 app_state 的 line_bind:* 列）。讀取失敗回傳空集合，不影響查詢。 */
async function loadBoundReservationIds() {
  const ids = new Set();
  if (STORAGE_MODE !== 'supabase') {
    for (const k of Object.keys(readJson(LINE_BINDINGS_FILE, {}))) ids.add(k);
    return ids;
  }
  try {
    const rows = await supabaseRequest('app_state', 'GET', null, '?select=value&key=like.line_bind:*');
    for (const r of rows || []) if (r && r.value && r.value.reservationId) ids.add(r.value.reservationId);
  } catch (error) { console.warn('Bind status unavailable; continuing:', error.message); }
  try {
    const rows = await supabaseRequest('app_state', 'GET', null, '?select=key&key=like.line_reservation:*');
    for (const r of rows || []) if (r && r.key) ids.add(String(r.key).slice('line_reservation:'.length));
  } catch (error) { console.warn('LINE login bind status unavailable; continuing:', error.message); }
  return ids;
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

async function saveReservationMetaToSupabase(reservations, previousValue = null) {
  if (STORAGE_MODE !== 'supabase') return;
  const value = {};
  for (const item of (Array.isArray(reservations) ? reservations : [])) {
    const meta = {};
    if (item.myNote) meta.myNote = item.myNote;
    if (item.statusLabel !== undefined) meta.statusLabel = item.statusLabel;
    if (item.otherStatus) meta.otherStatus = item.otherStatus;
    if (Array.isArray(item.tags) && item.tags.length) meta.tags = item.tags;
    if (Object.keys(meta).length) value[item.id] = meta;
  }
  // 綁定碼只存在中繼資料中，每次覆寫都必須保留（否則下一次寫入就會清掉）
  const ids = new Set((Array.isArray(reservations) ? reservations : []).map(r => r.id));
  for (const [id, prev] of Object.entries(previousValue || {})) {
    if (!prev || !prev.lineBindCode || !ids.has(id)) continue;
    value[id] = { ...(value[id] || {}), lineBindCode: prev.lineBindCode, ...(prev.lineBindCodeAt ? { lineBindCodeAt: prev.lineBindCodeAt } : {}) };
  }
  // 單一 upsert 取代 DELETE + POST：同一筆 key 原子覆寫，少一次往返
  await supabaseRequest('app_state', 'POST', {
    key: 'reservation_meta',
    value,
    updated_at: new Date().toISOString()
  }, '?on_conflict=key', 'resolution=merge-duplicates,return=representation');
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

/* ───────── 增量同步（預約／客人／公休）─────────
 * 每張表保存「上次成功寫入資料庫的列」作為基準（啟動後第一次同步讀取一次完整快照）。
 * 每次只 upsert 新增或內容改變的列，並刪除已不存在的列；失敗時只還原這次碰到的列。
 * 回滾失敗時清空基準，下次同步重新讀取快照（自我修復）。
 * 中繼資料（備註／狀態／標籤／綁定碼）：內容沒有變動就不寫入；基準保存在記憶體中（單一伺服器程序，
 * 所有寫入中繼資料的路徑都會更新基準）。
 */
const incBaseline = { reservations: null, customers: null, closures: null };
let reservationMetaBaseline = null;   // 上次成功寫入（或讀取）的中繼資料內容；null = 尚未讀取
const pickKeys = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const sortDeep = v => Array.isArray(v) ? v.map(sortDeep) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : v;
const canonicalRow = o => JSON.stringify(sortDeep(o));   // 深層排序：jsonb 會重排鍵順序，避免誤判為變動
const canonicalMeta = v => JSON.stringify(sortDeep(v ?? {}));
const chunkList = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const idInFilter = ids => `?id=in.(${ids.map(id => encodeURIComponent(String(id))).join(',')})`;

function incPlan(before, mapped) {
  const after = new Map(mapped.map(r => [r.id, r]));
  const upserts = mapped.filter(r => !before.has(r.id) || canonicalRow(pickKeys(before.get(r.id), Object.keys(r))) !== canonicalRow(r));
  const deletes = [...before.keys()].filter(id => !after.has(id));
  const touched = [...new Set([...upserts.map(r => r.id), ...deletes])];
  return { upserts, deletes, touched };
}
async function incWrite(table, plan, extra = []) {
  const writes = [
    ...chunkList(plan.upserts, 500).map(c => supabaseRequest(table, 'POST', c, '?on_conflict=id', 'resolution=merge-duplicates,return=representation')),
    ...chunkList(plan.deletes, 100).map(c => supabaseRequest(table, 'DELETE', null, idInFilter(c))),
    ...extra,
  ];
  const settled = await Promise.allSettled(writes);
  return settled.filter(r => r.status === 'rejected').map(r => r.reason);
}
async function incRollback(table, before, touched) {
  const newIds = touched.filter(id => !before.has(id));
  const restore = touched.filter(id => before.has(id)).map(id => before.get(id));
  const jobs = [
    ...chunkList(newIds, 100).map((c, n) => ({ label: `${table} DELETE 第 ${n + 1} 批`, run: () => supabaseRequest(table, 'DELETE', null, idInFilter(c)) })),
    ...chunkList(restore, 500).map((c, n) => ({ label: `${table} POST 第 ${n + 1} 批`, run: () => supabaseRequest(table, 'POST', c, '?on_conflict=id', 'resolution=merge-duplicates,return=representation') })),
  ];
  // 等待全部還原請求完成（不因單一失敗提早結束），並逐項記錄失敗的批次
  const settled = await Promise.allSettled(jobs.map(j => j.run()));
  return settled
    .map((r, k) => (r.status === 'rejected' ? `${jobs[k].label}: ${r.reason?.message ?? String(r.reason)}` : null))
    .filter(Boolean);
}
function incCommit(before, plan, mapped) {
  for (const id of plan.deletes) before.delete(id);
  for (const r of plan.upserts) before.set(r.id, r);
}
async function incBaselineFor(key, table) {
  if (!incBaseline[key]) incBaseline[key] = new Map((await readSupabaseSnapshot(table)).map(r => [r.id, r]));
  return incBaseline[key];
}
async function syncIncrementalTable(key, table, mapped) {
  const before = await incBaselineFor(key, table);
  const plan = incPlan(before, mapped);
  const failures = await incWrite(table, plan);
  if (!failures.length) { incCommit(before, plan, mapped); dirtyDatasets.delete(key); return; }
  const rollbackErrors = await incRollback(table, before, plan.touched);
  if (rollbackErrors.length) {
    incBaseline[key] = null;   // 基準不可靠：下次同步重新讀取完整快照
    throw new Error(`Supabase sync failed: ${failures[0].message}; rollback incomplete: ${rollbackErrors.join('; ')}`);
  }
  throw new Error(`Supabase sync failed; previous data restored: ${failures[0].message}`);
}

function buildReservationMeta(reservations, previousValue) {
  const value = {};
  for (const item of reservations) {
    const meta = {};
    if (item.myNote) meta.myNote = item.myNote;
    if (item.statusLabel !== undefined) meta.statusLabel = item.statusLabel;
    if (item.otherStatus) meta.otherStatus = item.otherStatus;
    if (Array.isArray(item.tags) && item.tags.length) meta.tags = item.tags;
    if (Object.keys(meta).length) value[item.id] = meta;
  }
  // 綁定碼只存在中繼資料中，每次覆寫都必須保留（只要預約仍存在）
  const ids = new Set(reservations.map(r => r.id));
  for (const [id, prev] of Object.entries(previousValue || {})) {
    if (!prev || !prev.lineBindCode || !ids.has(id)) continue;
    value[id] = { ...(value[id] || {}), lineBindCode: prev.lineBindCode, ...(prev.lineBindCodeAt ? { lineBindCodeAt: prev.lineBindCodeAt } : {}) };
  }
  return value;
}
// ---- 中繼資料 CAS（資料庫函式 cas_reservation_meta）----
async function casReservationMeta(expected, next) {
  return supabaseRequest('rpc/cas_reservation_meta', 'POST', { p_expected: expected ?? {}, p_next: next ?? {} }, '', 'return=representation');
}
async function readReservationMetaRemoteStrict() {
  const rows = await supabaseRequest('app_state', 'GET', null, '?select=value&key=eq.reservation_meta&limit=1');
  const v = rows && rows[0] && rows[0].value;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}
// 逐筆合併：只套用本次改變的預約；其餘保留資料庫目前內容（含外部 writer 的修改）；綁定碼以資料庫為準
function mergeReservationMetaEntries(current, baseline, next) {
  // 欄位級合併：只套用本次改變的欄位；其餘欄位保留資料庫目前的值（含外部 writer 的修改）；綁定碼以資料庫為準
  const out = JSON.parse(JSON.stringify(current ?? {}));
  const base = baseline ?? {}, want = next ?? {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(want)])) {
    const b = base[id], n = want[id];
    if (canonicalMeta(b) === canonicalMeta(n)) continue;          // 本次沒有變動的預約
    if (n === undefined) { delete out[id]; continue; }            // 預約已不存在
    const entry = { ...(out[id] || {}) };
    const bb = b || {};
    for (const k of new Set([...Object.keys(bb), ...Object.keys(n)])) {
      if (k === 'lineBindCode' || k === 'lineBindCodeAt') continue;   // 綁定碼以資料庫目前值為準
      if (canonicalMeta(bb[k]) === canonicalMeta(n[k])) continue;     // 本次沒有改這個欄位
      if (n[k] === undefined) delete entry[k]; else entry[k] = n[k];
    }
    if (Object.keys(entry).length) out[id] = entry; else delete out[id];
  }
  return out;
}
async function failAfterDataRollback(key, table, before, plan, error) {
  const errors = await incRollback(table, before, plan.touched);
  reservationMetaBaseline = null;     // 中繼資料狀態不確定：下次重新讀取
  if (errors.length) {
    incBaseline[key] = null;
    throw new Error(`Supabase sync failed: ${error.message}; rollback incomplete: ${errors.join('; ')}`);
  }
  throw new Error(`Supabase sync failed; previous data restored: ${error.message}`);
}
async function casUpdateReservationMetaEntry(reservationId, patch) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cur = await readReservationMetaRemoteStrict();
    const next = JSON.parse(JSON.stringify(cur));
    next[reservationId] = { ...(next[reservationId] || {}), ...patch };
    const res = await casReservationMeta(cur, next);
    if (res.status === 'written' || res.status === 'already_current') { reservationMetaBaseline = next; return; }
    // conflict：外部已修改，重新讀取後重試
  }
  reservationMetaBaseline = null;
  throw new Error('bind code CAS conflict after 3 attempts');
}
async function syncReservationsIncremental(rows, mapped) {
  const table = 'reservations', key = 'reservations';
  const before = await incBaselineFor(key, table);
  if (reservationMetaBaseline === null) reservationMetaBaseline = await readReservationMetaRemoteStrict();   // 讀取失敗：尚未寫入任何資料
  const plan = incPlan(before, mapped);
  // 1) 先寫預約資料；失敗則只回滾預約資料（中繼資料尚未寫入）
  const dataFailures = await incWrite(table, plan);
  if (dataFailures.length) return failAfterDataRollback(key, table, before, plan, dataFailures[0]);
  // 2) 中繼資料以 CAS 寫入：衝突時以 current 重新合併後重試（最多 3 次）；RPC 錯誤不重試
  const baseMeta = reservationMetaBaseline;
  const localNext = buildReservationMeta(rows, baseMeta);
  if (canonicalMeta(localNext) !== canonicalMeta(baseMeta)) {
    let expected = baseMeta, written = false;
    for (let attempt = 1; attempt <= 3 && !written; attempt++) {
      const candidate = mergeReservationMetaEntries(expected, baseMeta, localNext);
      let res;
      try { res = await casReservationMeta(expected, candidate); }
      catch (error) { return failAfterDataRollback(key, table, before, plan, error); }
      if (res.status === 'written' || res.status === 'already_current') { reservationMetaBaseline = candidate; written = true; }
      else if (res.status === 'conflict') expected = res.current ?? {};
      else if (res.status === 'missing') expected = {};
      else return failAfterDataRollback(key, table, before, plan, new Error(`unexpected CAS status ${res.status}`));
    }
    if (!written) return failAfterDataRollback(key, table, before, plan, new Error('metadata CAS conflict after 3 attempts'));
  }
  incCommit(before, plan, mapped);
  dirtyDatasets.delete(key);
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

  if (key === 'reservations') return syncReservationsIncremental(rows, mapped);
  if (key === 'customers') return syncIncrementalTable('customers', 'customers', mapped);
  if (key === 'closures') return syncIncrementalTable('closures', 'closures', mapped);

  // Read the complete pre-sync snapshot before any destructive write.
  // If this read fails, leave the remote table untouched.
  const [previousRows, previousMeta] = await Promise.all([
    readSupabaseSnapshot(table),
    key === 'reservations'
      ? supabaseRequest('app_state', 'GET', null, '?select=*&key=eq.reservation_meta')
      : Promise.resolve(null),
  ]);

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

let syncLock = Promise.resolve();
// 任何需要與資料同步互斥的寫入（例如綁定碼寫入中繼資料）都經過同一把鎖
function withSyncLock(fn) { const run = syncLock.then(fn); syncLock = run.catch(() => {}); return run; }
// 所有 Supabase 同步排隊執行：同一時間只允許一次同步。兩次同步重疊會造成重複鍵（customers_pkey），
// 導致同步失敗、本機與資料庫不一致。
async function flushStorage() {
  const run = syncLock.then(flushStorageNow);
  syncLock = run.catch(() => {});
  return run;
}
async function flushStorageNow() {
  if (STORAGE_MODE !== 'supabase') return;

  const keys = [...dirtyDatasets];
  // 不同資料表彼此獨立，並行同步。用 allSettled：即使其中一張失敗，另一張仍會完成，最後才統一回報錯誤。
  const results = await Promise.allSettled(keys.map(key => {
    const file = key === 'reservations' ? RESERVATIONS_FILE
      : key === 'customers' ? CUSTOMERS_FILE
      : CLOSURES_FILE;
    return syncDataset(key, readJson(file, []));
  }));
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
}
async function enqueueIntegrationJob(type, reservation, extra = {}) {
  if (STORAGE_MODE !== 'supabase') return;
  const payload = { reservation, eventType:type, emittedAt:new Date().toISOString(), ...extra };
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
 * 預約資料已經儲存「之後」才做的附加動作（LINE 綁定碼、整合任務）：失敗不可讓 API 回 500。
 * 否則客人會以為預約失敗，重試時又被擋成「時段剛剛已被其他使用者預約」，而管理者其實已有這筆預約。
 * 做法：重試一次（綁定碼 on_conflict=code、任務 dedupe_key 皆可安全重送）；仍失敗就記錄警告並繼續，回傳 null。
 * 警告格式固定為「[integration] … failed … (non-fatal)」，可在 Render 日誌搜尋。
 */
async function bestEffortIntegration(label, fn, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 250)); continue; }
      console.warn(`[integration] ${label} failed after ${attempt + 1} attempt(s) (non-fatal): ${error.message}`);
      return null;
    }
  }
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
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
function normalizeBookingCode(value) {
  const s = String(value || '').trim().toUpperCase();
  return /^BK-\d{8}-[0-9A-F]{6}$/.test(s) ? s : '';
}
function bookingCodeMatches(item, code) {
  return Boolean(code) && safeEqual(String(item?.bookingCode || '').toUpperCase(), code);
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
/* ───────────────────────── 資源回收桶（軟刪除）─────────────────────────
 * 設計：刪除 = 「先把完整快照存進回收桶，成功後才從正式資料移除」。
 *  - 不更動資料庫結構（回收桶存在 app_state 的 recycle_bin 一列；本機模式存成 data/recycle_bin.json）。
 *  - 預約一旦不在正式資料中，時段釋放、日曆事件移除、提醒略過都會自然成立（Worker 不需要修改）。
 *  - 順序保證：寫入回收桶失敗 → 什麼都不會被刪。
 *  - 預約 ↔ 客人檔案歷史紀錄雙向同步：刪預約會同時移除客人歷史；從客人檔案刪某筆歷史 = 刪該預約。
 */
async function loadRecycleBin() {
  if (STORAGE_MODE === 'supabase') {
    const rows = await supabaseRequest('app_state', 'GET', null, '?select=value&key=eq.recycle_bin&limit=1');
    const v = rows && rows[0] && rows[0].value;
    return Array.isArray(v && v.items) ? v.items : [];
  }
  const v = readJson(RECYCLE_FILE, []);
  return Array.isArray(v) ? v : [];
}
async function saveRecycleBin(items) {
  if (STORAGE_MODE === 'supabase') {
    await supabaseRequest('app_state', 'POST', { key: 'recycle_bin', value: { items }, updated_at: new Date().toISOString() },
      '?on_conflict=key', 'resolution=merge-duplicates,return=representation');
  } else {
    atomicWrite(RECYCLE_FILE, items);
  }
}
const isActiveFutureReservation = r => r.status !== 'CANCELLED' && !reservationHasEnded(r);
const briefReservation = r => ({ id: r.id, name: r.name, date: r.date, startTime: r.startTime, endTime: r.endTime, serviceName: r.serviceName, status: r.status, statusLabel: r.statusLabel || '' });
const samePersonRecord = (c, p) => (c.id && p.id && c.id === p.id) ||
  (String(c.name || '').trim() === String(p.name || '').trim() &&
   String(c.birthDate || c.birth_date || '').trim() === String(p.birthDate || p.birth_date || '').trim());

function customerReservations(customer, reservations) {
  const ids = new Set((Array.isArray(customer.history) ? customer.history : []).map(h => h.reservationId));
  return reservations.filter(r => ids.has(r.id) || (r.customerId && r.customerId === customer.id) ||
    (String(r.name || '').trim() === String(customer.name || '').trim() &&
     String(r.birthDate || r.birth_date || '').trim() === String(customer.birthDate || customer.birth_date || '').trim()));
}
/** 從所有客人檔案移除指定預約的歷史紀錄；回傳是否有變動 */
function stripHistory(customers, reservationIds) {
  const ids = new Set(reservationIds);
  let changed = false;
  for (const c of customers) {
    if (!Array.isArray(c.history)) continue;
    const next = c.history.filter(h => !ids.has(h.reservationId));
    if (next.length !== c.history.length) {
      c.history = next; c.updatedAt = new Date().toISOString();
      c.tags = [...new Set(next.flatMap(x => Array.isArray(x.tags) ? x.tags : []))].slice(0, 30);
      changed = true;
    }
  }
  return changed;
}

async function softDeleteReservation(id) {
  const bin = await loadRecycleBin();                               // 讀不到回收桶 → 丟錯，什麼都不會動
  const r = readJson(RESERVATIONS_FILE, []).find(x => x.id === id);
  if (!r) return { status: 404, body: { error: '找不到這筆預約' } };
  if (isActiveFutureReservation(r)) {
    return { status: 409, body: { error: '此預約仍有效且尚未結束，請先取消預約再刪除', code: 'ACTIVE_FUTURE' } };
  }
  const entry = { id: crypto.randomUUID(), type: 'reservation', deletedAt: new Date().toISOString(), summary: briefReservation(r), reservation: r };
  bin.push(entry);
  await saveRecycleBin(bin);                                         // ① 先進回收桶（失敗 → 不刪）
  await queueWrite(RESERVATIONS_FILE, readJson(RESERVATIONS_FILE, []).filter(x => x.id !== id));   // ② 再從正式資料移除
  invalidateCalendarCaches();
  const customers = readJson(CUSTOMERS_FILE, []);
  if (stripHistory(customers, [id])) atomicWrite(CUSTOMERS_FILE, customers);                      // ③ 同步移除客人歷史
  await flushStorage();
  await emitClosureChanged();                                        // 喚醒 Worker，讓日曆對帳盡快移除事件
  console.log(`[admin] reservation ${id} moved to recycle bin (${entry.id})`);
  return { status: 200, body: { ok: true, binId: entry.id } };
}

async function softDeleteCustomer(cid) {
  const bin = await loadRecycleBin();
  const customers = readJson(CUSTOMERS_FILE, []);
  const c = customers.find(x => x.id === cid);
  if (!c) return { status: 404, body: { error: '找不到這位客人' } };
  const mine = customerReservations(c, readJson(RESERVATIONS_FILE, []));
  const active = mine.filter(isActiveFutureReservation);
  if (active.length) {
    return { status: 409, body: { error: `此客人還有 ${active.length} 筆有效且尚未結束的預約，請先取消或處理後再刪除`, code: 'HAS_ACTIVE_FUTURE', reservations: active.map(briefReservation) } };
  }
  const entry = {
    id: crypto.randomUUID(), type: 'customer', deletedAt: new Date().toISOString(),
    summary: { name: c.name, birthDate: c.birthDate || '', phone: c.phone || '', reservationCount: mine.length },
    customer: c, reservations: mine,
  };
  bin.push(entry);
  await saveRecycleBin(bin);                                         // ① 先進回收桶
  const ids = new Set(mine.map(r => r.id));
  if (mine.length) { await queueWrite(RESERVATIONS_FILE, readJson(RESERVATIONS_FILE, []).filter(x => !ids.has(x.id))); invalidateCalendarCaches(); }
  const fresh = readJson(CUSTOMERS_FILE, []).filter(x => x.id !== cid);
  stripHistory(fresh, [...ids]);
  atomicWrite(CUSTOMERS_FILE, fresh);
  await flushStorage();
  await emitClosureChanged();
  console.log(`[admin] customer ${cid} moved to recycle bin (${entry.id}) with ${mine.length} reservation(s)`);
  return { status: 200, body: { ok: true, binId: entry.id, reservationsDeleted: mine.length } };
}

async function restoreFromRecycleBin(binId) {
  const bin = await loadRecycleBin();
  const entry = bin.find(x => x.id === binId);
  if (!entry) return { status: 404, body: { error: '回收桶中找不到這個項目' } };
  const live = readJson(RESERVATIONS_FILE, []);
  const liveIds = new Set(live.map(x => x.id));

  if (entry.type === 'reservation') {
    const r = entry.reservation;
    if (liveIds.has(r.id)) return { status: 409, body: { error: '這筆預約已存在於正式資料中，無法還原（可從回收桶永久移除這個項目）', code: 'ALREADY_EXISTS' } };
    if (isActiveFutureReservation(r)) {
      const conflict = restoreConflictMessage(r);
      if (conflict) return { status: 409, body: { error: conflict, code: 'CONFLICT' } };
    }
    await queueWrite(RESERVATIONS_FILE, [...live, r]);
    invalidateCalendarCaches();
    upsertCustomerFromReservation(r);                                // 重建客人歷史（客人若已不存在會一併建立）
    await flushStorage();
  } else if (entry.type === 'customer') {
    const toRestore = entry.reservations.filter(r => !liveIds.has(r.id));
    for (const r of toRestore) {
      if (isActiveFutureReservation(r)) { const m = restoreConflictMessage(r); if (m) return { status: 409, body: { error: m, code: 'CONFLICT' } }; }
    }
    const customers = readJson(CUSTOMERS_FILE, []);
    if (!customers.some(x => samePersonRecord(x, entry.customer))) { customers.push(entry.customer); atomicWrite(CUSTOMERS_FILE, customers); }
    if (toRestore.length) { await queueWrite(RESERVATIONS_FILE, [...live, ...toRestore]); invalidateCalendarCaches(); }
    for (const r of toRestore) upsertCustomerFromReservation(r);     // 與（可能已重新建立的）同一位客人合併，不會產生重複檔案
    await flushStorage();
  } else {
    return { status: 400, body: { error: '未知的回收桶項目類型' } };
  }
  await saveRecycleBin(bin.filter(x => x.id !== binId));             // 先還原、後移出回收桶（中途失敗最多是兩邊都有，不會遺失）
  await emitClosureChanged();
  console.log(`[admin] recycle bin ${binId} (${entry.type}) restored`);
  return { status: 200, body: { ok: true, type: entry.type } };
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
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  const ext = path.extname(full).toLowerCase();
  if (!types[ext] || path.basename(full).startsWith('.')) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': types[ext], 'Cache-Control': 'no-store' });
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
    if (req.method === 'GET' && u.pathname === '/auth/line/start') {
      if (!LINE_LOGIN.secret) return json(res, 503, { error: 'LINE 登入尚未設定' });
      const state = crypto.randomBytes(16).toString('base64url');
      const nonce = crypto.randomBytes(16).toString('base64url');
      const cookie = signLineToken({ s: state, n: nonce, exp: Date.now() + 10 * 60 * 1000 });
      const auth = new URL(`${LINE_LOGIN.authBase}/oauth2/v2.1/authorize`);
      auth.search = new URLSearchParams({ response_type: 'code', client_id: LINE_LOGIN.channelId, redirect_uri: LINE_LOGIN.redirectUri,
        state, scope: 'openid profile', nonce, bot_prompt: 'normal' }).toString();
      res.writeHead(302, { Location: auth.toString(), 'Set-Cookie': `line_login_state=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/auth/line; Max-Age=600` });
      return res.end();
    }
    if (req.method === 'GET' && u.pathname === '/auth/line/callback') {
      const clearCookie = 'line_login_state=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/auth/line';
      const fail = code => { res.writeHead(302, { Location: `/?line_error=${code}`, 'Set-Cookie': clearCookie }); return res.end(); };
      const saved = verifyLineToken(parseCookieHeader(req).line_login_state);
      if (!saved || !saved.exp || saved.exp < Date.now()) return fail('expired');
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== saved.s) return fail('state');
      try {
        const tokenRes = await fetch(`${LINE_LOGIN.apiBase}/oauth2/v2.1/token`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: LINE_LOGIN.redirectUri,
            client_id: LINE_LOGIN.channelId, client_secret: LINE_LOGIN.secret }) });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenJson.id_token) return fail('token');
        const verifyRes = await fetch(`${LINE_LOGIN.apiBase}/oauth2/v2.1/verify`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ id_token: tokenJson.id_token, client_id: LINE_LOGIN.channelId, nonce: saved.n }) });
        const claims = await verifyRes.json().catch(() => ({}));
        if (!verifyRes.ok || String(claims.aud) !== String(LINE_LOGIN.channelId) || claims.nonce !== saved.n || !claims.sub) return fail('verify');
        const ticket = signLineToken({ u: claims.sub, exp: Date.now() + 30 * 60 * 1000, j: crypto.randomUUID() });
        const setCookies = [clearCookie];
        if (CUSTOMER_LINE_MANAGE) setCookies.push(customerCookie(issueCustomerSession(claims.sub), CUSTOMER_MAX_MS / 1000));
        res.writeHead(302, { Location: `/?line_ticket=${encodeURIComponent(ticket)}`, 'Set-Cookie': setCookies });
        return res.end();
      } catch (error) {
        console.warn('[line-login] callback failed:', error.message, error.cause ? String(error.cause.code || error.cause.message || error.cause) : '');
        return fail('network');
      }
    }
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
      const code=normalizeBookingCode(u.searchParams.get('bookingCode'));
      const item=reservations.find(x=>x.id===reservationId && x.status!=='CANCELLED' && bookingCodeMatches(x, code));
      if(!item) return json(res,401,{error:'預約不存在、已取消或代碼不符'});
      if(!validDate(date)) return json(res,400,{error:'日期格式錯誤'});
      if(!serviceById(serviceId)) return json(res,400,{error:'服務項目無效'});
      return json(res,200,{date,serviceId,...getAvailability(date,serviceId,item.id)});
    }
    if (req.method === 'POST' && u.pathname === '/api/manage/lookup') {
      const data=await readBody(req);
      const phone=normalizePhone(data.phone);
      const code=normalizeBookingCode(data.bookingCode);
      if(!validPhone(phone)) return json(res,400,{error:'請輸入電話'});
      if(!code) return json(res,400,{error:'請輸入預約代碼（格式：BK-日期-六碼）'});
      const today = todayISO();
      const item=readJson(RESERVATIONS_FILE,[]).find(x=>normalizePhone(x.phone)===phone && x.status!=='CANCELLED' && x.date >= today && bookingCodeMatches(x, code));
      if(!item) return json(res,401,{error:'電話或預約代碼不符'});
      const metaAll = await loadReservationMetaFromSupabase();
      const boundSet = await loadBoundReservationIds();
      return json(res,200,{reservations:[{
        lineBindCode: (item.status==='CANCELLED' || reservationHasEnded(item)) ? null : ((metaAll[item.id] || {}).lineBindCode || null),
        lineBound: boundSet.has(item.id),
        id:item.id,name:item.name,birthDate:item.birthDate,phone:item.phone||'',
        serviceId:item.serviceId,serviceName:item.serviceName,durationMinutes:item.durationMinutes,
        date:item.date,startTime:item.startTime,endTime:item.endTime,status:item.status,note:item.note||''
      }]});
    }
    if (req.method === 'POST' && u.pathname === '/api/reservations') {
      const data = await readBody(req);
      // LINE 登入票據（可選）：有效才會綁定本次建立的預約；失敗直接拒絕，不建立預約
      let lineUserId = null, lineJti = null;
      if (data.lineTicket) {
        const t = verifyLineToken(data.lineTicket);
        if (!t || !t.u || !t.j || !t.exp || t.exp < Date.now()) return json(res, 400, { error: 'LINE 登入已過期，請重新登入或改用綁定碼', code: 'LINE_TICKET_INVALID' });
        if (usedLineTickets.has(t.j)) return json(res, 409, { error: '此 LINE 登入已使用，請重新登入', code: 'LINE_TICKET_USED' });
        lineUserId = t.u; lineJti = t.j;
      }
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
      // 快照：同步失敗時還原本機狀態（否則本機會留下一筆未同步、無通知的幻影預約，佔用時段）
      const snapshotReservations = JSON.parse(JSON.stringify(reservations));
      const snapshotCustomers = readJson(CUSTOMERS_FILE, []);
      reservations.push(item);
      // 先更新客人檔（標記為待同步），再由同一次 flush 並行同步預約與客人兩張表，而不是一張接一張
      upsertCustomerFromReservation(item);
      try {
        // queueWrite 內含 flushStorage（寫入 Supabase）。同步失敗會從這裡丟出，必須包在 try 內。
        await queueWrite(RESERVATIONS_FILE, reservations);
      } catch (syncError) {
        // 短期修法：資料庫同步失敗 → 不回 500（客人會誤以為系統壞掉），改回 503 並明確告知「預約未確認」。
        // 注意：本機檔案已寫入（atomicWrite 先於 flushStorage），所以這筆可能仍存在；客人重試若遇到「時段已占用」，代表上一筆其實已成立。
        console.warn('[booking] supabase sync failed; booking rolled back locally:', syncError.message);
        try {
          atomicWrite(RESERVATIONS_FILE, snapshotReservations);
          atomicWrite(CUSTOMERS_FILE, snapshotCustomers);
          invalidateCalendarCaches();
        } catch (restoreError) {
          console.error('[booking] local rollback failed:', restoreError.message);
        }
        return json(res, 503, {
          error: '系統目前無法確認您的預約，請稍後再試。',
          code: 'SYNC_FAILED'
        });
      }
      invalidateCalendarCaches();
      await flushStorage();   // 通常已在上面完成（待同步清單為空，不發出請求）；保留作為殘留重試
      // 預約已儲存：以下附加動作失敗不影響結果（綁定碼失敗時回傳 null，客人頁面會自動隱藏綁定提示）
      // 綁定碼與整合任務彼此獨立，並行寫入（原本依序等待，各多一次網路往返）
      // LINE 登入：先保存綁定；成功才標記為已綁定（管理員通知會合併成一則「已綁定LINE官方」）
      let lineBound = false;
      if (lineUserId) {
        try { await saveLineReservationBinding(item.id, lineUserId); lineBound = true; }
        catch (error) { console.warn('[line-login] save binding failed (reminders will not be sent for this booking):', error.message); }
      }
      if (lineUserId) { try { await saveLineProfile(lineUserId, { name: item.name, birthDate: item.birthDate, phone: item.phone }); } catch (error) { console.warn('[line-profile] save failed (non-fatal):', error.message); } }
      const [lineBindCode] = await Promise.all([
        lineUserId ? Promise.resolve(null) : bestEffortIntegration('line bind token', () => createLineBindToken(item)),
        bestEffortIntegration('enqueue reservation.created', () => enqueueIntegrationJob('reservation.created', item, lineBound ? { lineBound: true } : {})),
      ]);
      if (lineBindCode) {
        // 綁定碼跟著預約走：存在 app_state.reservation_meta（不改 reservations 的 19 欄），供查詢頁與後台顯示
        try {
          await withSyncLock(() => casUpdateReservationMetaEntry(item.id, { lineBindCode, lineBindCodeAt: new Date().toISOString() }));
        } catch (error) { console.warn('[integration] store bind code in meta failed (non-fatal):', error.message); }
      }
      // 喚醒 Worker 只是加速：任務已寫入資料庫，Worker 排程最遲 5 分鐘內會撿到。不阻塞客人的回應。
      notifyWorkerWakeup().catch(() => {});
      if (lineUserId) {
        // 票據僅在預約成功後才標記為已用
        usedLineTickets.set(lineJti, Date.now() + 30 * 60 * 1000);
        for (const [jti, exp] of usedLineTickets) if (exp < Date.now()) usedLineTickets.delete(jti);
      }
      return json(res, 201, { reservation: item, officialUrl: CONFIG.officialUrl, lineBindCode, lineBound });
    }
    if (u.pathname.startsWith('/api/my/')) {
      if (!CUSTOMER_LINE_MANAGE) return json(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') return json(res, 403, { error: '請求來源不正確' });
      const sub = currentCustomerSub(req);
      if (req.method === 'GET' && u.pathname === '/api/my/session') return json(res, 200, { loggedIn: Boolean(sub) });
      if (req.method === 'POST' && u.pathname === '/api/my/logout') {
        const token = parseCookieHeader(req).mh_customer;
        if (token) customerSessions.delete(token);
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'mh_customer=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/' });
      }
      if (!sub) return json(res, 401, { error: '請先以 LINE 登入' });
      if (req.method === 'GET' && u.pathname === '/api/my/reservations') {
        const ids = new Set(await lineReservationIdsOf(sub));
        const today = todayISO();
        const list = readJson(RESERVATIONS_FILE, [])
          .filter(x => ids.has(x.id) && x.status !== 'CANCELLED' && x.date >= today)
          .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
          .map(x => ({ id: x.id, serviceId: x.serviceId, serviceName: x.serviceName, durationMinutes: x.durationMinutes, date: x.date, startTime: x.startTime, endTime: x.endTime, status: x.status }));
        return json(res, 200, { reservations: list });
      }
      if (req.method === 'GET' && u.pathname === '/api/my/profile') return json(res, 200, { profile: (await loadLineProfile(sub)) || null });
      if (req.method === 'GET' && u.pathname === '/api/my/availability') {
        const date = u.searchParams.get('date');
        const serviceId = u.searchParams.get('serviceId') || CONFIG.services.find(x => x.active)?.id;
        const reservationId = String(u.searchParams.get('reservationId') || '');
        const owner = reservationId ? await lineOwnerOf(reservationId) : null;
        const item = readJson(RESERVATIONS_FILE, []).find(x => x.id === reservationId);
        // 不屬於此顧客與不存在一律回相同的 404
        if (!item || owner !== sub || item.status === 'CANCELLED') return json(res, 404, { error: '找不到此預約' });
        if (!validDate(date)) return json(res, 400, { error: '日期格式錯誤' });
        if (!serviceById(serviceId)) return json(res, 400, { error: '服務項目無效' });
        return json(res, 200, { date, serviceId, ...getAvailability(date, serviceId, item.id) });
      }
      const mine = u.pathname.match(/^\/api\/my\/reservations\/([^/]+)\/(cancel|update)$/);
      if (req.method === 'PATCH' && mine) {
        const reservationId = decodeURIComponent(mine[1]);
        const owner = await lineOwnerOf(reservationId);
        const reservations = readJson(RESERVATIONS_FILE, []);
        const item = reservations.find(x => x.id === reservationId);
        // 不屬於此顧客與不存在一律回相同的 404（不洩漏預約是否存在）
        if (!item || owner !== sub || item.status === 'CANCELLED') return json(res, 404, { error: '找不到此預約' });
        const data = await readBody(req);
        return applyReservationAction(res, mine[2], item, reservations, data);
      }
      return json(res, 404, { error: 'Not found' });
    }
    const manageMatch = u.pathname.match(/^\/api\/manage\/reservations\/([^/]+)\/(cancel|update)$/);
    if (req.method === 'PATCH' && manageMatch) {
      const reservationId=decodeURIComponent(manageMatch[1]);
      const action=manageMatch[2];
      const data=await readBody(req);
      const phone=normalizePhone(data.phone);
      const code=normalizeBookingCode(data.bookingCode);
      const reservations=readJson(RESERVATIONS_FILE,[]);
      const item=reservations.find(x=>x.id===reservationId);
      if(!item || item.status==='CANCELLED' || !validPhone(phone) || normalizePhone(item.phone)!==phone || !bookingCodeMatches(item, code))
        return json(res,401,{error:'電話或預約代碼不符'});
      return applyReservationAction(res, action, item, reservations, data);
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
      return json(res, 200, { ok: true }, { 'Set-Cookie': `mh_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/logout') {
      const token = parseCookies(req).mh_admin;
      if (token) sessions.delete(token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'mh_admin=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/' });
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
        'X-Export-Bytes': Buffer.byteLength(exportBody),      // 解壓縮後的位元組數；Render 前端代理可能壓縮並移除 Content-Length（實測發生），Worker 以此為準
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
      if (req.method === 'GET' && u.pathname === '/api/admin/services') {
        return json(res, 200, [...CONFIG.services].sort((a, b) => a.sortOrder - b.sortOrder));
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/services') {
        const data = await readBody(req);
        const result = normalizeServicesInput(data.services);
        if (result.error) return json(res, 400, { error: result.error });
        const incoming = new Set(result.services.map(x => x.id));
        const missing = CONFIG.services.filter(x => !incoming.has(x.id));
        if (missing.length) return json(res, 400, { error: `不可移除既有服務（${missing.map(x => x.name).join('、')}），請改為停用` });
        const previous = CONFIG.services;
        CONFIG.services = result.services;
        try {
          await persistSettings();
        } catch (error) {
          CONFIG.services = previous;
          console.warn('[settings] save failed:', error.message);
          return json(res, 503, { error: '服務設定儲存失敗，請稍後再試' });
        }
        return json(res, 200, { services: result.services });
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
        const endDate = String(data.endDate || '').trim();
        if (endDate && endDate !== date) {
          // 多日連休：僅支援全天；每一天存成一筆（沿用公休資料表，日曆每天一個全天事件）。全部檢查通過才寫入。
          if (!allDay) return json(res,400,{error:'多日公休僅支援全天公休'});
          if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !validDate(endDate)) return json(res,400,{error:'結束日期格式錯誤'});
          if (endDate < date) return json(res,400,{error:'結束日期不可早於開始日期'});
          const days = dateRangeISO(date, endDate);
          if (days.length > 31) return json(res,400,{error:'多日公休最多 31 天'});
          const reservationsAll = readJson(RESERVATIONS_FILE, []);
          const closuresAll = readJson(CLOSURES_FILE, []);
          const bookedDays = days.filter(d => reservationsAll.some(x => x.date === d && x.status !== 'CANCELLED'));
          if (bookedDays.length) return json(res,409,{error:`以下日期已有預約，無法設定公休：${bookedDays.join('、')}`, code:'HAS_RESERVATIONS', dates:bookedDays});
          const partialDays = days.filter(d => closuresAll.some(x => x.date === d && (x.startTime || x.endTime)));
          if (partialDays.length) return json(res,409,{error:`以下日期已有時段公休，請先刪除：${partialDays.join('、')}`, code:'HAS_PARTIAL', dates:partialDays});
          const nowIso = new Date().toISOString();
          const reason = String(data.reason || '').trim().slice(0, 60) || '公休';
          const created = [];
          let skipped = 0;
          for (const d of days) {
            if (closuresAll.some(x => x.date === d && !x.startTime && !x.endTime)) { skipped++; continue; }
            const item = { id: crypto.randomUUID(), date: d, reason, createdAt: nowIso };
            closuresAll.push(item);
            created.push(item);
          }
          if (created.length) { await queueWrite(CLOSURES_FILE, closuresAll); invalidateCalendarCaches(); await emitClosureChanged(); }
          return json(res,201,{closures:created, count:created.length, skipped});
        }
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
        const item={id:crypto.randomUUID(),date,...(allDay?{}:{startTime,endTime}),reason:String(data.reason||'').trim().slice(0,60)||'公休',createdAt:new Date().toISOString()};
        closures.push(item); await queueWrite(CLOSURES_FILE,closures); invalidateCalendarCaches(); await emitClosureChanged(); return json(res,201,{closure:item});
      }
      const closureMatch = u.pathname.match(/^\/api\/admin\/closures\/([^/]+)$/);
      if (req.method === 'DELETE' && closureMatch) {
        const id=decodeURIComponent(closureMatch[1]); const closures=readJson(CLOSURES_FILE,[]); const next=closures.filter(x=>x.id!==id);
        if (next.length===closures.length) return json(res,404,{error:'找不到公休設定'});
        await queueWrite(CLOSURES_FILE,next); invalidateCalendarCaches(); await emitClosureChanged(); return json(res,200,{ok:true});
      }
      // ───── 管理端：新增 / 刪除（軟刪除）預約與客人檔案 ─────
      if (req.method === 'POST' && u.pathname === '/api/admin/reservations') {
        const data = await readBody(req);
        let name, birthDate, phone, customerId = null;
        if (data.customerId) {
          const c = readJson(CUSTOMERS_FILE, []).find(x => x.id === data.customerId);
          if (!c) return json(res, 404, { error: '找不到這位客人' });
          name = normalizeName(c.name); birthDate = normalizeBirthDate(c.birthDate || c.birth_date); phone = normalizePhone(c.phone); customerId = c.id;
        } else {
          name = normalizeName(data.name); birthDate = normalizeBirthDate(data.birthDate); phone = normalizePhone(data.phone);
        }
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
        // 管理員新增：公休、時段衝突、營業時段照一般規則擋下；「當日／過去／最遠預約日」是給客人自助預約的限制，管理員不受限
        if (isClosed(data.date)) return json(res, 400, { error: '該日期為公休，無法新增預約', code: 'CLOSED' });
        const serviceSlots = expectedSlots(data.startTime, service.durationMinutes);
        const blocked = blockedSlots(data.startTime, service.durationMinutes);
        if (!new Set(baseSlotsForDate(data.date)).has(data.startTime) || !isContiguous(serviceSlots)) return json(res, 400, { error: '所選開始時間不在營業時段內', code: 'OUT_OF_HOURS' });
        if (!slotsAvailable(data.date, blocked)) return json(res, 409, { error: '這個時段已被其他預約占用', code: 'CONFLICT' });
        const reservations = readJson(RESERVATIONS_FILE, []);
        const now = new Date().toISOString();
        const item = {
          id: crypto.randomUUID(), bookingCode: generateBookingCode(reservations),
          name, birthDate, phone, note,
          serviceId: service.id, serviceName: service.name, durationMinutes: service.durationMinutes,
          date: data.date, startTime: serviceSlots[0], endTime: fromMinutes(toMinutes(serviceSlots[serviceSlots.length - 1]) + CONFIG.slotMinutes),
          serviceSlots, slots: blocked, status: 'CONFIRMED', createdAt: now, updatedAt: now, cancelledAt: null
        };
        if (customerId) item.customerId = customerId;
        reservations.push(item);
        await queueWrite(RESERVATIONS_FILE, reservations);
        invalidateCalendarCaches();
        upsertCustomerFromReservation(item);
        await flushStorage();
        await emitClosureChanged();                                  // 只喚醒 Worker 對帳日曆；管理員自己新增，不發 LINE 通知
        return json(res, 201, { reservation: item });
      }
      const adminResDel = u.pathname.match(/^\/api\/admin\/reservations\/([^/]+)$/);
      if (req.method === 'DELETE' && adminResDel) {
        const out = await softDeleteReservation(decodeURIComponent(adminResDel[1]));
        return json(res, out.status, out.body);
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/customers') {
        const data = await readBody(req);
        const name = normalizeName(data.name), birthDate = normalizeBirthDate(data.birthDate), phone = normalizePhone(data.phone), lineId = normalizeLineId(data.lineId);
        const missing = [];
        if (!name) missing.push('姓名');
        if (!validBirthDate(birthDate)) missing.push('西元生日');
        if (!validPhone(phone)) missing.push('電話');
        if (missing.length) return json(res, 400, { error: `客人資料不完整：${missing.join('、')}` });
        const customers = readJson(CUSTOMERS_FILE, []);
        const dup = customers.find(c => samePersonRecord(c, { name, birthDate }));
        if (dup) return json(res, 409, { error: '已有相同姓名與生日的客人檔案', code: 'DUPLICATE', customerId: dup.id });
        const inBin = (await loadRecycleBin()).find(e => e.type === 'customer' && samePersonRecord(e.customer, { name, birthDate }));
        if (inBin) return json(res, 409, { error: '回收桶中已有相同姓名與生日的客人，請從回收桶還原', code: 'IN_RECYCLE_BIN', binId: inBin.id });
        const now = new Date().toISOString();
        const customer = { id: crypto.randomUUID(), name, birthDate, phone, lineId, createdAt: now, updatedAt: now, history: [], tags: [] };
        customers.push(customer);
        atomicWrite(CUSTOMERS_FILE, customers);
        await flushStorage();
        return json(res, 201, { customer });
      }
      const adminCustPatch = u.pathname.match(/^\/api\/admin\/customers\/([^/]+)$/);
      if (req.method === 'PATCH' && adminCustPatch) {
        const data = await readBody(req);
        const id = decodeURIComponent(adminCustPatch[1]);
        const customers = readJson(CUSTOMERS_FILE, []);
        const c = customers.find(x => x.id === id);
        if (!c) return json(res, 404, { error: '找不到此客人' });
        if (typeof data.staffNote === 'string') { c.staffNote = data.staffNote.slice(0, 2000); c.updatedAt = new Date().toISOString(); }
        atomicWrite(CUSTOMERS_FILE, customers);
        await flushStorage();
        return json(res, 200, { customer: c });
      }
      const adminHistDel = u.pathname.match(/^\/api\/admin\/customers\/([^/]+)\/history\/([^/]+)$/);
      if (req.method === 'DELETE' && adminHistDel) {
        // 從客人檔案刪除某筆歷史 = 刪除對應的預約（雙向同步只有這一條邏輯路徑）
        const cust = readJson(CUSTOMERS_FILE, []).find(x => x.id === decodeURIComponent(adminHistDel[1]));
        const rid = decodeURIComponent(adminHistDel[2]);
        if (!cust || !(Array.isArray(cust.history) ? cust.history : []).some(h => h.reservationId === rid)) return json(res, 404, { error: '找不到這筆歷史預約紀錄' });
        const out = await softDeleteReservation(rid);
        return json(res, out.status, out.body);
      }
      const adminCustDel = u.pathname.match(/^\/api\/admin\/customers\/([^/]+)$/);
      if (req.method === 'DELETE' && adminCustDel) {
        const out = await softDeleteCustomer(decodeURIComponent(adminCustDel[1]));
        return json(res, out.status, out.body);
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/recycle-bin') {
        const bin = await loadRecycleBin();
        const liveIds = new Set(readJson(RESERVATIONS_FILE, []).map(x => x.id));
        const items = bin.map(e => ({ id: e.id, type: e.type, deletedAt: e.deletedAt, summary: e.summary, alreadyLive: e.type === 'reservation' && liveIds.has(e.reservation.id) }))
          .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
        return json(res, 200, items);
      }
      const adminBin = u.pathname.match(/^\/api\/admin\/recycle-bin\/([^/]+)(\/restore)?$/);
      if (req.method === 'POST' && adminBin && adminBin[2]) {
        const out = await restoreFromRecycleBin(decodeURIComponent(adminBin[1]));
        return json(res, out.status, out.body);
      }
      if (req.method === 'DELETE' && adminBin && !adminBin[2]) {
        const bin = await loadRecycleBin(); const id = decodeURIComponent(adminBin[1]);
        if (!bin.some(x => x.id === id)) return json(res, 404, { error: '回收桶中找不到這個項目' });
        await saveRecycleBin(bin.filter(x => x.id !== id));
        console.log(`[admin] recycle bin ${id} permanently removed`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/customers') {
        const customers=readJson(CUSTOMERS_FILE,[]).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant')); return json(res,200,customers);
      }
      if (req.method === 'GET' && u.pathname === '/api/admin/reservations') {
        await sweepExpiredToFinished();
        const date = u.searchParams.get('date');
        const status = u.searchParams.get('status');
        let list = readJson(RESERVATIONS_FILE, []);
        if (date) list = list.filter(x => x.date === date);
        if (status) list = list.filter(x => x.status === status);
        list.sort((a,b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
        // 綁定碼與已綁定旗標：已取消或已結束的預約不顯示碼（回 null）；讀取失敗時仍回傳列表（碼為 null）
        const metaAll = await loadReservationMetaFromSupabase();
        const boundSet = await loadBoundReservationIds();
        const out = list.map(item => ({
          ...item,
          lineBindCode: (item.status === 'CANCELLED' || reservationHasEnded(item)) ? null : ((metaAll[item.id] || {}).lineBindCode || null),
          lineBound: boundSet.has(item.id),
        }));
        return json(res, 200, out);
      }
      const statusMatch = u.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/status$/);
      if (req.method === 'PATCH' && statusMatch) {
        const id=decodeURIComponent(statusMatch[1]); const data=await readBody(req);
        const allowed=['Finished','Cancel','No-show','Other'];
        if(!allowed.includes(data.statusLabel) && data.statusLabel!=='') return json(res,400,{error:'預定狀態無效'});
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
        // 客人資料先更新，預約與客人由同一次並行同步寫入（原本兩次依序同步）
        upsertCustomerFromReservation(item);
        await queueWrite(RESERVATIONS_FILE,reservations); invalidateCalendarCaches();
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
        // 先寫本機、再同步同一人的標籤（syncPersonTags 直接讀寫本機檔），最後只做一次並行同步
        atomicWrite(RESERVATIONS_FILE,reservations);
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
        // 客人歷史也會顯示備註，先更新再由同一次並行同步寫入，避免留下未同步的狀態
        upsertCustomerFromReservation(item);
        await queueWrite(RESERVATIONS_FILE, reservations);
        invalidateCalendarCaches();
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

/* ───────────── 服務設定（後台可編輯）─────────────
 * Supabase 模式：app_state.settings；本機模式：data/settings.json。
 * 停用（active=false）的服務不在前台顯示、不可預約；既有預約保留當時的服務資訊。
 * 服務只能停用、不能移除，避免歷史資料指向不存在的服務。
 */
async function persistSettings() {
  const payload = { services: CONFIG.services, schedule: CONFIG.schedule };
  if (STORAGE_MODE === 'supabase') {
    await supabaseRequest('app_state', 'POST', { key: 'settings', value: payload, updated_at: new Date().toISOString() },
      '?on_conflict=key', 'resolution=merge-duplicates,return=representation');
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}
async function loadSettingsFromSupabase() {
  if (STORAGE_MODE !== 'supabase') return;
  const rows = await supabaseRequest('app_state', 'GET', null, '?select=value&key=eq.settings&limit=1');
  const v = rows?.[0]?.value;
  if (v && Array.isArray(v.services)) CONFIG.services = v.services;
  if (v && v.schedule && typeof v.schedule === 'object') CONFIG.schedule = v.schedule;
}
function normalizeServicesInput(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: '服務資料格式錯誤' };
  if (list.length > 30) return { error: '服務數量過多（最多 30 項）' };
  const seen = new Set();
  const out = [];
  for (const [i, raw] of list.entries()) {
    const name = String(raw?.name ?? '').trim();
    if (!name) return { error: `第 ${i + 1} 筆：服務名稱不可為空` };
    if (name.length > 40) return { error: `「${name}」：服務名稱最多 40 字` };
    const duration = Number(raw?.durationMinutes);
    if (!Number.isInteger(duration) || duration < CONFIG.slotMinutes || duration > 480 || duration % CONFIG.slotMinutes) {
      return { error: `「${name}」：服務時長須為 ${CONFIG.slotMinutes} 分鐘的倍數（${CONFIG.slotMinutes}～480）` };
    }
    const price = Number(raw?.price);
    if (!Number.isInteger(price) || price < 0 || price > 99999) return { error: `「${name}」：價格須為 0～99999 的整數` };
    const description = String(raw?.description ?? '').trim().slice(0, 120) || `完整約 ${duration} 分鐘`;
    let id = String(raw?.id || '').trim();
    if (!id) id = 'svc-' + crypto.randomBytes(4).toString('hex');
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return { error: `「${name}」：服務代碼格式錯誤` };
    if (seen.has(id)) return { error: `服務代碼重複：${id}` };
    seen.add(id);
    out.push({ id, name, description, price, durationMinutes: duration, active: raw?.active !== false, sortOrder: i + 1 });
  }
  return { services: out };
}
function dateRangeISO(start, end) {
  const out = [];
  let d = start;
  while (d <= end && out.length <= 31) {
    out.push(d);
    d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  }
  return out;
}

/* ───────── LINE Login（預約時綁定 LINE；6 碼流程保留）─────────
 * 綁定對象：這次建立的預約本身（不依電話）。票據為 HMAC 簽章，15 分鐘有效、只能使用一次，
 * 只能用於建立「本次登入者自己的」新預約，不能綁定既有預約。
 */
const LINE_LOGIN = {
  channelId: process.env.LINE_LOGIN_CHANNEL_ID || '2012360576',
  get secret() { return process.env.LINE_LOGIN_CHANNEL_SECRET || ''; },
  redirectUri: `${process.env.PUBLIC_BASE_URL || 'https://ronnie-s-witchery-corner.onrender.com'}/auth/line/callback`,
  apiBase: process.env.LINE_API_BASE || 'https://api.line.me',
  // 授權頁在 access.line.me（與 token／verify 的 api.line.me 不同主機）
  authBase: process.env.LINE_AUTH_BASE || 'https://access.line.me',
};
const LINE_BINDINGS_FILE = path.join(DATA_DIR, 'line_bindings.json');
const usedLineTickets = new Map();   // jti → 過期時間（單次使用；重啟後清空，票據 15 分鐘內仍有效，風險極低）
function lineHmac(data) {
  return crypto.createHmac('sha256', 'line-login:' + LINE_LOGIN.secret).update(data).digest('base64url');
}
function signLineToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + lineHmac(body);
}
function verifyLineToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = lineHmac(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
function parseCookieHeader(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
/* ───────── 顧客 LINE 工作階段（2a；旗標 CUSTOMER_LINE_MANAGE=on 才啟用）─────────
 * 閒置 2 小時、上限 8 小時；記憶體保存（重啟後需重新登入，與管理員登入一致）。
 * SameSite=Lax：LINE 授權頁回呼是跨站導向，Strict 可能導致首次請求帶不到 Cookie；
 * CSRF 防護由 Lax + 所有寫入端點的 X-Requested-With 標頭共同提供。
 */
const CUSTOMER_LINE_MANAGE = process.env.CUSTOMER_LINE_MANAGE === 'on';
const customerSessions = new Map();   // token → { sub, issuedAt, lastSeenAt }
const CUSTOMER_IDLE_MS = 2 * 60 * 60_000;
const CUSTOMER_MAX_MS = 8 * 60 * 60_000;
function issueCustomerSession(sub) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  customerSessions.set(token, { sub, issuedAt: now, lastSeenAt: now });
  return token;
}
function currentCustomerSub(req) {
  const token = parseCookieHeader(req).mh_customer;
  if (!token) return null;
  const s = customerSessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeenAt > CUSTOMER_IDLE_MS || now - s.issuedAt > CUSTOMER_MAX_MS) { customerSessions.delete(token); return null; }
  s.lastSeenAt = now;
  return s.sub;
}
function customerCookie(token, maxAgeSec) {
  return `mh_customer=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}
async function lineOwnerOf(reservationId) {
  if (STORAGE_MODE === 'supabase') {
    const rows = await supabaseRequest('app_state', 'GET', null, `?select=value&key=eq.${encodeURIComponent('line_reservation:' + reservationId)}&limit=1`);
    return (rows && rows[0] && rows[0].value && rows[0].value.userId) || null;
  }
  return (readJson(LINE_BINDINGS_FILE, {})[reservationId] || {}).userId || null;
}
async function lineReservationIdsOf(sub) {
  if (STORAGE_MODE === 'supabase') {
    const rows = await supabaseRequest('app_state', 'GET', null, '?select=key,value&key=like.line_reservation:*');
    return (rows || []).filter(r => r.value && r.value.userId === sub).map(r => String(r.key).slice('line_reservation:'.length));
  }
  return Object.entries(readJson(LINE_BINDINGS_FILE, {})).filter(([, v]) => v && v.userId === sub).map(([id]) => id);
}
// 取消與改期的業務邏輯（管理端電話+代碼、顧客端工作階段共用，行為完全相同）
async function applyReservationAction(res, action, item, reservations, data) {
  if (action === 'cancel') {
    markReservationCancelled(item);
    await queueWrite(RESERVATIONS_FILE, reservations); invalidateCalendarCaches(); upsertCustomerFromReservation(item); await flushStorage();
    await bestEffortIntegration('enqueue reservation.cancelled', () => enqueueIntegrationJob('reservation.cancelled', item)); await notifyWorkerWakeup();
    return json(res, 200, { ok: true, reservation: { id: item.id, status: item.status } });
  }
  const service = serviceById(data.serviceId);
  if (!validDate(data.date) || !service || typeof data.startTime !== 'string') return json(res, 400, { error: '新的日期、服務或時間不完整' });
  const today = todayISO();
  if (data.date <= today) return json(res, 400, { error: '當日及過去日期不可預約，請選擇明日或之後' });
  if (data.date > maxBookingDateISO()) return json(res, 400, { error: `目前可預約至 ${maxBookingDateISO()}` });
  if (isClosed(data.date)) return json(res, 400, { error: '該日期為公休，無法預約' });
  const allowedStarts = new Set(baseSlotsForDate(data.date));
  const serviceSlots = expectedSlots(data.startTime, service.durationMinutes);
  const blocked = blockedSlots(data.startTime, service.durationMinutes);
  if (!allowedStarts.has(data.startTime) || !isContiguous(serviceSlots)) return json(res, 400, { error: '所選開始時間不在可預約範圍內' });
  if (!slotsAvailable(data.date, blocked, item.id)) return json(res, 409, { error: '新的時段剛剛已被其他使用者預約，請重新選擇' });
  item.serviceId = service.id; item.serviceName = service.name; item.durationMinutes = service.durationMinutes;
  item.date = data.date; item.startTime = serviceSlots[0];
  item.endTime = fromMinutes(toMinutes(serviceSlots[serviceSlots.length - 1]) + CONFIG.slotMinutes);
  item.serviceSlots = serviceSlots; item.slots = blocked; item.updatedAt = new Date().toISOString();
  await queueWrite(RESERVATIONS_FILE, reservations); invalidateCalendarCaches(); upsertCustomerFromReservation(item); await flushStorage();
  await bestEffortIntegration('enqueue reservation.updated', () => enqueueIntegrationJob('reservation.updated', item)); await notifyWorkerWakeup();
  return json(res, 200, { ok: true, reservation: item });
}
const LINE_PROFILES_FILE = path.join(DATA_DIR, 'line_profiles.json');
// 上次填寫資料（僅姓名、生日、電話；備註不保存）。以 LINE userId 為鍵，本人登入後才可讀取
async function saveLineProfile(sub, profile) {
  const value = { name: profile.name || '', birthDate: profile.birthDate || '', phone: profile.phone || '', updatedAt: new Date().toISOString() };
  if (STORAGE_MODE === 'supabase') {
    await supabaseRequest('app_state', 'POST', { key: 'line_profile:' + sub, value, updated_at: value.updatedAt }, '?on_conflict=key', 'resolution=merge-duplicates,return=representation');
    return;
  }
  const all = readJson(LINE_PROFILES_FILE, {}); all[sub] = value; atomicWrite(LINE_PROFILES_FILE, all);
}
async function loadLineProfile(sub) {
  if (STORAGE_MODE === 'supabase') {
    const rows = await supabaseRequest('app_state', 'GET', null, '?select=value&key=eq.' + encodeURIComponent('line_profile:' + sub) + '&limit=1');
    return (rows && rows[0] && rows[0].value) || null;
  }
  return readJson(LINE_PROFILES_FILE, {})[sub] || null;
}
async function saveLineReservationBinding(reservationId, userId) {
  const value = { userId, boundAt: new Date().toISOString(), source: 'login' };
  if (STORAGE_MODE === 'supabase') {
    await supabaseRequest('app_state', 'POST', { key: `line_reservation:${reservationId}`, value, updated_at: value.boundAt },
      '?on_conflict=key', 'resolution=merge-duplicates,return=representation');
    return;
  }
  const all = readJson(LINE_BINDINGS_FILE, {});
  all[reservationId] = value;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LINE_BINDINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, LINE_BINDINGS_FILE);
}

async function startServer() {
  if (STORAGE_MODE === 'supabase') {
    await hydrateFromSupabase();
    await loadSettingsFromSupabase();
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
// 已過期、未取消、且沒有預定狀態的預約 → 自動標記為 Finished（會保存；手動設定過的不覆寫）
async function sweepExpiredToFinished(){
  const reservations = readJson(RESERVATIONS_FILE, []);
  let changed = 0;
  for (const item of reservations) {
    if (item.status !== 'CANCELLED' && !item.statusLabel && reservationHasEnded(item)) {
      item.statusLabel = 'Finished';
      changed++;
    }
  }
  if (changed) await queueWrite(RESERVATIONS_FILE, reservations);
}
