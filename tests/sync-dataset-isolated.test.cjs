const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('async function readSupabaseSnapshot(table) {');
const end = source.indexOf('\nasync function flushStorage()', start);
assert(start >= 0 && end > start, 'syncDataset source located');
const functionSource = source.slice(start, end);

async function runScenario(name, configure, data = [{id:'new-1',name:'new'}]) {
  const state = {
    tables: { reservations: [{id:'old-1',name:'old'}], customers: [], closures: [], app_state: [{key:'reservation_meta',value:{old:{myNote:'old note'}}}] },
    calls: [], dirty: new Set(['reservations']), fail: {},
  };
  configure(state);
  const context = {
    STORAGE_MODE: 'supabase', dirtyDatasets: state.dirty,
    supabaseRowFromReservation: x => x,
    supabaseRowFromCustomer: x => x,
    supabaseRowFromClosure: x => x,
    saveReservationMetaToSupabase: async rows => {
      await context.supabaseRequest('app_state','DELETE',null,'?key=eq.reservation_meta');
      if (state.fail.metaPost) { state.fail.metaPost = false; throw new Error('injected meta POST failure'); }
      await context.supabaseRequest('app_state','POST',{key:'reservation_meta',value:Object.fromEntries(rows.filter(x=>x.myNote).map(x=>[x.id,{myNote:x.myNote}])),updated_at:'test'});
    },
    supabaseRequest: async function(table, method='GET', body=null, query='') {
      state.calls.push({table,method,query});
      const failKey = `${method}:${table}`;
      if (state.fail[failKey]) { state.fail[failKey]--; throw new Error(`injected ${failKey} failure`); }
      if (method === 'GET') {
        if (table === 'app_state') return state.tables.app_state.filter(r => query.includes('reservation_meta') ? r.key==='reservation_meta' : true).map(r=>({...r}));
        const sorted = [...state.tables[table]].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
        const offset = Number((query.match(/offset=(\\d+)/)||[])[1] || 0);
        const limit = Number((query.match(/limit=(\\d+)/)||[])[1] || sorted.length || 1);
        return sorted.slice(offset, offset + limit).map(r=>({...r}));
      }
      if (method === 'DELETE') {
        if (table === 'app_state') state.tables.app_state = state.tables.app_state.filter(r=>r.key!=='reservation_meta');
        else state.tables[table] = [];
        return [];
      }
      if (method === 'POST') {
        if (table === 'app_state') state.tables.app_state.push(...(Array.isArray(body)?body:[body]));
        else state.tables[table].push(...(Array.isArray(body)?body:[body]));
        return body;
      }
      throw new Error('unsupported method');
    }
  };
  const fn = new Function('context', `with(context) { return (async () => { const { STORAGE_MODE, dirtyDatasets, supabaseRequest, supabaseRowFromReservation, supabaseRowFromCustomer, supabaseRowFromClosure, saveReservationMetaToSupabase } = context; ${functionSource}; return syncDataset; })(); }`);
  const syncDataset = await fn(context);
  let error = null;
  try { await syncDataset('reservations', data); } catch(e) { error = e; }
  return {name,state,error};
}
(async()=>{
  let r = await runScenario('success',()=>{});
  assert.equal(r.error,null); assert.deepEqual(r.state.tables.reservations.map(x=>x.id),['new-1']); assert.equal(r.state.dirty.has('reservations'),false);
  console.log('PASS success: new snapshot written and dirty flag cleared');

  r = await runScenario('write failure restores old rows',s=>{s.fail['POST:reservations']=1;});
  assert.match(r.error.message,/previous data restored/); assert.deepEqual(r.state.tables.reservations.map(x=>x.id),['old-1']); assert.equal(r.state.dirty.has('reservations'),true);
  console.log('PASS write failure: prior rows restored; dataset remains dirty');

  r = await runScenario('read failure no mutation',s=>{s.fail['GET:reservations']=1;});
  assert.match(r.error.message,/injected GET:reservations/); assert.deepEqual(r.state.tables.reservations.map(x=>x.id),['old-1']); assert.equal(r.state.calls.some(x=>x.method==='DELETE'),false);
  console.log('PASS read failure: no DELETE issued');

  r = await runScenario('metadata failure restores both',s=>{s.fail.metaPost=true;});
  assert.match(r.error.message,/previous data restored/); assert.deepEqual(r.state.tables.reservations.map(x=>x.id),['old-1']); assert.deepEqual(r.state.tables.app_state[0].value,{old:{myNote:'old note'}});
  console.log('PASS metadata failure: data and reservation metadata restored');

  r = await runScenario('rollback incomplete reported',s=>{s.fail['POST:reservations']=1; s.fail['POST:app_state']=1;});
  assert.match(r.error.message,/rollback incomplete/); assert.equal(r.state.dirty.has('reservations'),true);
  console.log('PASS rollback incomplete: explicit error reported; dirty flag retained');

  r = await runScenario('empty snapshot keeps existing clear semantics',()=>{},[]);
  assert.equal(r.error,null); assert.deepEqual(r.state.tables.reservations,[]); assert.equal(r.state.dirty.has('reservations'),false);
  console.log('PASS empty snapshot: table cleared (existing behavior preserved)');

  const many = Array.from({length: 1207}, (_,i)=>({id:`id-${String(i).padStart(4,'0')}`,name:`row-${i}`}));
  r = await runScenario('pagination over 500 rows',s=>{s.tables.reservations=many;},[{id:'new-1',name:'new'}]);
  const getCalls = r.state.calls.filter(x=>x.method==='GET' && x.table==='reservations');
  assert.equal(getCalls.length,3,'1207 rows should be read in three pages');
  assert.ok(getCalls.every(x=>x.query.includes('order=id.asc')),'all snapshot pages use stable id ordering');
  assert.equal(r.error,null);
  console.log('PASS pagination: 1207 prior rows read over 3 ordered pages');
})().catch(e=>{ console.error(e); process.exit(1); });
