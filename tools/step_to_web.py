# Использование: python step_to_web.py board.step out_model.js board_id
import json, struct, base64, gzip, numpy as np, time
import sys
exec(open('_step_common.py').read().split("fr=Seq()")[0])
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopoDS import TopoDS
fr=Seq(); st.GetFreeShapes(fr)

PART_COLORS={'copper':(0.80,0.50,0.22),'pad':(0.86,0.86,0.80),'silkscreen':(1,1,1),'PCB':(0.06,0.30,0.18)}
parts={}   # key -> dict
insts=[]
def getcol(face, solid, default):
    for s in (face, solid):
        c=Quantity_Color()
        if s is not None and ct.GetColor(s,XCAFDoc_ColorType.XCAFDoc_ColorSurf,c): return (c.Red(),c.Green(),c.Blue())
    return default
def mesh_part(label):
    name=nm(label); sh=st.GetShape_s(label)
    key=name
    if key in parts: return key
    kind=None
    for k in PART_COLORS:
        if name.endswith('_'+k): kind=k
    BRepMesh_IncrementalMesh(sh, 0.03 if kind is None else 0.05, False, 0.35, True)
    solidcol=Quantity_Color(); hs=ct.GetColor(sh,XCAFDoc_ColorType.XCAFDoc_ColorSurf,solidcol)
    default=(solidcol.Red(),solidcol.Green(),solidcol.Blue()) if hs else (PART_COLORS[kind] if kind else (0.45,0.45,0.48))
    if kind=='PCB': default=PART_COLORS['PCB']
    P=[];I=[];C=[];off=0
    e=TopExp_Explorer(sh,TopAbs_FACE)
    while e.More():
        f=TopoDS.Face(e.Current()); loc=TopLoc_Location()
        tri=BRep_Tool.Triangulation_s(f,loc)
        if tri is not None:
            tr=loc.Transformation()
            col=getcol(e.Current(),None,default) if kind not in ('PCB',) else default
            n=tri.NbNodes()
            for i in range(1,n+1):
                p=tri.Node(i).Transformed(tr); P.append((p.X(),p.Y(),p.Z())); C.append(col)
            rev=(f.Orientation()==TopAbs_REVERSED)
            for i in range(1,tri.NbTriangles()+1):
                a,b,c=tri.Triangle(i).Get()
                a+=off-1;b+=off-1;c+=off-1
                I.append((a,c,b) if rev else (a,b,c))
            off+=n
        e.Next()
    parts[key]=dict(kind=kind or 'comp',P=np.array(P,np.float32),I=np.array(I,np.uint32),C=(np.array(C)*255).round().astype(np.uint8))
    print(key,kind,len(P),len(I))
    return key
def mat(loc):
    t=loc.Transformation(); return [[t.Value(r,c) for c in range(1,5)] for r in (1,2,3)]
def mul(A,B):
    A=np.vstack([np.array(A),[0,0,0,1]]);B=np.vstack([np.array(B),[0,0,0,1]]);return A@B
def walk(l,M,ref):
    r=TDF_Label()
    if st.GetReferredShape_s(l,r):
        M2=mul(M,mat(st.GetLocation_s(l)))
        n=nm(l)
        return walk(r,M2,ref if ref else (n if not n.startswith('=>') and not n.startswith('NAUO') else None))
    if st.IsAssembly_s(l):
        cs=Seq(); st.GetComponents_s(l,cs)
        for i in range(1,cs.Length()+1): walk(cs.Value(i),M,ref)
    else:
        key=mesh_part(l); name=nm(l)
        insts.append(dict(ref=ref or name,part=key,m=M.flatten().tolist()))
top=fr.Value(1); cs=Seq(); st.GetComponents_s(top,cs)
for i in range(1,cs.Length()+1): walk(cs.Value(i),np.eye(4),None)
# pack
blob=bytearray(); pm={}
for k,p in parts.items():
    pm[k]=dict(kind=p['kind'],nv=len(p['P']),ni=len(p['I']),off=len(blob))
    blob+=p['P'].tobytes(); blob+=p['C'].tobytes()
    pad=(-len(blob))%4; blob+=b'\0'*pad
    pm[k]['ioff']=len(blob); blob+=p['I'].tobytes()
meta=dict(parts=pm,insts=insts)
mj=json.dumps(meta).encode()
payload=struct.pack('<I',len(mj))+mj+bytes(blob)
gz=gzip.compress(payload,9)
print('raw',len(payload),'gz',len(gz))
import os; pass
open(sys.argv[2],'w').write('window.BOARD_MODELS=window.BOARD_MODELS||{};window.BOARD_MODELS["%s"]="%s";\n'%(sys.argv[3],base64.b64encode(gz).decode()))
print([ (i['ref'],i['part'][:20]) for i in insts])
