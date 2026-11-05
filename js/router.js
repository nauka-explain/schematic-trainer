// Сетка, два слоя и автотрассировщик (A* по состояниям «слой + клетка + направление»)
// Узел пути = слой*N + клетка; слой 0 — верх, слой 1 — низ
const W=36,H=24,N=W*H,VIA=4,DIRS=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
const dirIdx=(dx,dy)=>DIRS.findIndex(d=>d[0]===dx&&d[1]===dy);
const cxy=c=>[c%W,(c/W|0)];
function rng(s){return()=>{s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const padNodes=p=>p.smd?[p.side*N+p.c]:[p.c,N+p.c];   // SMD-площадка на одном слое, THT — на обоих

// Можно ли шагнуть в пределах слоя из (x,y) в (nx,ny); tg — клетка-цель, pd — прошлое направление (8 = нет)
function ok(o,n,tg,x,y,nx,ny,pd){
  if(nx<0||ny<0||nx>=W||ny>=H)return false;
  const i=ny*W+nx,t=o[i];
  if(!(t===-1||(i===tg&&t===n)))return false;
  const d=dirIdx(nx-x,ny-y);
  if(pd<8){const df=Math.abs(d-pd);if(Math.min(df,8-df)>2)return false}
  if(d%2)for(const j of[y*W+nx,ny*W+x]){const q=o[j];if(!(q===-1||q===n))return false}
  return true;
}
function plen(p){let s=0;for(let k=1;k<p.length;k++){const a=p[k-1]%N,b=p[k]%N;if(a===b)continue;const[x,y]=cxy(a),[u,v]=cxy(b);s+=(x!==u&&y!==v)?Math.SQRT2:1}return s}
function bends(p){let n=0,pd=-1;for(let k=1;k<p.length;k++){const a=p[k-1]%N,b=p[k]%N;if(a===b){pd=-1;continue}const[x,y]=cxy(a),[u,v]=cxy(b),d=dirIdx(u-x,v-y);if(pd>=0&&d!==pd)n++;pd=d}return n}
// клетки переходных отверстий (смена слоя вне площадок THT)
function vias(p,base){const r=[];for(let k=1;k<p.length;k++){const a=p[k-1]%N;if(a===p[k]%N&&base[0][a]===-1&&base[1][a]===-1)r.push(a)}return r}

function route(o,n,srcs,tg,tgn){
  const S=2*N*9,dist=new Float64Array(S).fill(1e9),prev=new Int32Array(S).fill(-1),h=[];
  const[tx,ty]=cxy(tg),hh=(x,y)=>{const dx=Math.abs(tx-x),dy=Math.abs(ty-y);return Math.max(dx,dy)+(Math.SQRT2-1)*Math.min(dx,dy)};   // A*: оценка оставшегося пути
  const push=(f,g,i)=>{h.push([f,g,i]);let k=h.length-1;while(k>0){const p=(k-1)>>1;if(h[p][0]<=h[k][0])break;[h[p],h[k]]=[h[k],h[p]];k=p}};
  const pop=()=>{const t=h[0],l=h.pop();if(h.length){h[0]=l;let k=0;for(;;){const a=2*k+1,b=a+1;let m=k;if(a<h.length&&h[a][0]<h[m][0])m=a;if(b<h.length&&h[b][0]<h[m][0])m=b;if(m===k)break;[h[m],h[k]]=[h[k],h[m]];k=m}}return t};
  srcs.forEach(s=>{const[sx,sy]=cxy(s%N);dist[s*9+8]=0;push(hh(sx,sy),0,s*9+8)});
  while(h.length){
    const[,c,i]=pop();if(c>dist[i])continue;
    const nd=i/9|0,pd=i%9,cell=nd%N,l=nd/N|0,[x,y]=cxy(cell);
    if(tgn.includes(nd)){const p=[];for(let k=i;k>=0;k=prev[k])p.push(k/9|0);return p.reverse()}
    for(let d=0;d<8;d++){
      const nx=x+DIRS[d][0],ny=y+DIRS[d][1];
      if(!ok(o[l],n,tg,x,y,nx,ny,pd))continue;
      const nc=c+(d%2?Math.SQRT2:1)+(pd<8&&pd!==d?.6:0),ni=(l*N+ny*W+nx)*9+d;
      if(nc<dist[ni]){dist[ni]=nc;prev[ni]=i;push(nc+hh(nx,ny),nc,ni)}
    }
    if(o[0][cell]===-1&&o[1][cell]===-1){
      const ni=((1-l)*N+cell)*9+8,nc=c+VIA;
      if(nc<dist[ni]){dist[ni]=nc;prev[ni]=i;push(nc+hh(x,y),nc,ni)}
    }
  }
  return null;
}

function autoroute(b,tries=40){
  const r=rng(b.seed),man=n=>{const[a,c]=cxy(n.a.c),[d,e]=cxy(n.b.c);return Math.abs(a-d)+Math.abs(c-e)};
  let best=null,bs=0;
  for(let t=0;t<tries;t++){
    const ord=b.nets.map((_,i)=>i);
    if(t)ord.sort(()=>r()-.5);else ord.sort((p,q)=>man(b.nets[p])-man(b.nets[q]));
    const o=[b.base[0].slice(),b.base[1].slice()],paths=[];let fail=false;
    for(const n of ord){
      const nt=b.nets[n],p=route(o,n,padNodes(nt.a),nt.b.c,padNodes(nt.b));
      if(!p){fail=true;break}
      p.forEach(nd=>{const l=nd/N|0,c=nd%N;if(o[l][c]===-1)o[l][c]=n});paths[n]=p;
    }
    if(fail)continue;
    const len=paths.reduce((s,p)=>s+plen(p),0),v=paths.reduce((s,p)=>s+vias(p,b.base).length,0);
    if(!best||len+v*3<bs){bs=len+v*3;best={paths,ord,len,vias:v,bends:paths.reduce((s,p)=>s+bends(p),0)}}
  }
  return best;
}
