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

const state={config:null,date:null,service:null,startTime:null,slots:[],month:null,admin:false,lastReservation:null,preservedSelection:null};
function persistTimeSelection(){
  try{
    if(state.date && state.service && state.startTime){
      localStorage.setItem('roni_booking_time_selection',JSON.stringify({date:state.date,service:state.service,startTime:state.startTime,slots:Array.isArray(state.slots)?state.slots:[]}));
    }
  }catch(e){}
}
function restoreTimeSelection(){
  try{
    const raw=localStorage.getItem('roni_booking_time_selection');
    if(!raw)return;
    const v=JSON.parse(raw);
    if(v && v.date===state.date && v.service===state.service && v.startTime){
      state.startTime=v.startTime;
      state.slots=Array.isArray(v.slots)?v.slots.slice():[];
      state.preservedSelection={date:v.date,service:v.service,startTime:v.startTime,slots:state.slots.slice()};
    }
  }catch(e){}
}
function clearTimeSelection(){try{localStorage.removeItem('roni_booking_time_selection')}catch(e){}}

const $=id=>document.getElementById(id);
const api=async(url,opt={})=>{const r=await fetch(url,opt);const d=await r.json();if(!r.ok)throw new Error(d.error||'操作失敗');return d};
const esc=s=>String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const steps=()=>document.querySelectorAll('.step');
function setStep(n){steps().forEach((x,i)=>x.classList.toggle('active',i===n));const ls=$('lineLoginSlot');if(ls)ls.classList.toggle('hidden',n!==0);}
function iso(y,m,d){return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
function serviceById(id){return state.config.services.find(x=>x.id===id)}
function selectedService(){return serviceById(state.service)}
function updateSide(){const el=$('sideSummary'); if(!el) return; const s=selectedService();el.innerHTML=state.date?`日期：<b>${esc(state.date)}</b><br>服務：<b>${s?esc(s.name):'尚未選擇'}</b><br>時間：<b>${state.startTime?esc(state.startTime+'–'+timeAddMinutes(state.startTime,s.durationMinutes)):'尚未選擇'}</b>`:'尚未選擇預約資料。';}
async function monthStatus(month) {
  try {
    const serviceId = state.service || state.config.services[0].id;
    return await api('/api/calendar-status?month='+encodeURIComponent(month)+'&serviceId='+encodeURIComponent(serviceId));
  } catch { return { statuses: {} }; }
}
async function renderCalendar(){
  const y=state.month.getFullYear(),m=state.month.getMonth();
  $('monthTitle').textContent=`${y} 年 ${m+1} 月`;
  updateMonthNav();
  const cal=$('calendar');
  cal.innerHTML='<div class="calendarLoading">載入中…</div>';
  const first=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();
  const month=iso(y,m,1).slice(0,7);
  const batch=await monthStatus(month);
  // 所有日期先在記憶體中完成 HTML，資料完整後只對 DOM 寫入一次。
  // 避免瀏覽器逐個插入／繪製日期造成「一天一天跑出來」的視覺效果。
  let html=['日','一','二','三','四','五','六'].map(x=>`<div class="dow">${x}</div>`).join('');
  for(let i=0;i<first;i++) html+='<button class="day empty" disabled></button>';
  for(let d=1;d<=days;d++){
    const date=iso(y,m,d);
    let cls='day', attrs='';
    const title=[];
    if(date<=state.config.today||date>state.config.maxAdvanceDate){
      cls+=date===state.config.today?' closed':' past';
      attrs+=' disabled';
      if(date===state.config.today){title.push('當日不可預約');attrs+=' data-status="today-closed"';}
      else title.push('不可選取');
    }else{
      const st=batch.statuses?.[date]||{slots:[],available:[],closed:true};
      if(st.closed){cls+=' closed';attrs+=' disabled';title.push('公休');}
      else if(st.partialClosure){
        if(!st.available?.length){cls+=' full';attrs+=' disabled';}
        else { cls+=' partial'; attrs+=` data-date="${date}"`; }
        // 指定時段不可預約：前台格子不顯示文字
      }
      else if(!st.available?.length){cls+=' full';attrs+=' disabled';title.push('已額滿');}
      else{
        if(st.available.length<st.slots.length)cls+=' partial';
        attrs+=` data-date="${date}"`;
        if(st.available.length<st.slots.length)title.push('部分已預約');
      }
    }
    if(date===state.date)cls+=' selected';
    const eventLabel = title.length ? `<small class="dayStatus">${esc(title[0])}</small>` : '';
    html+=`<button class="${cls}"${attrs}${title.length?` title="${esc(title[0])}"`:''}>${d}${eventLabel}</button>`;
  }
  // 單次 replace，整個月份同時出現在畫面。
  cal.innerHTML=html;
  cal.querySelectorAll('button.day[data-date]').forEach(e=>e.onclick=()=>selectDate(e.dataset.date));
}
function addDays(date,days){const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+days);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function monthKey(d){return d.getFullYear()*12+d.getMonth();}
function updateMonthNav(){const minMonth=new Date(state.config.today+'T00:00:00');minMonth.setDate(1);const maxMonth=new Date(state.config.maxAdvanceDate+'T00:00:00');maxMonth.setDate(1);$('prevMonth').disabled=monthKey(state.month)<=monthKey(minMonth);$('nextMonth').disabled=monthKey(state.month)>=monthKey(maxMonth);}

async function selectDate(date){clearTimeSelection();state.date=date;state.startTime=null;state.slots=[];await renderServices();$('dateView').classList.add('hidden');$('serviceView').classList.remove('hidden');setStep(1);updateSide();}
async function renderServices(){$('serviceGrid').innerHTML=state.config.services.map(s=>`<button class="serviceCard ${state.service===s.id?'selected':''}" data-service="${esc(s.id)}"><div class="serviceRow"><div class="serviceInfo"><div class="serviceName">${esc(s.name)}</div><div class="serviceDescription">${esc(s.description||'完整約 '+s.durationMinutes+' 分鐘')}</div></div><div class="servicePrice">NT$${Number(s.price||0).toLocaleString('en-US')}</div></div></button>`).join('');document.querySelectorAll('.serviceCard').forEach(b=>b.onclick=()=>{state.service=b.dataset.service;renderServices();});$('serviceHint').textContent=`${state.date} · 請選擇服務項目`}
async function loadSlots(options={}){
  const preserve=options.preserve===true;
  const keepStart=preserve ? state.startTime : null;
  const keepSlots=preserve && Array.isArray(state.slots) ? state.slots.slice() : [];
  const d=await api('/api/availability?date='+state.date+'&serviceId='+state.service);
  const container=$('slots');
  container.innerHTML='';
  if(!preserve){
    restoreTimeSelection();
    if(!(state.startTime && state.preservedSelection && state.preservedSelection.date===state.date && state.preservedSelection.service===state.service)){
      state.startTime=null; state.slots=[];
    }
  }
  $('selectedDateText').textContent=`${state.date} · ${selectedService().name}`;
  if(!Array.isArray(d.slots)||d.slots.length===0){
    const msg=document.createElement('div');
    msg.className='emptyState';
    msg.textContent=d.reason==='OUT_OF_RANGE'?'此日期不在可預約範圍內。':'此日期沒有設定可預約時段。';
    container.appendChild(msg);
    return;
  }
  d.slots.forEach(t=>{
    const b=document.createElement('button');
    b.className='slot';
    b.textContent=t;
    if(d.available?.includes(t)){
      b.classList.add('available');
      b.onclick=()=>{
        document.querySelectorAll('.slot').forEach(x=>x.classList.remove('selected'));
        b.classList.add('selected');
        state.startTime=t;
        const svc=selectedService();
        const start=Number(t.slice(0,2))*60+Number(t.slice(3));
        state.slots=Array.from({length:Math.ceil(svc.durationMinutes/state.config.slotMinutes)},(_,i)=>`${String(Math.floor((start+i*state.config.slotMinutes)/60)).padStart(2,'0')}:${String((start+i*state.config.slotMinutes)%60).padStart(2,'0')}`);
        state.preservedSelection={date:state.date,service:state.service,startTime:state.startTime,slots:state.slots.slice()};
        persistTimeSelection();
        updateSide();
      };
    }else{
      b.classList.add('booked');
      b.disabled=true;
      b.title=d.closed?'此日期無法預約':'已預約或無法連續安排';
    }
    container.appendChild(b);
  });
  restoreTimeSelection();
  const wanted=(preserve || state.preservedSelection?.date===state.date) ? (keepStart || state.startTime || state.preservedSelection?.startTime) : null;
  if(wanted && d.available?.includes(wanted)){
    const selected=[...container.querySelectorAll('.slot')].find(x=>x.textContent===wanted && !x.disabled);
    if(selected){
      selected.classList.add('selected');
      state.startTime=wanted;
      state.slots=keepSlots.length ? keepSlots : (state.preservedSelection?.slots||[]).slice();
      updateSide();
    }
  }
}
async function showSlots(){if(!state.service)return uiAlert('請先選擇服務項目。');await loadSlots();$('serviceView').classList.add('hidden');$('slotView').classList.remove('hidden');setStep(2);updateSide();}
function timeAddMinutes(start,minutes){const [h,m]=String(start).split(':').map(Number);const total=h*60+m+Number(minutes||0);return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`}
function showForm(){if(!state.startTime)return uiAlert('請選擇時間。');const s=selectedService();$('formSummary').innerHTML=`日期：${esc(state.date)}<br>服務：${esc(s.name)}（${s.durationMinutes} 分鐘）<br>時間：${esc(state.startTime)}–${esc(timeAddMinutes(state.startTime,s.durationMinutes))}`;$('slotView').classList.add('hidden');$('formView').classList.remove('hidden');setStep(3);}
function showConfirm(ev){
  if(ev && typeof ev.preventDefault==='function') ev.preventDefault();
  // Snapshot the selected booking slot BEFORE validation. Validation must never clear it.
  const selectedDate=state.date;
  const selectedServiceId=state.service;
  const selectedStartTime=state.startTime;
  const selectedSlots=Array.isArray(state.slots)?state.slots.slice():[];
  const name=$('name').value.trim(),birthDate=$('birthDate').value,phone=$('phone').value.trim();
  const missing=[];
  if(!selectedDate)missing.push('日期');
  if(!selectedServiceId)missing.push('服務項目');
  if(!selectedStartTime)missing.push('時間');
  if(!name)missing.push('姓名');
  if(!birthDate)missing.push('西元生日');
  if(!phone)missing.push('電話');
  const validation=$('formValidation');
  if(missing.length){
    const text='預約資料不完整，請補填：'+missing.join('、');
    if(validation){validation.textContent=text;validation.classList.remove('hidden');}
    else uiAlert(text);
    // Stay on the form page. Do NOT call loadSlots(), renderServices(), or alter state.
    const target=!name?$('name'):!birthDate?$('birthDate'):!phone?$('phone'):null;
    if(target) target.focus();
    // Defensive restoration of the exact pre-validation selection.
    state.date=selectedDate;
    state.service=selectedServiceId;
    state.startTime=selectedStartTime;
    state.slots=selectedSlots;
    state.preservedSelection={date:selectedDate,service:selectedServiceId,startTime:selectedStartTime,slots:selectedSlots.slice()};
    persistTimeSelection();
    $('slotView').classList.add('hidden');
    $('formView').classList.remove('hidden');
    setStep(3);
    updateSide();
    return false;
  }
  if(!selectedServiceId || !selectedStartTime || !selectedSlots.length){
    const text='預約時間資料遺失，請返回時間頁重新選擇。';
    if(validation){validation.textContent=text;validation.classList.remove('hidden');}
    else uiAlert(text);
    return false;
  }
  if(validation) {validation.textContent='';validation.classList.add('hidden');}
  const s=selectedService();
  $('confirmSummary').innerHTML=`姓名：<b>${esc(name)}</b><br>生日：<b>${esc(birthDate)}</b><br>電話：<b>${esc(phone)}</b><br>服務：<b>${esc(s.name)}</b><br>日期：<b>${esc(selectedDate)}</b><br>時間：<b>${esc(selectedStartTime)}–${esc(timeAddMinutes(selectedStartTime,s.durationMinutes))}</b>`;
  $('formView').classList.add('hidden');
  $('confirmView').classList.remove('hidden');
  setStep(4);
  return true;
}
async function submitBooking(){const name=$('name').value.trim(),birthDate=$('birthDate').value,phone=$('phone').value.trim(),note=$('note').value.trim();const missing=[];if(!state.date)missing.push('日期');if(!state.service)missing.push('服務項目');if(!state.startTime)missing.push('開始時間');if(!name)missing.push('姓名');if(!birthDate)missing.push('西元生日');if(!phone)missing.push('電話');if(missing.length){uiAlert('預約資料不完整：'+missing.join('、'));return}try{$('submit').disabled=true;const r=await api('/api/reservations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:state.date,serviceId:state.service,startTime:state.startTime,name,birthDate,phone,note,lineTicket:getLineTicket()||undefined})});state.lastReservation=r.reservation;clearTimeSelection();$('successSummary').innerHTML=`姓名：${esc(r.reservation.name)}<br>生日：${esc(r.reservation.birthDate)}<br>電話：${esc(r.reservation.phone||'—')}<br>預約代碼：<b class="st-8f370ec5">${esc(r.reservation.bookingCode||'—')}</b>${r.reservation.bookingCode?` <button type="button" class="secondary copyBindBtn" data-act="copyBindCode" data-args="${esc(JSON.stringify([r.reservation.bookingCode]))}">複製</button>`:''}（查詢、取消、改期請保存此代碼）<br>服務：${esc(r.reservation.serviceName)}<br>日期：${esc(r.reservation.date)}<br>時間：${esc(r.reservation.startTime)}–${esc(r.reservation.endTime)}${r.lineBindCode&&!r.lineBound?`<br>綁定碼：<b class="bindCode">${esc(r.lineBindCode)}</b> <button type="button" class="secondary copyBindBtn" data-act="copyBindCode" data-args="${esc(JSON.stringify([r.lineBindCode]))}">複製</button><div class="bindHint">（請將綁定碼回傳官方帳號，以利接收預約提醒）</div>`:''}${r.lineBound?'<div class="bindHint">預約前一天會傳送LINE訊息提醒您</div>':''}`;clearLineTicket();$('confirmView').classList.add('hidden');$('successView').classList.remove('hidden');$('lineBindNotice').classList.add('hidden');setStep(4);updateSide();}catch(e){uiAlert(e.message);if(e.message.includes('LINE 登入'))clearLineTicket();if(e.message.includes('時段')||e.message.includes('預約'))await loadSlots()}finally{$('submit').disabled=false}}
async function copyBindCode(code, btn){
  try { await navigator.clipboard.writeText(String(code)); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = String(code); ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  }
  if (btn) { const old = btn.textContent; btn.textContent = '已複製'; setTimeout(() => { btn.textContent = old; }, 1500); }
}
function bookingText(){const r=state.lastReservation;return `蘿妮的療癒空間預約內容\n姓名：${r.name}\n生日：${r.birthDate}\n電話：${r.phone||'—'}\n服務項目：${r.serviceName}\n日期：${r.date}\n時間：${r.startTime}–${r.endTime}`}
function openLineOfficial(){window.open('https://line.me/R/ti/p/@798tysda?oat_content=url&ts=09230058','_blank','noopener,noreferrer')}
$('manageBookingBtn').onclick=()=>location.href='/manage.html';
function returnToDateSelection(){state.date=null;state.service=null;state.startTime=null;state.slots=[];state.lastReservation=null;clearTimeSelection();$('successView').classList.add('hidden');$('confirmView').classList.add('hidden');$('formView').classList.add('hidden');$('slotView').classList.add('hidden');$('serviceView').classList.add('hidden');$('dateView').classList.remove('hidden');setStep(0);updateSide();renderCalendar();}
$('manageAfterBooking').onclick=returnToDateSelection;$('prevMonth').onclick=async()=>{if($('prevMonth').disabled)return;state.month.setMonth(state.month.getMonth()-1);await renderCalendar()};$('nextMonth').onclick=async()=>{if($('nextMonth').disabled)return;state.month.setMonth(state.month.getMonth()+1);await renderCalendar()};$('backDate').onclick=()=>{$('serviceView').classList.add('hidden');$('dateView').classList.remove('hidden');setStep(0);updateSide()};$('toSlots').onclick=showSlots;$('backService').onclick=()=>{$('slotView').classList.add('hidden');$('serviceView').classList.remove('hidden');setStep(1)};$('toForm').onclick=showForm;$('backSlot').onclick=async()=>{$('formView').classList.add('hidden');$('slotView').classList.remove('hidden');setStep(2);if(state.date&&state.service){restoreTimeSelection();await loadSlots({preserve:true})}};$('toConfirm').onclick=showConfirm;$('backForm').onclick=()=>{$('confirmView').classList.add('hidden');$('formView').classList.remove('hidden');setStep(3)};$('submit').onclick=submitBooking;$('copyBtn').onclick=openLineOfficial;$('officialBtn').onclick=()=>window.open('https://linkgoods.com/journarie','_blank','noopener,noreferrer');
function startLineLogin(){ location.href='/auth/line/start'; }
function b64urlJson(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; return JSON.parse(atob(s)); }
function saveLineTicket(t){ try{ const info=b64urlJson(t.split('.')[0]); sessionStorage.setItem('lineTicket',JSON.stringify({t,exp:info.exp})); }catch(e){} }
function getLineTicket(){ const raw=sessionStorage.getItem('lineTicket'); if(!raw) return null; try{ const o=JSON.parse(raw); if(o.exp&&o.exp>Date.now()) return o.t; }catch(e){} sessionStorage.removeItem('lineTicket'); return null; }
function clearLineTicket(){ sessionStorage.removeItem('lineTicket'); state.lineTicket=null; renderLineSlot(); }
function renderLineSlot(){
  const slot=$('lineLoginSlot'); if(!slot) return;
  if(getLineTicket()||window.__lineSession) slot.innerHTML='<button type="button" class="secondary" data-act="logout">登出</button>';
  else slot.innerHTML='<picture><source media="(max-width:800px)" srcset="/btn_login_1x32dp.png"><img id="lineLoginImg" src="/btn_login_2x32dp.png" alt="用 LINE 登入並綁定" role="button" tabindex="0"></picture>';
  const img=$('lineLoginImg'); if(img){ img.onclick=startLineLogin; img.onkeydown=e=>{ if(e.key==='Enter') startLineLogin(); }; }
}
async function restoreLineReturn(){
  const q=new URLSearchParams(location.search);
  const err=q.get('line_error'), tok=q.get('line_ticket');
  if(tok){ saveLineTicket(tok); history.replaceState(null,'',location.pathname); }
  else if(err){ history.replaceState(null,'',location.pathname); uiAlert('LINE 登入未完成（'+err+'）。您仍可按「確認預約」，之後用綁定碼綁定。'); }
  renderLineSlot();
}
(async()=>{state.config=await api('/api/config');state.month=new Date(state.config.today+'T00:00:00');await renderCalendar();await restoreLineReturn()})().catch(e=>uiAlert(e.message));

// ===== CSP 相容事件委派（取代內嵌 on* 屬性）=====
const ACTIONS = {
  copyBindCode: (el, code) => copyBindCode(code, el),
  logout: () => logoutLine(),
};
document.addEventListener('click', e => {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, ...JSON.parse(el.dataset.args || '[]'));
});

// 登入狀態以工作階段為準（票據只代表預約用的暫存）；已登入：隱藏「查詢／修改預約」，只顯示「我的預約」
window.__lineSession = false;
function applyLoginChrome(){
  const mine=document.getElementById('myReservationsLink'), manage=document.getElementById('manageBookingBtn');
  if(mine) mine.hidden=!window.__lineSession;
  if(manage) manage.hidden=!!window.__lineSession;
  if(typeof renderLineSlot==='function') renderLineSlot();
}
fetch('/api/my/session',{credentials:'same-origin'}).then(r=>(r.ok?r.json():null)).then(d=>{
  window.__lineSession=!!(d&&d.loggedIn); applyLoginChrome();
}).catch(()=>{});
const myBtn=document.getElementById('myReservationsLink');
if(myBtn) myBtn.addEventListener('click',()=>{ location.href='/my-reservations.html'; });
async function logoutLine(){ try{ await fetch('/api/my/logout',{method:'POST',credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}); }catch(e){} try{ sessionStorage.removeItem('lineTicket'); }catch(e){} location.reload(); }
// 登入後自動帶入上次填寫的姓名、生日、電話；已登入的預約完成頁不顯示預約代碼
(function(){
  const fill=(id,v)=>{ const el=document.getElementById(id); if(el && !el.value && v) el.value=v; };
  fetch('/api/my/session',{credentials:'same-origin'}).then(r=>(r.ok?r.json():null)).then(s=>{
    if(!s||!s.loggedIn) return;
    return fetch('/api/my/profile',{credentials:'same-origin'}).then(r=>(r.ok?r.json():null)).then(d=>{
      const p=d&&d.profile; if(p){ fill('name',p.name); fill('birthDate',p.birthDate); fill('phone',p.phone); }
    });
  }).catch(()=>{});
  const sum=document.getElementById('successSummary');
  if(sum){ new MutationObserver(()=>{ if(window.__lineSession && sum.innerHTML.includes('預約代碼：')) sum.innerHTML=sum.innerHTML.replace(/預約代碼：[\s\S]*?<br>/,''); }).observe(sum,{childList:true}); }
})();
