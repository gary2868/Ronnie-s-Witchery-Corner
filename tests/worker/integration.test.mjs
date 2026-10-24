import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMocks, KEYS } from '../support/mock-services.mjs';
import { startWorkerAdapter, startRealServer } from '../support/harness.mjs';
import * as W from '../../worker/index.js';

let m, worker, flags = {};
before(async () => {
  m = await startMocks();
  worker = await startWorkerAdapter(() => m.env({ FEATURE_ADMIN_NOTIFY: 'on', FEATURE_CALENDAR: 'on', FEATURE_REMINDERS: 'on', FEATURE_BACKUP: 'on', FEATURE_LINE_BINDING: 'on', ...flags, RENDER_BASE_URL: renderBase }));
});
after(async () => { await worker.close(); await m.close(); });

let renderBase = '', srv, extra = [];
const T = () => m.S.tables;
const events = () => [...m.S.google.events.values()];
const startSrv = async (env = {}) => {
  srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase, INTEGRATION_WORKER_URL: worker.url, INTEGRATION_WORKER_SECRET: 'shared-secret', ...env });
  renderBase = srv.base; return srv;
};
beforeEach(() => { m.reset(); flags = {}; worker.clock.cur = null; });
afterEach(async () => { if (srv) await srv.stop(); srv = null; for (const s of extra) await s.stop(); extra = []; });

async function pickSlot(api) {
  const cfg = (await api('GET', '/api/config', undefined, { auth: false })).json;
  for (let i = 3; i < 30; i++) {
    const d = new Date(Date.now() + 8 * 3600e3 + i * 86400e3).toISOString().slice(0, 10);
    const av = (await api('GET', `/api/availability?date=${d}&serviceId=chakra`, undefined, { auth: false })).json;
    if (av && av.available && av.available.length > 3) return { date: d, startTime: av.available[0] };
  }
  throw new Error('找不到可預約日期');
}
const book = async (api, slot, over = {}) => api('POST', '/api/reservations', { name: '陳小華', birthDate: '1992-05-06', phone: '0912-345-678', serviceId: 'chakra', note: '第一次預約', ...slot, ...over }, { auth: false });

describe('整合測試：真實 server.js（Supabase 模式）+ Worker', () => {
  it('【回退驗證】INTEGRATION_ADMIN_EVENTS 未開啟 → 後台取消/公休不產生新事件（與舊版相同）', async () => {
    const { api } = await startSrv();
    const slot = await pickSlot(api); const r = await book(api, slot); assert.equal(r.status, 201);
    await worker.idle();
    const before = T().integration_jobs.length; const wakesBefore = m.S.wakes.length;
    assert.equal(before, 1, '既有行為：客人新增預約仍會產生 created job');
    assert.equal((await api('PATCH', `/api/admin/reservations/${r.json.reservation.id}/cancel`)).status, 200);
    const d2 = new Date(Date.parse(slot.date) + 5 * 86400e3).toISOString().slice(0, 10);
    assert.equal((await api('POST', '/api/admin/closures', { date: d2 })).status, 201);
    await worker.idle();
    assert.equal(T().integration_jobs.length, before, '旗標關閉時，後台取消不得新增 job');
  });

  it('【完整流程】新增→通知+日曆→綁定→前一天17:00提醒→後台取消→恢復→公休→備份→還原', async () => {
    const { api } = await startSrv({ INTEGRATION_ADMIN_EVENTS: 'on' });
    const slot = await pickSlot(api);

    // 1) 客人新增預約：真實 server 寫入 job + 綁定碼，並喚醒 Worker
    const created = await book(api, slot, { lineId: 'chen_line' }); assert.equal(created.status, 201);
    const rid = created.json.reservation.id, code = created.json.lineBindCode;
    assert.match(code, /^[0-9A-F]{6}$/);
    await worker.idle();
    const adminMsgs = () => m.S.line.pushes.filter(p => p.to === 'U_ADMIN');
    assert.equal(adminMsgs().length, 1); assert.match(adminMsgs()[0].text, /新預約[\s\S]*陳小華[\s\S]*0912-345-678/);
    assert.equal(events().length, 1); assert.equal(events()[0].start.dateTime, `${slot.date}T${slot.startTime}:00+08:00`);
    assert.ok(T().integration_jobs.every(j => j.status === 'done'));

    // 2) 客人把綁定碼傳給官方帳號
    const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt1', source: { userId: 'U_CHEN' }, message: { type: 'text', text: code.toLowerCase() } }] });
    const sig = crypto.createHmac('sha256', 'line-channel-secret').update(body).digest('base64');
    assert.equal((await fetch(worker.url + '/line/webhook', { method: 'POST', headers: { 'x-line-signature': sig }, body })).status, 200);
    assert.equal(T().app_state.find(x => x.key === 'line_bind:0912345678').value.userId, 'U_CHEN');

    // 3) 預約前一天 17:00（台北）→ 提醒客人。16:59 不送，17:00 送。
    const remindAt = W.taipeiToUtcMs(W.addDays(slot.date, -1), '17:00');
    worker.clock.cur = remindAt - 1000;
    await fetch(worker.url + '/wake', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' } }); await worker.idle();
    assert.equal(m.S.line.pushes.filter(p => p.to === 'U_CHEN').length, 0);
    worker.clock.cur = remindAt;
    await fetch(worker.url + '/wake', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' } }); await worker.idle();
    const rem = m.S.line.pushes.filter(p => p.to === 'U_CHEN'); assert.equal(rem.length, 1); assert.ok(rem[0].text.includes(slot.date));
    worker.clock.cur = null;

    // 4) 後台取消 → 管理者收到通知、日曆事件刪除
    assert.equal((await api('PATCH', `/api/admin/reservations/${rid}/cancel`)).status, 200); await worker.idle();
    assert.equal(adminMsgs().length, 2); assert.match(adminMsgs()[1].text, /預約已取消/); assert.equal(events().length, 0);

    // 5) 後台把已取消的預約改成 Finished（恢復）→ 日曆事件回來、管理者收到修改通知
    assert.equal((await api('PATCH', `/api/admin/reservations/${rid}/status`, { statusLabel: 'Finished' })).status, 200); await worker.idle();
    assert.equal(events().length, 1); assert.match(adminMsgs()[2].text, /預約已修改/);

    // 6) 公休：新增 → 日曆出現「公休」；刪除 → 消失（Worker 對帳）
    const d2 = W.addDays(slot.date, 5);
    const cl = await api('POST', '/api/admin/closures', { date: d2 }); assert.equal(cl.status, 201); await worker.idle();
    const ce = events().find(e => e.summary === '公休'); assert.ok(ce); assert.deepEqual(ce.start, { date: d2 });
    assert.equal((await api('DELETE', `/api/admin/closures/${cl.json.closure.id}`)).status, 200); await worker.idle();
    assert.equal(events().filter(e => e.summary === '公休').length, 0);

    // 7) Worker 寫入的綁定資料不會被 server 的資料同步誤刪
    assert.ok(T().app_state.find(x => x.key === 'line_bind:0912345678'), 'server 同步 reservation_meta 時不得動到其他 app_state 鍵');

    // 8) 後台「備份到 Google Drive」按鈕 → server → Worker → 匯出 → Drive
    const bk = await api('POST', '/api/admin/backup-to-drive'); assert.equal(bk.status, 200, JSON.stringify(bk.json));
    assert.match(srv.log(), /\[integration\] export accessed/, '備份含個資：匯出必須留下存取紀錄');
    assert.ok(!srv.log().includes('shared-secret'), '日誌不得出現密鑰');
    assert.equal(m.S.google.files.length, 1); const file = m.S.google.files[0];
    assert.deepEqual(m.S.google.uploadKinds, ['resumable'], '真實 server 的標頭足以讓 Worker 走串流路徑（不解碼）');
    assert.match(file.name, /^Ronnie-Witchery-Corner-backup-v2-\d{8}-\d{4}\.json$/); assert.equal(file.content.data.reservations.length, 1);

    // 9) 還原演練：把 Drive 上的檔案匯入一個全新的 server，資料必須一致
    const fresh = await startRealServer({}); extra.push(fresh);
    const imp = await fresh.api('POST', '/api/admin/import', file.content); assert.equal(imp.status, 200, JSON.stringify(imp.json));
    const restored = (await fresh.api('GET', '/api/admin/reservations')).json;
    assert.equal(restored.length, 1); assert.equal(restored[0].id, rid); assert.equal(restored[0].name, '陳小華'); assert.equal(restored[0].date, slot.date);
    assert.equal((await fresh.api('GET', '/api/admin/customers')).json.length, 1);
  });

  it('【回退驗證】Worker 全部功能 off → 即使 server 持續送事件，也不會有任何對外動作', async () => {
    flags = { FEATURE_ADMIN_NOTIFY: 'off', FEATURE_CALENDAR: 'off', FEATURE_REMINDERS: 'off', FEATURE_BACKUP: 'off', FEATURE_LINE_BINDING: 'off' };
    const { api } = await startSrv({ INTEGRATION_ADMIN_EVENTS: 'on' });
    const slot = await pickSlot(api); const r = await book(api, slot); await worker.idle();
    await api('PATCH', `/api/admin/reservations/${r.json.reservation.id}/cancel`); await worker.idle();
    assert.equal(m.S.line.pushes.length, 0); assert.equal(m.S.google.tokenCalls, 0); assert.equal(events().length, 0);
    assert.equal((await api('POST', '/api/admin/backup-to-drive')).status, 502, '備份關閉時，後台按鈕顯示錯誤而不是假裝成功');
    assert.equal((await api('GET', '/api/admin/reservations')).json.length, 1, '網站本身完全不受影響');
  });

  it('【容錯】Worker/日曆/LINE 全部故障時，網站預約與後台操作照常成功', async () => {
    const { api } = await startSrv({ INTEGRATION_ADMIN_EVENTS: 'on', INTEGRATION_WORKER_URL: 'http://127.0.0.1:9' });
    const slot = await pickSlot(api);
    const r = await book(api, slot); assert.equal(r.status, 201);
    assert.equal((await api('PATCH', `/api/admin/reservations/${r.json.reservation.id}/cancel`)).status, 200);
    const d2 = W.addDays(slot.date, 5); assert.equal((await api('POST', '/api/admin/closures', { date: d2 })).status, 201);
  });

  it('【安全】匯出端點：沒有/錯誤密鑰 → 401 並留下拒絕紀錄（日誌不含密鑰），不洩漏任何資料', async () => {
    const { api, base, log } = await startSrv();
    const slot = await pickSlot(api); await book(api, slot);
    for (const headers of [{}, { 'X-Integration-Secret': 'wrong' }, { 'X-Integration-Secret': 'shared-secre' }]) {
      const r = await fetch(base + '/api/integration/export', { headers }); assert.equal(r.status, 401); assert.ok(!(await r.text()).includes('陳小華'));
    }
    assert.equal((srv.log().match(/export denied/g) || []).length, 3); assert.ok(!srv.log().includes('wrong'));
    assert.equal((await fetch(base + '/api/integration/export', { headers: { 'X-Integration-Secret': 'shared-secret' } })).status, 200);
  });

  it('【測試工具】伺服器提前崩潰時：快速失敗並附上啟動日誌，不會卡死（曾因此導致整組測試逾時）', { timeout: 20000 }, async () => {
    const t0 = Date.now();
    await assert.rejects(startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' }), /server\.js 未能啟動[\s\S]*SUPABASE_URL/);
    assert.ok(Date.now() - t0 < 15000);
    const ok = await startRealServer({}); await ok.stop(); await ok.stop();   // 重複呼叫 stop() 也必須立即返回
  });

  it('【匯出標頭】真實 server 的匯出：Content-Length 等於實際位元組數、筆數標頭與內容一致（Worker 串流與驗證的依據）', async () => {
    const { api, base } = await startSrv(); const slot = await pickSlot(api); await book(api, slot);
    const res = await fetch(base + '/api/integration/export', { headers: { 'X-Integration-Secret': 'shared-secret' } });
    const buf = Buffer.from(await res.arrayBuffer()); const body = JSON.parse(buf.toString('utf8'));
    assert.equal(Number(res.headers.get('content-length')), buf.length); assert.equal(res.headers.get('x-export-format'), 'RONNIE_HEALING_SPACE_BACKUP'); assert.equal(Number(res.headers.get('x-export-bytes')), buf.length, 'X-Export-Bytes 必須等於解壓後的實際位元組數');
    assert.equal(res.headers.get('x-export-counts'), `reservations=${body.data.reservations.length};customers=${body.data.customers.length};closures=${body.data.closures.length}`);
    assert.equal(body.data.reservations.length, 1);
  });

  describe('預約已儲存之後，附加動作（綁定碼／整合任務）失敗：不可影響結果', () => {
    const slotAt = async (api, n) => { const s0 = await pickSlot(api); const av = (await api('GET', `/api/availability?date=${s0.date}&serviceId=chakra`, undefined, { auth: false })).json.available; return { date: s0.date, startTime: av[n * 4] }; };
    const warns = () => (srv.log().match(/\[integration\] .* failed after \d+ attempt\(s\) \(non-fatal\)/g) || []);

    it('綁定碼寫入失敗（連重試也失敗）→ 仍回 201 且預約存在；lineBindCode 為 null；任務照常建立；留下警告', async () => {
      const { api } = await startSrv(); const slot = await slotAt(api, 0);
      m.S.fail.push({ re: /^POST line_bind_tokens/, times: 2 });
      const r = await book(api, slot); assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.lineBindCode, null);
      assert.equal(T().reservations.length, 1); assert.equal(T().integration_jobs.length, 1); assert.equal(warns().length, 1); assert.match(warns()[0], /line bind token/);
    });
    it('整合任務寫入失敗（連重試也失敗）→ 仍回 201、綁定碼正常；留下警告；客人重試不會得到「時段已被預約」的誤導訊息', async () => {
      const { api } = await startSrv(); const slot = await slotAt(api, 1);
      m.S.fail.push({ re: /^POST integration_jobs/, times: 2 });
      const r = await book(api, slot); assert.equal(r.status, 201, JSON.stringify(r.json)); assert.match(r.json.lineBindCode, /^[0-9A-F]{6}$/);
      assert.equal(T().reservations.length, 1); assert.equal(T().integration_jobs.length, 0); assert.match(warns()[0], /enqueue reservation\.created/);
    });
    it('只失敗一次 → 自動重試成功：綁定碼與任務都在，沒有任何警告', async () => {
      const { api } = await startSrv(); const slot = await slotAt(api, 2);
      m.S.fail.push({ re: /^POST line_bind_tokens/, times: 1 }); m.S.fail.push({ re: /^POST integration_jobs/, times: 1 });
      const r = await book(api, slot); assert.equal(r.status, 201); assert.match(r.json.lineBindCode, /^[0-9A-F]{6}$/);
      assert.equal(T().integration_jobs.length, 1); assert.equal(warns().length, 0); assert.equal(T().line_bind_tokens.length, 1);
    });
    it('客人修改 / 取消預約：任務寫入失敗仍回 200，且修改/取消確實生效', async () => {
      const { api } = await startSrv(); const slot = await slotAt(api, 0); const r = await book(api, slot); const id = r.json.reservation.id;
      m.S.fail.push({ re: /^POST integration_jobs/, times: 2 });
      const newSlot = await slotAt(api, 3);
      const u = await api('PATCH', `/api/manage/reservations/${id}/update`, { phone: '0912-345-678', serviceId: 'chakra', date: newSlot.date, startTime: newSlot.startTime }, { auth: false });
      assert.equal(u.status, 200, JSON.stringify(u.json)); assert.equal(u.json.reservation.startTime, newSlot.startTime);
      m.S.fail.push({ re: /^POST integration_jobs/, times: 2 });
      const c = await api('PATCH', `/api/manage/reservations/${id}/cancel`, { phone: '0912-345-678' }, { auth: false });
      assert.equal(c.status, 200, JSON.stringify(c.json)); assert.equal(T().reservations.find(x => x.id === id).status, 'CANCELLED'); assert.equal(warns().length, 2);
    });
  });
});
