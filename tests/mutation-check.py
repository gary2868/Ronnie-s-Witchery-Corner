#!/usr/bin/env python3
"""突變測試：故意把關鍵邏輯改壞，確認測試「真的會失敗」。

- 每個突變都在「獨立的暫存副本」中執行（不會動到你的原始檔案），並可平行執行。
- 用法（於專案根目錄）：
    python3 tests/mutation-check.py              # 全部（76 項，約 9~10 分鐘；可用 --only 只跑部分）
    python3 tests/mutation-check.py -j 2         # 平行數
    python3 tests/mutation-check.py --only M1,M5 # 只跑指定突變
    python3 tests/mutation-check.py --list
- 結束碼：0 = 全部突變都被測試抓到；1 = 有漏網或基準線失敗。
"""
import argparse, concurrent.futures as cf, os, re, shutil, subprocess, sys, tempfile, time
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_CMD="node --test{flag} tests/worker/worker.test.mjs tests/worker/integration.test.mjs"
def node_major():
    try: return int(subprocess.check_output(['node','-p',"process.versions.node.split('.')[0]"],text=True).strip())
    except Exception: sys.exit("找不到 node")
FLAG=" --test-timeout=60000" if node_major()>=20 else ""

MUT=[
 ("M1","提醒時間 17:00 → 16:00","worker/index.js","addDays(r.date, -1), '17:00'","addDays(r.date, -1), '16:00'"),
 ("M2","server 旗標檢查移除（回退機制失效）","server.js","  if (!INTEGRATION_ADMIN_EVENTS) return;\n  try {\n    await enqueueIntegrationJob","  try {\n    await enqueueIntegrationJob"),
 ("M3","已完成步驟仍重做","worker/index.js","if (steps[name] && !String(steps[name]).startsWith('error')) continue;",""),
 ("M4","備份清理不檢查命名規則","worker/index.js",".filter(f => BACKUP_NAME_RE.test(f.name) && f.id !== justUploadedId)",".filter(f => f.id !== justUploadedId)"),
 ("M5","LINE 簽章驗證被繞過","worker/index.js","if (!(await verifyLineSignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET))) {","if (false) {"),
 ("M6","日曆對帳不限本系統事件","worker/index.js","privateExtendedProperty=${enc('ronnie=1')}&",""),
 ("M7","保留份數改成 1","worker/index.js","const keep = Math.max(7, Number(env.BACKUP_KEEP) || 60);","const keep = 1;"),
 ("M8","job 狀態寫入 processing（違反資料表限制）","worker/index.js","{ attempts: attempts + 1, run_after: new Date(deps.now() + LEASE_MS).toISOString() }","{ status: 'processing', attempts: attempts + 1, run_after: new Date(deps.now() + LEASE_MS).toISOString() }"),
 ("M10","提醒時間後才預約也補發","worker/index.js","if (Date.parse(r.createdAt) > remindAt) continue;",""),
 ("M11","已取消預約仍發提醒","worker/index.js","if (!cur || cur.status === 'CANCELLED') return 'skipped:cancelled';","if (!cur) return 'skipped:cancelled';"),
 ("M12","空備份也觸發清理","worker/index.js","if (hasData && file.id) trashed","if (file.id) trashed"),
 ("M13","後台取消不再送事件（server）","server.js","        await emitAdminReservationEvent('reservation.cancelled', item);\n        return json(res, 200, { ok: true, reservation: item });","        return json(res, 200, { ok: true, reservation: item });"),
 ("M14","恢復預約不送事件（server）","server.js","if(integrationEvent) await emitAdminReservationEvent(integrationEvent,item);",""),
 ("M15","公休變更不喚醒 Worker（server）","server.js","invalidateCalendarCaches(); await emitClosureChanged(); return json(res,201,{closure:item});","invalidateCalendarCaches(); return json(res,201,{closure:item});"),
 ("M16","逾時 job 不再略過（舊通知湧入）","worker/index.js","if (deps.now() - Date.parse(job.created_at || 0) > STALE_JOB_MS) return 'skipped:stale';",""),
 ("M17","電話正規化被拿掉","worker/index.js","export function normalizePhoneKey(phone) { return String(phone || '').replace(/\\D/g, ''); }","export function normalizePhoneKey(phone) { return String(phone || ''); }"),
 ("M18","事件改用 payload 快照而非資料庫現況","worker/index.js","const rows = await sb(env, deps, 'reservations', { query: `?id=eq.${enc(id)}&select=*` });\n  const r = normalizeReservation(rows && rows[0]);\n  if (!r || r.status === 'CANCELLED')","const r = normalizeReservation({ id, status: 'CONFIRMED', name: 'x', date: '2026-01-01', startTime: '10:00', endTime: '11:00' });\n  if (!r)"),
 ("M19","日曆對帳不設單輪筆數上限（僅剩請求預算）","worker/index.js","(ops >= maxOps || budgetLeft(env, deps) < OP_COST)","(budgetLeft(env, deps) < OP_COST)"),
 ("M20","每輪 job 數無上限","worker/index.js","const DEFAULT_BATCH = 4;","const DEFAULT_BATCH = 400;"),
 ("M21","/calendar-purge 不需確認字串","worker/index.js","if (body.preview !== true && body.confirm !== 'DELETE-ALL-RONNIE-EVENTS') return","if (false) return"),
 # ── 針對外部審查新增 ──
 ("N1","Webhook 遇暫時性故障仍回 200（LINE 不會重送）","worker/index.js","return transient ? { status: 500, body: { error: 'temporary failure; please redeliver' } } : { status: 200, body: { ok: true } };","return { status: 200, body: { ok: true } };"),
 ("N2","移除猜碼次數限制","worker/index.js","if (att.count >= BIND_MAX_BAD_ATTEMPTS) {","if (false) {"),
 ("N3","領取綁定碼不檢查過期","worker/index.js","&expires_at=gte.${enc(nowIso)}`","`"),
 ("N4","expires_at 無效日期當成有效","worker/index.js"," || !Number.isFinite(Date.parse(t.expires_at))",""),
 ("N5","綁定寫入失敗不還原綁定碼","worker/index.js","try { await sb(env, deps, 'line_bind_tokens', { method: 'POST', query: '?on_conflict=code'","try { if (false) await sb(env, deps, 'line_bind_tokens', { method: 'POST', query: '?on_conflict=code'"),
 ("N6","reply 失敗不改用 push 補送","worker/index.js","if (await lineReply(env, deps, ev.replyToken, text)) return;","await lineReply(env, deps, ev.replyToken, text); return;"),
 ("N7","LINE 重送事件不辨識（重複事件回「無效」）","worker/index.js","if (ev.webhookEventId) {\n      const done","if (false) {\n      const done"),
 ("N8","對外請求不設逾時","worker/index.js","opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(ms) }","opts"),
 ("N9","備份不檢查必要設定","worker/index.js","  assertConfig(env, 'FEATURE_BACKUP');\n",""),
 ("N10","清除預覽模式也會刪除","worker/index.js","  if (preview) {\n    return { preview: true","  if (false) {\n    return { preview: true"),
 ("N11","清除不再逐筆驗證 ronnie=1 標記","worker/index.js","const own = e => e.extendedProperties?.private?.ronnie === '1';","const own = e => true;"),
 ("N12","job 錯誤記錄失敗會中斷整輪","worker/index.js","    } catch (persistError) {","    } catch (persistError) { throw persistError;"),
 ("N13","preflight 漏清 integration_jobs 測試列（含重複寫入的列）","worker/preflight.mjs","  { label: `integration_jobs dedupe_key=${dk}`, table: 'integration_jobs', filter: `dedupe_key=eq.${encodeURIComponent(dk)}` },\n",""),
 ("N14","匯出端點不留存取紀錄（server）","server.js","console.log(`[integration] export accessed ${new Date().toISOString()}`);",""),
 ("N15","綁定碼改為先查後刪（非原子）","worker/index.js","method: 'DELETE', query: `?code=eq.${enc(code)}&expires_at=gte.${enc(nowIso)}`, prefer: 'return=representation',\n  });","method: 'GET', query: `?code=eq.${enc(code)}&expires_at=gte.${enc(nowIso)}`,\n  }); await sb(env, deps, 'line_bind_tokens', { method: 'DELETE', query: `?code=eq.${enc(code)}` });"),
 # ── 針對第二輪審查新增 ──
 ("P1","日曆清除不截斷批次（信任 API 回傳筆數）","worker/index.js","const items = all.slice(0, n);","const items = all;"),
 ("P2","日曆清除不做刪除後驗證","worker/index.js","if (deleted > 0 && budgetLeft(env, deps) >= 1) {","if (false) {"),
 ("P3","日曆清除不看請求預算","worker/index.js","if (budgetLeft(env, deps) < 3) { stoppedBy = 'budget'; break; }",""),
 ("P4","job 處理不看請求預算","worker/index.js","if (budgetLeft(env, deps) < JOB_COST) {","if (false) {"),
 ("P5","日曆對帳不看請求預算","worker/index.js","(ops >= maxOps || budgetLeft(env, deps) < OP_COST)","(ops >= maxOps)"),
 ("P6","預算不隨每次執行重算","worker/index.js","function freshBudget(deps) { return { ...deps, state: { ...deps.state, subrequests: 0 } }; }","function freshBudget(deps) { return deps; }"),
 ("P7","對外請求不計數","worker/index.js","  deps.state.subrequests = (deps.state.subrequests || 0) + 1;",""),
 ("P8","preflight 把「略過」記成通過","worker/preflight.mjs","for (const n of UNVERIFIED_IN_READONLY) add(n, 'skip',","for (const n of UNVERIFIED_IN_READONLY) add(n, 'pass',"),
 ("P9","preflight 漏清 app_state 測試列","worker/preflight.mjs","    { label: `app_state key=${stateKey}`, table: 'app_state', filter: `key=eq.${encodeURIComponent(stateKey)}` },\n",""),
 ("P10","preflight 不驗證綁定碼唯一約束","worker/preflight.mjs","return { pass: isDup(r), detail: r.ok ? '重複寫入竟然成功：綁定碼","return { pass: true, detail: r.ok ? '重複寫入竟然成功：綁定碼"),
 ("P11","preflight 不驗證 on_conflict=code","worker/preflight.mjs","return { pass: r.ok, detail: err(r) + '（沒有 code","return { pass: true, detail: err(r) + '（沒有 code"),
 ("P12","preflight 不驗證原子領取回傳列","worker/preflight.mjs","if (!first.ok || !Array.isArray(first.json) || first.json.length !== 1) return","if (false) return"),
 ("P13","preflight 清理失敗不回報殘留","worker/preflight.mjs","if (residual.length) add('測試資料清理', 'fail'","if (false) add('測試資料清理', 'fail'"),
 ("P14","preflight 有略過時結束碼仍為 0","worker/preflight.mjs","exitCode: fail ? 1 : skip ? 2 : 0","exitCode: fail ? 1 : 0"),
 # ── 針對第三輪審查新增（串流備份、警示、Webhook 期限、排程守門）──
 ("Q1","備份退回「解碼再上傳」（不走串流）","worker/index.js","const streamable = modeWanted !== 'buffered' && ","const streamable = false && "),
 ("Q2","不驗證 Drive 上傳大小","worker/index.js","if (file.size !== undefined && Number(file.size) !== expectedBytes) {","if (false) {"),
 ("Q3","備份重試不做每日冪等","worker/index.js","if (reason === 'cron' && m === 'on') {","if (false) {"),
 ("Q4","警示不節流（每次都發）","worker/index.js","if (last && deps.now() - last < minIntervalMs) return 'throttled';",""),
 ("Q5","第一次備份失敗就通知（雜訊）","worker/index.js","cron === CRONS.backups[CRONS.backups.length - 1]","true"),
 ("Q6","Webhook 取消 2 秒期限（一律等處理完）","worker/index.js","const first = await Promise.race([work, timeout]);","const first = await work;"),
 ("Q7","備份 cron 誤設成 UTC 17:00（=台北凌晨 1 點）","worker/wrangler.toml",'"0 19 * * *"','"0 17 * * *"'),
 ("Q8","串流上限不檢查","worker/index.js","const max = Number(env.BACKUP_STREAM_MAX_BYTES) || DEFAULT_STREAM_MAX_BYTES;\n    if (len > max) {","const max = Number(env.BACKUP_STREAM_MAX_BYTES) || DEFAULT_STREAM_MAX_BYTES;\n    if (false) {"),
 ("Q9","緩衝模式大小上限不檢查（標頭）","worker/index.js","if (Number.isFinite(len) && len > max) { await discard(res); throw new Error(tooBig(len)); }",""),
 ("Q10","緩衝模式大小上限不檢查（內容）","worker/index.js","if (text.length > max) throw new Error(tooBig(text.length));",""),
 ("Q11","Google 授權失效不通知","worker/index.js","deps.state.googleAuthFailed = true;",""),
 ("Q12","任務重試用盡不通知","worker/index.js","if (final) deps.state.failedJobs = (deps.state.failedJobs || 0) + 1;",""),
 ("Q13","Render 匯出不送格式標頭（server）","server.js","        'X-Export-Format': 'RONNIE_HEALING_SPACE_BACKUP',\n",""),
 ("Q14","串流 PUT 不帶 Content-Length（變成 chunked）","worker/index.js","'Content-Length': String(len), Authorization: `Bearer ${token}` }","Authorization: `Bearer ${token}` }"),
 ("Q15","dry 模式仍會上傳","worker/index.js","if (m === 'dry') {      // dry：只讀取回應標頭","if (false) {      // dry：只讀取回應標頭"),
 ("Q16","大量預約不警告 CPU 風險","worker/index.js","if (desired.size > 300) {","if (false) {"),
 ("Q17","未知 cron 被當成備份執行","worker/index.js","if (CRONS.backups.includes(cron)) {","if (CRONS.backups.includes(cron) || cron !== CRONS.tick) {"),
 # ── 部分成功修正 / Render 代理壓縮（第四輪）──
 ("R1","附加動作失敗改回丟錯（API 回 500）","server.js","console.warn(`[integration] ${label} failed after ${attempt + 1} attempt(s) (non-fatal): ${error.message}`);\n      return null;","console.warn(`[integration] ${label} failed after ${attempt + 1} attempt(s) (non-fatal): ${error.message}`);\n      throw error;"),
 ("R2","附加動作不重試","server.js","async function bestEffortIntegration(label, fn, retries = 1) {","async function bestEffortIntegration(label, fn, retries = 0) {"),
 ("R3","建立預約的綁定碼失敗仍會讓 API 失敗","server.js","await bestEffortIntegration('line bind token', () => createLineBindToken(item));","await createLineBindToken(item);"),
 ("R4","建立預約的任務失敗仍會讓 API 失敗","server.js","await bestEffortIntegration('enqueue reservation.created', () => enqueueIntegrationJob('reservation.created', item));","await enqueueIntegrationJob('reservation.created', item);"),
 ("R5","客人取消的任務失敗仍會讓 API 失敗","server.js","await bestEffortIntegration('enqueue reservation.cancelled', () => enqueueIntegrationJob('reservation.cancelled', item));","await enqueueIntegrationJob('reservation.cancelled', item);"),
 ("R6","客人修改的任務失敗仍會讓 API 失敗","server.js","await bestEffortIntegration('enqueue reservation.updated', () => enqueueIntegrationJob('reservation.updated', item));","await enqueueIntegrationJob('reservation.updated', item);"),
 ("R7","匯出不送 X-Export-Bytes（server）","server.js","        'X-Export-Bytes': Buffer.byteLength(exportBody),",""),
 ("R8","Worker 不使用 X-Export-Bytes（只看 Content-Length）","worker/index.js","const len = Number.isFinite(hdrNum('x-export-bytes')) && hdrNum('x-export-bytes') > 0 ? hdrNum('x-export-bytes') : hdrNum('content-length');","const len = hdrNum('content-length');"),
 ("R9","Worker 不要求不壓縮","worker/index.js","'X-Integration-Secret': env.INTEGRATION_WORKER_SECRET, 'Accept-Encoding': 'identity' },","'X-Integration-Secret': env.INTEGRATION_WORKER_SECRET },"),
 ("R10","Worker 不檢查回應是否被壓縮","worker/index.js","const identityBody = enc_ === '' || enc_ === 'identity';","const identityBody = true;"),
]

def copy_tree(dst):
    shutil.copytree(ROOT,dst,ignore=shutil.ignore_patterns('.git','node_modules','data','*.mutbak'))
def run_tests(cwd,timeout=240):
    t=time.time()
    try:
        p=subprocess.run(TEST_CMD.format(flag=FLAG),shell=True,cwd=cwd,capture_output=True,text=True,timeout=timeout); out=p.stdout+p.stderr; rc=p.returncode
    except subprocess.TimeoutExpired: return dict(rc=124,passed=0,failed=-1,secs=time.time()-t,timeout=True)
    g=lambda k:int((re.search(rf"^(?:# |ℹ ){k} (\d+)",out,re.M) or [0,0])[1])
    return dict(rc=rc,passed=g('pass'),failed=g('fail'),secs=time.time()-t,timeout=False)
def one(m):
    mid,name,f,old,new=m; d=tempfile.mkdtemp(prefix='mut-'); work=os.path.join(d,'p')
    try:
        copy_tree(work); path=os.path.join(work,f); s=open(path,encoding='utf-8').read()
        if old not in s: return (mid,name,'BAD','找不到要突變的程式碼（請更新本腳本）',0)
        open(path,'w',encoding='utf-8').write(s.replace(old,new,1))
        r=run_tests(work)
        caught = r['rc']!=0 or r['failed']!=0
        return (mid,name,'CAUGHT' if caught else 'SURVIVED',('逾時' if r['timeout'] else f"fail={r['failed']}"),r['secs'])
    finally: shutil.rmtree(d,ignore_errors=True)

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('-j',type=int,default=max(1,min(4,(os.cpu_count() or 2)//2)),help='平行數（預設：CPU 核心數的一半，最多 4；核心少時平行反而更慢）'); ap.add_argument('--only'); ap.add_argument('--list',action='store_true'); a=ap.parse_args()
    if a.list:
        for m in MUT: print(m[0],m[1])
        sys.exit(0)
    muts=[m for m in MUT if not a.only or m[0] in a.only.split(',')]
    t0=time.time(); d=tempfile.mkdtemp(prefix='base-'); base=os.path.join(d,'p'); copy_tree(base); b=run_tests(base); shutil.rmtree(d,ignore_errors=True)
    print(f"基準線：pass={b['passed']} fail={b['failed']} 結束碼={b['rc']}（{b['secs']:.0f}s）",flush=True)
    if b['rc']!=0 or b['failed']!=0: sys.exit("基準線本身就有失敗，請先修好測試")
    bad=[]
    with cf.ThreadPoolExecutor(max_workers=max(1,a.j)) as ex:
        for mid,name,st,detail,secs in ex.map(one,muts):
            print(f"{'已抓到 ' if st=='CAUGHT' else '★'+st+' '} {mid:4s}{name}  ({detail}, {secs:.0f}s)",flush=True)
            if st!='CAUGHT': bad.append(mid)
    print(f"\n結果：{len(muts)-len(bad)}/{len(muts)} 個突變被測試抓到（總耗時 {time.time()-t0:.0f}s）"+("" if not bad else f"；未通過：{bad}"))
    sys.exit(1 if bad else 0)
