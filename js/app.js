/* Приложение: связывает 3D-вид, редактор схемы и проверку. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const E = window.Editor, V = window.Viewer3D, D = window.SCH_DATA;
  const KEY = 'pcbsim:amp:v1';
  let mode = 'exam', secs = 0, timerOn = false, hints = 0, checks = 0, lastRes = null, saveT = null;

  const PART_RU = [
    [/^R_Axial/, 'Резистор выводной'], [/^C_Disc/, 'Конденсатор дисковый (керамический)'], [/^CP_Radial/, 'Конденсатор электролитический (полярный)'],
    [/^D_DO-41/, 'Диод DO-41'], [/^LED/, 'Светодиод'], [/^DIP-8/, 'Микросхема в корпусе DIP-8'], [/^2N2222/, 'Транзистор в корпусе TO-92'],
    [/^WH148/, 'Переменный (подстроечный) резистор'], [/^TB006/, 'Клеммник 2 контакта'], [/^500SSP3/, 'Переключатель'],
  ];
  const partRu = (p) => { const m = PART_RU.find(([r]) => r.test(p || '')); return m ? m[1] : 'Компонент'; };
  const refOf = (k) => String(k).split('.')[0];
  const pinLabel = (k) => { const [r, n] = String(k).split('.'); return `${r}.${n}`; };

  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3800); }
  E.setToast(toast);

  /* ---------- сохранение ---------- */
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify({ s: E.serialize(), secs, hints, checks, mode })); } catch (e) { } }, 400);
  }
  function load() {
    try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d && E.restore(d.s)) { secs = d.secs || 0; hints = d.hints || 0; checks = d.checks || 0; setMode(d.mode || 'exam'); return true; } } catch (e) { }
    return false;
  }

  /* ---------- режимы ---------- */
  function setMode(m) {
    mode = m; document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('#tagsRow').hidden = m !== 'train'; if (m !== 'train') { $('#tagsToggle').checked = false; V.setTags && V.setTags(false); }
    V.focus && V.focus([]); E.flashComps([]); save();
  }

  /* ---------- таймер и прогресс ---------- */
  setInterval(() => { if (timerOn) { secs++; $('#timer').textContent = fmt(secs); } }, 1000);
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  function status(pos) {
    if (pos) $('#stCursor').textContent = `x ${pos.x.toFixed(2)} · y ${pos.y.toFixed(2)} мм`;
    const st = E.stats(); $('#progress').textContent = `${st.pinsDone}/${st.pinsTotal}`; $('#stInfo').textContent = `Проводов: ${st.wires}`;
  }
  E.onStatus = status;
  E.onChange = () => {
    if (!timerOn) timerOn = true;
    lastRes = null; if (!$('#results').hidden) markStale(); V.focus && V.focus([]); save();
  };
  function markStale() { const b = $('#rBody'); if (!b.querySelector('.stale')) { const d = document.createElement('div'); d.className = 'issue miss stale'; d.textContent = 'Схема изменена после проверки. Нажмите «Проверить» ещё раз.'; b.prepend(d); } }

  /* ---------- проверка ---------- */
  function runCheck() { return window.Checker.check(E.graph(), D.nets); }
  function check() {
    const g = E.graph(); if (!g.edges.length) { toast('Сначала проведите хотя бы один провод.'); return; }
    const res = runCheck(); lastRes = res; checks++; E.setResult(res); E.setHint(null); showResults(res); save();
    if (res.stats.perfect) { timerOn = false; try { const k = KEY + ':best'; const b = JSON.parse(localStorage.getItem(k) || 'null'); if (!b || secs < b.secs) localStorage.setItem(k, JSON.stringify({ secs, hints, checks })); } catch (e) { } }
  }
  const list = (a, n = 6) => (a.length > n ? a.slice(0, n).join(', ') + ' …' : a.join(', '));
  function showResults(res) {
    const st = res.stats; $('#results').hidden = false;
    $('#rTitle').textContent = st.perfect ? 'Схема собрана верно' : 'Результат проверки';
    const cls = st.perfect ? 'ok' : st.score >= 60 ? 'mid' : 'low';
    let h = `<div class="score ${cls}"><span class="big">${st.score}%</span><div class="kv" style="flex:1"><span>Верных соединений</span><b>${st.correct} из ${st.required}</b><span>Пропущено</span><b>${st.missing}</b><span>Лишних замыканий</span><b>${st.wrong}</b><span>Время · подсказки · проверки</span><b>${fmt(secs)} · ${hints} · ${checks}</b></div></div>`;
    h += `<div class="legend"><span><i style="border-color:#e5383b"></i>лишнее / неверное</span><span><i style="border-color:#f08c00;border-top-style:dashed"></i>не соединено</span><span><i style="border-color:#1a9b45"></i>верно</span></div>`;
    if (st.perfect) h += `<div class="issue good">Все соединения (${st.required}) совпадают с эталонной схемой, лишних связей нет.</div>`;
    if (res.shorts.length) {
      h += '<h3>Лишние соединения (красные провода)</h3>';
      res.shorts.forEach((s, i) => {
        h += `<div class="issue bad" data-short="${i}"><b>Замкнуты разные цепи:</b>` + s.groups.map((g) => `<small><code>${g.net}</code>: ${list(g.pins.map(pinLabel).concat(g.power.map((p) => 'символ ' + p)))}</small>`).join('') + '</div>';
      });
    }
    if (res.missing.length) {
      h += '<h3>Не соединено (пунктир)</h3>';
      res.missing.forEach((m, i) => { h += `<div class="issue miss" data-miss="${i}"><code>${pinLabel(m.a)}</code> и <code>${pinLabel(m.b)}</code> должны быть в одной цепи<small>${m.net}</small></div>`; });
    }
    h += '<h3>Цепи</h3>';
    res.netsReport.filter((n) => n.pins.length > 1).forEach((n) => {
      const c = n.shorted ? '#e5383b' : n.status === 'ok' ? '#2fb344' : '#f08c00';
      h += `<div class="netrow"><span class="d" style="background:${c}"></span><div><b>${n.name || 'Цепь'}</b> <code>${list(n.pins.map(pinLabel), 9)}</code></div></div>`;
    });
    const unused = res.netsReport.filter((n) => n.pins.length === 1).map((n) => pinLabel(n.pins[0]));
    if (unused.length) h += `<div class="netrow"><span class="d" style="background:#6c757d"></span><div><b>Не подключены (по схеме):</b> <code>${unused.join(', ')}</code></div></div>`;
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
    const res = runCheck(); if (!res.missing.length) { toast(res.stats.wrong ? 'Недостающих связей нет, но есть лишние. Нажмите «Проверить».' : 'Все соединения уже на месте.'); return; }
    const m = res.missing[Math.floor(Math.random() * res.missing.length)]; hints++; E.setHint(m); E.focusPins([m.a, m.b]);
    const refs = [refOf(m.a), refOf(m.b)]; E.flashComps(refs); V.focus(refs, true);
    toast(`Подсказка: соедините ${pinLabel(m.a)} и ${pinLabel(m.b)}`); save();
  }

  /* ---------- 3D ---------- */
  function bind3D() {
    document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => V.setView(b.dataset.view)));
    document.querySelectorAll('[data-layer]').forEach((c) => (c.onchange = () => V.setLayer(c.dataset.layer, c.checked)));
    $('#xray').onchange = (e) => V.setBoardOpacity(e.target.checked ? 0.22 : 1);
    $('#tagsToggle').onchange = (e) => V.setTags(e.target.checked);
  }
  function onPick3D(p) {
    const card = $('#card3d');
    if (!p) { card.hidden = true; V.focus([]); E.flashComps([]); return; }
    V.focus([p.ref]);
    card.hidden = false; card.innerHTML = mode === 'train' ? `<b>${p.ref}</b> · ${partRu(p.part)}` : `${partRu(p.part)}<br><small>Определите по шелкографии, какой это компонент на схеме.</small>`;
    if (mode === 'train') { E.selectComp(p.ref); E.focusComps([p.ref]); E.flashComps([p.ref]); }
  }
  E.onSelect = (s) => {
    if (mode !== 'train' || !s || s.type !== 'comp') return;
    const c = E.compInfo(s.id); if (c && !c.power && V.has(s.id)) { V.focus([s.id], true); $('#card3d').hidden = false; $('#card3d').innerHTML = `<b>${s.id}</b> · ${partRu(V.partOf(s.id))}`; }
    else if (c && c.id === 'J2') { $('#card3d').hidden = false; $('#card3d').innerHTML = '<b>J2</b> · разъём 3,5 мм: 3D-модели нет, на плате видны только его площадки.'; }
  };
  E.onHover = (o, ev) => {
    const tip = $('#pinTip'); if (!o) { tip.hidden = true; return; }
    const r = $('#paneSch').getBoundingClientRect(); tip.hidden = false; tip.style.left = ev.clientX - r.left + 14 + 'px'; tip.style.top = ev.clientY - r.top + 14 + 'px';
    if (o.num !== undefined) tip.textContent = o.comp.power ? o.comp.val : `${o.comp.id} · вывод ${o.num}${o.name && o.name !== '~' && o.name !== o.num ? ' (' + o.name + ')' : ''}`;
    else tip.textContent = `${o.comp.id}${o.comp.power ? '' : ' · ' + o.comp.val}`;
  };

  /* ---------- разделитель ---------- */
  function bindSplit() {
    const g = $('#gutter'), s = $('#split'); let on = false;
    g.addEventListener('pointerdown', (e) => { on = true; g.setPointerCapture(e.pointerId); });
    g.addEventListener('pointermove', (e) => { if (!on) return; const r = s.getBoundingClientRect(); s.style.setProperty('--left', Math.max(25, Math.min(75, ((e.clientX - r.left) / r.width) * 100)) + '%'); V.resize(); });
    g.addEventListener('pointerup', () => { on = false; E.fit(); });
    g.addEventListener('keydown', (e) => { const cur = parseFloat(getComputedStyle(s).getPropertyValue('--left')) || 52; if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { s.style.setProperty('--left', cur + (e.key === 'ArrowLeft' ? -3 : 3) + '%'); V.resize(); } });
  }

  /* ---------- запуск ---------- */
  function boot() {
    E.init($('#schHost'));
    const restored = load(); status(); if (restored) { $('#timer').textContent = fmt(secs); toast('Восстановлена ваша прошлая сборка.'); }
    document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
    document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => E.setTool(b.dataset.tool)));
    $('#bRot').onclick = E.rotate; $('#bMir').onclick = E.mirror; $('#bDel').onclick = E.deleteSelected; $('#bUndo').onclick = E.undo; $('#bRedo').onclick = E.redo;
    $('#bGnd').onclick = () => E.addPower('GND'); $('#bBatt').onclick = () => E.addPower('+BATT'); $('#bFit').onclick = E.fit;
    $('#layoutSel').onchange = (e) => { if (e.target.value) E.layout(e.target.value); e.target.value = ''; };
    $('#ratsToggle').onchange = (e) => E.setRatsnest(e.target.checked);
    $('#btnCheck').onclick = check; $('#btnHint').onclick = hint;
    $('#btnReset').onclick = () => { if (confirm('Удалить все проведённые провода и начать заново?')) { E.reset(); secs = 0; hints = 0; checks = 0; timerOn = false; $('#timer').textContent = '00:00'; $('#results').hidden = true; save(); } };
    const help = $('#help'); $('#btnHelp').onclick = () => help.showModal();
    try { if (!localStorage.getItem(KEY + ':seen')) { help.showModal(); localStorage.setItem(KEY + ':seen', '1'); } } catch (e) { help.showModal(); }
    bind3D(); bindSplit(); E.fit();
    V.init($('#view3d'), $('#tags3d'), { onPick: onPick3D }).then(() => { $('#loading3d').remove(); }).catch((err) => { $('#loading3d').textContent = 'Не удалось загрузить 3D: ' + err.message; });
    window.addEventListener('resize', () => E.fit());
  }
  boot();
})();
