/* Панель компонентов: карточки с иконками символов и счётчиками «размещено/всего». */
(function () {
  'use strict';
  const E = window.Editor; const P = (window.Palette = {});
  let root, cards = [], toastFn = () => {};
  P.setToast = (f) => (toastFn = f);

  P.init = function (el) {
    root = el; root.innerHTML = ''; cards = [];
    const add = (kind, key, title, icon, tag) => {
      const c = document.createElement('div'); c.className = 'pcard'; c.dataset.kind = kind; c.dataset.key = key; c.setAttribute('role', 'button'); c.tabIndex = 0;
      c.dataset.tip = title; c.dataset.pos = 'r';
      c.innerHTML = `<span class="ptag">${tag}</span>${icon}${kind === 'group' ? '<span class="cnt"></span>' : ''}`;
      root.appendChild(c); cards.push(c); bind(c); return c;
    };
    E.groups().forEach((g) => add('group', g.lib, `${g.title}: ${g.refs[0]}–${g.refs[g.refs.length - 1]}`.replace(/(\w+)–\1$/, '$1'), E.symbolSvg(g.lib, 56), (g.refs[0].match(/[A-Za-z]+/) || [''])[0].slice(0, 3)));
    const sep = document.createElement('div'); sep.className = 'psep'; root.appendChild(sep);
    E.powers().forEach((pw) => add('power', pw.name, (pw.name === 'GND' ? 'Земля (GND)' : 'Питание ' + pw.name), E.symbolSvg(pw.lib, 56), ''));
    const trash = document.createElement('div'); trash.className = 'ptrash'; trash.innerHTML = '<svg class="ic"><use href="#i-trash"/></svg>'; root.appendChild(trash);
    E.paletteHit = (x, y) => { const r = root.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
    E.onPaletteHover = (on) => root.classList.toggle('removing', !!on);
    P.update();
  };

  P.update = function () {
    const gs = Object.fromEntries(E.groups().map((g) => [g.lib, g]));
    cards.forEach((c) => {
      const cnt = c.querySelector('.cnt');
      if (c.dataset.kind === 'group') { const g = gs[c.dataset.key]; cnt.textContent = g.placed + '/' + g.total; c.classList.toggle('full', g.placed === g.total); c.classList.toggle('some', g.placed > 0 && g.placed < g.total); }
      else c.classList.toggle('some', E.powerCount(c.dataset.key) > 0);
    });
  };

  function bind(card) {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault();
      const kind = card.dataset.kind, key = card.dataset.key;
      if (card.classList.contains('full')) { toastFn('Все компоненты этого типа уже на схеме. Чтобы убрать, перетащите лишний обратно в панель.'); return; }
      const sx = e.clientX, sy = e.clientY; let ghost = null, moved = false;
      const mv = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) { moved = true; ghost = document.createElement('div'); ghost.className = 'ghost'; ghost.innerHTML = card.querySelector('svg').outerHTML; document.body.appendChild(ghost); }
        if (ghost) { ghost.style.transform = `translate(${ev.clientX - 36}px,${ev.clientY - 36}px)`; ghost.classList.toggle('ok', E.containsClient(ev.clientX, ev.clientY)); }
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); ghost && ghost.remove();
        if (!moved) { E.dropFromPalette(kind, key); }
        else if (E.containsClient(ev.clientX, ev.clientY)) E.dropFromPalette(kind, key, ev.clientX, ev.clientY);
      };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); E.dropFromPalette(card.dataset.kind, card.dataset.key); } });
  }
})();
