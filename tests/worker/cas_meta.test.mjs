// 中繼資料 CAS：外部 writer 競爭、衝突重試、RPC 失敗、綁定碼衝突
import '../support/polyfill.mjs';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMocks, KEYS } from '../support/mock-services.mjs';
import { startRealServer } from '../support/harness.mjs';

const taipei = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const CAS = 'POST rpc/cas_reservation_meta';

describe('中繼資料 CAS：外部 writer 競爭', () => {
  let m, srv, api;
  before(async () => { m = await startMocks(); });
  after(async () => { await m.close(); });
  beforeEach(async () => { m.reset(); srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase }); api = srv.api; });
  afterEach(async () => { m.S.onRequest = null; m.S.fail = []; await srv.stop(); srv = null; });

  async function openSlot(from) {
    for (let i = from; i < 60; i++) {
      const d = addDays(taipei(), i);
      const av = (await api('GET', `/api/availability?date=${d}&serviceId=chakra`, undefined, { auth: false })).json;
      if (av?.available?.length > 3) return { date: d, startTime: av.available[0] };
    }
    throw new Error('找不到可預約日期');
  }
  const body = (slot, name) => ({ name, birthDate: '1990-01-01', phone: `0911-${slot.date.slice(-2)}-${name.length}00`, serviceId: 'chakra', note: '', ...slot });
  const meta = () => (m.S.tables.app_state.find(r => r.key === 'reservation_meta') || {}).value || {};
  const casCount = () => m.S.log.filter(l => l === CAS).length;
  // 只在第一次 CAS 之前注入外部修改
  const injectOnce = (entryId, entry) => { let fired = false; m.S.onRequest = (method, table) => {
    if (!fired && method === 'POST' && table === 'rpc/cas_reservation_meta') {
      fired = true;
      let row = m.S.tables.app_state.find(r => r.key === 'reservation_meta');
      if (!row) { row = { key: 'reservation_meta', value: {}, updated_at: new Date().toISOString() }; m.S.tables.app_state.push(row); }   // 列不存在時先建立，外部 writer 才有修改目標
      row.value = { ...row.value, [entryId]: entry };
    } }; };
  // 每次 CAS 之前都注入（模擬持續衝突）
  const injectAlways = () => { let n = 0; m.S.onRequest = (method, table) => {
    if (method === 'POST' && table === 'rpc/cas_reservation_meta') {
      n++;
      const row = m.S.tables.app_state.find(r => r.key === 'reservation_meta');
      if (row) row.value = { ...row.value, [`EXT${n}`]: { myNote: `external ${n}` } };
    } }; };

  it('外部 writer 在 CAS 前新增他人的備註 → 衝突後合併重試，兩邊的修改都保留', async () => {
    const slot = await openSlot(3);
    const r = await api('POST', '/api/reservations', body(slot, '甲客人'), { auth: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.reservation.id;
    injectOnce('R_EXT', { myNote: 'external' });
    const before = casCount();
    const p = await api('PATCH', `/api/admin/reservations/${id}/status`, { statusLabel: 'Finished', otherStatus: '' });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.ok(casCount() - before >= 2, '第一次 CAS 應衝突，之後重試');
    assert.equal(meta()[id].statusLabel, 'Finished', '本地的狀態變更必須寫入');
    assert.equal(meta().R_EXT.myNote, 'external', '外部 writer 的修改不得被覆寫');
  });

  it('外部 writer 的修改不影響本次未變動的預約', async () => {
    const slot = await openSlot(10);
    const r = await api('POST', '/api/reservations', body(slot, '乙客人'), { auth: false });
    const id = r.json.reservation.id;
    const code = r.json.lineBindCode;
    m.S.tables.app_state.find(r => r.key === 'reservation_meta').value[id].myNote = 'EXTERNAL NOTE';
    const p = await api('PATCH', `/api/admin/reservations/${id}/tags`, { tags: ['vip'] });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(meta()[id].myNote, 'EXTERNAL NOTE', '本次只改標籤，外部備註必須保留');
    assert.deepEqual(meta()[id].tags, ['vip']);
    assert.equal(meta()[id].lineBindCode, code, '綁定碼必須保留');
  });

  it('持續衝突（3 次重試仍失敗）→ 回 5xx，中繼資料不被寫入', async () => {
    const slot = await openSlot(16);
    const r = await api('POST', '/api/reservations', body(slot, '丙客人'), { auth: false });
    const id = r.json.reservation.id;
    injectAlways();
    const before = casCount();
    const p = await api('PATCH', `/api/admin/reservations/${id}/status`, { statusLabel: 'Finished', otherStatus: '' });
    assert.ok(p.status >= 500, `應為 5xx，實際 ${p.status}`);
    assert.equal(casCount() - before, 3, '應只重試到 3 次');
    assert.notEqual(meta()[id]?.statusLabel, 'Finished', '衝突未解決時不得寫入本地變動');
  });

  it('CAS RPC 錯誤（網路/5xx）不重試，直接回錯誤', async () => {
    const slot = await openSlot(22);
    const r = await api('POST', '/api/reservations', body(slot, '丁客人'), { auth: false });
    const id = r.json.reservation.id;
    m.S.fail.push({ re: /^POST rpc\/cas_reservation_meta/, times: 99 });
    const before = casCount();
    const p = await api('PATCH', `/api/admin/reservations/${id}/status`, { statusLabel: 'Finished', otherStatus: '' });
    assert.ok(p.status >= 500, `應為 5xx，實際 ${p.status}`);
    assert.equal(casCount() - before, 1, 'RPC 錯誤不應重試');
  });

  it('綁定碼寫入遇到外部衝突 → 重試後綁定碼與外部修改都保留', async () => {
    const slot = await openSlot(28);
    injectOnce('R_EXT2', { myNote: 'external2' });
    const r = await api('POST', '/api/reservations', body(slot, '戊客人'), { auth: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.reservation.id;
    assert.ok(r.json.lineBindCode, '應回傳綁定碼');
    assert.equal(meta()[id].lineBindCode, r.json.lineBindCode, '綁定碼必須寫入中繼資料');
    assert.equal(meta().R_EXT2.myNote, 'external2', '外部修改必須保留');
  });
});
