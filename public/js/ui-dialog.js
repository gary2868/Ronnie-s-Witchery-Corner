// 頁面內對話框：取代瀏覽器原生 alert／confirm（原生對話框會顯示網址列，無法隱藏）。純文字顯示，不使用 innerHTML。
(function () {
  function box(message, buttons) {
    return new Promise(resolve => {
      const mask = document.createElement('div');
      mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(40,30,55,.35);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
      const card = document.createElement('div');
      card.style.cssText = 'background:#fff;color:#2b2233;border-radius:16px;max-width:420px;width:100%;padding:20px 22px;box-shadow:0 10px 30px rgba(0,0,0,.2);font:15px/1.6 "Noto Sans TC",system-ui,sans-serif';
      const text = document.createElement('div'); text.style.whiteSpace = 'pre-wrap'; text.textContent = String(message == null ? '' : message);
      card.appendChild(text);
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:18px';
      const onKey = e => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
      const done = v => { document.removeEventListener('keydown', onKey); mask.remove(); resolve(v); };
      buttons.forEach(b => {
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = b.label;
        btn.style.cssText = b.primary
          ? 'border:0;border-radius:12px;padding:9px 18px;background:linear-gradient(135deg,#9b7fc4,#6f5590);color:#fff;font:inherit;cursor:pointer'
          : 'border:1px solid #d8cbe8;border-radius:12px;padding:9px 18px;background:#fff;color:#6f5590;font:inherit;cursor:pointer';
        btn.addEventListener('click', () => done(b.value)); row.appendChild(btn);
      });
      card.appendChild(row); mask.appendChild(card); document.body.appendChild(mask);
      document.addEventListener('keydown', onKey);
      mask.addEventListener('click', e => { if (e.target === mask) done(false); });
      const first = row.querySelector('button:last-child'); if (first) first.focus();
    });
  }
  window.uiAlert = msg => box(msg, [{ label: '確定', value: true, primary: true }]);
  window.uiConfirm = msg => box(msg, [{ label: '取消', value: false }, { label: '確定', value: true, primary: true }]);
})();
