#!/usr/bin/env node
/**
 * 上線前資料表檢查（Preflight）
 *
 * 目的：在啟用任何功能前，確認你「真實的」Supabase 資料表符合 Worker 的假設。
 *
 * 用法：
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node worker/preflight.mjs
 *       → 唯讀模式（預設）：只用 SELECT 檢查欄位是否存在。**不會**驗證約束與寫入行為（這些會顯示為「略過」）。
 *   ... node worker/preflight.mjs --write-test
 *       → 另做「寫入往返測試」：對 integration_jobs / line_bind_tokens / app_state 各新增帶 preflight 標記的測試列，
 *         驗證狀態值、唯一約束、upsert、綁定碼「原子領取」查詢，最後一定清除（含中途出錯）。
 *
 * 每一項結果分為：✅ 通過　❌ 失敗　⏭️ 略過（尚未驗證）
 * 結束碼：0 = 全部執行且通過；1 = 有失敗；2 = 無失敗但有略過項目（驗證不完整，不可視為通過上線檢查）。
 *
 * 約束（唯一索引等）無法透過 REST API 讀取系統目錄，所以「唯讀」模式做不到；請用寫入測試做行為驗證，
 * 或在 Supabase SQL Editor 執行 MANUAL_SQL 內的唯讀 SQL。
 */
const EXPECTED = {
  integration_jobs: ['id', 'type', 'reservation_id', 'payload', 'status', 'attempts', 'run_after', 'dedupe_key', 'created_at'],
  line_bind_tokens: ['code', 'reservation_id', 'phone', 'expires_at'],
  app_state: ['key', 'value', 'updated_at'],
  reservations: ['id', 'status', 'date', 'start_time', 'end_time', 'created_at', 'updated_at', 'phone', 'name', 'service_name'],
  closures: ['id', 'date', 'start_time', 'end_time'],
};

export const MANUAL_SQL = `-- 唯讀：列出索引與約束，人工確認 dedupe_key / code / key 具唯一性
select tablename, indexname, indexdef from pg_indexes
 where schemaname = 'public' and tablename in ('integration_jobs','line_bind_tokens','app_state') order by 1, 2;
select conrelid::regclass as tbl, conname, contype, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in ('public.integration_jobs'::regclass, 'public.line_bind_tokens'::regclass, 'public.app_state'::regclass);`;

const UNVERIFIED_IN_READONLY = [
  'integration_jobs.status 可設為 pending / done / failed',
  'integration_jobs.dedupe_key 具唯一約束',
  'integration_jobs on_conflict + ignore-duplicates 可用',
  'line_bind_tokens.code 具唯一約束',
  'line_bind_tokens on_conflict=code 可用（綁定失敗時還原綁定碼）',
  'line_bind_tokens 原子領取查詢（DELETE … RETURNING）正確處理過期與重複領取',
  'app_state.key 具唯一約束、upsert 與 JSON 欄位篩選可用',
];

export async function runPreflight(env, { fetchImpl = fetch, writeTest = false } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const results = [];
  const add = (name, status, detail = '') => results.push({ name, status, ok: status === 'pass', detail });
  if (!base || !key) { add('設定', 'fail', '缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY'); return results; }

  const call = async (method, path, body, prefer) => {
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const err = r => `HTTP ${r.status}：${r.text.slice(0, 200)}`;
  const isDup = r => !r.ok && /23505|duplicate|unique/i.test(r.text);

  // ── 唯讀：資料表與欄位 ──
  for (const [table, cols] of Object.entries(EXPECTED)) {
    try {
      const r = await call('GET', `${table}?select=${cols.join(',')}&limit=1`);
      add(`資料表 ${table}（欄位 ${cols.length} 個）`, r.ok ? 'pass' : 'fail', r.ok ? '' : err(r));
    } catch (e) { add(`資料表 ${table}`, 'fail', String(e.message || e)); }
  }

  if (!writeTest) {
    for (const n of UNVERIFIED_IN_READONLY) add(n, 'skip', '唯讀模式不驗證；請加 --write-test，或用 SQL 人工確認');
    return results;
  }

  // ── 寫入往返測試：所有測試資料先登記、最後在 finally 統一清除並驗證 ──
  const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const dk = `preflight:${run}`;
  const stateKey = `preflight:${run}`;
  const codeOk = ('F0' + run.slice(0, 4)).toUpperCase();     // 6 碼，與正式綁定碼同長度
  const codeExpired = ('F1' + run.slice(0, 4)).toUpperCase();
  const cleanups = [
    { label: `integration_jobs dedupe_key=${dk}`, table: 'integration_jobs', filter: `dedupe_key=eq.${encodeURIComponent(dk)}` },
    { label: `line_bind_tokens code=${codeOk}`, table: 'line_bind_tokens', filter: `code=eq.${codeOk}` },
    { label: `line_bind_tokens code=${codeExpired}`, table: 'line_bind_tokens', filter: `code=eq.${codeExpired}` },
    { label: `app_state key=${stateKey}`, table: 'app_state', filter: `key=eq.${encodeURIComponent(stateKey)}` },
  ];
  const step = async (name, fn) => {
    try { const r = await fn(); add(name, r.pass ? 'pass' : 'fail', r.pass ? '' : r.detail); return r.pass; }
    catch (e) { add(name, 'fail', `執行時發生例外：${String(e.message || e).slice(0, 160)}`); return false; }
  };

  try {
    const sample = await call('GET', 'reservations?select=id&limit=1');   // reservation_id 若有外鍵，需使用真實存在的預約
    const rid = sample.ok && sample.json && sample.json[0] ? sample.json[0].id : null;
    const nowIso = new Date().toISOString();

    // integration_jobs
    const job = { id: crypto.randomUUID(), type: 'preflight.test', reservation_id: rid, payload: { preflight: true }, status: 'pending', attempts: 0, run_after: nowIso, dedupe_key: dk, created_at: nowIso };
    const inserted = await step('integration_jobs 可新增', async () => { const r = await call('POST', 'integration_jobs', job, 'return=representation'); return { pass: r.ok, detail: err(r) }; });
    if (inserted) {
      for (const st of ['done', 'failed', 'pending']) {
        await step(`integration_jobs.status 可設為 ${st}`, async () => {
          const r = await call('PATCH', `integration_jobs?id=eq.${job.id}`, { status: st }, 'return=representation');
          return { pass: r.ok && Array.isArray(r.json) && r.json.length === 1, detail: err(r) };
        });
      }
      await step('integration_jobs.dedupe_key 具唯一約束', async () => {
        const r = await call('POST', 'integration_jobs', { ...job, id: crypto.randomUUID() }, 'return=representation');
        return { pass: isDup(r), detail: r.ok ? '重複寫入竟然成功：提醒可能被重複建立！請為 dedupe_key 建立唯一索引' : err(r) };
      });
      await step('integration_jobs on_conflict + ignore-duplicates 可用', async () => {
        const r = await call('POST', 'integration_jobs?on_conflict=dedupe_key', { ...job, id: crypto.randomUUID() }, 'resolution=ignore-duplicates,return=representation');
        return { pass: r.ok && Array.isArray(r.json) && r.json.length === 0, detail: err(r) };
      });
    }

    // line_bind_tokens（綁定碼）
    const tok = (code, expires) => ({ code, reservation_id: rid, phone: '0000000000', expires_at: expires });
    const future = new Date(Date.now() + 3600e3).toISOString(), past = new Date(Date.now() - 3600e3).toISOString();
    const tokenInserted = await step('line_bind_tokens 可新增', async () => { const r = await call('POST', 'line_bind_tokens', tok(codeOk, future), 'return=representation'); return { pass: r.ok, detail: err(r) }; });
    if (tokenInserted) {
      await step('line_bind_tokens.code 具唯一約束', async () => {
        const r = await call('POST', 'line_bind_tokens', tok(codeOk, future), 'return=representation');
        return { pass: isDup(r), detail: r.ok ? '重複寫入竟然成功：綁定碼可能重複，請為 code 建立唯一索引或主鍵' : err(r) };
      });
      await step('line_bind_tokens on_conflict=code 可用（綁定失敗時還原綁定碼）', async () => {
        const r = await call('POST', 'line_bind_tokens?on_conflict=code', tok(codeOk, future), 'resolution=merge-duplicates,return=representation');
        return { pass: r.ok, detail: err(r) + '（沒有 code 的唯一約束時，這個語法會失敗）' };
      });
      await call('POST', 'line_bind_tokens', tok(codeExpired, past), 'return=minimal');
      await step('line_bind_tokens 原子領取查詢（DELETE … RETURNING）正確處理過期與重複領取', async () => {
        const claim = code => call('DELETE', `line_bind_tokens?code=eq.${code}&expires_at=gte.${encodeURIComponent(new Date().toISOString())}`, undefined, 'return=representation');
        const expired = await claim(codeExpired);
        if (!expired.ok || !Array.isArray(expired.json) || expired.json.length !== 0) return { pass: false, detail: `已過期的碼不應被領取：${err(expired)}` };
        const first = await claim(codeOk);
        if (!first.ok || !Array.isArray(first.json) || first.json.length !== 1) return { pass: false, detail: `有效的碼應被領取 1 次：${err(first)}（DELETE 需回傳被刪的列）` };
        const second = await claim(codeOk);
        if (!second.ok || !Array.isArray(second.json) || second.json.length !== 0) return { pass: false, detail: `同一個碼不可被領取兩次：${err(second)}` };
        return { pass: true };
      });
    }

    // app_state
    await step('app_state.key 具唯一約束、upsert 與 JSON 欄位篩選可用', async () => {
      const row = { key: stateKey, value: { ok: true }, updated_at: nowIso };
      const up = await call('POST', 'app_state?on_conflict=key', row, 'resolution=merge-duplicates,return=representation');
      if (!up.ok) return { pass: false, detail: `upsert 失敗：${err(up)}` };
      const dup = await call('POST', 'app_state', row, 'return=representation');
      if (!isDup(dup)) return { pass: false, detail: dup.ok ? 'key 重複寫入竟然成功：請為 key 建立唯一索引或主鍵' : err(dup) };
      const q = await call('GET', `app_state?key=like.${encodeURIComponent('preflight:*')}&value->>ok=eq.true&select=key`);
      return { pass: q.ok && Array.isArray(q.json) && q.json.some(x => x.key === stateKey), detail: `JSON 欄位篩選（value->>…）不可用：${err(q)}` };
    });
  } catch (e) {
    add('寫入往返測試', 'fail', `未預期的例外：${String(e.message || e).slice(0, 160)}`);
  } finally {
    // 統一清除並「驗證」確實已清除；任何殘留都回報識別資訊，方便手動刪除
    const residual = [];
    for (const c of cleanups) {
      let gone = false;
      try {
        await call('DELETE', `${c.table}?${c.filter}`);
        const check = await call('GET', `${c.table}?${c.filter}&select=*&limit=1`);
        gone = check.ok && Array.isArray(check.json) && check.json.length === 0;
      } catch { /* 視為未清除 */ }
      if (!gone) residual.push(c.label);
    }
    if (residual.length) add('測試資料清理', 'fail', `以下測試資料可能殘留，請手動刪除：${residual.join('；')}`);
    else add('測試資料已清除（已逐項驗證）', 'pass');
  }
  return results;
}

export function summarize(results) {
  const fail = results.filter(r => r.status === 'fail').length;
  const skip = results.filter(r => r.status === 'skip').length;
  const pass = results.filter(r => r.status === 'pass').length;
  return { pass, fail, skip, exitCode: fail ? 1 : skip ? 2 : 0 };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const writeTest = process.argv.includes('--write-test');
  const r = await runPreflight(process.env, { writeTest });
  const icon = { pass: '✅', fail: '❌', skip: '⏭️ ' };
  for (const x of r) console.log(`${icon[x.status]} ${x.name}${x.detail ? ' — ' + x.detail : ''}`);
  const s = summarize(r);
  console.log(`\n通過 ${s.pass}　失敗 ${s.fail}　略過 ${s.skip}`);
  if (s.fail) console.log('❌ 有項目未通過：請先處理再上線（不要自行修改正式資料表，請把輸出貼給我評估）。');
  else if (s.skip) console.log('⚠️  無失敗，但有略過項目：約束與寫入行為「尚未驗證」，不可視為通過。請加上 --write-test 再執行。\n\n或在 Supabase SQL Editor 人工確認：\n' + MANUAL_SQL);
  else console.log('✅ 全部項目都已執行且通過。');
  process.exit(s.exitCode);
}
