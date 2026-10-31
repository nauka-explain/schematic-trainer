/* Редактор схемы на SVG: символы KiCad, провода, узлы, пан/зум, undo/redo. */
(function () {
  'use strict';
  const D = window.SCH_DATA;
  const E = (window.Editor = {});
  const COL = { body: '#840000', fill: '#FFFFC2', wire: '#00842c', pinTxt: '#a40000', nameTxt: '#006464', refTxt: '#006464' };
  const SNAP = 1.27, STUB = 2.54;
  let svg, root, layers = {}, S, view = { x: 0, y: 0, k: 4 }, tool = 'select', cursor = { x: 0, y: 0 };
  let sel = null; // {type:'comp'|'edge'|'node', id}
  let drawing = null, drag = null, pan = null, hover = null, pinMap = {}, hist = [], fut = [];
  let result = null, ratsnest = false, hint = null, pointers = new Map(), pinch = null, bbCache = {};
  E.onChange = null; E.onSelect = null; E.onStatus = null;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = (n) => Math.round(n * 100) / 100;
  const snap = (v) => Math.round(v / SNAP) * SNAP;

  function tf(px, py, rot, mir) {
    if (mir === 'x') py = -py; if (mir === 'y') px = -px;
    const a = (rot * Math.PI) / 180, c = Math.round(Math.cos(a) * 1e6) / 1e6, s = Math.round(Math.sin(a) * 1e6) / 1e6;
    return [px * c + py * s, -px * s + py * c];
  }
  function libBBox(lib) {
    if (bbCache[lib]) return bbCache[lib];
    const L = D.libs[lib]; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const ext = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    L.g.forEach((g) => { if (g.t === 'circle') { ext(g.cx - g.r, g.cy - g.r); ext(g.cx + g.r, g.cy + g.r); } else { const m = g.d.match(/-?\d+\.?\d*/g) || []; for (let i = 0; i + 1 < m.length; i += 2) ext(+m[i], +m[i + 1]); } });
    L.pins.forEach((p) => ext(p.x, p.y));
    if (x0 > x1) { x0 = -2; x1 = 2; y0 = -2; y1 = 2; }
    return (bbCache[lib] = { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 });
  }

  /* ---------- состояние ---------- */
  function freshComps() {
    return D.insts.map((i) => ({ id: i.id, lib: i.lib, x: i.x, y: i.y, rot: i.rot, mir: i.mir, val: i.val, fp: i.fp, power: i.power, lr: i.lr, lv: i.lv, user: false, ox: i.x, oy: i.y }));
  }
  function initState() { S = { comps: freshComps(), nodes: [], edges: [], next: 1, uid: 1 }; }
  const snapshot = () => JSON.stringify(S);
  function push() { hist.push(snapshot()); if (hist.length > 120) hist.shift(); fut = []; }
  function changed(clearRes = true) { if (clearRes) { result = null; hint = null; } rebuildPins(); render(); E.onChange && E.onChange(); status(); }
  E.undo = () => { if (!hist.length) return; fut.push(snapshot()); S = JSON.parse(hist.pop()); sel = null; drawing = null; changed(); };
  E.redo = () => { if (!fut.length) return; hist.push(snapshot()); S = JSON.parse(fut.pop()); sel = null; drawing = null; changed(); };

  /* ---------- геометрия выводов ---------- */
  function pinsOf(c) {
    const L = D.libs[c.lib];
    return L.pins.map((p) => {
      const [wx, wy] = tf(p.x, p.y, c.rot, c.mir);
      const r = (p.r * Math.PI) / 180; const [dx, dy] = tf(Math.cos(r), -Math.sin(r), c.rot, c.mir);
      const [bx, by] = tf(p.x + Math.cos(r) * p.l, p.y - Math.sin(r) * p.l, c.rot, c.mir);
      return { key: c.power ? c.id : c.id + '.' + p.u, comp: c, num: p.u, name: p.n, x: f2(c.x + wx), y: f2(c.y + wy), ox: -Math.round(dx), oy: -Math.round(dy), bx: c.x + bx, by: c.y + by, len: p.l, lp: p };
    });
  }
  function rebuildPins() { pinMap = {}; S.comps.forEach((c) => pinsOf(c).forEach((p) => (pinMap[p.key] = p))); }
  const nodeById = (id) => S.nodes.find((n) => n.id === id);
  function nodePos(key) {
    if (pinMap[key]) return pinMap[key];
    const n = nodeById(key); return n ? { x: n.x, y: n.y, ox: 0, oy: 0 } : { x: 0, y: 0, ox: 0, oy: 0 };
  }

  /* ---------- маршрутизация (ортогональная) ---------- */
  function manh(p, q, fa, la) {
    if (Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01) return [[p.x, p.y], [q.x, q.y]];
    if (fa === 'h' && la === 'h') { const m = snap((p.x + q.x) / 2); return [[p.x, p.y], [m, p.y], [m, q.y], [q.x, q.y]]; }
    if (fa === 'v' && la === 'v') { const m = snap((p.y + q.y) / 2); return [[p.x, p.y], [p.x, m], [q.x, m], [q.x, q.y]]; }
    if (fa === 'h') return [[p.x, p.y], [q.x, p.y], [q.x, q.y]];
    return [[p.x, p.y], [p.x, q.y], [q.x, q.y]];
  }
  const axis = (o) => (o.ox ? 'h' : o.oy ? 'v' : null);
  function route(a, b) {
    const hasA = a.ox || a.oy, hasB = b.ox || b.oy;
    const A1 = hasA ? { x: a.x + a.ox * STUB, y: a.y + a.oy * STUB } : a, B1 = hasB ? { x: b.x + b.ox * STUB, y: b.y + b.oy * STUB } : b;
    let fa = hasA ? axis(a) : hasB ? (axis(b) === 'h' ? 'v' : 'h') : Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? 'h' : 'v';
    let la = hasB ? axis(b) : hasA ? (axis(a) === 'h' ? 'v' : 'h') : fa === 'h' ? 'v' : 'h';
    let pts = [];
    if (hasA) pts.push([a.x, a.y]);
    pts = pts.concat(manh(A1, B1, fa, la));
    if (hasB) pts.push([b.x, b.y]);
    const out = [];
    pts.forEach((p) => { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - p[0]) > 0.01 || Math.abs(l[1] - p[1]) > 0.01) out.push(p); });
    for (let i = out.length - 2; i > 0; i--) { const [p, q, r] = [out[i - 1], out[i], out[i + 1]]; if ((Math.abs(p[0] - q[0]) < 0.01 && Math.abs(q[0] - r[0]) < 0.01) || (Math.abs(p[1] - q[1]) < 0.01 && Math.abs(q[1] - r[1]) < 0.01)) out.splice(i, 1); }
    return out;
  }
  const ptsStr = (pts) => pts.map((p) => f2(p[0]) + ',' + f2(p[1])).join(' ');
  function nearestOn(pts, x, y) {
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy || 1;
      let t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)); const px = ax + t * dx, py = ay + t * dy; const d = Math.hypot(px - x, py - y);
      if (!best || d < best.d) best = { d, x: px, y: py, horiz: Math.abs(dy) < 0.01 };
    }
    return best;
  }

  /* ---------- цепи пользователя ---------- */
  function userNets() {
    const p = new Map(); const f = (a) => { if (!p.has(a)) p.set(a, a); while (p.get(a) !== a) { p.set(a, p.get(p.get(a))); a = p.get(a); } return a; };
    S.edges.forEach((e) => p.set(f(e.a), f(e.b)));
    S.comps.filter((c) => c.power).forEach((c) => p.set(f(c.id), f('NET:' + c.val)));
    return f;
  }

  /* ---------- отрисовка ---------- */
  function render() {
    const nets = userNets(); const hovNet = hover && (hover.net !== undefined ? hover.net : null);
    const deg = {}; S.edges.forEach((e) => { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; });
    let w = '', c = '', t = '', o = '', pn = '';
    // провода
    S.edges.forEach((e) => {
      const pts = route(nodePos(e.a), nodePos(e.b)); e._pts = pts;
      let cls = 'wire'; const st = result && result.edgeStatus[e.id]; if (st) cls += ' ' + st;
      if (sel && sel.type === 'edge' && sel.id === e.id) cls += ' sel';
      if (hovNet !== null && nets(e.a) === hovNet) cls += ' hot';
      w += `<polyline class="${cls}" points="${ptsStr(pts)}"/>`;
      w += `<polyline class="hit" data-kind="edge" data-id="${e.id}" points="${ptsStr(pts)}"/>`;
    });
    // компоненты
    S.comps.forEach((cm) => {
      const L = D.libs[cm.lib]; const bb = libBBox(cm.lib);
      const sx = cm.mir === 'y' ? -1 : 1, sy = cm.mir === 'x' ? -1 : 1;
      const cls = 'comp' + (sel && sel.type === 'comp' && sel.id === cm.id ? ' sel' : '') + (cm.power ? ' power' : '') + (flash[cm.id] ? ' flash' : '');
      c += `<g class="${cls}" data-kind="comp" data-id="${esc(cm.id)}" transform="translate(${f2(cm.x)} ${f2(cm.y)}) rotate(${-cm.rot}) scale(${sx} ${sy})">`;
      if (!cm.power) c += `<rect class="bodyhit" x="${bb.x}" y="${bb.y}" width="${bb.w}" height="${bb.h}"/>`;
      L.g.forEach((g) => {
        const fill = g.fill === 'background' ? COL.fill : g.fill === 'outline' ? COL.body : 'none';
        c += g.t === 'circle' ? `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="${fill}"/>` : `<path d="${g.d}" fill="${fill}"/>`;
      });
      L.pins.forEach((p) => { if (p.l > 0) { const r = (p.r * Math.PI) / 180; c += `<line class="pinline" x1="${p.x}" y1="${p.y}" x2="${f2(p.x + Math.cos(r) * p.l)}" y2="${f2(p.y - Math.sin(r) * p.l)}"/>`; } });
      c += '</g>';
      // подписи
      const lab = (l, txt, cl) => {
        if (!l) return ''; const j = l.just || []; const anchor = j.includes('left') ? 'start' : j.includes('right') ? 'end' : 'middle';
        const base = j.includes('top') ? 'hanging' : j.includes('bottom') ? 'auto' : 'central';
        const x = f2(cm.x + l.dx), y = f2(cm.y + l.dy); const rot = l.rot % 180 ? ` transform="rotate(-90 ${x} ${y})"` : '';
        return `<text class="${cl}" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${base}"${rot}>${esc(txt)}</text>`;
      };
      if (!cm.power) t += lab(cm.lr, cm.id, 'tref'); t += lab(cm.lv, cm.val, 'tval');
      pinsOf(cm).forEach((p) => {
        if (!cm.power && p.len > 1.5) {
          const L2 = p.lp; const mx = (p.x + p.bx) / 2, my = (p.y + p.by) / 2;
          if (!D.libs[cm.lib].hu) { t += p.ox ? `<text class="tpin" x="${f2(mx)}" y="${f2(my - 0.55)}" text-anchor="middle">${esc(p.num)}</text>` : `<text class="tpin" x="${f2(mx - 0.55)}" y="${f2(my)}" text-anchor="end" dominant-baseline="central">${esc(p.num)}</text>`; }
          if (!D.libs[cm.lib].hn && p.name && p.name !== '~' && p.name !== p.num) {
            const dx = -p.ox, dy = -p.oy; const nx = p.bx + dx * 0.7, ny = p.by + dy * 0.7;
            t += `<text class="tname" x="${f2(nx)}" y="${f2(ny)}" text-anchor="${dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle'}" dominant-baseline="central">${esc(p.name)}</text>`;
          }
        }
        // маркеры выводов
        const d = deg[p.key] || 0; const bad = result && result.badPins && result.badPins.has(p.key); const miss = result && result.missPins && result.missPins.has(p.key);
        const hot = hovNet !== null && nets(p.key) === hovNet;
        pn += `<g class="pin${d ? ' on' : ''}${bad ? ' bad' : ''}${miss ? ' miss' : ''}${hot ? ' hot' : ''}${hint && (hint.a === p.key || hint.b === p.key) ? ' hint' : ''}" transform="translate(${p.x} ${p.y})"><circle class="pd" r="${cm.power ? 0.5 : 0.55}"/>${miss || bad || (hint && (hint.a === p.key || hint.b === p.key)) ? '<circle class="ring" r="1.6"/>' : ''}<circle class="phit" data-kind="pin" data-key="${esc(p.key)}" r="1.25"/></g>`;
      });
    });
    // свободные узлы
    S.nodes.forEach((n) => {
      const d = deg[n.id] || 0; const isSel = sel && sel.type === 'node' && sel.id === n.id;
      pn += `<g transform="translate(${n.x} ${n.y})" class="fn${d >= 3 ? ' junc' : d <= 1 ? ' dang' : ''}${isSel ? ' sel' : ''}"><circle class="nd" r="${d >= 3 ? 0.62 : 0.42}"/><circle class="phit" data-kind="node" data-id="${n.id}" r="1.0"/></g>`;
    });
    // оверлей результата
    if (ratsnest) o += ratsnestSvg();
    if (result) {
      result.missing.forEach((m) => { const a = nodePos(m.a), b = nodePos(m.b); o += `<polyline class="missing" points="${ptsStr(route(a, b))}"/>`; });
    }
    if (hint) { const a = nodePos(hint.a), b = nodePos(hint.b); o += `<polyline class="missing hintline" points="${ptsStr(route(a, b))}"/>`; }
    // временный провод
    let tmp = '';
    if (drawing) { const a = nodePos(drawing.from); let b = drawing.cur || cursor; tmp = `<polyline class="wire temp" points="${ptsStr(route(a, { x: b.x, y: b.y, ox: 0, oy: 0 }))}"/>`; }
    layers.wires.innerHTML = w; layers.comps.innerHTML = c; layers.text.innerHTML = t; layers.over.innerHTML = o; layers.pins.innerHTML = pn; layers.temp.innerHTML = tmp;
  }
  let flash = {};
  function ratsnestSvg() {
    let s = '';
    D.nets.forEach((n) => {
      const pts = n.pins.map((k) => pinMap[k]).filter(Boolean); if (pts.length < 2) return;
      const used = [pts[0]], rest = pts.slice(1);
      while (rest.length) { let b = null; used.forEach((u) => rest.forEach((r, i) => { const d = Math.hypot(u.x - r.x, u.y - r.y); if (!b || d < b.d) b = { d, u, i }; })); const r = rest.splice(b.i, 1)[0]; s += `<line class="rats" x1="${b.u.x}" y1="${b.u.y}" x2="${r.x}" y2="${r.y}"/>`; used.push(r); }
    });
    return s;
  }
  function applyView() { root.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); const g = document.getElementById('gridpat'); if (g) { const s = 2.54 * view.k; g.setAttribute('width', s); g.setAttribute('height', s); g.setAttribute('patternTransform', `translate(${view.x} ${view.y})`); const dot = g.firstElementChild; dot.setAttribute('r', Math.max(0.6, Math.min(1.2, view.k * 0.12))); dot.setAttribute('cx', 0); dot.setAttribute('cy', 0); } }
  const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };

  E.fit = function () {
    const r = svg.getBoundingClientRect(); if (!r.width) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    S.comps.forEach((c) => { const b = libBBox(c.lib); [[b.x, b.y], [b.x + b.w, b.y + b.h]].forEach(([px, py]) => { for (const [a, bb] of [[px, py], [py, px]]) { } const [wx, wy] = tf(px, py, c.rot, c.mir); x0 = Math.min(x0, c.x + wx - 6); x1 = Math.max(x1, c.x + wx + 6); y0 = Math.min(y0, c.y + wy - 6); y1 = Math.max(y1, c.y + wy + 6); }); });
    const k = Math.min(r.width / (x1 - x0), r.height / (y1 - y0)) * 0.96;
    view.k = k; view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k; view.y = (r.height - (y1 - y0) * k) / 2 - y0 * k; applyView();
  };

  /* ---------- провода: логика ---------- */
  function newNode(x, y) { const id = 'n' + S.uid++; S.nodes.push({ id, x: snap(x), y: snap(y) }); return id; }
  function addEdge(a, b) {
    if (a === b) return null; if (S.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return null;
    const id = 'e' + S.uid++; S.edges.push({ id, a, b }); return id;
  }
  function splitEdge(eid, x, y) {
    const e = S.edges.find((q) => q.id === eid); if (!e) return null;
    const n = nearestOn(e._pts, x, y); let nx = n.x, ny = n.y; if (n.horiz) nx = snap(nx); else ny = snap(ny);
    const id = newNode(nx, ny); const nd = nodeById(id); nd.x = f2(nx); nd.y = f2(ny);
    S.edges = S.edges.filter((q) => q.id !== eid); addEdge(e.a, id); addEdge(id, e.b); return id;
  }
  function startWire(from) { drawing = { from, cur: null }; }
  function wireTarget(t, w) { // вернуть ключ узла для клика (создавая при необходимости)
    if (t && t.kind === 'pin') return { key: t.key, finish: true };
    if (t && t.kind === 'node') return { key: t.id, finish: true };
    if (t && t.kind === 'edge') return { key: splitEdge(t.id, w.x, w.y), finish: true };
    return { key: newNode(w.x, w.y), finish: false };
  }

  /* ---------- события ---------- */
  function targetOf(ev) {
    const el = ev.target.closest && ev.target.closest('[data-kind]'); if (!el) return null;
    return { kind: el.dataset.kind, id: el.dataset.id, key: el.dataset.key };
  }
  function bind() {
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const k2 = Math.max(0.8, Math.min(40, view.k * Math.exp(-e.deltaY * 0.0015))); view.x = mx - ((mx - view.x) / view.k) * k2; view.y = my - ((my - view.y) / view.k) * k2; view.k = k2; applyView(); }, { passive: false });
    svg.addEventListener('dblclick', () => { if (drawing) { drawing = null; render(); } });
    window.addEventListener('keydown', onKey);
  }
  function onDown(e) {
    svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }; drag = null; pan = null; drawing = null; return; }
    const w = toWorld(e.clientX, e.clientY); cursor = w; const t = targetOf(e);
    if (e.button === 1 || e.button === 2) { if (e.button === 2 && drawing) { drawing = null; render(); return; } pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; return; }
    if (e.button !== 0) return;
    const down = { x: e.clientX, y: e.clientY, moved: false, handled: false }; E._down = down;
    if (drawing) {
      push(); const prev = drawing.from; const tg = wireTarget(t, w);
      if (tg.key && tg.key !== prev) { addEdge(prev, tg.key); }
      drawing = tg.finish ? null : { from: tg.key, cur: null }; down.handled = true; changed(); return;
    }
    if (t && t.kind === 'pin') { startWire(t.key); down.fromPin = true; down.pin = t.key; render(); return; }
    if (tool === 'wire') {
      push();
      if (t && t.kind === 'node') startWire(t.id); else if (t && t.kind === 'edge') startWire(splitEdge(t.id, w.x, w.y)); else if (!t || t.kind !== 'comp') startWire(newNode(w.x, w.y));
      if (!drawing) { hist.pop(); } changed(); if (t && t.kind === 'comp') select({ type: 'comp', id: t.id }); return;
    }
    if (t && t.kind === 'node') { select({ type: 'node', id: t.id }); push(); drag = { type: 'node', id: t.id }; return; }
    if (t && t.kind === 'comp') { const c = S.comps.find((q) => q.id === t.id); select({ type: 'comp', id: t.id }); drag = { type: 'comp', id: t.id, dx: w.x - c.x, dy: w.y - c.y, pushed: false }; return; }
    if (t && t.kind === 'edge') { select({ type: 'edge', id: t.id }); return; }
    select(null); pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  }
  function onMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const k2 = Math.max(0.8, Math.min(40, pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); const r = svg.getBoundingClientRect(); const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top; view.x = mx - ((mx - view.x) / view.k) * k2; view.y = my - ((my - view.y) / view.k) * k2; view.k = k2; applyView(); return; }
    if (pan) { view.x = pan.vx + e.clientX - pan.sx; view.y = pan.vy + e.clientY - pan.sy; applyView(); return; }
    const w = toWorld(e.clientX, e.clientY); cursor = w;
    const dn = E._down; if (dn && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 6) dn.moved = true;
    if (drag) {
      if (drag.type === 'comp') { const c = S.comps.find((q) => q.id === drag.id); if (!drag.pushed) { push(); drag.pushed = true; result = null; } c.x = f2(snap(w.x - drag.dx)); c.y = f2(snap(w.y - drag.dy)); rebuildPins(); render(); }
      else if (drag.type === 'node') { const n = nodeById(drag.id); n.x = snap(w.x); n.y = snap(w.y); result = null; render(); }
      return;
    }
    const t = ev2t(e);
    if (drawing) { drawing.cur = t && t.kind === 'pin' ? nodePos(t.key) : t && t.kind === 'node' ? nodePos(t.id) : { x: snap(w.x), y: snap(w.y) }; render(); }
    updateHover(t, e);
    E.onStatus && E.onStatus({ x: w.x, y: w.y });
  }
  const ev2t = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); if (!el || !svg.contains(el)) return null; const q = el.closest('[data-kind]'); return q ? { kind: q.dataset.kind, id: q.dataset.id, key: q.dataset.key } : null; };
  let lastHoverKey = null;
  function updateHover(t, e) {
    let key = null, net;
    if (t) { const nets = userNets(); if (t.kind === 'pin') { key = 'p' + t.key; net = nets(t.key); } else if (t.kind === 'edge') { const ed = S.edges.find((q) => q.id === t.id); if (ed) { key = 'e' + t.id; net = nets(ed.a); } } else if (t.kind === 'node') { key = 'n' + t.id; net = nets(t.id); } }
    if (key !== lastHoverKey) { lastHoverKey = key; hover = key ? { net, t } : null; render(); }
    E.onHover && E.onHover(t && t.kind === 'pin' ? pinMap[t.key] : t && t.kind === 'comp' ? { comp: S.comps.find((q) => q.id === t.id) } : null, e);
  }
  function onUp(e) {
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
    const dn = E._down; E._down = null;
    if (pan) { pan = null; return; }
    if (drag) { if (drag.type === 'node') changed(); else if (drag.pushed) changed(); drag = null; return; }
    if (dn && dn.fromPin && dn.moved && drawing) { // перетаскивание от вывода: отпустили над целью
      const t = ev2t(e); const w = toWorld(e.clientX, e.clientY);
      if (t && (t.kind === 'pin' || t.kind === 'node' || t.kind === 'edge')) { push(); const tg = wireTarget(t, w); if (tg.key && tg.key !== drawing.from) addEdge(drawing.from, tg.key); drawing = null; changed(); }
    }
  }
  function onKey(e) {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? E.redo() : E.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); E.redo(); return; }
    if (k === 'escape') { if (drawing) { drawing = null; render(); } else select(null); }
    else if (k === 'delete' || k === 'backspace') { E.deleteSelected(); }
    else if (k === 'r') E.rotate(); else if (k === 'x') E.mirror();
    else if (k === 'w') E.setTool('wire'); else if (k === 'v') E.setTool('select'); else if (k === 'f') E.fit();
  }

  /* ---------- публичный API ---------- */
  function select(s) { sel = s; render(); E.onSelect && E.onSelect(s); }
  E.setTool = (t) => { tool = t; drawing = null; svg.dataset.tool = t; document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); render(); };
  E.rotate = () => { if (sel && sel.type === 'comp') { push(); const c = S.comps.find((q) => q.id === sel.id); c.rot = (c.rot + 90) % 360; changed(); } };
  E.mirror = () => { if (sel && sel.type === 'comp') { push(); const c = S.comps.find((q) => q.id === sel.id); c.mir = c.mir === 'y' ? null : 'y'; changed(); } };
  E.deleteSelected = () => {
    if (!sel) return; push();
    if (sel.type === 'edge') S.edges = S.edges.filter((e) => e.id !== sel.id);
    else if (sel.type === 'node') { S.edges = S.edges.filter((e) => e.a !== sel.id && e.b !== sel.id); S.nodes = S.nodes.filter((n) => n.id !== sel.id); }
    else if (sel.type === 'comp') { const c = S.comps.find((q) => q.id === sel.id); if (!c || !c.user) { hist.pop(); toast('Удалять можно только добавленные вами символы питания'); return; } S.edges = S.edges.filter((e) => e.a !== c.id && e.b !== c.id); S.comps = S.comps.filter((q) => q.id !== c.id); }
    sel = null; cleanup(); changed();
  };
  function cleanup() { // убрать «висячие» промежуточные узлы без проводов
    const used = new Set(); S.edges.forEach((e) => { used.add(e.a); used.add(e.b); }); S.nodes = S.nodes.filter((n) => used.has(n.id));
  }
  E.addPower = (name) => {
    push(); const lib = name === 'GND' ? 'power:GND' : 'power:+BATT'; const r = svg.getBoundingClientRect(); const w = toWorld(r.left + r.width / 2 + (Math.random() - 0.5) * 80, r.top + r.height / 2 + (Math.random() - 0.5) * 80);
    const proto = D.insts.find((i) => i.lib === lib);
    S.comps.push({ id: '#U' + (S.uid++), lib, x: snap(w.x), y: snap(w.y), rot: 0, mir: null, val: name, fp: '', power: true, lr: null, lv: proto.lv, user: true });
    changed(false); toast('Символ ' + name + ' добавлен в центр. Перетащите его на место и соедините с выводом.');
  };
  E.reset = () => { hist = []; fut = []; initState(); sel = null; drawing = null; result = null; hint = null; changed(); E.fit(); };
  E.layout = (mode) => {
    push(); const comps = S.comps;
    if (mode === 'kicad') comps.forEach((c) => { if (c.ox !== undefined) { c.x = c.ox; c.y = c.oy; } });
    else {
      const real = comps.filter((c) => !c.power); const pw = comps.filter((c) => c.power);
      for (let i = real.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [real[i], real[j]] = [real[j], real[i]]; }
      const cols = 6, cw = 44, ch = 32; real.forEach((c, i) => { c.rot = 0; c.mir = null; c.x = snap(40 + (i % cols) * cw); c.y = snap(40 + Math.floor(i / cols) * ch); });
      const rows = Math.ceil(real.length / cols); pw.forEach((c, i) => { c.x = snap(30 + (i % 12) * 18); c.y = snap(40 + rows * ch + 10 + Math.floor(i / 12) * 14); });
    }
    changed(); E.fit();
  };
  E.setRatsnest = (on) => { ratsnest = on; render(); };
  E.setResult = (r) => { result = r; if (r) { r.badPins = new Set(); r.missPins = new Set(); r.missing.forEach((m) => { r.missPins.add(m.a); r.missPins.add(m.b); }); r.shorts.forEach((s) => s.groups.forEach((g) => g.pins.forEach((p) => r.badPins.add(p)))); } render(); };
  E.setHint = (h) => { hint = h; render(); };
  E.flashComps = (ids) => { flash = {}; (ids || []).forEach((i) => (flash[i] = true)); render(); };
  E.focusComps = (ids) => {
    const cs = S.comps.filter((c) => ids.includes(c.id)); if (!cs.length) return; const r = svg.getBoundingClientRect();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; cs.forEach((c) => { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); });
    const k = Math.max(view.k, Math.min(r.width / (x1 - x0 + 40), r.height / (y1 - y0 + 40), 9)); view.k = k; view.x = r.width / 2 - ((x0 + x1) / 2) * k; view.y = r.height / 2 - ((y0 + y1) / 2) * k; applyView();
  };
  E.selectComp = (id) => { select(id ? { type: 'comp', id } : null); };
  E.focusPins = (keys) => { const ids = keys.map((k) => (pinMap[k] ? pinMap[k].comp.id : null)).filter(Boolean); E.focusComps(ids); };
  E.compInfo = (id) => S.comps.find((c) => c.id === id);
  E.graph = () => {
    const real = S.comps.filter((c) => !c.power); const pins = []; real.forEach((c) => pinsOf(c).forEach((p) => pins.push(p.key)));
    const pos = {}; Object.values(pinMap).forEach((p) => (pos[p.key] = { x: p.x, y: p.y }));
    return { pins, free: S.nodes.map((n) => n.id), edges: S.edges.map((e) => ({ id: e.id, a: e.a, b: e.b })), power: S.comps.filter((c) => c.power).map((c) => ({ key: c.id, name: c.val })), pos };
  };
  E.stats = () => {
    const must = new Set(); D.nets.forEach((n) => { if (n.pins.length > 1) n.pins.forEach((p) => must.add(p)); });
    const deg = new Set(); S.edges.forEach((e) => { deg.add(e.a); deg.add(e.b); });
    let done = 0; must.forEach((p) => { if (deg.has(p)) done++; }); return { wires: S.edges.length, pinsDone: done, pinsTotal: must.size };
  };
  E.serialize = () => JSON.stringify(S);
  E.restore = (str) => { try { const s = JSON.parse(str); if (!s.comps) return false; S = s; changed(false); return true; } catch (e) { return false; } };
  function status() { E.onStatus && E.onStatus(null); }
  let toastFn = null; E.setToast = (f) => (toastFn = f); const toast = (m) => toastFn && toastFn(m);

  E.init = function (container) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'sch'); svg.dataset.tool = 'select';
    svg.innerHTML = `<defs><pattern id="gridpat" width="10" height="10" patternUnits="userSpaceOnUse"><circle r="0.8" fill="#b9b6a8"/></pattern></defs><rect width="100%" height="100%" fill="url(#gridpat)"/><g id="root"><g id="gWires"></g><g id="gOver"></g><g id="gComps"></g><g id="gText"></g><g id="gTemp"></g><g id="gPins"></g></g>`;
    container.appendChild(svg); root = svg.querySelector('#root');
    layers = { wires: svg.querySelector('#gWires'), over: svg.querySelector('#gOver'), comps: svg.querySelector('#gComps'), text: svg.querySelector('#gText'), temp: svg.querySelector('#gTemp'), pins: svg.querySelector('#gPins') };
    initState(); rebuildPins(); bind(); new ResizeObserver(() => { }).observe(container);
    render(); E.fit(); applyView();
  };
})();
