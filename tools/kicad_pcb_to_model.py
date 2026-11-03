#!/usr/bin/env python3
"""Сборка 3D-модели платы по файлу KiCad (.kicad_pcb) для веб-симулятора.

Строит подложку (с отверстиями), медь, площадки, шелкографию (с обозначениями) и ставит 3D-модели
деталей (STEP из библиотеки KiCad, лежат в models_dir; если модели нет, строится простой параллелепипед).

Использование:
  python kicad_pcb_to_model.py board.kicad_pcb models_dir out.js board_id
"""
import sys, re, math, json, struct, gzip, base64, os
import numpy as np, sexpdata, trimesh
from sexpdata import Symbol
from shapely.geometry import Point, LineString, Polygon, MultiPolygon, box
from shapely.ops import unary_union, polygonize
from shapely import affinity
from matplotlib.textpath import TextPath
from matplotlib.font_manager import FontProperties

N = lambda x: x.value() if isinstance(x, Symbol) else x
def find(n, k): return [c for c in n[1:] if isinstance(c, list) and N(c[0]) == k]
def f1(n, k):
    r = find(n, k); return r[0] if r else None
def has_hide(n):
    for c in n[1:]:
        if isinstance(c, list):
            if N(c[0]) == 'hide' and (len(c) < 2 or N(c[1]) != 'no'): return True
            if N(c[0]) == 'effects' and has_hide(c): return True
        elif N(c) == 'hide': return True
    return False

BOARD_T = 1.6
COL = dict(pcb=(0.06, 0.30, 0.18), copper=(0.80, 0.50, 0.22), pad=(0.86, 0.86, 0.80), silk=(1, 1, 1))

# ------------------------------------------------------------------ разбор платы
def parse_pcb(path):
    t = sexpdata.loads(open(path, encoding='utf8').read())
    return t

def fp_xf(fp, lx, ly):
    th = math.radians(fp['rot']); x, y = lx, -ly
    return (fp['x'] + x * math.cos(th) - y * math.sin(th), -fp['y'] + x * math.sin(th) + y * math.cos(th))

def arc3(s, m, e, n=28):
    (x1, y1), (x2, y2), (x3, y3) = s, m, e
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-9: return [s, e]
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1, a2, a3 = (math.atan2(y - uy, x - ux) for y, x in ((y1, x1), (y2, x2), (y3, x3)))
    def ccw(a, b): return (b - a) % (2 * math.pi)
    if ccw(a1, a2) < ccw(a1, a3): span = ccw(a1, a3); sgn = 1          # дуга идёт против часовой
    else: span = ccw(a3, a1); sgn = -1
    return [(ux + r * math.cos(a1 + sgn * span * i / n), uy + r * math.sin(a1 + sgn * span * i / n)) for i in range(n + 1)]

def stroke_w(n, default=0.15):
    s = f1(n, 'stroke')
    if s and f1(s, 'width'): return float(f1(s, 'width')[1])
    if f1(n, 'width'): return float(f1(n, 'width')[1])
    return default

def graphic(n, kind, xf):
    """Возвращает shapely-геометрию линии/дуги/круга/прямоугольника/полигона в мировых координатах."""
    P = lambda node: xf(node[1], node[2])
    w = stroke_w(n); fill = f1(n, 'fill'); filled = bool(fill) and len(fill) > 1 and N(fill[1]) in ('yes', 'solid', 'filled')
    if kind in ('fp_line', 'gr_line'): return LineString([P(f1(n, 'start')), P(f1(n, 'end'))]).buffer(w / 2, 8)
    if kind in ('fp_arc', 'gr_arc'):
        s, m, e = f1(n, 'start'), f1(n, 'mid'), f1(n, 'end')
        if m is None: return None
        return LineString(arc3(P(s), P(m), P(e))).buffer(w / 2, 8)
    if kind in ('fp_circle', 'gr_circle'):
        c = P(f1(n, 'center')); e = P(f1(n, 'end')); r = math.hypot(e[0] - c[0], e[1] - c[1]); g = Point(c).buffer(r, 40)
        return g if filled else g.boundary.buffer(w / 2, 8)
    if kind in ('fp_rect', 'gr_rect'):
        a, b = P(f1(n, 'start')), P(f1(n, 'end'))
        poly = Polygon([a, (b[0], a[1]), b, (a[0], b[1])])
        return poly if filled else poly.boundary.buffer(w / 2, 8)
    if kind in ('fp_poly', 'gr_poly'):
        pts = [xf(c[1], c[2]) for c in find(f1(n, 'pts'), 'xy')]
        if len(pts) < 3: return None
        poly = Polygon(pts); return poly if filled else poly.boundary.buffer(w / 2, 8)
    return None

_font = FontProperties(family='DejaVu Sans', weight='bold')
def text_geom(s, size, just, angle, mirror, pos):
    s = ''.join(ch if (32 <= ord(ch) < 127 or ch in 'ЁёА-Яа-я°±µΩ') else ' ' for ch in s)
    if not s.strip(): return None
    tp = TextPath((0, 0), s, size=size * 1.08, prop=_font)
    g = None
    for p in tp.to_polygons():
        if len(p) < 3: continue
        pg = Polygon(p).buffer(0)
        g = pg if g is None else g.symmetric_difference(pg)
    if g is None or g.is_empty: return None
    minx, miny, maxx, maxy = g.bounds; cap = size * 1.08 * 0.729
    dx = -(minx + maxx) / 2; dy = -cap / 2
    if 'left' in just: dx = -minx
    if 'right' in just: dx = -maxx
    if 'top' in just: dy = -cap
    if 'bottom' in just: dy = 0
    g = affinity.translate(g, dx, dy)
    if mirror: g = affinity.scale(g, -1, 1, origin=(0, 0))
    g = affinity.rotate(g, angle, origin=(0, 0)); return affinity.translate(g, pos[0], pos[1])

def justify_of(n):
    e = f1(n, 'effects'); j = f1(e, 'justify') if e else None
    return [N(x) for x in j[1:]] if j else []
def size_of(n):
    e = f1(n, 'effects'); f = f1(e, 'font') if e else None
    s = f1(f, 'size') if f else None
    return float(s[1]) if s else 1.0

def pad_geom(p, cx, cy, ang):
    sz = f1(p, 'size'); w, h = float(sz[1]), float(sz[2]); shape = N(p[3])
    if shape == 'circle': g = Point(0, 0).buffer(w / 2, 28)
    elif shape == 'oval':
        if w >= h: g = LineString([(-(w - h) / 2, 0), ((w - h) / 2, 0)]).buffer(h / 2, 20)
        else: g = LineString([(0, -(h - w) / 2), (0, (h - w) / 2)]).buffer(w / 2, 20)
    elif shape == 'roundrect':
        rr = f1(p, 'roundrect_rratio'); r = (float(rr[1]) if rr else 0.25) * min(w, h)
        g = box(-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r).buffer(r, 8) if r > 0 else box(-w / 2, -h / 2, w / 2, h / 2)
    else: g = box(-w / 2, -h / 2, w / 2, h / 2)
    g = affinity.rotate(g, ang, origin=(0, 0)); return affinity.translate(g, cx, cy)

def drill_geom(p, cx, cy, ang):
    d = f1(p, 'drill')
    if not d: return None
    vals = [x for x in d[1:] if not isinstance(x, list)]
    if not vals: return None
    if N(vals[0]) == 'oval':
        w, h = float(vals[1]), float(vals[2])
        g = LineString([(-(w - h) / 2, 0), ((w - h) / 2, 0)]).buffer(h / 2, 16) if w >= h else LineString([(0, -(h - w) / 2), (0, (h - w) / 2)]).buffer(w / 2, 16)
        g = affinity.rotate(g, ang, origin=(0, 0))
    else:
        dd = float(vals[0]); g = Point(0, 0).buffer(dd / 2, 20)
    off = f1(d, 'offset')
    if off: g = affinity.translate(g, float(off[1]), -float(off[2]))
    return affinity.translate(g, cx, cy)

def read_board(t):
    B = dict(fps=[], segs=[], vias=[], zones=[], edge=[], silk=[], gtexts=[])
    for n in find(t, 'footprint'):
        at = f1(n, 'at'); fp = dict(name=n[1], x=float(at[1]), y=float(at[2]), rot=float(at[3]) if len(at) > 3 else 0.0, layer=N(f1(n, 'layer')[1]), node=n, models=[], pads=[], ref='', val='')
        for pr in find(n, 'property'):
            if pr[1] == 'Reference': fp['ref'] = pr[2]
            if pr[1] == 'Value': fp['val'] = pr[2]
        for tx in find(n, 'fp_text'):
            if N(tx[1]) == 'reference' and not fp['ref']: fp['ref'] = tx[2]
        for m in find(n, 'model'):
            o, s, r = f1(m, 'offset'), f1(m, 'scale'), f1(m, 'rotate')
            g = lambda node, d: [float(x) for x in node[1][1:4]] if node else d
            fp['models'].append(dict(path=m[1], off=g(o, [0, 0, 0]), scale=g(s, [1, 1, 1]), rot=g(r, [0, 0, 0])))
        for p in find(n, 'pad'):
            pa = f1(p, 'at'); lx, ly = float(pa[1]), float(pa[2]); ang = float(pa[3]) if len(pa) > 3 else 0.0
            cx, cy = fp_xf(fp, lx, ly)
            layers = [N(x) for x in (f1(p, 'layers') or [0])[1:]]
            fp['pads'].append(dict(node=p, c=(cx, cy), ang=ang, type=N(p[2]), layers=layers, local=(lx, ly)))
        B['fps'].append(fp)
    for s in find(t, 'segment'):
        B['segs'].append((LineString([(float(f1(s, 'start')[1]), -float(f1(s, 'start')[2])), (float(f1(s, 'end')[1]), -float(f1(s, 'end')[2]))]).buffer(float(f1(s, 'width')[1]) / 2, 8), N(f1(s, 'layer')[1])))
    for s in find(t, 'arc'):
        pts = lambda k: (float(f1(s, k)[1]), -float(f1(s, k)[2]))
        B['segs'].append((LineString(arc3(pts('start'), pts('mid'), pts('end'))).buffer(float(f1(s, 'width')[1]) / 2, 8), N(f1(s, 'layer')[1])))
    for v in find(t, 'via'):
        at = f1(v, 'at'); layers = [N(x) for x in f1(v, 'layers')[1:]]
        B['vias'].append(dict(c=(float(at[1]), -float(at[2])), size=float(f1(v, 'size')[1]), drill=float(f1(v, 'drill')[1])))
    for z in find(t, 'zone'):
        for fpoly in find(z, 'filled_polygon'):
            pts = [(float(c[1]), -float(c[2])) for c in find(f1(fpoly, 'pts'), 'xy')]
            if len(pts) >= 3: B['zones'].append((Polygon(pts).buffer(0), N(f1(fpoly, 'layer')[1])))
    P0 = lambda x, y: (float(x), -float(y))
    for kind in ('gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly'):
        for n in find(t, kind):
            L = N(f1(n, 'layer')[1])
            if L == 'Edge.Cuts': B['edge'].append((kind, n, P0))
            elif L in ('F.SilkS', 'B.SilkS'):
                g = graphic(n, kind, P0)
                if g is not None: B['silk'].append((g, L))
    for n in find(t, 'gr_text'):
        L = N(f1(n, 'layer')[1])
        if L in ('F.SilkS', 'B.SilkS'): B['gtexts'].append(n)
    return B

def board_outline(B):
    polys, lines = [], []
    def add(kind, n, xf):
        if kind in ('gr_circle', 'gr_rect', 'gr_poly', 'fp_circle', 'fp_rect', 'fp_poly'):
            g = graphic(n, kind, xf)
            if g is not None:
                # контур хранится как «линия» — нужна исходная область
                if kind.endswith('circle'):
                    c = xf(f1(n, 'center')[1], f1(n, 'center')[2]); e = xf(f1(n, 'end')[1], f1(n, 'end')[2]); polys.append(Point(c).buffer(math.hypot(e[0] - c[0], e[1] - c[1]), 60))
                elif kind.endswith('rect'):
                    a, b = xf(f1(n, 'start')[1], f1(n, 'start')[2]), xf(f1(n, 'end')[1], f1(n, 'end')[2]); polys.append(Polygon([a, (b[0], a[1]), b, (a[0], b[1])]))
                else: polys.append(Polygon([xf(c[1], c[2]) for c in find(f1(n, 'pts'), 'xy')]))
        elif kind in ('gr_line', 'fp_line'): lines.append(LineString([xf(f1(n, 'start')[1], f1(n, 'start')[2]), xf(f1(n, 'end')[1], f1(n, 'end')[2])]))
        elif kind in ('gr_arc', 'fp_arc'):
            s, m, e = (xf(f1(n, k)[1], f1(n, k)[2]) for k in ('start', 'mid', 'end')); lines.append(LineString(arc3(s, m, e)))
    for kind, n, xf in B['edge']: add(kind, n, xf)
    for fp in B['fps']:
        for kind in ('fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly'):
            for n in find(fp['node'], kind):
                if N(f1(n, 'layer')[1]) == 'Edge.Cuts': add(kind, n, lambda x, y, fp=fp: fp_xf(fp, float(x), float(y)))
    if lines:
        merged = unary_union(lines)
        polys += [p for p in polygonize(merged)]
    if not polys:
        xs = [p['c'] for fp in B['fps'] for p in fp['pads']]
        return box(min(x for x, _ in xs) - 3, min(y for _, y in xs) - 3, max(x for x, _ in xs) + 3, max(y for _, y in xs) + 3)
    polys.sort(key=lambda p: -p.area); out = polys[0]
    for p in polys[1:]:
        if out.contains(p): out = out.difference(p)
    return out

# ------------------------------------------------------------------ геометрия слоёв
def mesh_of(geom, z0, z1, color):
    geoms = [geom] if isinstance(geom, Polygon) else list(getattr(geom, 'geoms', []))
    ms = []
    for g in geoms:
        if not isinstance(g, Polygon) or g.is_empty or g.area < 1e-6: continue
        g = g.simplify(0.005)
        try:
            m = trimesh.creation.extrude_polygon(g, z1 - z0); m.apply_translation([0, 0, z0]); ms.append(m)
        except Exception as e: print('  mesh skip', e)
    if not ms: return None
    m = trimesh.util.concatenate(ms)
    V = np.array(m.vertices, np.float32)[np.array(m.faces).reshape(-1)]          # «суп из треугольников»: плоское затенение без полос
    return dict(P=V, I=np.arange(len(V), dtype=np.uint32).reshape(-1, 3), C=np.tile((np.array(color) * 255).astype(np.uint8), (len(V), 1)))

def build_layers(B):
    outline = board_outline(B)
    drills, pads = [], {'F': [], 'B': []}
    for fp in B['fps']:
        for p in fp['pads']:
            d = drill_geom(p['node'], p['c'][0], p['c'][1], p['ang'])
            if d is not None: drills.append(d)
            if p['type'] == 'np_thru_hole': continue
            g = pad_geom(p['node'], p['c'][0], p['c'][1], p['ang'])
            if any(l in ('*.Cu', 'F.Cu') for l in p['layers']): pads['F'].append(g)
            if any(l in ('*.Cu', 'B.Cu') for l in p['layers']): pads['B'].append(g)
    for v in B['vias']:
        drills.append(Point(v['c']).buffer(v['drill'] / 2, 16)); g = Point(v['c']).buffer(v['size'] / 2, 20); pads['F'].append(g); pads['B'].append(g)
    D = unary_union(drills) if drills else None
    board = outline.difference(D) if D is not None else outline
    out = {}
    out['PCB'] = mesh_of(board, 0, BOARD_T, COL['pcb'])
    for side, sign in (('F', 1), ('B', -1)):
        L = side + '.Cu'; padU = unary_union(pads[side]) if pads[side] else None
        cu = [g for g, l in B['segs'] if l == L] + [g for g, l in B['zones'] if l == L]
        cuU = unary_union(cu) if cu else None
        if cuU is not None:
            if padU is not None: cuU = cuU.difference(padU)
            if D is not None: cuU = cuU.difference(D)
            cuU = cuU.intersection(outline)
        z = (BOARD_T, BOARD_T + 0.03) if sign > 0 else (-0.03, 0)
        zp = (BOARD_T, BOARD_T + 0.04) if sign > 0 else (-0.04, 0)
        zs = (BOARD_T + 0.04, BOARD_T + 0.05) if sign > 0 else (-0.05, -0.04)
        if cuU is not None and not cuU.is_empty: out['copper_' + side] = mesh_of(cuU, *z, COL['copper'])
        if padU is not None:
            pp = padU.difference(D) if D is not None else padU
            out['pad_' + side] = mesh_of(pp, *zp, COL['pad'])
        # шелкография
        silk = [g for g, l in B['silk'] if l == side + '.SilkS']; texts = []
        for fp in B['fps']:
            if fp['layer'] != side + '.Cu' and False: continue
            for kind in ('fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly'):
                for n in find(fp['node'], kind):
                    if N(f1(n, 'layer')[1]) == side + '.SilkS':
                        g = graphic(n, kind, lambda x, y, fp=fp: fp_xf(fp, float(x), float(y)))
                        if g is not None: silk.append(g)
            txs = [(pr, 'property') for pr in find(fp['node'], 'property') if pr[1] in ('Reference', 'Value')] + [(tx, 'fp_text') for tx in find(fp['node'], 'fp_text')]
            for tx, kind in txs:
                lay = f1(tx, 'layer')
                if not lay or N(lay[1]) != side + '.SilkS' or has_hide(tx): continue
                s = tx[2] if kind == 'property' else tx[2]
                if kind == 'fp_text' and N(tx[1]) in ('reference', 'value'): s = tx[2]
                s = str(s).replace('${REFERENCE}', fp['ref']).replace('${VALUE}', fp['val']).replace('%R', fp['ref']).replace('%V', fp['val'])
                at = f1(tx, 'at'); lx, ly = float(at[1]), float(at[2]); ang = float(at[3]) if len(at) > 3 else 0.0
                j = justify_of(tx); tg = text_geom(s, size_of(tx), j, ang, 'mirror' in j or side == 'B', fp_xf(fp, lx, ly))
                if tg is not None: texts.append(tg)
        for n in B['gtexts']:
            if N(f1(n, 'layer')[1]) != side + '.SilkS': continue
            at = f1(n, 'at'); j = justify_of(n)
            tg = text_geom(str(n[1]), size_of(n), j, float(at[3]) if len(at) > 3 else 0.0, 'mirror' in j or side == 'B', (float(at[1]), -float(at[2])))
            if tg is not None: texts.append(tg)
        allsilk = unary_union(silk + texts) if (silk or texts) else None
        if allsilk is not None:
            if padU is not None: allsilk = allsilk.difference(padU.buffer(0.2))
            if D is not None: allsilk = allsilk.difference(D.buffer(0.3))
            allsilk = allsilk.intersection(outline.buffer(-0.1))
            if not allsilk.is_empty: out['silk_' + side] = mesh_of(allsilk, *zs, COL['silk'])
    bounds = outline.bounds
    return out, bounds

# ------------------------------------------------------------------ 3D-модели деталей (STEP)
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.TDF import TDF_Label
from OCP.collections import Sequence_TDF_Label as Seq
from OCP.Quantity import Quantity_Color
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopoDS import TopoDS
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location

def load_step(path):
    app = XCAFApp_Application.GetApplication_s(); doc = TDocStd_Document(TCollection_ExtendedString('XmlOcaf')); app.NewDocument(TCollection_ExtendedString('MDTV-XCAF'), doc)
    r = STEPCAFControl_Reader(); r.SetColorMode(True); r.SetNameMode(True); r.ReadFile(path); r.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()); ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    def col(s):
        c = Quantity_Color(); return (c.Red(), c.Green(), c.Blue()) if ct.GetColor(s, XCAFDoc_ColorType.XCAFDoc_ColorSurf, c) else None
    def mat(loc):
        t = loc.Transformation(); return np.vstack([[[t.Value(r_, c_) for c_ in range(1, 5)] for r_ in (1, 2, 3)], [0, 0, 0, 1]])
    P, I, C = [], [], []; off = [0]
    def leaf(l, M):
        sh = st.GetShape_s(l); BRepMesh_IncrementalMesh(sh, 0.04, False, 0.4, True)
        default = col(sh) or (0.5, 0.5, 0.52); e = TopExp_Explorer(sh, TopAbs_FACE)
        while e.More():
            f = TopoDS.Face(e.Current()); loc = TopLoc_Location(); tri = BRep_Tool.Triangulation_s(f, loc)
            if tri is not None:
                tr = loc.Transformation(); c = col(e.Current()) or default; n = tri.NbNodes()
                for i in range(1, n + 1):
                    p = tri.Node(i).Transformed(tr); v = M @ np.array([p.X(), p.Y(), p.Z(), 1.0]); P.append(v[:3]); C.append(c)
                rev = f.Orientation() == TopAbs_REVERSED
                for i in range(1, tri.NbTriangles() + 1):
                    a, b, c2 = tri.Triangle(i).Get(); a += off[0] - 1; b += off[0] - 1; c2 += off[0] - 1; I.append((a, c2, b) if rev else (a, b, c2))
                off[0] += n
            e.Next()
    def walk(l, M):
        ref = TDF_Label()
        if st.GetReferredShape_s(l, ref): return walk(ref, M @ mat(st.GetLocation_s(l)))
        if st.IsAssembly_s(l):
            cs = Seq(); st.GetComponents_s(l, cs)
            for i in range(1, cs.Length() + 1): walk(cs.Value(i), M)
        else: leaf(l, M)
    fr = Seq(); st.GetFreeShapes(fr)
    for i in range(1, fr.Length() + 1): walk(fr.Value(i), np.eye(4))
    if not P: return None
    return dict(P=np.array(P, np.float32), I=np.array(I, np.uint32), C=(np.array(C) * 255).round().astype(np.uint8))

def box_part(w, d, h, color=(0.55, 0.55, 0.58)):
    m = trimesh.creation.box(extents=(w, d, h)); m.apply_translation([0, 0, h / 2])
    return dict(P=np.array(m.vertices, np.float32), I=np.array(m.faces, np.uint32), C=np.tile((np.array(color) * 255).astype(np.uint8), (len(m.vertices), 1)))

def rotmat(rx, ry, rz):
    def R(axis, a):
        a = math.radians(a); c, s = math.cos(a), math.sin(a); M = np.eye(4)
        if axis == 'x': M[1, 1], M[1, 2], M[2, 1], M[2, 2] = c, -s, s, c
        if axis == 'y': M[0, 0], M[0, 2], M[2, 0], M[2, 2] = c, s, -s, c
        if axis == 'z': M[0, 0], M[0, 1], M[1, 0], M[1, 1] = c, -s, s, c
        return M
    return R('z', rz) @ R('y', ry) @ R('x', rx)

def main():
    pcb, models_dir, out_js, board_id = sys.argv[1:5]
    t = parse_pcb(pcb); B = read_board(t); print('footprints:', len(B['fps']))
    layers, bounds = build_layers(B)
    parts = {}; insts = []
    names = dict(PCB='board_PCB', copper_F='board_copper', pad_F='board_pad', silk_F='board_silkscreen')
    def merge(keys, name, kind):
        ms = [layers[k] for k in keys if k in layers and layers[k] is not None]
        if not ms: return
        off, P, I, C = 0, [], [], []
        for m in ms: P.append(m['P']); I.append(m['I'] + off); C.append(m['C']); off += len(m['P'])
        parts[name] = dict(kind=kind, P=np.vstack(P), I=np.vstack(I).astype(np.uint32), C=np.vstack(C))
        insts.append(dict(ref=name, part=name, m=np.eye(4).flatten().tolist()))
    merge(['PCB'], 'board_PCB', 'PCB'); merge(['copper_F', 'copper_B'], 'board_copper', 'copper'); merge(['pad_F', 'pad_B'], 'board_pad', 'pad'); merge(['silk_F', 'silk_B'], 'board_silkscreen', 'silkscreen')
    cache = {}
    for fp in B['fps']:
        if not fp['ref'] or fp['ref'].startswith('#'): continue
        placed = False
        for m in fp['models']:
            rel = re.sub(r'^\$\{[^}]+\}/', '', m['path']); local = os.path.join(models_dir, rel.replace('/', '__'))
            if rel not in cache:
                cache[rel] = load_step(local) if os.path.exists(local) else None
                print(' model', rel.split('/')[-1][:60], 'OK' if cache[rel] else 'MISSING')
            part = cache[rel]
            if part is None: continue
            key = os.path.splitext(rel.split('/')[-1])[0]
            parts[key] = dict(kind='comp', **part)
            th = math.radians(fp['rot']); Mfp = np.eye(4); Mfp[:3, :3] = rotmat(0, 0, fp['rot'])[:3, :3]; Mfp[0, 3], Mfp[1, 3] = fp['x'], -fp['y']
            if fp['layer'] == 'B.Cu': Mfp = Mfp @ np.diag([1, -1, -1, 1])
            Mm = np.eye(4); Mm[:3, :3] = rotmat(*m['rot'])[:3, :3] @ np.diag(m['scale']); Mm[:3, 3] = m['off']
            insts.append(dict(ref=fp['ref'], part=key, m=(Mfp @ Mm).flatten().tolist())); placed = True
        if not placed:   # запасной вариант: параллелепипед по площадкам
            pts = [p['c'] for p in fp['pads']]
            if not pts: continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            w, d = max(max(xs) - min(xs) + 2, 3), max(max(ys) - min(ys) + 2, 3); h = 8.0
            mm = re.search(r'(\d+\.?\d*)x(\d+\.?\d*)mm_H(\d+\.?\d*)mm', fp['name'])
            if mm: w, d, h = float(mm.group(1)), float(mm.group(2)), min(float(mm.group(3)), 30)
            key = 'box_' + re.sub(r'\W', '_', fp['name'])[:40]
            parts[key] = dict(kind='comp', **box_part(w, d, h)); M = np.eye(4); M[0, 3], M[1, 3] = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
            insts.append(dict(ref=fp['ref'], part=key, m=M.flatten().tolist())); print(' fallback box for', fp['ref'], fp['name'])
    # упаковка (тот же формат, что у viewer3d.js)
    blob = bytearray(); pm = {}
    for k, p in parts.items():
        pm[k] = dict(kind=p['kind'], nv=len(p['P']), ni=len(p['I']), off=len(blob))
        blob += p['P'].astype(np.float32).tobytes(); blob += p['C'].tobytes(); blob += b'\0' * ((-len(blob)) % 4)
        pm[k]['ioff'] = len(blob); blob += p['I'].astype(np.uint32).tobytes()
    mj = json.dumps(dict(parts=pm, insts=insts)).encode()
    gz = gzip.compress(struct.pack('<I', len(mj)) + mj + bytes(blob), 9)
    open(out_js, 'w').write('window.BOARD_MODELS=window.BOARD_MODELS||{};window.BOARD_MODELS["%s"]="%s";\n' % (board_id, base64.b64encode(gz).decode()))
    print('wrote', out_js, len(gz) // 1024, 'KB; refs:', sorted({i['ref'] for i in insts if not i['ref'].startswith('board_')}))
main()
