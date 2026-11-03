/* Редактор схемы на SVG: палитра компонентов, символы KiCad, провода, узлы,
   рамка выделения (окно/секущая), пан/зум, undo/redo. */
(function () {
  'use strict';
  let D = null;
  const E = (window.Editor = {});
  const COL = { body: '#840000', fill: '#FFFFC2' };
  const SNAP = 1.27, STUB = 2.54;
  let svg, root, layers = {}, S, view = { x: 0, y: 0, k: 4 }, tool = 'select', cursor = { x: 0, y: 0 };
  let sel = { comp: new Set(), edge: new Set(), node: new Set() };
  let drawing = null, drag = null, pan = null, marq = null, hover = null, lastHoverKey = null, pinMap = {}, hist = [], fut = [];
  let segDrag = null, result = null, ratsnest = false, hint = null, pointers = new Map(), pinch = null, bbCache = {}, flash = {}, space = false;
  E.onChange = null; E.onSelect = null; E.onStatus = null; E.onHover = null; E.paletteHit = null; E.onPaletteHover = null;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = (n) => Math.round(n * 100) / 100;
  const snap = (v) => Math.round(v / SNAP) * SNAP;
  const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

  /* ---------- справочники (зависят от выбранной платы) ---------- */
  let INST = {}, GROUPS = [];
  E.data = () => D;
  E.setData = (data) => {
    D = data; bbCache = {}; INST = {}; D.insts.forEach((i) => (INST[i.id] = i));
    const m = new Map();
    D.insts.filter((i) => !i.power).forEach((i) => { if (!m.has(i.lib)) m.set(i.lib, { lib: i.lib, refs: [], title: (D.libs[i.lib] && D.libs[i.lib].title) || i.lib, order: (D.libs[i.lib] && D.libs[i.lib].order) || 99 }); m.get(i.lib).refs.push(i.id); });
    m.forEach((g) => g.refs.sort(natural));
    GROUPS = [...m.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'));
    hist = []; fut = []; initState(); sel = { comp: new Set(), edge: new Set(), node: new Set() }; drawing = null; result = null; hint = null; flash = {}; ratsnest = false;
    rebuildPins(); render(); E.fit(); E.onChange && E.onChange(); E.onStatus && E.onStatus(null); emitSel();
  };
  E.powers = () => (D ? D.powers : []);
  E.groups = () => GROUPS.map((g) => ({ lib: g.lib, title: g.title, refs: g.refs, total: g.refs.length, placed: g.refs.filter((r) => S.comps.some((c) => c.id === r)).length }));
  E.powerCount = (n) => S.comps.filter((c) => c.power && c.val === n).length;
  E.compCounts = () => { const real = S.comps.filter((c) => !c.power).length; return { placed: real, total: D.insts.filter((i) => !i.power).length }; };

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
  function compBox(c) {
    const b = libBBox(c.lib); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([px, py]) => { const [wx, wy] = tf(px, py, c.rot, c.mir); x0 = Math.min(x0, c.x + wx); x1 = Math.max(x1, c.x + wx); y0 = Math.min(y0, c.y + wy); y1 = Math.max(y1, c.y + wy); });
    return { x0, y0, x1, y1 };
  }
  /* иконка символа для палитры */
  E.symbolSvg = (lib, px) => {
    const L = D.libs[lib], b = libBBox(lib); let s = `<svg class="symicon" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${px || 56}" height="${px || 56}" preserveAspectRatio="xMidYMid meet">`;
    L.g.forEach((g) => { const fill = g.fill === 'background' ? COL.fill : g.fill === 'outline' ? COL.body : 'none'; s += g.t === 'circle' ? `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="${fill}"/>` : `<path d="${g.d}" fill="${fill}"/>`; });
    L.pins.forEach((p) => { if (p.l > 0) { const r = (p.r * Math.PI) / 180; s += `<line x1="${p.x}" y1="${p.y}" x2="${p.x + Math.cos(r) * p.l}" y2="${p.y - Math.sin(r) * p.l}"/>`; } });
    return s + '</svg>';
  };

  /* ---------- состояние ---------- */
  function initState() { S = { comps: [], nodes: [], edges: [], uid: 1 }; }
  const snapshot = () => JSON.stringify(S);
  function push() { hist.push(snapshot()); if (hist.length > 120) hist.shift(); fut = []; }
  function changed(clearRes = true) { if (clearRes) { result = null; hint = null; } rebuildPins(); pruneSel(); render(); E.onChange && E.onChange(); E.onStatus && E.onStatus(null); emitSel(); }
  E.undo = () => { if (!hist.length) return; fut.push(snapshot()); S = JSON.parse(hist.pop()); drawing = null; changed(); };
  E.redo = () => { if (!fut.length) return; hist.push(snapshot()); S = JSON.parse(fut.pop()); drawing = null; changed(); };
  function pruneSel() { sel.comp.forEach((id) => { if (!S.comps.some((c) => c.id === id)) sel.comp.delete(id); }); sel.edge.forEach((id) => { if (!S.edges.some((c) => c.id === id)) sel.edge.delete(id); }); sel.node.forEach((id) => { if (!S.nodes.some((c) => c.id === id)) sel.node.delete(id); }); }
  const selCount = () => sel.comp.size + sel.edge.size + sel.node.size;
  function emitSel() { E.onSelect && E.onSelect({ comps: [...sel.comp], edges: sel.edge.size, nodes: sel.node.size }); }
  function setSel(o) { sel = { comp: new Set(o.comp || []), edge: new Set(o.edge || []), node: new Set(o.node || []) }; render(); emitSel(); }

  /* ---------- выводы ---------- */
  function pinsOf(c) {
    const L = D.libs[c.lib];
    return L.pins.map((p) => {
      const [wx, wy] = tf(p.x, p.y, c.rot, c.mir);
      const r = (p.r * Math.PI) / 180; const [dx, dy] = tf(Math.cos(r), -Math.sin(r), c.rot, c.mir);
      const [bx, by] = tf(p.x + Math.cos(r) * p.l, p.y - Math.sin(r) * p.l, c.rot, c.mir);
      return { key: c.power ? c.id : c.id + '.' + p.u, comp: c, num: p.u, name: p.n, x: f2(c.x + wx), y: f2(c.y + wy), ox: -Math.round(dx), oy: -Math.round(dy), bx: c.x + bx, by: c.y + by, len: p.l };
    });
  }
  function rebuildPins() { pinMap = {}; S.comps.forEach((c) => pinsOf(c).forEach((p) => (pinMap[p.key] = p))); }
  const nodeById = (id) => S.nodes.find((n) => n.id === id);
  function nodePos(key) { if (pinMap[key]) return pinMap[key]; const n = nodeById(key); return n ? { x: n.x, y: n.y, ox: 0, oy: 0 } : { x: 0, y: 0, ox: 0, oy: 0 }; }

  /* ---------- маршрутизация ---------- */
  function manh(p, q, fa, la) {
    if (Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01) return [[p.x, p.y], [q.x, q.y]];
    if (fa === 'h' && la === 'h') { const m = snap((p.x + q.x) / 2); return [[p.x, p.y], [m, p.y], [m, q.y], [q.x, q.y]]; }
    if (fa === 'v' && la === 'v') { const m = snap((p.y + q.y) / 2); return [[p.x, p.y], [p.x, m], [q.x, m], [q.x, q.y]]; }
    if (fa === 'h') return [[p.x, p.y], [q.x, p.y], [q.x, q.y]];
    return [[p.x, p.y], [p.x, q.y], [q.x, q.y]];
  }
  const axis = (o) => (o.ox ? 'h' : o.oy ? 'v' : null);
  function route(a, b, first) {
    const hasA = a.ox || a.oy, hasB = b.ox || b.oy;
    const A1 = hasA ? { x: a.x + a.ox * STUB, y: a.y + a.oy * STUB } : a, B1 = hasB ? { x: b.x + b.ox * STUB, y: b.y + b.oy * STUB } : b;
    const fa = hasA ? axis(a) : hasB ? (axis(b) === 'h' ? 'v' : 'h') : first || (Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? 'h' : 'v');
    const la = hasB ? axis(b) : hasA ? (axis(a) === 'h' ? 'v' : 'h') : fa === 'h' ? 'v' : 'h';
    let mid = null, fa2 = fa, la2 = la;
    if (hasA && hasB && fa === la) {          // оба вывода смотрят вдоль одной оси: проверяем, что провод не «пятится» через корпус
      const v = fa === 'v', pa = v ? A1.y : A1.x, pb = v ? B1.y : B1.x, da = v ? a.oy : a.ox, db = v ? b.oy : b.ox, m = (pa + pb) / 2;
      if ((m - pa) * da < -0.01 || (m - pb) * db < -0.01) {
        if (da === db) { const e = da > 0 ? Math.max(pa, pb) : Math.min(pa, pb); mid = v ? [[A1.x, A1.y], [A1.x, e], [B1.x, e], [B1.x, B1.y]] : [[A1.x, A1.y], [e, A1.y], [e, B1.y], [B1.x, B1.y]]; }   // П-образный обход
        else { fa2 = la2 = v ? 'h' : 'v'; }                                                                                                              // обход сбоку
      }
    }
    let pts = []; if (hasA) pts.push([a.x, a.y]); pts = pts.concat(mid || manh(A1, B1, fa2, la2)); if (hasB) pts.push([b.x, b.y]);
    const out = []; pts.forEach((p) => { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - p[0]) > 0.01 || Math.abs(l[1] - p[1]) > 0.01) out.push(p); });
    for (let i = out.length - 2; i > 0; i--) { const [p, q, r] = [out[i - 1], out[i], out[i + 1]]; if ((Math.abs(p[0] - q[0]) < 0.01 && Math.abs(q[0] - r[0]) < 0.01) || (Math.abs(p[1] - q[1]) < 0.01 && Math.abs(q[1] - r[1]) < 0.01)) out.splice(i, 1); }
    return out;
  }
  const ptsStr = (pts) => pts.map((p) => f2(p[0]) + ',' + f2(p[1])).join(' ');
  function nearestOn(pts, x, y) {
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)); const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px - x, py - y);
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
  function labelsFor(cm) {
    const b = compBox(cm), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const T = (x, y, txt, cl, an, bl) => `<text class="${cl}" x="${f2(x)}" y="${f2(y)}" text-anchor="${an}" dominant-baseline="${bl}">${esc(txt)}</text>`;
    if (cm.power) { const p = pinsOf(cm)[0]; return p.oy < 0 ? T(cx, b.y1 + 0.2, cm.val, 'tval', 'middle', 'hanging') : T(cx, b.y0 - 0.2, cm.val, 'tval', 'middle', 'auto'); }
    if (b.y1 - b.y0 > (b.x1 - b.x0) * 1.15) return T(b.x1 + 0.3, cy - 0.95, cm.id, 'tref', 'start', 'central') + T(b.x1 + 0.3, cy + 1.0, cm.val, 'tval', 'start', 'central');
    return T(cx, b.y0 - 0.25, cm.id, 'tref', 'middle', 'auto') + T(cx, b.y1 + 0.25, cm.val, 'tval', 'middle', 'hanging');
  }
  function compGroup(cm, cls, hit) {
    const L = D.libs[cm.lib], bb = libBBox(cm.lib), sx = cm.mir === 'y' ? -1 : 1, sy = cm.mir === 'x' ? -1 : 1; let c = '';
    c += `<g class="${cls}" ${hit ? `data-kind="comp" data-id="${esc(cm.id)}"` : ''} transform="translate(${f2(cm.x)} ${f2(cm.y)}) rotate(${-cm.rot}) scale(${sx} ${sy})">`;
    if (!cm.power && hit) c += `<rect class="bodyhit" x="${bb.x}" y="${bb.y}" width="${bb.w}" height="${bb.h}"/>`;
    L.g.forEach((g) => { const fill = g.fill === 'background' ? COL.fill : g.fill === 'outline' ? COL.body : 'none'; c += g.t === 'circle' ? `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="${fill}"/>` : `<path d="${g.d}" fill="${fill}"/>`; });
    L.pins.forEach((p) => { if (p.l > 0) { const r = (p.r * Math.PI) / 180; c += `<line class="pinline" x1="${p.x}" y1="${p.y}" x2="${f2(p.x + Math.cos(r) * p.l)}" y2="${f2(p.y - Math.sin(r) * p.l)}"/>`; } });
    return c + '</g>';
  }
  function pinTexts(cm) {
    const L = D.libs[cm.lib]; let t = '';
    pinsOf(cm).forEach((p) => {
      if (!cm.power && p.len > 1.5) {
        const mx = (p.x + p.bx) / 2, my = (p.y + p.by) / 2;
        if (!L.hu) t += p.ox ? `<text class="tpin" x="${f2(mx)}" y="${f2(my - 0.55)}" text-anchor="middle">${esc(p.num)}</text>` : `<text class="tpin" x="${f2(mx - 0.55)}" y="${f2(my)}" text-anchor="end" dominant-baseline="central">${esc(p.num)}</text>`;
        if (!L.hn && p.name && p.name !== '~' && p.name !== p.num) { const dx = -p.ox; t += `<text class="tname" x="${f2(p.bx + dx * 0.7)}" y="${f2(p.by - p.oy * 0.7)}" text-anchor="${dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle'}" dominant-baseline="central">${esc(p.name)}</text>`; }
      }
    });
    return t;
  }
  /* статичная отрисовка символа (для анимации): тело, подписи, выводы */
  E.staticComp = (cm) => ({ body: compGroup(cm, 'comp', false), text: labelsFor(cm) + pinTexts(cm), pins: pinsOf(cm).map((p) => ({ x: p.x, y: p.y, key: p.key })) });
  E.routeStatic = (a, b) => route(a, b);
  E.pinsOfStatic = (cm) => pinsOf(cm);
  E.libBox = compBox;
  function render() {
    if (!D) return;
    const nets = userNets(); const hovNet = hover ? hover.net : null;
    const deg = {}; S.edges.forEach((e) => { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; });
    let w = '', c = '', t = '', o = '', pn = ''; const handles = new Set();
    S.edges.forEach((e) => {
      const pts = route(nodePos(e.a), nodePos(e.b), e.f); e._pts = pts;
      let cls = 'wire'; const st = result && result.edgeStatus[e.id]; if (st) cls += ' ' + st;
      if (sel.edge.has(e.id)) cls += ' sel'; if (hovNet !== null && nets(e.a) === hovNet) cls += ' hot';
      w += `<polyline class="${cls}" points="${ptsStr(pts)}"/>`;
      for (let i = 0; i + 1 < pts.length; i++) { const hz = Math.abs(pts[i][1] - pts[i + 1][1]) < 0.01; w += `<line class="hit" data-kind="edge" data-id="${e.id}" data-seg="${i}" data-dir="${hz ? 'h' : 'v'}" x1="${f2(pts[i][0])}" y1="${f2(pts[i][1])}" x2="${f2(pts[i + 1][0])}" y2="${f2(pts[i + 1][1])}"/>`; if (sel.edge.has(e.id) && Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > 2.2) o += `<rect class="grip" x="${f2((pts[i][0] + pts[i + 1][0]) / 2 - 0.55)}" y="${f2((pts[i][1] + pts[i + 1][1]) / 2 - 0.55)}" width="1.1" height="1.1"/>`; }
      if (sel.edge.has(e.id)) { handles.add(e.a); handles.add(e.b); }
    });
    S.comps.forEach((cm) => {
      const cls = 'comp' + (sel.comp.has(cm.id) ? ' sel' : '') + (cm.power ? ' power' : '') + (flash[cm.id] ? ' flash' : '');
      c += compGroup(cm, cls, true);
      t += labelsFor(cm) + pinTexts(cm);
      pinsOf(cm).forEach((p) => {
        const d = deg[p.key] || 0, bad = result && result.badPins && result.badPins.has(p.key), miss = result && result.missPins && result.missPins.has(p.key);
        const hot = hovNet !== null && nets(p.key) === hovNet, hn = hint && (hint.a === p.key || hint.b === p.key);
        pn += `<g class="pin${d ? ' on' : ''}${bad ? ' bad' : ''}${miss ? ' miss' : ''}${hot ? ' hot' : ''}${hn ? ' hint' : ''}" transform="translate(${p.x} ${p.y})"><circle class="pd" r="${cm.power ? 0.5 : 0.55}"/>${miss || bad || hn ? '<circle class="ring" r="1.6"/>' : ''}<circle class="phit" data-kind="pin" data-key="${esc(p.key)}" r="1.25"/></g>`;
      });
    });
    S.nodes.forEach((n) => {
      const d = deg[n.id] || 0;
      pn += `<g transform="translate(${n.x} ${n.y})" class="fn${d >= 3 ? ' junc' : d <= 1 ? ' dang' : ''}${sel.node.has(n.id) ? ' sel' : ''}${handles.has(n.id) ? ' handle' : ''}"><circle class="nd" r="${d >= 3 ? 0.62 : 0.42}"/><circle class="phit" data-kind="node" data-id="${n.id}" r="1.0"/></g>`;
    });
    if (ratsnest) o += ratsnestSvg();
    if (result) result.missing.forEach((m) => { if (pinMap[m.a] && pinMap[m.b]) o += `<polyline class="missing" points="${ptsStr(route(nodePos(m.a), nodePos(m.b)))}"/>`; });
    if (hint && pinMap[hint.a] && pinMap[hint.b]) o += `<polyline class="missing hintline" points="${ptsStr(route(nodePos(hint.a), nodePos(hint.b)))}"/>`;
    let tmp = '';
    if (drawing) {
      const a = anchorPos(drawing), b = drawing.cur || { x: snap(cursor.x), y: snap(cursor.y), ox: 0, oy: 0 };
      tmp += `<polyline class="wire temp" points="${ptsStr(route(a, b, drawing.flip))}"/><circle class="anchor" cx="${f2(a.x)}" cy="${f2(a.y)}" r=".62"/>`;
      if (drawing.cur && drawing.cur.snap) tmp += `<circle class="snapring" cx="${f2(b.x)}" cy="${f2(b.y)}" r="1.5"/>`;
    } else if (tool === 'wire' && idleSnap) tmp += `<circle class="snapring" cx="${f2(idleSnap.x)}" cy="${f2(idleSnap.y)}" r="1.5"/>`;
    if (marq && marq.moved) { const x = Math.min(marq.x0, marq.x1), y = Math.min(marq.y0, marq.y1); tmp += `<rect class="marq ${marq.x1 >= marq.x0 ? 'win' : 'cross'}" x="${f2(x)}" y="${f2(y)}" width="${f2(Math.abs(marq.x1 - marq.x0))}" height="${f2(Math.abs(marq.y1 - marq.y0))}"/>`; }
    layers.wires.innerHTML = w; layers.comps.innerHTML = c; layers.text.innerHTML = t; layers.over.innerHTML = o; layers.pins.innerHTML = pn; layers.temp.innerHTML = tmp;
  }
  function ratsnestSvg() {
    let s = '';
    D.nets.forEach((n) => {
      const pts = n.pins.map((k) => pinMap[k]).filter(Boolean); if (pts.length < 2) return;
      const used = [pts[0]], rest = pts.slice(1);
      while (rest.length) { let b = null; used.forEach((u) => rest.forEach((r, i) => { const d = Math.hypot(u.x - r.x, u.y - r.y); if (!b || d < b.d) b = { d, u, i }; })); const r = rest.splice(b.i, 1)[0]; s += `<line class="rats" x1="${b.u.x}" y1="${b.u.y}" x2="${r.x}" y2="${r.y}"/>`; used.push(r); }
    });
    return s;
  }
  function applyView() {
    root.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    const g = svg.querySelector('#gridpat'); if (g) { const s = 2.54 * view.k; g.setAttribute('width', s); g.setAttribute('height', s); g.setAttribute('patternTransform', `translate(${view.x} ${view.y})`); const dot = g.firstElementChild; dot.setAttribute('r', Math.max(0.6, Math.min(1.2, view.k * 0.12))); }
  }
  const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
  E.containsClient = (x, y) => { const r = svg.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };

  E.fit = function () {
    if (!D) return; const r = svg.getBoundingClientRect(); if (!r.width) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    if (!S.comps.length) { x0 = 15; y0 = 15; x1 = 175; y1 = 125; }
    else { S.comps.forEach((c) => { const b = compBox(c); x0 = Math.min(x0, b.x0 - 6); y0 = Math.min(y0, b.y0 - 6); x1 = Math.max(x1, b.x1 + 6); y1 = Math.max(y1, b.y1 + 6); }); }
    const k = Math.min(Math.min(r.width / (x1 - x0), r.height / (y1 - y0)) * 0.96, 8);
    view.k = k; view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k; view.y = (r.height - (y1 - y0) * k) / 2 - y0 * k; applyView();
  };

  /* ---------- палитра: размещение и удаление ---------- */
  E.dropFromPalette = (kind, key, cx, cy) => {
    const w = cx === undefined ? centerWorld() : toWorld(cx, cy);
    if (kind === 'power') { push(); S.comps.push({ id: '#P' + S.uid++, lib: D.powers.find((q) => q.name === key).lib, x: f2(snap(w.x)), y: f2(snap(w.y)), rot: 0, mir: null, val: key, fp: '', power: true }); changed(false); setSel({ comp: [S.comps[S.comps.length - 1].id] }); return true; }
    const g = GROUPS.find((q) => q.lib === key); const free = g.refs.find((r) => !S.comps.some((c) => c.id === r));
    if (!free) return false; const i = INST[free]; push();
    S.comps.push({ id: free, lib: i.lib, x: f2(snap(w.x)), y: f2(snap(w.y)), rot: 0, mir: null, val: i.val, fp: i.fp, power: false });
    changed(false); setSel({ comp: [free] }); return true;
  };
  function centerWorld() { const r = svg.getBoundingClientRect(); const jitter = () => (Math.random() - 0.5) * 20; return toWorld(r.left + r.width / 2 + jitter(), r.top + r.height / 2 + jitter()); }
  /* смена позиционного обозначения (внутри группы одинаковых символов) */
  E.designators = (id) => { const c = S.comps.find((q) => q.id === id); if (!c || c.power) return []; return GROUPS.find((g) => g.lib === c.lib).refs.map((r) => ({ ref: r, val: INST[r].val, used: S.comps.some((q) => q.id === r && q.id !== id) })); };
  E.setDesignator = (id, ref) => {
    const c = S.comps.find((q) => q.id === id), other = S.comps.find((q) => q.id === ref); if (!c || c.power || id === ref || INST[ref].lib !== c.lib) return;
    push(); const map = { [id]: ref }; if (other) map[ref] = id;
    const conv = (k) => { const i = k.indexOf('.'); if (i < 0) return k; const r = k.slice(0, i); return r in map ? map[r] + k.slice(i) : k; };
    S.edges.forEach((e) => { e.a = conv(e.a); e.b = conv(e.b); });
    [c, other].forEach((q) => { if (!q) return; const n = map[q.id]; q.id = n; q.val = INST[n].val; q.fp = INST[n].fp; });
    changed(); setSel({ comp: [ref] });
  };
  function removeComps(ids) { S.edges = S.edges.filter((e) => !ids.some((id) => e.a === id || e.b === id || e.a.startsWith(id + '.') || e.b.startsWith(id + '.'))); S.comps = S.comps.filter((c) => !ids.includes(c.id)); cleanup(); }
  function cleanup() { const used = new Set(); S.edges.forEach((e) => { used.add(e.a); used.add(e.b); }); S.nodes = S.nodes.filter((n) => used.has(n.id) || sel.node.has(n.id) && false); }
  E.deleteSelected = () => {
    if (!selCount()) return; push();
    S.edges = S.edges.filter((e) => !sel.edge.has(e.id));
    [...sel.node].forEach((id) => {
      const inc = S.edges.filter((e) => e.a === id || e.b === id);
      if (inc.length === 2) { const o = inc.map((e) => (e.a === id ? e.b : e.a)); S.edges = S.edges.filter((e) => !inc.includes(e)); if (o[0] !== o[1]) addEdge(o[0], o[1]); }
      else S.edges = S.edges.filter((e) => e.a !== id && e.b !== id);
      S.nodes = S.nodes.filter((n) => n.id !== id);
    });
    removeComps([...sel.comp]); sel = { comp: new Set(), edge: new Set(), node: new Set() }; changed();
  };
  E.rotate = () => { if (!sel.comp.size) return; push(); S.comps.forEach((c) => { if (sel.comp.has(c.id)) c.rot = (c.rot + 90) % 360; }); changed(); };
  E.mirror = () => { if (!sel.comp.size) return; push(); S.comps.forEach((c) => { if (sel.comp.has(c.id)) c.mir = c.mir === 'y' ? null : 'y'; }); changed(); };
  E.selectAll = () => setSel({ comp: S.comps.map((c) => c.id), edge: S.edges.map((e) => e.id), node: S.nodes.map((n) => n.id) });

  /* ---------- провода ---------- */
  function newNode(x, y) { const id = 'n' + S.uid++; S.nodes.push({ id, x: f2(snap(x)), y: f2(snap(y)) }); return id; }
  function addEdge(a, b) { if (a === b || S.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return null; const id = 'e' + S.uid++; S.edges.push({ id, a, b }); return id; }
  function splitEdge(eid, x, y) {
    const e = S.edges.find((q) => q.id === eid); if (!e) return null;
    const n = nearestOn(e._pts, x, y); let nx = n.x, ny = n.y; if (n.horiz) nx = snap(nx); else ny = snap(ny);
    const id = newNode(nx, ny); const nd = nodeById(id); nd.x = f2(nx); nd.y = f2(ny);
    S.edges = S.edges.filter((q) => q.id !== eid); addEdge(e.a, id); addEdge(id, e.b); return id;
  }

  /* ---------- редактирование проводов ---------- */
  function rawNode(x, y) { const id = 'n' + S.uid++; S.nodes.push({ id, x: f2(x), y: f2(y) }); return id; }
  function degOf(k) { return S.edges.filter((e) => e.a === k || e.b === k).length; }
  /* Превращаем маршрут провода в цепочку узлов, чтобы любой сегмент можно было сдвигать. */
  function startSegDrag(sd) {
    const e = S.edges.find((q) => q.id === sd.id); if (!e || !e._pts) return false;
    const pts = e._pts, n = pts.length; if (n < 2) return false;
    const i = Math.max(0, Math.min(sd.seg, n - 2)); const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (len < 1.2) return false;
    const horiz = Math.abs(pts[i][1] - pts[i + 1][1]) < 0.01;
    const anchor = (k) => !!pinMap[k] || degOf(k) >= 2;           // выводы и узлы-развилки остаются на месте
    const uAnch = i === 0 && anchor(e.a), vAnch = i === n - 2 && anchor(e.b);
    push();
    const chain = [e.a]; for (let k = 1; k < n - 1; k++) chain.push(rawNode(pts[k][0], pts[k][1])); chain.push(e.b);
    S.edges = S.edges.filter((q) => q.id !== e.id);
    const ux = (pts[i + 1][0] - pts[i][0]) / len, uy = (pts[i + 1][1] - pts[i][1]) / len, d = Math.min(STUB, len / (uAnch && vAnch ? 3 : 2));
    for (let k = 0; k < chain.length - 1; k++) if (k !== i) addEdge(chain[k], chain[k + 1]);
    let segA = chain[i], segB = chain[i + 1];
    if (uAnch) { const nu = rawNode(pts[i][0] + ux * d, pts[i][1] + uy * d); addEdge(chain[i], nu); segA = nu; }
    if (vAnch) { const nv = rawNode(pts[i + 1][0] - ux * d, pts[i + 1][1] - uy * d); addEdge(nv, chain[i + 1]); segB = nv; }
    const segId = addEdge(segA, segB);
    sd.nodes = [segA, segB].map((k) => ({ k, x: nodeById(k).x, y: nodeById(k).y })); sd.horiz = horiz; sel.edge = new Set([segId]);
    return true;
  }
  /* Убираем лишние промежуточные узлы на прямых участках. */
  function simplify() {
    for (let guard = 0, again = true; again && guard < 300; guard++) {
      again = false;
      for (const n of S.nodes) {
        const inc = S.edges.filter((e) => e.a === n.id || e.b === n.id); if (inc.length !== 2) continue;
        const o = inc.map((e) => (e.a === n.id ? e.b : e.a)); if (o[0] === o[1]) continue;
        if (S.edges.some((e) => (e.a === o[0] && e.b === o[1]) || (e.a === o[1] && e.b === o[0]))) continue;
        const A = nodePos(o[0]), B = nodePos(o[1]), r = route(A, B); if (r.length !== 2) continue;
        const [p, q] = r; if (Math.abs((q[0] - p[0]) * (n.y - p[1]) - (q[1] - p[1]) * (n.x - p[0])) > 0.05) continue;
        if (n.x < Math.min(p[0], q[0]) - 0.05 || n.x > Math.max(p[0], q[0]) + 0.05 || n.y < Math.min(p[1], q[1]) - 0.05 || n.y > Math.max(p[1], q[1]) + 0.05) continue;
        if (route(A, n).length !== 2 || route(n, B).length !== 2) continue;
        S.edges = S.edges.filter((e) => !inc.includes(e)); S.nodes = S.nodes.filter((x) => x !== n); addEdge(o[0], o[1]); again = true; break;
      }
    }
  }

  /* ---------- выделение рамкой ---------- */
  const inR = (p, r) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
  function segX(a, b, c, d) { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c) * o(a, b, d) <= 0 && o(c, d, a) * o(c, d, b) <= 0; }
  function segHitsRect(a, b, r) { if (inR(a, r) || inR(b, r)) return true; const q = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]; for (let i = 0; i < 4; i++) if (segX(a, b, q[i], q[(i + 1) % 4])) return true; return false; }
  function marqueeSelect(marq) {
    const additive = marq.add;
    const r = { x0: Math.min(marq.x0, marq.x1), y0: Math.min(marq.y0, marq.y1), x1: Math.max(marq.x0, marq.x1), y1: Math.max(marq.y0, marq.y1) };
    const win = marq.x1 >= marq.x0; // слева направо — «окно» (только целиком), справа налево — «секущая» (всё задетое)
    const out = { comp: additive ? [...sel.comp] : [], edge: additive ? [...sel.edge] : [], node: additive ? [...sel.node] : [] };
    S.comps.forEach((c) => { const b = compBox(c); const full = b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1, touch = b.x0 <= r.x1 && b.x1 >= r.x0 && b.y0 <= r.y1 && b.y1 >= r.y0; if (win ? full : touch) out.comp.push(c.id); });
    S.edges.forEach((e) => { const p = e._pts || route(nodePos(e.a), nodePos(e.b)); let ok; if (win) ok = p.every((q) => inR(q, r)); else { ok = false; for (let i = 0; i + 1 < p.length; i++) if (segHitsRect(p[i], p[i + 1], r)) ok = true; } if (ok) out.edge.push(e.id); });
    S.nodes.forEach((n) => { if (inR([n.x, n.y], r)) out.node.push(n.id); });
    setSel(out);
  }

  /* ---------- события ---------- */
  function targetOf(ev) { const el = ev.target.closest && ev.target.closest('[data-kind]'); return el ? { kind: el.dataset.kind, id: el.dataset.id, key: el.dataset.key, seg: el.dataset.seg } : null; }
  const ev2t = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); if (!el || !svg.contains(el)) return null; const q = el.closest('[data-kind]'); return q ? { kind: q.dataset.kind, id: q.dataset.id, key: q.dataset.key, seg: q.dataset.seg } : null; };
  function bind() {
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const k2 = Math.max(0.8, Math.min(40, view.k * Math.exp(-e.deltaY * 0.0015))); view.x = mx - ((mx - view.x) / view.k) * k2; view.y = my - ((my - view.y) / view.k) * k2; view.k = k2; applyView(); }, { passive: false });
    svg.addEventListener('dblclick', () => finishWire());
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; if (!inField()) e.preventDefault(); } });
  }
  function startGroupDrag(w) {
    drag = { start: w, comps: S.comps.filter((c) => sel.comp.has(c.id)).map((c) => ({ c, x: c.x, y: c.y })), nodes: S.nodes.filter((n) => sel.node.has(n.id)).map((n) => ({ n, x: n.x, y: n.y })), pushed: false };
  }
  /* ===== Создание проводов =====
     Провод = цепочка сегментов. Начало: клик по выводу/узлу/проводу/пустому месту (на пустом месте узел
     создаётся лишь при фиксации сегмента). Дальше: клик по пустому месту — поворот (узел), клик по выводу,
     узлу или проводу — конец. Либо зажать ЛКМ, протянуть и отпустить (над целью — конец, над пустым — поворот).
     Пробел — сменить направление излома, Backspace — шаг назад, ПКМ/Enter/двойной клик — завершить,
     Esc — отменить весь провод. Весь провод откатывается одним Ctrl+Z. */
  const anchorPos = (dr) => (dr.anchor ? nodePos(dr.anchor) : { x: dr.pt.x, y: dr.pt.y, ox: 0, oy: 0 });
  function targetPoint(t, w) {
    if (t && t.kind === 'pin') return Object.assign({ snap: true }, nodePos(t.key));
    if (t && t.kind === 'node') return Object.assign({ snap: true }, nodePos(t.id));
    if (t && t.kind === 'edge') { const e = S.edges.find((q) => q.id === t.id); if (e && e._pts) { const n = nearestOn(e._pts, w.x, w.y); return { x: n.horiz ? snap(n.x) : n.x, y: n.horiz ? n.y : snap(n.y), ox: 0, oy: 0, snap: true }; } }
    return { x: snap(w.x), y: snap(w.y), ox: 0, oy: 0 };
  }
  function beginWire(t, w, press) {
    drawing = { anchor: null, pt: null, cur: null, flip: null, edges: [], nodes: [], pushed: false, press: press ? { moved: false } : null };
    if (t && t.kind === 'pin') drawing.anchor = t.key;
    else if (t && t.kind === 'node') drawing.anchor = t.id;
    else if (t && t.kind === 'edge') { push(); drawing.pushed = true; drawing.anchor = splitEdge(t.id, w.x, w.y); drawing.nodes.push(drawing.anchor); }
    else drawing.pt = { x: snap(w.x), y: snap(w.y) };
  }
  function commitTo(t, w) {
    const dr = drawing; if (!dr) return;
    if (t && ((t.kind === 'pin' && t.key === dr.anchor) || (t.kind === 'node' && t.id === dr.anchor))) return;      // тот же узел
    const tp = targetPoint(t, w), ap = anchorPos(dr);
    if (Math.abs(tp.x - ap.x) < 0.01 && Math.abs(tp.y - ap.y) < 0.01) return;                                      // нулевая длина
    if (!dr.pushed) { push(); dr.pushed = true; }
    if (!dr.anchor) { dr.anchor = newNode(dr.pt.x, dr.pt.y); dr.nodes.push(dr.anchor); dr.pt = null; }
    let key, finish = true;
    if (t && t.kind === 'pin') key = t.key; else if (t && t.kind === 'node') key = t.id;
    else if (t && t.kind === 'edge') { key = splitEdge(t.id, w.x, w.y); dr.nodes.push(key); }
    else { key = newNode(w.x, w.y); dr.nodes.push(key); finish = false; }
    const id = addEdge(dr.anchor, key); if (id) { if (dr.flip) S.edges.find((q) => q.id === id).f = dr.flip; dr.edges.push(id); }
    if (finish) drawing = null; else { dr.anchor = key; dr.flip = null; dr.cur = null; }
    changed();
  }
  function undoSilent() { if (!hist.length) return; S = JSON.parse(hist.pop()); changed(false); }
  function finishWire() { const dr = drawing; if (!dr) return; drawing = null; if (!dr.edges.length && dr.pushed) undoSilent(); else render(); }
  function cancelWire() { const dr = drawing; if (!dr) return; drawing = null; if (dr.pushed) undoSilent(); else render(); }
  function stepBack() {
    const dr = drawing; if (!dr) return; if (!dr.edges.length) { cancelWire(); return; }
    const eid = dr.edges.pop(), e = S.edges.find((q) => q.id === eid); S.edges = S.edges.filter((q) => q.id !== eid);
    const cur = dr.anchor; if (dr.nodes.includes(cur) && degOf(cur) === 0) { S.nodes = S.nodes.filter((n) => n.id !== cur); dr.nodes = dr.nodes.filter((k) => k !== cur); }
    dr.anchor = e.a; dr.flip = null; dr.cur = null;
    if (!dr.edges.length && dr.nodes.includes(dr.anchor) && degOf(dr.anchor) === 0) { const p = nodeById(dr.anchor); dr.pt = { x: p.x, y: p.y }; S.nodes = S.nodes.filter((n) => n.id !== dr.anchor); dr.nodes = dr.nodes.filter((k) => k !== dr.anchor); dr.anchor = null; }
    changed(false); render();
  }
  function toggleFlip() { const dr = drawing; if (!dr) return; const a = anchorPos(dr), b = dr.cur || cursor; const eff = dr.flip || (Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? 'h' : 'v'); dr.flip = eff === 'h' ? 'v' : 'h'; render(); }
  let idleSnap = null, idleKey = '';
  function updateWireCursor(t, w) {
    const p = targetPoint(t, w);
    if (drawing) { drawing.cur = p; render(); return; }
    const key = p.snap ? p.x + ',' + p.y : ''; if (key !== idleKey) { idleKey = key; idleSnap = p.snap ? p : null; render(); }
  }

  function onDown(e) {
    svg.setPointerCapture && svg.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }; drag = null; pan = null; marq = null; finishWire(); return; }
    const w = toWorld(e.clientX, e.clientY); cursor = w; const t = targetOf(e);
    if (e.button === 1 || e.button === 2 || space) { if (e.button === 2 && drawing) { finishWire(); return; } pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; return; }
    if (e.button !== 0) return;
    const down = { x: e.clientX, y: e.clientY, moved: false }; E._down = down;
    if (drawing) { commitTo(t, w); return; }
    if (t && t.kind === 'pin') { beginWire(t, w, true); down.wirePress = true; render(); return; }
    if (tool === 'wire') {
      if (t && t.kind === 'comp') { setSel({ comp: [t.id] }); return; }
      beginWire(t, w, true); down.wirePress = true; render(); return;
    }
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (t && (t.kind === 'comp' || t.kind === 'node')) {
      const set = t.kind === 'comp' ? sel.comp : sel.node;
      if (add) { set.has(t.id) ? set.delete(t.id) : set.add(t.id); setSel(sel); return; }
      if (!set.has(t.id)) setSel(t.kind === 'comp' ? { comp: [t.id] } : { node: [t.id] });
      startGroupDrag(w); return;
    }
    if (t && t.kind === 'edge') { if (add) { sel.edge.has(t.id) ? sel.edge.delete(t.id) : sel.edge.add(t.id); setSel(sel); } else { setSel({ edge: [t.id] }); segDrag = { id: t.id, seg: +t.seg || 0, start: w, started: false }; } return; }
    marq = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, moved: false, add };
  }
  function onMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const k2 = Math.max(0.8, Math.min(40, pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); const r = svg.getBoundingClientRect(); const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top; view.x = mx - ((mx - view.x) / view.k) * k2; view.y = my - ((my - view.y) / view.k) * k2; view.k = k2; applyView(); return; }
    if (pan) { view.x = pan.vx + e.clientX - pan.sx; view.y = pan.vy + e.clientY - pan.sy; applyView(); return; }
    const w = toWorld(e.clientX, e.clientY); cursor = w;
    const dn = E._down; if (dn && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 6) dn.moved = true;
    if (marq) { marq.x1 = w.x; marq.y1 = w.y; if (dn && dn.moved) marq.moved = true; render(); return; }
    if (segDrag) {
      if (!segDrag.started) { if (!dn || !dn.moved) return; if (!startSegDrag(segDrag)) { segDrag = null; return; } segDrag.started = true; }
      const sd = segDrag; result = null;
      sd.nodes.forEach((o) => { const nd = nodeById(o.k); if (sd.horiz) nd.y = f2(snap(o.y + (w.y - sd.start.y))); else nd.x = f2(snap(o.x + (w.x - sd.start.x))); });
      render(); return;
    }
    if (drag) {
      if (!dn || !dn.moved) return;
      if (!drag.pushed) { push(); drag.pushed = true; result = null; }
      const dx = snap(w.x - drag.start.x), dy = snap(w.y - drag.start.y);
      drag.comps.forEach((o) => { o.c.x = f2(o.x + dx); o.c.y = f2(o.y + dy); }); drag.nodes.forEach((o) => { o.n.x = f2(o.x + dx); o.n.y = f2(o.y + dy); });
      rebuildPins(); render();
      const over = !!(E.paletteHit && E.paletteHit(e.clientX, e.clientY) && drag.comps.length); drag.over = over; E.onPaletteHover && E.onPaletteHover(over); return;
    }
    const t = ev2t(e);
    if (drawing || tool === 'wire') updateWireCursor(t, w);
    updateHover(t, e); E.onStatus && E.onStatus({ x: w.x, y: w.y });
  }
  function updateHover(t, e) {
    let key = null, net;
    if (t) { const nets = userNets(); if (t.kind === 'pin') { key = 'p' + t.key; net = nets(t.key); } else if (t.kind === 'edge') { const ed = S.edges.find((q) => q.id === t.id); if (ed) { key = 'e' + t.id; net = nets(ed.a); } } else if (t.kind === 'node') { key = 'n' + t.id; net = nets(t.id); } }
    if (key !== lastHoverKey) { lastHoverKey = key; hover = key ? { net } : null; render(); }
    E.onHover && E.onHover(t && t.kind === 'pin' ? pinMap[t.key] : t && t.kind === 'comp' ? { comp: S.comps.find((q) => q.id === t.id) } : null, e);
  }
  function onUp(e) {
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
    const dn = E._down; E._down = null;
    if (pan) { pan = null; return; }
    if (segDrag) { const sd = segDrag; segDrag = null; if (sd.started) { simplify(); changed(); } return; }
    if (marq) { const m = marq; marq = null; if (m.moved) marqueeSelect(m); else { if (!m.add) setSel({}); else render(); } return; }
    if (drag) {
      const d = drag; drag = null; E.onPaletteHover && E.onPaletteHover(false);
      if (d.pushed) { if (d.over) { const ids = d.comps.map((o) => o.c.id); S.comps.forEach((c) => { if (ids.includes(c.id)) { const o = d.comps.find((q) => q.c === c); c.x = o.x; c.y = o.y; } }); removeComps(ids); sel.comp.clear(); } changed(); }
      return;
    }
    if (dn && dn.wirePress && drawing && drawing.press) {
      drawing.press = null;
      if (dn.moved) commitTo(ev2t(e), toWorld(e.clientX, e.clientY));      // протянули и отпустили
    }
  }
  function inField() { const a = document.activeElement; return !!a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); }
  function onKey(e) {
    if (inField() || document.querySelector('dialog[open]') || document.getElementById('anim')) return;
    const c = e.code, ctrl = e.ctrlKey || e.metaKey;           // e.code не зависит от раскладки (русская, английская…)
    if (c === 'Space') { e.preventDefault(); if (e.repeat) return; if (drawing) toggleFlip(); else space = true; return; }
    if (ctrl && c === 'KeyZ') { e.preventDefault(); e.shiftKey ? E.redo() : E.undo(); return; }
    if (ctrl && c === 'KeyY') { e.preventDefault(); E.redo(); return; }
    if (ctrl && c === 'KeyA') { e.preventDefault(); E.selectAll(); return; }
    if (ctrl || e.altKey) return;
    if (c === 'Escape') { if (drawing) cancelWire(); else setSel({}); }
    else if (c === 'Enter' || c === 'NumpadEnter') finishWire();
    else if (c === 'Delete' || c === 'Backspace') { e.preventDefault(); if (drawing) stepBack(); else E.deleteSelected(); }
    else if (c === 'KeyR') E.rotate(); else if (c === 'KeyX') E.mirror();
    else if (c === 'KeyW') E.setTool('wire'); else if (c === 'KeyV') E.setTool('select'); else if (c === 'KeyF') E.fit();
  }

  /* ---------- публичный API ---------- */
  E.setTool = (t) => { finishWire(); tool = t; svg.dataset.cursor = t; document.querySelectorAll('.toolbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); render(); };
  E.reset = () => { hist = []; fut = []; initState(); sel = { comp: new Set(), edge: new Set(), node: new Set() }; drawing = null; result = null; hint = null; changed(); E.fit(); };
  E.setRatsnest = (on) => { ratsnest = on; render(); };
  E.setResult = (r) => { result = r; if (r) { r.badPins = new Set(); r.missPins = new Set(); r.missing.forEach((m) => { r.missPins.add(m.a); r.missPins.add(m.b); }); r.shorts.forEach((s) => s.groups.forEach((g) => g.pins.forEach((p) => r.badPins.add(p)))); } render(); };
  E.setHint = (h) => { hint = h; render(); };
  E.flashComps = (ids) => { flash = {}; (ids || []).forEach((i) => (flash[i] = true)); render(); };
  E.focusComps = (ids) => {
    const cs = S.comps.filter((c) => ids.includes(c.id)); if (!cs.length) return; const r = svg.getBoundingClientRect();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; cs.forEach((c) => { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); });
    const k = Math.max(view.k, Math.min(r.width / (x1 - x0 + 40), r.height / (y1 - y0 + 40), 9)); view.k = k; view.x = r.width / 2 - ((x0 + x1) / 2) * k; view.y = r.height / 2 - ((y0 + y1) / 2) * k; applyView();
  };
  E.isDrawing = () => !!drawing;
  E.selectComp = (id) => setSel(id ? { comp: [id] } : {});
  E.focusPins = (keys) => E.focusComps(keys.map((k) => (pinMap[k] ? pinMap[k].comp.id : null)).filter(Boolean));
  E.compInfo = (id) => S.comps.find((c) => c.id === id);
  E.isPlaced = (ref) => S.comps.some((c) => c.id === ref);
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
  E.restore = (str) => { try { const s = JSON.parse(str); if (!s.comps) return false; S = s; hist = []; fut = []; changed(false); return true; } catch (e) { return false; } };
  E.view = () => view;

  E.init = function (container) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'sch'); svg.dataset.cursor = 'select';
    svg.innerHTML = `<defs><pattern id="gridpat" width="10" height="10" patternUnits="userSpaceOnUse"><circle r="0.8" fill="#b9b6a8"/></pattern></defs><rect width="100%" height="100%" fill="url(#gridpat)"/><g id="root"><g id="gWires"></g><g id="gOver"></g><g id="gComps"></g><g id="gText"></g><g id="gTemp"></g><g id="gPins"></g></g>`;
    container.appendChild(svg); root = svg.querySelector('#root');
    layers = { wires: svg.querySelector('#gWires'), over: svg.querySelector('#gOver'), comps: svg.querySelector('#gComps'), text: svg.querySelector('#gText'), temp: svg.querySelector('#gTemp'), pins: svg.querySelector('#gPins') };
    initState(); bind(); applyView();
  };
})();
