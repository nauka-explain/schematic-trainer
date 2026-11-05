// Корпуса: p — вывод, b — тело SMD (занято), . — место под корпусом THT (дорожки проходят)
const rep=(s,n)=>Array(n).fill(s);
const PARTS=[
  {p:'R',smd:1,mk:()=>['pp']},{p:'R',smd:1,mk:()=>['pbp']},
  {p:'C',smd:1,mk:()=>['pp']},{p:'C',smd:1,mk:()=>['pbp']},
  {p:'D',smd:1,mk:()=>['pp']},
  {p:'Q',smd:1,mk:()=>['pp','pb']},{p:'Q',smd:1,mk:()=>['bpb','pbp']},
  {p:'U',smd:1,mk:r=>rep('pbp',2+(r()*3|0))},{p:'U',smd:1,mk:r=>rep('pbp',2+(r()*3|0))},
  {p:'R',smd:0,mk:r=>['p'+'.'.repeat(2+(r()*3|0))+'p']},
  {p:'D',smd:0,mk:()=>['p..p']},{p:'Q',smd:0,mk:()=>['ppp']},
  {p:'U',smd:0,mk:r=>rep('p.p',3+(r()*3|0))},{p:'J',smd:0,tag:'датчик',mk:r=>rep('p',2+(r()*3|0))},
];
// Внешние разъёмы стоят у края платы: корпус (.) у края, выводы (p) направлены внутрь
const EDGE=[
  {p:'J',smd:0,edge:1,tag:'USB',mk:()=>['....','....','pppp']},
  {p:'J',smd:0,edge:1,tag:'DC',mk:()=>['...','.p.','p.p']},
  {p:'J',smd:0,edge:1,tag:'CON',mk:()=>['...','ppp']},
];
const rot=rows=>Array.from(rows[0],(_,j)=>rows.map((_,i)=>rows[rows.length-1-i][j]).join(''));
const LEVELS={1:{parts:4,nets:5,x:2},2:{parts:7,nets:8,x:3},3:{parts:10,nets:12,x:4},4:{parts:14,nets:18,x:5}};
const shuf=(a,r)=>{for(let i=a.length-1;i>0;i--){const j=r()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]]}return a};

function tryGen(seed,lvl){
  const r=rng(seed),L=LEVELS[lvl],base=[new Int8Array(N).fill(-1),new Int8Array(N).fill(-1)],bod=new Uint8Array(N),pads=[],comps=[],cnt={};
  const setb=(p,v)=>{if(p.smd)base[p.side][p.c]=v;else base[0][p.c]=base[1][p.c]=v};
  [0,W-1].forEach(x=>[0,H-1].forEach(y=>{base[0][y*W+x]=base[1][y*W+x]=-2}));
  for(let n=0;n<L.parts;n++){
    const s=n===0?EDGE[r()*EDGE.length|0]:PARTS[r()*PARTS.length|0];let rows=s.mk(r),e=-1;
    if(s.edge){e=r()*4|0;for(let q=0;q<e;q++)rows=rot(rows)}
    else if(r()<.5)rows=Array.from(rows[0],(_,i)=>rows.map(q=>q[i]).join(''));
    const h=rows.length,w=rows[0].length,side=s.smd?(r()<.35?1:0):-1;let placed=false;cnt[s.p]=(cnt[s.p]||0)+1;
    for(let t=0;t<150&&!placed;t++){
      const x=s.edge&&(e===1||e===3)?(e===1?W-w:0):1+(r()*(W-w-1)|0),y=s.edge&&(e===0||e===2)?(e===0?0:H-h):1+(r()*(H-h-1)|0);let free=true;
      for(let j=y-1;j<=y+h;j++)for(let i=x-1;i<=x+w;i++)if(i>=0&&i<W&&j>=0&&j<H&&bod[j*W+i])free=false;
      if(!free)continue;
      placed=true;comps.push({n:s.p+cnt[s.p],smd:s.smd,side,x,y,w,h,rows,edge:s.edge,tag:s.tag});
      for(let j=0;j<h;j++)for(let i=0;i<w;i++){
        const c=(y+j)*W+x+i,ch=rows[j][i];bod[c]=1;
        if(ch==='b')base[side][c]=-2;
        if(ch==='p'){const p={c,k:comps.length-1,smd:s.smd,side,u:s.p==='U',net:-1};pads.push(p);setb(p,-2)}
      }
    }
    if(!placed)return null;
  }
  // у резисторов, диодов, транзисторов и разъёмов подключены все выводы, у микросхемы минимум половина
  const used=pads.filter(p=>!p.u);
  comps.forEach((_,k)=>{const ps=shuf(pads.filter(p=>p.u&&p.k===k),r);ps.slice(0,Math.ceil(ps.length/2)).forEach(p=>used.push(p))});
  const opt=shuf(pads.filter(p=>p.u&&!used.includes(p)),r);
  if(used.length%2){if(!opt.length)return null;used.push(opt.pop())}
  if(used.length>2*(L.nets+L.x))return null;
  while(used.length<2*L.nets&&opt.length>1)used.push(opt.pop(),opt.pop());
  // пары выводов из разных компонентов: всегда берём два самых «заполненных» компонента
  const grp={};used.forEach(p=>(grp[p.k]=grp[p.k]||[]).push(p));
  const gl=Object.values(grp).map(a=>shuf(a,r));let pairs=[];
  for(;;){
    gl.sort((x,y)=>y.length-x.length);
    if(!gl[0].length)break;
    if(gl.length<2||!gl[1].length){pairs=null;break}
    pairs.push([gl[0].pop(),gl[1].pop()]);
  }
  if(!pairs)return null;
  const nets=pairs.map(([a,b],i)=>{a.net=b.net=i;setb(a,i);setb(b,i);return{a,b}});
  return{seed,lvl,base,nets,comps,allPads:pads};
}
function generate(seed,lvl){
  for(let k=0;k<500;k++){
    const b=tryGen(seed+k*7919,lvl);if(!b)continue;
    if(!autoroute(b,1))continue;
    b.auto=autoroute(b,6);
    const ls=b.auto.paths.map(plen).sort((a,c)=>a-c);
    b.auto.ratio=ls[ls.length-1]/ls[ls.length>>1];
    return b;
  }
}
