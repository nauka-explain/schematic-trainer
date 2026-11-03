# Использование: python kicad_sch_to_json.py board.kicad_sch sch.json  (затем см. README: сборка sch_data.js)
import sexpdata, json, math, itertools, sys
from sexpdata import Symbol
t = sexpdata.loads(open(sys.argv[1],encoding='utf8').read())
N=lambda x: x.value() if isinstance(x,Symbol) else x
def find(n,k): return [c for c in n[1:] if isinstance(c,list) and N(c[0])==k]
def f1(n,k):
    r=find(n,k); return r[0] if r else None
def yes(n,k):
    x=f1(n,k); return bool(x) and (len(x)<2 or N(x[1])=='yes')
# ---- lib symbols graphics
def arc_path(s,m,e):
    (x1,y1),(x2,y2),(x3,y3)=s,m,e
    d=2*(x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2))
    if abs(d)<1e-9: return f'M{x1} {y1} L{x3} {y3}'
    ux=((x1**2+y1**2)*(y2-y3)+(x2**2+y2**2)*(y3-y1)+(x3**2+y3**2)*(y1-y2))/d
    uy=((x1**2+y1**2)*(x3-x2)+(x2**2+y2**2)*(x1-x3)+(x3**2+y3**2)*(x2-x1))/d
    r=math.hypot(x1-ux,y1-uy)
    cross=(x2-x1)*(y3-y2)-(y2-y1)*(x3-x2)   # in already-flipped (y down) coords
    sweep=1 if cross>0 else 0
    # large arc if mid and chord relationship
    a1=math.atan2(y1-uy,x1-ux);a3=math.atan2(y3-uy,x3-ux);am=math.atan2(y2-uy,x2-ux)
    def norm(a): return a%(2*math.pi)
    if sweep==1: span=norm(a3-a1); midspan=norm(am-a1)
    else: span=norm(a1-a3); midspan=norm(a1-am)
    large=1 if span>math.pi else 0
    return f'M{x1:.3f} {y1:.3f} A{r:.3f} {r:.3f} 0 {large} {sweep} {x3:.3f} {y3:.3f}'
def xy(n): return (f1(n,'xy') if False else None)
def pts(n):
    return [(c[1],-c[2]) for c in find(f1(n,'pts'),'xy')]
libs={}
for ls in find(f1(t,'lib_symbols'),'symbol'):
    g=[];pins=[]
    def walk(n):
        for c in n[2:]:
            if not isinstance(c,list): continue
            k=N(c[0])
            if k=='symbol': walk(c)
            elif k=='polyline':
                p=pts(c); fill=N(f1(f1(c,'fill'),'type')[1]) if f1(c,'fill') else 'none'
                g.append(dict(t='path',d='M'+' L'.join(f'{x:.3f} {y:.3f}' for x,y in p),fill=fill))
            elif k=='rectangle':
                a=f1(c,'start');b=f1(c,'end');fill=N(f1(f1(c,'fill'),'type')[1]) if f1(c,'fill') else 'none'
                x1,y1,x2,y2=a[1],-a[2],b[1],-b[2]
                g.append(dict(t='path',d=f'M{x1} {y1} L{x2} {y1} L{x2} {y2} L{x1} {y2} Z',fill=fill))
            elif k=='circle':
                ce=f1(c,'center');r=f1(c,'radius')[1];fill=N(f1(f1(c,'fill'),'type')[1]) if f1(c,'fill') else 'none'
                g.append(dict(t='circle',cx=ce[1],cy=-ce[2],r=r,fill=fill))
            elif k=='arc':
                s=f1(c,'start');m=f1(c,'mid');e=f1(c,'end');fill=N(f1(f1(c,'fill'),'type')[1]) if f1(c,'fill') else 'none'
                g.append(dict(t='path',d=arc_path((s[1],-s[2]),(m[1],-m[2]),(e[1],-e[2])),fill=fill))
            elif k=='pin':
                at=f1(c,'at'); nm=f1(c,'name'); nu=f1(c,'number')
                hide=any(N(x)=='hide' and False for x in c)
                pins.append(dict(name=nm[1],num=nu[1],x=at[1],y=-at[2],rot=at[3],len=f1(c,'length')[1],hidden=yes(c,'hide')))
    walk(ls)
    libs[ls[1]]=dict(g=g,pins=pins,power=f1(ls,'power') is not None,pin_names_hide=bool(f1(ls,'pin_names') and f1(f1(ls,'pin_names'),'hide')),pin_numbers_hide=bool(f1(ls,'pin_numbers') and f1(f1(ls,'pin_numbers'),'hide')))
    
# ---- instances
def tf(px,py,rot,mir):
    # px,py in y-down local coords; mirror x => flip y ; mirror y => flip x ; rotate rot deg CCW visually (y-down)
    if mir=='x': py=-py
    if mir=='y': px=-px
    a=math.radians(rot); c,s=round(math.cos(a),6),round(math.sin(a),6)
    return (px*c+py*s, -px*s+py*c)
insts=[]
for s in find(t,'symbol'):
    lid=f1(s,'lib_id')[1]; at=f1(s,'at'); mir=f1(s,'mirror'); mir=N(mir[1]) if mir else None
    props={}
    for p in find(s,'property'):
        e=f1(p,'effects'); j=f1(e,'justify') if e else None
        props[p[1]]=dict(v=p[2],x=f1(p,'at')[1],y=f1(p,'at')[2],rot=f1(p,'at')[3],hide=bool(e and yes(e,'hide')),just=[N(x) for x in j[1:]] if j else [])
    insts.append(dict(lib=lid,x=at[1],y=at[2],rot=at[3],mir=mir,props=props,ref=props['Reference']['v'],val=props['Value']['v'],
        unit=f1(s,'unit')[1] if f1(s,'unit') else 1, fp=props.get('Footprint',{}).get('v','')))
# pin positions
def pinpos(i):
    L=libs[i['lib']]; out=[]
    for p in L['pins']:
        dx,dy=tf(p['x'],p['y'],i['rot'],i['mir']); out.append((p,(round(i['x']+dx,3),round(i['y']+dy,3))))
    return out
wires=[[(round(c[1],3),round(c[2],3)) for c in find(f1(w,'pts'),'xy')] for w in find(t,'wire')]
juncs=[(round(f1(j,'at')[1],3),round(f1(j,'at')[2],3)) for j in find(t,'junction')]
ncs=[(round(f1(j,'at')[1],3),round(f1(j,'at')[2],3)) for j in find(t,'no_connect')]
# ---- connectivity
nodes={}  # id -> parent
def F(a):
    while nodes[a]!=a: nodes[a]=nodes[nodes[a]]; a=nodes[a]
    return a
def U(a,b): nodes.setdefault(a,a);nodes.setdefault(b,b);nodes[F(a)]=F(b)
def onseg(p,a,b,eps=0.01):
    cr=(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])
    if abs(cr)>eps*max(1,math.hypot(b[0]-a[0],b[1]-a[1])): return False
    return min(a[0],b[0])-eps<=p[0]<=max(a[0],b[0])+eps and min(a[1],b[1])-eps<=p[1]<=max(a[1],b[1])+eps
segs=[]
for wi,w in enumerate(wires):
    nodes.setdefault(('w',wi),('w',wi))
    for a,b in zip(w,w[1:]): segs.append((wi,a,b))
close=lambda p,q: abs(p[0]-q[0])<0.01 and abs(p[1]-q[1])<0.01
for (w1,a1,b1),(w2,a2,b2) in itertools.combinations(segs,2):
    if w1==w2: continue
    # endpoint on other segment, or shared endpoint
    for p in (a1,b1):
        if onseg(p,a2,b2): U(('w',w1),('w',w2))
    for p in (a2,b2):
        if onseg(p,a1,b1): U(('w',w2),('w',w1))
    for j in juncs:
        if onseg(j,a1,b1) and onseg(j,a2,b2): U(('w',w1),('w',w2))
pinnodes=[]
for i in insts:
    for p,pos in pinpos(i):
        pid=('p',i['ref'],p['num'],i['lib']) if not libs[i['lib']]['power'] else ('pw',i['ref'])
        nodes.setdefault(pid,pid); pinnodes.append((i,p,pos,pid))
hit=0;tot=0
for i,p,pos,pid in pinnodes:
    tot+=1; ok=False
    for wi,a,b in segs:
        if onseg(pos,a,b): U(pid,('w',wi)); ok=True
    for j,q,pos2,pid2 in pinnodes:
        if pid2!=pid and close(pos,pos2): U(pid,pid2); ok=True
    hit+=ok
print('pins attached',hit,'of',tot)
# power merges
for i in insts:
    if libs[i['lib']]['power'] and i['val']!='PWR_FLAG':
        U(('pw',i['ref']),('net',i['val']))
nets={}
for i,p,pos,pid in pinnodes:
    if libs[i['lib']]['power']: continue
    nets.setdefault(F(pid),[]).append(f"{i['ref']}.{p['num']}")
named={}
for k,v in list(nets.items()): pass
out=[]
for r,pins in nets.items():
    name=None
    for n in nodes:
        if isinstance(n,tuple) and n[0]=='net' and F(n)==r: name=n[1]
    out.append(dict(name=name,pins=sorted(pins)))
out.sort(key=lambda n:(n['name'] is None,-len(n['pins'])))
for n in out: print(n)
# unattached pins
print('unattached:', [(i['ref'],p['num'],pos) for i,p,pos,pid in pinnodes if not any(onseg(pos,a,b) for _,a,b in segs) and not libs[i['lib']]['power'] and not any(pid2!=pid and close(pos,pos2) for _,_,pos2,pid2 in pinnodes)])
json.dump(dict(libs=libs,insts=insts,nets=out,ncs=ncs,
  pins={f"{i['ref']}.{p['num']}":dict(ref=i['ref'],num=p['num'],name=p['name'],x=pos[0],y=pos[1]) for i,p,pos,pid in pinnodes if not libs[i['lib']]['power']}),open(sys.argv[2],'w'))
