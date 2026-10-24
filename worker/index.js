/**
 * Ronnie's Witchery Corner — Integration Worker (Cloudflare Workers, ES module, 無外部相依)
 *
 * 功能（皆有獨立開關，值為 off | dry | on，預設 off）：
 *   FEATURE_ADMIN_NOTIFY   新增/修改/取消預約 → LINE 通知管理者
 *   FEATURE_REMINDERS      預約前一天 17:00（台北）→ LINE 提醒客人
 *   FEATURE_CALENDAR       預約與公休 ⇄ Google 日曆（單向：網站 → 日曆）
 *   FEATURE_BACKUP         定時匯出後台資料 → Google Drive
 *   FEATURE_LINE_BINDING   LINE Webhook：客人傳 6 碼綁定碼完成綁定（on / off）
 *
 *   dry = 完整執行判斷與組訊息，但「不呼叫」LINE / Google，只寫入執行紀錄，供上線前試跑。
 *
 * 回退：把對應 FEATURE_* 改回 off（Cloudflare 儀表板即時生效，不需重新部署）。
 *
 * 設計原則：
 *  - 不更動 Supabase 資料表結構；只使用既有欄位與 app_state 通用表。
 *  - integration_jobs 只使用 pending / done / failed 三種狀態；以 run_after 當租約，避免重複處理。
 *  - 日曆事件使用「由預約 id 推導的固定事件 ID」＋私有屬性 ronnie=1：重複執行不會產生重複事件，
 *    也只會動到本系統建立的事件，不碰你自己的其他行程。
 */

/**
 * 排程（UTC；必須與 wrangler.toml 的 crons 完全一致，tests 會比對）。
 * - tick：每 5 分鐘處理 job、掃描「預約前一天 17:00（台北）」的提醒。提醒時間由程式以 Asia/Taipei 計算，
 *   與 cron 的小時無關（cron 只負責「定期醒來檢查」），所以不會有 UTC/台北時區換算錯誤。
 * - backups：19:00 UTC = 03:00 台北；20:00 UTC = 04:00 台北（重試：當天已成功就略過）。
 */
export const CRONS = { tick: '*/5 * * * *', backups: ['0 19 * * *', '0 20 * * *'] };
const TZ_OFFSET_MS = 8 * 3600e3; // Asia/Taipei，無日光節約時間
const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 15, 60, 180];
const LEASE_MS = 5 * 60e3;
const DEFAULT_BATCH = 4;           // 每輪處理的 job 數：配合 Cloudflare 免費方案「每次執行最多 50 個對外請求」
const DEFAULT_RECONCILE_OPS = 25;  // 日曆對帳每輪最多寫入的事件數；超過的下一輪（15 分鐘後）繼續
const STALE_JOB_MS = 6 * 3600e3;
const BACKUP_PREFIX = 'Ronnie-Witchery-Corner-backup-v2-';
const BACKUP_NAME_RE = /^Ronnie-Witchery-Corner-backup-v2-\d{8}-\d{4}\.json$/;
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/* ───────────────────────── 設定檢查 ───────────────────────── */

const SB = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const GOOGLE = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
export const REQUIRED_CONFIG = {
  FEATURE_ADMIN_NOTIFY: [...SB, 'LINE_CHANNEL_ACCESS_TOKEN', 'ADMIN_LINE_USER_ID'],
  FEATURE_REMINDERS: [...SB, 'LINE_CHANNEL_ACCESS_TOKEN'],
  FEATURE_CALENDAR: [...SB, ...GOOGLE, 'GOOGLE_CALENDAR_ID'],
  FEATURE_BACKUP: [...GOOGLE, 'GOOGLE_DRIVE_FOLDER_ID', 'RENDER_BASE_URL', 'INTEGRATION_WORKER_SECRET'],
  FEATURE_LINE_BINDING: [...SB, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'],
};
/** 回傳「已啟用（on/dry）但缺少」的設定名稱（只回傳名稱，絕不輸出值）。force=true 時不看開關。 */
export function missingConfig(env, feature, force = false) {
  if (!force && featureMode(env, feature) === 'off') return [];
  return REQUIRED_CONFIG[feature].filter(k => !String(env[k] ?? '').trim());
}
function assertConfig(env, feature, force = false) {
  const miss = missingConfig(env, feature, force);
  if (miss.length) throw new Error(`缺少設定：${miss.join(', ')}（${feature}）`);
}

/* ───────────────────────── 基礎工具 ───────────────────────── */

export function featureMode(env, name) {
  const v = String(env[name] || 'off').trim().toLowerCase();
  return v === 'on' || v === 'dry' ? v : 'off';
}

export function taipeiDate(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function taipeiStamp(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
export function taipeiToUtcMs(date, time) {
  const [y, m, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm || 0) - TZ_OFFSET_MS;
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
const enc = encodeURIComponent;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
// Cloudflare 免費方案：每次執行最多 50 個對外請求（付費方案 1000）。預設預算 40，留 10 個緩衝；付費方案請設 SUBREQUEST_BUDGET。
const DEFAULT_SUBREQUEST_BUDGET = 40;
const JOB_COST = 12;        // 處理一個 job 的最壞請求數估計（領取、LINE、資料庫讀取、Google×2、更新×3）
const OP_COST = 3;          // 日曆單筆寫入的最壞請求數（POST + PATCH + 緩衝）

/** 本次執行已使用/剩餘的對外請求數。每次執行（HTTP 請求或 cron）開始時歸零。 */
export function budgetLeft(env, deps) {
  const max = Math.max(5, Number(env.SUBREQUEST_BUDGET) || DEFAULT_SUBREQUEST_BUDGET);
  return max - (deps.state.subrequests || 0);
}
/** 每個入口（HTTP / cron）開頭呼叫：回傳計數歸零的 deps，避免長壽命的 deps 把預算累積耗盡。log 陣列仍共用。 */
function freshBudget(deps) { return { ...deps, state: { ...deps.state, subrequests: 0 } }; }

/** 暫時性錯誤（網路中斷、逾時、5xx、429、408）：重試通常有效；其餘（400/401/403/404…）視為永久性。 */
export function transientError(message, { status } = {}) {
  const e = new Error(message);
  e.transient = status === undefined || status >= 500 || status === 429 || status === 408;
  e.status = status;
  return e;
}
/** 所有對外請求都經過這裡：統一逾時（預設 15 秒，可用 FETCH_TIMEOUT_MS 調整），網路層錯誤標記為暫時性。 */
async function tfetch(env, deps, url, opts = {}) {
  const ms = Math.max(50, Number(env.FETCH_TIMEOUT_MS) || DEFAULT_FETCH_TIMEOUT_MS);
  deps.state.subrequests = (deps.state.subrequests || 0) + 1;     // 計數（含失敗的請求，Cloudflare 也會計入）
  try {
    return await deps.fetch(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    const e = transientError(`網路錯誤或逾時：${String(error.message || error).slice(0, 120)}`);
    throw e;
  }
}

function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(str) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); }
export async function uuidFromString(str) {
  const b = new Uint8Array(await sha256(str)).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function fingerprint(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}
/** Google 日曆事件 ID 只能用 a-v 與 0-9：以 id 的 UTF-8 十六進位表示，固定且可重算。 */
export function eventIdFor(kind, id) {
  // 固定前綴 ronnie（皆為 a-v 字元）確保長度必定 ≥ 5，且一眼可辨識是本系統建立的事件
  return (kind === 'closure' ? 'ronniec' : 'ronnier') + hex(new TextEncoder().encode(String(id)));
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  const ax = new Uint8Array(x), ay = new Uint8Array(y);
  let diff = 0; for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ ay[i];
  return diff === 0;
}
export function normalizePhoneKey(phone) { return String(phone || '').replace(/\D/g, ''); }

export function makeDeps(overrides = {}) {
  return { fetch: (...a) => fetch(...a), now: () => Date.now(), log: [], state: {}, ...overrides };
}
function logEvent(deps, event) {
  const rec = { t: new Date(deps.now()).toISOString(), ...event };
  deps.log.push(rec);
  console.log(JSON.stringify(rec));
}

/* ───────────────────────── 資料轉換 ───────────────────────── */

export function normalizeReservation(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name || '',
    phone: r.phone || '',
    lineId: r.lineId ?? r.line_id ?? '',
    note: r.note || '',
    serviceName: r.serviceName ?? r.service_name ?? '',
    durationMinutes: r.durationMinutes ?? r.duration_minutes ?? 30,
    date: r.date,
    startTime: r.startTime ?? r.start_time,
    endTime: r.endTime ?? r.end_time,
    status: r.status || 'CONFIRMED',
    createdAt: r.createdAt ?? r.created_at,
    updatedAt: r.updatedAt ?? r.updated_at,
  };
}
function normalizeClosure(c) {
  return { id: c.id, date: c.date, startTime: c.startTime ?? c.start_time ?? '', endTime: c.endTime ?? c.end_time ?? '' };
}
function endTimeOf(r) {
  if (r.endTime) return r.endTime;
  const [h, m] = String(r.startTime).split(':').map(Number);
  const t = h * 60 + m + Number(r.durationMinutes || 30);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/* ───────────────────────── Supabase ───────────────────────── */

async function sb(env, deps, path, { method = 'GET', query = '', body, prefer } = {}) {
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await tfetch(env, deps, `${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${path}${query}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw transientError(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  return text ? JSON.parse(text) : null;
}
async function recordRun(env, deps, task, ok, summary) {
  try {
    await sb(env, deps, 'app_state', {
      method: 'POST', query: '?on_conflict=key', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: `worker_last_run:${task}`, value: { at: new Date(deps.now()).toISOString(), ok, summary }, updated_at: new Date(deps.now()).toISOString() },
    });
  } catch { /* 執行紀錄寫入失敗不影響主流程 */ }
}

/* ───────────────────────── LINE ───────────────────────── */

export async function linePush(env, deps, to, text, retryKeySeed) {
  const mode = 'LINE_PUSH';
  if (!to) throw new Error('缺少 LINE 收件人');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  if (retryKeySeed) headers['X-Line-Retry-Key'] = await uuidFromString(retryKeySeed);
  const res = await tfetch(env, deps, `${env.LINE_API_BASE || 'https://api.line.me'}/v2/bot/message/push`, {
    method: 'POST', headers, body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  // 409 = 相同 retry key 已成功送出過，視為成功（避免重複訊息）
  if (!res.ok && res.status !== 409) throw transientError(`${mode} ${res.status}: ${(await res.text()).slice(0, 200)}`, { status: res.status });
  return { sent: true };
}
/** 回覆訊息；失敗不丟錯，回傳是否成功（replyToken 約 1 分鐘內有效，過期屬正常情況）。 */
async function lineReply(env, deps, replyToken, text) {
  if (!replyToken) return false;
  try {
    const res = await tfetch(env, deps, `${env.LINE_API_BASE || 'https://api.line.me'}/v2/bot/message/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) { logEvent(deps, { task: 'line_reply_failed', status: res.status }); return false; }
    return true;
  } catch (error) {
    logEvent(deps, { task: 'line_reply_failed', error: String(error.message || error) });
    return false;
  }
}
/** 先用 reply；失敗（過期、LINE 暫時故障）則改用 push 補送，確保使用者知道結果。 */
async function replyOrPush(env, deps, ev, text) {
  if (await lineReply(env, deps, ev.replyToken, text)) return;
  try { await linePush(env, deps, ev.source.userId, text); }
  catch (error) { logEvent(deps, { task: 'line_push_fallback_failed', error: String(error.message || error) }); }
}

export function adminMessage(type, r) {
  const head = { 'reservation.created': '🆕 新預約', 'reservation.updated': '✏️ 預約已修改', 'reservation.cancelled': '❌ 預約已取消' }[type] || '📌 預約異動';
  const lines = [
    head,
    `姓名：${r.name}`,
    `電話：${r.phone}`,
    `服務：${r.serviceName}`,
    `時間：${r.date}（週${weekday(r.date)}）${r.startTime}–${endTimeOf(r)}`,
  ];
  if (r.lineId) lines.push(`LINE ID：${r.lineId}`);
  if (r.note) lines.push(`備註：${r.note}`);
  return lines.join('\n');
}
export function reminderMessage(r) {
  return [
    '【蘿妮的療癒空間｜預約提醒】',
    `${r.name} 您好 🌙`,
    `提醒您，明天 ${r.date}（週${weekday(r.date)}）${r.startTime}–${endTimeOf(r)} 有預約。`,
    `服務：${r.serviceName}`,
    '如需調整請提早與我們聯繫，期待與您見面 ✦',
  ].join('\n');
}

/* ───────────────────────── Google ───────────────────────── */

async function googleToken(env, deps) {
  const c = deps.state.googleToken;
  if (c && c.exp > deps.now() + 60e3) return c.value;
  const res = await tfetch(env, deps, env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok && (res.status === 400 || res.status === 401)) deps.state.googleAuthFailed = true;   // 讓本次執行結束時通知管理者
  if (!res.ok) throw transientError(`Google token ${res.status}（若為 invalid_grant，代表授權已失效，請重新取得 refresh token）: ${(await res.text()).slice(0, 200)}`, { status: res.status });
  const j = await res.json();
  deps.state.googleToken = { value: j.access_token, exp: deps.now() + (Number(j.expires_in) || 3600) * 1000 };
  return j.access_token;
}
async function gfetch(env, deps, url, { method = 'GET', body, headers = {}, rawBody, okStatuses = [] } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await googleToken(env, deps);
    const res = await tfetch(env, deps, url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (res.status === 401 && attempt === 0) { deps.state.googleToken = null; continue; }
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) throw transientError(`Google ${method} ${url.split('?')[0]} ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: res.status, json, headers: res.headers };
  }
  throw new Error('Google 授權失敗');
}
const calBase = env => `${env.GOOGLE_CALENDAR_API || 'https://www.googleapis.com/calendar/v3'}/calendars/${enc(env.GOOGLE_CALENDAR_ID)}/events`;

export function reservationEvent(r) {
  const end = endTimeOf(r);
  const body = {
    summary: `${r.name}｜${r.serviceName}`,
    description: [`電話：${r.phone}`, r.lineId ? `LINE ID：${r.lineId}` : '', r.note ? `備註：${r.note}` : '', `預約編號：${r.id}`].filter(Boolean).join('\n'),
    start: { dateTime: `${r.date}T${r.startTime}:00+08:00`, timeZone: 'Asia/Taipei' },
    end: { dateTime: `${r.date}T${end}:00+08:00`, timeZone: 'Asia/Taipei' },
    reminders: { useDefault: false },
  };
  const fp = fingerprint(JSON.stringify([body.summary, body.description, body.start, body.end]));
  body.extendedProperties = { private: { ronnie: '1', kind: 'reservation', rid: String(r.id), fp } };
  return { id: eventIdFor('reservation', r.id), body, fp };
}
export function closureEvent(c) {
  const allDay = !c.startTime && !c.endTime;
  const body = { summary: '公休', description: `公休設定 ${c.id}`, reminders: { useDefault: false }, colorId: '8' };
  if (allDay) { body.start = { date: c.date }; body.end = { date: addDays(c.date, 1) }; }
  else {
    body.start = { dateTime: `${c.date}T${c.startTime}:00+08:00`, timeZone: 'Asia/Taipei' };
    body.end = { dateTime: `${c.date}T${c.endTime}:00+08:00`, timeZone: 'Asia/Taipei' };
  }
  const fp = fingerprint(JSON.stringify([body.summary, body.start, body.end]));
  body.extendedProperties = { private: { ronnie: '1', kind: 'closure', rid: String(c.id), fp } };
  return { id: eventIdFor('closure', c.id), body, fp };
}
async function calendarUpsert(env, deps, ev) {
  const base = calBase(env);
  const r = await gfetch(env, deps, base, { method: 'POST', body: { id: ev.id, ...ev.body }, okStatuses: [409] });
  if (r.status === 409) {
    // 已存在（含曾被刪除的同 ID 事件）→ 更新並確保為 confirmed
    await gfetch(env, deps, `${base}/${ev.id}`, { method: 'PATCH', body: { ...ev.body, status: 'confirmed' } });
    return 'updated';
  }
  return 'created';
}
async function calendarDelete(env, deps, eventId) {
  const r = await gfetch(env, deps, `${calBase(env)}/${eventId}`, { method: 'DELETE', okStatuses: [404, 410] });
  return r.status === 204 || r.status === 200 ? 'deleted' : 'absent';
}

/** 單筆預約同步：以資料庫「目前狀態」為準（不是 job 當時的快照），避免重試造成舊資料覆蓋新資料。 */
async function syncReservationById(env, deps, id) {
  const rows = await sb(env, deps, 'reservations', { query: `?id=eq.${enc(id)}&select=*` });
  const r = normalizeReservation(rows && rows[0]);
  if (!r || r.status === 'CANCELLED') return calendarDelete(env, deps, eventIdFor('reservation', id));
  return calendarUpsert(env, deps, reservationEvent(r));
}

/** 全量對帳：補齊遺漏、修正差異、移除已取消/已刪除。只處理帶 ronnie=1 的事件。 */
export async function reconcileCalendar(env, deps) {
  assertConfig(env, 'FEATURE_CALENDAR', true);
  const nowMs = deps.now();
  const windowStart = addDays(taipeiDate(nowMs), -7);
  const [resRows, cloRows] = await Promise.all([
    sb(env, deps, 'reservations', { query: `?date=gte.${windowStart}&status=neq.CANCELLED&select=*&limit=2000` }),
    sb(env, deps, 'closures', { query: `?date=gte.${windowStart}&select=*&limit=2000` }),
  ]);
  const desired = new Map();
  for (const r of resRows || []) { const ev = reservationEvent(normalizeReservation(r)); desired.set(ev.id, ev); }
  for (const c of cloRows || []) { const ev = closureEvent(normalizeClosure(c)); desired.set(ev.id, ev); }

  const existing = new Map();
  let pageToken = '';
  do {
    const q = `?privateExtendedProperty=${enc('ronnie=1')}&timeMin=${enc(new Date(taipeiToUtcMs(windowStart, '00:00')).toISOString())}&maxResults=250&showDeleted=false&singleEvents=false${pageToken ? `&pageToken=${enc(pageToken)}` : ''}`;
    const { json } = await gfetch(env, deps, `${calBase(env)}${q}`);
    for (const e of (json && json.items) || []) existing.set(e.id, e);
    pageToken = (json && json.nextPageToken) || '';
  } while (pageToken);

  const out = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  const maxOps = Math.max(1, Number(env.RECONCILE_MAX_OPS) || DEFAULT_RECONCILE_OPS);
  let ops = 0, partial = false;
  // 兩道上限：每輪最多 maxOps 筆寫入，且「實際剩餘的對外請求數」要夠做一筆（最壞 POST+PATCH）
  const budget = () => ((ops >= maxOps || budgetLeft(env, deps) < OP_COST) ? (partial = true, false) : (ops++, true));
  for (const [id, ev] of desired) {
    const cur = existing.get(id);
    if (!cur) { if (!budget()) continue; await calendarUpsert(env, deps, ev); out.created++; }
    else if (cur.extendedProperties?.private?.fp !== ev.fp) { if (!budget()) continue; await calendarUpsert(env, deps, ev); out.updated++; }
    else out.unchanged++;
  }
  for (const id of existing.keys()) {
    if (!desired.has(id)) { if (!budget()) continue; await calendarDelete(env, deps, id); out.deleted++; }
  }
  if (partial) out.partial = true; // 還有未處理的差異，下一輪對帳會繼續
  if (desired.size > 300) { out.warn = 'large_dataset'; logEvent(deps, { task: 'cpu_risk', desired: desired.size, note: '免費方案每次執行 CPU 約 10ms，未來預約超過約 300 筆時可能逾時；建議升級付費方案' }); }
  return out;
}

/* ───────────────────────── Job 處理 ───────────────────────── */

function backoffMs(attempt) { return (BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)] || 60) * 60e3; }

async function patchJob(env, deps, id, patch, guard = '') {
  return sb(env, deps, 'integration_jobs', { method: 'PATCH', query: `?id=eq.${enc(id)}${guard}`, body: patch, prefer: 'return=representation' });
}

async function stepAdminNotify(env, deps, job, r) {
  const m = featureMode(env, 'FEATURE_ADMIN_NOTIFY');
  if (m === 'off') return 'skipped:off';
  assertConfig(env, 'FEATURE_ADMIN_NOTIFY');
  if (deps.now() - Date.parse(job.created_at || 0) > STALE_JOB_MS) return 'skipped:stale';
  const text = adminMessage(job.type, r);
  if (m === 'dry') { logEvent(deps, { task: 'admin_notify', dry: true, to: 'ADMIN', text }); return 'dry'; }
  await linePush(env, deps, env.ADMIN_LINE_USER_ID, text, `admin:${job.dedupe_key || job.id}`);
  return 'sent';
}
async function stepCalendar(env, deps, job) {
  const m = featureMode(env, 'FEATURE_CALENDAR');
  if (m === 'off') return 'skipped:off';
  assertConfig(env, 'FEATURE_CALENDAR');
  if (m === 'dry') { logEvent(deps, { task: 'calendar', dry: true, reservation: job.reservation_id }); return 'dry'; }
  return calendarUpsertOrDelete(env, deps, job.reservation_id);
}
const calendarUpsertOrDelete = (env, deps, id) => syncReservationById(env, deps, id);

async function stepCustomerReminder(env, deps, job) {
  const m = featureMode(env, 'FEATURE_REMINDERS');
  if (m === 'off') return 'skipped:off';
  assertConfig(env, 'FEATURE_REMINDERS');
  const planned = normalizeReservation(job.payload?.reservation);
  if (!planned) return 'skipped:no_payload';
  const rows = await sb(env, deps, 'reservations', { query: `?id=eq.${enc(job.reservation_id)}&select=*` });
  const cur = normalizeReservation(rows && rows[0]);
  if (!cur || cur.status === 'CANCELLED') return 'skipped:cancelled';
  if (cur.date !== planned.date || cur.startTime !== planned.startTime) return 'skipped:rescheduled';
  if (deps.now() >= taipeiToUtcMs(cur.date, cur.startTime)) return 'skipped:started';
  const key = normalizePhoneKey(cur.phone);
  const bind = await sb(env, deps, 'app_state', { query: `?key=eq.${enc('line_bind:' + key)}&select=value` });
  const userId = bind && bind[0] && bind[0].value && bind[0].value.userId;
  if (!userId) return 'skipped:no_line_binding';
  const text = reminderMessage(cur);
  if (m === 'dry') { logEvent(deps, { task: 'reminder', dry: true, to: key, text }); return 'dry'; }
  await linePush(env, deps, userId, text, `reminder:${job.dedupe_key}`);
  return 'sent';
}

async function processOne(env, deps, job) {
  const attempts = Number(job.attempts || 0);
  const claimed = await patchJob(env, deps, job.id,
    { attempts: attempts + 1, run_after: new Date(deps.now() + LEASE_MS).toISOString() },
    `&status=eq.pending&attempts=eq.${attempts}`);
  if (!claimed || !claimed.length) return { id: job.id, result: 'claimed_elsewhere' };

  const payload = { ...(job.payload || {}) };
  const steps = { ...(payload.steps || {}) };
  const reservation = normalizeReservation(payload.reservation);
  try {
    let plan;
    if (job.type === 'reminder.customer') plan = [['customerReminder', () => stepCustomerReminder(env, deps, job)]];
    else if (/^reservation\.(created|updated|cancelled)$/.test(job.type)) {
      plan = [['adminNotify', () => stepAdminNotify(env, deps, job, reservation)], ['calendar', () => stepCalendar(env, deps, job)]];
    } else plan = [];
    for (const [name, run] of plan) {
      if (steps[name] && !String(steps[name]).startsWith('error')) continue; // 已完成的步驟不重做（避免重複通知）
      steps[name] = await run();
      await patchJob(env, deps, job.id, { payload: { ...payload, steps } });
    }
    await patchJob(env, deps, job.id, { status: 'done', payload: { ...payload, steps, lastError: undefined } });
    return { id: job.id, type: job.type, result: 'done', steps };
  } catch (error) {
    const n = attempts + 1;
    const final = n >= MAX_ATTEMPTS;
    try {
      await patchJob(env, deps, job.id, {
        status: final ? 'failed' : 'pending',
        run_after: new Date(deps.now() + backoffMs(n)).toISOString(),
        payload: { ...payload, steps, lastError: String(error.message || error).slice(0, 300) },
      });
    } catch (persistError) {
      // 連「記錄失敗」都失敗（例如資料庫整個不通）：不中斷本輪其他 job。
      // job 仍是 pending，租約（5 分鐘）到期後會被重新撿起；已送出的 LINE 以 X-Line-Retry-Key 去重，不會重複。
      logEvent(deps, { task: 'job_persist_failed', job: job.id, error: String(persistError.message || persistError) });
    }
    if (final) deps.state.failedJobs = (deps.state.failedJobs || 0) + 1;
    logEvent(deps, { task: 'job_error', job: job.id, type: job.type, attempt: n, final, error: String(error.message || error) });
    return { id: job.id, type: job.type, result: final ? 'failed' : 'retry', error: String(error.message || error) };
  }
}

export async function processJobs(env, deps) {
  const nowIso = new Date(deps.now()).toISOString();
  const jobs = await sb(env, deps, 'integration_jobs', {
    query: `?status=eq.pending&run_after=lte.${enc(nowIso)}&order=created_at.asc&limit=${Math.max(1, Number(env.JOB_BATCH) || DEFAULT_BATCH)}`,
  });
  const results = [];
  for (const job of jobs || []) {
    if (budgetLeft(env, deps) < JOB_COST) { logEvent(deps, { task: 'jobs_budget_stop', left: budgetLeft(env, deps) }); break; }   // 其餘留待下一輪（尚未領取，不消耗重試次數）
    results.push(await processOne(env, deps, job));
  }
  return results;
}

/** 掃描「需要提醒」的預約並建立 reminder job（以 dedupe_key 保證每筆預約每個時段只提醒一次）。 */
export async function scanReminders(env, deps) {
  if (featureMode(env, 'FEATURE_REMINDERS') === 'off') return { created: 0, skipped: 'off' };
  assertConfig(env, 'FEATURE_REMINDERS');
  const nowMs = deps.now();
  const today = taipeiDate(nowMs);
  const rows = await sb(env, deps, 'reservations', {
    query: `?date=in.(${today},${addDays(today, 1)})&status=neq.CANCELLED&select=*`,
  });
  let created = 0;
  for (const raw of rows || []) {
    const r = normalizeReservation(raw);
    if (budgetLeft(env, deps) < 3) break;   // 預算不足：剩下的下一輪再建立（dedupe_key 保證不會重複）
    const remindAt = taipeiToUtcMs(addDays(r.date, -1), '17:00');
    const startMs = taipeiToUtcMs(r.date, r.startTime);
    if (nowMs < remindAt || nowMs >= startMs) continue;           // 未到提醒時間 / 已開始
    if (Date.parse(r.createdAt) > remindAt) continue;             // 提醒時間之後才預約：不補發提醒
    const ins = await sb(env, deps, 'integration_jobs', {
      method: 'POST', query: '?on_conflict=dedupe_key', prefer: 'resolution=ignore-duplicates,return=representation',
      body: {
        id: crypto.randomUUID(), type: 'reminder.customer', reservation_id: r.id,
        payload: { reservation: r, remindAt: new Date(remindAt).toISOString() },
        status: 'pending', attempts: 0, run_after: new Date(nowMs).toISOString(),
        dedupe_key: `reminder:${r.id}:${r.date}:${r.startTime}`, created_at: new Date(nowMs).toISOString(),
      },
    });
    if (ins && ins.length) created++;
  }
  return { created };
}

/* ───────────────────────── LINE Webhook（綁定） ───────────────────────── */

async function verifyLineSignature(raw, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return safeEqual(expected, signature);
}
const BIND_MAX_BAD_ATTEMPTS = 5;           // 同一個 LINE 使用者 1 小時內最多可輸入錯誤綁定碼的次數
const BIND_ATTEMPT_WINDOW_MS = 3600e3;

async function getAttempts(env, deps, userId) {
  const rows = await sb(env, deps, 'app_state', { query: `?key=eq.${enc('line_attempts:' + userId)}&select=value` });
  const v = rows && rows[0] && rows[0].value;
  if (!v || deps.now() - Date.parse(v.windowStart) > BIND_ATTEMPT_WINDOW_MS) return { count: 0, windowStart: new Date(deps.now()).toISOString() };
  return v;
}
async function putAttempts(env, deps, userId, value) {
  await sb(env, deps, 'app_state', {
    method: 'POST', query: '?on_conflict=key', prefer: 'resolution=merge-duplicates,return=minimal',
    body: { key: `line_attempts:${userId}`, value, updated_at: new Date(deps.now()).toISOString() },
  });
}

async function handleBindCode(env, deps, ev, code) {
  const userId = ev.source.userId;
  const nowIso = new Date(deps.now()).toISOString();

  // 1. 猜碼限制：錯誤次數過多就直接擋下，連資料庫都不查
  const att = await getAttempts(env, deps, userId);
  if (att.count >= BIND_MAX_BAD_ATTEMPTS) {
    logEvent(deps, { task: 'line_bind_blocked' });
    return replyOrPush(env, deps, ev, '嘗試次數過多，為了安全請 1 小時後再試。');
  }

  // 2. 原子領取：一個 DELETE ... RETURNING 同時完成「檢查未過期」與「作廢」，
  //    即使同一個碼同時被多個請求處理，也只有一個能領到。
  const claimed = await sb(env, deps, 'line_bind_tokens', {
    method: 'DELETE', query: `?code=eq.${enc(code)}&expires_at=gte.${enc(nowIso)}`, prefer: 'return=representation',
  });
  const t = claimed && claimed[0];
  if (!t || !Number.isFinite(Date.parse(t.expires_at))) {
    // LINE 重送同一事件：若這個事件已經綁定成功過，回覆成功而不是「無效」
    if (ev.webhookEventId) {
      const done = await sb(env, deps, 'app_state', { query: `?key=like.${enc('line_bind:*')}&value->>eventId=eq.${enc(ev.webhookEventId)}&select=key` });
      if (done && done.length) return replyOrPush(env, deps, ev, '✅ 綁定成功！系統會在預約前一天下午 5:00 傳送提醒給您。');
    }
    await putAttempts(env, deps, userId, { count: att.count + 1, windowStart: att.windowStart });
    return replyOrPush(env, deps, ev, '綁定碼無效或已過期，請回到預約完成頁確認，或重新預約取得新的綁定碼。');
  }

  // 3. 寫入綁定（含事件 ID，供重送時辨識）。失敗就把綁定碼還回去，並丟出暫時性錯誤讓 LINE 重送。
  try {
    await sb(env, deps, 'app_state', {
      method: 'POST', query: '?on_conflict=key', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: `line_bind:${normalizePhoneKey(t.phone)}`, value: { userId, boundAt: nowIso, reservationId: t.reservation_id, eventId: ev.webhookEventId || null }, updated_at: nowIso },
    });
  } catch (error) {
    try { await sb(env, deps, 'line_bind_tokens', { method: 'POST', query: '?on_conflict=code', prefer: 'resolution=merge-duplicates,return=minimal', body: { code: t.code, reservation_id: t.reservation_id, phone: t.phone, expires_at: t.expires_at } }); }
    catch (restoreError) { logEvent(deps, { task: 'line_bind_token_restore_failed', error: String(restoreError.message || restoreError) }); }
    throw error;
  }
  try { await putAttempts(env, deps, userId, { count: 0, windowStart: nowIso }); } catch { /* 清除次數失敗不影響綁定 */ }
  logEvent(deps, { task: 'line_bind', phoneKey: normalizePhoneKey(t.phone).slice(-4).padStart(10, '*') });
  return replyOrPush(env, deps, ev, '✅ 綁定成功！系統會在預約前一天下午 5:00 傳送提醒給您。');
}

async function handleLineEvent(env, deps, ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId) return;
  if (ev.type === 'follow') {
    return lineReply(env, deps, ev.replyToken, '歡迎加入蘿妮的療癒空間 ✦\n預約完成後，請把預約成功頁面上的 6 碼綁定碼傳給我，就能收到預約提醒。');
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  const text = String(ev.message.text || '').trim().toUpperCase();
  if (text === 'ID') return lineReply(env, deps, ev.replyToken, `您的 LINE userId：\n${userId}`);
  if (!/^[0-9A-F]{6}$/.test(text)) return;
  return handleBindCode(env, deps, ev, text);
}

/**
 * 回應規則（LINE 以 HTTP 狀態判斷是否要重送；需在 LINE Developers 開啟「Webhook redelivery」）：
 *  - 簽章錯誤 → 401
 *  - 全部事件處理成功，或只有「永久性」錯誤（重送也沒用）→ 200
 *  - 任一事件發生「暫時性」錯誤（資料庫/網路/LINE 5xx、429）→ 500，讓 LINE 重送；
 *    同時盡力回覆使用者「系統忙碌，請稍後再傳一次」。處理流程已做成可重複執行，重送不會重複綁定。
 */
export async function handleLineWebhook(request, env, deps, ctx = { waitUntil() {} }) {
  const raw = await request.text();
  if (!(await verifyLineSignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET))) {
    return json({ error: 'invalid signature' }, 401);
  }
  if (featureMode(env, 'FEATURE_LINE_BINDING') !== 'on') return json({ ok: true, binding: 'off' });
  const miss = missingConfig(env, 'FEATURE_LINE_BINDING');
  if (miss.length) { logEvent(deps, { task: 'line_webhook_config_missing', missing: miss }); return json({ error: `缺少設定：${miss.join(', ')}` }, 500); }
  let body; try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  const work = (async () => {
    let transient = false;
    for (const ev of body.events || []) {
      try { await handleLineEvent(env, deps, ev); }
      catch (error) {
        logEvent(deps, { task: 'line_event_error', transient: Boolean(error.transient), error: String(error.message || error) });
        if (error.transient) {
          transient = true;
          await lineReply(env, deps, ev.replyToken, '系統暫時忙碌，請稍後再把綁定碼傳一次。');
        }
      }
    }
    return transient ? { status: 500, body: { error: 'temporary failure; please redeliver' } } : { status: 200, body: { ok: true } };
  })();

  // LINE 要求 2 秒內回應，否則記為 request_timeout（開啟重送時會重送，可能與仍在處理中的原請求競爭）。
  // 所以：在期限內完成 → 回真實結果（200 / 500 供 LINE 判斷是否重送）；來不及 → 先回 200，處理在背景繼續完成。
  const deadline = Math.max(50, Number(env.WEBHOOK_DEADLINE_MS) || 1500);
  let timer; const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), deadline); });
  const first = await Promise.race([work, timeout]); clearTimeout(timer);
  if (first) return json(first.body, first.status);
  logEvent(deps, { task: 'line_webhook_deferred', deadlineMs: deadline });
  ctx.waitUntil(work.catch(() => {}));
  return json({ ok: true, deferred: true });
}

/* ───────────────────────── 備份到 Google Drive ───────────────────────── */

/**
 * 回退用：刪除「本系統建立」的日曆事件（私有屬性 ronnie=1）。使用者自己的行程不受影響。
 * - 一次最多處理 limit 筆（預設 10、上限 25），且以「實際剩餘的對外請求數」為準，預算不足就停（stoppedBy='budget'）。
 * - 每批刪除後重新查詢一次，驗證這批事件確實已不存在（verified / stillPresent）；remaining 以重新查詢的結果為準。
 * - preview=true：只列出將被刪除的事件摘要，不刪除任何東西。
 * - 刪除前逐筆再驗證事件確實帶有 ronnie=1 標記。
 * 不受 FEATURE_CALENDAR 開關限制（回退時通常已先關掉開關），但需要密鑰與明確的確認字串。
 */
export async function purgeCalendar(env, deps, { preview = false, limit = 10 } = {}) {
  assertConfig(env, 'FEATURE_CALENDAR', true);
  const n = Math.min(25, Math.max(1, Number(limit) || 10));
  const listUrl = `${calBase(env)}?privateExtendedProperty=${enc('ronnie=1')}&maxResults=${n}&showDeleted=false&singleEvents=false`;
  const own = e => e.extendedProperties?.private?.ronnie === '1';
  const { json } = await gfetch(env, deps, listUrl);
  const all = ((json && json.items) || []).filter(own);
  const items = all.slice(0, n);                       // 硬性截斷：即使 API 回傳超過 maxResults，也絕不處理超過 limit 筆
  const more = Boolean(json && json.nextPageToken) || all.length > n;
  if (preview) {
    return { preview: true, wouldDelete: items.length, remaining: more, sample: items.slice(0, 5).map(e => ({ id: e.id, summary: e.summary, start: e.start })) };
  }
  let deleted = 0, stoppedBy = null;
  const deletedIds = [];
  for (const e of items) {
    if (budgetLeft(env, deps) < 3) { stoppedBy = 'budget'; break; }     // 保留 1 個給驗證，另有 1 個緩衝（例如授權更新）
    await calendarDelete(env, deps, e.id); deleted++; deletedIds.push(e.id);
  }
  let verified = null, stillPresent = [], remaining = more || items.length > deleted;
  if (deleted > 0 && budgetLeft(env, deps) >= 1) {
    const check = await gfetch(env, deps, listUrl);
    const left = ((check.json && check.json.items) || []).filter(own);
    stillPresent = left.map(e => e.id).filter(id => deletedIds.includes(id));
    verified = stillPresent.length === 0;
    remaining = left.length > 0 || Boolean(check.json && check.json.nextPageToken);
  }
  return { deleted, remaining, verified, stillPresent, ...(stoppedBy ? { stoppedBy } : {}) };
}

const BACKUP_FORMAT = 'RONNIE_HEALING_SPACE_BACKUP';
const DEFAULT_BUFFERED_MAX_BYTES = 1_000_000;     // 緩衝模式（需解碼/編碼，吃 CPU）：約 1MB。Cloudflare 免費方案每次執行 CPU 上限 10ms
const DEFAULT_STREAM_MAX_BYTES = 200_000_000;     // 串流模式不經 JS 處理，上限只是防呆

function parseCounts(h) {
  if (!h) return null;
  const o = {};
  for (const kv of String(h).split(';')) { const [k, v] = kv.split('='); if (k) o[k.trim()] = Number(v); }
  return ['reservations', 'customers', 'closures'].every(k => Number.isFinite(o[k]) && o[k] >= 0) ? o : null;
}
async function discard(res) { try { await res.body?.cancel(); } catch { /* 已結束 */ } }

/** 今天（台北日期）是否已有成功的備份檔；有就回傳檔名。用於 cron 重試時略過。 */
async function backupExistsToday(env, deps) {
  const day = taipeiStamp(deps.now()).slice(0, 8);
  const api = env.GOOGLE_DRIVE_API || 'https://www.googleapis.com/drive/v3';
  const q = `'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false and name contains '${BACKUP_PREFIX}${day}-'`;
  const { json } = await gfetch(env, deps, `${api}/files?q=${enc(q)}&pageSize=10&fields=${enc('files(id,name)')}&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const hit = ((json && json.files) || []).find(f => BACKUP_NAME_RE.test(f.name) && f.name.includes(`-${day}-`));
  return hit ? hit.name : null;
}

/**
 * 串流上傳（預設）：把 Render 回應的「位元組」直接接到 Drive 的可續傳上傳，Worker 不解碼、不解析、不重新編碼。
 * 這是免費方案（每次執行 CPU 10ms）下，唯一不受資料量影響的做法。需要 Content-Length（由 Render 匯出標頭提供）。
 */
async function driveUploadStream(env, deps, name, stream, len) {
  const api = env.GOOGLE_UPLOAD_API || 'https://www.googleapis.com/upload/drive/v3';
  const init = await gfetch(env, deps, `${api}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size`, {
    method: 'POST', body: { name, parents: [env.GOOGLE_DRIVE_FOLDER_ID], mimeType: 'application/json' },
    headers: { 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(len) },
  });
  const session = init.headers && init.headers.get('location');
  if (!session) throw new Error('Drive 未回傳上傳工作階段網址（Location）');
  const token = await googleToken(env, deps);
  const res = await tfetch(env, deps, session, {
    method: 'PUT', body: stream, duplex: 'half',      // duplex 為 Node 測試所需；Workers 會忽略
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(len), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(Math.max(1000, Number(env.BACKUP_UPLOAD_TIMEOUT_MS) || 120_000)),   // 大檔上傳需要比一般請求更久
  });
  const text = await res.text();
  if (!res.ok) throw transientError(`Google PUT upload ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  try { return JSON.parse(text); } catch { throw new Error('Drive 上傳回應不是 JSON'); }
}
/** 緩衝上傳（相容舊版 Render / 沒有 Content-Length / BACKUP_UPLOAD_MODE=buffered）：只適合小檔，有大小上限保護。 */
async function driveUploadMultipart(env, deps, name, text) {
  const boundary = `ronnie${deps.now().toString(36)}`;
  const metadata = { name, parents: [env.GOOGLE_DRIVE_FOLDER_ID], mimeType: 'application/json' };
  const rawBody = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  const up = await gfetch(env, deps,
    `${env.GOOGLE_UPLOAD_API || 'https://www.googleapis.com/upload/drive/v3'}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size`,
    { method: 'POST', rawBody, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
  return up.json || {};
}

export async function runBackup(env, deps, reason = 'manual') {
  const m = featureMode(env, 'FEATURE_BACKUP');
  if (m === 'off') return { ok: false, skipped: 'off' };
  assertConfig(env, 'FEATURE_BACKUP');

  // cron 重試：今天已經成功備份過就略過（手動備份一律執行）
  if (reason === 'cron' && m === 'on') {
    const existing = await backupExistsToday(env, deps);
    if (existing) { logEvent(deps, { task: 'backup', skipped: 'already_done_today', name: existing, reason }); return { ok: true, skipped: 'already_done_today', name: existing }; }
  }

  const res = await tfetch(env, deps, `${String(env.RENDER_BASE_URL).replace(/\/$/, '')}/api/integration/export`, {
    // 要求不壓縮：Render 前端代理會壓縮回應並移除 Content-Length，串流上傳需要確定的位元組數
    headers: { 'X-Integration-Secret': env.INTEGRATION_WORKER_SECRET, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(90_000) : undefined,
  });
  if (!res.ok) { await discard(res); throw new Error(`匯出失敗 ${res.status}`); }

  const name = `${BACKUP_PREFIX}${taipeiStamp(deps.now())}.json`;
  // 位元組數以 Render 自訂標頭 X-Export-Bytes 為準；沒有時才用 Content-Length（舊版 Render / 其他代理）
  const hdrNum = name => { const v = res.headers.get(name); return v === null || v === '' ? NaN : Number(v); };
  const len = Number.isFinite(hdrNum('x-export-bytes')) && hdrNum('x-export-bytes') > 0 ? hdrNum('x-export-bytes') : hdrNum('content-length');
  // 回應若被壓縮（Content-Encoding 非 identity），實際位元組數與 X-Export-Bytes 不一致 → 不可串流，改走緩衝（讀取解碼後的文字）
  const enc_ = String(res.headers.get('content-encoding') || '').toLowerCase();
  const identityBody = enc_ === '' || enc_ === 'identity';
  let counts = parseCounts(res.headers.get('x-export-counts'));
  const modeWanted = String(env.BACKUP_UPLOAD_MODE || 'stream').toLowerCase();
  const streamable = modeWanted !== 'buffered' && identityBody && res.headers.get('x-export-format') === BACKUP_FORMAT && Boolean(counts) && Number.isFinite(len) && len > 0;

  if (m === 'dry') {      // dry：只讀取回應標頭（唯讀），不讀內容、不上傳
    await discard(res);
    const path = streamable ? 'stream' : 'buffered';
    logEvent(deps, { task: 'backup', dry: true, name, counts, bytes: Number.isFinite(len) ? len : null, path, reason });
    return { ok: true, dry: true, name, counts, bytes: Number.isFinite(len) ? len : null, path };
  }

  let file, expectedBytes, path;
  if (streamable) {
    const max = Number(env.BACKUP_STREAM_MAX_BYTES) || DEFAULT_STREAM_MAX_BYTES;
    if (len > max) { await discard(res); throw new Error(`匯出檔 ${(len / 1048576).toFixed(1)} MB 超過串流上限 ${(max / 1048576).toFixed(0)} MB（BACKUP_STREAM_MAX_BYTES）`); }
    file = await driveUploadStream(env, deps, name, res.body, len);
    expectedBytes = len; path = 'stream';
  } else {
    const max = Number(env.BACKUP_MAX_BYTES) || DEFAULT_BUFFERED_MAX_BYTES;
    const tooBig = n => `匯出檔 ${(n / 1048576).toFixed(1)} MB 超過緩衝模式安全上限 ${(max / 1048576).toFixed(1)} MB（免費方案 CPU 10ms）。請更新 Render 的 server.js（提供串流所需標頭），或升級付費方案後調高 BACKUP_MAX_BYTES`;
    if (Number.isFinite(len) && len > max) { await discard(res); throw new Error(tooBig(len)); }
    const text = await res.text();
    if (text.length > max) throw new Error(tooBig(text.length));
    let payload; try { payload = JSON.parse(text); } catch { throw new Error('匯出資料不是有效的 JSON，已中止備份'); }
    const d = payload && payload.data;
    if (!payload || payload.backupFormat !== BACKUP_FORMAT || !d || !Array.isArray(d.reservations) || !Array.isArray(d.customers) || !Array.isArray(d.closures)) {
      throw new Error('匯出資料格式不正確，已中止備份');
    }
    counts = { reservations: d.reservations.length, customers: d.customers.length, closures: d.closures.length };
    file = await driveUploadMultipart(env, deps, name, text);
    expectedBytes = Number.isFinite(len) ? len : new TextEncoder().encode(text).length; path = 'buffered';
  }

  // 驗證上傳結果：Drive 回報的檔案大小必須等於送出的位元組數，否則視為損毀並移到垃圾桶
  if (file.size !== undefined && Number(file.size) !== expectedBytes) {
    if (file.id) { try { await gfetch(env, deps, `${env.GOOGLE_DRIVE_API || 'https://www.googleapis.com/drive/v3'}/files/${file.id}?supportsAllDrives=true`, { method: 'PATCH', body: { trashed: true } }); } catch { /* 盡力而為 */ } }
    throw new Error(`上傳大小不符（Drive ${file.size} bytes，預期 ${expectedBytes}），該檔已移到垃圾桶，本次備份視為失敗`);
  }

  let trashed = 0;
  const hasData = counts.reservations + counts.customers + counts.closures > 0;
  if (hasData && file.id) trashed = await applyRetention(env, deps, file.id);
  logEvent(deps, { task: 'backup', name, counts, bytes: expectedBytes, path, fileId: file.id, trashed, reason });
  return { ok: true, name, fileId: file.id, counts, bytes: expectedBytes, path, trashed };
}
/** 保留最新 N 份（預設 60）。只處理本系統命名規則的檔案，且是「移到垃圾桶」而非永久刪除，可還原。 */
async function applyRetention(env, deps, justUploadedId) {
  const keep = Math.max(7, Number(env.BACKUP_KEEP) || 60);
  const api = env.GOOGLE_DRIVE_API || 'https://www.googleapis.com/drive/v3';
  const q = `'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false and name contains '${BACKUP_PREFIX}'`;
  const { json } = await gfetch(env, deps,
    `${api}/files?q=${enc(q)}&orderBy=${enc('createdTime desc')}&pageSize=1000&fields=${enc('files(id,name,createdTime)')}&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const files = ((json && json.files) || []).filter(f => BACKUP_NAME_RE.test(f.name) && f.id !== justUploadedId);
  const surplus = files.slice(Math.max(0, keep - 1));
  for (const f of surplus) await gfetch(env, deps, `${api}/files/${f.id}?supportsAllDrives=true`, { method: 'PATCH', body: { trashed: true } });
  return surplus.length;
}

/* ───────────────────────── 管理者警示 ───────────────────────── */

const ALERT_INTERVAL_MS = 12 * 3600e3;
/**
 * 發生「會靜默持續」的故障時，主動用 LINE 通知管理者（同一類警示 12 小時內最多一則）。
 * 遵守 FEATURE_ADMIN_NOTIFY 開關（off 不發、dry 只記錄）；警示本身失敗絕不影響主流程。
 */
export async function alertAdmin(env, deps, key, text, minIntervalMs = ALERT_INTERVAL_MS) {
  const m = featureMode(env, 'FEATURE_ADMIN_NOTIFY');
  if (m === 'off') return 'off';
  if (missingConfig(env, 'FEATURE_ADMIN_NOTIFY').length) return 'no_config';
  if (budgetLeft(env, deps) < 4) return 'no_budget';
  try {
    const rows = await sb(env, deps, 'app_state', { query: `?key=eq.${enc('alert:' + key)}&select=value` });
    const last = rows && rows[0] && rows[0].value && Date.parse(rows[0].value.at);
    if (last && deps.now() - last < minIntervalMs) return 'throttled';
    if (m === 'dry') logEvent(deps, { task: 'alert', dry: true, key, text });
    else await linePush(env, deps, env.ADMIN_LINE_USER_ID, text);
    await sb(env, deps, 'app_state', {
      method: 'POST', query: '?on_conflict=key', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: `alert:${key}`, value: { at: new Date(deps.now()).toISOString() }, updated_at: new Date(deps.now()).toISOString() },
    });
    logEvent(deps, { task: 'alert_sent', key });
    return 'sent';
  } catch (error) {
    logEvent(deps, { task: 'alert_failed', key, error: String(error.message || error) });
    return 'error';
  }
}
/** 每次執行結束時呼叫：把本次累積的「需要人處理」事件通知管理者。 */
async function postRun(env, deps) {
  const st = deps.state;
  if (st.googleAuthFailed) {
    st.googleAuthFailed = false;
    await alertAdmin(env, deps, 'google_auth', '⚠️ Google 授權已失效（invalid_grant），日曆同步與自動備份已暫停。\n請依文件 §3.3 重新取得 refresh token，更新 GOOGLE_REFRESH_TOKEN 後重新部署。');
  }
  if (st.failedJobs) {
    const n = st.failedJobs; st.failedJobs = 0;
    await alertAdmin(env, deps, 'job_failed', `⚠️ 有 ${n} 筆整合任務重試 5 次仍失敗（LINE／日曆）。\n請查看 /status 的 failedJobs 與 Worker 日誌，排除後再重送。`);
  }
}

/* ───────────────────────── 日常排程 ───────────────────────── */

async function guarded(env, deps, task, fn) {
  try { const out = await fn(); await recordRun(env, deps, task, true, out); return { task, ok: true, out }; }
  catch (error) {
    const msg = String(error.message || error);
    logEvent(deps, { task, error: msg });
    await recordRun(env, deps, task, false, msg);
    return { task, ok: false, error: msg };
  }
}
export async function runTick(env, deps, { reconcile = false } = {}) {
  const out = [];
  out.push(await guarded(env, deps, 'jobs', () => processJobs(env, deps)));
  out.push(await guarded(env, deps, 'reminder_scan', async () => {
    const s = await scanReminders(env, deps);
    if (s.created) await processJobs(env, deps);
    return s;
  }));
  if (reconcile && featureMode(env, 'FEATURE_LINE_BINDING') === 'on') {
    // 清掉一天前的猜碼次數紀錄（避免 app_state 無限增長）
    out.push(await guarded(env, deps, 'state_cleanup', async () => {
      await sb(env, deps, 'app_state', { method: 'DELETE', query: `?key=like.${enc('line_attempts:*')}&updated_at=lte.${enc(new Date(deps.now() - 86400e3).toISOString())}` });
      return { ok: true };
    }));
  }
  if (reconcile && featureMode(env, 'FEATURE_CALENDAR') !== 'off') {
    out.push(await guarded(env, deps, 'calendar_reconcile', async () =>
      featureMode(env, 'FEATURE_CALENDAR') === 'dry' ? { dry: true } : reconcileCalendar(env, deps)));
  }
  await postRun(env, deps);
  return out;
}

/* ───────────────────────── HTTP / Cron 入口 ───────────────────────── */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
async function authorized(request, env) {
  const given = request.headers.get('x-worker-secret') || '';
  return Boolean(env.INTEGRATION_WORKER_SECRET) && safeEqual(given, env.INTEGRATION_WORKER_SECRET);
}

export async function handleRequest(request, env, ctx = { waitUntil() {} }, deps = makeDeps()) {
  deps = freshBudget(deps);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/health') return json({ ok: true });
  if (request.method === 'POST' && path === '/line/webhook') return handleLineWebhook(request, env, deps, ctx);

  if (!(await authorized(request, env))) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'POST' && path === '/wake') {
    ctx.waitUntil(runTick(env, deps, { reconcile: true }));
    return json({ ok: true, accepted: true }, 202);
  }
  if (request.method === 'POST' && path === '/backup-now') {
    try {
      const r = await runBackup(env, deps, 'manual');
      await recordRun(env, deps, 'backup', r.ok !== false, r);
      if (r.skipped) return json({ error: '備份功能尚未啟用（FEATURE_BACKUP=off）' }, 503);
      return json({ ok: true, ...r });
    } catch (error) {
      await recordRun(env, deps, 'backup', false, String(error.message || error));
      return json({ error: String(error.message || error) }, 502);
    }
  }
  if (request.method === 'POST' && path === '/sync-calendar') {
    const m = featureMode(env, 'FEATURE_CALENDAR');
    if (m === 'off') return json({ error: 'FEATURE_CALENDAR=off' }, 503);
    if (m === 'dry') return json({ ok: true, dry: true });
    try { return json({ ok: true, ...(await reconcileCalendar(env, deps)) }); }
    catch (error) { return json({ error: String(error.message || error) }, 502); }
  }
  if (request.method === 'POST' && path === '/calendar-purge') {
    let body = {}; try { body = await request.json(); } catch { /* */ }
    if (body.preview !== true && body.confirm !== 'DELETE-ALL-RONNIE-EVENTS') return json({ error: '需要 {"confirm":"DELETE-ALL-RONNIE-EVENTS"}（或 {"preview":true} 只預覽）' }, 400);
    try { return json({ ok: true, ...(await purgeCalendar(env, deps, { preview: body.preview === true, limit: body.limit })) }); }
    catch (error) { return json({ error: String(error.message || error) }, 502); }
  }
  if (request.method === 'GET' && path === '/status') {
    const features = Object.fromEntries(['FEATURE_ADMIN_NOTIFY', 'FEATURE_REMINDERS', 'FEATURE_CALENDAR', 'FEATURE_BACKUP', 'FEATURE_LINE_BINDING'].map(k => [k, featureMode(env, k)]));
    let pending = null, failed = null, lastRuns = null;
    try {
      pending = (await sb(env, deps, 'integration_jobs', { query: '?status=eq.pending&select=id&limit=1000' })).length;
      failed = (await sb(env, deps, 'integration_jobs', { query: '?status=eq.failed&select=id&limit=1000' })).length;
      lastRuns = await sb(env, deps, 'app_state', { query: `?key=like.${enc('worker_last_run:*')}&select=key,value` });
    } catch (error) { lastRuns = String(error.message || error); }
    const missing = Object.fromEntries(Object.keys(REQUIRED_CONFIG).map(k => [k, missingConfig(env, k)]).filter(([, v]) => v.length));
    return json({ ok: true, features, missingConfig: missing, pendingJobs: pending, failedJobs: failed, lastRuns });
  }
  return json({ error: 'Not found' }, 404);
}

export async function handleScheduled(event, env, ctx = { waitUntil() {} }, deps = makeDeps()) {
  deps = freshBudget(deps);
  const cron = event.cron || '';
  const at = new Date(event.scheduledTime || deps.now());
  if (CRONS.backups.includes(cron)) {
    // 每日 03:00（台北）備份；04:00 為重試（當天已成功則略過）。只有「最後一次嘗試」仍失敗才通知管理者，避免暫時性故障的雜訊。
    const r = await guarded(env, deps, 'backup', () => runBackup(env, deps, 'cron'));
    if (!r.ok && cron === CRONS.backups[CRONS.backups.length - 1]) {
      await alertAdmin(env, deps, 'backup_failed', `⚠️ 自動備份失敗（已重試仍未成功）：${String(r.error).slice(0, 200)}\n請檢查 Worker 日誌與 /status。`);
    }
    await postRun(env, deps);
    return r;
  }
  if (cron !== CRONS.tick) logEvent(deps, { task: 'unknown_cron', cron });   // 排程字串與程式不一致：留下紀錄，並安全地當作一般檢查執行
  // 每 5 分鐘：處理 job、提醒掃描；每 15 分鐘另外做日曆對帳
  return runTick(env, deps, { reconcile: at.getUTCMinutes() % 15 === 0 });
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  scheduled: (event, env, ctx) => ctx.waitUntil(handleScheduled(event, env, ctx)),
};
