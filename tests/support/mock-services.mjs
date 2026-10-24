// 測試用「假外部世界」：Supabase(PostgREST) / LINE / Google OAuth / Calendar / Drive / Render export
// 全部跑在同一個本機 HTTP 伺服器；不對外連線。
import './polyfill.mjs';
import http from 'node:http';
import zlib from 'node:zlib';

export const KEYS = { supabase: 'sb-service-key', line: 'line-token', googleRefresh: 'g-refresh' };
const RES_COLS = ['id','booking_code','name','birth_date','phone','line_id','note','service_id','service_name','duration_minutes','date','start_time','end_time','service_slots','slots','status','created_at','updated_at','cancelled_at'];
const COLS = {
  reservations: RES_COLS,
  customers: ['id','name','birth_date','phone','line_id','created_at','updated_at','history'],
  closures: ['id','date','start_time','end_time','created_at'],
  app_state: ['key','value','updated_at'],
  integration_jobs: ['id','type','reservation_id','payload','status','attempts','run_after','dedupe_key','created_at'],
  line_bind_tokens: ['code','reservation_id','phone','expires_at'],
};
const PK = { reservations:'id', customers:'id', closures:'id', app_state:'key', integration_jobs:'id', line_bind_tokens:'code' };
const UNIQUE = { integration_jobs: ['dedupe_key'] };
const JOB_STATUS = ['pending', 'done', 'failed']; // 模擬可能存在的 CHECK 限制：Worker 只能使用這三種

export async function startMocks(port = 0) {
  const S = {
    tables: Object.fromEntries(Object.keys(COLS).map(k => [k, []])),
    line: { pushes: [], attempts: 0, replies: [], replyAttempts: 0, retryKeys: new Set(), failNext: 0, failReply: 0, failReplyStatus: 500, failPushStatus: 500 },
    google: { sessions: new Map(), uploadKinds: [], putHeaders: [], failPut: 0, truncateUpload: false, tokenFail: false, failStatus: 503, tokenCalls: 0, events: new Map(), tombstones: new Set(), files: [], apiCalls: [], expireTokenOnce: false, pageSize: 250, failNext: { calendar: 0, drive: 0 }, seq: 0 },
    render: { exportPayload: null, status: 200, exportCalls: 0, legacy: false, chunked: false, proxyGzip: false, forceGzip: false, lieBytes: 0, lastAcceptEncoding: '' },
    wakes: [],
    requests: 0,           // 收到的 HTTP 請求總數（用來驗證 Worker 每次執行的對外請求數）
    log: [],
    fail: [],              // Supabase 故障注入：[{ re, skip, times, status }]
    delay: [],             // Supabase 延遲注入：[{ re, ms }]
    jobStatuses: ['pending', 'done', 'failed'],
  };
  const read = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
  const readBuf = req => new Promise(r => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

  // ---------- PostgREST 過濾 ----------
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function matchRow(row, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      const [col, jkey] = k.split('->>');
      const val = jkey ? (row[col] || {})[jkey] : row[k]; let m;
      if ((m = /^eq\.(.*)$/.exec(v))) { if (String(val) !== m[1]) return false; }
      else if ((m = /^neq\.(.*)$/.exec(v))) { if (String(val) === m[1]) return false; }
      else if ((m = /^lte\.(.*)$/.exec(v))) { if (!(cmp(String(val), m[1]) <= 0)) return false; }
      else if ((m = /^gte\.(.*)$/.exec(v))) { if (!(cmp(String(val), m[1]) >= 0)) return false; }
      else if ((m = /^in\.\((.*)\)$/.exec(v))) { if (!m[1].split(',').includes(String(val))) return false; }
      else if ((m = /^like\.(.*)$/.exec(v))) { const re = new RegExp('^' + m[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); if (!re.test(String(val))) return false; }
      else if (v === 'not.is.null') { if (val == null) return false; }
      else throw new Error('mock: unsupported filter ' + k + '=' + v);
    }
    return true;
  }
  function validateRow(table, row) {
    const allowed = COLS[table];
    const bad = Object.keys(row).filter(k => !allowed.includes(k));
    if (bad.length) return { code: 'PGRST204', message: `Could not find the '${bad[0]}' column of '${table}' in the schema cache` };
    if (table === 'integration_jobs' && row.status !== undefined && !S.jobStatuses.includes(row.status)) return { code: '23514', message: `new row for relation "integration_jobs" violates check constraint (status=${row.status})` };
    return null;
  }

  async function supabase(req, res, u) {
    if (req.headers.apikey !== KEYS.supabase || req.headers.authorization !== 'Bearer ' + KEYS.supabase) return send(res, 401, { message: 'bad key' });
    const table = u.pathname.replace('/rest/v1/', '');
    if (!(table in S.tables)) return send(res, 404, { code: '42P01', message: 'relation does not exist' });
    const params = [...u.searchParams.entries()];
    const prefer = String(req.headers.prefer || '');
    S.log.push(`${req.method} ${table}${u.search}`);
    for (const d of S.delay) if (d.re.test(`${req.method} ${table}`)) await new Promise(r => setTimeout(r, d.ms));
    for (const f of S.fail) {
      if (!f.re.test(`${req.method} ${table}`)) continue;
      if (f.skip > 0) { f.skip--; continue; }
      if (f.times > 0) { f.times--; return send(res, f.status || 500, { message: 'injected failure' }); }
    }
    try {
      if (req.method === 'GET') {
        const sel = (u.searchParams.get('select') || '*').split(',').map(x => x.trim()).filter(x => x && x !== '*');
        const allowed = (COLS[table] || []).filter(c => !(S.dropped && S.dropped.table === table && S.dropped.col === c));
        const missing = COLS[table] ? sel.filter(c => !allowed.includes(c) && !c.includes('(') && !c.includes('->')) : [];
        if (missing.length) return send(res, 400, { code: '42703', message: `column ${table}.${missing[0]} does not exist` });
        let rows = S.tables[table].filter(r => matchRow(r, params));
        const ord = u.searchParams.get('order');
        if (ord) { const [c, d] = ord.split('.'); rows = [...rows].sort((a, b) => cmp(String(a[c]), String(b[c])) * (d === 'desc' ? -1 : 1)); }
        const off = Number(u.searchParams.get('offset') || 0), lim = u.searchParams.get('limit');
        return send(res, 200, rows.slice(off, lim ? off + Number(lim) : undefined));
      }
      if (req.method === 'DELETE') {
        if (!params.length) return send(res, 400, { message: 'DELETE requires a filter' });
        const gone = S.tables[table].filter(r => matchRow(r, params));
        S.tables[table] = S.tables[table].filter(r => !matchRow(r, params));
        return send(res, 200, S.deleteReturnsNothing ? [] : gone);      // 模擬：DELETE 不回傳被刪的列
      }
      const body = JSON.parse((await read(req)) || 'null');
      if (req.method === 'PATCH') {
        const err = validateRow(table, body); if (err) return send(res, 400, err);
        const hit = S.tables[table].filter(r => matchRow(r, params));
        for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(body)));
        return send(res, 200, prefer.includes('return=minimal') ? undefined : hit);
      }
      if (req.method === 'POST') {
        const rows = [].concat(body); const out = [];
        for (const r of rows) {
          const err = validateRow(table, r); if (err) return send(res, 400, err);
          const oc = u.searchParams.get('on_conflict');
          const keys = oc ? [oc] : [PK[table]];
          const uniq = [...new Set([...keys, ...(S.noUnique ? [] : (UNIQUE[table] || []))])];
          if (S.noTokenUnique && table === 'line_bind_tokens') {      // 模擬：code 沒有唯一約束
            if (oc) return send(res, 400, { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' });
            S.tables[table].push(JSON.parse(JSON.stringify(r))); out.push(r); continue;
          }
          const dup = S.tables[table].find(x => uniq.some(k => r[k] !== undefined && x[k] === r[k]));
          if (dup) {
            if (prefer.includes('ignore-duplicates')) continue;
            if (oc) { Object.assign(dup, r); out.push(dup); continue; }
            return send(res, 409, { code: '23505', message: 'duplicate key' });
          }
          S.tables[table].push(JSON.parse(JSON.stringify(r))); out.push(r);
        }
        return send(res, 201, prefer.includes('return=minimal') ? undefined : out);
      }
      send(res, 405, { message: 'method' });
    } catch (e) { send(res, 500, { message: String(e) }); }
  }

  // ---------- LINE ----------
  async function line(req, res, u) {
    if (req.headers.authorization !== 'Bearer ' + KEYS.line) return send(res, 401, { message: 'bad line token' });
    const body = JSON.parse((await read(req)) || '{}');
    if (u.pathname.endsWith('/message/push')) {
      S.line.attempts++;
      if (S.line.failNext > 0) { S.line.failNext--; return send(res, S.line.failPushStatus, { message: 'line down' }); }
      const rk = req.headers['x-line-retry-key'];
      if (rk && S.line.retryKeys.has(rk)) return send(res, 409, { message: 'retry key accepted before' });
      if (rk) S.line.retryKeys.add(rk);
      S.line.pushes.push({ to: body.to, text: body.messages[0].text, retryKey: rk });
      return send(res, 200, {});
    }
    if (u.pathname.endsWith('/message/reply')) {
      S.line.replyAttempts++;
      if (S.line.failReply > 0) { S.line.failReply--; return send(res, S.line.failReplyStatus, { message: 'reply failed' }); }
      S.line.replies.push({ token: body.replyToken, text: body.messages[0].text }); return send(res, 200, {}); }
    send(res, 404, {});
  }

  // ---------- Google ----------
  const G = S.google;
  function gAuth(req, res) {
    const ok = req.headers.authorization === 'Bearer gtoken-' + G.tokenCalls;
    if (G.expireTokenOnce) { G.expireTokenOnce = false; send(res, 401, { error: 'expired' }); return false; }
    if (!ok) { send(res, 401, { error: 'bad token' }); return false; }
    return true;
  }
  async function googleToken(req, res) {
    const p = new URLSearchParams(await read(req));
    if (G.tokenFail || p.get('grant_type') !== 'refresh_token' || p.get('refresh_token') !== KEYS.googleRefresh) return send(res, 400, { error: 'invalid_grant' });
    G.tokenCalls++; send(res, 200, { access_token: 'gtoken-' + G.tokenCalls, expires_in: 3600 });
  }
  async function calendar(req, res, u) {
    if (!gAuth(req, res)) return;
    if (G.failNext.calendar > 0) { G.failNext.calendar--; return send(res, G.failStatus, { error: 'calendar down' }); }
    const m = /\/calendars\/([^/]+)\/events(?:\/([^/?]+))?$/.exec(u.pathname);
    const [, cal, id] = m;
    G.apiCalls.push(`${req.method} ${id || 'list'}`);
    if (req.method === 'GET' && !id) {
      const [pk, pv] = (u.searchParams.get('privateExtendedProperty') || '=').split('=');
      let items = [...G.events.values()].filter(e => G.leakForeign || !pk || e.extendedProperties?.private?.[pk] === pv);
      const start = Number(u.searchParams.get('pageToken') || 0);
      const size = Math.min(G.pageSize, Number(u.searchParams.get('maxResults')) || G.pageSize);   // 與真實 API 一致：遵守 maxResults
      const page = G.ignoreMaxResults ? items.slice(start) : items.slice(start, start + size);   // ignoreMaxResults：模擬 API 回傳超量
      return send(res, 200, { items: page, ...(start + size < items.length && !G.ignoreMaxResults ? { nextPageToken: String(start + size) } : {}) });
    }
    if (req.method === 'POST') {
      const b = JSON.parse(await read(req));
      if (G.events.has(b.id) || G.tombstones.has(b.id)) return send(res, 409, { error: 'identifier already exists' });
      if (!/^[a-v0-9]{5,1024}$/.test(b.id)) return send(res, 400, { error: 'invalid event id ' + b.id });
      G.events.set(b.id, { ...b, status: 'confirmed' }); return send(res, 200, G.events.get(b.id));
    }
    if (req.method === 'PATCH') {
      const b = JSON.parse(await read(req));
      if (G.tombstones.has(id) && b.status === 'confirmed') { G.tombstones.delete(id); G.events.set(id, { id, ...b }); return send(res, 200, G.events.get(id)); }
      if (!G.events.has(id)) return send(res, 404, { error: 'not found' });
      G.events.set(id, { ...G.events.get(id), ...b }); return send(res, 200, G.events.get(id));
    }
    if (req.method === 'DELETE') {
      if (G.tombstones.has(id)) return send(res, 410, { error: 'gone' });
      if (!G.events.has(id)) return send(res, 404, { error: 'not found' });
      if (G.ignoreDelete) return send(res, 204);      // 模擬：API 回成功但事件其實還在
      G.events.delete(id); G.tombstones.add(id); return send(res, 204);
    }
    send(res, 405, {});
  }
  function parseMultipart(raw, ctype) {
    const b = /boundary=(.+)$/.exec(ctype)[1];
    const parts = raw.split(`--${b}`).filter(p => p.trim() && p.trim() !== '--');
    return parts.map(p => JSON.parse(p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')));
  }
  async function drive(req, res, u) {
    if (!gAuth(req, res)) return;
    if (G.failNext.drive > 0) { G.failNext.drive--; return send(res, 503, { error: 'drive down' }); }
    // 可續傳上傳：POST 建立工作階段（回傳 Location），再 PUT 位元組內容（單次，帶 Content-Length）
    if (req.method === 'POST' && u.pathname.endsWith('/files') && u.searchParams.get('uploadType') === 'resumable') {
      const meta = JSON.parse(await read(req)); const id = 'sess' + (++G.seq);
      G.sessions.set(id, { meta, declared: Number(req.headers['x-upload-content-length']) });
      G.uploadKinds.push('resumable');
      return send(res, 200, {}, { Location: `http://${req.headers.host}/google/upload/session/${id}` });
    }
    if (req.method === 'POST' && u.pathname.endsWith('/files')) {
      G.uploadKinds.push('multipart');
      const [meta, content] = parseMultipart(await read(req), req.headers['content-type']);
      const f = { id: 'file' + (++G.seq), name: meta.name, parents: meta.parents, content, trashed: false, createdTime: new Date(Date.UTC(2026, 0, 1) + G.seq * 60e3).toISOString() };
      if (meta.createdTime) f.createdTime = meta.createdTime;
      G.files.push(f); return send(res, 200, { id: f.id, name: f.name });
    }
    if (req.method === 'GET' && u.pathname.endsWith('/files')) {
      const q = u.searchParams.get('q') || '';
      const folder = /'([^']+)' in parents/.exec(q)?.[1]; const contains = /name contains '([^']+)'/.exec(q)?.[1];
      let files = G.files.filter(f => (!folder || f.parents.includes(folder)) && !f.trashed && (!contains || f.name.includes(contains)));
      files = files.sort((a, b) => cmp(b.createdTime, a.createdTime));
      return send(res, 200, { files: files.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime })) });
    }
    const m = /\/files\/([^/?]+)$/.exec(u.pathname);
    if (req.method === 'PATCH' && m) {
      const f = G.files.find(x => x.id === m[1]); if (!f) return send(res, 404, {});
      Object.assign(f, JSON.parse(await read(req))); return send(res, 200, { id: f.id });
    }
    send(res, 404, {});
  }

  const server = http.createServer(async (req, res) => {
    S.requests++;
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname.startsWith('/rest/v1/')) return supabase(req, res, u);
      if (u.pathname.startsWith('/line/')) return line(req, res, u);
      if (u.pathname === '/google/token') return googleToken(req, res);
      if (u.pathname.startsWith('/google/calendar/v3/')) return calendar(req, res, u);
      if (u.pathname.startsWith('/google/upload/session/') && req.method === 'PUT') {
        const id = u.pathname.split('/').pop(); const sess = G.sessions.get(id); if (!sess) return send(res, 404, {});
        if (G.failPut > 0) { G.failPut--; req.resume(); return send(res, 503, { error: 'upload backend down' }); }
        const buf = await readBuf(req); const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared !== buf.length) return send(res, 400, { error: `length mismatch ${declared} vs ${buf.length}` });
        const stored = G.truncateUpload ? buf.subarray(0, Math.floor(buf.length / 2)) : buf;     // 模擬：Drive 端只收到一半
        let content; try { content = JSON.parse(stored.toString('utf8')); } catch { content = stored.toString('utf8'); }
        const f = { id: 'file' + (++G.seq), name: sess.meta.name, parents: sess.meta.parents, content, trashed: false, bytes: stored.length, createdTime: new Date(Date.UTC(2026, 0, 1) + G.seq * 60e3).toISOString() };
        G.files.push(f); G.putHeaders.push({ 'content-length': req.headers['content-length'], 'transfer-encoding': req.headers['transfer-encoding'] });
        return send(res, 200, { id: f.id, name: f.name, size: String(stored.length) });
      }
      if (u.pathname.startsWith('/google/drive/v3/') || u.pathname.startsWith('/google/upload/drive/v3/')) return drive(req, res, u);
      if (u.pathname === '/render/api/integration/export') {
        if (req.headers['x-integration-secret'] !== 'shared-secret') return send(res, 401, { error: 'Unauthorized' });
        S.render.exportCalls++;
        if (S.render.status !== 200) return send(res, S.render.status, S.render.exportPayload || {});
        const payload = S.render.exportPayload || {}; const body = JSON.stringify(payload); const d = payload.data || {};
        const headers = { 'Content-Type': 'application/json; charset=utf-8' };
        const isArr = k => Array.isArray(d[k]);
        if (!S.render.legacy && payload.backupFormat && isArr('reservations') && isArr('customers') && isArr('closures')) {   // legacy=true 模擬「尚未更新的舊版 Render」：沒有 X-Export-* 標頭；真實 server 只會對正常資料送出標頭
          headers['X-Export-Format'] = payload.backupFormat || '';
          headers['X-Export-Counts'] = `reservations=${(d.reservations || []).length};customers=${(d.customers || []).length};closures=${(d.closures || []).length}`;
          headers['X-Export-Bytes'] = Buffer.byteLength(body) + (S.render.lieBytes || 0);   // lieBytes：模擬標頭謊報大小
        }
        S.render.lastAcceptEncoding = req.headers['accept-encoding'] || '';
        // proxyGzip：模擬 Render 前端代理——客戶端接受 gzip 時壓縮並移除 Content-Length（你的 PowerShell 實測看到的現象）
        // forceGzip：不管客戶端要求，一律壓縮（最壞情況）
        const wantsGzip = /gzip|br|deflate/.test(S.render.lastAcceptEncoding) && !/^identity$/.test(S.render.lastAcceptEncoding.trim());
        if (S.render.forceGzip || (S.render.proxyGzip && wantsGzip)) {
          headers['Content-Encoding'] = 'gzip';
          res.writeHead(200, headers); return res.end(zlib.gzipSync(body));
        }
        if (!S.render.chunked) headers['Content-Length'] = Buffer.byteLength(body);   // chunked=true：不帶 Content-Length
        res.writeHead(200, headers);
        if (S.render.chunked) { const mid = Math.floor(body.length / 2); res.write(body.slice(0, mid)); return setTimeout(() => res.end(body.slice(mid)), 5); }
        return res.end(body);
      }
      if (u.pathname === '/worker/wake') { S.wakes.push(req.headers['x-worker-secret']); return send(res, 202, { ok: true }); }
      send(res, 404, { message: 'not found' });
    } catch (e) { send(res, 500, { message: String(e) }); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const p = server.address().port;
  const base = `http://127.0.0.1:${p}`;
  return {
    S, base, port: p,
    reset() { for (const k of Object.keys(S.tables)) S.tables[k] = []; S.line.pushes = []; S.line.attempts = 0; S.line.replyAttempts = 0; S.line.failReply = 0; S.line.replies = []; S.line.retryKeys.clear(); S.line.failNext = 0;
      Object.assign(S.google, { sessions: new Map(), uploadKinds: [], putHeaders: [], failPut: 0, truncateUpload: false, ignoreMaxResults: false, ignoreDelete: false, leakForeign: false, tokenFail: false, failStatus: 503, tokenCalls: 0, events: new Map(), tombstones: new Set(), files: [], apiCalls: [], expireTokenOnce: false, pageSize: 250, seq: 0, failNext: { calendar: 0, drive: 0 } });
      S.render.exportPayload = null; S.render.status = 200; S.render.exportCalls = 0; S.render.legacy = false; S.render.chunked = false; S.render.proxyGzip = false; S.render.forceGzip = false; S.render.lieBytes = 0; S.render.lastAcceptEncoding = ''; S.requests = 0; S.wakes = []; S.log = []; S.fail = []; S.delay = []; S.jobStatuses = ['pending', 'done', 'failed']; S.dropped = null; S.noUnique = false; S.noTokenUnique = false; S.deleteReturnsNothing = false; },
    env(extra = {}) {
      return {
        SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: KEYS.supabase,
        LINE_API_BASE: base + '/line', LINE_CHANNEL_ACCESS_TOKEN: KEYS.line, LINE_CHANNEL_SECRET: 'line-channel-secret', ADMIN_LINE_USER_ID: 'U_ADMIN',
        GOOGLE_TOKEN_URL: base + '/google/token', GOOGLE_CALENDAR_API: base + '/google/calendar/v3', GOOGLE_DRIVE_API: base + '/google/drive/v3', GOOGLE_UPLOAD_API: base + '/google/upload/drive/v3',
        GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REFRESH_TOKEN: KEYS.googleRefresh, GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com', GOOGLE_DRIVE_FOLDER_ID: 'FOLDER1',
        RENDER_BASE_URL: base + '/render', INTEGRATION_WORKER_SECRET: 'shared-secret',
        ...extra,
      };
    },
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
  };
}
