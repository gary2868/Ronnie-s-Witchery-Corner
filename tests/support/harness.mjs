// 整合測試輔助：啟動「真實 server.js」（子行程）與「Worker 的 HTTP 轉接器」。
import './polyfill.mjs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W from '../../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 把 Worker 以 HTTP 服務方式跑起來（等同 Cloudflare 的 fetch 入口），並可控制 Worker 的時鐘。 */
export async function startWorkerAdapter(getEnv) {
  const clock = { cur: null, now() { return this.cur ?? Date.now(); } };
  const pending = new Set();
  const deps = W.makeDeps({ now: () => clock.now() });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request(`http://worker${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const ctx = { waitUntil: p => { const t = p.catch(e => console.error('waitUntil error', e)).finally(() => pending.delete(t)); pending.add(t); } };
    const r = await W.handleRequest(request, getEnv(), ctx, deps);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, clock, deps,
    async idle() { while (pending.size) await Promise.all([...pending]); },
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** 啟動真實 server.js（複製一份到暫存資料夾，資料互不影響）。 */
export async function startRealServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronnie-srv-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: src => !/(^|[\\/])(node_modules|\.git|data)([\\/]|$)/.test(path.relative(ROOT, src)) });   // 相對路徑 + 同時支援 / 與 \（Windows）；避免專案路徑本身含 data 時整包被排除，也避免把你的真實 data 複製進測試
  const port = await freePort();
  const logFile = path.join(dir, 'server.log'); const out = fs.openSync(logFile, 'w');
  const child = spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', out, out] });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (child.exitCode !== null || child.signalCode) break;                       // 子行程已提前結束：不要再空等
    try { ready = (await fetch(base + '/api/config', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* 尚未就緒 */ }
  }
  if (!ready) {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n');
    child.kill('SIGKILL');
    throw new Error(`server.js 未能啟動（結束碼 ${child.exitCode}）。啟動日誌：\n${tail}`);
  }
  let cookie = '';
  const api = async (method, p, body, { auth = true } = {}) => {
    if (auth && !cookie && p.startsWith('/api/admin') && p !== '/api/admin/login') {
      const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '5144' }) });
      cookie = r.headers.get('set-cookie').split(';')[0];
    }
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json };
  };
  const stop = () => new Promise(resolve => {
    // 子行程若已結束，'exit' 事件不會再觸發，必須直接返回（否則會永遠卡住）
    if (child.exitCode !== null || child.signalCode) return resolve();
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(killer); resolve(); });
    child.kill('SIGTERM');
  });
  return { base, api, dir, log: () => fs.readFileSync(logFile, 'utf8'), stop };
}
