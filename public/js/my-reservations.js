// 我的預約（2c）：所有操作透過事件委派（CSP 相容，無內嵌事件）；寫入一律附 X-Requested-With 標頭。
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { list: [], changeId: null, change: null, startTime: null, available: [] };
  const notice = (msg, isError) => { const n = $('notice'); n.textContent = msg; n.classList.toggle('hidden', !msg); n.style.background = isError ? '#f8e1e1' : '#efe8f7'; };
  async function api(path, opts = {}) {
    const headers = { 'X-Requested-With': 'fetch' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, { method: opts.method || 'GET', credentials: 'same-origin', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(data.error || `請求失敗（${r.status}）`); err.status = r.status; throw err; }
    return data;
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  async function loadList() {
    const data = await api('/api/my/reservations');
    state.list = data.reservations || [];
    show('listBox', true);
    $('listBox').innerHTML = state.list.length
      ? state.list.map(x => `<div class="card"><b>${esc(x.date)} ${esc(x.startTime)}–${esc(x.endTime)}</b><div class="meta">${esc(x.serviceName)}（${esc(x.durationMinutes)} 分鐘）${x.status === 'CONFIRMED' ? '' : '｜' + esc(x.status)}</div>`
        + `<div class="actions"><button class="secondary" data-act="change" data-id="${esc(x.id)}">改期</button><button class="danger" data-act="cancel" data-id="${esc(x.id)}">取消預約</button></div></div>`).join('')
      : '<div class="card">目前沒有即將到來的預約。</div>';
  }
  async function init() {
    const s = await api('/api/my/session');
    if (!s.loggedIn) { show('loginBox', true); return; }
    show('logoutBtn', true);
    await loadList();
  }
  async function cancelRes(id) {
    if (!confirm('確定要取消這筆預約嗎？取消後該時段會重新開放。')) return;
    try { await api(`/api/my/reservations/${encodeURIComponent(id)}/cancel`, { method: 'PATCH', body: {} }); notice('預約已取消。'); await loadList(); }
    catch (e) { notice(e.message, true); }
  }
  function openChange(id) {
    const x = state.list.find(r => r.id === id); if (!x) return;
    state.changeId = id; state.change = x; state.startTime = null;
    $('changeCurrent').textContent = `目前：${x.date} ${x.startTime}–${x.endTime}｜${x.serviceName}`;
    $('changeDate').value = x.date; $('changeDate').min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    $('saveChangeBtn').disabled = true; show('changeBox', true); loadSlots();
  }
  function closeChange() { state.changeId = null; state.change = null; state.startTime = null; show('changeBox', false); }
  async function loadSlots() {
    if (!state.change) return;
    state.startTime = null; $('saveChangeBtn').disabled = true; $('slots').innerHTML = '';
    const date = $('changeDate').value;
    if (!date) return;
    try {
      const d = await api(`/api/my/availability?date=${encodeURIComponent(date)}&serviceId=${encodeURIComponent(state.change.serviceId)}&reservationId=${encodeURIComponent(state.changeId)}`);
      $('slotHint').textContent = d.closed ? '此日期無法預約。' : '請選擇開始時間。';
      state.available = d.available || [];
      (d.slots || []).forEach(t => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'secondary slot'; b.textContent = t; b.dataset.time = t;
        b.dataset.act = 'pickSlot';
        if (!state.available.includes(t)) { b.disabled = true; b.style.opacity = '.4'; }
        $('slots').appendChild(b);
      });
    } catch (e) { $('slotHint').textContent = e.message; }
  }
  function pickSlot(el) {
    state.startTime = el.dataset.time;
    document.querySelectorAll('.slot').forEach(b => b.classList.toggle('selected', b === el));
    $('saveChangeBtn').disabled = false;
  }
  async function saveChange() {
    if (!state.changeId || !state.startTime) return;
    try {
      await api(`/api/my/reservations/${encodeURIComponent(state.changeId)}/update`, { method: 'PATCH', body: { date: $('changeDate').value, serviceId: state.change.serviceId, startTime: state.startTime } });
      notice('已完成改期。'); closeChange(); await loadList();
    } catch (e) { notice(e.message, true); await loadSlots(); }
  }
  async function logout() {
    await api('/api/my/logout', { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  }
  const ACTIONS = {
    cancel: el => cancelRes(el.dataset.id),
    change: el => openChange(el.dataset.id),
    closeChange: () => closeChange(),
    pickSlot: el => pickSlot(el),
    saveChange: () => saveChange(),
    logout: () => logout(),
  };
  document.addEventListener('click', e => {
    const el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (el && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el);
  });
  document.addEventListener('change', e => { if (e.target && e.target.id === 'changeDate') loadSlots(); });
  init().catch(e => notice(e.message, true));
})();
