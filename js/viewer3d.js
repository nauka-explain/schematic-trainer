/* 3D-просмотрщик печатной платы (three.js). Данные: window.PCB_MODEL_B64 (gzip+base64). */
(function () {
  'use strict';
  const V = (window.Viewer3D = {});
  let renderer, scene, camera, controls, host, tagsHost;
  const groups = {}; // comps, silk, copper, pad, pcb
  const comps = {}; // ref -> {meshes:[], mats:[]}
  let boardCenter = new THREE.Vector3(), boardSize = 100;
  let focusRefs = [], pulse = 0, tween = null, showTags = false, tagEls = {};
  let onPick = null, hoverCb = null;

  async function decode(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof DecompressionStream === 'undefined') throw new Error('Браузер не поддерживает DecompressionStream. Обновите браузер.');
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(ds).arrayBuffer();
  }

  V.init = function (container, tags, opts) {
    host = container; tagsHost = tags; onPick = opts && opts.onPick; hoverCb = opts && opts.onHover;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.5, 2000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 0.85));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(-60, -80, 120); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.35); d2.position.set(80, 60, -60); scene.add(d2);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true; controls.maxPolarAngle = Math.PI; controls.minPolarAngle = 0;
    controls.zoomSpeed = 1.1;
    for (const k of ['comps', 'silk', 'copper', 'pad', 'pcb']) { groups[k] = new THREE.Group(); scene.add(groups[k]); }
    window.addEventListener('resize', V.resize);
    new ResizeObserver(V.resize).observe(host);
    bindPick();
    loop();
  };

  /* Загрузка модели платы (можно вызывать повторно при смене платы) */
  function clearScene() {
    const geos = new Set(), mats = new Set();
    Object.values(groups).forEach((g) => { g.traverse((o) => { if (o.isMesh) { geos.add(o.geometry); mats.add(o.material); } }); g.clear(); });
    geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose());
    Object.keys(comps).forEach((k) => delete comps[k]); focusRefs = []; tween = null; tagEls = {}; if (tagsHost) tagsHost.innerHTML = '';
  }
  V.load = async function (b64) {
    clearScene();
    const buf = await decode(b64);
    const dv = new DataView(buf);
    const jl = dv.getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
    const base = 4 + jl;
    const geos = {};
    for (const [name, p] of Object.entries(meta.parts)) {
      const pos = new Float32Array(buf.slice(base + p.off, base + p.off + p.nv * 12));
      const col = new Uint8Array(buf.slice(base + p.off + p.nv * 12, base + p.off + p.nv * 15));
      const idx = new Uint32Array(buf.slice(base + p.ioff, base + p.ioff + p.ni * 12));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      geos[name] = { g, kind: p.kind };
    }
    const mk = (extra) => new THREE.MeshPhongMaterial(Object.assign({ vertexColors: true, shininess: 40, specular: 0x333333, side: THREE.DoubleSide }, extra || {}));
    V.pcbMat = mk({ shininess: 25 });
    for (const inst of meta.insts) {
      const G = geos[inst.part];
      let mat;
      if (G.kind === 'comp') mat = mk(); else if (G.kind === 'PCB') mat = V.pcbMat; else mat = mk({ shininess: 70, specular: 0x666666 });
      const mesh = new THREE.Mesh(G.g, mat);
      mesh.matrixAutoUpdate = false; mesh.matrix.set(...inst.m); mesh.matrixWorldNeedsUpdate = true;
      const target = { comp: 'comps', silkscreen: 'silk', copper: 'copper', pad: 'pad', PCB: 'pcb', pcb: 'pcb' }[G.kind] || 'comps';
      if (G.kind === 'comp') {
        mesh.userData.ref = inst.ref; mesh.userData.part = inst.part;
        (comps[inst.ref] = comps[inst.ref] || { meshes: [], mats: [], part: inst.part });
        comps[inst.ref].meshes.push(mesh); comps[inst.ref].mats.push(mat);
      }
      groups[target].add(mesh);
    }
    // PCB bbox
    const bb = new THREE.Box3().setFromObject(groups.pcb);
    bb.getCenter(boardCenter); boardSize = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y);
    V.board = { min: bb.min.clone(), max: bb.max.clone() };
    // each component gets its own material so it can glow
    for (const c of Object.values(comps)) {
      c.mats = c.meshes.map((m) => { m.material = m.material.clone(); return m.material; });
    }
    V.refs = Object.keys(comps);
    tagsHost && V.refs.forEach((r) => { const d = document.createElement('div'); d.className = 'tag3d'; d.textContent = r; d.hidden = true; tagsHost.appendChild(d); tagEls[r] = d; });
    V.resize();
    V.setView('iso', true);
  };

  function bindPick() {
    const el = renderer.domElement; let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; tween = null; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null; const r = pick(e); onPick && onPick(r);
    });
    el.addEventListener('pointermove', (e) => { if (e.buttons) return; hoverCb && hoverCb(pick(e), e); });
    el.addEventListener('pointerleave', () => hoverCb && hoverCb(null));
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const objs = groups.comps.visible ? groups.comps.children : [];
    const hit = ray.intersectObjects(objs, false)[0];
    return hit ? { ref: hit.object.userData.ref, part: hit.object.userData.part } : null;
  }

  V.resize = function () {
    if (!host || !renderer) return;
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };

  V.setView = function (name, instant) {
    const D = boardSize * 2.1, t = boardCenter.clone(); t.z = 1.6;
    let p;
    if (name === 'top') p = new THREE.Vector3(0, -0.02 * D, D);
    else if (name === 'bottom') p = new THREE.Vector3(0, -0.02 * D, -D);
    else if (name === 'front') p = new THREE.Vector3(0, -D, 0.25 * D);
    else p = new THREE.Vector3(-0.35 * D, -0.8 * D, 0.75 * D);
    tweenTo(t, t.clone().add(p), instant);
  };
  function tweenTo(target, pos, instant) {
    if (instant) { controls.target.copy(target); camera.position.copy(pos); controls.update(); return; }
    tween = { t0: performance.now(), dur: 550, ft: controls.target.clone(), fp: camera.position.clone(), tt: target, tp: pos };
  }

  V.setLayer = (k, on) => { if (groups[k]) groups[k].visible = on; };
  V.setBoardOpacity = (v) => {
    V.pcbMat.transparent = v < 0.99; V.pcbMat.opacity = v; V.pcbMat.depthWrite = v >= 0.99; V.pcbMat.needsUpdate = true;
  };
  V.setTags = (on) => { showTags = on; Object.values(tagEls).forEach((d) => (d.hidden = !on)); };

  V.focus = function (refs, frame) {
    focusRefs = (refs || []).filter((r) => comps[r]);
    for (const [r, c] of Object.entries(comps)) c.mats.forEach((m) => m.emissive.setHex(0x000000));
    if (frame && focusRefs.length) {
      const box = new THREE.Box3();
      focusRefs.forEach((r) => comps[r].meshes.forEach((m) => box.expandByObject(m)));
      const c = box.getCenter(new THREE.Vector3()); const s = Math.max(box.getSize(new THREE.Vector3()).length(), 14);
      const dir = camera.position.clone().sub(controls.target).normalize();
      const dist = Math.max(s * 4, 75);
      tweenTo(c, c.clone().add(dir.multiplyScalar(dist)));
    }
  };
  V.partOf = (ref) => comps[ref] && comps[ref].part;
  V.has = (ref) => !!comps[ref];

  const tmp = new THREE.Vector3();
  function loop() {
    requestAnimationFrame(loop);
    if (tween) {
      let k = Math.min(1, (performance.now() - tween.t0) / tween.dur); k = 1 - Math.pow(1 - k, 3);
      controls.target.lerpVectors(tween.ft, tween.tt, k); camera.position.lerpVectors(tween.fp, tween.tp, k);
      if (k >= 1) tween = null;
    }
    controls.update();
    if (focusRefs.length) {
      pulse += 0.08; const v = 0.35 + 0.3 * Math.sin(pulse);
      focusRefs.forEach((r) => comps[r].mats.forEach((m) => m.emissive.setRGB(v * 1.0, v * 0.55, 0)));
    }
    renderer.render(scene, camera);
    if (showTags) {
      const w = host.clientWidth, h = host.clientHeight;
      for (const [r, c] of Object.entries(comps)) {
        const d = tagEls[r]; if (!d) continue;
        const b = c.box || (c.box = new THREE.Box3().setFromObject(c.meshes[0]));
        b.getCenter(tmp); tmp.z = b.max.z; tmp.project(camera);
        const vis = groups.comps.visible && tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
        d.style.display = vis ? '' : 'none';
        d.style.transform = `translate(-50%,-50%) translate(${((tmp.x + 1) / 2) * w}px,${((1 - tmp.y) / 2) * h}px)`;
      }
    }
  }
})();
