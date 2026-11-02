// 管理端：新增預約／客人、軟刪除（資源回收桶）、還原、雙向同步。使用「真實 server.js」。
import '../support/polyfill.mjs';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMocks, KEYS } from '../support/mock-services.mjs';
import { startRealServer } from '../support/harness.mjs';
import * as W from '../../worker/index.js';

const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const BIRTH = '1990-01-01';

async function openSlot(api, from = 3) {           // 找一個未來、可預約且有餘裕的日期與開始時間
  for (let i = from; i < 40; i++) {
    const d = addDays(taipeiToday(), i);
    const av = (await api('GET', `/api/availability?date=${d}&serviceId=chakra`, undefined, { auth: false })).json;
    if (av && av.available && av.available.length > 6) return { date: d, slots: av.available };
  }
  throw new Error('找不到可預約日期');
}
const mkCustomer = async (api, name, phone = '0912345678') => (await api('POST', '/api/admin/customers', { name, birthDate: BIRTH, phone })).json.customer;
const addRes = (api, customerId, date, startTime, extra = {}) => api('POST', '/api/admin/reservations', { customerId, serviceId: 'chakra', date, startTime, ...extra });
async function addPast(api, customerId) {          // 管理員補登過去的預約（過去日期不受「客人自助預約」限制）
  for (let back = 1; back < 21; back++) for (const st of ['10:00', '11:00', '14:00', '15:00', '09:00']) {
    const r = await addRes(api, customerId, addDays(taipeiToday(), -back), st);
    if (r.status === 201) return r.json.reservation;
  }
  throw new Error('找不到可補登的過去時段');
}
const reservations = async api => (await api('GET', '/api/admin/reservations')).json;
const customers = async api => (await api('GET', '/api/admin/customers')).json;
const bin = async api => (await api('GET', '/api/admin/recycle-bin')).json;
/** 不變式：客人歷史中的每一筆都必須對應到一筆實際存在的預約（沒有孤兒），且回收桶中的預約不在正式資料裡 */
async function assertConsistent(api, label = '') {
  const ids = new Set((await reservations(api)).map(r => r.id));
  for (const c of await customers(api)) for (const h of c.history || []) assert.ok(ids.has(h.reservationId), `${label} 孤兒歷史：${c.name} → ${h.reservationId}`);
  for (const e of await bin(api)) if (e.type === 'reservation') assert.ok(!ids.has(e.summary.id), `${label} 回收桶項目仍存在於正式資料：${e.summary.id}`);
}

describe('管理端新增／軟刪除／還原（本機模式，真實 server.js）', () => {
  let srv, api;
  before(async () => { srv = await startRealServer({}); api = srv.api; });
  after(async () => { await srv.stop(); });

  it('驗證保護：所有新端點未登入一律 401', async () => {
    const no = (m, p, b) => api(m, p, b, { auth: false });
    for (const [m, p, b] of [['POST', '/api/admin/reservations', {}], ['DELETE', '/api/admin/reservations/x'], ['POST', '/api/admin/customers', {}], ['DELETE', '/api/admin/customers/x'],
      ['DELETE', '/api/admin/customers/x/history/y'], ['GET', '/api/admin/recycle-bin'], ['POST', '/api/admin/recycle-bin/x/restore', {}], ['DELETE', '/api/admin/recycle-bin/x']]) {
      assert.equal((await no(m, p, b)).status, 401, `${m} ${p}`);
    }
  });

  it('新增客人：欄位驗證、重複（姓名＋生日）會被擋下並指出既有客人', async () => {
    assert.equal((await api('POST', '/api/admin/customers', { birthDate: BIRTH, phone: '0912345678' })).status, 400);
    assert.equal((await api('POST', '/api/admin/customers', { name: '甲', birthDate: 'abc', phone: '0912345678' })).status, 400);
    assert.equal((await api('POST', '/api/admin/customers', { name: '甲', birthDate: BIRTH, phone: '12' })).status, 400);
    const ok = await api('POST', '/api/admin/customers', { name: '新增客人甲', birthDate: BIRTH, phone: '0912-345-678', lineId: 'jia' });
    assert.equal(ok.status, 201); assert.deepEqual(ok.json.customer.history, []);
    const dup = await api('POST', '/api/admin/customers', { name: '新增客人甲', birthDate: BIRTH, phone: '0999999999' });
    assert.equal(dup.status, 409); assert.equal(dup.json.code, 'DUPLICATE'); assert.equal(dup.json.customerId, ok.json.customer.id);
    assert.ok((await customers(api)).some(c => c.id === ok.json.customer.id));
  });

  it('新增預約：成功會寫入客人歷史；公休、時段衝突、營業時間外照一般規則擋下；當日與過去日期管理員可補登', async () => {
    const c = await mkCustomer(api, '新增預約乙'); const { date, slots } = await openSlot(api);
    assert.equal((await addRes(api, 'no-such', date, slots[0])).status, 404);
    assert.equal((await api('POST', '/api/admin/reservations', { customerId: c.id, serviceId: 'nope', date, startTime: slots[0] })).status, 400);
    const ok = await addRes(api, c.id, date, slots[0]); assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.reservation.status, 'CONFIRMED'); assert.equal(ok.json.reservation.customerId, c.id);
    assert.ok((await customers(api)).find(x => x.id === c.id).history.some(h => h.reservationId === ok.json.reservation.id));
    const clash = await addRes(api, c.id, date, slots[0]); assert.equal(clash.status, 409); assert.equal(clash.json.code, 'CONFLICT');
    assert.equal((await addRes(api, c.id, date, '03:00')).status, 400);
    const d2 = (await openSlot(api, 9)); assert.equal((await api('POST', '/api/admin/closures', { date: d2.date })).status, 201);
    const closed = await addRes(api, c.id, d2.date, d2.slots[0]); assert.equal(closed.status, 400); assert.equal(closed.json.code, 'CLOSED');
    const past = await addPast(api, c.id); assert.ok(past.date < taipeiToday());
    await assertConsistent(api, '新增後');
  });

  it('刪除預約：仍有效且未結束 → 擋下；取消後可刪；預約與客人歷史同步消失；還原後（含備註）一起回來', async () => {
    const c = await mkCustomer(api, '刪除預約丙'); const { date, slots } = await openSlot(api, 5);
    const r = (await addRes(api, c.id, date, slots[0])).json.reservation;
    const blocked = await api('DELETE', `/api/admin/reservations/${r.id}`); assert.equal(blocked.status, 409); assert.equal(blocked.json.code, 'ACTIVE_FUTURE');
    assert.ok((await reservations(api)).some(x => x.id === r.id), '被擋下時預約必須完好');
    assert.equal((await api('PATCH', `/api/admin/reservations/${r.id}/note`, { myNote: '我的備註X' })).status, 200);
    assert.equal((await api('PATCH', `/api/admin/reservations/${r.id}/cancel`)).status, 200);
    const del = await api('DELETE', `/api/admin/reservations/${r.id}`); assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.ok(!(await reservations(api)).some(x => x.id === r.id)); assert.ok(!(await customers(api)).find(x => x.id === c.id).history.some(h => h.reservationId === r.id));
    const entry = (await bin(api)).find(e => e.id === del.json.binId); assert.equal(entry.type, 'reservation'); assert.equal(entry.summary.date, date);
    await assertConsistent(api, '刪除後');
    const back = await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {}); assert.equal(back.status, 200, JSON.stringify(back.json));
    const restored = (await reservations(api)).find(x => x.id === r.id); assert.ok(restored); assert.equal(restored.status, 'CANCELLED'); assert.equal(restored.myNote, '我的備註X');
    assert.ok((await customers(api)).find(x => x.id === c.id).history.some(h => h.reservationId === r.id), '還原後客人歷史也要回來');
    assert.equal((await bin(api)).filter(e => e.id === del.json.binId).length, 0);
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 404, '同一個項目不能還原兩次');
    await assertConsistent(api, '還原後');
  });

  it('已結束（過去）的有效預約可直接刪除與還原', async () => {
    const c = await mkCustomer(api, '過去預約丁'); const p = await addPast(api, c.id);
    const del = await api('DELETE', `/api/admin/reservations/${p.id}`); assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 200);
    assert.ok((await reservations(api)).some(x => x.id === p.id)); await assertConsistent(api);
  });

  it('從客人檔案刪除某筆歷史 = 刪除該預約（反向同步）；不屬於該客人的歷史會被拒絕', async () => {
    const a = await mkCustomer(api, '歷史戊'), b = await mkCustomer(api, '歷史己'); const p = await addPast(api, a.id);
    assert.equal((await api('DELETE', `/api/admin/customers/${b.id}/history/${p.id}`)).status, 404);
    assert.ok((await reservations(api)).some(x => x.id === p.id), '被拒絕時不得動到預約');
    assert.equal((await api('DELETE', `/api/admin/customers/${a.id}/history/${p.id}`)).status, 200);
    assert.ok(!(await reservations(api)).some(x => x.id === p.id)); await assertConsistent(api, '反向刪除後');
  });

  it('刪除客人：還有有效且未結束的預約 → 禁止並列出；處理後刪除會連同其預約一起進回收桶；還原會全部回來', async () => {
    const c = await mkCustomer(api, '客人庚'); const { date, slots } = await openSlot(api, 12);
    const future = (await addRes(api, c.id, date, slots[0])).json.reservation; const past = await addPast(api, c.id);
    const refuse = await api('DELETE', `/api/admin/customers/${c.id}`); assert.equal(refuse.status, 409); assert.equal(refuse.json.code, 'HAS_ACTIVE_FUTURE');
    assert.deepEqual(refuse.json.reservations.map(r => r.id), [future.id]);
    assert.ok((await customers(api)).some(x => x.id === c.id), '被擋下時客人必須完好');
    await api('PATCH', `/api/admin/reservations/${future.id}/cancel`);
    const del = await api('DELETE', `/api/admin/customers/${c.id}`); assert.equal(del.status, 200, JSON.stringify(del.json)); assert.equal(del.json.reservationsDeleted, 2);
    const ids = (await reservations(api)).map(r => r.id); assert.ok(!ids.includes(future.id) && !ids.includes(past.id)); assert.ok(!(await customers(api)).some(x => x.id === c.id));
    const entry = (await bin(api)).find(e => e.id === del.json.binId); assert.equal(entry.type, 'customer'); assert.equal(entry.summary.reservationCount, 2);
    await assertConsistent(api, '刪客人後');
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 200);
    const ids2 = (await reservations(api)).map(r => r.id); assert.ok(ids2.includes(future.id) && ids2.includes(past.id));
    assert.equal((await customers(api)).filter(x => x.name === '客人庚').length, 1); await assertConsistent(api, '還原客人後');
  });

  it('還原客人時，若同一位客人已被重新建立（例如又預約了）→ 合併，不會產生重複檔案', async () => {
    const c = await mkCustomer(api, '客人辛'); const p = await addPast(api, c.id);
    const del = await api('DELETE', `/api/admin/customers/${c.id}`); assert.equal(del.status, 200);
    const again = await mkCustomer(api, '客人辛');                              // 同姓名＋生日：因為回收桶已有，管理端新增會被擋
    assert.equal(again, undefined, '回收桶中有同一位客人時，新增客人必須被擋下');
    const dup = await api('POST', '/api/admin/customers', { name: '客人辛', birthDate: BIRTH, phone: '0912345678' });
    assert.equal(dup.status, 409); assert.equal(dup.json.code, 'IN_RECYCLE_BIN'); assert.equal(dup.json.binId, del.json.binId);
    const { date, slots } = await openSlot(api, 15);                              // 客人自己用公開頁面又預約 → 會建立新的客人檔案
    const pub = await api('POST', '/api/reservations', { name: '客人辛', birthDate: BIRTH, phone: '0912345678', serviceId: 'chakra', date, startTime: slots[0] }, { auth: false });
    assert.equal(pub.status, 201, JSON.stringify(pub.json));
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 200);
    assert.equal((await customers(api)).filter(x => x.name === '客人辛').length, 1, '合併成同一位客人'); assert.ok((await reservations(api)).some(x => x.id === p.id)); await assertConsistent(api, '合併後');
  });

  it('永久移除：從回收桶刪除後無法再還原；其他項目不受影響', async () => {
    const c = await mkCustomer(api, '客人壬'); const p1 = await addPast(api, c.id); const p2 = await addPast(api, c.id);
    const d1 = (await api('DELETE', `/api/admin/reservations/${p1.id}`)).json, d2 = (await api('DELETE', `/api/admin/reservations/${p2.id}`)).json;
    assert.equal((await api('DELETE', `/api/admin/recycle-bin/${d1.binId}`)).status, 200);
    assert.equal((await api('POST', `/api/admin/recycle-bin/${d1.binId}/restore`, {})).status, 404); assert.equal((await api('DELETE', `/api/admin/recycle-bin/${d1.binId}`)).status, 404);
    assert.equal((await api('POST', `/api/admin/recycle-bin/${d2.binId}/restore`, {})).status, 200); await assertConsistent(api);
  });

  it('已被刪除的預約，客人用「管理預約」頁面查不到（等同不存在）', async () => {
    const c = await mkCustomer(api, '客人癸', '0922333444'); const p = await addPast(api, c.id);
    await api('DELETE', `/api/admin/reservations/${p.id}`);
    const gone = await api('PATCH', `/api/manage/reservations/${p.id}/cancel`, { phone: '0922333444' }, { auth: false });
    const never = await api('PATCH', `/api/manage/reservations/00000000-0000-0000-0000-000000000000/cancel`, { phone: '0922333444' }, { auth: false });
    assert.equal(gone.status, never.status, '已刪除的預約，回應必須與「根本不存在」完全一樣（不洩漏任何資訊）'); assert.notEqual(gone.status, 200);
    assert.deepEqual(gone.json, never.json);
  });
});

describe('Supabase 模式：持久化、失敗保護、日曆事件移除', () => {
  let m, srv, api;
  before(async () => { m = await startMocks(); });
  after(async () => { await m.close(); });
  beforeEach(async () => { m.reset(); srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase }); api = srv.api; });
  afterEach(async () => { if (srv) await srv.stop(); srv = null; });
  const T = () => m.S.tables;
  const binRow = () => T().app_state.find(x => x.key === 'recycle_bin');

  it('刪除：Supabase 的預約列消失、客人歷史更新、回收桶寫入 app_state；伺服器重啟後仍然一致，且可還原', async () => {
    const c = await mkCustomer(api, 'SB客人'); const p = await addPast(api, c.id);
    assert.equal(T().reservations.length, 1);
    const del = await api('DELETE', `/api/admin/reservations/${p.id}`); assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal(T().reservations.length, 0); assert.equal(binRow().value.items.length, 1); assert.equal(binRow().value.items[0].reservation.id, p.id);
    assert.equal(T().customers.find(x => x.id === c.id).history.length, 0);
    await srv.stop(); srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase }); api = srv.api;   // 全新部署：本機資料清空，只靠 Supabase
    assert.equal((await reservations(api)).length, 0); assert.equal((await bin(api)).length, 1);
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 200);
    assert.equal(T().reservations.length, 1); assert.equal(T().customers.find(x => x.id === c.id).history.length, 1); assert.equal(binRow().value.items.length, 0);
  });

  it('寫入回收桶失敗 → 回 500，預約與客人歷史完全不動（先進回收桶、後刪除的順序保護）', async () => {
    const c = await mkCustomer(api, 'SB保護'); const p = await addPast(api, c.id);
    m.S.fail.push({ re: /^POST app_state/, times: 1 });
    const del = await api('DELETE', `/api/admin/reservations/${p.id}`); assert.equal(del.status, 500);
    assert.equal(T().reservations.length, 1); assert.equal(T().customers.find(x => x.id === c.id).history.length, 1); assert.ok(!binRow() || binRow().value.items.length === 0);
    assert.equal((await api('DELETE', `/api/admin/reservations/${p.id}`)).status, 200, '故障排除後可再次刪除');
  });

  it('讀取回收桶失敗 → 回 500，什麼都不動', async () => {
    const c = await mkCustomer(api, 'SB讀取'); const p = await addPast(api, c.id);
    m.S.fail.push({ re: /^GET app_state/, times: 1 });
    assert.equal((await api('DELETE', `/api/admin/reservations/${p.id}`)).status, 500); assert.equal(T().reservations.length, 1);
  });

  it('還原到一半寫回收桶失敗：預約已回到正式資料、項目仍在回收桶 → 再次還原回 409（不會產生重複預約），列表標示 alreadyLive，可永久移除', async () => {
    const c = await mkCustomer(api, 'SB半途'); const p1 = await addPast(api, c.id); const p2 = await addPast(api, c.id);
    const e1 = (await api('DELETE', `/api/admin/reservations/${p1.id}`)).json.binId, e2 = (await api('DELETE', `/api/admin/reservations/${p2.id}`)).json.binId;
    const upserts = () => m.S.log.filter(l => /^POST app_state/.test(l)).length;
    const before = upserts(); assert.equal((await api('POST', `/api/admin/recycle-bin/${e1}/restore`, {})).status, 200); const k = upserts() - before;   // 一次還原會對 app_state 寫入 k 次（最後一次是回收桶）
    m.S.fail.push({ re: /^POST app_state/, skip: k - 1, times: 1 });
    assert.equal((await api('POST', `/api/admin/recycle-bin/${e2}/restore`, {})).status, 500, '寫回收桶失敗 → 回 500');
    assert.equal(T().reservations.filter(r => r.id === p2.id).length, 1, '預約已經回到正式資料');
    assert.ok((await bin(api)).find(e => e.id === e2).alreadyLive, '項目仍在回收桶，並標示 alreadyLive');
    const again = await api('POST', `/api/admin/recycle-bin/${e2}/restore`, {}); assert.equal(again.status, 409); assert.equal(again.json.code, 'ALREADY_EXISTS');
    assert.equal(T().reservations.filter(r => r.id === p2.id).length, 1, '不可產生重複預約');
    assert.equal((await api('DELETE', `/api/admin/recycle-bin/${e2}`)).status, 200); assert.equal((await bin(api)).length, 0);
  });

  it('刪除客人：Supabase 的客人列與其預約列一起消失；還原後一起回來', async () => {
    const c = await mkCustomer(api, 'SB刪客人'); await addPast(api, c.id); await addPast(api, c.id);
    assert.equal(T().reservations.length, 2);
    const del = await api('DELETE', `/api/admin/customers/${c.id}`); assert.equal(del.status, 200);
    assert.equal(T().reservations.length, 0); assert.ok(!T().customers.some(x => x.id === c.id)); assert.equal(binRow().value.items[0].reservations.length, 2);
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 200);
    assert.equal(T().reservations.length, 2); assert.equal(T().customers.find(x => x.id === c.id).history.length, 2);
  });

  it('端對端：預約 → Worker 建立日曆事件 → 管理員取消並刪除 → Worker 對帳移除事件；還原後事件回來', async () => {
    const env = m.env({ FEATURE_CALENDAR: 'on' }); const deps = () => W.makeDeps();
    const { date, slots } = await openSlot(api); const c = await mkCustomer(api, 'SB日曆');
    const r = (await addRes(api, c.id, date, slots[0])).json.reservation;
    await W.reconcileCalendar(env, deps()); assert.equal(m.S.google.events.size, 1);
    await api('PATCH', `/api/admin/reservations/${r.id}/cancel`); const del = await api('DELETE', `/api/admin/reservations/${r.id}`); assert.equal(del.status, 200);
    await W.reconcileCalendar(env, deps()); assert.equal(m.S.google.events.size, 0, '刪除後日曆事件必須消失');
    assert.equal((await api('POST', `/api/admin/recycle-bin/${del.json.binId}/restore`, {})).status, 200);
    await W.reconcileCalendar(env, deps()); assert.equal(m.S.google.events.size, 0, '還原的是「已取消」預約，不應出現在日曆');
  });
});
