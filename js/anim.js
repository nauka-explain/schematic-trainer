/* Анимация построения эталонной схемы: компоненты появляются один за другим,
   затем «прорисовываются» провода. Работает на отдельном слое, сборка пользователя не затрагивается.
   Параллельно подсвечиваются соответствующие детали на 3D-плате. */
(function () {
  'use strict';
  const E = window.Editor, V = window.Viewer3D; let D = null;
  const A = (window.Anim = {});
  const SPEEDS = [0.5, 1, 2, 4];
  let ov = null, raf = 0, t = 0, T = 1, playing = false, speed = 1, last = 0, svg, root, head, seek, cap, btnPlay, btnSpd;
  let items = { comps: [], wires: [], juncs: [] }, view = { x: 0, y: 0, k: 5 }, focusKey = '', dragging = false, ptr = null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ic = (id) => `<svg class="ic"><use href="#${id}"/></svg>`;
  const rk = (x, y) => Math.round(x * 10) + '|' + Math.round(y * 10);
  const plen = (p) => { let s = 0; for (let i = 0; i + 1 < p.length; i++) s += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]); return s; };
  const onSeg = (q, a, b) => Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) < 0.05 && q[0] >= Math.min(a[0], b[0]) - 0.02 && q[0] <= Math.max(a[0], b[0]) + 0.02 && q[1] >= Math.min(a[1], b[1]) - 0.02 && q[1] <= Math.max(a[1], b[1]) + 0.02;
  const refOf = (k) => (String(k).startsWith('#') || /^PWR/.test(k) ? null : String(k).split('.')[0]);

  A.isOpen = () => !!ov;
  A.close = function () {
    if (!ov) return; cancelAnimationFrame(raf); ov.remove(); ov = null; window.removeEventListener('keydown', onKey);
    V.focus && V.focus([]);
  };
  A.open = function (host) {
    if (ov) return; D = E.data(); build(host); fit(); t = 0; playing = true; last = performance.now(); raf = requestAnimationFrame(tick); window.addEventListener('keydown', onKey);
  };

  function build(host) {
    const comps = D.insts.map((i) => ({ id: i.id, lib: i.lib, x: i.x, y: i.y, rot: i.rot, mir: i.mir, val: i.val, power: i.power }));
    const byPos = (a, b) => a.x - b.x || a.y - b.y;
    const real = comps.filter((c) => !c.power).sort(byPos), pw = comps.filter((c) => c.power).sort(byPos);
    ov = document.createElement('div'); ov.id = 'anim';
    ov.innerHTML = `<svg class="sch animsvg"><defs><pattern id="agrid" width="10" height="10" patternUnits="userSpaceOnUse"><circle r="0.8" fill="#b9b6a8"/></pattern></defs><rect width="100%" height="100%" fill="url(#agrid)"/><g id="aroot"><g id="aw"></g><g id="ac"></g><g id="aj"></g><g id="ap"></g><circle id="ahead" class="ahead" r="1.1" visibility="hidden"/></g></svg>
      <div class="animtag">${ic('i-playc')}<span>Эталонная схема</span></div>
      <div class="animbar">
        <button class="ico" id="aPlay" data-tip="Пауза / продолжить (пробел)" aria-label="Пауза">${ic('i-pause')}</button>
        <button class="ico" id="aRestart" data-tip="Сначала" aria-label="Сначала">${ic('i-restart')}</button>
        <input type="range" id="aSeek" min="0" max="1000" value="0" aria-label="Положение анимации">
        <button id="aSpeed" class="spd" data-tip="Скорость">1×</button>
        <span id="aCap"></span>
        <button class="ico" id="aClose" data-tip="Закрыть (Esc)" aria-label="Закрыть">${ic('i-close')}</button>
      </div>`;
    host.appendChild(ov);
    svg = ov.querySelector('svg.animsvg'); root = ov.querySelector('#aroot'); head = ov.querySelector('#ahead'); seek = ov.querySelector('#aSeek'); cap = ov.querySelector('#aCap'); btnPlay = ov.querySelector('#aPlay'); btnSpd = ov.querySelector('#aSpeed');
    const gW = ov.querySelector('#aw'), gC = ov.querySelector('#ac'), gJ = ov.querySelector('#aj'), gP = ov.querySelector('#ap');
    items = { comps: [], wires: [], juncs: [] }; const pinAt = {}, pinPos = {}; let cur = 0.2;

    // --- компоненты
    [...real, ...pw].forEach((cm, i) => {
      const isP = cm.power; const start = cur; const dur = isP ? 0.28 : 0.45; cur += isP ? 0.1 : 0.22;
      const s = E.staticComp(cm); const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.setAttribute('class', 'acomp'); g.innerHTML = s.body + s.text; gC.appendChild(g);
      const pins = s.pins.map((p) => { const pg = document.createElementNS('http://www.w3.org/2000/svg', 'g'); pg.setAttribute('class', 'pin'); pg.setAttribute('transform', `translate(${p.x} ${p.y})`); pg.innerHTML = `<circle class="pd" r="${isP ? 0.5 : 0.55}"/>`; pg.style.opacity = 0; gP.appendChild(pg); const o = { el: pg, n: 0 }; (pinAt[rk(p.x, p.y)] = pinAt[rk(p.x, p.y)] || []).push(o); pinPos[p.key] = p; return o; });
      items.comps.push({ cm, els: [g], pins, start, dur, p: -1 });
    });
    const compsEnd = cur + 0.5; cur = compsEnd;

    // --- провода: сигнальные цепи слева направо, затем +BATT и GND
    const netX = D.nets.map((n) => Math.min(...n.pins.map((k) => (pinPos[k] ? pinPos[k].x : 1e9))));
    const pr = D.nets.map((n, i) => ({ i, p: n.name === 'GND' ? 2 : n.name ? 1 : 0, x: netX[i] })).sort((a, b) => a.p - b.p || a.x - b.x); const rank = {}; pr.forEach((r, k) => (rank[r.i] = k));
    const ws = D.wires.map((w, i) => ({ pts: w.p, n: w.n, i, mx: Math.min(...w.p.map((q) => q[0])), my: Math.min(...w.p.map((q) => q[1])) })).sort((a, b) => rank[a.n] - rank[b.n] || a.mx - b.mx || a.my - b.my);
    ws.forEach((w) => {
      const L = plen(w.pts), dur = clamp(L / 70, 0.14, 0.55), start = cur; cur += dur * 0.8;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); el.setAttribute('class', 'wire'); el.setAttribute('points', w.pts.map((q) => q.join(',')).join(' ')); el.setAttribute('pathLength', '1');
      el.style.strokeDasharray = '1 1'; el.style.strokeDashoffset = 1; el.style.visibility = 'hidden'; gW.appendChild(el);
      const ends = [w.pts[0], w.pts[w.pts.length - 1]].map((q) => pinAt[rk(q[0], q[1])] || []).flat();
      const keys = [w.pts[0], w.pts[w.pts.length - 1]].map((q) => Object.values(pinPos).filter((p) => rk(p.x, p.y) === rk(q[0], q[1])).map((p) => p.key)).flat();
      items.wires.push({ el, pts: w.pts, L, start, dur, ends, refs: [...new Set(keys.map(refOf).filter(Boolean))], net: w.n, p: -1, done: false });
    });
    const wiresEnd = Math.max(...items.wires.map((w) => w.start + w.dur));
    // --- узлы (точки соединения)
    D.juncs.forEach((j) => {
      let when = 0; items.wires.forEach((w) => { for (let i = 0; i + 1 < w.pts.length; i++) if (onSeg(j, w.pts[i], w.pts[i + 1])) { when = Math.max(when, w.start + w.dur); break; } });
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('class', 'ajunc'); c.setAttribute('cx', j[0]); c.setAttribute('cy', j[1]); c.setAttribute('r', 0.62); gJ.appendChild(c); items.juncs.push({ el: c, when });
    });
    T = wiresEnd + 1.2;
    // --- элементы управления
    btnPlay.onclick = toggle; ov.querySelector('#aRestart').onclick = () => { t = 0; focusKey = ''; playing = true; icons(); };
    ov.querySelector('#aClose').onclick = A.close;
    btnSpd.onclick = () => { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; btnSpd.textContent = speed + '×'; };
    seek.oninput = () => { dragging = true; t = (seek.value / 1000) * T; focusKey = ''; };
    seek.onchange = () => (dragging = false);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, k2 = clamp(view.k * Math.exp(-e.deltaY * 0.0015), 1, 30); view.x = mx - ((mx - view.x) / view.k) * k2; view.y = my - ((my - view.y) / view.k) * k2; view.k = k2; applyView(); }, { passive: false });
    svg.addEventListener('pointerdown', (e) => { ptr = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', (e) => { if (ptr) { view.x = ptr.vx + e.clientX - ptr.x; view.y = ptr.vy + e.clientY - ptr.y; applyView(); } });
    svg.addEventListener('pointerup', () => (ptr = null));
    ov.dataset.bbox = JSON.stringify(bbox(real.concat(pw)));
  }
  function bbox(cs) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; cs.forEach((c) => { const b = E.libBox(c); x0 = Math.min(x0, b.x0 - 4); y0 = Math.min(y0, b.y0 - 6); x1 = Math.max(x1, b.x1 + 4); y1 = Math.max(y1, b.y1 + 6); }); return [x0, y0, x1, y1]; }
  function applyView() { root.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); const g = svg.querySelector('#agrid'); const s = 2.54 * view.k; g.setAttribute('width', s); g.setAttribute('height', s); g.setAttribute('patternTransform', `translate(${view.x} ${view.y})`); g.firstElementChild.setAttribute('r', clamp(view.k * 0.12, 0.6, 1.2)); }
  function fit() {
    const [x0, y0, x1, y1] = JSON.parse(ov.dataset.bbox), r = svg.getBoundingClientRect(); const bottom = 70; // место под панель управления
    const k = Math.min(r.width / (x1 - x0), (r.height - bottom) / (y1 - y0)) * 0.97; view.k = k; view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k; view.y = (r.height - bottom - (y1 - y0) * k) / 2 - y0 * k; applyView();
  }
  function icons() { btnPlay.innerHTML = ic(playing ? 'i-pause' : 'i-play'); btnPlay.dataset.tip = playing ? 'Пауза (пробел)' : t >= T ? 'Повторить (пробел)' : 'Продолжить (пробел)'; }
  function toggle() { if (!playing && t >= T) { t = 0; focusKey = ''; } playing = !playing; icons(); }
  function onKey(e) { if (!ov) return; if (e.key === 'Escape') { A.close(); e.preventDefault(); } else if (e.code === 'Space') { e.preventDefault(); toggle(); } }

  function render() {
    items.comps.forEach((it) => {
      const p = clamp((t - it.start) / it.dur, 0, 1); if (p === it.p) return; it.p = p; const e = 1 - Math.pow(1 - p, 3);
      it.els.forEach((el) => { el.style.opacity = p; el.style.transform = `translateY(${(-(1 - e) * 4).toFixed(2)}px) scale(${(0.8 + 0.2 * e).toFixed(3)})`; });
      it.pins.forEach((o) => (o.el.style.opacity = p));
    });
    let active = null, lastStarted = -1;
    items.wires.forEach((w, i) => {
      const p = clamp((t - w.start) / w.dur, 0, 1); if (t >= w.start) lastStarted = i; if (p > 0 && p < 1) active = { w, p, i };
      if (p === w.p) return; w.p = p; w.el.style.visibility = p > 0 ? 'visible' : 'hidden'; w.el.style.strokeDashoffset = 1 - p;
      const done = p >= 1; if (done !== w.done) { w.done = done; w.ends.forEach((o) => { o.n += done ? 1 : -1; o.el.classList.toggle('on', o.n > 0); }); }
    });
    items.juncs.forEach((j) => (j.el.style.visibility = t >= j.when ? 'visible' : 'hidden'));
    // «перо» на конце рисуемого провода
    if (active) { let d = active.p * active.w.L, pts = active.w.pts, x = pts[0][0], y = pts[0][1]; for (let i = 0; i + 1 < pts.length; i++) { const s = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if (d <= s || i === pts.length - 2) { const f = s ? clamp(d / s, 0, 1) : 0; x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f; y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f; break; } d -= s; } head.setAttribute('cx', x); head.setAttribute('cy', y); head.setAttribute('visibility', 'visible'); } else head.setAttribute('visibility', 'hidden');
    // подпись и подсветка на 3D-плате
    let key, refs = [], text = '';
    const firstWire = items.wires[0].start;
    if (t < firstWire - 0.4) { let k = -1; items.comps.forEach((c, i) => { if (t >= c.start) k = i; }); if (k >= 0) { const c = items.comps[k].cm; key = 'c' + k; refs = c.power ? [] : [c.id]; text = c.power ? c.val : `${c.id} · ${c.val}`; } else { key = 'start'; text = 'Компоненты'; } }
    else if (t >= T - 1.1) { key = 'end'; text = 'Готово'; }
    else if (lastStarted >= 0) { const w = items.wires[lastStarted], n = D.nets[w.net]; key = 'w' + lastStarted; refs = w.refs; text = 'Цепь: ' + (n && n.name ? n.name : 'сигнал'); }
    else { key = 'gap'; text = 'Провода'; }
    if (key !== focusKey) { focusKey = key; cap.textContent = text; V.focus && V.focus(refs, false); }
    if (!dragging) seek.value = Math.round((t / T) * 1000);
  }
  function tick(now) {
    raf = requestAnimationFrame(tick); const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (playing) { t = Math.min(T, t + dt * speed); if (t >= T) { playing = false; icons(); } }
    render();
  }
})();
