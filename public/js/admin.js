(function () {
  // 以頁面內提示框取代瀏覽器原生 alert（原生框會顯示網址）；不阻塞執行，與原本的 alert 用法相容
  function ensureNotice() {
    let box = document.getElementById('pageNotice');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'pageNotice';
    box.className = 'pageNotice hidden';
    box.innerHTML = '<div class="pageNoticeCard"><div class="pageNoticeText" id="pageNoticeText"></div><button type="button" class="pageNoticeOk" id="pageNoticeOk">確定</button></div>';
    document.body.appendChild(box);
    document.getElementById('pageNoticeOk').onclick = () => box.classList.add('hidden');
    return box;
  }
  window.alert = function (message) {
    const box = ensureNotice();
    document.getElementById('pageNoticeText').textContent = String(message ?? '');
    box.classList.remove('hidden');
  };
})();

const $ = id => document.getElementById(id);

const api = async (url, opt = {}) => {
  const r = await fetch(url, opt);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '操作失敗');
  return d;
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({
  '&':'&amp;',
  '<':'&lt;',
  '>':'&gt;',
  '"':'&quot;',
  "'":'&#039;'
}[m]));

let calendarMonth = new Date();
let customers = [];

function filterCustomersByPhone() {
  const q = String($('customerSearch').value || '').replace(/\D/g, '');
  return q
    ? customers.filter(c => String(c.phone || '').replace(/\D/g, '').includes(q))
    : customers;
}

function showLogin() {
  $('adminPanel').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('loginPanel').classList.remove('hidden');
}

async function exportData() {
  try {
    const r = await fetch('/api/admin/export');
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || '匯出失敗');
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Ronnie’s Witchery Corner-backup-v2-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

function showImportConfirm() {
  return new Promise(resolve => {
    const modal = $('importConfirmModal');
    const ok = $('importConfirm');
    const cancel = $('importCancel');
    const close = value => {
      modal.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      modal.removeEventListener('click', onBackdrop);
      resolve(value);
    };
    const onBackdrop = e => {
      if (e.target === modal) close(false);
    };
    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    modal.addEventListener('click', onBackdrop);
    modal.classList.remove('hidden');
    ok.focus();
  });
}

function showAdminActionConfirm(message, yesText = '確定') {
  return new Promise(resolve => {
    const modal = $('importConfirmModal');
    const text = $('importConfirmText');
    const ok = $('importConfirm');
    const cancel = $('importCancel');
    const oldText = text.textContent;
    const oldOkText = ok.textContent;

    text.textContent = message;
    ok.textContent = yesText;

    const close = value => {
      modal.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      modal.removeEventListener('click', onBackdrop);
      text.textContent = oldText;
      ok.textContent = oldOkText;
      resolve(value);
    };

    const onBackdrop = e => {
      if (e.target === modal) close(false);
    };

    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    modal.addEventListener('click', onBackdrop);
    modal.classList.remove('hidden');
    ok.focus();
  });
}

async function importDataFromFile(file) {
  if (!file) return;
  try {
    if (!await showImportConfirm()) return;

    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('JSON 備份檔格式錯誤，無法讀取');
    }

    const r = await fetch('/api/admin/import', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });

    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '匯入失敗');

    uiAlert(`匯入完成\n預約：${d.reservations} 筆\n客人檔案：${d.customers} 筆\n公休：${d.closures} 筆`);

    adminCalendarCache.clear();
    await loadCalendar(true);
    await loadAdmin();
    await loadCustomers();
    await loadClosures();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  } finally {
    $('importFile').value = '';
  }
}

function showTab(name) {
  if (name === 'customer') crmView = { mode: 'list', id: null, tab: 'overview', filter: 'all', openRes: null };
  if (name === 'customer' && Array.isArray(customers) && typeof renderCustomers === 'function') renderCustomers();
  if (name === 'reservation') name = 'calendar'; // 合併行事曆（單一分頁）
  ['calendar','reservation','customer','closure','service','recycle','backup'].forEach(x => {
    $(x + 'View').classList.toggle('hidden', x !== name);
  });

  $('tabCalendar').classList.toggle('active', name === 'calendar');
  $('tabReservations').classList.toggle('active', name === 'reservation');
  $('tabCustomers').classList.toggle('active', name === 'customer');
  $('tabClosures').classList.toggle('active', name === 'closure');
  $('tabServices').classList.toggle('active', name === 'service');

  $('tabCalendar').classList.toggle('secondary', name !== 'calendar');
  $('tabReservations').classList.toggle('secondary', name !== 'reservation');
  $('tabCustomers').classList.toggle('secondary', name !== 'customer');
  $('tabClosures').classList.toggle('secondary', name !== 'closure');
  $('tabServices').classList.toggle('secondary', name !== 'service');
  $('tabRecycle').classList.toggle('active', name === 'recycle');
  $('tabRecycle').classList.toggle('secondary', name !== 'recycle');
  if ($('tabBackup')) { $('tabBackup').classList.toggle('active', name === 'backup'); $('tabBackup').classList.toggle('secondary', name !== 'backup'); }
  if (name === 'calendar') $('reservationView').classList.remove('hidden'); // 合併行事曆（單一分頁）：右側當日區一併顯示
}

const adminCalendarCache = new Map();

async function fetchAdminCalendar(y, m, force = false) {
  const key = `${y}-${String(m).padStart(2,'0')}`;
  if (!force && adminCalendarCache.has(key)) return adminCalendarCache.get(key);

  const promise = api(`/api/admin/calendar?year=${y}&month=${m}`);
  if (!force) adminCalendarCache.set(key, promise);

  try {
    return await promise;
  } catch (e) {
    adminCalendarCache.delete(key);
    throw e;
  }
}

function renderAdminCalendar(data) {
  const y = calendarMonth.getFullYear();
  const m = calendarMonth.getMonth() + 1;
  const map = new Map(data.map(x => [x.date, x]));
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();

  let html = [
    '<div class="dow">日</div>',
    '<div class="dow">一</div>',
    '<div class="dow">二</div>',
    '<div class="dow">三</div>',
    '<div class="dow">四</div>',
    '<div class="dow">五</div>',
    '<div class="dow">六</div>'
  ].join('');

  for (let i = 0; i < first; i++) html += '<div></div>';

  for (let d = 1; d <= days; d++) {
    const date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const x = map.get(date);
    const status = String(x?.status || '');
    let eventLabel = labelStatus(status);

    if (status === 'AVAILABLE') eventLabel = '';

    const reservationCount = Number(x?.reservationCount || 0);

    if (
      reservationCount > 0 &&
      status !== 'CLOSED' &&
      
      status !== 'TODAY' &&
      status !== 'PAST' &&
      status !== 'UNAVAILABLE' &&
      status !== 'FULL'
    ) {
      eventLabel = `已預約 ${reservationCount} 筆`;
    } else if (status === 'RESERVED') {
      eventLabel = '已預約';
    }

    // calendarLabelPolish：公休顯示休假原因；過去日期顯示原來資訊；時段公休不顯示
    if (status === 'CLOSED' || status === 'PAST') eventLabel = x?.closureReason || (reservationCount > 0 ? `已預約 ${reservationCount} 筆` : '');

    html += `<button type="button" class="calDay ${status.toLowerCase()}" data-date="${date}" data-booked=\"${reservationCount}\" data-status="${status}"><b>${d}</b><div class="calCount">${esc(eventLabel)}</div></button>`;
  }

  const grid = $('calendarGrid');
  grid.innerHTML = html;

  grid.querySelectorAll('.calDay').forEach(b => {
    b.onclick = () => {
      const status = b.dataset.status;
      if (status === 'UNAVAILABLE') return;
      if (status === 'CLOSED' || (status === 'PARTIAL_CLOSED' && Number(b.dataset.booked || 0) === 0)) {
        window.__focusClosureDate = b.dataset.date;
        showTab('closure');
        loadClosures();
        return;
      }
      $('adminDate').value = b.dataset.date;
      showTab('reservation');
      loadAdmin();
    };
  });
}

async function loadCalendar(force = false) {
  const y = calendarMonth.getFullYear();
  const m = calendarMonth.getMonth() + 1;
  $('monthTitle').textContent = `${y} 年 ${m} 月`;

  const grid = $('calendarGrid');
  grid.setAttribute('aria-busy', 'true');

  if (force) adminCalendarCache.delete(`${y}-${String(m).padStart(2,'0')}`);

  try {
    const data = await fetchAdminCalendar(y, m, force);
    renderAdminCalendar(data);
    grid.setAttribute('aria-busy', 'false');

    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;

    fetchAdminCalendar(py, pm).catch(() => {});
    fetchAdminCalendar(ny, nm).catch(() => {});
  } catch (e) {
    grid.setAttribute('aria-busy', 'false');
    if (e.message === '未登入') {
      showLogin();
      return;
    }
    $('calendarNotice').textContent = e.message;
    $('calendarNotice').classList.remove('hidden');
  }
}

function labelStatus(s) {
  return ({
    AVAILABLE:'可預約',
    PARTIAL:'部分預約',
    RESERVED:'已預約',
    FULL:'滿額',
    CLOSED:'公休',
    PARTIAL_CLOSED:'部分公休',
    TODAY:'當日不可預約',
    PAST:'過去',
    UNAVAILABLE:'不可預約'
  })[s] || '';
}

/*
 * 統一取消狀態：
 * 1. status === CANCELLED
 * 2. statusLabel === Cancel
 * 3. statusLabel === CANCELLED
 * 上述三種情況都視為已取消預約。
 */
function isCancelledReservation(x) {
  if (!x) return false;

  const status = String(x.status || '').trim().toUpperCase();
  const statusLabel = String(x.statusLabel || '').trim().toUpperCase();

  return status === 'CANCELLED' ||
         statusLabel === 'CANCEL' ||
         statusLabel === 'CANCELLED';
}

/*
 * 網站統一時區：Asia/Taipei。
 * 回傳「台北當下的牆上時間」，以 Date.UTC 編碼成可比較的數值，
 * 與 reservationDateTimeKey() 使用相同編碼方式，不受瀏覽器所在時區影響。
 */
function taipeiNowKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());

  const get = type => Number(parts.find(p => p.type === type)?.value || 0);

  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/* 預約結束時間（台北牆上時間編碼）；無法解析則回傳 null */
function reservationEndKey(x) {
  return reservationDateTimeKey({ date: x?.date, startTime: x?.endTime });
}

function isExpiredReservation(x) {
  if (!x) return false;

  // 先判斷取消，已取消預約不列入過期分類
  if (isCancelledReservation(x)) return false;

  const endKey = reservationEndKey(x);
  if (endKey === null) return false;

  // 結束時間「之後」才算過期：10:00:00 整仍未過期，10:00:01 起為過期
  return taipeiNowKey() > endKey;
}

function displayStatus(x) {
  // 1. Cancel 與 CANCELLED 統一顯示
  if (isCancelledReservation(x)) return 'CANCELLED';

  // 2. 已選擇的預定狀態優先（Finished / No-show / Other…），過期預約也一樣
  if (x.statusLabel) {
    return x.statusLabel === 'Other' && x.otherStatus
      ? x.otherStatus
      : x.statusLabel;
  }

  // 3. 已過期且尚未選擇狀態：預設顯示 Finished
  if (isExpiredReservation(x)) return 'Finished';

  return x.status || '';
}

/*
 * 將預約日期與開始時間轉成可比較的數值。
 * 有效格式：
 * date：YYYY-MM-DD
 * startTime：H:mm、HH:mm 或 HH:mm:ss
 */
function reservationDateTimeKey(x) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    String(x?.date || '')
  );
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(x?.startTime || '').trim()
  );

  if (!d || !t) return null;

  const y = Number(d[1]);
  const m = Number(d[2]);
  const day = Number(d[3]);
  const h = Number(t[1]);
  const min = Number(t[2]);
  const sec = Number(t[3] || 0);

  if (
    m < 1 || m > 12 ||
    day < 1 || day > 31 ||
    h < 0 || h > 23 ||
    min < 0 || min > 59 ||
    sec < 0 || sec > 59
  ) {
    return null;
  }

  // 防止 2026-02-31 這類不存在的日期被當成有效日期
  const checkDate = new Date(Date.UTC(y, m - 1, day));

  if (
    checkDate.getUTCFullYear() !== y ||
    checkDate.getUTCMonth() !== m - 1 ||
    checkDate.getUTCDate() !== day
  ) {
    return null;
  }

  return Date.UTC(y, m - 1, day, h, min, sec);
}

/*
 * direction = 1：日期時間由早到晚
 * direction = -1：日期時間由晚到早
 * 無法解析時使用原始日期時間字串作為後備排序。
 */
function compareReservationDateTime(a, b, direction = 1) {
  const ka = reservationDateTimeKey(a);
  const kb = reservationDateTimeKey(b);

  if (ka !== null && kb !== null && ka !== kb) {
    return direction * (ka - kb);
  }

  const sa = `${a?.date || ''} ${a?.startTime || ''}`;
  const sb = `${b?.date || ''} ${b?.startTime || ''}`;

  return direction * sa.localeCompare(sb);
}

window.__adminAccordionOpen = window.__adminAccordionOpen || { expired: false, cancelled: false };

function renderAccordion(key, title, arr, cardsHtml) {
  if (!arr.length) return '';

  return `
    <details class="adminAccordion" data-accordion="${key}" ${window.__adminAccordionOpen[key] ? 'open' : ''}
             data-toggle-for="adminAccordion" data-key="${esc(key)}">
      <summary><span>${title}</span><span class="accCount">${arr.length}</span></summary>
      ${cardsHtml(arr)}
    </details>
  `;
}

function renderBookingCard(x) {
  const isCancelled = isCancelledReservation(x);
  const isExpired = !isCancelled && isExpiredReservation(x);
  const eid = encodeURIComponent(x.id);

  return `
    <div class="booking ${isCancelled ? 'cancelled' : ''} ${isExpired ? 'expired' : ''}">
      <div>
        <b>${esc(x.name)}</b>
        ${x.lineBound ? '<span class="status">已綁定 LINE</span>' : ''}
        ${
          Array.isArray(x.tags) && x.tags.length
            ? x.tags.map(t => `<span class="tag">${esc(t)}</span>`).join(' ')
            : ''
        }
        <br>
        預約日期：${esc(x.date)} ·
        ${esc(x.startTime)}–${esc(x.endTime)}
        <br>
        ${esc(x.serviceName)}
        <div class="muted">
          <span class="status" id="statusBadge-${eid}">${esc(displayStatus(x))}</span>
        </div>
      </div>

      <div class="bookingActions">
        <button class="secondary" data-act="showDetail" data-args="${esc(JSON.stringify([eid]))}">查看資料</button>
        ${
          !isCancelled && !isExpired
            ? `<button class="danger" data-act="cancelBooking" data-args="${esc(JSON.stringify([eid]))}">取消預約</button>`
            : `<button class="danger" data-act="deleteReservation" data-args="${esc(JSON.stringify([eid]))}">刪除</button>`
        }
      </div>

      <div id="detail-${eid}" class="inlineDetail"></div>
    </div>
  `;
}

/* 點選預定狀態時，即時同步卡片上服務下方的狀態標籤 */
function previewReservationStatus(v) {
  const x = window.currentDetailReservation;
  if (!x) return;

  const badge = $('statusBadge-' + encodeURIComponent(x.id));
  if (!badge) return;

  const other = v === 'Other' ? ($('otherStatusInput')?.value.trim() || '') : '';
  badge.textContent = displayStatus({ ...x, statusLabel: v, otherStatus: other });
}

/* 關閉詳細資料（未儲存）時，標籤還原為已儲存的狀態 */
function restoreStatusBadge(id) {
  const x = (window.__detailOriginals || {})[decodeURIComponent(id)];
  const badge = $('statusBadge-' + id);
  if (x && badge) badge.textContent = displayStatus(x);
}

function closeReservationDetail(btn) {
  const box = btn.closest('.inlineDetail');
  if (!box) return;
  restoreStatusBadge(box.id.replace(/^detail-/, ''));
  box.innerHTML = '';
}

async function loadAdmin() {
  try {
    const date = $('adminDate').value;

    let list = await api(
      '/api/admin/reservations' +
      (date ? '?date=' + encodeURIComponent(date) : '')
    );

    // 第一區：未取消、尚未逾期，日期時間由早到晚
    const active = list
      .filter(x =>
        !isCancelledReservation(x) &&
        !isExpiredReservation(x)
      )
      .sort((a, b) => compareReservationDateTime(a, b, 1));

    // 第二區：未取消、已逾期，日期時間由晚到早
    const expired = list
      .filter(x =>
        !isCancelledReservation(x) &&
        isExpiredReservation(x)
      )
      .sort((a, b) => compareReservationDateTime(a, b, -1));

    // 第三區：已取消，日期時間由晚到早
    const cancelled = list
      .filter(x => isCancelledReservation(x))
      .sort((a, b) => compareReservationDateTime(a, b, -1));

    // 依照三個區塊的順序合併
    list = [...active, ...expired, ...cancelled];

    // 記錄本次畫面上的分類，供自動重新分類檢查使用
    window.__adminRenderedList = list;
    window.__adminRenderedExpired = new Set(expired.map(x => x.id));

    const cardsHtml = arr => `<div class="admin-list">${arr.map(renderBookingCard).join('')}</div>`;

    // 未選擇特定日期：第二區（Expired）、第三區（Cancelled）使用折疊面板
    const useAccordion = !date;

    if (!list.length) {
      $('adminContent').innerHTML = '目前沒有預約紀錄。';
    } else if (useAccordion) {
      $('adminContent').innerHTML =
        (active.length ? cardsHtml(active) : '') +
        renderAccordion('expired', 'Expired', expired, cardsHtml) +
        renderAccordion('cancelled', 'Cancelled', cancelled, cardsHtml);
    } else {
      // 已選擇日期：維持單一清單（三區順序不變）
      $('adminContent').innerHTML = dayRowsHtml(list) + (date ? closureRowsHtml(await loadPartialClosures(date)) : '');
    }

  } catch (e) {
    if (e.message === '未登入') {
      showLogin();
      return;
    }

    $('adminContent').innerHTML = `<p>${esc(e.message)}</p>`;
  }
}

/*
 * 預約時間經過後自動重新分類（未過期 → 已過期，並隱藏取消按鍵）。
 * 每 15 秒檢查一次；只有分類真的改變、且沒有展開中的詳細資料時才重新載入，
 * 避免打斷正在編輯的備註。
 */
setInterval(() => {
  const list = window.__adminRenderedList;
  const rendered = window.__adminRenderedExpired;
  if (!Array.isArray(list) || !(rendered instanceof Set)) return;

  const hasOpenDetail = [...document.querySelectorAll('.inlineDetail')]
    .some(el => el.innerHTML.trim());
  if (hasOpenDetail) return;

  const changed = list.some(x =>
    !isCancelledReservation(x) &&
    isExpiredReservation(x) !== rendered.has(x.id)
  );

  if (changed) loadAdmin();
}, 15000);

async function showDetail(id) {
  const existing = $('detail-' + id);
  if (existing && existing.innerHTML.trim()) {
    restoreStatusBadge(id);
    existing.innerHTML = '';
    return;
  }

  try {
    const list = await api('/api/admin/reservations');
    const x = list.find(a => a.id === decodeURIComponent(id));
    if (!x) return;

    const noteValue = String(x.myNote || '').replace(/"/g, '&quot;');
    const tags = Array.isArray(x.tags) ? x.tags : [];
    // 已過期且尚未選擇狀態時，預設選取 Finished（與列表顯示一致）
    const status = isCancelledReservation(x)
      ? 'Cancel'
      : (x.statusLabel || (isExpiredReservation(x) ? 'Finished' : ''));
    const lockedCancelled = isCancelledReservation(x);

    window.currentDetailReservation = x;
    window.__detailOriginals = window.__detailOriginals || {};
    window.__detailOriginals[x.id] = x;

    const detailBox = $('detail-' + encodeURIComponent(x.id));
    if (!detailBox) return;

    detailBox.innerHTML = `
      <div class="detail">
        <h2>預約詳細資訊</h2>

        <div>
          <b>標籤：</b>
          <span id="reservationTags">
            ${tags.map(t => `<span class="tag">${esc(t)} <button type="button" class="tagDelete" data-act="deleteReservationTag" data-args="${esc(JSON.stringify([encodeURIComponent(t)]))}">×</button></span>`).join(' ')}
          </span>
          <div>
            <input id="reservationTagInput" maxlength="30" placeholder="新增標籤">
            <button class="secondary" data-act="addReservationTag">新增標籤</button>
          </div>
        </div>

        <div class="detailGrid">
          <div class="detailLabel">姓名</div><div>${esc(x.name)}</div>
          <div class="detailLabel">生日</div><div>${esc(x.birthDate || '—')}</div>
          <div class="detailLabel">電話</div><div>${esc(x.phone || '—')}</div>
          <div class="detailLabel">服務</div><div>${esc(x.serviceName)}（${esc(x.durationMinutes)} 分鐘）</div>
          <div class="detailLabel">預約時間</div><div>${esc(String(x.date || '').slice(0,10))} ${esc(x.startTime || '')}–${esc(x.endTime || '')}</div>
          <div class="detailLabel">綁定碼</div><div>${x.lineBindCode ? `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;letter-spacing:.1em">${esc(x.lineBindCode)}</span>${x.lineBound ? '（已綁定）' : ''}` : (x.lineBound ? '已綁定 LINE（登入綁定，無綁定碼）' : '—')}</div>
          <div class="detailLabel">客人的備註</div><div>${esc(x.note || '—')}</div>
          <div class="detailLabel">我的備註</div>
          <div><textarea id="myNoteInput" rows="4" maxlength="500" style="width:100%;box-sizing:border-box;resize:vertical">${noteValue}</textarea></div>

          <div class="detailLabel">預定狀態</div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${['Finished','Cancel','No-show','Other'].map(v => `<button type="button" class="secondary statusChoice ${status === v ? 'selected' : ''}" ${lockedCancelled && v !== 'Cancel' ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''} data-act="chooseStatus" data-args="${esc(JSON.stringify([v]))}">${v}</button>`).join('')}
              <input id="otherStatusInput" data-in="previewReservationStatus" data-args="${esc(JSON.stringify(['Other']))}" class="${status === 'Other' ? '' : 'hidden'}" maxlength="100" placeholder="請輸入自定義狀態" value="${esc(x.otherStatus || '')}" style="max-width:220px;flex:1 1 180px">
              <button class="primary" style="display:none" data-act="saveReservationDetail" data-args="${esc(JSON.stringify([encodeURIComponent(x.id)]))}">儲存</button>
            </div>
          </div>
        </div>

        <div class="actions">
          <button class="secondary" data-act="closeReservationDetail">關閉</button>
        </div>
      </div>
    `;

    window.selectedReservationStatus = status;
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

function chooseStatusLegacy(v) {
  // 已取消的預約時段已釋放，不可改回其他狀態
  if (isCancelledReservation(window.currentDetailReservation) && v !== 'Cancel') return;

  window.selectedReservationStatus = v;

  document.querySelectorAll('.statusChoice').forEach(b => {
    b.classList.toggle('selected', b.textContent === v);
  });

  const input = $('otherStatusInput');
  if (input) {
    input.classList.toggle('hidden', v !== 'Other');
    if (v === 'Other') input.focus();
  }

  previewReservationStatus(v);
}

async function saveReservationDetail(id) {
  const v = window.selectedReservationStatus || '';
  const input = $('myNoteInput');

  if (!input) {
    uiAlert('找不到我的備註輸入框');
    return;
  }

  const other = v === 'Other'
    ? ($('otherStatusInput')?.value.trim() || '')
    : '';

  try {
    const noteResult = await api('/api/admin/reservations/' + id + '/note', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({myNote:input.value})
    });

    let saved = noteResult.reservation || window.currentDetailReservation;

    // 選擇 Cancel：先呼叫正式取消 API（status=CANCELLED、釋放時段），
    // 讓 Cancel 與 CANCELLED 在前後端代表同一件事。
    if (v === 'Cancel' && !isCancelledReservation(window.currentDetailReservation)) {
      if (!await showAdminActionConfirm('選擇 Cancel 會取消此筆預約，時段會恢復可預約。確定取消？', '確定取消')) {
        return;
      }

      const cancelResult = await api('/api/admin/reservations/' + id + '/cancel', {
        method:'PATCH'
      });

      saved = cancelResult.reservation || saved;
      adminCalendarCache.clear();
    }

    if (v) {
      // 同步寫入 statusLabel，保持與既有資料格式一致
      const statusResult = await api('/api/admin/reservations/' + id + '/status', {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({statusLabel:v,otherStatus:other})
      });

      saved = statusResult.reservation || saved;
    }

    window.currentDetailReservation = saved;
    await loadAdmin();
    await loadCustomers();
    if (v === 'Cancel') await loadCalendar();
  } catch (e) {
    uiAlert(e.message);
  }
}

async function saveStatus(id) {
  return saveReservationDetail(id);
}

async function addReservationTag() {
  const x = window.currentDetailReservation;
  const input = $('reservationTagInput');
  if (!input) return;

  const v = input.value.trim();
  if (!v) return;

  const tags = [...new Set([...(x.tags || []), v])].slice(0, 30);

  try {
    await api('/api/admin/reservations/' + encodeURIComponent(x.id) + '/tags', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tags})
    });

    await loadAdmin();
    await loadCustomers();
    await showDetail(x.id);
  } catch (e) {
    uiAlert(e.message);
  }
}

async function deleteReservationTag(tag) {
  const x = window.currentDetailReservation;
  if (!x) return;

  const t = decodeURIComponent(tag);
  const tags = (x.tags || []).filter(v => v !== t);

  try {
    const d = await api('/api/admin/reservations/' + encodeURIComponent(x.id) + '/tags', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tags})
    });

    window.currentDetailReservation = d.reservation;

    $('reservationTags').innerHTML = tags.map(v =>
      `<span class="tag">${esc(v)} <button type="button" class="tagDelete" data-act="deleteReservationTag" data-args="${esc(JSON.stringify([encodeURIComponent(v)]))}">×</button></span>`
    ).join(' ');

    await loadAdmin();
    await loadCustomers();
  } catch (e) {
    uiAlert(e.message);
  }
}

async function saveMyNote(id) {
  try {
    const input = $('myNoteInput');
    if (!input) throw new Error('找不到我的備註輸入框');

    const value = input.value;
    const d = await api('/api/admin/reservations/' + id + '/note', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({myNote:value})
    });

    window.currentDetailReservation = d.reservation;

    const notice = $('myNoteNotice');
    if (notice) notice.textContent = '已儲存';

    await loadCustomers();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

async function cancelBooking(id) {
  if (!await showAdminActionConfirm('確定取消此筆預約？取消後時段會恢復可預約。', '確定取消')) return;

  try {
    await api('/api/admin/reservations/' + id + '/cancel', {method:'PATCH'});
    await loadAdmin();
    adminCalendarCache.clear();
    await loadCalendar();
  } catch (e) {
    uiAlert(e.message);
  }
}

async function loadCustomersLegacy() {
  try {
    customers = await api('/api/admin/customers');
    renderCustomers();
  } catch (e) {
    if (e.message === '未登入') showLogin();
  }
}

function toggleCustHistory(btn) {
  const box = btn.closest('.customer').querySelector('.custHistory');
  box.classList.toggle('hidden');
}
function renderCustomersLegacy() {
  const q = $('customerSearch').value.trim().toLowerCase();

  const list = filterCustomersByPhone().filter(c =>
    !q ||
    String(c.name || '').toLowerCase().includes(q) ||
    String(c.phone || '').toLowerCase().includes(q)
  );

  $('customerContent').innerHTML = list.length
    ? `<div class="customerList">${list.map(c => {
        const tags = Array.isArray(c.tags) ? c.tags : [];

        return `<div class="customer booking">
          <div><b>${esc(c.name)}</b>
          ${tags.map(t => `<span class="tag">${esc(t)} <button type="button" class="tagDelete" data-act="deleteCustomerTag" data-args="${esc(JSON.stringify([encodeURIComponent(c.id),encodeURIComponent(t)]))}">×</button></span>`).join(' ')}
          <br>電話：${esc(c.phone || '—')}
          <br>生日：${esc(c.birthDate || '—')}
          </div>
          <div class="bookingActions"><button class="secondary" data-act="toggleCustHistory">查看資料</button><button class="danger" data-act="deleteCustomer" data-args="${esc(JSON.stringify([encodeURIComponent(c.id)]))}">刪除檔案</button></div>
          <div class="custHistory hidden">
            <div class="history">
              <div>
                <input id="ct-${esc(c.id)}" placeholder="新增標籤">
                <button class="secondary" data-act="addCustomerTag" data-args="${esc(JSON.stringify([encodeURIComponent(c.id)]))}">新增標籤</button>
              </div>
              歷史預約紀錄：${c.history?.length || 0} 筆
              <hr>
              ${(c.history || []).map(h => {
                const historyCancelled = isCancelledReservation(h);
                const historyStatus = historyCancelled
                  ? 'CANCELLED'
                  : (h.statusLabel || (isExpiredReservation(h) ? 'Finished' : '—'));

                return `<div class="customerHistoryItem">
                  <button type="button" class="historyJump" data-act="openCustomerReservation" data-args="${esc(JSON.stringify([encodeURIComponent(h.reservationId || '')]))}">
                    <span>${esc(String(h.date || '').slice(0,10))} ${esc(h.startTime || '')}–${esc(h.endTime || '')} · ${esc(h.serviceName || '')}</span>
                  </button>
                  <br>客人的備註：${esc(h.note || '—')}
                  <br>我的備註：${esc(h.myNote || '—')}
                  <br>預定狀態：${esc(historyStatus)}${historyCancelled ? '' : `<br><button class="secondary" data-act="cancelBooking" data-args="${esc(JSON.stringify([encodeURIComponent(h.reservationId || '')]))}">取消</button>`}<button class="secondary" data-act="showHistoryDetail" data-args="${esc(JSON.stringify([encodeURIComponent(h.reservationId || ''), String(h.date || '').slice(0,10)]))}">詳細</button>${h.statusLabel === 'Other' && h.otherStatus ? '（' + esc(h.otherStatus) + '）' : ''}
                  <br><button class="secondary" data-act="deleteCustomerHistory" data-args="${esc(JSON.stringify([encodeURIComponent(c.id),encodeURIComponent(h.reservationId || '')]))}">刪除此筆紀錄</button>
                </div>`;
              }).join('<hr>') || '尚無歷史預約'}
            </div>
          </div>
        </div>`;
      }).join('')}</div>`
    : '目前沒有符合的客人檔案。';
}

async function openCustomerReservation(id) {
  const rid = decodeURIComponent(id || '');
  if (!rid) return;

  try {
    showTab('reservation');
    await loadAdmin();

    const detail = $('detail-' + encodeURIComponent(rid));
    if (detail) {
      // 若該預約位於折疊面板內，先展開
      const acc = detail.closest('details.adminAccordion');
      if (acc) acc.open = true;

      const row = detail.closest('.booking');
      if (row) row.scrollIntoView({behavior:'smooth',block:'center'});
      await showDetail(rid);
    }
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

async function addCustomerTag(id) {
  const cid = decodeURIComponent(id);
  const c = customers.find(x => x.id === cid);
  const input = $('ct-' + cid);

  if (!c || !input) return;

  const v = input.value.trim();
  if (!v) return;

  const tags = [...new Set([...(c.tags || []), v])].slice(0, 30);

  try {
    const d = await api('/api/admin/customers/' + id + '/tags', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tags})
    });

    c.tags = d.customer.tags;
    renderCustomers();
  } catch (e) {
    uiAlert(e.message);
  }
}

async function deleteCustomerTag(id, tag) {
  const cid = decodeURIComponent(id);
  const t = decodeURIComponent(tag);
  const c = customers.find(x => x.id === cid);
  if (!c) return;

  const tags = (c.tags || []).filter(v => v !== t);

  try {
    const d = await api('/api/admin/customers/' + id + '/tags', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tags})
    });

    c.tags = d.customer.tags;
    renderCustomers();
    await loadAdmin();
  } catch (e) {
    uiAlert(e.message);
  }
}

function fillClosureTimes() {
  const starts = [];

  for (let m = 9 * 60; m <= 20 * 60; m += 30) {
    starts.push(`${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`);
  }

  $('closureStart').innerHTML = starts.map(t => `<option value="${t}">${t}</option>`).join('');

  $('closureMode').onchange = () => {
    const mode = $('closureMode').value;
    const range = mode === 'range';
    const multi = mode === 'multi';
    $('closureStart').classList.toggle('hidden', !range);
    $('closureEnd').classList.toggle('hidden', !range);
    $('closureEndDate').classList.toggle('hidden', !multi);

    if (range) {
      $('closureStart').value = starts[0];
      updateClosureEnds();
    } else {
      $('closureStart').value = '';
      $('closureEnd').innerHTML = '';
    }
  };

  $('closureStart').onchange = updateClosureEnds;

  function updateClosureEnds() {
    const v = $('closureStart').value;
    if (!v) return;

    const a = v.split(':').map(Number);
    const start = a[0] * 60 + a[1] + 30;
    let opts = '';

    for (let m = start; m <= 21 * 60; m += 30) {
      const t = `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
      opts += `<option value="${t}">${t}</option>`;
    }

    $('closureEnd').innerHTML = opts;
  }
}

function taipeiTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
window.__closureAccordionOpen = window.__closureAccordionOpen || { expired: false };
function renderClosureCard(x) {
  return `
    <div class="booking" id="closure-${esc(x.id)}">
      <div>
        <b>${esc(x.date)}</b><br>
        ${x.startTime ? `${esc(x.startTime)}–${esc(x.endTime)} 不可預約` : '全天公休'}
      </div>
      <div class="bookingActions"><button class="danger" data-act="deleteClosure" data-args="${esc(JSON.stringify([encodeURIComponent(x.id)]))}">刪除</button></div>
    </div>
  `;
}
async function loadClosuresLegacy() {
  try {
    const list = await api('/api/admin/closures');
    const today = taipeiTodayISO();
    // 降序：日期新到舊，同日依時段由晚到早
    const sorted = [...list].sort((a, b) => `${b.date}${b.startTime || ''}`.localeCompare(`${a.date}${a.startTime || ''}`));
    const active = sorted.filter(x => x.date >= today);
    const expired = sorted.filter(x => x.date < today);
    const cards = arr => `<div class="admin-list">${arr.map(renderClosureCard).join('')}</div>`;
    let html = active.length ? cards(active) : (expired.length ? '' : '目前沒有公休設定。');
    if (expired.length) {
      html += `
        <details class="adminAccordion" data-accordion="closure-expired" ${window.__closureAccordionOpen.expired ? 'open' : ''}
                 data-toggle-for="closureExpired">
          <summary><span>Expired</span><span class="accCount">${expired.length}</span></summary>
          ${cards(expired)}
        </details>`;
    }
    $('closureContent').innerHTML = html;
    const focusDate = window.__focusClosureDate;
    if (focusDate) {
      window.__focusClosureDate = null;
      const card = [...document.querySelectorAll('#closureContent .booking')].find(el => el.querySelector('b')?.textContent === focusDate);
      if (card) {
        const det = card.closest('details');
        if (det) { det.open = true; window.__closureAccordionOpen.expired = true; }
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('focusFlash');
        setTimeout(() => card.classList.remove('focusFlash'), 1800);
      }
    }
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else $('closureContent').innerHTML = `<p>${esc(e.message)}</p>`;
  }
}

async function addClosure() {
  const mode = $('closureMode').value;
  const range = mode === 'range';
  const multi = mode === 'multi';
  const date = $('closureDate').value;
  const endDate = multi ? $('closureEndDate').value : '';
  const start = range ? $('closureStart').value : '';
  const end = range ? $('closureEnd').value : '';

  if (!date) {
    uiAlert('請選擇公休日期');
    return;
  }
  if (multi && !endDate) {
    uiAlert('請選擇連休結束日期');
    return;
  }
  if (multi && endDate < date) {
    uiAlert('結束日期不可早於開始日期');
    return;
  }
  if (range && !end) {
    uiAlert('請選擇公休結束時間');
    return;
  }

  try {
    const d = await api('/api/admin/closures', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({date, endDate, startTime:start, endTime:end, reason: (document.getElementById('closureReason') ? document.getElementById('closureReason').value : '').trim()})
    });

    $('closureDate').value = '';
    $('closureEndDate').value = '';
    $('closureMode').value = 'all';
    $('closureStart').classList.add('hidden');
    $('closureEnd').classList.add('hidden');
    $('closureEndDate').classList.add('hidden');

    if (multi) {
      uiAlert(`已新增 ${d.count} 天公休${d.skipped ? `（${d.skipped} 天原本已是公休，已略過）` : ''}`);
    }

    await loadClosures();
    adminCalendarCache.clear();
    await loadCalendar();
  } catch (e) {
    uiAlert(e.message);
  }
}

async function deleteClosure(id) {
  if (!await showAdminActionConfirm('確定刪除此公休設定？刪除後該時段會恢復可預約。', '確定刪除')) return;

  try {
    await api('/api/admin/closures/' + id, {method:'DELETE'});
    await loadClosures();
    adminCalendarCache.clear();
    await loadCalendar();
  } catch (e) {
    uiAlert(e.message);
  }
}

let serviceRows = [];   // 畫面上目前的服務列（已儲存＋尚未儲存的新列）
function serviceRowHtml(s, i) {
  const isNew = !s.id;
  return `<div class="booking serviceRow" draggable="true" data-idx="${i}" data-id="${esc(s.id || '')}">
    <div class="svcMain">
      <label>服務名稱</label><input class="svcName" maxlength="40" value="${esc(s.name || '')}">
      <label>說明</label><input class="svcDesc" maxlength="120" value="${esc(s.description || '')}">
    </div>
    <div class="svcNums">
      <label>時長（分鐘）</label><input class="svcDuration" type="number" min="30" max="480" step="30" value="${esc(s.durationMinutes ?? 60)}">
      <label>價格（NT$）</label><input class="svcPrice" type="number" min="0" max="99999" step="1" value="${esc(s.price ?? 0)}">
    </div>
    <div class="svcSide">
      <label><input class="svcActive" type="checkbox" ${s.active === false ? '' : 'checked'}> 前台顯示</label> <button type="button" class="secondary" data-act="moveServiceUp">▲</button> <button type="button" class="secondary" data-act="moveServiceDown">▼</button>
      ${isNew ? '<button type="button" class="danger" data-act="removeNewServiceRow">移除</button>' : ''}
      <button type="button" class="primary svcSave" data-act="saveServicesCard">儲存</button>
    </div>
  </div>`;
}
function renderServices() {
  $('serviceContent').innerHTML = serviceRows.length ? serviceRows.map((s, i) => serviceRowHtml(s, i)).join('') : '目前沒有服務。';
}
async function loadServices() {
  try {
    serviceRows = await api('/api/admin/services');
    renderServices();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else $('serviceContent').innerHTML = `<p>${esc(e.message)}</p>`;
  }
}
function collectServiceRows() {
  return [...document.querySelectorAll('#serviceContent .serviceRow')].map(row => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.svcName').value,
    description: row.querySelector('.svcDesc').value,
    durationMinutes: Number(row.querySelector('.svcDuration').value),
    price: Number(row.querySelector('.svcPrice').value),
    active: row.querySelector('.svcActive').checked
  }));
}
function addServiceRow() {
  const cur = collectServiceRows();
  cur.unshift({ name: '', description: '', durationMinutes: 60, price: 0, active: true });
  serviceRows = cur;
  renderServices();
}
function removeNewServiceRow(btn) {
  const idx = Number(btn.closest('.serviceRow').dataset.idx);
  const cur = collectServiceRows();
  cur.splice(idx, 1);
  serviceRows = cur;
  renderServices();
}
async function saveServices() {
  try {
    const d = await api('/api/admin/services', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ services: collectServiceRows() })
    });
    uiAlert('服務設定已儲存');
    serviceRows = d.services;
    renderServices();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

/* ───────── 刪除／回收桶／新增預約與客人（v7.1 前端）───────── */
async function deleteReservation(id) {
  if (!await showAdminActionConfirm('確定刪除此預約？刪除後會移入「回收桶」，可在回收桶還原。', '確定刪除')) return;
  try {
    await api('/api/admin/reservations/' + id, { method: 'DELETE' });
    adminCalendarCache.clear();
    await loadAdmin();
    await loadCustomers();
    await loadCalendar();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}
async function deleteCustomer(cid) {
  if (!await showAdminActionConfirm('確定刪除此客人檔案？其歷史預約會一併移入「回收桶」，可在回收桶還原。', '確定刪除')) return;
  try {
    const d = await api('/api/admin/customers/' + cid, { method: 'DELETE' });
    uiAlert(`已移入回收桶（含 ${d.reservationsDeleted} 筆預約）`);
    adminCalendarCache.clear();
    await loadCustomers();
    await loadAdmin();
    await loadCalendar();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}
async function deleteCustomerHistory(cid, rid) {
  if (!await showAdminActionConfirm('確定刪除此筆歷史預約？會同時刪除對應的預約，並移入「回收桶」。', '確定刪除')) return;
  try {
    await api('/api/admin/customers/' + cid + '/history/' + rid, { method: 'DELETE' });
    adminCalendarCache.clear();
    await loadCustomers();
    await loadAdmin();
    await loadCalendar();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

function renderRecycleCard(x) {
  const s = x.summary || {};
  const isRes = x.type === 'reservation';
  const title = isRes
    ? `${esc(s.name || '')}｜${esc(s.serviceName || '')}`
    : `${esc(s.name || '')}（客人，含 ${esc(s.reservationCount ?? 0)} 筆預約）`;
  const detail = isRes
    ? `${esc(String(s.date || '').slice(0, 10))} ${esc(s.startTime || '')}–${esc(s.endTime || '')} · ${esc(s.status || '')}`
    : `電話：${esc(s.phone || '—')}`;
  const when = new Date(x.deletedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const restoreBtn = x.alreadyLive
    ? ''
    : `<button class="secondary" data-act="restoreRecycleItem" data-args="${esc(JSON.stringify([encodeURIComponent(x.id)]))}">還原</button>`;
  return `
    <div class="booking">
      <div>
        <span class="status">${isRes ? '預約' : '客人'}</span> <b>${title}</b><br>
        <span class="muted">${detail}</span><br>
        <span class="muted">刪除時間：${esc(when)}${x.alreadyLive ? '｜正式資料中已存在（請永久移除）' : ''}</span>
      </div>
      <div class="bookingActions">
        ${restoreBtn}
        <button class="danger" data-act="purgeRecycleItem" data-args="${esc(JSON.stringify([encodeURIComponent(x.id)]))}">永久移除</button>
      </div>
    </div>
  `;
}
async function loadRecycleBin() {
  try {
    const items = await api('/api/admin/recycle-bin');
    $('recycleContent').innerHTML = items.length
      ? `<div class="admin-list">${items.map(renderRecycleCard).join('')}</div>`
      : '回收桶是空的。';
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else $('recycleContent').innerHTML = `<p>${esc(e.message)}</p>`;
  }
}
async function restoreRecycleItem(id) {
  try {
    await api('/api/admin/recycle-bin/' + id + '/restore', { method: 'POST' });
    uiAlert('已還原');
    adminCalendarCache.clear();
    await loadRecycleBin();
    await loadAdmin();
    await loadCustomers();
    await loadCalendar();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else { uiAlert(e.message); await loadRecycleBin(); }
  }
}
async function purgeRecycleItem(id) {
  if (!await showAdminActionConfirm('確定永久移除？永久移除後無法還原。', '永久移除')) return;
  try {
    await api('/api/admin/recycle-bin/' + id, { method: 'DELETE' });
    await loadRecycleBin();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

/* 新增預約 */
async function openAddReservation() {
  const box = $('addReservationBox');
  if (!box.classList.contains('hidden')) return;   // 已開啟時不切換，避免送出失敗後誤關表單
  try { await loadCustomers(); } catch (e) {}
  let svcs = [];
  try { svcs = (await api('/api/admin/services')).filter(x => x.active !== false); } catch (e) {}
  box.innerHTML = `
    <div class="detail">
      <h2>新增預約</h2>
      <label>客人</label>
      <select id="addResCustomer">
        <option value="">— 新客人（填寫下方資料）—</option>
        ${customers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}｜${esc(c.phone || '—')}｜${esc(c.birthDate || '—')}</option>`).join('')}
      </select>
      <div id="addResNewFields">
        <label>姓名</label><input id="addResName" maxlength="40">
        <label>西元生日</label><input id="addResBirth" type="date">
        <label>電話</label><input id="addResPhone" maxlength="30">
      </div>
      <label>服務</label>
      <select id="addResService">${svcs.map(x => `<option value="${esc(x.id)}">${esc(x.name)}（${esc(x.durationMinutes)} 分鐘）</option>`).join('')}</select>
      <label>日期</label><input id="addResDate" type="date">
      <label>開始時間</label>
      <select id="addResTime"><option value="">請先選擇日期與服務</option></select>
      <label>備註（選填）</label><input id="addResNote" maxlength="500">
      <div class="actions">
        <button class="secondary" data-act="closeAddReservation">取消</button>
        <button data-act="submitAddReservation">建立預約</button>
      </div>
    </div>
  `;
  box.classList.remove('hidden');
  $('addResCustomer').onchange = () => {
    $('addResNewFields').classList.toggle('hidden', !!$('addResCustomer').value);
  };
  $('addResService').onchange = loadAddResTimes;
  $('addResDate').onchange = loadAddResTimes;
}
function closeAddReservation() {
  const box = $('addReservationBox');
  box.classList.add('hidden');
  box.innerHTML = '';
}
async function loadAddResTimes() {
  const date = $('addResDate').value;
  const serviceId = $('addResService').value;
  const sel = $('addResTime');
  if (!date || !serviceId) {
    sel.innerHTML = '<option value="">請先選擇日期與服務</option>';
    return;
  }
  sel.innerHTML = '<option value="">載入中…</option>';
  try {
    const d = await api(`/api/availability?date=${encodeURIComponent(date)}&serviceId=${encodeURIComponent(serviceId)}`);
    const list = d.available || [];
    sel.innerHTML = list.length
      ? list.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')
      : '<option value="">此日沒有可預約時段（可能公休或已滿）</option>';
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}
async function submitAddReservation() {
  const cid = $('addResCustomer').value;
  const body = {
    serviceId: $('addResService').value,
    date: $('addResDate').value,
    startTime: $('addResTime').value,
    note: $('addResNote').value
  };
  if (cid) body.customerId = cid;
  else {
    body.name = $('addResName').value;
    body.birthDate = $('addResBirth').value;
    body.phone = $('addResPhone').value;
  }
  if (!body.date || !body.startTime) { uiAlert('請選擇日期與開始時間'); return; }
  try {
    await api('/api/admin/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    uiAlert('已建立預約');
    closeAddReservation();
    adminCalendarCache.clear();
    await loadAdmin();
    await loadCustomers();
    await loadCalendar();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

/* 新增客人 */
function openAddCustomer() {
  const box = $('addCustomerBox');
  if (!box.classList.contains('hidden')) return;   // 已開啟時不切換，避免送出失敗後誤關表單
  box.innerHTML = `
    <div class="detail">
      <h2>新增客人</h2>
      <label>姓名</label><input id="addCusName" maxlength="40">
      <label>西元生日</label><input id="addCusBirth" type="date">
      <label>電話</label><input id="addCusPhone" maxlength="30">
      <label>LINE ID（選填）</label><input id="addCusLine" maxlength="60">
      <div class="actions">
        <button class="secondary" data-act="closeAddCustomer">取消</button>
        <button data-act="submitAddCustomer">建立客人</button>
      </div>
    </div>
  `;
  box.classList.remove('hidden');
}
function closeAddCustomer() {
  const box = $('addCustomerBox');
  box.classList.add('hidden');
  box.innerHTML = '';
}
async function submitAddCustomer() {
  const body = {
    name: $('addCusName').value,
    birthDate: $('addCusBirth').value,
    phone: $('addCusPhone').value,
    lineId: $('addCusLine').value
  };
  try {
    await api('/api/admin/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    uiAlert('已建立客人');
    closeAddCustomer();
    await loadCustomers();
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

async function login() {
  const password = $('password').value;

  if (!password) {
    $('loginMsg').textContent = '請輸入密碼。';
    $('loginMsg').classList.remove('hidden');
    return;
  }

  try {
    await api('/api/admin/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password})
    });

    $('password').value = '';
    $('loginPanel').classList.add('hidden');
    $('adminPanel').classList.remove('hidden');
    $('logout').classList.remove('hidden');

    showTab('calendar');
    await loadCalendar();
  } catch (e) {
    $('loginMsg').textContent = e.message;
    $('loginMsg').classList.remove('hidden');
  }
}

async function backupToDrive() {
  try {
    const r = await fetch('/api/admin/backup-to-drive', {method:'POST'});
    const d = await r.json().catch(() => ({}));

    if (!r.ok) throw new Error(d.error || 'Google Drive 備份失敗');

    uiAlert('已送出 Google Drive 備份');
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else uiAlert(e.message);
  }
}

$('login').onclick = login;
$('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

$('exportData').onclick = exportData;
$('backupDrive').onclick = backupToDrive;
$('importData').onclick = () => $('importFile').click();
$('importFile').onchange = e => importDataFromFile(e.target.files[0]);

$('logout').onclick = async () => {
  await api('/api/admin/logout', {method:'POST'});
  showLogin();
};

$('prevMonth').onclick = () => {
  calendarMonth.setMonth(calendarMonth.getMonth() - 1);
  loadCalendar(true);
};

$('nextMonth').onclick = () => {
  calendarMonth.setMonth(calendarMonth.getMonth() + 1);
  loadCalendar(true);
};

$('tabCalendar').onclick = () => {
  showTab('calendar');
  loadCalendar(true);
};

$('tabReservations').onclick = () => {
  showTab('reservation');
  loadAdmin();
};

$('tabCustomers').onclick = () => {
  showTab('customer');
  loadCustomers();
};

$('tabClosures').onclick = () => {
  showTab('closure');
  loadClosures();
};

$('addClosure').onclick = addClosure;
$('tabServices').onclick = () => {
  showTab('service');
  loadServices();
};
$('addServiceRow').onclick = addServiceRow;
$('saveServices').onclick = saveServices;
$('tabRecycle').onclick = () => {
  showTab('recycle');
  loadRecycleBin();
};
$('addReservationBtn').onclick = openAddReservation;
$('addCustomerBtn').onclick = openAddCustomer;
fillClosureTimes();
$('refreshAdmin').onclick = loadAdmin;

document.addEventListener('visibilitychange', () => {
  if (
    !document.hidden &&
    !$('adminPanel').classList.contains('hidden') &&
    !$('calendarView').classList.contains('hidden')
  ) {
    loadCalendar(true);
  }
});

$('clearAdmin').onclick = () => {
  $('adminDate').value = '';
  loadAdmin();
};

$('refreshCustomers').onclick = loadCustomers;
$('customerSearch').oninput = renderCustomers;

// ===== CSP 相容事件委派（取代內嵌 on* 屬性）=====
const ACTIONS = {
  showDetail: (el, ...a) => { const p = showDetail(...a); if (el && el.closest && el.closest('.crmResOpen')) return Promise.resolve(p).then(() => crmCleanOpenDetails(el)); return p; },
  cancelBooking: (el, ...a) => cancelBooking(...a),
  deleteReservation: (el, ...a) => deleteReservation(...a),
  deleteReservationTag: (el, ...a) => deleteReservationTag(...a),
  addReservationTag: (el, ...a) => addReservationTag(...a),
  chooseStatus: (el, ...a) => chooseStatus(...a),
  saveReservationDetail: (el, ...a) => saveReservationDetail(...a),
  closeReservationDetail: (el) => closeReservationDetail(el),
  deleteCustomerTag: (el, ...a) => deleteCustomerTag(...a),
  toggleCustHistory: (el) => toggleCustHistory(el),
  deleteCustomer: (el, ...a) => deleteCustomer(...a),
  saveServicesCard: () => saveServices(),
  crmDeleteCustomer: (el, enc) => crmDeleteCustomer(enc),
  addCustomerTag: (el, ...a) => addCustomerTag(...a),
  openCustomerReservation: (el, ...a) => openCustomerReservation(...a),
  deleteCustomerHistory: (el, ...a) => deleteCustomerHistory(...a),
  deleteClosure: (el, ...a) => deleteClosure(...a),
  removeNewServiceRow: (el) => removeNewServiceRow(el),
  crmNoteToggle: (el, id) => crmNoteToggle(id),
  openClosureSettings: (el, id) => openClosureSettings(id),
  openCustomerDetail: (el, id) => openCustomerDetail(id),
  crmBack: () => crmBack(),
  crmSetTab: (el, t) => crmSetTab(t),
  crmSetFilter: (el, f) => crmSetFilter(f),
  crmToggleRes: (el, id) => crmToggleRes(id),
  crmNewReservation: () => crmNewReservation(),
  crmDeleteRes: (el, id) => crmDeleteRes(id),
  deleteClosureGroup: (el, ...ids) => deleteClosureGroup(ids),
  showHistoryDetail: (el, rid, date) => showHistoryDetail(el, rid, date),
  openCrmForCustomer: (el, cid, phone) => openCrmForCustomer(cid, phone),
  moveServiceUp: (el) => moveServiceRow(el, -1),
  moveServiceDown: (el) => moveServiceRow(el, 1),
  restoreRecycleItem: (el, ...a) => restoreRecycleItem(...a),
  purgeRecycleItem: (el, ...a) => purgeRecycleItem(...a),
  closeAddReservation: (el, ...a) => closeAddReservation(...a),
  submitAddReservation: (el, ...a) => submitAddReservation(...a),
  closeAddCustomer: (el, ...a) => closeAddCustomer(...a),
  submitAddCustomer: (el, ...a) => submitAddCustomer(...a),
  previewReservationStatus: (el, ...a) => previewReservationStatus(...a),
};
document.addEventListener('click', e => {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, ...JSON.parse(el.dataset.args || '[]'));
});
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.in) return;
  const fn = ACTIONS[el.dataset.in];
  if (fn) fn(el, ...JSON.parse(el.dataset.args || '[]'));
}, true);
document.addEventListener('toggle', e => {
  const el = e.target;
  const tag = el.dataset && el.dataset.toggleFor;
  if (!tag) return;
  if (tag === 'adminAccordion') window.__adminAccordionOpen[el.dataset.key] = el.open;
  if (tag === 'closureExpired') window.__closureAccordionOpen.expired = el.open;
}, true);

if (!$('adminPanel').classList.contains('hidden')) loadCalendar().then(() => {
  if (!$('adminPanel').classList.contains('hidden')) {
    showTab('calendar');
  }
});
// ===== 服務排序（拖曳與 ▲▼）=====
function moveServiceRow(el, dir){
  const cur = collectServiceRows(); const idx = Number(el.closest('.serviceRow').dataset.idx); const j = idx + dir;
  if (j < 0 || j >= cur.length) return;
  [cur[idx], cur[j]] = [cur[j], cur[idx]]; serviceRows = cur; renderServices();
}
let dragServiceIdx = null;
document.addEventListener('dragstart', e => {
  const r = e.target.closest ? e.target.closest('#serviceContent .serviceRow') : null; if (!r) return;
  dragServiceIdx = Number(r.dataset.idx); e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', ''); } catch (err) {}
});
document.addEventListener('dragover', e => {
  if (e.target.closest && e.target.closest('#serviceContent .serviceRow')) e.preventDefault();
});
document.addEventListener('drop', e => {
  const r = e.target.closest ? e.target.closest('#serviceContent .serviceRow') : null;
  if (!r || dragServiceIdx === null) return;
  e.preventDefault();
  const to = Number(r.dataset.idx); const cur = collectServiceRows();
  const [moved] = cur.splice(dragServiceIdx, 1); cur.splice(to, 0, moved);
  dragServiceIdx = null; serviceRows = cur; renderServices();
});
// ===== 合併行事曆（單一分頁）：左側月曆、右側當日預約（DOM 重新排列，既有 id 與功能不變）=====
(function mergeCalendarLayout(){
  const cal = document.getElementById('calendarView'), day = document.getElementById('reservationView');
  if (!cal || !day || cal.parentElement.classList.contains('dayLayout')) return;
  const wrap = document.createElement('div'); wrap.className = 'dayLayout';
  cal.parentElement.insertBefore(wrap, cal);
  const left = document.createElement('div'); left.className = 'dayLeft';
  const right = document.createElement('div'); right.className = 'dayRight';
  wrap.append(left, right); left.appendChild(cal); right.appendChild(day);
  const t = document.getElementById('tabReservations'); if (t) t.style.display = 'none';
})();
// ===== 當日列表修正（時分、降序、整列點擊）=====
function dayRowsHtml(arr){
  if (!arr.length) return '目前沒有預約紀錄。';
  const hm = s => String(s || '').slice(0, 5);
  const sorted = arr.slice().sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
  return '<div class="dayRows">' + sorted.map(r => {
    const cid = encodeURIComponent(r.customerId || r.customer_id || '');
    const phone = String(r.phone || '');
    const st = r.status === 'CANCELLED' ? '已取消' : (r.statusLabel || '已確認');
    return '<div class="dayRow" data-act="openCrmForCustomer" data-args="' + esc(JSON.stringify([cid, phone])) + '">' +
      '<span class="dayTime">' + esc(hm(r.startTime)) + '–' + esc(hm(r.endTime)) + '</span>' +
      '<span class="dayName">' + esc(r.name || '') + '</span>' +
      '<span class="dayService">' + esc(r.serviceName || '') + '</span>' +
      '<span class="dayDur">' + esc(r.durationMinutes || '') + ' 分鐘</span>' +
      '<span class="dayStatus">' + esc(st) + '</span>' +
      '</div>';
  }).join('') + '</div>';
}
async function openCrmForCustomerLegacy(cid, phone){
  const id = decodeURIComponent(cid || '');
  showTab('customer');
  await loadCustomers();
  renderCustomers();
  const find = () => [...document.querySelectorAll('#customerContent .customer')].find(card =>
    (id && card.querySelector('input[id="ct-' + CSS.escape(id) + '"]')) || (phone && card.textContent.includes(phone)));
  let card = find();
  if (!card && phone) { $('customerSearch').value = phone; renderCustomers(); card = find(); }
  if (!card) { alert('找不到此客戶的檔案'); return; }
  const h = card.querySelector('.custHistory'); if (h) h.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function showHistoryDetail(el, rid, date){
  const id = decodeURIComponent(rid || ''); const day = decodeURIComponent(date || '');
  const item = el.closest('.customerHistoryItem'); if (!item) return;
  const old = item.querySelector('.histDetail'); if (old) { old.remove(); return; }
  const list = await api('/api/admin/reservations?date=' + encodeURIComponent(day));
  const arr = Array.isArray(list) ? list : (list.reservations || []);
  const r = arr.find(x => x.id === id);
  const box = document.createElement('div'); box.className = 'histDetail';
  box.innerHTML = r ? renderBookingCard(r) : '找不到此預約的詳細資料。';
  item.appendChild(box);
}
// ===== 客戶 CRM 新版（名冊＋詳細檔案）=====
let crmRes = [];
let crmView = { mode: 'list', id: null, tab: 'overview', filter: 'all', openRes: null };
function crmToday(){ return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()); }
function crmDigits(s){ return String(s || '').replace(/\D/g, ''); }
function crmResFor(c){
  const cd = crmDigits(c.phone);
  return crmRes.filter(r => { const k = r.customerId || r.customer_id; return k ? k === c.id : (cd && crmDigits(r.phone) === cd); });
}
function crmStats(c){
  const list = crmResFor(c), today = crmToday();
  const done = list.filter(r => r.status !== 'CANCELLED' && r.statusLabel === 'Finished');
  const pastDone = done.map(r => String(r.date)).filter(d => d < today).sort();
  const future = list.filter(crmIsFuture).map(r => String(r.date)).sort();
  const all = list.map(r => String(r.date)).sort();
  return {
    done: done.length,
    lastVisit: pastDone.length ? pastDone[pastDone.length - 1] : '',
    futureCount: future.length,
    nextFuture: future.length ? future[0] : '',
    first: all.length ? all[0] : '',
    lineBound: list.some(r => r.lineBound),
  };
}
function crmSortDesc(list){
  return list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.startTime).localeCompare(String(a.startTime)));
}
function crmHm(s){ return String(s || '').slice(0, 5); }
function crmFilterCustomers(){
  const q = String(($('customerSearch') && $('customerSearch').value) || '').trim().toLowerCase();
  const qd = crmDigits(q);
  return (customers || []).filter(c => !q ||
    String(c.name || '').toLowerCase().includes(q) ||
    (qd && crmDigits(c.phone).includes(qd)) ||
    (Array.isArray(c.tags) && c.tags.some(t => String(t).toLowerCase().includes(q))));
}
function crmTags(c){ return (Array.isArray(c.tags) ? c.tags : []).map(t => '<em class="crmTag">' + esc(t) + '</em>').join(''); }
// ---- 名冊 ----
function renderCustomers(){
  if (crmView.mode === 'detail') return renderCustomerDetail();
  const all = customers || [];
  const withFuture = crmRes.filter(crmIsFuture).length;
  const rows = crmFilterCustomers().map(c => ({ c, s: crmStats(c) }));
  $('customerContent').innerHTML =
    '<div class="crmSummary"><div><span>總客戶</span><b>' + all.length + '</b></div><div><span>未來預約</span><b>' + withFuture + '</b></div></div>' +
    '<div class="crmTable"><div class="crmHead"><span>客戶</span><span>電話</span><span>最近到訪</span><span>下一次預約</span></div>' +
    (rows.length ? rows.map(({ c, s }) =>
      '<div class="crmRow" data-act="openCustomerDetail" data-args="' + esc(JSON.stringify([encodeURIComponent(c.id)])) + '">' +
        '<span class="crmName"><b>' + esc(c.name || '') + '</b>' + crmTags(c) + '</span>' +
        '<span>' + esc(c.phone || '—') + '</span>' +
        '<span>' + esc(s.lastVisit || '—') + '</span>' +
        '<span>' + esc(s.nextFuture || '無') + '</span>' +
        
      '</div>').join('') : '<div class="crmEmpty">沒有符合的客戶</div>') +
    '</div>';
}
// ---- 詳細檔案 ----
function openCustomerDetail(encId){
  crmView = { mode: 'detail', id: decodeURIComponent(encId || ''), tab: 'overview', filter: 'all', openRes: null };
  renderCustomers();
}
function crmBack(){ crmView = { mode: 'list', id: null, tab: 'overview', filter: 'all', openRes: null }; renderCustomers(); }
function crmSetTab(t){ crmView.tab = t; renderCustomers(); }
function crmSetFilter(f){ crmView.filter = f; renderCustomers(); }
function crmToggleRes(id){ const v = decodeURIComponent(id || ''); crmView.openRes = crmView.openRes === v ? null : v; renderCustomers(); }
function crmNewReservation(){ showTab('calendar'); const b = $('addReservationBtn'); if (b) b.click(); }
function crmMatchFilter(r, f){
  const today = crmToday();
  if (f === 'future') return r.status === 'CONFIRMED' && String(r.date) > today;
  if (f === 'done') return r.status !== 'CANCELLED' && r.statusLabel === 'Finished';
  if (f === 'cancelled') return r.status === 'CANCELLED';
  if (f === 'noshow') return r.statusLabel === 'No-show';
  return true;
}
function crmStatusText(r){
  if (r.status === 'CANCELLED') return '已取消';
  return r.statusLabel ? (r.statusLabel === 'Other' && r.otherStatus ? r.otherStatus : r.statusLabel) : '已確認';
}
function renderCustomerDetail(){
  const c = (customers || []).find(x => x.id === crmView.id);
  if (!c) { crmBack(); return; }
  const s = crmStats(c);
  const list = crmSortDesc(crmResFor(c));
  const head =
    '<div class="crmDetailHead"><button class="secondary" data-act="crmBack">← 返回名冊</button>' +
    '<div class="crmTitle"><h2>' + esc(c.name || '') + '</h2>' +
    '<div class="crmMeta">' + esc(c.phone || '—') + ' · ' + (s.lineBound ? 'LINE 已綁定' : 'LINE 未綁定') + '</div>' +
    '<div>' + crmTags(c) + '</div></div>' +
    '<div class="crmHeadBtns"><button data-act="crmNewReservation">＋ 新增預約</button>' +
    '<button class="danger" data-act="crmDeleteCustomer" data-args="' + esc(JSON.stringify([encodeURIComponent(c.id)])) + '">刪除客人</button></div></div>' +
    '<div class="crmKpis"><div><span>完成服務</span><b>' + s.done + '</b> 次</div>' +
    '<div><span>最近到訪</span><b>' + esc(s.lastVisit || '—') + '</b></div>' +
    '<div><span>未來預約</span><b>' + s.futureCount + '</b> 筆</div></div>';
  const tabNames = [['overview', '總覽'], ['list', '預約紀錄'], ['notes', '備註/標籤']];
  const tabs = '<div class="crmTabs">' + tabNames.map(([k, n]) =>
    '<button class="' + (crmView.tab === k ? '' : 'secondary') + '" data-act="crmSetTab" data-args="' + esc(JSON.stringify([k])) + '">' + n + '</button>').join('') + '</div>';
  let body = '';
  if (crmView.tab === 'overview') {
    const latest = list[0];
    const next = list.find(crmIsFuture);
    body = '<div class="crmGrid">' + '<div class="crmCard"><h3>我的備註</h3>' + (c.staffNote ? esc(c.staffNote) : '<span class="crmMuted">尚未填寫</span>') + '</div>' +
      '<div class="crmCard"><h3>客戶資料</h3>生日：' + esc(c.birthDate || '—') + '<br>首次預約：' + esc(s.first || '—') + '</div>' +
      '<div class="crmCard"><h3>最近活動</h3>' + (latest ? esc(latest.date) + ' · ' + esc(latest.serviceName || '') + ' · ' + esc(crmStatusText(latest)) : '尚無預約') + '</div>' +
      '<div class="crmCard"><h3>下一次預約</h3>' + (next ? esc(next.date) + ' ' + esc(crmHm(next.startTime)) + '–' + esc(crmHm(next.endTime)) + ' · ' + esc(next.serviceName || '') + ' · ' + esc(next.durationMinutes || '') + ' 分鐘' : '無') + '</div>' +
      '</div>';
  } else if (crmView.tab === 'list') {
    const filters = [['all', '全部'], ['future', '未來預約'], ['done', '已完成'], ['cancelled', '已取消']];
    body = '<div class="crmTabs">' + filters.map(([k, n]) =>
      '<button class="' + (crmView.filter === k ? '' : 'secondary') + '" data-act="crmSetFilter" data-args="' + esc(JSON.stringify([k])) + '">' + n + '</button>').join('') + '</div>';
    const items = list.filter(r => crmMatchFilterV2(r, crmView.filter));
    body += items.length ? items.map(r => {
      const open = crmView.openRes === r.id;
      return '<div class="crmResRow" data-act="crmToggleRes" data-args="' + esc(JSON.stringify([encodeURIComponent(r.id)])) + '">' +
        '<span>' + esc(String(r.date)) + ' ' + esc(crmHm(r.startTime)) + '–' + esc(crmHm(r.endTime)) + '</span>' +
        '<span>' + esc(r.serviceName || '') + '</span><span>' + esc(r.durationMinutes || '') + ' 分鐘</span>' +
        '<span class="crmStatus">' + esc(crmStatusText(r)) + '</span></div>' +
        (open ? crmDetailOnly(r) : '');
    }).join('') : '<div class="crmEmpty">沒有符合的預約</div>';
  } else {
    body = crmNoteBlock(c) + '<div class="crmCard"><h3>標籤</h3>' + (Array.isArray(c.tags) && c.tags.length ? crmTags(c) : '尚無標籤') +
      '<div class="crmTagAdd"><input id="ct-' + esc(c.id) + '" placeholder="新增標籤">' +
      '<button data-act="addCustomerTag" data-args="' + esc(JSON.stringify([encodeURIComponent(c.id)])) + '">新增</button></div></div>' +
      '<h3 style="margin-top:14px">歷次預約備註</h3>' +
      (list.length ? list.map(r => '<div class="crmCard"><b>' + esc(String(r.date)) + ' ' + esc(r.serviceName || '') + '</b>' +
        '<br>客人的備註：' + esc(r.note || '—') + '</div>').join('') : '尚無預約');
  }
  $('customerContent').innerHTML = head + tabs + body;
  if (crmView.tab === 'notes') arrangeNotesRow();
  if (crmView.openRes) crmLoadOpenDetail(encodeURIComponent(crmView.openRes));
}
// ---- 載入 ----
async function loadCustomers(){
  try {
    const [cust, res] = await Promise.all([api('/api/admin/customers'), api('/api/admin/reservations')]);
    customers = cust;
    crmRes = Array.isArray(res) ? res : (res.reservations || []);
    renderCustomers();
  } catch (e) {
    if (e.message === '未登入') showLogin();
  }
}
// 點當日列表的客戶：找到客戶後直接開啟詳細檔案
async function openCrmForCustomer(cid, phone){
  const id = decodeURIComponent(cid || '');
  showTab('customer');
  await loadCustomers();
  const c = (customers || []).find(x => x.id === id) ||
    (customers || []).find(x => crmDigits(x.phone) && crmDigits(x.phone) === crmDigits(phone));
  if (!c) { alert('找不到此客戶的檔案'); return; }
  openCustomerDetail(encodeURIComponent(c.id));
}
// ===== CRM 預約紀錄展開卡片：不顯示標籤區塊（標籤改由客戶備註管理）=====
function crmCardClean(r){
  const wrap = document.createElement('div');
  wrap.innerHTML = renderBookingCard(r);
  wrap.querySelectorAll('input[placeholder="新增標籤"]').forEach(inp => {
    let row = inp.parentElement;
    while (row && row !== wrap && row.textContent.trim().length > 120) row = row.parentElement;
    (row && row !== wrap ? row : inp).remove();
  });
  wrap.querySelectorAll('textarea').forEach(ta => {
    let row = ta.parentElement;
    while (row && row !== wrap && !(row.textContent || '').includes('我的備註')) row = row.parentElement;
    if (row && row !== wrap && row.textContent.trim().length <= 160) row.remove(); else ta.remove();
  });
  wrap.querySelectorAll('button').forEach(b => { if ((b.textContent || '').trim() === 'Other') b.remove(); });
  return wrap.innerHTML;
}
// ===== 部分公休顯示在當日列表（最後一筆預約下方）=====
async function loadPartialClosures(date){
  try {
    const all = await api('/api/admin/closures');
    return (all || []).filter(x => x.date === date && x.startTime);
  } catch (e) { return []; }
}
function closureRowsHtml(arr){
  if (!arr || !arr.length) return '';
  return '<div class="dayRows">' + arr.map(x =>
    '<div class="dayRow dayClosure" data-act="openClosureSettings" data-args="' + esc(JSON.stringify([encodeURIComponent(x.id)])) + '">' +
      '<span class="dayTime">' + esc(String(x.startTime || '').slice(0, 5)) + '–' + esc(String(x.endTime || '').slice(0, 5)) + '</span>' +
      '<span class="dayName">部分公休</span>' +
      '<span class="dayService">不可預約</span>' +
      '<span class="dayDur"></span>' +
      '<span class="dayStatus">公休</span>' +
    '</div>').join('') + '</div>';
}
async function openClosureSettings(id){
  const cid = decodeURIComponent(id || '');
  showTab('closure');
  await loadClosures();
  const el = document.getElementById('closure-' + cid);
  if (el) {
    el.style.outline = '2px solid var(--violet)';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { el.style.outline = ''; }, 2500);
  }
}
// ===== 我的備註（客戶層級）=====
function crmNoteBlock(c){
  const editing = crmView.noteEditing === c.id;
  return '<div class="crmCard"><h3>我的備註</h3>' +
    '<textarea id="crmStaffNote" class="crmNote"' + (editing ? '' : ' readonly') + '>' + esc(c.staffNote || '') + '</textarea>' +
    '<div class="crmNoteActions"><button data-act="crmNoteToggle" data-args="' + esc(JSON.stringify([encodeURIComponent(c.id)])) + '">' + (editing ? '完成儲存' : '修改') + '</button></div></div>';
}
async function crmNoteToggle(encId){
  const id = decodeURIComponent(encId || '');
  const c = (customers || []).find(x => x.id === id); if (!c) return;
  if (crmView.noteEditing !== id) {
    crmView.noteEditing = id; renderCustomers();
    const ta = document.getElementById('crmStaffNote'); if (ta) ta.focus();
    return;
  }
  const v = (document.getElementById('crmStaffNote') || {}).value || '';
  const r = await fetch('/api/admin/customers/' + encodeURIComponent(id), {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staffNote: v })
  });
  if (!r.ok) { alert('儲存失敗（' + r.status + '）'); return; }
  c.staffNote = v; crmView.noteEditing = null; renderCustomers();
}
// ===== CRM 展開卡片清理（標籤、我的備註、Other；保護含姓名／客人的備註／預定狀態的容器）=====
function crmCleanRoot(root){
  const txt = el => (el.textContent || '').replace(/\s+/g, '');
  const kill = [];
  root.querySelectorAll('*').forEach(el => {
    const t = txt(el);
    const isField = t.indexOf('標籤') === 0 || t.indexOf('我的備註') === 0;
    const isContainer = t.indexOf('姓名') >= 0 || t.indexOf('客人的備註') >= 0 || t.indexOf('預定狀態') >= 0;
    if (t.length > 0 && t.length <= 200 && isField && !isContainer) kill.push(el);
  });
  kill.forEach(el => { if (el.isConnected) el.remove(); });
  root.querySelectorAll('button').forEach(b => { if ((b.textContent || '').trim() === 'Other') b.remove(); });
  root.querySelectorAll('input[placeholder="新增標籤"], textarea').forEach(el => el.remove());
  root.querySelectorAll('button.statusChoice, #otherStatusInput, [data-act="saveReservationDetail"]').forEach(el => el.remove());
  root.querySelectorAll('*').forEach(el => { if (el.children.length === 0 && (el.textContent || '').trim() === '預定狀態') el.remove(); });
  root.querySelectorAll('.detail button').forEach(b => { const t = (b.textContent || '').trim(); if (t === '關閉' || t === '刪除') b.remove(); });
  root.querySelectorAll('button.statusChoice').forEach(b => { if (b.textContent.trim() !== 'No-show') b.remove(); });
  root.querySelectorAll('[data-act="saveReservationDetail"]').forEach(el => el.remove());
  root.querySelectorAll('[data-act="saveReservationDetail"]').forEach(el => el.remove());
  // 預定狀態列：橫列並移除自訂輸入框（Other 的文字框）
  const nsBtn = [...root.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'No-show');
  if (nsBtn && nsBtn.parentElement) {
    const row = nsBtn.parentElement;
    row.querySelectorAll('input').forEach(i => i.remove());
    row.style.display = 'flex'; row.style.flexDirection = 'row'; row.style.flexWrap = 'wrap';
    row.style.alignItems = 'center'; row.style.gap = '8px';
  }
}
function crmCardStrict(r){
  const wrap = document.createElement('div');
  wrap.innerHTML = renderBookingCard(r);
  crmCleanRoot(wrap);
  return wrap.innerHTML;
}
function crmCleanOpenDetails(el){
  const root = el && el.closest ? el.closest('.crmResOpen') : null;
  if (root) crmCleanRoot(root);
}
// ===== 預定狀態：點按鍵直接儲存（第二十八步）=====
async function chooseStatus(v){
  if (v === 'No-show') return toggleNoShow();
  const r = window.currentDetailReservation;
  if (!r || !r.id) { uiAlert('找不到此預約'); return; }
  const id = r.id;
  if (v === 'Other') {
    window.selectedReservationStatus = 'Other';
    document.querySelectorAll('.statusChoice').forEach(b => b.classList.toggle('selected', b.textContent === 'Other'));
    const input = $('otherStatusInput'); if (input) { input.classList.remove('hidden'); input.focus(); }
    return;
  }
  try {
    if (v === 'Cancel') {
      if (isCancelledReservation(r)) return;
      if (!await showAdminActionConfirm('選擇 Cancel 會取消此筆預約，時段會恢復可預約。確定取消？', '確定取消')) return;
      await api('/api/admin/reservations/' + id + '/cancel', { method: 'PATCH' });
    } else {
      await api('/api/admin/reservations/' + id + '/status', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusLabel: v })
      });
    }
    await refreshAfterStatus();
  } catch (e) {
    uiAlert(e.message);
  }
}
async function refreshAfterStatus(){
  try { await loadAdmin(); } catch (e) {}
  if (typeof crmView !== 'undefined' && crmView && crmView.mode === 'detail') { try { await loadCustomers(); } catch (e) {} }
}
// Other：輸入自定義文字後離開輸入框即儲存
document.addEventListener('change', async e => {
  if (!e.target || e.target.id !== 'otherStatusInput') return;
  const r = window.currentDetailReservation; if (!r || !r.id) return;
  const text = String(e.target.value || '').trim();
  if (!text) { uiAlert('請輸入 Other 的自定義狀態'); return; }
  try {
    await api('/api/admin/reservations/' + r.id + '/status', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusLabel: 'Other', otherStatus: text })
    });
    await refreshAfterStatus();
  } catch (err) { uiAlert(err.message); }
});
// ===== 預定狀態只保留 No-show：點一次設為 No-show，再點一次回到點擊前狀態 =====
window.noShowPrev = window.noShowPrev || {};
async function toggleNoShow(){
  const r = window.currentDetailReservation;
  if (!r || !r.id) { uiAlert('找不到此預約'); return; }
  if (isCancelledReservation(r)) { uiAlert('已取消的預約不可變更預定狀態'); return; }
  const id = r.id;
  const cur = r.statusLabel || '';
  let body;
  if (cur === 'No-show') {
    const prev = window.noShowPrev[id] || { label: '', other: '' };
    body = { statusLabel: prev.label, otherStatus: prev.other || '' };
    delete window.noShowPrev[id];
  } else {
    window.noShowPrev[id] = { label: cur, other: r.otherStatus || '' };
    body = { statusLabel: 'No-show', otherStatus: '' };
  }
  try {
    await api('/api/admin/reservations/' + id + '/status', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await refreshAfterStatus();
  } catch (e) { uiAlert(e.message); }
}
// ===== 預約紀錄篩選（時間判斷）=====
function crmNowKey(){
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
function crmMatchFilterV2(r, f){
  const now = crmNowKey();
  const endKey = String(r.date) + ' ' + crmHm(r.endTime);
  const startKey = String(r.date) + ' ' + crmHm(r.startTime);
  const cancelled = r.status === 'CANCELLED';
  if (f === 'future') return crmIsFuture(r);
  if (f === 'done') return !cancelled && endKey <= now;
  if (f === 'cancelled') return cancelled;
  return true;
}
// ===== A) 預約紀錄：點列直接展開詳細資訊 =====
function crmDetailOnly(r){
  const enc = encodeURIComponent(r.id);
  return '<div class="crmResOpen crmOpenCard" data-rid="' + esc(r.id) + '">' +
    '<div id="detail-' + enc + '" class="crmDetailBox"></div>' +
    '<div class="crmDetailBar">' +
      '<button class="danger" data-act="crmDeleteRes" data-args="' + esc(JSON.stringify([enc])) + '">刪除</button>' +
      '<button class="secondary" data-act="crmToggleRes" data-args="' + esc(JSON.stringify([enc])) + '">關閉</button>' +
    '</div></div>';
}
async function crmLoadOpenDetail(encId){
  const box = $('detail-' + encId);
  if (!box || box.innerHTML.trim()) return;
  await showDetail(encId);
  // 載入後仍為空：稍後自動重試一次（避免列表重新繪製造成的時序問題）
  if (!$('detail-' + encId) || !$('detail-' + encId).innerHTML.trim()) {
    await new Promise(res => setTimeout(res, 200));
    const again = $('detail-' + encId);
    if (again && !again.innerHTML.trim()) await showDetail(encId);
  }
  const b2 = $('detail-' + encId);
  if (b2) crmCleanOpenDetails(b2);
}
async function crmDeleteRes(encId){
  await deleteReservation(encId);
  await loadCustomers();
}
// ===== C) 備份設定分頁：搬移既有按鍵（保留事件綁定），順序：匯出、匯入、備份到 Google Drive =====
(function setupBackupView(){
  const rv = document.getElementById('recycleView');
  const panel = rv && rv.parentElement;
  if (!panel || document.getElementById('backupView')) return;
  const view = document.createElement('div');
  view.id = 'backupView'; view.className = 'hidden';
  view.innerHTML = '<div class="glass"><h2>備份設定</h2><div class="hint">匯出、匯入後台資料，或備份到 Google Drive。</div><div class="backupBtns" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px"></div></div>';
  const row = view.querySelector('.backupBtns');
  ['exportData', 'importData', 'backupDrive'].forEach(id => { const b = document.getElementById(id); if (b) row.appendChild(b); });
  const fi = document.getElementById('importFile'); if (fi) row.appendChild(fi);
  panel.appendChild(view);
  const nav = document.getElementById('tabBackup');
  if (nav) nav.addEventListener('click', () => showTab('backup'));
})();
// 診斷輔助（仍空白時於 Console 執行：crmDiagDetail()）
function crmDiagDetail(){
  const box = document.querySelector('.crmDetailBox');
  return { boxExists: !!box, boxLen: box ? box.innerHTML.length : -1, current: window.currentDetailReservation ? window.currentDetailReservation.id : null };
}
// 未來預約（統一規則）：已確認，且開始時間晚於現在（台北時間）
function crmIsFuture(r){
  return r.status === 'CONFIRMED' && (String(r.date) + ' ' + crmHm(r.startTime)) > crmNowKey();
}
// ===== 公休設定改版 =====
window.__closureAccordionOpen = window.__closureAccordionOpen || { expired: false, others: false };
function closureDayDiff(a, b){ return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function closureGroups(list){
  const sorted = [...list].sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
  const groups = [];
  for (const x of sorted) {
    const last = groups[groups.length - 1];
    const whole = !x.startTime;
    const reason = x.reason || '公休';
    if (last && whole && last.whole && last.reason === reason && closureDayDiff(last.end, x.date) === 1) {
      last.end = x.date; last.ids.push(x.id); last.days++;
    } else {
      groups.push({ whole, start: x.date, end: x.date, startTime: x.startTime || '', endTime: x.endTime || '', reason, ids: [x.id], days: 1 });
    }
  }
  return groups;
}
function renderClosureGroupCard(g){
  const dateText = g.whole ? (g.start === g.end ? g.start : g.start + ' ～ ' + g.end + '（' + g.days + ' 天）') : g.start;
  const timeText = g.whole ? '全天公休' : (g.startTime + '–' + g.endTime + ' 不可預約');
  const enc = esc(JSON.stringify(g.ids.map(id => encodeURIComponent(id))));
  return '<div class="booking closureGroup"><div><b>' + esc(dateText) + '</b><br>' + esc(timeText) + ' · ' + esc(g.reason) + '</div>' +
    '<div class="bookingActions"><button class="danger" data-act="deleteClosureGroup" data-args="' + enc + '">刪除</button></div></div>';
}
async function deleteClosureGroup(ids){
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return;
  if (!await showAdminActionConfirm('確定刪除此公休？', '確定刪除')) return;
  try {
    for (const enc of list) await api('/api/admin/closures/' + enc, { method: 'DELETE' });
    if (typeof invalidateAllCaches === 'function') invalidateAllCaches();
  } catch (e) { uiAlert(e.message); }
  await loadClosures();
}
async function loadClosures(){
  try {
    const list = await api('/api/admin/closures');
    const today = taipeiTodayISO();
    const month = today.slice(0, 7);
    const future = list.filter(x => x.date >= today);
    const expired = list.filter(x => x.date < today);
    const groups = closureGroups(future);
    const monthDays = list.filter(x => !x.startTime && x.date.slice(0, 7) === month).length;
    if ($('sumMonth')) $('sumMonth').textContent = monthDays;
    if ($('sumFuture')) $('sumFuture').textContent = future.length;
    const top = groups.slice(0, 4), rest = groups.slice(4);
    let html = '';
    html += top.length ? '<div class="admin-list">' + top.map(renderClosureGroupCard).join('') + '</div>' : '<p>目前沒有即將到來的公休。</p>';
    if (rest.length) {
      html += '<details class="adminAccordion" ' + (window.__closureAccordionOpen.others ? 'open' : '') + ' ontoggle="window.__closureAccordionOpen.others=this.open">' +
        '<summary><span>其他未來公休</span><span class="accCount">' + rest.length + '</span></summary>' +
        '<div class="admin-list">' + rest.map(renderClosureGroupCard).join('') + '</div></details>';
    }
    if (expired.length) {
      const sortedExp = [...expired].sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));
      html += '<details class="adminAccordion" ' + (window.__closureAccordionOpen.expired ? 'open' : '') + ' ontoggle="window.__closureAccordionOpen.expired=this.open">' +
        '<summary><span>已過期公休</span><span class="accCount">' + expired.length + '</span></summary>' +
        '<div class="admin-list">' + sortedExp.map(renderClosureCard).join('') + '</div></details>';
    }
    if (!list.length) html = '<p>目前沒有公休設定。</p>';
    $('closureContent').innerHTML = html;
  } catch (e) {
    if (e.message === '未登入') showLogin();
    else $('closureContent').innerHTML = '<p>' + esc(e.message) + '</p>';
  }
}
// ---- ＋新增公休 表單 ----
function setClosureType(mode){
  $('closureMode').value = mode;
  $('closureMode').dispatchEvent(new Event('change'));
  document.querySelectorAll('#closureModal .typeBtn').forEach(b => b.classList.toggle('selected', b.dataset.mode === mode));
}
function openClosureForm(){
  $('closureDate').value = '';
  $('closureEndDate').value = '';
  $('closureReason').value = '公休';
  setClosureType('all');
  $('closureModal').classList.remove('hidden');
}
function closeClosureForm(){ $('closureModal').classList.add('hidden'); }
async function submitClosureForm(){
  const mode = $('closureMode').value;
  if (!$('closureDate').value) { uiAlert('請選擇公休日期'); return; }
  if (mode === 'multi' && !$('closureEndDate').value) { uiAlert('請選擇連休結束日期'); return; }
  if (mode === 'multi' && $('closureEndDate').value < $('closureDate').value) { uiAlert('結束日期不可早於開始日期'); return; }
  if (mode === 'range' && !$('closureEnd').value) { uiAlert('請選擇公休結束時間'); return; }
  closeClosureForm();
  await addClosure();
}
function setupClosureForm(){
  if (window.__closureFormReady) return; window.__closureFormReady = true;
  const slot = document.getElementById('closureDateSlot');
  if (!slot || !document.getElementById('closureModal')) return;
  ['closureMode', 'closureDate', 'closureEndDate', 'closureStart', 'closureEnd'].forEach(id => { const el = document.getElementById(id); if (el) slot.appendChild(el); });
  document.querySelectorAll('#closureModal .typeBtn').forEach(b => b.addEventListener('click', () => setClosureType(b.dataset.mode)));
  document.getElementById('openClosureForm').addEventListener('click', openClosureForm);
  document.getElementById('closureCancel').addEventListener('click', closeClosureForm);
  document.getElementById('closureSubmit').addEventListener('click', submitClosureForm);
  document.getElementById('closureModal').addEventListener('click', e => { if (e.target.id === 'closureModal') closeClosureForm(); });
}
document.addEventListener('DOMContentLoaded', setupClosureForm);
if (document.readyState !== 'loading') setupClosureForm();
// 備註/標籤分頁：我的備註與標籤並排同一列（保持各自原高度）
function arrangeNotesRowLegacy(){
  const root = $('customerContent');
  const cards = [...root.querySelectorAll('.crmCard')];
  const h = c => { const t = c.querySelector('h3'); return t ? t.textContent.trim() : ''; };
  const noteCard = cards.find(c => h(c) === '我的備註');
  const tagCard = cards.find(c => h(c) === '標籤');
  if (!noteCard || !tagCard || (noteCard.parentElement && noteCard.parentElement.classList.contains('crmNotesRow'))) return;
  const row = document.createElement('div');
  row.className = 'crmNotesRow';
  noteCard.parentElement.insertBefore(row, noteCard);
  row.append(noteCard, tagCard);
}
// 備註/標籤分頁：我的備註、標籤、歷次預約備註 三欄並排（我的備註與標籤等高；歷次保持原高度）
function arrangeNotesRow(){
  const root = $('customerContent');
  if (root.querySelector('.crmNotesRow')) return;
  const h = el => { const t = el.querySelector ? el.querySelector('h3') : null; return t ? t.textContent.trim() : ''; };
  const cards = [...root.querySelectorAll('.crmCard')];
  const noteCard = cards.find(c => h(c) === '我的備註');
  const tagCard = cards.find(c => h(c) === '標籤');
  if (!noteCard || !tagCard) return;
  const histHead = [...root.querySelectorAll('h3')].find(x => x.textContent.trim() === '歷次預約備註');
  const histNodes = [];
  if (histHead) {
    histNodes.push(histHead);
    let n = histHead.nextElementSibling;
    while (n) { histNodes.push(n); n = n.nextElementSibling; }
  }
  const row = document.createElement('div');
  row.className = 'crmNotesRow';
  const colNote = document.createElement('div'); colNote.className = 'crmNoteCol';
  const colTag = document.createElement('div'); colTag.className = 'crmTagCol';
  const colHist = document.createElement('div'); colHist.className = 'crmHistCol';
  noteCard.parentElement.insertBefore(row, noteCard);
  row.append(colNote, colTag, colHist);
  colNote.appendChild(noteCard);
  colTag.appendChild(tagCard);
  histNodes.forEach(n => colHist.appendChild(n));
  wrapTagChips(tagCard);
}
// ===== 個別客戶：刪除客人（刪除後回到名冊）=====
async function crmDeleteCustomer(enc){
  const id = decodeURIComponent(enc || '');
  await deleteCustomer(enc);
  await loadCustomers();
  if (!(customers || []).some(x => x.id === id)) crmBack();
}
// ===== 手機版按鍵排序（以按鍵文字加上 class，CSS 負責排序）=====
(function tagToolbarButtons(){
  const mark = (scope, rules) => {
    document.querySelectorAll(scope + ' button').forEach(b => {
      const t = (b.textContent || '').trim();
      for (const [needle, cls] of rules) if (t.indexOf(needle) >= 0) { b.classList.add(cls); break; }
    });
  };
  mark('#reservationView .adminTools', [['新增預約', 'tbAdd'], ['查詢', 'tbQuery'], ['清除', 'tbClear']]);
  mark('#customerView .adminTools', [['新增客人', 'tbAdd'], ['重新整理', 'tbRefresh']]);
})();
// layoutFix2：配色與位置（DOM 只調整 class，不改事件綁定）
(function layoutFix2(){
  const rf = document.getElementById('refreshCustomers'), ad = document.getElementById('addCustomerBtn');
  if (rf && ad) { rf.classList.add('secondary'); ad.classList.remove('secondary'); }
  const as = document.getElementById('addServiceRow');
  if (as) {
    as.classList.remove('secondary'); as.classList.add('primary');
    const p = as.parentElement;
    if (p) { p.style.display = 'flex'; p.style.flexWrap = 'wrap'; p.style.alignItems = 'center'; p.style.gap = '8px'; }
  }
})();
// ===== layoutBatch3 =====
// 標籤：每個標籤外框只隨自身文字長度（不被同列最長者拉伸）
function wrapTagChips(card){
  if (!card || card.querySelector('.crmTagList')) return;
  const chips = [...card.querySelectorAll('.crmTag')];
  if (!chips.length) return;
  const list = document.createElement('div');
  list.className = 'crmTagList';
  chips[0].parentNode.insertBefore(list, chips[0]);
  chips.forEach(c => list.appendChild(c));
}
// 客戶 CRM：新增客人按鍵與總客戶／未來預約並排於右側（參考公休設定）
(function placeAddCustomerBtn(){
  const addBtn = document.getElementById('addCustomerBtn');
  const content = document.getElementById('customerContent');
  if (!addBtn || !content) return;
  const place = () => {
    const sum = content.querySelector('.crmSummary');
    if (!sum || (sum.parentElement && sum.parentElement.classList.contains('crmTopRow'))) return;
    const row = document.createElement('div');
    row.className = 'crmTopRow';
    sum.parentElement.insertBefore(row, sum);
    row.append(sum, addBtn);
  };
  new MutationObserver(place).observe(content, { childList: true });
  place();
})();
// 服務設定：上下移動置中下、前台顯示勾選框置左下、儲存與移除置右下
(function arrangeServiceCards(){
  const box = document.getElementById('serviceContent');
  if (!box) return;
  const arrange = () => {
    box.querySelectorAll('.serviceRow').forEach(row => {
      if (row.querySelector('.svcFoot')) return;
      const foot = document.createElement('div'); foot.className = 'svcFoot';
      const left = document.createElement('div'); left.className = 'svcLeft';
      const mid = document.createElement('div'); mid.className = 'svcMid';
      const right = document.createElement('div'); right.className = 'svcRight';
      const chk = row.querySelector('.svcActive'); const lab = chk ? chk.closest('label') : null;
      if (lab) left.appendChild(lab);
      row.querySelectorAll('button[data-act^="moveService"]').forEach(b => mid.appendChild(b));
      row.querySelectorAll('.svcSave, button[data-act="removeNewServiceRow"]').forEach(b => right.appendChild(b));
      foot.append(left, mid, right);
      row.appendChild(foot);
      const side = row.querySelector('.svcSide'); if (side && !side.children.length) side.style.display = 'none';
    });
  };
  new MutationObserver(arrange).observe(box, { childList: true, subtree: false });
  arrange();
})();
// 日期空白時顯示置中文字「選擇日期」（覆蓋層，不影響點選）
(function dateHints(){
  const ids = ['adminDate', 'closureDate', 'closureEndDate'];
  ids.forEach(id => {
    const inp = document.getElementById(id);
    if (!inp || inp.dataset.hinted) return;
    inp.dataset.hinted = '1';
    const wrap = document.createElement('div'); wrap.className = 'dateWrap';
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    const hint = document.createElement('span'); hint.className = 'dateHint'; hint.textContent = '選擇日期';
    wrap.appendChild(hint);
    const sync = () => { wrap.classList.toggle('isEmpty', !inp.value); };
    inp.addEventListener('input', sync); inp.addEventListener('change', sync); sync();
  });
})();
// ===== layoutFix4：回收桶按鍵移到卡片最後（靠右） =====
(function layoutFix4(){
  const box = document.getElementById('recycleContent');
  if (!box) return;
  const arrange = () => {
    box.querySelectorAll('.booking').forEach(card => {
      const acts = card.querySelector('.bookingActions');
      if (acts && acts.parentElement !== card) card.appendChild(acts);
      else if (acts && acts === card.lastElementChild) return;
      else if (acts) card.appendChild(acts);
    });
  };
  new MutationObserver(arrange).observe(box, { childList: true, subtree: true });
  arrange();
})();
