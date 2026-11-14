import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import '../support/polyfill.mjs';
import { startMocks } from '../support/mock-services.mjs';
import * as W from '../../worker/index.js';

let m;
before(async () => { m = await startMocks(); });
after(async () => { await m.close(); });
beforeEach(() => m.reset());

const NOW = W.taipeiToUtcMs('2026-10-20', '12:00');
const ENV_ON = (extra = {}) => m.env({ FEATURE_ADMIN_NOTIFY: 'on', FEATURE_CALENDAR: 'on', FEATURE_REMINDERS: 'on', FEATURE_BACKUP: 'on', FEATURE_LINE_BINDING: 'on', ...extra });
const mkDeps = (ms, extra = {}) => W.makeDeps({ now: () => ms, ...extra });
const exportOf = (n = 3) => ({ backupFormat: 'RONNIE_HEALING_SPACE_BACKUP', backupVersion: 'V2', exportedAt: 'x',
  data: { reservations: Array.from({ length: n }, (_, i) => ({ id: 'r' + i })), customers: [{ id: 'c' }], closures: [] } });
const files = () => m.S.apps.files.filter(f => !f.trashed);
const BK = /^Ronnie-Witchery-Corner-backup-v2-\d{8}-\d{4}\.json$/;

describe('Apps Script 中繼：定時與手動備份', () => {
  it('上傳到 Apps Script；檔名為台北時間；內容與匯出完全相同', async () => {
    m.S.render.exportPayload = exportOf();
    const r = await W.runBackup(ENV_ON(), mkDeps(Date.parse('2026-10-20T19:00:00Z')), 'cron');
    assert.equal(r.ok, true);
    assert.equal(r.name, 'Ronnie-Witchery-Corner-backup-v2-20261021-0300.json');
    assert.equal(files().length, 1); assert.equal(files()[0].name, r.name);
    assert.deepEqual(files()[0].content, m.S.render.exportPayload);
  });

  it('串流上傳：帶固定 Content-Length（非 chunked），位元組數與回報一致', async () => {
    m.S.render.exportPayload = exportOf();
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW), 'manual');
    assert.equal(r.path, 'stream');
    const h = m.S.apps.putHeaders[0];
    assert.equal(Number(h['content-length']), r.bytes); assert.equal(h['transfer-encoding'], undefined);
    assert.equal(files()[0].bytes, r.bytes);
  });

  it('保留最新 60 份（Apps Script 端執行）；只動符合命名規則的檔案；剛上傳的不會被刪', async () => {
    m.S.render.exportPayload = exportOf();
    for (let i = 0; i < 65; i++) {
      const name = 'Ronnie-Witchery-Corner-backup-v2-2026080' + (i % 9 + 1) + '-' + String(i).padStart(4, '0') + '.json';
      m.S.apps.files.push({ id: 'old' + i, name, trashed: false, bytes: 1, content: {}, createdTime: new Date(Date.UTC(2026, 7, 1) + i * 60e3).toISOString() });
    }
    m.S.apps.files.push({ id: 'lookalike', name: 'Ronnie-Witchery-Corner-backup-v2-NOTES-my-manual-copy.json', trashed: false, bytes: 1, content: {}, createdTime: '2019-01-01T00:00:00Z' });
    m.S.apps.files.push({ id: 'foreign', name: '我的重要文件.docx', trashed: false, bytes: 1, content: {}, createdTime: '2020-01-01T00:00:00Z' });
    const r = await W.runBackup(ENV_ON({ BACKUP_KEEP: '60' }), mkDeps(NOW), 'cron');
    const alive = m.S.apps.files.filter(f => !f.trashed && BK.test(f.name));
    assert.equal(alive.length, 60); assert.equal(r.trashed, 6);
    assert.ok(alive.some(f => f.id === r.fileId), '剛上傳的檔案必須保留');
    assert.equal(m.S.apps.files.find(f => f.id === 'old0').trashed, true, '最舊的先被清理');
    assert.equal(m.S.apps.files.find(f => f.id === 'old64').trashed, false);
    assert.equal(m.S.apps.files.find(f => f.id === 'foreign').trashed, false);
    assert.equal(m.S.apps.files.find(f => f.id === 'lookalike').trashed, false, '名稱相似但非本系統格式的檔案不可動');
  });

  it('匯出失敗 / 格式不符 → 不上傳', async () => {
    m.S.render.status = 500;
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /匯出失敗 500/);
    m.S.render.status = 200; m.S.render.exportPayload = { hello: 'world' };
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /格式不正確/);
    assert.equal(m.S.apps.files.length, 0);
  });

  it('全空資料也會備份，但不觸發清理（避免空備份把好備份擠掉）', async () => {
    m.S.render.exportPayload = { ...exportOf(), data: { reservations: [], customers: [], closures: [] } };
    for (let i = 0; i < 70; i++) {
      m.S.apps.files.push({ id: 'o' + i, name: 'Ronnie-Witchery-Corner-backup-v2-20260101-' + String(i).padStart(4, '0') + '.json', trashed: false, bytes: 1, content: {}, createdTime: new Date(Date.UTC(2026, 0, 1) + i * 60e3).toISOString() });
    }
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW));
    assert.equal(r.ok, true);
    assert.equal(r.trashed, 0); assert.equal(m.S.apps.files.filter(f => f.trashed).length, 0);
  });

  it('Apps Script 暫時故障 → 丟出錯誤，不留下檔案；排除後可重跑', async () => {
    m.S.render.exportPayload = exportOf(); m.S.apps.failUpload = 1;
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW)), /Apps Script 上傳失敗/);
    assert.equal(files().length, 0);
    assert.equal((await W.runBackup(ENV_ON(), mkDeps(NOW))).ok, true);
    assert.equal(files().length, 1);
  });

  it('串流超過上限 → 不上傳', async () => {
    m.S.render.exportPayload = exportOf();
    await assert.rejects(W.runBackup(ENV_ON({ BACKUP_STREAM_MAX_BYTES: '100' }), mkDeps(NOW), 'manual'), /超過串流上限/);
    assert.equal(m.S.apps.requests, 0, '超限時不應呼叫 Apps Script');
  });

  it('相容舊版 Render（沒有 X-Export-* 標頭）→ 改用緩衝模式並成功上傳', async () => {
    m.S.render.exportPayload = exportOf(); m.S.render.legacy = true;
    const r = await W.runBackup(ENV_ON(), mkDeps(NOW), 'manual');
    assert.equal(r.path, 'buffered'); assert.equal(files().length, 1);
    assert.deepEqual(files()[0].content, m.S.render.exportPayload);
  });

  it('BACKUP_UPLOAD_MODE=buffered 可手動切回緩衝模式', async () => {
    m.S.render.exportPayload = exportOf();
    const r = await W.runBackup(ENV_ON({ BACKUP_UPLOAD_MODE: 'buffered' }), mkDeps(NOW), 'manual');
    assert.equal(r.path, 'buffered'); assert.equal(files().length, 1);
  });

  it('dry：只讀回應標頭，不上傳、不呼叫 Apps Script 上傳', async () => {
    m.S.render.exportPayload = exportOf();
    const r = await W.runBackup(ENV_ON({ FEATURE_BACKUP: 'dry' }), mkDeps(NOW), 'manual');
    assert.equal(r.dry, true); assert.equal(r.path, 'stream');
    assert.deepEqual(r.counts, { reservations: 3, customers: 1, closures: 0 });
    assert.equal(files().length, 0); assert.equal(m.S.render.exportCalls, 1);
  });

  it('每日冪等：cron 當天已成功就略過（查詢 Apps Script）；手動備份一律執行', async () => {
    m.S.render.exportPayload = exportOf(); const env = ENV_ON();
    const a = await W.runBackup(env, mkDeps(NOW), 'cron'); assert.equal(a.ok, true); assert.equal(a.skipped, undefined);
    const b = await W.runBackup(env, mkDeps(NOW + 3600e3), 'cron');
    assert.equal(b.skipped, 'already_done_today'); assert.equal(files().length, 1);
    assert.equal(m.S.render.exportCalls, 1, '略過時不應再向 Render 要資料');
    await W.runBackup(env, mkDeps(NOW + 7200e3), 'manual'); assert.equal(files().length, 2);
  });

  it('HTTP /backup-now：成功 200；dry 不上傳；匯出失敗 502', async () => {
    const call = env => W.handleRequest(new Request('http://w/backup-now', { method: 'POST', headers: { 'x-worker-secret': 'shared-secret' } }), env, undefined, mkDeps(NOW));
    m.S.render.exportPayload = exportOf();
    assert.equal((await call(ENV_ON())).status, 200); assert.equal(files().length, 1);
    assert.equal((await call(ENV_ON({ FEATURE_BACKUP: 'dry' }))).status, 200); assert.equal(files().length, 1);
    m.S.render.status = 500;
    const bad = await call(ENV_ON()); assert.equal(bad.status, 502); assert.ok((await bad.json()).error);
  });

  it('重試排程：第一次 cron 失敗、第二次成功 → 一份備份且不通知；兩次都失敗 → 管理者一則警示', async () => {
    m.S.render.exportPayload = exportOf(); const env = ENV_ON(); const first = W.CRONS.backups[0], last = W.CRONS.backups[1];
    m.S.render.status = 500;
    await W.handleScheduled({ cron: first, scheduledTime: NOW }, env, undefined, mkDeps(NOW));
    assert.equal(m.S.line.pushes.length, 0, '第一次失敗不通知');
    m.S.render.status = 200;
    await W.handleScheduled({ cron: last, scheduledTime: NOW + 3600e3 }, env, undefined, mkDeps(NOW + 3600e3));
    assert.equal(files().length, 1); assert.equal(m.S.line.pushes.length, 0);
    m.reset(); m.S.render.exportPayload = exportOf(); m.S.render.status = 500;
    await W.handleScheduled({ cron: first, scheduledTime: NOW }, env, undefined, mkDeps(NOW));
    await W.handleScheduled({ cron: last, scheduledTime: NOW + 3600e3 }, env, undefined, mkDeps(NOW + 3600e3));
    assert.equal(m.S.line.pushes.length, 1); assert.match(m.S.line.pushes[0].text, /自動備份失敗/);
  });

  // 已知缺口：大小不符時，Worker 目前仍以 Drive API 移除壞檔；在 Apps Script 架構下該步驟會失敗，
  // 壞檔會留在資料夾。此測試只驗證「會回報錯誤」，缺口另案處理（見維運說明）。
  it('上傳後大小不符 → 本次備份回報失敗（已知缺口：壞檔目前不會被移除）', async () => {
    m.S.render.exportPayload = exportOf(); m.S.apps.truncate = true;
    await assert.rejects(W.runBackup(ENV_ON(), mkDeps(NOW), 'manual'), /上傳大小不符/);
  });
});
