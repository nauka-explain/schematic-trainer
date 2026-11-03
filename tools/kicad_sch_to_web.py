#!/usr/bin/env python3
"""Разбор схемы KiCad (.kicad_sch, KiCad 6–10, один лист) в данные для веб-симулятора.

Получает символы, провода, узлы, эталонный список цепей (по проводам, силовым символам и сетевым меткам).
Использование: python kicad_sch_to_web.py board.kicad_sch out.js board_id "Название" "Подзаголовок" уровень
"""
import sys, json, math, itertools, re
import sexpdata
from sexpdata import Symbol

N = lambda x: x.value() if isinstance(x, Symbol) else x
def find(n, k): return [c for c in n[1:] if isinstance(c, list) and N(c[0]) == k]
def f1(n, k):
    r = find(n, k); return r[0] if r else None
def yes(n, k):
    x = f1(n, k); return bool(x) and (len(x) < 2 or N(x[1]) in ('yes', True))

def arc_path(s, m, e):
    (x1, y1), (x2, y2), (x3, y3) = s, m, e
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-9: return f'M{x1} {y1} L{x3} {y3}'
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2); sweep = 1 if cross > 0 else 0
    a1, a3 = math.atan2(y1 - uy, x1 - ux), math.atan2(y3 - uy, x3 - ux)
    norm = lambda a: a % (2 * math.pi)
    span = norm(a3 - a1) if sweep else norm(a1 - a3)
    return f'M{x1:.3f} {y1:.3f} A{r:.3f} {r:.3f} 0 {1 if span > math.pi else 0} {sweep} {x3:.3f} {y3:.3f}'

def fill_of(c):
    f = f1(c, 'fill'); t = f1(f, 'type') if f else None
    return N(t[1]) if t else 'none'

def read_libs(t):
    libs = {}
    for ls in find(f1(t, 'lib_symbols'), 'symbol'):
        g, pins, units = [], [], set()
        def walk(n):
            for c in n[2:]:
                if not isinstance(c, list): continue
                k = N(c[0])
                if k == 'symbol':
                    m = re.search(r'_(\d+)_(\d+)$', str(c[1]))
                    if m and int(m.group(1)) > 1: units.add(int(m.group(1)))
                    walk(c)
                elif k == 'polyline':
                    p = [(q[1], -q[2]) for q in find(f1(c, 'pts'), 'xy')]; g.append(dict(t='path', d='M' + ' L'.join(f'{x:.3f} {y:.3f}' for x, y in p), fill=fill_of(c)))
                elif k == 'rectangle':
                    a, b = f1(c, 'start'), f1(c, 'end'); x1, y1, x2, y2 = a[1], -a[2], b[1], -b[2]
                    g.append(dict(t='path', d=f'M{x1} {y1} L{x2} {y1} L{x2} {y2} L{x1} {y2} Z', fill=fill_of(c)))
                elif k == 'circle':
                    ce = f1(c, 'center'); g.append(dict(t='circle', cx=ce[1], cy=-ce[2], r=f1(c, 'radius')[1], fill=fill_of(c)))
                elif k == 'arc':
                    s, m, e = f1(c, 'start'), f1(c, 'mid'), f1(c, 'end'); g.append(dict(t='path', d=arc_path((s[1], -s[2]), (m[1], -m[2]), (e[1], -e[2])), fill=fill_of(c)))
                elif k == 'pin':
                    at, nm, nu = f1(c, 'at'), f1(c, 'name'), f1(c, 'number')
                    pins.append(dict(n=nm[1], u=str(nu[1]), x=at[1], y=-at[2], r=at[3], l=f1(c, 'length')[1]))
        walk(ls)
        if units: raise SystemExit(f'Символ {ls[1]} состоит из нескольких частей (units): такие символы не поддерживаются.')
        pn = f1(ls, 'pin_names'); pu = f1(ls, 'pin_numbers')
        libs[ls[1]] = dict(g=g, pins=pins, power=f1(ls, 'power') is not None, hn=bool(pn and yes(pn, 'hide')) or bool(pn and any(N(x) == 'hide' for x in pn[1:])), hu=bool(pu and yes(pu, 'hide')) or bool(pu and any(N(x) == 'hide' for x in pu[1:])))
    return libs

def tf(px, py, rot, mir):
    if mir == 'x': py = -py
    if mir == 'y': px = -px
    a = math.radians(rot); c, s = round(math.cos(a), 6), round(math.sin(a), 6)
    return (px * c + py * s, -px * s + py * c)

# ---- русские названия типов (для панели компонентов)
def ru_title(lib, ref, val):
    l = lib.lower(); p = re.search(r'[A-Za-z]+', ref).group(0).upper(); v = str(val)
    if p == 'RV' or 'potentiometer' in l or 'trimmer' in l: return 'Переменный резистор'
    if p == 'R': return 'Резистор'
    if p == 'C':
        return 'Конденсатор электролитический' if ('polarized' in l or l.endswith(':cp') or 'cp_' in l) else 'Конденсатор'
    if p == 'D':
        return 'Светодиод' if 'led' in l else ('Стабилитрон' if 'zener' in l else 'Диод ' + v)
    if p == 'Q': return 'Транзистор ' + v
    if p == 'U': return ('Стабилизатор ' if 'regulator' in l else 'Микросхема ') + v
    if p in ('J', 'P', 'X'): return 'Клеммник' if ('screw' in l or 'terminal' in l) else 'Разъём ' + v
    if p == 'T': return 'Трансформатор'
    if p == 'F': return 'Предохранитель'
    if p in ('SW', 'S'): return 'Переключатель'
    if p == 'L': return 'Катушка / дроссель'
    if p == 'BZ' or p == 'LS': return 'Зуммер / динамик'
    if p == 'Y': return 'Кварцевый резонатор'
    if p == 'K': return 'Реле'
    return f'Компонент {p}'
ORDER = ['R', 'RV', 'C', 'D', 'Q', 'U', 'T', 'F', 'L', 'SW', 'S', 'J', 'P', 'K', 'Y', 'BZ']

def build(path, bid, title, subtitle, level):
    t = sexpdata.loads(open(path, encoding='utf8').read())
    if find(t, 'sheet'): raise SystemExit('В схеме есть вложенные листы: нужен один плоский лист.')
    libs = read_libs(t); insts = []
    for s in find(t, 'symbol'):
        lid = f1(s, 'lib_id')[1]; at = f1(s, 'at'); mir = f1(s, 'mirror'); props = {p[1]: p[2] for p in find(s, 'property')}
        if props.get('Reference', '').startswith('#FLG') or props.get('Value') == 'PWR_FLAG': continue
        if yes(s, 'in_bom') is False and False: pass
        insts.append(dict(lib=lid, x=at[1], y=at[2], rot=at[3] if len(at) > 3 else 0, mir=N(mir[1]) if mir else None, ref=props['Reference'], val=props['Value'], fp=props.get('Footprint', '')))
    wires = [[(round(c[1], 3), round(c[2], 3)) for c in find(f1(w, 'pts'), 'xy')] for w in find(t, 'wire')]
    juncs = [(round(f1(j, 'at')[1], 3), round(f1(j, 'at')[2], 3)) for j in find(t, 'junction')]
    labels = [(l[1], (round(f1(l, 'at')[1], 3), round(f1(l, 'at')[2], 3))) for k in ('label', 'global_label', 'hierarchical_label') for l in find(t, k)]
    # ---- связность
    par = {}
    def F(a):
        par.setdefault(a, a)
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    def U(a, b): par[F(a)] = F(b)
    def onseg(p, a, b, eps=0.01):
        if abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) > eps * max(1, math.hypot(b[0] - a[0], b[1] - a[1])): return False
        return min(a[0], b[0]) - eps <= p[0] <= max(a[0], b[0]) + eps and min(a[1], b[1]) - eps <= p[1] <= max(a[1], b[1]) + eps
    segs = [(wi, a, b) for wi, w in enumerate(wires) for a, b in zip(w, w[1:])]
    for wi in range(len(wires)): F(('w', wi))
    for (w1, a1, b1), (w2, a2, b2) in itertools.combinations(segs, 2):
        if w1 == w2: continue
        if any(onseg(p, a2, b2) for p in (a1, b1)) or any(onseg(p, a1, b1) for p in (a2, b2)): U(('w', w1), ('w', w2))
        for j in juncs:
            if onseg(j, a1, b1) and onseg(j, a2, b2): U(('w', w1), ('w', w2))
    pinnodes = []
    for i in insts:
        pw = libs[i['lib']]['power']
        for p in libs[i['lib']]['pins']:
            dx, dy = tf(p['x'], p['y'], i['rot'], i['mir']); pos = (round(i['x'] + dx, 3), round(i['y'] + dy, 3))
            pid = ('pw', i['ref']) if pw else ('p', i['ref'], p['u']); F(pid); pinnodes.append((i, p, pos, pid))
    close = lambda p, q: abs(p[0] - q[0]) < 0.01 and abs(p[1] - q[1]) < 0.01
    for i, p, pos, pid in pinnodes:
        for wi, a, b in segs:
            if onseg(pos, a, b): U(pid, ('w', wi))
        for j, q, pos2, pid2 in pinnodes:
            if pid2 != pid and close(pos, pos2): U(pid, pid2)
    for k, (name, pos) in enumerate(labels):                      # сетевые метки: на проводе/выводе, одноимённые объединяются
        node = ('lab', k); F(node); U(node, ('net', name))
        for wi, a, b in segs:
            if onseg(pos, a, b): U(node, ('w', wi))
        for i, p, ppos, pid in pinnodes:
            if close(pos, ppos): U(node, pid)
    for i in insts:
        if libs[i['lib']]['power']: U(('pw', i['ref']), ('net', i['val']))
    nets = {}
    for i, p, pos, pid in pinnodes:
        if libs[i['lib']]['power']: continue
        nets.setdefault(F(pid), []).append(f"{i['ref']}.{p['u']}")
    named = {}
    for n in list(par):
        if isinstance(n, tuple) and n[0] == 'net': named[F(n)] = n[1]
    out = [dict(name=named.get(r), pins=sorted(p, key=lambda s: (re.sub(r'\d+', '', s.split('.')[0]), int(re.sub(r'\D', '', s.split('.')[0]) or 0), s))) for r, p in nets.items()]
    ridx = {r: k for k, r in enumerate(nets)}
    out_sorted = sorted(range(len(out)), key=lambda k: (out[k]['name'] is None, -len(out[k]['pins'])))
    rank = {k: n for n, k in enumerate(out_sorted)}; netlist = [out[k] for k in out_sorted]
    wout = [dict(p=w, n=rank[ridx[F(('w', wi))]] if F(('w', wi)) in ridx else -1) for wi, w in enumerate(wires)]
    # ---- данные для сайта
    used = {i['lib'] for i in insts}; L = {}
    first = {}
    for i in insts: first.setdefault(i['lib'], i)
    for k in used:
        d = libs[k]; fi = first[k]
        L[k] = dict(g=d['g'], pins=d['pins'], power=d['power'], hn=d['hn'], hu=d['hu'])
        if not d['power']:
            pre = re.search(r'[A-Za-z]+', fi['ref']).group(0).upper()
            L[k]['title'] = ru_title(k, fi['ref'], fi['val']); L[k]['order'] = ORDER.index(pre) if pre in ORDER else 99
    ilist = [dict(id=i['ref'], lib=i['lib'], x=i['x'], y=i['y'], rot=i['rot'], mir=i['mir'], val=i['val'], fp=i['fp'], power=libs[i['lib']]['power']) for i in insts]
    powers = []
    for i in insts:
        if libs[i['lib']]['power'] and i['val'] not in [p['name'] for p in powers]: powers.append(dict(name=i['val'], lib=i['lib']))
    must = sorted({p for n in netlist if len(n['pins']) > 1 for p in n['pins']})
    data = dict(id=bid, title=title, libs=L, insts=ilist, nets=netlist, wires=wout, juncs=juncs, powers=powers)
    return data, dict(id=bid, title=title, subtitle=subtitle, level=level, parts=len([i for i in ilist if not i['power']]), nets=len([n for n in netlist if len(n['pins']) > 1]), pins=len(must))

if __name__ == '__main__':
    path, out_js, bid, title, subtitle, level = sys.argv[1:7]
    data, info = build(path, bid, title, subtitle, int(level))
    open(out_js, 'w').write('window.BOARD_DATA=window.BOARD_DATA||{};window.BOARD_DATA["%s"]=%s;\n' % (bid, json.dumps(data, separators=(',', ':'), ensure_ascii=False)))
    json.dump(info, open(out_js + '.info.json', 'w'), ensure_ascii=False)
    print(info); [print(' ', n['name'] or '-', n['pins']) for n in data['nets']]
