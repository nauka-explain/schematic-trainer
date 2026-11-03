import sys
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.TDF import TDF_Label
from OCP.collections import Sequence_TDF_Label as Seq
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
app=XCAFApp_Application.GetApplication_s()
doc=TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
app.NewDocument(TCollection_ExtendedString("MDTV-XCAF"),doc)
r=STEPCAFControl_Reader(); r.SetColorMode(True); r.SetNameMode(True)
r.ReadFile(sys.argv[1]); r.Transfer(doc)
st=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()); ct=XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
def nm(l):
    a=TDataStd_Name()
    return a.Get().ToExtString() if l.FindAttribute(TDataStd_Name.GetID_s(),a) else ''
def col(shape):
    c=Quantity_Color()
    return (round(c.Red(),2),round(c.Green(),2),round(c.Blue(),2)) if ct.GetColor(shape,XCAFDoc_ColorType.XCAFDoc_ColorSurf,c) else None
fr=Seq(); st.GetFreeShapes(fr)
def walk(l,d=0):
    ref=TDF_Label()
    if st.GetReferredShape_s(l,ref):
        loc=st.GetLocation_s(l); t=loc.Transformation().TranslationPart()
        print('  '*d,'INST',nm(l),'->',nm(ref),(round(t.X(),2),round(t.Y(),2),round(t.Z(),2)))
        return walk(ref,d+1)
    sh=st.GetShape_s(l)
    if st.IsAssembly_s(l):
        print('  '*d,'ASM',nm(l))
        cs=Seq(); st.GetComponents_s(l,cs)
        for i in range(1,cs.Length()+1): walk(cs.Value(i),d+1)
    else:
        cols={}; nf=0
        e=TopExp_Explorer(sh,TopAbs_FACE)
        while e.More():
            nf+=1; c=col(e.Current()); cols[c]=cols.get(c,0)+1; e.Next()
        print('  '*d,'PART',nm(l),'faces',nf,'solidcol',col(sh),'facecols',cols)
for i in range(1,fr.Length()+1): walk(fr.Value(i))
