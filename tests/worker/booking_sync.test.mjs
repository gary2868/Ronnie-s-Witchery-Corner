// 短期修法：預約主流程的 Supabase 同步失敗 → 503 + 明確訊息（不是 500）。真實 server.js + 模擬 Supabase。
import '../support/polyfill.mjs';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMocks, KEYS } from '../support/mock-services.mjs';
import { startRealServer } from '../support/harness.mjs';

const taipei = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

describe('預約同步失敗 → 503（短期修法）', () => {
  let m, srv, api;
  before(async () => { m = await startMocks(); });
  after(async () => { await m.close(); });
  beforeEach(async () => { m.reset(); srv = await startRealServer({ STORAGE_MODE: 'supabase', SUPABASE_URL: m.base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase }); api = srv.api; });
  afterEach(async () => { await srv.stop(); srv = null; });

  async function openSlot(from = 3) {
    for (let i = from; i < 40; i++) {
      const d = addDays(taipei(), i);
      const av = (await api('GET', `/api/availability?date=${d}&serviceId=chakra`, undefined, { auth: false })).json;
      if (av?.available?.length > 3) return { date: d, startTime: av.available[0] };
    }
    throw new Error('找不到可預約日期');
  }
  const body = slot => ({ name: '同步失敗測試', birthDate: '1992-05-06', phone: '0911-600-001', serviceId: 'chakra', note: '', ...slot });

  it('Supabase 寫入失敗 → 回 503（不是 500），訊息說明預約未確認，並提示重試', async () => {
    const slot = await openSlot(3);
    m.S.fail.push({ re: /^POST app_state/, times: 99 });   // 讓 flushStorage 持續失敗
    const r = await api('POST', '/api/reservations', body(slot), { auth: false });
    assert.equal(r.status, 503, `應為 503，實際 ${r.status}：${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'SYNC_FAILED');
    assert.match(r.json.error, /無法確認您的預約/);
    assert.match(r.json.error, /請稍後再試/);
    assert.match(r.json.error, /此時段已被預約.*聯絡店家/, '必須提醒客人重試時的衝突可能代表已成立');
  });

  it('故障排除後，客人重試可成功（同步補上）', async () => {
    const slot = await openSlot(6);
    m.S.fail.push({ re: /^POST app_state/, times: 99 });
    const first = await api('POST', '/api/reservations', body(slot), { auth: false });
    assert.equal(first.status, 503);
    m.S.fail = [];                                          // 故障恢復
    const retry = await api('POST', '/api/reservations', body(slot), { auth: false });
    // 本機檔案可能已有第一次寫入的預約 → 重試會被擋成「時段已被占用」（409），這是預期行為，不是錯誤
    assert.ok([201, 409].includes(retry.status), `重試應為 201 或 409（已占用），實際 ${retry.status}`);
    if (retry.status === 409) {
      assert.match(retry.json.error, /已被其他使用者預約/, '409 代表第一次其實已成立，訊息需可理解');
    }
  });

  it('同步正常時行為不變（201）', async () => {
    const slot = await openSlot(9);
    const r = await api('POST', '/api/reservations', body(slot), { auth: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });

  it('客人表寫入失敗（與預約表並行同步）→ 回 503；且預約表不因此回滾失敗、不建立整合任務', async () => {
    const slot = await openSlot(12);
    m.S.fail.push({ re: /^POST customers/, times: 1 });   // 只讓客人表的第一次寫入失敗（回滾用的寫入會成功）
    const r = await api('POST', '/api/reservations', body(slot), { auth: false });
    assert.equal(r.status, 503, `應為 503，實際 ${r.status}：${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'SYNC_FAILED');
    assert.equal(m.S.tables.integration_jobs.length, 0, '同步失敗時不可建立整合任務（否則 Worker 會處理遠端不存在的預約）');
  });

  it('預約表寫入失敗 → 回 503，且不建立整合任務（任務必須在預約真正寫入遠端之後才建立）', async () => {
    const slot = await openSlot(15);
    m.S.fail.push({ re: /^POST reservations/, times: 1 });
    const r = await api('POST', '/api/reservations', body(slot), { auth: false });
    assert.equal(r.status, 503, `應為 503，實際 ${r.status}：${JSON.stringify(r.json)}`);
    assert.equal(m.S.tables.integration_jobs.length, 0);
    assert.equal(m.S.tables.line_bind_tokens.length, 0, '同步失敗時不可產生綁定碼');
  });
});
