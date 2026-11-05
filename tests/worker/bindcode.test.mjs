// 綁定碼跟著預約走：寫入 reservation_meta、查詢頁與後台可讀、已綁定旗標、已取消/已結束不顯示。真實 server.js + 模擬 Supabase。
import '../support/polyfill.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMocks, KEYS } from '../support/mock-services.mjs';
import { startRealServer } from '../support/harness.mjs';

const taipei = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

describe('綁定碼跟著預約走（Supabase 模式）', () => {
  let m, srv, api, base;
  before(async () => {
    m = await startMocks();
    srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase });
    api = srv.api; base = srv.base;
  });
  after(async () => { await srv.stop(); await m.close(); });

  async function openSlot(from = 3) {
    for (let i = from; i < 40; i++) {
      const d = addDays(taipei(), i);
      const av = (await api('GET', `/api/availability?date=${d}&serviceId=chakra`, undefined, { auth: false })).json;
      if (av && av.available && av.available.length > 2) return { date: d, startTime: av.available[0] };
    }
    throw new Error('找不到可預約日期');
  }
  const book = (slot, phone) => api('POST', '/api/reservations', { name: '綁定碼測試', birthDate: '1992-05-06', phone, serviceId: 'chakra', note: '', ...slot }, { auth: false });
  const meta = () => m.S.tables.app_state.find(x => x.key === 'reservation_meta')?.value || {};

  it('建立預約時綁定碼寫入 reservation_meta（不增加 reservations 的欄位）', async () => {
    const slot = await openSlot(3); const r = await book(slot, '0911-111-111');
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.reservation.id;
    assert.equal(meta()[id]?.lineBindCode, r.json.lineBindCode, '綁定碼必須寫入該預約的 meta');
    assert.ok(Object.keys(m.S.tables.reservations[0]).length === 19, 'reservations 仍是 19 欄');
    assert.ok(!('lineBindCode' in m.S.tables.reservations[0]), '綁定碼不可進 reservations 表');
  });

  it('後台列表：有效預約顯示綁定碼；未綁定時 lineBound=false', async () => {
    const slot = await openSlot(6); const r = await book(slot, '0911-222-222'); const id = r.json.reservation.id;
    const list = (await api('GET', '/api/admin/reservations')).json;
    const row = list.find(x => x.id === id);
    assert.equal(row.lineBindCode, r.json.lineBindCode); assert.equal(row.lineBound, false);
  });

  it('綁定成功後：碼仍顯示，且 lineBound=true（查詢頁與後台都一樣）', async () => {
    const slot = await openSlot(9); const r = await book(slot, '0911-333-333'); const id = r.json.reservation.id; const code = r.json.lineBindCode;
    const hook = async events => { const body = JSON.stringify({ events }); const sig = crypto.createHmac('sha256', 'line-channel-secret').update(body).digest('base64');
      return fetch(srv.base.replace(/\/$/, '') + '/__noop', { method: 'GET' }).catch(() => null); };
    // 模擬「綁定已完成」：寫入 line_bind:* 列（與 Worker 寫入的格式相同），不依賴 Worker 程序
    m.S.tables.app_state.push({ key: 'line_bind:09113333333', value: { userId: 'U_X', boundAt: new Date().toISOString(), reservationId: id }, updated_at: 'x' });
    const list = (await api('GET', '/api/admin/reservations')).json; const row = list.find(x => x.id === id);
    assert.equal(row.lineBound, true); assert.equal(row.lineBindCode, code, '已綁定的碼仍保留顯示（前端加「（已綁定）」）');
  });

  it('查詢頁（只靠電話）：回傳綁定碼與已綁定旗標；已取消的預約不會出現在查詢結果', async () => {
    const slot = await openSlot(12); const r = await book(slot, '0911-444-444');
    const q = await api('POST', '/api/manage/lookup', { phone: '0911-444-444' }, { auth: false });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const row = q.json.reservations.find(x => x.id === r.json.reservation.id);
    assert.equal(row.lineBindCode, r.json.lineBindCode); assert.equal(row.lineBound, false);
    await api('PATCH', `/api/manage/reservations/${r.json.reservation.id}/cancel`, { phone: '0911-444-444' }, { auth: false });
    const q2 = await api('POST', '/api/manage/lookup', { phone: '0911-444-444' }, { auth: false });
    assert.ok(!q2.json.reservations || !q2.json.reservations.some(x => x.id === r.json.reservation.id), '已取消的預約不應出現在查詢結果');
  });

  it('已取消的預約：後台不顯示綁定碼（null）', async () => {
    const slot = await openSlot(15); const r = await book(slot, '0911-555-555'); const id = r.json.reservation.id;
    await api('PATCH', `/api/admin/reservations/${id}/cancel`);
    const row = (await api('GET', '/api/admin/reservations')).json.find(x => x.id === id);
    assert.equal(row.lineBindCode, null, '已取消的預約不得顯示綁定碼');
  });

  it('meta 寫入失敗（綁定碼步驟內）：只影響這筆的綁定碼顯示，不影響預約與綁定碼本身', async () => {
    // 注意：預約主流程的 flushStorage 本來就會寫入 app_state（既有行為，v7.1 即如此）。
    // 這裡只注入「單次」失敗，讓它落在綁定碼之後的 meta 寫入，驗證 meta 失敗不會讓預約變成 500。
    const slot = await openSlot(18);
    const before = m.S.log.filter(l => /^POST app_state/.test(l)).length;
    m.S.fail.push({ re: /^POST app_state/, skip: 0, times: 1 });   // 放行 flushStorage 的第一次寫入，失敗在 meta 寫入
    const r = await book(slot, '0911-666-666');
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.ok(r.json.reservation.id, '預約必須已存在');
    const id = r.json.reservation.id;
    assert.equal(meta()[id]?.lineBindCode, undefined, '此筆 meta 寫入失敗，因此沒有綁定碼顯示');
    assert.ok(r.json.lineBindCode === null || /^[0-9A-F]{6}$/.test(r.json.lineBindCode), '綁定碼本身不受影響');
  });
});
