/* Проверка собранной схемы по эталонному списку цепей (из KiCad). Чистая логика, без DOM. */
(function () {
  'use strict';
  const Checker = (window.Checker = {});

  function UF() {
    const p = new Map();
    const f = (a) => { if (!p.has(a)) p.set(a, a); while (p.get(a) !== a) { p.set(a, p.get(p.get(a))); a = p.get(a); } return a; };
    return { find: f, union: (a, b) => p.set(f(a), f(b)) };
  }

  /* graph = { pins:[key], free:[key], edges:[{id,a,b}], power:[{key,name}], pos:{key:{x,y}} }
     ref   = [{name, pins:[key]}] */
  Checker.check = function (graph, ref) {
    const pinRef = {}, nameRef = {};
    ref.forEach((n, i) => { if (!n.name) n.label = n.pins.slice(0, 2).join('–'); n.pins.forEach((p) => (pinRef[p] = i)); if (n.name) nameRef[n.name] = i; });
    const nodeRef = (k) => (k in pinRef ? pinRef[k] : null);
    const powerName = {}; graph.power.forEach((p) => (powerName[p.key] = p.name));
    const refOfNode = (k) => (k in powerName ? (powerName[k] in nameRef ? nameRef[powerName[k]] : 'x:' + powerName[k]) : nodeRef(k));

    // смежность (провода + виртуальные связи одноимённых символов питания)
    const adj = new Map(); const add = (a, b, id) => { (adj.get(a) || adj.set(a, []).get(a)).push([b, id]); (adj.get(b) || adj.set(b, []).get(b)).push([a, id]); };
    graph.edges.forEach((e) => add(e.a, e.b, e.id));
    graph.power.forEach((p) => add(p.key, 'NET:' + p.name, 'virt'));
    const uf = UF();
    graph.edges.forEach((e) => uf.union(e.a, e.b));
    graph.power.forEach((p) => uf.union(p.key, 'NET:' + p.name));

    const reach = (start, skip) => {
      const seen = new Set([start]); const st = [start];
      while (st.length) { const u = st.pop(); for (const [v, id] of adj.get(u) || []) { if (id === skip || seen.has(v)) continue; seen.add(v); st.push(v); } }
      return seen;
    };
    const refSet = (S) => { const r = new Set(); S.forEach((k) => { const x = refOfNode(k); if (x !== null && x !== undefined) r.add(x); }); return r; };

    // компоненты связности пользователя
    const comps = new Map();
    [...graph.pins, ...graph.free, ...graph.power.map((p) => p.key)].forEach((k) => { const r = uf.find(k); (comps.get(r) || comps.set(r, []).get(r)).push(k); });

    // статус каждого провода
    const edgeStatus = {};
    for (const e of graph.edges) {
      const A = reach(e.a, e.id);
      if (A.has(e.b)) {
        const rs = refSet(A);
        edgeStatus[e.id] = rs.size === 0 ? 'dangling' : rs.size > 1 ? 'bad' : 'ok';
      } else {
        const B = reach(e.b, e.id); const ra = refSet(A), rb = refSet(B);
        if (!ra.size || !rb.size) { edgeStatus[e.id] = 'dangling'; continue; }
        let share = false; ra.forEach((x) => { if (rb.has(x)) share = true; });
        edgeStatus[e.id] = share ? 'ok' : 'bad';
      }
    }

    // замыкания разных цепей
    const shorts = []; let wrong = 0;
    comps.forEach((members) => {
      const byRef = new Map();
      members.forEach((k) => { const x = refOfNode(k); if (x === null || x === undefined) return; (byRef.get(x) || byRef.set(x, []).get(x)).push(k); });
      if (byRef.size > 1) {
        wrong += byRef.size - 1;
        shorts.push({ groups: [...byRef.entries()].map(([x, ks]) => ({ net: typeof x === 'number' ? ref[x].name || 'Цепь ' + ref[x].label : String(x).slice(2), pins: ks.filter((k) => !(k in powerName)), power: ks.filter((k) => k in powerName).map((k) => powerName[k]) })) });
      }
    });

    // недостающие связи
    const missing = []; let required = 0, miss = 0; const netsReport = [];
    ref.forEach((n, i) => {
      const pins = n.pins; required += Math.max(0, pins.length - 1);
      const groups = new Map();
      pins.forEach((p) => { const r = uf.find(p); (groups.get(r) || groups.set(r, []).get(r)).push(p); });
      const gl = [...groups.values()];
      let status = gl.length <= 1 ? 'ok' : 'partial';
      if (gl.length > 1) {
        miss += gl.length - 1;
        // MST по минимальным расстояниям между группами
        const inT = new Set([0]);
        while (inT.size < gl.length) {
          let best = null;
          for (const a of inT) for (let b = 0; b < gl.length; b++) { if (inT.has(b)) continue;
            for (const pa of gl[a]) for (const pb of gl[b]) {
              const A = graph.pos[pa], B = graph.pos[pb]; const d = A && B ? Math.abs(A.x - B.x) + Math.abs(A.y - B.y) : 1e6;
              if (!best || d < best.d) best = { d, a: pa, b: pb, bi: b };
            } }
          inT.add(best.bi); missing.push({ a: best.a, b: best.b, net: n.name || 'Цепь ' + n.label, idx: i, unplaced: !graph.pos[best.a] || !graph.pos[best.b] });
        }
      }
      netsReport.push({ idx: i, name: n.name, pins, groups: gl, status });
    });
    // цепи, затронутые замыканием
    shorts.forEach((s) => s.groups.forEach((g) => { const r = netsReport.find((x) => (x.name || 'Цепь ' + ref[x.idx].label) === g.net); if (r) r.shorted = true; }));
    const correct = required - miss;
    const score = required ? Math.max(0, Math.round(((correct - wrong) / required) * 100)) : 100;
    const badEdges = Object.values(edgeStatus).filter((s) => s === 'bad').length;
    return { edgeStatus, shorts, missing, netsReport, stats: { required, correct, missing: miss, wrong, badEdges, score, perfect: miss === 0 && wrong === 0 } };
  };
})();
