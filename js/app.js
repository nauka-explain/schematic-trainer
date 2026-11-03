/* Приложение: связывает палитру, 3D-вид, редактор схемы и проверку. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const E = window.Editor, V = window.Viewer3D, P = window.Palette;
  let D = null, boardId = null, KEY = '', ALLREFS = [], switching = false;
  const keyFor = (id) => (id === 'amplifier' ? 'pcbsim:amp:v2' : 'pcbsim:' + id + ':v2');
  let mode = 'exam', secs = 0, timerOn = false, hints = 0, checks = 0, lastRes = null, saveT = null;

  const PART_RU = [
    [/^R_Axial/, 'Резистор выводной'], [/^C_Disc/, 'Конденсатор дисковый'], [/^CP_Radial/, 'Конденсатор электролитический'],
    [/^D_DO-41/, 'Диод DO-41'], [/^LED/, 'Светодиод'], [/^DIP-8/, 'Микросхема DIP-8'], [/^2N2222/, 'Транзистор TO-92'],
    [/^WH148/, 'Переменный резистор'], [/^TB006/, 'Клеммник 2 контакта'], [/^500SSP3/, 'Переключатель'],
    [/^C_Radial/, 'Конденсатор электролитический'], [/^TO-220/, 'Микросхема/транзистор TO-220'], [/^TO-92/, 'Транзистор TO-92'], [/^Potentiometer/, 'Подстроечный резистор'],
    [/^TerminalBlock/, 'Клеммник'], [/^Transformer/, 'Трансформатор'], [/^Fuseholder/, 'Держатель предохранителя'],
  ];
  const partRu = (p) => { const m = PART_RU.find(([r]) => r.test(p || '')); return m ? m[1] : null; };
  const typeName = (ref, part) => partRu(part) || ((E.compInfo(ref) || (D && D.insts.find((i) => i.id === ref)) || {}).lib && D.libs[(E.compInfo(ref) || D.insts.find((i) => i.id === ref)).lib].title) || 'Компонент';
  const refOf = (k) => String(k).split('.')[0];
  const pinLabel = (k) => String(k);
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

  /* ---------- подсказки-тултипы (иконки без подписей) ---------- */
  const tip = $('#tip');
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]'); if (!el || e.pointerType === 'touch') { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip; tip.hidden = false; const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect(); const pos = el.dataset.pos || 'b';
    let x, y; if (pos === 'r') { x = r.right + 8; y = r.top + r.height / 2 - tr.height / 2; } else if (pos === 'l') { x = r.left - tr.width - 8; y = r.top + r.height / 2 - tr.height / 2; } else { x = r.left + r.width / 2 - tr.width / 2; y = r.bottom + 7; }
    tip.style.left = Math.max(4, Math.min(innerWidth - tr.width - 4, x)) + 'px'; tip.style.top = Math.max(4, y) + 'px';
  });
  document.addEventListener('pointerdown', () => (tip.hidden = true));
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-tip]')) tip.hidden = true; });

  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 4200); }
  P.setToast(toast);

  /* ---------- сохранение ---------- */
  function saveNow() { if (!boardId) return; try { localStorage.setItem(KEY, JSON.stringify({ s: E.serialize(), secs, hints, checks, mode })); } catch (e) { } }
  function save() { clearTimeout(saveT); saveT = setTimeout(saveNow, 400); }
  function load() { try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d && E.restore(d.s)) { secs = d.secs || 0; hints = d.hints || 0; checks = d.checks || 0; setMode(d.mode || 'exam'); return true; } } catch (e) { } return false; }

  /* ---------- режимы ---------- */
  function setMode(m) {
    mode = m; document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    const tg = $('#tagsToggle'); tg.hidden = m !== 'train'; if (m !== 'train') { tg.classList.remove('on'); V.setTags && V.setTags(false); }
    V.focus && V.focus([]); E.flashComps([]); save();
  }

  /* ---------- индикаторы ---------- */
  setInterval(() => { if (timerOn) { secs++; $('#timer').textContent = fmt(secs); } }, 1000);
  function status(pos) {
    if (pos) $('#stCursor').textContent = `x ${pos.x.toFixed(1)} · y ${pos.y.toFixed(1)}`;
    const st = E.stats(), cc = E.compCounts();
    $('#progress').textContent = `${st.pinsDone}/${st.pinsTotal}`; $('#stWires').textContent = st.wires; $('#mComps').textContent = `${cc.placed}/${cc.total}`;
  }
  E.onStatus = status;
  E.onChange = () => {
    if (switching) return;
    timerOn = true; lastRes = null; if (!$('#results').hidden) markStale(); V.focus && V.focus([]); P.update(); save();
  };
  function markStale() { const b = $('#rBody'); if (!b.querySelector('.stale')) { const d = document.createElement('div'); d.className = 'issue miss stale'; d.textContent = 'Схема изменена после проверки. Нажмите «Проверить» ещё раз.'; b.prepend(d); } }

  /* ---------- выбор и инспектор обозначения ---------- */
  let selId = null;
  E.onSelect = (info) => {
    selId = info.comps.length === 1 ? info.comps[0] : null;
    const n = info.comps.length + info.edges + info.nodes; const s = $('#stSel'); s.hidden = !n;
    $('#stSelN').textContent = [info.comps.length && `${info.comps.length} комп.`, info.edges && `${info.edges} пров.`, info.nodes && `${info.nodes} уз.`].filter(Boolean).join(' · ');
    const ins = $('#inspector'); const c = info.comps.length === 1 && !info.edges && !info.nodes ? E.compInfo(info.comps[0]) : null;
    if (c && !c.power) {
      ins.hidden = false; const sel = $('#desSel'); sel.innerHTML = E.designators(c.id).map((d) => `<option value="${d.ref}"${d.ref === c.id ? ' selected' : ''}>${d.ref}${d.used ? ' ✓' : ''} · ${d.val}</option>`).join(''); $('#desVal').textContent = '';
    } else ins.hidden = true;
    if (mode === 'train' && c && !c.power && V.has && V.has(c.id)) { V.focus([c.id], true); const card = $('#card3d'); card.hidden = false; card.innerHTML = `<b>${c.id}</b> · ${typeName(c.id, V.partOf(c.id))}`; }
    else if (mode === 'train' && c && !c.power) { const card = $('#card3d'); card.hidden = false; card.innerHTML = `<b>${c.id}</b> · для этого элемента нет 3D-модели, на плате видны только его площадки.`; }
  };
  $('#desSel').onchange = (e) => { if (selId) E.setDesignator(selId, e.target.value); e.target.blur(); };

  /* ---------- проверка ---------- */
  const runCheck = () => window.Checker.check(E.graph(), D.nets);
  function unplacedRefs() { return ALLREFS.filter((r) => !E.isPlaced(r)); }
  function check() {
    const g = E.graph(); if (!g.pins.length) { toast('Сначала перетащите компоненты на холст.'); return; }
    if (!g.edges.length) { toast('Проведите хотя бы один провод.'); return; }
    const res = runCheck(); lastRes = res; checks++; E.setResult(res); E.setHint(null); showResults(res); save();
    if (res.stats.perfect) { timerOn = false; try { const k = KEY + ':best'; const b = JSON.parse(localStorage.getItem(k) || 'null'); if (!b || secs < b.secs) localStorage.setItem(k, JSON.stringify({ secs, hints, checks })); } catch (e) { } }
  }
  const list = (a, n = 6) => (a.length > n ? a.slice(0, n).join(', ') + ' …' : a.join(', '));
  function showResults(res) {
    const st = res.stats, un = unplacedRefs(); $('#results').hidden = false;
    $('#rTitle').textContent = st.perfect ? 'Схема собрана верно' : 'Результат проверки';
    const cls = st.perfect ? 'ok' : st.score >= 60 ? 'mid' : 'low';
    let h = `<div class="score ${cls}"><span class="big">${st.score}%</span><div class="kv" style="flex:1"><span>Верных соединений</span><b>${st.correct} из ${st.required}</b><span>Пропущено</span><b>${st.missing}</b><span>Лишних замыканий</span><b>${st.wrong}</b><span>Время · подсказки · проверки</span><b>${fmt(secs)} · ${hints} · ${checks}</b></div></div>`;
    h += `<div class="legend"><span><i style="border-color:#e5383b"></i>лишнее / неверное</span><span><i style="border-color:#f08c00;border-top-style:dashed"></i>не соединено</span><span><i style="border-color:#1a9b45"></i>верно</span></div>`;
    if (st.perfect) h += `<div class="issue good">Все соединения (${st.required}) совпадают с эталонной схемой, лишних связей нет.</div>`;
    if (un.length) h += `<div class="issue miss" style="cursor:default"><b>Не размещены на схеме (${un.length}):</b><small><code>${list(un, 14)}</code></small></div>`;
    if (res.shorts.length) {
      h += '<h3>Лишние соединения (красные провода)</h3>';
      res.shorts.forEach((s, i) => { h += `<div class="issue bad" data-short="${i}"><b>Замкнуты разные цепи:</b>` + s.groups.map((g) => `<small><code>${g.net}</code>: ${list(g.pins.map(pinLabel).concat(g.power.map((p) => 'символ ' + p)))}</small>`).join('') + '</div>'; });
    }
    const shown = res.missing.filter((m) => !m.unplaced);
    if (shown.length) {
      h += '<h3>Не соединено (пунктир)</h3>';
      res.missing.forEach((m, i) => { if (!m.unplaced) h += `<div class="issue miss" data-miss="${i}"><code>${pinLabel(m.a)}</code> и <code>${pinLabel(m.b)}</code> должны быть в одной цепи<small>${m.net}</small></div>`; });
    }
    h += '<h3>Цепи</h3>';
    res.netsReport.filter((n) => n.pins.length > 1).forEach((n) => {
      const c = n.shorted ? '#e5383b' : n.status === 'ok' ? '#2fb344' : '#f08c00';
      h += `<div class="netrow"><span class="d" style="background:${c}"></span><div><b>${n.name || 'Цепь'}</b> <code>${list(n.pins.map(pinLabel), 9)}</code></div></div>`;
    });
    $('#rBody').innerHTML = h;
  }
  $('#rBody').addEventListener('click', (e) => {
    const it = e.target.closest('.issue'); if (!it || !lastRes) return; let pins = [];
    if (it.dataset.miss !== undefined) { const m = lastRes.missing[+it.dataset.miss]; pins = [m.a, m.b]; }
    else if (it.dataset.short !== undefined) lastRes.shorts[+it.dataset.short].groups.forEach((g) => (pins = pins.concat(g.pins)));
    else return;
    const refs = [...new Set(pins.map(refOf))]; E.focusPins(pins); E.flashComps(refs); V.focus(refs, true);
  });
  $('#rClose').onclick = () => ($('#results').hidden = true);

  /* ---------- подсказка ---------- */
  function hint() {
    if (!E.graph().pins.length) { toast('Начните с размещения компонентов из панели.'); return; }
    const res = runCheck(), cand = res.missing.filter((m) => !m.unplaced);
    if (!cand.length) { const n = unplacedRefs().length; toast(n ? `Размещено не всё: осталось ${n} компонентов (${list(unplacedRefs(), 5)}).` : res.stats.wrong ? 'Недостающих связей нет, но есть лишние. Нажмите «Проверить».' : 'Все соединения уже на месте.'); return; }
    const m = cand[Math.floor(Math.random() * cand.length)]; hints++; E.setHint(m); E.focusPins([m.a, m.b]);
    const refs = [refOf(m.a), refOf(m.b)]; E.flashComps(refs); V.focus(refs, true); toast(`Подсказка: соедините ${m.a} и ${m.b}`); save();
  }

  /* ---------- 3D ---------- */
  function bind3D() {
    document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => V.setView(b.dataset.view)));
    document.querySelectorAll('[data-layer]').forEach((b) => (b.onclick = () => { b.classList.toggle('on'); V.setLayer(b.dataset.layer, b.classList.contains('on')); }));
    $('#tagsToggle').onclick = (e) => { const b = e.currentTarget; b.classList.toggle('on'); V.setTags(b.classList.contains('on')); };
  }
  function onPick3D(p) {
    const card = $('#card3d');
    if (!p) { card.hidden = true; V.focus([]); E.flashComps([]); return; }
    V.focus([p.ref]); card.hidden = false;
    if (mode === 'train') {
      card.innerHTML = `<b>${p.ref}</b> · ${typeName(p.ref, p.part)}`;
      if (E.isPlaced(p.ref)) { E.selectComp(p.ref); E.focusComps([p.ref]); E.flashComps([p.ref]); } else toast(`${p.ref} ещё не на схеме: перетащите «${typeName(p.ref, p.part).toLowerCase()}» из панели.`);
    } else card.innerHTML = `${typeName(p.ref, p.part)}<br><small>Определите по шелкографии, какой это элемент схемы.</small>`;
  }
  E.onHover = (o, ev) => {
    const t = $('#pinTip'); if (!o) { t.hidden = true; return; }
    const r = $('#schHost').getBoundingClientRect(); t.hidden = false; t.style.left = ev.clientX - r.left + 14 + 'px'; t.style.top = ev.clientY - r.top + 14 + 'px';
    if (o.num !== undefined) t.textContent = o.comp.power ? o.comp.val : `${o.comp.id} · вывод ${o.num}${o.name && o.name !== '~' && o.name !== o.num ? ' (' + o.name + ')' : ''}`;
    else t.textContent = `${o.comp.id}${o.comp.power ? '' : ' · ' + o.comp.val}`;
  };

  /* ---------- разделитель ---------- */
  function bindSplit() {
    const g = $('#gutter'), s = $('#split'); let on = false;
    g.addEventListener('pointerdown', (e) => { on = true; g.setPointerCapture(e.pointerId); });
    g.addEventListener('pointermove', (e) => { if (!on) return; const r = s.getBoundingClientRect(); s.style.setProperty('--left', Math.max(25, Math.min(70, ((e.clientX - r.left) / r.width) * 100)) + '%'); V.resize(); });
    g.addEventListener('pointerup', () => { on = false; });
    g.addEventListener('keydown', (e) => { const cur = parseFloat(getComputedStyle(s).getPropertyValue('--left')) || 44; if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { s.style.setProperty('--left', cur + (e.key === 'ArrowLeft' ? -3 : 3) + '%'); V.resize(); } });
  }

  /* после щелчка мышью кнопка не должна «держать» фокус: иначе пробел/Enter нажмут её ещё раз */
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0 && !b.closest('dialog')) b.blur(); });

  /* ---------- выбор платы ---------- */
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Не найден файл ' + src)); document.head.appendChild(s); });
  async function ensureBoard(id) {
    if (!(window.BOARD_DATA && window.BOARD_DATA[id])) await loadScript(`boards/${id}/data.js`);
    if (!(window.BOARD_MODELS && window.BOARD_MODELS[id])) await loadScript(`boards/${id}/model.js`);
  }
  function setLoading(on, text) { const l = $('#loading3d'); l.hidden = !on; if (text) l.textContent = text; }
  function bestOf(id) { try { return JSON.parse(localStorage.getItem(keyFor(id) + ':best') || 'null'); } catch (e) { return null; } }
  function buildBoardMenu() {
    const m = $('#boardMenu'); m.innerHTML = '';
    window.BOARD_LIST.forEach((b) => {
      const el = document.createElement('button'); el.className = 'bitem' + (b.id === boardId ? ' cur' : ''); el.setAttribute('role', 'menuitem');
      const best = bestOf(b.id);
      el.innerHTML = `<b>${b.title}</b><span class="bmeta"><span class="lvl" data-tip="Сложность">${[1, 2, 3].map((n) => `<i class="${n <= b.level ? 'on' : ''}"></i>`).join('')}</span><span title="Деталей">${b.parts}</span>${best ? `<svg class="ic done"><use href="#i-done"/></svg>${fmt(best.secs)}` : ''}</span><small>${b.subtitle}</small>`;
      el.onclick = () => { closeBoardMenu(); if (b.id !== boardId) openBoard(b.id); };
      m.appendChild(el);
    });
  }
  function openBoardMenu() { buildBoardMenu(); $('#boardMenu').hidden = false; $('#boardBtn').setAttribute('aria-expanded', 'true'); }
  function closeBoardMenu() { $('#boardMenu').hidden = true; $('#boardBtn').setAttribute('aria-expanded', 'false'); }
  async function openBoard(id) {
    if (boardId) { clearTimeout(saveT); saveNow(); }
    switching = true; setLoading(true, 'Загрузка платы…'); window.Anim.close(); $('#results').hidden = true; $('#card3d').hidden = true;
    try { await ensureBoard(id); } catch (err) { setLoading(true, err.message); switching = false; return; }
    boardId = id; KEY = keyFor(id); D = window.BOARD_DATA[id]; ALLREFS = D.insts.filter((i) => !i.power).map((i) => i.id);
    timerOn = false; secs = 0; hints = 0; checks = 0; lastRes = null;
    E.setData(D); const restored = load(); P.init($('#palette')); status(); E.fit();
    $('#boardName').textContent = (window.BOARD_LIST.find((b) => b.id === id) || {}).title || D.title; document.title = 'Чтение схем и печатных плат: ' + $('#boardName').textContent;
    $('#timer').textContent = fmt(secs); try { localStorage.setItem('pcbsim:last', id); } catch (e) { }
    switching = false; if (restored) { timerOn = true; toast('Восстановлена ваша прошлая сборка этой платы.'); }
    try { await V.load(window.BOARD_MODELS[id]); setLoading(false); } catch (err) { setLoading(true, 'Не удалось загрузить 3D: ' + err.message); }
  }

  /* ---------- запуск ---------- */
  function boot() {
    E.init($('#schHost'));
    document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
    document.querySelectorAll('.toolbar [data-tool]').forEach((b) => (b.onclick = () => E.setTool(b.dataset.tool)));
    $('#bRot').onclick = E.rotate; $('#bMir').onclick = E.mirror; $('#bDel').onclick = E.deleteSelected; $('#bUndo').onclick = E.undo; $('#bRedo').onclick = E.redo; $('#bFit').onclick = E.fit;
    $('#ratsToggle').onclick = (e) => { const b = e.currentTarget; b.classList.toggle('on'); E.setRatsnest(b.classList.contains('on')); };
    $('#bAnim').onclick = () => {
      if (window.Anim.isOpen()) { window.Anim.close(); return; }
      if (mode === 'exam' && E.stats().wires + E.compCounts().placed > 0 && !confirm('Анимация покажет готовую схему. Таймер остановится. Продолжить?')) return;
      if (mode === 'exam') timerOn = false;
      window.Anim.open($('#schHost'));
    };
    $('#btnCheck').onclick = check; $('#btnHint').onclick = hint;
    $('#btnReset').onclick = () => { if (confirm('Убрать все компоненты и провода этой платы и начать заново?')) { E.reset(); secs = 0; hints = 0; checks = 0; timerOn = false; $('#timer').textContent = '00:00'; $('#results').hidden = true; save(); } };
    const help = $('#help'); $('#btnHelp').onclick = () => help.showModal();
    try { if (!localStorage.getItem('pcbsim:seen')) { help.showModal(); localStorage.setItem('pcbsim:seen', '1'); } } catch (e) { help.showModal(); }
    $('#boardBtn').onclick = (e) => { e.stopPropagation(); $('#boardMenu').hidden ? openBoardMenu() : closeBoardMenu(); };
    document.addEventListener('click', (e) => { if (!e.target.closest('#boardMenu') && !e.target.closest('#boardBtn')) closeBoardMenu(); });
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !$('#boardMenu').hidden) closeBoardMenu(); });
    window.addEventListener('beforeunload', saveNow);
    bind3D(); bindSplit(); V.init($('#view3d'), $('#tags3d'), { onPick: onPick3D });
    window.addEventListener('resize', () => E.fit());
    let last = 'amplifier'; try { last = localStorage.getItem('pcbsim:last') || last; } catch (e) { }
    if (!window.BOARD_LIST.some((b) => b.id === last)) last = window.BOARD_LIST[0].id;
    openBoard(last);
  }
  boot();
})();
