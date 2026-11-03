#!/usr/bin/env python3
"""Сверка эталонных цепей схемы с цепями, записанными в плате (.kicad_pcb). Использование: check_sch_vs_pcb.py out_sch.js board.kicad_pcb"""
import sys, json, re, sexpdata
from sexpdata import Symbol
N = lambda x: x.value() if isinstance(x, Symbol) else x
def find(n, k): return [c for c in n[1:] if isinstance(c, list) and N(c[0]) == k]
def f1(n, k):
    r = find(n, k); return r[0] if r else None
js = open(sys.argv[1], encoding='utf8').read(); data = json.loads(js[js.index('=', js.index('BOARD_DATA["')) + 1:].rstrip().rstrip(';'))
sch = {frozenset(n['pins']) for n in data['nets'] if len(n['pins']) > 1}
t = sexpdata.loads(open(sys.argv[2], encoding='utf8').read()); nets = {}; refs = set()
for fp in find(t, 'footprint'):
    ref = next((p[2] for p in find(fp, 'property') if p[1] == 'Reference'), '?'); refs.add(ref)
    for p in find(fp, 'pad'):
        n = f1(p, 'net')
        if n and len(n) > 1:
            name = n[2] if len(n) > 2 else n[1]
            if name: nets.setdefault(str(name), set()).add(f'{ref}.{p[1]}')
pcb = {frozenset(v) for v in nets.values() if len(v) > 1}
print('цепей в схеме:', len(sch), '| цепей на плате:', len(pcb))
print('совпадают' if sch == pcb else 'РАСХОЖДЕНИЕ')
for s in sch - pcb: print('  только в схеме:', sorted(s))
for s in pcb - sch: print('  только на плате:', sorted(s))
sr = {i['id'] for i in data['insts'] if not i['power']}
print('обозначения: схема-плата =', sorted(sr - refs), '| плата-схема =', sorted(refs - sr))
