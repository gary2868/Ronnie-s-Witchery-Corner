// 已綁定的顯示：查詢頁／後台回傳 lineBound=true 且碼仍保留（前端再加「（已綁定）」）。真實 server.js + 模擬 Supabase。
import '../support/polyfill.mjs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMocks, KEYS } from '../support/mock-services.mjs';
import { startRealServer } from '../support/harness.mjs';

const taipei = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

describe('已綁定的顯示（同一程序持有模擬服務，可直接寫入綁定紀錄）', () => {
  let m, srv, api;
  before(async () => {
    m = await startMocks();
    srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase });
    api = srv.api;
  });
  after(async () => { await srv.stop(); await m.close(); });

  it('查詢頁：綁定完成後，碼仍保留且 lineBound=true；未綁定的同電話預約則為 false', async () => {
    let slot = null;
    for (let i = 3; i < 40 && !slot; i++) {
      const d = addDays(taipei(), i);
      const av = (await api('GET', `/api/availability?date=${d}&serviceId=chakra`, undefined, { auth: false })).json;
      if (av?.available?.length > 3) slot = { date: d, startTime: av.available[0] };
    }
    const phone = '0911-880-001';
    const r = await api('POST', '/api/reservations', { name: '已綁定測試', birthDate: '1992-05-06', phone, serviceId: 'chakra', note: '', ...slot }, { auth: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.reservation.id, code = r.json.lineBindCode;
    assert.match(code, /^[0-9A-F]{6}$/);

    let q = await api('POST', '/api/manage/lookup', { phone, bookingCode: r.json.reservation.bookingCode }, { auth: false });
    assert.equal(q.json.reservations[0].lineBound, false); assert.equal(q.json.reservations[0].lineBindCode, code);

    // 模擬 Worker 完成綁定：寫入 line_bind:* 列（與 Worker 寫入格式相同）
    m.S.tables.app_state.push({ key: 'line_bind:' + phone.replace(/\D/g, ''), value: { userId: 'U_BOUND', boundAt: new Date().toISOString(), reservationId: id, eventId: 'EV1' }, updated_at: 'x' });

    q = await api('POST', '/api/manage/lookup', { phone, bookingCode: r.json.reservation.bookingCode }, { auth: false });
    const row = q.json.reservations.find(x => x.id === id);
    assert.equal(row.lineBound, true, '綁定完成後必須標示已綁定');
    assert.equal(row.lineBindCode, code, '已綁定的碼仍保留（前端加「（已綁定）」）');

    const admin = (await api('GET', '/api/admin/reservations')).json.find(x => x.id === id);
    assert.equal(admin.lineBound, true); assert.equal(admin.lineBindCode, code);
  });
});
