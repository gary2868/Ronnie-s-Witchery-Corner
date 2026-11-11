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
  ['calendar','reservation','customer','closure','service','recycle'].forEach(x => {
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
      $('adminContent').innerHTML = cardsHtml(list);
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
              <button class="primary" style="margin-left:auto" data-act="saveReservationDetail" data-args="${esc(JSON.stringify([encodeURIComponent(x.id)]))}">儲存</button>
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

function chooseStatus(v) {
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

async function loadCustomers() {
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
function renderCustomers() {
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
                  <br>預定狀態：${esc(historyStatus)}${h.statusLabel === 'Other' && h.otherStatus ? '（' + esc(h.otherStatus) + '）' : ''}
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
    <div class="booking">
      <div>
        <b>${esc(x.date)}</b><br>
        ${x.startTime ? `${esc(x.startTime)}–${esc(x.endTime)} 不可預約` : '全天公休'}
      </div>
      <div class="bookingActions"><button class="danger" data-act="deleteClosure" data-args="${esc(JSON.stringify([encodeURIComponent(x.id)]))}">刪除</button></div>
    </div>
  `;
}
async function loadClosures() {
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
      body:JSON.stringify({date, endDate, startTime:start, endTime:end})
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
  showDetail: (el, ...a) => showDetail(...a),
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
  addCustomerTag: (el, ...a) => addCustomerTag(...a),
  openCustomerReservation: (el, ...a) => openCustomerReservation(...a),
  deleteCustomerHistory: (el, ...a) => deleteCustomerHistory(...a),
  deleteClosure: (el, ...a) => deleteClosure(...a),
  removeNewServiceRow: (el) => removeNewServiceRow(el),
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

loadCalendar().then(() => {
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
