const info=document.getElementById('info');
const esc=s=>String(s??'—').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
let r=null;
try{r=JSON.parse(sessionStorage.getItem('ronnieModifyResult')||'null')}catch(e){r=null}
if(!r){info.innerHTML='<div class="row"><span class="value">找不到修改後的預約資訊。</span></div>'}else{
 const time=(r.startTime||'—')+'–'+(r.endTime||'—');
 info.innerHTML=[
  ['姓名',r.name],['生日',r.birthDate],['電話',r.phone],['服務',r.serviceName],['日期',r.date],['時間',time]
 ].map(x=>`<div class="row"><span class="label">${esc(x[0])}：</span><span class="value">${esc(x[1])}</span></div>`).join('');
}
document.getElementById('backBooking').onclick=()=>{sessionStorage.removeItem('ronnieModifyResult');window.location.href='/'};
