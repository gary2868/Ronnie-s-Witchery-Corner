const $=id=>document.getElementById(id);let config=null,current=null,selectedStart=null,lookupResults=[];
const api=async(url,opt={})=>{const r=await fetch(url,opt);const d=await r.json();if(!r.ok)throw new Error(d.error||'操作失敗');return d};
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
let lookupCode='';const bookingCodeVal=()=>$('bookingCode').value.trim().toUpperCase();
const phone=()=>$('phone').value.trim();
function copyBindCode(code, btn){
  const text = String(code);
  const flash = () => { if (btn) { const old = btn.textContent; btn.textContent = '已複製'; setTimeout(() => { btn.textContent = old; }, 1500); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(flash, () => fallbackCopy(text, flash));
  } else { fallbackCopy(text, flash); }
}
function fallbackCopy(text, done){
  const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
  ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {} finally { document.body.removeChild(ta); }
  done();
}
function renderCurrent(){const r=current;$('currentSummary').innerHTML=`<b>姓名：</b>${esc(r.name)}<br><b>生日：</b>${esc(r.birthDate||'—')}<br><b>電話：</b>${esc(r.phone||'—')}<br><b>服務：</b>${esc(r.serviceName)}（${r.durationMinutes} 分鐘）<br><b>日期：</b>${esc(r.date)}<br><b>時間：</b>${esc(r.startTime)}–${esc(r.endTime)}<br><b>綁定碼：</b>${r.lineBindCode?`<span class="bindCodeText">${esc(r.lineBindCode)}</span><button type="button" class="secondary copyBindBtn" data-act="copyBindCode" data-args="${esc(JSON.stringify([r.lineBindCode]))}">複製</button>${r.lineBound?'（已綁定）':''}`:'—'}`}
function showNotice(msg){$('notice').textContent=msg;$('notice').classList.remove('hidden')}
function selectReservation(i){current=lookupResults[i];$('lookupView').classList.add('hidden');$('manageView').classList.remove('hidden');$('newDate').min=addDays(config.today,1);$('newDate').max=config.maxAdvanceDate;$('newDate').value=current.date<addDays(config.today,1)?addDays(config.today,1):current.date;$('newService').innerHTML=config.services.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}（${s.durationMinutes} 分鐘）</option>`).join('');$('newService').value=current.serviceId;renderCurrent();loadSlots()}
function renderLookupResults(){let box=$('lookupResults');if(!box){box=document.createElement('div');box.id='lookupResults';$('lookupView').appendChild(box)}box.innerHTML='<h3>找到的預約</h3>';lookupResults.forEach((r,i)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.style.cssText='display:block;width:100%;margin:8px 0;text-align:left';b.textContent=`${r.date} ${r.startTime}–${r.endTime}｜${r.serviceName}`;b.onclick=()=>selectReservation(i);box.appendChild(b)})}
async function loadSlots(){selectedStart=null;$('slots').innerHTML='';const date=$('newDate').value,serviceId=$('newService').value;if(!date||!serviceId||!current)return;const d=await api('/api/manage/availability?date='+encodeURIComponent(date)+'&serviceId='+encodeURIComponent(serviceId)+'&reservationId='+encodeURIComponent(current.id)+'&bookingCode='+encodeURIComponent(lookupCode));$('slotHint').textContent=d.closed?'此日期無法預約。':'請選擇開始時間（09:00–20:00）。服務結束後鎖定 30 分鐘。';d.slots.forEach(t=>{const b=document.createElement('button');b.type='button';b.className='slot';b.textContent=t;if(d.available.includes(t)){b.onclick=()=>{document.querySelectorAll('.slot').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');selectedStart=t}}else{b.classList.add('booked');b.disabled=true}$('slots').appendChild(b)})}
async function lookup(){const p=phone();const bc=bookingCodeVal();if(!p){alert('請輸入電話。');return}if(!bc){alert('請輸入預約代碼。');return}try{$('lookupBtn').disabled=true;config=config||await api('/api/config');const r=await api('/api/manage/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p,bookingCode:bc})});lookupCode=bc;lookupResults=r.reservations||[];if(lookupResults.length===1)selectReservation(0);else renderLookupResults()}catch(e){alert(e.message)}finally{$('lookupBtn').disabled=false}}
function addDays(date,days){const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+days);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function confirmAction(message,changes=[]){return new Promise(resolve=>{const modal=$('confirmModal'),msg=$('confirmMessage'),yes=$('confirmYes'),no=$('confirmNo');msg.textContent=message;const old=$('confirmChangeList');if(old)old.remove();if(changes.length){const box=document.createElement('div');box.id='confirmChangeList';box.className='confirm-change-list';box.innerHTML=changes.map(c=>`<div class=\"confirm-change-row\"><span class=\"confirm-change-label\">${esc(c.label)}：</span><span>${esc(c.oldValue)}</span><span class=\"confirm-change-arrow\">→</span><span>${esc(c.newValue)}</span></div>`).join('');msg.insertAdjacentElement('afterend',box)}modal.classList.remove('hidden');modal.setAttribute('aria-hidden','false');const finish=value=>{modal.classList.add('hidden');modal.setAttribute('aria-hidden','true');yes.onclick=null;no.onclick=null;resolve(value)};yes.onclick=()=>finish(true);no.onclick=()=>finish(false);$('confirmModal').querySelector('.confirm-backdrop').onclick=()=>finish(false);yes.focus()})}
function backToLookup(){current=null;selectedStart=null;$('manageView').classList.add('hidden');$('lookupView').classList.remove('hidden');$('notice').classList.add('hidden');$('slots').innerHTML='';$('phone').value='';$('bookingCode').value='';lookupCode='';const results=$('lookupResults');if(results)results.remove()}
function timeAddMinutes(start,minutes){const [h,m]=String(start).split(':').map(Number);const total=h*60+m+Number(minutes||0);return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`}
function getSelectedService(){return (config?.services||[]).find(s=>String(s.id)===String($('newService').value))||null}
async function update(){if(!current)return;if(!selectedStart){alert('請選擇新的時間。');return}const svc=getSelectedService();const newService=svc?.name||'';const newDate=$('newDate').value;const newEnd=timeAddMinutes(selectedStart,svc?.durationMinutes||0);const oldTime=`${current.startTime}–${current.endTime}`;const newTime=`${selectedStart}–${newEnd}`;const changes=[];if(String(current.serviceName||'')!==String(newService))changes.push({label:'服務',oldValue:current.serviceName||'—',newValue:newService||'—'});if(String(current.date||'')!==String(newDate))changes.push({label:'日期',oldValue:current.date||'—',newValue:newDate||'—'});if(oldTime!==newTime)changes.push({label:'時間',oldValue:oldTime,newValue:newTime});if(!changes.length)changes.push({label:'狀態',oldValue:'無變更',newValue:'請確認後儲存'});if(!(await confirmAction('確定要修改這筆預約嗎？',changes)))return;try{$('updateBtn').disabled=true;const result=await api('/api/manage/reservations/'+encodeURIComponent(current.id)+'/update',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:current.phone,bookingCode:lookupCode,date:newDate,serviceId:$('newService').value,startTime:selectedStart})});sessionStorage.setItem('ronnieModifyResult',JSON.stringify(result.reservation||{}));window.location.href='/modify-result.html'}catch(e){alert(e.message);await loadSlots()}finally{$('updateBtn').disabled=false}}
async function cancelBooking(){if(!current)return;if(!(await confirmAction('確定要取消這筆預約嗎？取消後該時段會重新開放。')))return;try{$('cancelBtn').disabled=true;await api('/api/manage/reservations/'+encodeURIComponent(current.id)+'/cancel',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:current.phone,bookingCode:lookupCode})});backToLookup();
confirmAction('預約已取消。');}catch(e){alert(e.message)}finally{$('cancelBtn').disabled=false}}
$('lookupBtn').onclick=lookup;$('newDate').onchange=loadSlots;$('newService').onchange=loadSlots;$('updateBtn').onclick=update;$('cancelBtn').onclick=cancelBooking;$('backLookup').onclick=backToLookup;
(async()=>{try{config=await api('/api/config')}catch(e){alert(e.message)}})();

// ===== CSP 相容事件委派（取代內嵌 on* 屬性）=====
const ACTIONS = {
  goHome: () => { location.href = '/'; },
  copyBindCode: (el, code) => copyBindCode(code, el),
};
document.addEventListener('click', e => {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, ...JSON.parse(el.dataset.args || '[]'));
});
