import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import '../support/polyfill.mjs';
import http from 'node:http';
import { startMocks } from '../support/mock-services.mjs';
import { runPreflight, summarize } from '../../worker/preflight.mjs';
import * as W from '../../worker/index.js';
import fs from 'node:fs';

let m;
before(async () => { m = await startMocks(); });
after(async () => { await m.close(); });
beforeEach(() => m.reset());

const at = (date, time) => W.taipeiToUtcMs(date, time);
const mkDeps = (ms, extra = {}) => W.makeDeps({ now: () => ms.v ?? ms, ...extra });
const clock = ms => ({ cur: ms, get v() { return this.cur; }, set v(x) { this.cur = x; } });
const T = m_ => m_.S.tables;

function resRow(id, date, start = '10:00', over = {}) {
  const [h] = start.split(':').map(Number);
  const end = `${String(h + 1).padStart(2, '0')}:${start.split(':')[1]}`;
  return { id, booking_code: 'BK' + id, name: '王小明', birth_date: '1990-01-01', phone: '0912-345-678', line_id: '', note: '', service_id: 's', service_name: '脈輪調頻 60 分鐘',
    duration_minutes: 60, date, start_time: start, end_time: end, service_slots: [start], slots: [start], status: 'CONFIRMED',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', cancelled_at: null, ...over };
}
const camel = r => W.normalizeReservation(r);
function addJob(type, row, over = {}) {
  const j = { id: crypto.randomUUID(), type, reservation_id: row.id, payload: { reservation: camel(row), eventType: type }, status: 'pending', attempts: 0,
    run_after: '2026-10-20T00:00:00.000Z', dedupe_key: `${type}:${row.id}:${row.updated_at}`, created_at: new Date(NOW).toISOString(), ...over };
  T(m).integration_jobs.push(j); return j;
}
const NOW = at('2026-10-20', '12:00');
const ENV_ON = (extra = {}) => m.env({ FEATURE_ADMIN_NOTIFY: 'on', FEATURE_CALENDAR: 'on', FEATURE_REMINDERS: 'on', FEATURE_BACKUP: 'on', FEATURE_LINE_BINDING: 'on', ...extra });
const jobRow = id => T(m).integration_jobs.find(j => j.id === id);

/* ───────────── 0. 工具函式 ───────────── */
describe('時間與 ID 工具', () => {
  it('台北時間換算（UTC+8）與跨日', () => {
    assert.equal(new Date(at('2026-10-20', '17:00')).toISOString(), '2026-10-20T09:00:00.000Z');
    assert.equal(W.taipeiDate(Date.parse('2026-10-20T16:30:00Z')), '2026-10-21');
    assert.equal(W.addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(W.addDays('2026-03-01', -1), '2026-02-28');
  });
  it('日曆事件 ID：固定、合法字元（a-v0-9）、不同 id 不衝突', () => {
    const a = W.eventIdFor('reservation', crypto.randomUUID()); const id = crypto.randomUUID();
    assert.match(a, /^[a-v0-9]{5,1024}$/);
    assert.equal(W.eventIdFor('reservation', id), W.eventIdFor('reservation', id));
    assert.notEqual(W.eventIdFor('reservation', id), W.eventIdFor('closure', id));
  });
  it('featureMode 只接受 on/dry，其餘一律視為 off', () => {
    assert.equal(W.featureMode({ X: 'ON' }, 'X'), 'on'); assert.equal(W.featureMode({ X: 'dry' }, 'X'), 'dry');
    for (const v of [undefined, '', 'true', '1', 'enabled', 'off']) assert.equal(W.featureMode({ X: v }, 'X'), 'off');
  });
});

/* ───────────── A. 預設全關：與沒有 Worker 一樣安全 ───────────── */
describe('A. 開關預設關閉', () => {
  it('所有 FEATURE_* 未設定：不呼叫 LINE / Google，job 標為 done(skipped)', async () => {
    const r = resRow('r1', '2026-10-25'); addJob('reservation.created', r);
    const out = await W.processJobs(m.env(), mkDeps(NOW));
    assert.equal(out[0].result, 'done');
    assert.equal(m.S.line.pushes.length, 0); assert.equal(m.S.google.tokenCalls, 0);
    assert.deepEqual(Object.values(T(m).integration_jobs[0].payload.steps), ['skipped:off', 'skipped:off']);
  });
  it('提醒掃描 off：不建立任何 job', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21'));
    assert.deepEqual(await W.scanReminders(m.env(), mkDeps(at('2026-10-20', '17:30'))), { created: 0, skipped: 'off' });
    assert.equal(T(m).integration_jobs.length, 0);
  });
  it('HTTP：無密鑰 401；/backup-now 在 FEATURE_BACKUP=off 回 503', async () => {
    const req = (path, headers = {}, method = 'POST') => new Request('http://w' + path, { method, headers });
    assert.equal((await W.handleRequest(req('/wake'), m.env(), undefined, mkDeps(NOW))).status, 401);
    assert.equal((await W.handleRequest(req('/backup-now', { 'x-worker-secret': 'wrong' }), m.env(), undefined, mkDeps(NOW))).status, 401);
    assert.equal((await W.handleRequest(req('/backup-now', { 'x-worker-secret': 'shared-secret' }), m.env(), undefined, mkDeps(NOW))).status, 503);
    assert.equal((await W.handleRequest(req('/health', {}, 'GET'), m.env(), undefined, mkDeps(NOW))).status, 200);
  });
});

/* ───────────── B. 管理者 LINE 通知 ───────────── */
describe('B. 新增/修改/取消 → LINE 通知管理者', () => {
  it('三種事件各送一則，內容正確，job 完成且不重送', async () => {
    const r = resRow('r1', '2026-10-25', '14:00', { note: '第一次來', line_id: 'ronnie_line' });
    for (const t of ['reservation.created', 'reservation.updated', 'reservation.cancelled']) addJob(t, r, { dedupe_key: t + 'x' });
    const env = ENV_ON({ FEATURE_CALENDAR: 'off' });
    await W.processJobs(env, mkDeps(NOW));
    assert.equal(m.S.line.pushes.length, 3);
    assert.ok(m.S.line.pushes.every(p => p.to === 'U_ADMIN'));
    assert.match(m.S.line.pushes[0].text, /新預約/); assert.match(m.S.line.pushes[1].text, /預約已修改/); assert.match(m.S.line.pushes[2].text, /預約已取消/);
    const t = m.S.line.pushes[0].text;
    for (const s of ['王小明', '0912-345-678', '脈輪調頻 60 分鐘', '2026-10-25（週日）14:00–15:00', '第一次來', 'ronnie_line']) assert.ok(t.includes(s), s);
    await W.processJobs(env, mkDeps(NOW));
    assert.equal(m.S.line.pushes.length, 3, '第二次處理不應重送');
    assert.ok(T(m).integration_jobs.every(j => j.status === 'done'));
  });
  it('LINE 暫時失敗 → 保留 pending、退避重試、成功後只送一次', async () => {
    const j = addJob('reservation.created', resRow('r1', '2026-10-25'));
    const env = ENV_ON({ FEATURE_CALENDAR: 'off' }); m.S.line.failNext = 1;
    const c = clock(NOW);
    const out1 = await W.processJobs(env, mkDeps(c));
    assert.equal(out1[0].result, 'retry');
    assert.equal(jobRow(j.id).status, 'pending'); assert.equal(jobRow(j.id).attempts, 1);
    assert.ok(Date.parse(jobRow(j.id).run_after) > NOW, '應退避到未來');
    assert.match(jobRow(j.id).payload.lastError, /LINE_PUSH 500/);
    assert.equal((await W.processJobs(env, mkDeps(c))).length, 0, '退避期間不應被撿起');
    c.v = NOW + 2 * 60e3;
    const out2 = await W.processJobs(env, mkDeps(c));
    assert.equal(out2[0].result, 'done'); assert.equal(m.S.line.pushes.length, 1);
  });
  it('已完成的步驟不重做：LINE 成功但日曆失敗 → 重試不會再發一次 LINE', async () => {
    const j = addJob('reservation.created', resRow('r1', '2026-10-25')); T(m).reservations.push(resRow('r1', '2026-10-25'));
    const env = ENV_ON(); m.S.google.failNext.calendar = 1; const c = clock(NOW);
    const out1 = await W.processJobs(env, mkDeps(c));
    assert.equal(out1[0].result, 'retry'); assert.equal(m.S.line.pushes.length, 1); assert.equal(jobRow(j.id).payload.steps.adminNotify, 'sent');
    c.v = NOW + 2 * 60e3; await W.processJobs(env, mkDeps(c));
    assert.equal(m.S.line.attempts, 1, '已完成的 LINE 步驟連「請求」都不該再發起（不依賴 LINE 的 retry key）');
    assert.equal(m.S.line.pushes.length, 1, 'LINE 不可重複'); assert.equal(m.S.google.events.size, 1); assert.equal(jobRow(j.id).status, 'done');
  });
  it('連續失敗 5 次 → failed（只使用 pending/done/failed，符合資料表限制）', async () => {
    const j = addJob('reservation.created', resRow('r1', '2026-10-25'));
    const env = ENV_ON({ FEATURE_CALENDAR: 'off' }); m.S.line.failNext = 99; const c = clock(NOW);
    for (let i = 0; i < 5; i++) { await W.processJobs(env, mkDeps(c)); c.v = Date.parse(jobRow(j.id).run_after) + 1000; } // 依實際退避時間推進（總計 < 6 小時，不觸發過期）
    assert.equal(jobRow(j.id).status, 'failed'); assert.equal(jobRow(j.id).attempts, 5);
    c.v += 99 * 3600e3; assert.equal((await W.processJobs(env, mkDeps(c))).length, 0, 'failed 不再處理');
  });
  it('兩個 Worker 同時處理同一 job：只會送出一則（租約/比較後更新）', async () => {
    addJob('reservation.created', resRow('r1', '2026-10-25'));
    const env = ENV_ON({ FEATURE_CALENDAR: 'off' });
    await Promise.all([W.processJobs(env, mkDeps(NOW)), W.processJobs(env, mkDeps(NOW)), W.processJobs(env, mkDeps(NOW))]);
    assert.equal(m.S.line.pushes.length, 1);
  });
  it('逾時（>6 小時）的舊 job 不補發 LINE（避免開啟功能時湧入過期通知）', async () => {
    addJob('reservation.created', resRow('r1', '2026-10-25'), { created_at: new Date(NOW - 7 * 3600e3).toISOString() });
    await W.processJobs(ENV_ON({ FEATURE_CALENDAR: 'off' }), mkDeps(NOW));
    assert.equal(m.S.line.pushes.length, 0); assert.equal(T(m).integration_jobs[0].payload.steps.adminNotify, 'skipped:stale');
  });
  it('dry 模式：不呼叫 LINE，只寫紀錄', async () => {
    addJob('reservation.created', resRow('r1', '2026-10-25'));
    const d = mkDeps(NOW); await W.processJobs(ENV_ON({ FEATURE_ADMIN_NOTIFY: 'dry', FEATURE_CALENDAR: 'off' }), d);
    assert.equal(m.S.line.pushes.length, 0); assert.ok(d.log.some(l => l.task === 'admin_notify' && l.dry && /新預約/.test(l.text)));
  });
  it('未設定 ADMIN_LINE_USER_ID：明確報錯（job 進入重試並記錄原因），不靜默略過、不發任何訊息', async () => {
    const j = addJob('reservation.created', resRow('r1', '2026-10-25'));
    const out = await W.processJobs(ENV_ON({ ADMIN_LINE_USER_ID: '', FEATURE_CALENDAR: 'off' }), mkDeps(NOW));
    assert.equal(out[0].result, 'retry'); assert.match(jobRow(j.id).payload.lastError, /缺少設定：ADMIN_LINE_USER_ID/);
    assert.equal(m.S.line.pushes.length, 0);
  });
});

/* ───────────── C. 客人提醒：前一天 17:00（台北） ───────────── */
describe('C. 預約前一天 17:00 提醒客人', () => {
  const bind = (phone = '0912-345-678', userId = 'U_CUSTOMER') => T(m).app_state.push({ key: 'line_bind:' + W.normalizePhoneKey(phone), value: { userId }, updated_at: 'x' });
  async function tick(ms, env = ENV_ON()) { return W.runTick(env, mkDeps(ms)); }

  it('16:59:59 不送；17:00:00 起送出；之後重複掃描不重送', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00')); bind();
    await tick(at('2026-10-20', '16:59') + 59_000); assert.equal(m.S.line.pushes.length, 0);
    await tick(at('2026-10-20', '17:00')); assert.equal(m.S.line.pushes.length, 1);
    const p = m.S.line.pushes[0];
    assert.equal(p.to, 'U_CUSTOMER'); assert.match(p.text, /明天 2026-10-21（週三）10:00–11:00/); assert.match(p.text, /王小明 您好/);
    for (const t of ['17:05', '18:00', '23:55']) await tick(at('2026-10-20', t));
    assert.equal(m.S.line.pushes.length, 1);
    assert.equal(T(m).integration_jobs.filter(j => j.type === 'reminder.customer').length, 1);
  });
  it('以 UTC 時間驗證：09:00:00Z = 17:00 台北', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21')); bind();
    await tick(Date.parse('2026-10-20T08:59:59Z')); assert.equal(m.S.line.pushes.length, 0);
    await tick(Date.parse('2026-10-20T09:00:00Z')); assert.equal(m.S.line.pushes.length, 1);
  });
  it('已取消預約不提醒；取消發生在掃描與送出之間也不送', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00', { status: 'CANCELLED' })); bind();
    await tick(at('2026-10-20', '17:10')); assert.equal(m.S.line.pushes.length, 0);
    m.reset(); T(m).reservations.push(resRow('r2', '2026-10-21')); bind();
    const env = ENV_ON(); await W.scanReminders(env, mkDeps(at('2026-10-20', '17:00')));
    T(m).reservations[0].status = 'CANCELLED';
    await W.processJobs(env, mkDeps(at('2026-10-20', '17:01')));
    assert.equal(m.S.line.pushes.length, 0); assert.equal(T(m).integration_jobs[0].payload.steps.customerReminder, 'skipped:cancelled');
  });
  it('提醒時間之後才建立的預約：不補發', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00', { created_at: new Date(at('2026-10-20', '18:30')).toISOString() })); bind();
    await tick(at('2026-10-20', '19:00')); assert.equal(m.S.line.pushes.length, 0);
  });
  it('改期：舊時段已提醒不影響；新時段會依新時間提醒；送出前被改期則略過舊提醒', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00')); bind();
    const env = ENV_ON(); await W.scanReminders(env, mkDeps(at('2026-10-20', '17:00')));
    Object.assign(T(m).reservations[0], { date: '2026-10-22', start_time: '11:00', end_time: '12:00' });
    await W.processJobs(env, mkDeps(at('2026-10-20', '17:01')));
    assert.equal(m.S.line.pushes.length, 0); assert.equal(T(m).integration_jobs[0].payload.steps.customerReminder, 'skipped:rescheduled');
    await tick(at('2026-10-21', '17:00')); assert.equal(m.S.line.pushes.length, 1); assert.match(m.S.line.pushes[0].text, /2026-10-22/);
  });
  it('Worker 當機補送：預約當天早上仍補發；開始後不補發', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00')); bind();
    await tick(at('2026-10-21', '08:00')); assert.equal(m.S.line.pushes.length, 1);
    m.reset(); T(m).reservations.push(resRow('r2', '2026-10-21', '10:00')); bind();
    await tick(at('2026-10-21', '10:00')); assert.equal(m.S.line.pushes.length, 0);
  });
  it('尚未綁定 LINE 的客人：略過並記錄原因，不報錯、不重試', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21'));
    await tick(at('2026-10-20', '17:00'));
    const j = T(m).integration_jobs[0]; assert.equal(j.status, 'done'); assert.equal(j.payload.steps.customerReminder, 'skipped:no_line_binding');
  });
  it('電話格式不同（0912-345-678 / 0912345678）視為同一人', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00', { phone: '0912345678' })); bind('0912-345-678');
    await tick(at('2026-10-20', '17:00')); assert.equal(m.S.line.pushes.length, 1);
  });
  it('dry 模式不送出；同一天多筆各自提醒', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21', '10:00'), resRow('r2', '2026-10-21', '14:00', { phone: '0922-000-111' })); bind(); bind('0922-000-111', 'U_B');
    await tick(at('2026-10-20', '17:00'), ENV_ON({ FEATURE_REMINDERS: 'dry' })); assert.equal(m.S.line.pushes.length, 0);
    m.reset(); T(m).reservations.push(resRow('r1', '2026-10-21', '10:00'), resRow('r2', '2026-10-21', '14:00', { phone: '0922-000-111' })); bind(); bind('0922-000-111', 'U_B');
    await tick(at('2026-10-20', '17:00')); assert.deepEqual(m.S.line.pushes.map(p => p.to).sort(), ['U_B', 'U_CUSTOMER']);
  });
});

/* ───────────── D. LINE Webhook 綁定 ───────────── */
describe('D. LINE 綁定碼', () => {
  const sign = body => crypto.createHmac('sha256', 'line-channel-secret').update(body).digest('base64');
  const hook = async (events, { sig, env = ENV_ON() } = {}) => {
    const body = JSON.stringify({ events });
    return W.handleLineWebhook(new Request('http://w/line/webhook', { method: 'POST', headers: { 'x-line-signature': sig ?? sign(body) }, body }), env, mkDeps(NOW));
  };
  const msg = (text, userId = 'U_CUSTOMER') => ({ type: 'message', replyToken: 'rt-' + text, source: { userId }, message: { type: 'text', text } });
  const binds = () => T(m).app_state.filter(x => x.key.startsWith('line_bind:'));
  const token = (code = 'A1B2C3', over = {}) => T(m).line_bind_tokens.push({ code, reservation_id: 'r1', phone: '0912-345-678', expires_at: new Date(NOW + 3600e3).toISOString(), ...over });

  it('簽章錯誤 / 缺少簽章 → 401，且不處理任何事件', async () => {
    token(); assert.equal((await hook([msg('A1B2C3')], { sig: 'bogus' })).status, 401);
    const body = JSON.stringify({ events: [msg('A1B2C3')] });
    assert.equal((await W.handleLineWebhook(new Request('http://w', { method: 'POST', body }), ENV_ON(), mkDeps(NOW))).status, 401);
    assert.equal(T(m).app_state.length, 0); assert.equal(T(m).line_bind_tokens.length, 1);
  });
  it('正確綁定碼 → 寫入綁定、綁定碼作廢、回覆成功；同碼不可重複使用', async () => {
    token(); assert.equal((await hook([msg('a1b2c3')])).status, 200);
    const b = T(m).app_state.find(x => x.key === 'line_bind:0912345678'); assert.equal(b.value.userId, 'U_CUSTOMER');
    assert.equal(T(m).line_bind_tokens.length, 0); assert.match(m.S.line.replies[0].text, /綁定成功/);
    await hook([msg('A1B2C3', 'U_ATTACKER')]);
    assert.equal(T(m).app_state.find(x => x.key === 'line_bind:0912345678').value.userId, 'U_CUSTOMER', '被盜用的舊碼不得覆蓋');
    assert.match(m.S.line.replies[1].text, /無效或已過期/);
  });
  it('過期、不存在的綁定碼 → 回覆無效；一般聊天不回覆；ID 指令回 userId；follow 回歡迎詞', async () => {
    token('DEAD00', { expires_at: new Date(NOW - 1000).toISOString() });
    await hook([msg('DEAD00'), msg('FFFFFF'), msg('你好')]);
    assert.equal(binds().length, 0); assert.equal(m.S.line.replies.length, 2);
    await hook([msg('id', 'U_XYZ'), { type: 'follow', replyToken: 'rt-f', source: { userId: 'U_NEW' } }]);
    assert.match(m.S.line.replies[2].text, /U_XYZ/); assert.match(m.S.line.replies[3].text, /綁定碼/);
  });
  it('FEATURE_LINE_BINDING=off：簽章通過也只回 200，不做任何事', async () => {
    token(); assert.equal((await hook([msg('A1B2C3')], { env: ENV_ON({ FEATURE_LINE_BINDING: 'off' }) })).status, 200);
    assert.equal(T(m).app_state.length, 0); assert.equal(m.S.line.replies.length, 0);
  });
  it('綁定後 → 收到前一天 17:00 提醒（綁定到提醒的完整流程）', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21')); token(); await hook([msg('A1B2C3', 'U_REAL')]);
    await W.runTick(ENV_ON(), mkDeps(at('2026-10-20', '17:00')));
    assert.deepEqual(m.S.line.pushes.map(p => p.to), ['U_REAL']);
  });
});

/* ───────────── E. Google 日曆 ───────────── */
describe('E. Google 日曆同步（預約與公休）', () => {
  const ev = () => [...m.S.google.events.values()];
  it('新增預約 → 建立事件（時間為 +08:00、固定 ID、帶私有標記）', async () => {
    const r = resRow('r1', '2026-10-25', '14:00'); T(m).reservations.push(r); addJob('reservation.created', r);
    await W.processJobs(ENV_ON({ FEATURE_ADMIN_NOTIFY: 'off' }), mkDeps(NOW));
    assert.equal(ev().length, 1); const e = ev()[0];
    assert.equal(e.id, W.eventIdFor('reservation', 'r1')); assert.equal(e.summary, '王小明｜脈輪調頻 60 分鐘');
    assert.equal(e.start.dateTime, '2026-10-25T14:00:00+08:00'); assert.equal(e.end.dateTime, '2026-10-25T15:00:00+08:00');
    assert.equal(e.extendedProperties.private.ronnie, '1'); assert.match(e.description, /0912-345-678/);
  });
  it('修改 → 同一事件更新（不會產生第二筆）；取消 → 事件刪除；恢復 → 事件復原', async () => {
    const env = ENV_ON({ FEATURE_ADMIN_NOTIFY: 'off' }); const row = resRow('r1', '2026-10-25', '14:00'); T(m).reservations.push(row);
    addJob('reservation.created', row); await W.processJobs(env, mkDeps(NOW));
    Object.assign(row, { start_time: '16:00', end_time: '17:00', updated_at: '2026-10-20T01:00:00.000Z' }); addJob('reservation.updated', row);
    await W.processJobs(env, mkDeps(NOW)); assert.equal(ev().length, 1); assert.equal(ev()[0].start.dateTime, '2026-10-25T16:00:00+08:00');
    row.status = 'CANCELLED'; addJob('reservation.cancelled', row, { dedupe_key: 'c1' }); await W.processJobs(env, mkDeps(NOW)); assert.equal(ev().length, 0);
    row.status = 'CONFIRMED'; addJob('reservation.updated', row, { dedupe_key: 'u2' }); await W.processJobs(env, mkDeps(NOW));
    assert.equal(ev().length, 1, '被刪除的事件 ID 仍可復原'); assert.equal(ev()[0].status, 'confirmed');
  });
  it('以資料庫目前狀態為準：舊 job 重試不會把已取消的預約又建回日曆', async () => {
    const row = resRow('r1', '2026-10-25', '14:00', { status: 'CANCELLED' }); T(m).reservations.push(row);
    addJob('reservation.created', row); await W.processJobs(ENV_ON({ FEATURE_ADMIN_NOTIFY: 'off' }), mkDeps(NOW)); assert.equal(ev().length, 0);
  });
  it('全量對帳：補遺漏、修差異、刪孤兒；不碰非本系統事件；第二次執行為 no-op', async () => {
    const env = ENV_ON(); const a = resRow('a', '2026-10-25', '10:00'), b = resRow('b', '2026-10-26', '10:00'), c = resRow('c', '2026-10-27', '10:00', { status: 'CANCELLED' });
    T(m).reservations.push(a, b, c);
    T(m).closures.push({ id: 'cl1', date: '2026-10-28', start_time: null, end_time: null, created_at: 'x' }, { id: 'cl2', date: '2026-10-29', start_time: '13:00', end_time: '15:00', created_at: 'x' });
    let out = await W.reconcileCalendar(env, mkDeps(NOW)); assert.deepEqual(out, { created: 4, updated: 0, deleted: 0, unchanged: 0 });
    const closureAll = m.S.google.events.get(W.eventIdFor('closure', 'cl1')), closurePart = m.S.google.events.get(W.eventIdFor('closure', 'cl2'));
    assert.deepEqual(closureAll.start, { date: '2026-10-28' }); assert.deepEqual(closureAll.end, { date: '2026-10-29' }); assert.equal(closureAll.summary, '公休');
    assert.equal(closurePart.start.dateTime, '2026-10-29T13:00:00+08:00');
    m.S.google.events.set('mine', { id: 'mine', summary: '我自己的行程', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } });
    m.S.google.events.get(W.eventIdFor('reservation', 'a')).extendedProperties.private.fp = 'drifted';
    m.S.google.events.set('ronnierff', { id: 'ronnierff', summary: '孤兒', extendedProperties: { private: { ronnie: '1', fp: 'x' } } });
    out = await W.reconcileCalendar(env, mkDeps(NOW)); assert.deepEqual(out, { created: 0, updated: 1, deleted: 1, unchanged: 3 });
    assert.ok(m.S.google.events.has('mine'), '使用者自己的事件必須原封不動');
    out = await W.reconcileCalendar(env, mkDeps(NOW)); assert.deepEqual(out, { created: 0, updated: 0, deleted: 0, unchanged: 4 });
  });
  it('對帳：公休被刪除 → 日曆事件移除；分頁清單完整處理', async () => {
    const env = ENV_ON(); m.S.google.pageSize = 2;
    for (let i = 0; i < 5; i++) T(m).reservations.push(resRow('p' + i, '2026-10-2' + (i + 1), '10:00'));
    await W.reconcileCalendar(env, mkDeps(NOW)); assert.equal(ev().length, 5);
    const out = await W.reconcileCalendar(env, mkDeps(NOW)); assert.equal(out.unchanged, 5);
    T(m).reservations.length = 0; const out2 = await W.reconcileCalendar(env, mkDeps(NOW)); assert.equal(out2.deleted, 5); assert.equal(ev().length, 0);
  });
  it('資料量大時分次完成：每輪最多 25 筆寫入（配合免費方案 50 個對外請求限制），多輪後完整且不重複', async () => {
    for (let i = 0; i < 60; i++) T(m).reservations.push(resRow('b' + i, W.addDays('2026-10-21', i % 20), String(9 + (i % 10)).padStart(2, '0') + ':00'));
    const env = ENV_ON(); const o1 = await W.reconcileCalendar(env, mkDeps(NOW));
    assert.equal(o1.created, 25); assert.equal(o1.partial, true); assert.equal(ev().length, 25);
    await W.reconcileCalendar(env, mkDeps(NOW)); const o3 = await W.reconcileCalendar(env, mkDeps(NOW));
    assert.equal(ev().length, 60); assert.equal(o3.created, 10);
    const o4 = await W.reconcileCalendar(env, mkDeps(NOW)); assert.deepEqual(o4, { created: 0, updated: 0, deleted: 0, unchanged: 60 });
  });
  it('每輪 job 數有上限（預設 4），其餘留待下一輪', async () => {
    for (let i = 0; i < 10; i++) addJob('reservation.created', resRow('j' + i, '2026-10-25'), { dedupe_key: 'k' + i });
    const out = await W.processJobs(ENV_ON({ FEATURE_CALENDAR: 'off' }), mkDeps(NOW)); assert.equal(out.length, 4);
    assert.equal(T(m).integration_jobs.filter(j => j.status === 'pending').length, 6);
  });
  it('只對帳「7 天前之後」的資料：很久以前的預約不會被建立', async () => {
    T(m).reservations.push(resRow('old', '2026-01-05'), resRow('now', '2026-10-21'));
    await W.reconcileCalendar(ENV_ON(), mkDeps(NOW)); assert.equal(ev().length, 1);
  });
  it('存取權杖過期（401）→ 自動換新並重試成功', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-25')); m.S.google.expireTokenOnce = true;
    await W.reconcileCalendar(ENV_ON(), mkDeps(NOW)); assert.equal(ev().length, 1); assert.ok(m.S.google.tokenCalls >= 2);
  });
  it('回退用 /calendar-purge：只刪本系統事件、需密鑰與確認字串、不受開關限制', async () => {
    T(m).reservations.push(resRow('a', '2026-10-25'), resRow('b', '2026-10-26')); await W.reconcileCalendar(ENV_ON(), mkDeps(NOW));
    m.S.google.events.set('mine', { id: 'mine', summary: '我自己的行程' });
    const call = (headers, body, env = m.env({ FEATURE_CALENDAR: 'off' })) => W.handleRequest(new Request('http://w/calendar-purge', { method: 'POST', headers, body: JSON.stringify(body) }), env, undefined, mkDeps(NOW));
    assert.equal((await call({}, { confirm: 'DELETE-ALL-RONNIE-EVENTS' })).status, 401);
    assert.equal((await call({ 'x-worker-secret': 'shared-secret' }, {})).status, 400); assert.equal(m.S.google.events.size, 3);
    const res = await call({ 'x-worker-secret': 'shared-secret' }, { confirm: 'DELETE-ALL-RONNIE-EVENTS' }); // FEATURE_CALENDAR 預設 off 也能執行
    assert.equal(res.status, 200); const rj = await res.json(); assert.equal(rj.deleted, 2); assert.equal(rj.remaining, false);
    assert.deepEqual([...m.S.google.events.keys()], ['mine']);
  });
  it('dry 模式不呼叫 Google；off 時 /sync-calendar 回 503', async () => {
    const r = resRow('r1', '2026-10-25'); T(m).reservations.push(r); addJob('reservation.created', r);
    const d = mkDeps(NOW); await W.processJobs(ENV_ON({ FEATURE_CALENDAR: 'dry', FEATURE_ADMIN_NOTIFY: 'off' }), d);
    assert.equal(m.S.google.tokenCalls, 0); assert.ok(d.log.some(l => l.task === 'calendar' && l.dry));
    const res = await W.handleRequest(new Request('http://w/sync-calendar', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' } }), m.env(), undefined, mkDeps(NOW));
    assert.equal(res.status, 503);
  });
});

/* ───────────── F. Google Drive 備份 ───────────── */
describe('F. 定時備份到 Google Drive', () => {
  const exportOf = (n = 3) => ({ backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', backupVersion: 'V2', exportedAt: 'x', data: { reservations: Array.from({ length: n }, (_, i) => ({ id: 'r' + i })), customers: [{ id: 'c' }], closures: [] } });
  const stamp = ms => W.taipeiStamp(ms);
  it('上傳到指定資料夾；檔名為台北時間；內容與匯出完全相同（可直接用「匯入後台資料」還原）', async () => {
    m.S.render.exportPayload = exportOf();
    const r = await W.runBackup(ENV_ON(), mkDeps(Date.parse('2026-10-20T19:00:00Z')), 'cron');
    assert.equal(r.ok, true); assert.equal(r.name, 'Ronnie-Witchery-Corner-backup-v2-20261021-0300.json');
    const f = m.S.google.files[0]; assert.deepEqual(f.parents, ['FOLDER1']); assert.deepEqual(f.content, m.S.render.exportPayload);
  });
  it('保留最新 60 份：多的「移到垃圾桶」（非永久刪除）；只動符合命名規則的檔案；剛上傳的不會被刪', async () => {
    m.S.render.exportPayload = exportOf();
    for (let i = 0; i < 65; i++) m.S.google.files.push({ id: 'old' + i, name: `Ronnie-Witchery-Corner-backup-v2-2026080${i % 9 + 1}-${String(i).padStart(4, '0')}.json`, parents: ['FOLDER1'], trashed: false, createdTime: new Date(Date.UTC(2026, 7, 1) + i * 60e3).toISOString(), content: {} });
    m.S.google.files.push({ id: 'lookalike', name: 'Ronnie-Witchery-Corner-backup-v2-NOTES-my-manual-copy.json', parents: ['FOLDER1'], trashed: false, createdTime: '2019-01-01T00:00:00Z' });
    m.S.google.files.push({ id: 'foreign', name: '我的重要文件.docx', parents: ['FOLDER1'], trashed: false, createdTime: '2020-01-01T00:00:00Z' });
    m.S.google.files.push({ id: 'otherfolder', name: 'Ronnie-Witchery-Corner-backup-v2-20200101-0000.json', parents: ['OTHER'], trashed: false, createdTime: '2020-01-01T00:00:00Z' });
    m.S.google.seq = 1000;
    const r = await W.runBackup(ENV_ON({ BACKUP_KEEP: '60' }), mkDeps(NOW), 'cron');
    const alive = m.S.google.files.filter(f => !f.trashed && f.parents[0] === 'FOLDER1' && /^Ronnie-Witchery-Corner-backup-v2-\d{8}-\d{4}\.json$/.test(f.name));
    assert.equal(alive.length, 60); assert.equal(r.trashed, 6);
    assert.ok(alive.some(f => f.id === r.fileId)); assert.equal(m.S.google.files.find(f => f.id === 'foreign').trashed, false); assert.equal(m.S.google.files.find(f => f.id === 'lookalike').trashed, false, '名稱相似但非本系統格式的檔案不可動'); assert.equal(m.S.google.files.find(f => f.id === 'otherfolder').trashed, false);
    assert.equal(m.S.google.files.find(f => f.id === 'old0').trashed, true, '最舊的先被清理'); assert.equal(m.S.google.files.find(f => f.id === 'old64').trashed, false);
  });
  it('匯出失敗 / 格式不符 → 不上傳、不清理舊備份，並回報錯誤', async () => {
    m.S.render.status = 500; await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /匯出失敗 500/); assert.equal(m.S.google.files.length, 0);
    m.S.render.status = 200; m.S.render.exportPayload = { hello: 'world' }; await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /格式不正確/);
    m.S.render.exportPayload = { ...exportOf(), data: { reservations: [], customers: 'oops', closures: [] } }; await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /格式不正確/);
    assert.equal(m.S.google.files.length, 0);
  });
  it('全空資料也會備份，但不觸發清理（避免空備份把好備份擠掉）', async () => {
    m.S.render.exportPayload = { ...exportOf(), data: { reservations: [], customers: [], closures: [] } };
    for (let i = 0; i < 70; i++) m.S.google.files.push({ id: 'o' + i, name: `Ronnie-Witchery-Corner-backup-v2-20260101-${String(i).padStart(4, '0')}.json`, parents: ['FOLDER1'], trashed: false, createdTime: new Date(Date.UTC(2026, 0, 1) + i * 60e3).toISOString() });
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW)); assert.equal(r.trashed, 0); assert.equal(m.S.google.files.filter(f => f.trashed).length, 0);
  });
  it('Drive 暫時故障 → 丟出錯誤（排程下一輪可重試），不留下半成品', async () => {
    m.S.render.exportPayload = exportOf(); m.S.google.failNext.drive = 1;
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /Google POST/); assert.equal(m.S.google.files.length, 0);
    assert.equal((await W.runBackup(ENV_ON(), mkDeps(NOW))).ok, true); assert.equal(m.S.google.files.length, 1);
  });
  it('HTTP /backup-now：成功 200；dry 不上傳；匯出失敗 502（Render 端會顯示錯誤）', async () => {
    const call = env => W.handleRequest(new Request('http://w/backup-now', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' } }), env, undefined, mkDeps(NOW));
    m.S.render.exportPayload = exportOf();
    assert.equal((await call(ENV_ON())).status, 200); assert.equal(m.S.google.files.length, 1);
    assert.equal((await call(ENV_ON({ FEATURE_BACKUP: 'dry' }))).status, 200); assert.equal(m.S.google.files.length, 1);
    m.S.render.status = 500; const bad = await call(ENV_ON()); assert.equal(bad.status, 502); assert.ok((await bad.json()).error);
  });
});

/* ───────────── G. 排程分派 ───────────── */
describe('G. Cron 分派', () => {
  it('0 19 * * *（03:00 台北）→ 備份；*/5 → job+提醒；對帳只在每 15 分鐘', async () => {
    m.S.render.exportPayload = { backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', data: { reservations: [{ id: 1 }], customers: [], closures: [] } };
    await W.handleScheduled({ cron: '0 19 * * *', scheduledTime: Date.parse('2026-10-20T19:00:00Z') }, ENV_ON(), undefined, mkDeps(NOW)); assert.equal(m.S.google.files.length, 1);
    T(m).reservations.push(resRow('r1', '2026-10-25'));
    await W.handleScheduled({ cron: '*/5 * * * *', scheduledTime: Date.parse('2026-10-20T04:05:00Z') }, ENV_ON(), undefined, mkDeps(NOW)); assert.equal(m.S.google.events.size, 0, '05 分不對帳');
    await W.handleScheduled({ cron: '*/5 * * * *', scheduledTime: Date.parse('2026-10-20T04:15:00Z') }, ENV_ON(), undefined, mkDeps(NOW)); assert.equal(m.S.google.events.size, 1, '15 分對帳');
  });
  it('任一子任務失敗不影響其他子任務；失敗與成功都寫入執行紀錄', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-25')); m.S.google.failNext.calendar = 99;
    const out = await W.runTick(ENV_ON(), mkDeps(NOW), { reconcile: true });
    assert.equal(out.find(o => o.task === 'jobs').ok, true); assert.equal(out.find(o => o.task === 'calendar_reconcile').ok, false);
    const runs = Object.fromEntries(T(m).app_state.map(x => [x.key, x.value]));
    assert.equal(runs['worker_last_run:jobs'].ok, true); assert.equal(runs['worker_last_run:calendar_reconcile'].ok, false);
  });
  it('/status（需密鑰）回報各功能模式、待處理/失敗 job 與最近執行結果', async () => {
    addJob('reservation.created', resRow('r1', '2026-10-25'), { status: 'failed' }); addJob('reservation.created', resRow('r2', '2026-10-25'));
    const res = await W.handleRequest(new Request('http://w/status', { headers: { 'x-worker-secret': 'shared-secret' } }), ENV_ON({ FEATURE_BACKUP: 'dry' }), undefined, mkDeps(NOW));
    const j = await res.json(); assert.equal(j.features.FEATURE_BACKUP, 'dry'); assert.equal(j.pendingJobs, 1); assert.equal(j.failedJobs, 1);
  });
});


/* ───────────── H. 審查補強：Webhook 可靠性、猜碼、設定檢查、逾時、故障 ───────────── */
describe('H1. LINE Webhook：暫時性故障可恢復、綁定碼原子且防猜', () => {
  const sign = body => crypto.createHmac('sha256', 'line-channel-secret').update(body).digest('base64');
  const hook = async (events, env = ENV_ON(), deps = mkDeps(NOW)) => {
    const body = JSON.stringify({ events });
    return W.handleLineWebhook(new Request('http://w/line/webhook', { method: 'POST', headers: { 'x-line-signature': sign(body) }, body }), env, deps);
  };
  let n = 0;
  const msg = (text, userId = 'U_CUSTOMER', over = {}) => ({ type: 'message', webhookEventId: 'EV' + (++n), replyToken: 'rt' + n, source: { userId }, message: { type: 'text', text }, ...over });
  const token = (code = 'A1B2C3', over = {}) => T(m).line_bind_tokens.push({ code, reservation_id: 'r1', phone: '0912-345-678', expires_at: new Date(NOW + 3600e3).toISOString(), ...over });
  const binds = () => T(m).app_state.filter(x => x.key.startsWith('line_bind:'));

  it('寫入綁定時資料庫暫時故障 → 回 500（讓 LINE 重送）、綁定碼還回去、使用者收到「系統忙碌」；重送後成功', async () => {
    token(); const ev = msg('A1B2C3');
    m.S.fail.push({ re: /^POST app_state/, times: 1 });
    const r1 = await hook([ev]); assert.equal(r1.status, 500);
    assert.equal(T(m).line_bind_tokens.length, 1, '綁定碼必須還原，否則使用者再也無法綁定');
    assert.equal(binds().length, 0); assert.match(m.S.line.replies.at(-1).text, /系統暫時忙碌/);
    const r2 = await hook([ev]); assert.equal(r2.status, 200);   // LINE 重送同一事件
    assert.equal(binds().length, 1); assert.equal(binds()[0].value.userId, 'U_CUSTOMER'); assert.equal(T(m).line_bind_tokens.length, 0);
    assert.match(m.S.line.replies.at(-1).text, /綁定成功/);
  });
  it('領取綁定碼時資料庫故障 → 500 + 忙碌回覆；綁定碼保持原樣', async () => {
    token(); m.S.fail.push({ re: /^DELETE line_bind_tokens/, times: 1 });
    assert.equal((await hook([msg('A1B2C3')])).status, 500);
    assert.equal(T(m).line_bind_tokens.length, 1); assert.equal(binds().length, 0);
  });
  it('429 / 逾時 這類暫時性錯誤 → 500；400 這類永久性錯誤 → 200（不引發無限重送）', async () => {
    token(); m.S.fail.push({ re: /^POST app_state/, times: 1, status: 429 });
    assert.equal((await hook([msg('A1B2C3')])).status, 500);
    m.reset(); token(); m.S.fail.push({ re: /^POST app_state/, times: 1, status: 400 });
    assert.equal((await hook([msg('A1B2C3')])).status, 200);
  });
  it('LINE 重送「已成功」的同一事件 → 回覆成功，不算猜錯，也不會覆蓋綁定', async () => {
    token(); const ev = msg('A1B2C3'); await hook([ev]);
    const before = JSON.stringify(binds()[0]);
    assert.equal((await hook([ev])).status, 200);
    assert.match(m.S.line.replies.at(-1).text, /綁定成功/); assert.equal(JSON.stringify(binds()[0]), before);
    assert.equal(T(m).app_state.filter(x => x.key.startsWith('line_attempts:')).length === 0 || T(m).app_state.find(x => x.key === 'line_attempts:U_CUSTOMER').value.count === 0, true);
    await hook([msg('A1B2C3', 'U_ATTACKER')]);   // 不同事件、同一個（已用過的）碼
    assert.equal(binds()[0].value.userId, 'U_CUSTOMER'); assert.match(m.S.line.replies.at(-1).text, /無效或已過期/);
  });
  it('同一個綁定碼被多個人同時送出 → 只有一個人綁定成功（原子領取）', async () => {
    token(); const users = ['U1', 'U2', 'U3', 'U4', 'U5'];
    await Promise.all(users.map(u => hook([msg('A1B2C3', u)])));
    assert.equal(binds().length, 1); assert.ok(users.includes(binds()[0].value.userId));
    assert.equal(m.S.line.replies.filter(r => /綁定成功/.test(r.text)).length, 1);
    assert.equal(m.S.line.replies.filter(r => /無效或已過期/.test(r.text)).length, 4);
  });
  it('reply 失敗（過期/LINE 故障）→ 改用 push 補送結果；push 也失敗不影響綁定與回應碼', async () => {
    token(); m.S.line.failReply = 1;
    assert.equal((await hook([msg('A1B2C3')])).status, 200);
    assert.equal(binds().length, 1); assert.deepEqual(m.S.line.pushes.map(p => p.to), ['U_CUSTOMER']); assert.match(m.S.line.pushes[0].text, /綁定成功/);
    m.reset(); token(); m.S.line.failReply = 1; m.S.line.failNext = 1;
    assert.equal((await hook([msg('A1B2C3')])).status, 200); assert.equal(binds().length, 1);
  });
  it('expires_at 不是有效日期 → 視為無效（不會被當成「永不過期」），且該碼被消耗', async () => {
    token('BADD00', { expires_at: 'not-a-date' });
    await hook([msg('BADD00')]); assert.equal(binds().length, 0); assert.match(m.S.line.replies.at(-1).text, /無效或已過期/);
  });
  it('猜碼限制：同一使用者 1 小時內錯 5 次即封鎖（連正確的碼也先擋）；成功會歸零；不同使用者互不影響', async () => {
    token('600D00');
    const c = clock(NOW); const deps = () => mkDeps(c);
    for (let i = 0; i < 5; i++) await hook([msg('AAAAA' + i, 'U_GUESS')], ENV_ON(), deps());
    await hook([msg('600D00', 'U_GUESS')], ENV_ON(), deps());
    assert.match(m.S.line.replies.at(-1).text, /嘗試次數過多/); assert.equal(binds().length, 0); assert.equal(T(m).line_bind_tokens.length, 1);
    await hook([msg('600D00', 'U_OTHER')], ENV_ON(), deps()); assert.equal(binds().length, 1, '另一位使用者不受影響');
    token('600D01', { expires_at: new Date(NOW + 3 * 3600e3).toISOString() }); c.v = NOW + 61 * 60e3;
    await hook([msg('600D01', 'U_GUESS')], ENV_ON(), deps()); assert.equal(binds().length, 1); // 同電話覆蓋，仍為 1 列
    assert.equal(binds()[0].value.userId, 'U_GUESS', '1 小時後恢復可用');
  });
  it('日誌不含綁定碼、完整電話或 userId 以外的個資', async () => {
    token(); const d = mkDeps(NOW); await hook([msg('A1B2C3')], ENV_ON(), d);
    const all = JSON.stringify(d.log); assert.ok(!all.includes('A1B2C3')); assert.ok(!all.includes('0912345678')); assert.ok(!all.includes('0912-345-678'));
  });
});

describe('H2. 設定檢查（只回報名稱，不外洩值）', () => {
  it('功能啟用但缺少設定 → 明確錯誤；dry 也會檢查（才能在試跑時發現）', async () => {
    m.S.render.exportPayload = { backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', data: { reservations: [], customers: [], closures: [] } };
    await assert.rejects(W.runBackup(ENV_ON({ GOOGLE_DRIVE_FOLDER_ID: '' }), mkDeps(NOW)), /缺少設定：GOOGLE_DRIVE_FOLDER_ID/);
    await assert.rejects(W.runBackup(ENV_ON({ FEATURE_BACKUP: 'dry', GOOGLE_REFRESH_TOKEN: '' }), mkDeps(NOW)), /缺少設定：GOOGLE_REFRESH_TOKEN/);
    await assert.rejects(W.reconcileCalendar(ENV_ON({ GOOGLE_CALENDAR_ID: '' }), mkDeps(NOW)), /GOOGLE_CALENDAR_ID/);
  });
  it('/status 列出缺少的設定名稱；回應內容不含任何機密值', async () => {
    const env = ENV_ON({ LINE_CHANNEL_ACCESS_TOKEN: '', GOOGLE_CLIENT_SECRET: '' });
    const res = await W.handleRequest(new Request('http://w/status', { headers: { 'x-worker-secret': 'shared-secret' } }), env, undefined, mkDeps(NOW));
    const text = await res.text(); const j = JSON.parse(text);
    assert.ok(j.missingConfig.FEATURE_ADMIN_NOTIFY.includes('LINE_CHANNEL_ACCESS_TOKEN')); assert.ok(j.missingConfig.FEATURE_CALENDAR.includes('GOOGLE_CLIENT_SECRET'));
    for (const secret of ['shared-secret', 'sb-service-key', 'line-channel-secret', 'g-refresh', 'csecret']) assert.ok(!text.includes(secret), `/status 不應含 ${secret}`);
    assert.deepEqual(W.missingConfig(m.env(), 'FEATURE_CALENDAR'), [], '功能 off 時不檢查');
  });
});

describe('H3. 逾時與故障處理', () => {
  it('外部服務卡住不回應 → 在逾時時間內失敗（不會讓整個排程無限等待），且標記為暫時性', { timeout: 10000 }, async () => {
    const hang = http.createServer(() => { /* 永不回應 */ }); await new Promise(r => hang.listen(0, '127.0.0.1', r));
    const env = ENV_ON({ SUPABASE_URL: `http://127.0.0.1:${hang.address().port}`, FETCH_TIMEOUT_MS: '300' });
    const t0 = Date.now(); let err;
    try { await W.processJobs(env, mkDeps(NOW, {})); } catch (e) { err = e; }
    hang.close(); hang.closeAllConnections?.();
    assert.ok(err, '應該丟出錯誤'); assert.ok(Date.now() - t0 < 3000, `應在 3 秒內失敗，實際 ${Date.now() - t0}ms`); assert.equal(err.transient, true);
  });
  it('LINE 已送出但 Worker 來不及更新 job（模擬當機）→ 租約到期重試時，因 retry key 不會重複送出', async () => {
    const j = addJob('reservation.created', resRow('r1', '2026-10-25')); const env = ENV_ON({ FEATURE_CALENDAR: 'off' }); const c = clock(NOW);
    m.S.fail.push({ re: /^PATCH integration_jobs/, skip: 1, times: 99 });   // 第 1 次 PATCH（領取）成功，之後全部失敗
    await W.processJobs(env, mkDeps(c));                                   // 不應丟出例外中斷整輪
    assert.equal(m.S.line.pushes.length, 1); assert.equal(m.S.line.attempts, 1);
    assert.equal(jobRow(j.id).status, 'pending'); assert.ok(Date.parse(jobRow(j.id).run_after) > NOW, '租約期間不會被重複撿起');
    m.S.fail = []; c.v = NOW + 6 * 60e3;
    const out = await W.processJobs(env, mkDeps(c));
    assert.equal(out[0].result, 'done'); assert.equal(m.S.line.attempts, 2, '確實重試過'); assert.equal(m.S.line.pushes.length, 1, 'LINE 以 retry key 去重，管理者只收到一則');
  });
  it('Google 429 限流 → 退避重試後成功；403 權限不足 → 5 次後標為 failed 並保留原因', async () => {
    const row = resRow('r1', '2026-10-25'); T(m).reservations.push(row); const j = addJob('reservation.created', row); const env = ENV_ON({ FEATURE_ADMIN_NOTIFY: 'off' }); const c = clock(NOW);
    m.S.google.failNext.calendar = 1; m.S.google.failStatus = 429;
    assert.equal((await W.processJobs(env, mkDeps(c)))[0].result, 'retry'); assert.match(jobRow(j.id).payload.lastError, /429/);
    c.v = Date.parse(jobRow(j.id).run_after) + 1000; assert.equal((await W.processJobs(env, mkDeps(c)))[0].result, 'done'); assert.equal(m.S.google.events.size, 1);
    m.reset(); T(m).reservations.push(row); const j2 = addJob('reservation.created', row); m.S.google.failNext.calendar = 99; m.S.google.failStatus = 403;
    for (let i = 0; i < 5; i++) { await W.processJobs(env, mkDeps(c)); c.v = Date.parse(jobRow(j2.id).run_after) + 1000; }
    assert.equal(jobRow(j2.id).status, 'failed'); assert.match(jobRow(j2.id).payload.lastError, /403/);
  });
  it('Google 授權失效（invalid_grant）→ 錯誤訊息指出原因與處置；修復後自動恢復', async () => {
    const row = resRow('r1', '2026-10-25'); T(m).reservations.push(row); const j = addJob('reservation.created', row); const env = ENV_ON({ FEATURE_ADMIN_NOTIFY: 'off' }); const c = clock(NOW);
    m.S.google.tokenFail = true; const out = await W.processJobs(env, mkDeps(c));
    assert.equal(out[0].result, 'retry'); assert.match(jobRow(j.id).payload.lastError, /invalid_grant.*重新取得 refresh token/);
    m.S.google.tokenFail = false; c.v = Date.parse(jobRow(j.id).run_after) + 1000;
    assert.equal((await W.processJobs(env, mkDeps(c)))[0].result, 'done'); assert.equal(m.S.google.events.size, 1);
  });
  it('日曆對帳遇到限流 → 本輪失敗但不留下半成品；下一輪完整補齊', async () => {
    for (let i = 0; i < 4; i++) T(m).reservations.push(resRow('q' + i, '2026-10-2' + (i + 1)));
    m.S.google.failNext.calendar = 1; m.S.google.failStatus = 429;
    await assert.rejects(W.reconcileCalendar(ENV_ON(), mkDeps(NOW)), /429/); assert.equal(m.S.google.events.size, 0);
    assert.equal((await W.reconcileCalendar(ENV_ON(), mkDeps(NOW))).created, 4);
  });
});

describe('H4. 日曆清除：預覽、分批、逐筆驗證', () => {
  const call = (body) => W.handleRequest(new Request('http://w/calendar-purge', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' }, body: JSON.stringify(body) }), m.env({ FEATURE_CALENDAR: 'off' }), undefined, mkDeps(NOW));
  it('preview 不刪除任何事件，只列出摘要；不需確認字串', async () => {
    for (let i = 0; i < 3; i++) T(m).reservations.push(resRow('p' + i, '2026-10-2' + (i + 1))); await W.reconcileCalendar(ENV_ON(), mkDeps(NOW));
    m.S.google.events.set('mine', { id: 'mine', summary: '我的行程' });
    const r = await (await call({ preview: true })).json();
    assert.equal(r.preview, true); assert.equal(r.wouldDelete, 3); assert.equal(m.S.google.events.size, 4); assert.ok(r.sample.every(e => e.id.startsWith('ronnier')));
  });
  it('大量事件分批刪除：每批最多 limit 筆，重複呼叫直到 remaining=false；自己的行程始終保留', async () => {
    for (let i = 0; i < 60; i++) T(m).reservations.push(resRow('b' + i, W.addDays('2026-10-21', i % 20), String(9 + (i % 10)).padStart(2, '0') + ':00'));
    m.S.google.pageSize = 25; for (let i = 0; i < 3; i++) await W.reconcileCalendar(ENV_ON(), mkDeps(NOW)); assert.equal(m.S.google.events.size, 60);
    m.S.google.events.set('mine', { id: 'mine', summary: '我的行程' });
    let calls = 0, total = 0, r;
    do { r = await (await call({ confirm: 'DELETE-ALL-RONNIE-EVENTS', limit: 25 })).json(); total += r.deleted; calls++; } while (r.remaining && calls < 10);
    assert.equal(total, 60); assert.ok(calls >= 3 && calls <= 4, `分批次數 ${calls}`); assert.deepEqual([...m.S.google.events.keys()], ['mine']);
  });
});

describe('H4b. 清除的最後防線', () => {
  it('即使 Google 的篩選失效、回傳了「不是本系統建立」的事件，也只刪帶 ronnie=1 標記的', async () => {
    T(m).reservations.push(resRow('a', '2026-10-25')); await W.reconcileCalendar(ENV_ON(), mkDeps(NOW));
    m.S.google.events.set('mine', { id: 'mine', summary: '我的行程' }); m.S.google.leakForeign = true;
    const r = await W.purgeCalendar(m.env({ FEATURE_CALENDAR: 'off' }), mkDeps(NOW));
    assert.equal(r.deleted, 1); assert.ok(m.S.google.events.has('mine'));
  });
});

describe('H5. 上線前檢查工具（preflight）：通過/失敗/略過、約束驗證、清理保證', () => {
  const run = (opts = {}, env = { SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: 'sb-service-key' }) => runPreflight(env, opts);
  const by = (r, st) => r.filter(x => x.status === st);
  const emptyTables = () => ['integration_jobs', 'line_bind_tokens', 'app_state'].every(t => T(m)[t].length === 0);

  it('唯讀模式：只有 GET；欄位通過，但約束與寫入行為標為「略過」且結束碼為 2（不可視為完成驗證）', async () => {
    const r = await run();
    assert.equal(by(r, 'fail').length, 0); assert.equal(by(r, 'pass').length, 5); assert.equal(by(r, 'skip').length, 7);
    assert.ok(by(r, 'skip').some(x => /line_bind_tokens\.code 具唯一約束/.test(x.name)), '綁定碼唯一約束必須列為待驗證');
    assert.ok(m.S.log.every(l => l.startsWith('GET ')), '唯讀模式只能有 GET'); assert.ok(emptyTables());
    assert.equal(summarize(r).exitCode, 2);
  });
  it('缺少欄位 → 指出是哪一張表，結束碼 1', async () => {
    m.S.dropped = { table: 'integration_jobs', col: 'dedupe_key' }; const r = await run();
    const bad = by(r, 'fail'); assert.equal(bad.length, 1); assert.match(bad[0].name, /integration_jobs/); assert.match(bad[0].detail, /dedupe_key/); assert.equal(summarize(r).exitCode, 1);
  });
  it('寫入往返測試：全部通過、沒有略過、結束碼 0、三張表都不留任何資料', async () => {
    const r = await run({ writeTest: true }); assert.deepEqual(by(r, 'fail'), [], JSON.stringify(by(r, 'fail')));
    assert.equal(by(r, 'skip').length, 0); assert.equal(summarize(r).exitCode, 0); assert.ok(emptyTables());
    for (const frag of ['設為 done', '設為 failed', 'line_bind_tokens.code 具唯一約束', 'on_conflict=code 可用', '原子領取查詢', 'app_state.key 具唯一約束']) assert.ok(by(r, 'pass').some(x => x.name.includes(frag)), frag);
  });
  it('status 欄位不接受 failed → 抓得到，且仍清除測試列', async () => {
    m.S.jobStatuses = ['pending', 'done']; const r = await run({ writeTest: true });
    assert.ok(by(r, 'fail').some(x => /failed/.test(x.name))); assert.ok(emptyTables());
  });
  it('dedupe_key 沒有唯一約束 → 抓得到，且「多寫入的重複列」也會被清除', async () => {
    m.S.noUnique = true; const r = await run({ writeTest: true });
    assert.ok(by(r, 'fail').some(x => /dedupe_key/.test(x.name))); assert.ok(emptyTables());
  });
  it('line_bind_tokens.code 沒有唯一約束 → 抓得到（重複碼 + on_conflict=code 還原都會失敗）；測試列照樣清除', async () => {
    m.S.noTokenUnique = true; const r = await run({ writeTest: true }); const bad = by(r, 'fail').map(x => x.name);
    assert.ok(bad.some(n => /line_bind_tokens\.code 具唯一約束/.test(n)), bad.join('|')); assert.ok(bad.some(n => /on_conflict=code/.test(n)), bad.join('|'));
    assert.ok(emptyTables()); assert.equal(summarize(r).exitCode, 1);
  });
  it('綁定碼「原子領取」查詢不回傳被刪的列 → 抓得到', async () => {
    m.S.deleteReturnsNothing = true; const r = await run({ writeTest: true });
    assert.ok(by(r, 'fail').some(x => /原子領取/.test(x.name) && /回傳被刪的列/.test(x.detail)), JSON.stringify(by(r, 'fail')));
  });
  it('清理保證：中途某步驟發生伺服器錯誤 / 丟出例外，所有測試資料仍會清除並驗證', async () => {
    m.S.fail.push({ re: /^GET app_state/, times: 1 }); let r = await run({ writeTest: true });
    assert.ok(by(r, 'fail').length >= 1); assert.ok(emptyTables()); assert.ok(by(r, 'pass').some(x => /測試資料已清除/.test(x.name)));
    m.reset(); let n = 0;
    const flaky = (url, opts) => (opts?.method === 'PATCH' && ++n === 2) ? Promise.reject(new Error('socket hang up')) : fetch(url, opts);
    r = await run({ writeTest: true, fetchImpl: flaky });
    assert.ok(by(r, 'fail').some(x => /例外/.test(x.detail))); assert.ok(emptyTables());
  });
  it('清理失敗時：明確回報殘留資料的識別資訊（可手動刪除），結束碼 1', async () => {
    m.S.fail.push({ re: /^DELETE integration_jobs/, times: 99 });
    const r = await run({ writeTest: true }); const bad = by(r, 'fail').find(x => x.name === '測試資料清理');
    assert.ok(bad, '必須回報清理失敗'); assert.match(bad.detail, /integration_jobs dedupe_key=preflight:[0-9a-f]{12}/);
    assert.equal(T(m).integration_jobs.length, 1, '殘留列確實存在，識別資訊才有意義'); assert.equal(summarize(r).exitCode, 1);
  });
  it('缺少連線設定 → 直接回報而不是丟例外', async () => {
    const r = await runPreflight({}, {}); assert.equal(r[0].status, 'fail'); assert.match(r[0].detail, /SUPABASE_URL/);
  });
});

describe('H6. 每次執行的對外請求預算（Cloudflare 免費方案 50 個）', () => {
  const purge = (body, env) => W.handleRequest(new Request('http://w/calendar-purge', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' }, body: JSON.stringify(body) }), env || m.env({ FEATURE_CALENDAR: 'off' }), undefined, mkDeps(NOW));
  const seedEvents = async n => {
    for (let i = 0; i < n; i++) T(m).reservations.push(resRow('e' + i, W.addDays('2026-10-21', i % 20), String(9 + (i % 10)).padStart(2, '0') + ':00'));
    for (let i = 0; i < Math.ceil(n / 25) + 1; i++) await W.reconcileCalendar(ENV_ON(), mkDeps(NOW));
    assert.equal(m.S.google.events.size, n);
  };

  it('日曆清除：預設每批 10 筆；每批的實際請求數遠低於 50；分批直到 remaining=false，且每批都驗證', async () => {
    await seedEvents(30); let calls = 0, total = 0, r;
    do {
      const before = m.S.requests; r = await (await purge({ confirm: 'DELETE-ALL-RONNIE-EVENTS' })).json();
      const used = m.S.requests - before; assert.ok(used <= 14, `單批請求數 ${used}`);
      assert.equal(r.deleted <= 10, true); assert.equal(r.verified, true); total += r.deleted; calls++;
    } while (r.remaining && calls < 10);
    assert.equal(total, 30); assert.equal(calls, 3); assert.equal(m.S.google.events.size, 0);
  });
  it('日曆清除：即使 Google 回傳的筆數超過 maxResults（不守規矩），單批仍不會超過 limit，請求數也在預算內', async () => {
    await seedEvents(30); m.S.google.ignoreMaxResults = true; const before = m.S.requests;
    const r = await (await purge({ confirm: 'DELETE-ALL-RONNIE-EVENTS', limit: 5 })).json();
    assert.equal(r.deleted, 5); assert.ok(m.S.requests - before <= 10, `請求數 ${m.S.requests - before}`); assert.equal(r.remaining, true);
  });
  it('日曆清除：刪除後驗證 — API 回成功但事件仍在 → verified=false 並列出 stillPresent，remaining=true', async () => {
    await seedEvents(3); m.S.google.ignoreDelete = true;
    const r = await (await purge({ confirm: 'DELETE-ALL-RONNIE-EVENTS' })).json();
    assert.equal(r.verified, false); assert.equal(r.stillPresent.length, 3); assert.equal(r.remaining, true);
  });
  it('日曆清除：以「實際剩餘請求數」為準，預算不足就提早停止（stoppedBy=budget）且不超過預算', async () => {
    await seedEvents(20); const before = m.S.requests;
    const r = await (await purge({ confirm: 'DELETE-ALL-RONNIE-EVENTS', limit: 25 }, m.env({ FEATURE_CALENDAR: 'off', SUBREQUEST_BUDGET: '8' }))).json();
    assert.equal(r.stoppedBy, 'budget'); assert.ok(r.deleted >= 1 && r.deleted < 10, `deleted=${r.deleted}`); assert.ok(m.S.requests - before <= 8, `請求數 ${m.S.requests - before}`);
    assert.equal(r.remaining, true);
  });
  it('日曆對帳：預算不足就停止（partial），不超過預算；下一次執行（預算重算）繼續完成', async () => {
    for (let i = 0; i < 20; i++) T(m).reservations.push(resRow('c' + i, W.addDays('2026-10-21', i), '10:00'));
    const env = ENV_ON({ SUBREQUEST_BUDGET: '10' }); const before = m.S.requests;
    const o1 = await W.reconcileCalendar(env, mkDeps(NOW)); assert.equal(o1.partial, true); assert.ok(o1.created > 0 && o1.created < 20); assert.ok(m.S.requests - before <= 10, `請求數 ${m.S.requests - before}`);
    for (let i = 0; i < 6; i++) await W.reconcileCalendar(env, mkDeps(NOW));
    assert.equal(m.S.google.events.size, 20);
  });
  it('job 處理：預算不足時停止領取新 job（未領取的 job 不消耗重試次數），不超過預算', async () => {
    for (let i = 0; i < 4; i++) { const r = resRow('j' + i, '2026-10-25'); T(m).reservations.push(r); addJob('reservation.created', r, { dedupe_key: 'k' + i }); }
    const env = ENV_ON({ SUBREQUEST_BUDGET: '25' }); const before = m.S.requests;
    const out = await W.processJobs(env, mkDeps(NOW));
    assert.ok(out.length >= 1 && out.length < 4, `處理了 ${out.length} 個`); assert.ok(m.S.requests - before <= 25, `請求數 ${m.S.requests - before}`);
    const untouched = T(m).integration_jobs.filter(j => j.status === 'pending'); assert.ok(untouched.length >= 1); assert.ok(untouched.every(j => j.attempts === 0), '未處理的 job 不應被消耗重試次數');
  });
  it('預算以「每次執行」計算：同一個 deps 連續處理兩次排程，第二次不會因第一次用掉預算而什麼都不做', async () => {
    const env = ENV_ON({ SUBREQUEST_BUDGET: '20', FEATURE_REMINDERS: 'off' }); const d = mkDeps(NOW);
    for (let i = 0; i < 2; i++) { const r = resRow('t' + i, '2026-10-25'); T(m).reservations.push(r); addJob('reservation.created', r, { dedupe_key: 'kk' + i }); await W.handleScheduled({ cron: '*/5 * * * *', scheduledTime: Date.parse('2026-10-20T04:05:00Z') }, env, undefined, d); }
    assert.equal(T(m).integration_jobs.filter(j => j.status === 'done').length, 2);
  });
});

/* ───────────── H7. 備份：位元組串流、驗證、每日冪等與重試 ───────────── */
describe('H7. 備份：串流上傳（不解碼）、上傳驗證、每日冪等與重試', () => {
  const exportOf = (n = 3, extra = {}) => ({ backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', backupVersion: 'V2', exportedAt: 'x', data: { reservations: Array.from({ length: n }, (_, i) => ({ id: 'r' + i, ...extra })), customers: [{ id: 'c' }], closures: [] } });
  const files = () => m.S.google.files.filter(f => !f.trashed);
  // 包裝 fetch：匯出回應若被 text()/json() 等「解碼」就丟錯，用來證明串流路徑完全沒有碰內容
  const noDecode = (url, opts) => fetch(url, opts).then(res => !String(url).includes('/api/integration/export') ? res
    : new Proxy(res, { get(tg, p) { if (['text', 'json', 'arrayBuffer', 'blob', 'formData'].includes(p)) return () => { throw new Error('不應解碼匯出內容'); }; const v = tg[p]; return typeof v === 'function' ? v.bind(tg) : v; } }));

  it('預設為串流：用可續傳上傳、位元組完全相同、帶 Content-Length（非 chunked），且 Worker 完全沒有解碼匯出內容', async () => {
    m.S.render.exportPayload = exportOf();
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW, { fetch: noDecode }), 'manual');
    assert.equal(r.ok, true); assert.equal(r.path, 'stream'); assert.deepEqual(m.S.google.uploadKinds, ['resumable']);
    assert.deepEqual(files()[0].content, m.S.render.exportPayload); assert.equal(files()[0].bytes, r.bytes);
    const h = m.S.google.putHeaders[0]; assert.equal(Number(h['content-length']), r.bytes); assert.equal(h['transfer-encoding'], undefined, '必須是固定長度，不可為 chunked');
  });
  it('大檔（約 12MB）也走串流且不解碼；同一份資料在緩衝模式會被大小上限擋下（保護 10ms CPU）', async () => {
    m.S.render.exportPayload = exportOf(2, { blob: 'x'.repeat(6_000_000) });
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW, { fetch: noDecode }), 'manual');
    assert.equal(r.path, 'stream'); assert.ok(r.bytes > 11_000_000); assert.equal(files()[0].bytes, r.bytes);
    m.S.google.files = []; m.S.google.uploadKinds = [];
    await assert.rejects(W.runBackup(ENV_ON({ BACKUP_UPLOAD_MODE: 'buffered' }), mkDeps(NOW), 'manual'), /超過緩衝模式安全上限/); assert.equal(files().length, 0);
  });
  it('上傳後 Drive 回報的大小與送出的不符 → 視為損毀：該檔移到垃圾桶、本次備份視為失敗（不留下壞檔）', async () => {
    m.S.render.exportPayload = exportOf(); m.S.google.truncateUpload = true;
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW), 'manual'), /上傳大小不符/); assert.equal(files().length, 0); assert.equal(m.S.google.files.length, 1, '壞檔應在垃圾桶內而非被永久刪除');
  });
  it('串流超過上限 / Drive 上傳階段暫時故障 → 不留下檔案；故障排除後可重跑', async () => {
    m.S.render.exportPayload = exportOf();
    await assert.rejects(W.runBackup(ENV_ON({ BACKUP_STREAM_MAX_BYTES: '100' }), mkDeps(NOW), 'manual'), /超過串流上限/); assert.equal(m.S.google.sessions.size, 0, '超限時不應建立上傳工作階段');
    m.S.google.failPut = 1; await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW), 'manual'), /PUT upload 503/); assert.equal(files().length, 0);
    assert.equal((await W.runBackup(ENV_ON(), mkDeps(NOW), 'manual')).ok, true); assert.equal(files().length, 1);
  });
  it('相容舊版 Render（沒有 X-Export-* 標頭）或沒有 Content-Length：自動改用緩衝模式；太大則要求更新 server.js', async () => {
    m.S.render.exportPayload = exportOf(); m.S.render.legacy = true;
    let r = await W.runBackup(ENV_ON(), mkDeps(NOW), 'manual'); assert.equal(r.path, 'buffered'); assert.deepEqual(m.S.google.uploadKinds, ['multipart']); assert.deepEqual(files()[0].content, m.S.render.exportPayload);
    m.reset(); m.S.render.exportPayload = exportOf(); m.S.render.legacy = true; m.S.render.chunked = true;      // 舊版 Render + 沒有 Content-Length：既不知道大小也沒有標頭 → 只能緩衝
    r = await W.runBackup(ENV_ON(), mkDeps(NOW), 'manual'); assert.equal(r.path, 'buffered'); assert.equal(files().length, 1);
    m.reset(); m.S.render.exportPayload = exportOf(5); m.S.render.legacy = true;
    // 標頭已顯示太大 → 不應下載/解碼內容（用會在解碼時丟錯的 fetch 驗證），直接報錯並提示更新 server.js
    await assert.rejects(W.runBackup(ENV_ON({ BACKUP_MAX_BYTES: '200' }), mkDeps(NOW, { fetch: noDecode }), 'manual'), /更新 Render 的 server\.js/); assert.equal(files().length, 0);
    // 沒有 Content-Length（chunked）時只能讀完才知道大小 → 讀完後仍要擋下
    m.reset(); m.S.render.exportPayload = exportOf(5); m.S.render.legacy = true; m.S.render.chunked = true;
    await assert.rejects(W.runBackup(ENV_ON({ BACKUP_MAX_BYTES: '200' }), mkDeps(NOW), 'manual'), /超過緩衝模式安全上限/); assert.equal(files().length, 0);
  });
  it('BACKUP_UPLOAD_MODE=buffered 可手動切回緩衝模式（回退用）', async () => {
    m.S.render.exportPayload = exportOf(); const r = await W.runBackup(ENV_ON({ BACKUP_UPLOAD_MODE: 'buffered' }), mkDeps(NOW), 'manual');
    assert.equal(r.path, 'buffered'); assert.deepEqual(m.S.google.uploadKinds, ['multipart']);
  });
  it('dry：只讀回應標頭（不讀內容、不連 Google、不上傳）', async () => {
    m.S.render.exportPayload = exportOf(); const d = mkDeps(NOW, { fetch: noDecode });
    const r = await W.runBackup(ENV_ON({ FEATURE_BACKUP: 'dry' }), d, 'manual');
    assert.equal(r.dry, true); assert.equal(r.path, 'stream'); assert.deepEqual(r.counts, { reservations: 3, customers: 1, closures: 0 });
    assert.equal(m.S.google.tokenCalls, 0); assert.equal(m.S.google.files.length, 0); assert.equal(m.S.render.exportCalls, 1);
  });
  it('每日冪等：cron 當天已成功備份就略過；手動備份一律執行；隔天會再備份', async () => {
    m.S.render.exportPayload = exportOf(); const env = ENV_ON();
    const a = await W.runBackup(env, mkDeps(NOW), 'cron'); assert.equal(a.ok, true); assert.equal(a.skipped, undefined);
    const b = await W.runBackup(env, mkDeps(NOW + 3600e3), 'cron'); assert.equal(b.skipped, 'already_done_today'); assert.equal(files().length, 1); assert.equal(m.S.render.exportCalls, 1, '略過時不應再向 Render 要資料');
    await W.runBackup(env, mkDeps(NOW + 7200e3), 'manual'); assert.equal(files().length, 2);
    await W.runBackup(env, mkDeps(NOW + 86400e3), 'cron'); assert.equal(files().length, 3);
  });
  it('重試排程：第一次 cron 失敗、第二次成功 → 只有一份備份且不打擾管理者；兩次都失敗 → 管理者收到一則警示（12 小時內不重複）', async () => {
    m.S.render.exportPayload = exportOf(); const env = ENV_ON(); const [first, last] = W.CRONS.backups;
    m.S.render.status = 500;
    await W.handleScheduled({ cron: first, scheduledTime: NOW }, env, undefined, mkDeps(NOW)); assert.equal(m.S.line.pushes.length, 0, '第一次失敗不通知');
    m.S.render.status = 200; await W.handleScheduled({ cron: last, scheduledTime: NOW + 3600e3 }, env, undefined, mkDeps(NOW + 3600e3));
    assert.equal(files().length, 1); assert.equal(m.S.line.pushes.length, 0);
    m.reset(); m.S.render.exportPayload = exportOf(); m.S.render.status = 500;
    await W.handleScheduled({ cron: first, scheduledTime: NOW }, env, undefined, mkDeps(NOW)); await W.handleScheduled({ cron: last, scheduledTime: NOW + 3600e3 }, env, undefined, mkDeps(NOW + 3600e3));
    assert.equal(m.S.line.pushes.length, 1); assert.equal(m.S.line.pushes[0].to, 'U_ADMIN'); assert.match(m.S.line.pushes[0].text, /自動備份失敗/);
    await W.handleScheduled({ cron: last, scheduledTime: NOW + 7200e3 }, env, undefined, mkDeps(NOW + 7200e3)); assert.equal(m.S.line.pushes.length, 1, '12 小時內不重複警示');
    await W.handleScheduled({ cron: last, scheduledTime: NOW + 14 * 3600e3 }, env, undefined, mkDeps(NOW + 14 * 3600e3)); assert.equal(m.S.line.pushes.length, 2);
  });
});

/* ───────────── H8. 管理者警示：靜默故障要讓人知道 ───────────── */
describe('H7b. 備份：Render 前端代理壓縮 / 移除 Content-Length（實測會發生）', () => {
  const exportOf = (n = 3, extra = {}) => ({ backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', backupVersion: 'V2', exportedAt: 'x', data: { reservations: Array.from({ length: n }, (_, i) => ({ id: 'r' + i, ...extra })), customers: [{ id: 'c' }], closures: [] } });
  const files = () => m.S.google.files.filter(f => !f.trashed);
  const noDecode = (url, opts) => fetch(url, opts).then(res => !String(url).includes('/api/integration/export') ? res
    : new Proxy(res, { get(tg, p) { if (['text', 'json', 'arrayBuffer', 'blob', 'formData'].includes(p)) return () => { throw new Error('不應解碼匯出內容'); }; const v = tg[p]; return typeof v === 'function' ? v.bind(tg) : v; } }));

  it('Worker 要求「不壓縮」（Accept-Encoding: identity）；前端代理因此不壓縮，仍可串流', async () => {
    m.S.render.exportPayload = exportOf(); m.S.render.proxyGzip = true;
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW, { fetch: noDecode }), 'manual');
    assert.equal(m.S.render.lastAcceptEncoding, 'identity'); assert.equal(r.path, 'stream'); assert.deepEqual(files()[0].content, m.S.render.exportPayload);
  });
  it('沒有 Content-Length（chunked）但有 X-Export-Bytes → 仍可串流，並以 X-Export-Bytes 作為上傳長度', async () => {
    m.S.render.exportPayload = exportOf(); m.S.render.chunked = true;
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW, { fetch: noDecode }), 'manual');
    assert.equal(r.path, 'stream'); assert.equal(files()[0].bytes, r.bytes); assert.equal(Number(m.S.google.putHeaders[0]['content-length']), r.bytes);
  });
  it('最壞情況：代理無視要求、一律壓縮 → 偵測到 Content-Encoding，不走串流（避免長度不符），改用緩衝並成功備份', async () => {
    m.S.render.exportPayload = exportOf(); m.S.render.forceGzip = true;
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW), 'manual');
    assert.equal(r.path, 'buffered'); assert.deepEqual(files()[0].content, m.S.render.exportPayload); assert.equal(r.bytes, Buffer.byteLength(JSON.stringify(m.S.render.exportPayload)));
  });
  it('X-Export-Bytes 與實際位元組數不符（謊報）→ 上傳被拒/驗證失敗，不留下壞檔（安全失敗）', async () => {
    m.S.render.exportPayload = exportOf(); m.S.render.lieBytes = -10;
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW), 'manual')); assert.equal(files().length, 0);
  });
});

describe('H8. 管理者警示（Google 授權失效、任務重試用盡）', () => {
  const calJob = () => { const r = resRow('r1', '2026-10-25'); T(m).reservations.push(r); return addJob('reservation.created', r); };
  const alerts = () => m.S.line.pushes.filter(p => p.to === 'U_ADMIN' && /⚠️/.test(p.text));

  it('Google 授權失效（invalid_grant）→ 通知管理者重新授權；12 小時內不重複，之後再提醒', async () => {
    calJob(); const env = ENV_ON({ FEATURE_ADMIN_NOTIFY: 'on' }); const c = clock(NOW); m.S.google.tokenFail = true;
    await W.runTick(env, mkDeps(c)); assert.equal(alerts().length, 1); assert.match(alerts()[0].text, /Google 授權已失效[\s\S]*refresh token/);
    c.v = NOW + 6 * 60e3; await W.runTick(env, mkDeps(c)); assert.equal(alerts().length, 1, '12 小時內不重複');
    c.v = NOW + 13 * 3600e3; await W.runTick(env, mkDeps(c)); assert.equal(alerts().length, 2);
  });
  it('任務重試 5 次仍失敗 → 通知管理者一次（不是每次失敗都通知）', async () => {
    const j = calJob(); const env = ENV_ON(); const c = clock(NOW); m.S.google.failNext.calendar = 99; m.S.google.failStatus = 403;
    for (let i = 0; i < 5; i++) { await W.runTick(env, mkDeps(c)); c.v = Date.parse(jobRow(j.id).run_after) + 1000; }
    assert.equal(jobRow(j.id).status, 'failed'); assert.equal(alerts().length, 1); assert.match(alerts()[0].text, /1 筆整合任務重試 5 次仍失敗/);
  });
  it('遵守開關與設定：off 不發、dry 只記錄、缺少設定不報錯；警示本身失敗也不影響主流程', async () => {
    const d1 = mkDeps(NOW); assert.equal(await W.alertAdmin(ENV_ON({ FEATURE_ADMIN_NOTIFY: 'off' }), d1, 'k', 't'), 'off');
    const d2 = mkDeps(NOW); assert.equal(await W.alertAdmin(ENV_ON({ FEATURE_ADMIN_NOTIFY: 'dry' }), d2, 'k', 't'), 'sent'); assert.equal(m.S.line.pushes.length, 0); assert.ok(d2.log.some(l => l.task === 'alert' && l.dry));
    m.reset(); assert.equal(await W.alertAdmin(ENV_ON({ ADMIN_LINE_USER_ID: '' }), mkDeps(NOW), 'k', 't'), 'no_config');
    calJob(); m.S.google.tokenFail = true; m.S.line.failNext = 99;
    const out = await W.runTick(ENV_ON(), mkDeps(NOW)); assert.ok(Array.isArray(out), 'LINE 也壞掉時，runTick 仍須正常結束');
  });
});

/* ───────────── H9. LINE Webhook 必須在 2 秒內回應 ───────────── */
describe('H9. Webhook 回應期限（LINE 要求 2 秒）', () => {
  const sign = body => crypto.createHmac('sha256', 'line-channel-secret').update(body).digest('base64');
  let n = 0; const msg = text => ({ type: 'message', webhookEventId: 'EVD' + (++n), replyToken: 'rtd' + n, source: { userId: 'U_SLOW' }, message: { type: 'text', text } });
  const token = () => T(m).line_bind_tokens.push({ code: 'A1B2C3', reservation_id: 'r1', phone: '0912-345-678', expires_at: new Date(NOW + 3600e3).toISOString() });
  const call = async (env, events, pending) => { const body = JSON.stringify({ events }); const t0 = Date.now();
    const res = await W.handleLineWebhook(new Request('http://w/line/webhook', { method: 'POST', headers: { 'x-line-signature': sign(body) }, body }), env, mkDeps(NOW), { waitUntil: p => pending.push(p) });
    return { res, ms: Date.now() - t0 }; };
  const binds = () => T(m).app_state.filter(x => x.key.startsWith('line_bind:'));

  it('資料庫很慢（處理超過期限）→ 立刻回 200（deferred），處理在背景完成，客人最後仍綁定成功', async () => {
    token(); m.S.delay.push({ re: /./, ms: 250 }); const pending = [];
    const { res, ms } = await call(ENV_ON({ WEBHOOK_DEADLINE_MS: '100' }), [msg('A1B2C3')], pending);
    assert.equal(res.status, 200); assert.equal((await res.json()).deferred, true); assert.ok(ms < 450, `應在期限附近回應，實際 ${ms}ms`);
    assert.equal(binds().length, 0, '回應當下還沒處理完'); await Promise.all(pending);
    assert.equal(binds().length, 1); assert.match(m.S.line.replies.at(-1).text, /綁定成功/);
  });
  it('已回 200 之後才遇到暫時性故障：客人收到「系統忙碌」、綁定碼還原（LINE 不會重送，所以要讓客人知道可重傳）', async () => {
    token(); m.S.delay.push({ re: /^POST app_state/, ms: 250 }); m.S.fail.push({ re: /^POST app_state/, times: 1 }); const pending = [];
    const { res } = await call(ENV_ON({ WEBHOOK_DEADLINE_MS: '100' }), [msg('A1B2C3')], pending); assert.equal(res.status, 200);
    await Promise.all(pending); assert.equal(binds().length, 0); assert.equal(T(m).line_bind_tokens.length, 1); assert.match(m.S.line.replies.at(-1).text, /系統暫時忙碌/);
  });
  it('在期限內完成：仍回傳真實結果（暫時性故障 → 500，讓 LINE 重送）', async () => {
    token(); m.S.fail.push({ re: /^POST app_state/, times: 1 }); const pending = [];
    const { res } = await call(ENV_ON({ WEBHOOK_DEADLINE_MS: '1500' }), [msg('A1B2C3')], pending); assert.equal(res.status, 500); assert.equal(pending.length, 0);
  });
});

/* ───────────── H10. 排程設定守門（時區 / cron） ───────────── */
describe('H10. 排程與時區守門', () => {
  const toml = fs.readFileSync(new URL('../../worker/wrangler.toml', import.meta.url), 'utf8');
  const crons = JSON.parse('[' + /crons\s*=\s*\[([^\]]*)\]/.exec(toml)[1] + ']');

  it('wrangler.toml 的 crons 必須與程式的 CRONS 完全一致（改了一邊忘了另一邊，備份就會靜默不執行）', () => {
    assert.deepEqual(crons, [W.CRONS.tick, ...W.CRONS.backups]);
  });
  it('備份排程換算成台北時間必須是凌晨 03:00 與 04:00（UTC+8）；提醒用的 cron 不綁定任何小時', () => {
    assert.deepEqual(W.CRONS.backups.map(c => { const [min, hour] = c.split(' '); return `${String((Number(hour) + 8) % 24).padStart(2, '0')}:${min.padStart(2, '0')}`; }), ['03:00', '04:00']);
    assert.equal(W.CRONS.tick.split(' ')[1], '*', '5 分鐘檢查不得綁定小時；17:00 的判斷在程式裡以 Asia/Taipei 計算');
    for (const c of crons) assert.notEqual(c, '0 17 * * *', '0 17 * * * 是 UTC 17:00 = 台北凌晨 01:00，不是下午 5 點');
  });
  it('提醒時間與 cron 無關：每個 5 分鐘檢查都以台北時間判斷（09:00Z = 台北 17:00 才送；17:00Z 不會再送）', async () => {
    T(m).reservations.push(resRow('r1', '2026-10-21')); T(m).app_state.push({ key: 'line_bind:0912345678', value: { userId: 'U_C' }, updated_at: 'x' });
    const tick = iso => W.handleScheduled({ cron: W.CRONS.tick, scheduledTime: Date.parse(iso) }, ENV_ON(), undefined, mkDeps(Date.parse(iso)));
    await tick('2026-10-20T08:55:00Z'); assert.equal(m.S.line.pushes.length, 0);
    await tick('2026-10-20T09:00:00Z'); assert.equal(m.S.line.pushes.length, 1);
    await tick('2026-10-20T17:00:00Z'); await tick('2026-10-20T23:55:00Z'); assert.equal(m.S.line.pushes.length, 1);
  });
  it('排程字串與程式不一致時：留下 unknown_cron 紀錄，且不會誤當成備份執行', async () => {
    m.S.render.exportPayload = { backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', data: { reservations: [{ id: 1 }], customers: [], closures: [] } };
    const d = mkDeps(NOW); await W.handleScheduled({ cron: '0 17 * * *', scheduledTime: NOW }, ENV_ON(), undefined, d);
    assert.ok(d.log.some(l => l.task === 'unknown_cron' && l.cron === '0 17 * * *')); assert.equal(m.S.google.files.length, 0); assert.equal(m.S.render.exportCalls, 0);
  });
  it('日曆對帳：未來預約超過 300 筆時警告「免費方案 CPU 可能不足」', async () => {
    for (let i = 0; i < 305; i++) T(m).reservations.push(resRow('w' + i, W.addDays('2026-10-21', i % 30), String(9 + (i % 10)).padStart(2, '0') + ':00'));
    const d = mkDeps(NOW); const out = await W.reconcileCalendar(ENV_ON(), d); assert.equal(out.warn, 'large_dataset'); assert.ok(d.log.some(l => l.task === 'cpu_risk'));
    m.reset(); T(m).reservations.push(resRow('a', '2026-10-25')); assert.equal((await W.reconcileCalendar(ENV_ON(), mkDeps(NOW))).warn, undefined);
  });
});
