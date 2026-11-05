const C=34,cv=document.getElementById('cv'),cx=cv.getContext('2d'),$=id=>document.getElementById(id),root=document.documentElement;
cv.width=W*C;cv.height=H*C;
// Вид: масштаб и сдвиг платы (щипок двумя пальцами, колесо мыши, кнопки)
const view={k:1,tx:0,ty:0};
function clampView(){view.k=Math.min(4,Math.max(1,view.k));view.tx=Math.min(0,Math.max(cv.width*(1-view.k),view.tx));view.ty=Math.min(0,Math.max(cv.height*(1-view.k),view.ty))}
const toCv=(e,dy=0)=>{const r=cv.getBoundingClientRect();return[(e.clientX-r.left)*cv.width/r.width,(e.clientY+dy-r.top)*cv.height/r.height]};
function zoomAt(px,py,f){const k0=view.k,wx=(px-view.tx)/k0,wy=(py-view.ty)/k0;view.k=k0*f;clampView();view.tx=px-wx*view.k;view.ty=py-wy*view.k;clampView()}
function cellOf(e,dy=0){const[px,py]=toCv(e,dy);return[Math.floor((px-view.tx)/view.k/C),Math.floor((py-view.ty)/view.k/C)]}
let anim=null,B,occ,paths,tg,tgn,marks,redoS,last=null,act=null,mode=0,layer=0,hov=null,ghost=false,hintN=null,hintT,flash='',flashT,hints=0,t0=null,tEnd=null,best=null,theme='dark';
// контрастная палитра цепей
const PAL=['#ffd23f','#35c9ff','#ff5fa2','#ff8a3d','#b890ff','#f4f4f4','#8cff5a','#ff4d4d','#2de2c0','#ffa8e0'].map(h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)));
const col=(n,a=1)=>`rgba(${PAL[n%PAL.length]},${a})`;
const TH={dark:{b0:'#17614b',b1:'#0a2e24',dot:'rgba(255,255,255,.13)',tint:'rgba(40,90,200,.22)'},light:{b0:'#2f9a72',b1:'#1b6a4d',dot:'rgba(255,255,255,.24)',tint:'rgba(30,70,190,.24)'}};
const pt=c=>{const[x,y]=cxy(c);return[x*C+C/2,y*C+C/2]};
const done=n=>paths[n].length>0&&tgn[n].includes(paths[n][paths[n].length-1]);
const fmt=ms=>{const s=ms/1000|0;return(s/60|0)+':'+String(s%60).padStart(2,'0')};
const key=()=>'pcb3:'+B.seed+':'+B.lvl;   // новый ключ: поле стало больше, старые рекорды не подходят
function note(s){flash=s;clearTimeout(flashT);flashT=setTimeout(()=>{flash='';stats()},2500);stats()}

function setTheme(t){theme=t;root.dataset.theme=t;try{localStorage.setItem('pcb-theme',t)}catch(e){}$('bTheme').setAttribute('aria-checked',t==='dark');$('bTheme').title=t==='dark'?'Тёмная тема, нажмите для светлой':'Светлая тема, нажмите для тёмной';if(B)draw()}
function newGame(seed){
  if(anim)animStop();
  seed=seed||(Math.random()*1e6|0);
  while(!(B=generate(seed,+$('lvl').value)))seed++;   // редкие нерешаемые ID пропускаем
  $('seed').value=seed;
  try{best=JSON.parse(localStorage.getItem(key()))}catch(e){best=null}
  reset();
}
function reset(){
  occ=[B.base[0].slice(),B.base[1].slice()];paths=B.nets.map(()=>[]);tg=B.nets.map(()=>-1);tgn=B.nets.map(()=>[]);marks=B.nets.map(()=>[]);redoS=B.nets.map(()=>[]);last=null;
  act=null;layer=0;hintN=null;hints=0;t0=tEnd=null;draw();
}
function clearNet(n){paths[n].forEach(nd=>{const l=nd/N|0,c=nd%N;occ[l][c]=B.base[l][c]});paths[n]=[];tg[n]=-1;tgn[n]=[];marks[n]=[];redoS[n]=[]}
function lastDir(p){
  if(p.length<2)return 8;const a=p[p.length-2],b=p[p.length-1];
  if(a%N===b%N)return 8;const[x,y]=cxy(a%N),[u,v]=cxy(b%N);return dirIdx(u-x,v-y);
}

// Предпросмотр: от конца дорожки до курсора, излом 45° (диагональ и прямая)
function preview(){
  if(act===null||!hov)return null;
  const p=paths[act],e=p[p.length-1],l=e/N|0,[x0,y0]=cxy(e%N),dx=hov[0]-x0,dy=hov[1]-y0;
  const ax=Math.abs(dx),ay=Math.abs(dy),m=Math.min(ax,ay),s=Math.max(ax,ay)-m;
  const dia=[Math.sign(dx),Math.sign(dy)],str=ax>=ay?[Math.sign(dx),0]:[0,Math.sign(dy)];
  const mv=mode?[...rep(str,s),...rep(dia,m)]:[...rep(dia,m),...rep(str,s)];
  let x=x0,y=y0,pd=lastDir(p),bad=false;const cells=[];
  for(const[a,b]of mv){
    const nx=x+a,ny=y+b;
    if(!ok(occ[l],act,tg[act],x,y,nx,ny,pd)){bad=true;break}
    pd=dirIdx(a,b);x=nx;y=ny;cells.push(y*W+x);if(tgn[act].includes(l*N+y*W+x))break;
  }
  return{cells,bad,l};
}

function line(p,w,style,dash){
  if(p.length<2)return;
  cx.beginPath();p.forEach((c,k)=>{const[x,y]=pt(c);k?cx.lineTo(x,y):cx.moveTo(x,y)});
  cx.lineWidth=w;cx.strokeStyle=style;cx.setLineDash(dash||[]);cx.stroke();cx.setLineDash([]);
}
function track(p,i,lay,a,full){
  let seg=[];
  const fl=()=>{if(seg.length>1){if(full)line(seg,13,'rgba(0,0,0,.5)');line(seg,full?9:7,col(i,a));if(full)line(seg,3,'rgba(255,255,255,.3)')}seg=[]};
  p.forEach(nd=>{if((nd/N|0)===lay)seg.push(nd%N);else fl()});fl();
}
function pad(c,smd,fill){
  const[x,y]=pt(c);cx.fillStyle=fill;cx.beginPath();
  if(smd)cx.roundRect(x-13,y-11,26,22,3);else cx.arc(x,y,12,0,7);
  cx.fill();cx.strokeStyle='rgba(0,0,0,.55)';cx.lineWidth=1.5;cx.stroke();
  if(!smd){cx.fillStyle='#06120e';cx.beginPath();cx.arc(x,y,4,0,7);cx.fill()}
}
function ring(c,r,fill,hole){const[x,y]=pt(c);cx.fillStyle=fill;cx.beginPath();cx.arc(x,y,r,0,7);cx.fill();cx.strokeStyle='rgba(0,0,0,.6)';cx.lineWidth=1.5;cx.stroke();cx.fillStyle='#06120e';cx.beginPath();cx.arc(x,y,hole,0,7);cx.fill()}

function draw(){
  cx.setTransform(1,0,0,1,0,0);cx.fillStyle='#07130f';cx.fillRect(0,0,cv.width,cv.height);cx.setTransform(view.k,0,0,view.k,view.tx,view.ty);
  const shown=anim?anim.paths:paths,dn=i=>anim?anim.complete[i]:done(i);
  const t=TH[theme],g=cx.createRadialGradient(cv.width/2,cv.height/2,40,cv.width/2,cv.height/2,cv.width*.65);
  g.addColorStop(0,t.b0);g.addColorStop(1,t.b1);cx.fillStyle=g;cx.fillRect(0,0,cv.width,cv.height);
  if(layer){cx.fillStyle=t.tint;cx.fillRect(0,0,cv.width,cv.height)}
  cx.fillStyle=t.dot;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)cx.fillRect(x*C+C/2-1,y*C+C/2-1,2,2);
  if(hov&&hov[0]>=0&&hov[1]>=0&&hov[0]<W&&hov[1]<H){cx.fillStyle='rgba(255,255,255,.1)';cx.fillRect(hov[0]*C+2,hov[1]*C+2,C-4,C-4)}
  [0,W-1].forEach(x=>[0,H-1].forEach(y=>ring(y*W+x,11,'#d9a05b',6)));
  cx.lineCap=cx.lineJoin='round';
  shown.forEach((p,i)=>track(p,i,1-layer,.3,false));
  B.comps.forEach(k=>{
    cx.globalAlpha=k.smd&&k.side!==layer?.3:1;
    k.rows.forEach((row,j)=>[...row].forEach((ch,i)=>{
      if(ch==='b'){cx.fillStyle='rgba(6,14,18,.85)';cx.fillRect((k.x+i)*C+2,(k.y+j)*C+2,C-4,C-4)}
      else if(ch==='.'&&k.edge){cx.fillStyle='rgba(255,255,255,.12)';cx.fillRect((k.x+i)*C+2,(k.y+j)*C+2,C-4,C-4)}
    }));
    cx.strokeStyle='rgba(240,245,236,.85)';cx.lineWidth=1.5;cx.setLineDash(k.smd?[]:[5,4]);
    cx.strokeRect(k.x*C+3,k.y*C+3,k.w*C-6,k.h*C-6);cx.setLineDash([]);
    cx.fillStyle='rgba(240,245,236,.95)';cx.textAlign='left';cx.font='600 11px system-ui';
    cx.fillText(k.n+(k.tag?' '+k.tag:'')+(k.smd&&k.side?' (низ)':''),k.x*C+3,k.y===0?(k.y+k.h)*C+12:k.y*C-3);
  });
  cx.globalAlpha=1;
  if(ghost&&!anim)B.auto.paths.forEach(p=>line(p.map(n=>n%N),2,'rgba(255,255,255,.6)',[5,5]));
  B.nets.forEach((n,i)=>{if(!dn(i))line([n.a.c,n.b.c],1.5,col(i,.5),[4,5])});
  shown.forEach((p,i)=>track(p,i,layer,1,true));
  shown.forEach(p=>vias(p,B.base).forEach(c=>ring(c,9,'#e0b060',3.5)));
  const pv=preview();
  if(pv){
    const p=paths[act];line([p[p.length-1]%N,...pv.cells],10,col(act,.55));
    if(pv.bad){const x=hov[0]*C+C/2,y=hov[1]*C+C/2;cx.strokeStyle='#ff5050';cx.lineWidth=3;cx.beginPath();cx.moveTo(x-7,y-7);cx.lineTo(x+7,y+7);cx.moveTo(x+7,y-7);cx.lineTo(x-7,y+7);cx.stroke()}
  }
  if(hintN!==null)line(B.auto.paths[hintN].map(n=>n%N),4,'#fff',[7,5]);
  B.allPads.forEach(p=>{cx.globalAlpha=p.smd&&p.side!==layer?.3:1;pad(p.c,p.smd,p.net>=0?col(p.net):'#8f9a92')});
  cx.globalAlpha=1;
  // концы незаконченных дорожек (пауза)
  (anim?[]:paths).forEach((p,i)=>{if(p.length>1&&!done(i)&&(p[p.length-1]/N|0)===layer){const[x,y]=pt(p[p.length-1]%N);cx.strokeStyle='#fff';cx.lineWidth=2;cx.setLineDash([3,3]);cx.beginPath();cx.arc(x,y,15,0,7);cx.stroke();cx.setLineDash([])}});
  if(anim){   // «перо» анимации: хвост до головки, свечение, вспышки при подключении площадки
    const hd=anim.head;
    if(hd){const pp=anim.paths[hd.n],lp=pp.length?pt(pp[pp.length-1]%N):[hd.x,hd.y];
      cx.beginPath();cx.moveTo(lp[0],lp[1]);cx.lineTo(hd.x,hd.y);cx.lineWidth=9;cx.strokeStyle=col(hd.n,1);cx.stroke();
      const gr=cx.createRadialGradient(hd.x,hd.y,2,hd.x,hd.y,C*.9);gr.addColorStop(0,col(hd.n,.9));gr.addColorStop(1,col(hd.n,0));
      cx.fillStyle=gr;cx.beginPath();cx.arc(hd.x,hd.y,C*.9,0,7);cx.fill();cx.fillStyle='#fff';cx.beginPath();cx.arc(hd.x,hd.y,4,0,7);cx.fill()}
    anim.flash.forEach(f=>{const[x,y]=pt(B.nets[f.n].b.c),q=f.age/600;cx.strokeStyle=col(f.n,1-q);cx.lineWidth=3;cx.beginPath();cx.arc(x,y,12+q*26,0,7);cx.stroke()});
  }
  if(tg2&&tg2.mode==='route'&&tg2.moved&&hov){const[x,y]=[hov[0]*C+C/2,hov[1]*C+C/2];cx.strokeStyle='#fff';cx.lineWidth=2;cx.beginPath();cx.arc(x,y,C*.45,0,7);cx.stroke()}   // метка точки под пальцем
  $('zoom').value=view.k;$('tbLayer').textContent=layer?'Низ':'Верх';$('badge').textContent=layer?'Нижний слой':'Верхний слой';$('badge').className='badge'+(layer?' bot':'');
  $('bLayer').textContent='Слой: '+(layer?'нижний':'верхний')+' (Пробел)';
  stats();
}

function stats(){
  const nd=B.nets.filter((_,i)=>done(i)).length,pr=Math.round(nd/B.nets.length*100);
  const ls=paths.map(plen).filter(v=>v>0).sort((a,b)=>a-b),L=ls.reduce((s,v)=>s+v,0),bd=paths.reduce((s,p)=>s+bends(p),0),vs=paths.reduce((s,p)=>s+vias(p,B.base).length,0);
  const ratio=ls.length?ls[ls.length-1]/ls[ls.length>>1]:0;
  $('prog').textContent=pr+'%';$('barfill').style.width=pr+'%';
  $('len').textContent=L.toFixed(1);$('auto').textContent=B.auto.len.toFixed(1);
  $('bnd').textContent=bd+' / '+B.auto.bends;$('via').textContent=vs+' / '+B.auto.vias;
  $('even').textContent=ratio.toFixed(2)+' / '+B.auto.ratio.toFixed(2);
  $('best').textContent=best?best.s+'/100':'—';
  const paused=paths.some((p,i)=>p.length>1&&!done(i)&&i!==act);
  let m=act!==null?'Кликайте, чтобы фиксировать участки\nПробел ставит переходное отверстие, Esc ставит на паузу':paused?'Есть дорожки на паузе\nКликните на конец дорожки, чтобы продолжить':'Нажмите на площадку, чтобы начать дорожку';
  if(pr===100){
    if(!tEnd){tEnd=Date.now();$('time').textContent=fmt(tEnd-t0)}
    const pen=Math.max(0,bd-B.auto.bends)+Math.min(15,Math.max(0,ratio-B.auto.ratio)*5)+Math.max(0,vs-B.auto.vias)*2+hints*3;
    const s=Math.max(0,Math.round(Math.min(100,B.auto.len/L*100)-pen));
    if(!best||s>best.s){best={s};try{localStorage.setItem(key(),JSON.stringify(best))}catch(e){}}
    $('best').textContent=best.s+'/100';
    m=`Готово! Оценка ${s}/100 ${s>=90?'★★★':s>=75?'★★☆':'★☆☆'}\n`+(L<B.auto.len-.01?'Вы обошли автотрассировщика по длине':s>=90?'Результат близок к автотрассировщику':'Сократите длину, изгибы, переходы и самую длинную дорожку')+`\nВремя ${fmt(tEnd-t0)}`;
  }
  if(anim)m=anim.text;
  $('msg').textContent=flash||m;
}

// что можно начать или продолжить в этой клетке
function findStart(i){
  for(let n=0;n<B.nets.length;n++){
    const p=paths[n],nt=B.nets[n];
    if(!p.length){const pd=nt.a.c===i?nt.a:nt.b.c===i?nt.b:null;if(pd)return{n,pd}}
    else if(!done(n)&&p[p.length-1]%N===i)return{n}
  }
}
function begin({n,pd}){
  const nt=B.nets[n];
  if(pd){const o=pd===nt.a?nt.b:nt.a;tg[n]=o.c;tgn[n]=padNodes(o);layer=pd.smd?pd.side:layer;paths[n]=[layer*N+pd.c]}
  else layer=paths[n][paths[n].length-1]/N|0;
  act=n;last=n;if(!t0)t0=Date.now();
}
function commit(){
  const pv=preview();if(!pv||!pv.cells.length)return;
  const p=paths[act];marks[act].push(p.length);redoS[act]=[];last=act;
  pv.cells.forEach(c=>{p.push(pv.l*N+c);if(occ[pv.l][c]===-1)occ[pv.l][c]=act});
  if(tgn[act].includes(p[p.length-1]))act=null;
  draw();
}
function undo(){
  if(act===null&&last!==null&&paths[last].length>1)act=last;   // можно отменить участок и у завершённой дорожки
  if(act===null)return;
  const m=marks[act],p=paths[act];
  if(m.length){const rm=p.splice(m.pop());rm.forEach(nd=>{const l=nd/N|0,c=nd%N;occ[l][c]=B.base[l][c]});redoS[act].push(rm);layer=p[p.length-1]/N|0}
  else if(p.length===1){clearNet(act);act=null}
  else note('Нечего отменять, Delete удаляет дорожку');
  draw();
}
function redo(){
  if(act===null&&last!==null&&redoS[last].length)act=last;
  if(act===null||!redoS[act].length)return;
  const p=paths[act],rm=redoS[act].pop();
  if(!rm.every(nd=>{const l=nd/N|0,c=nd%N;return occ[l][c]===-1||(occ[l][c]===act&&B.base[l][c]===act)})){redoS[act]=[];return note('Участок уже занят, повтор невозможен')}
  marks[act].push(p.length);
  rm.forEach(nd=>{const l=nd/N|0,c=nd%N;p.push(nd);if(occ[l][c]===-1)occ[l][c]=act});
  layer=p[p.length-1]/N|0;if(tgn[act].includes(p[p.length-1]))act=null;
  draw();
}
// Пробел: смена слоя; во время прокладки ставит переходное отверстие
function flip(){
  if(act===null){layer^=1;return draw()}
  const p=paths[act],e=p[p.length-1],c=e%N,l=e/N|0,o=1-l;
  if(B.base[l][c]===act){if(B.base[o][c]!==act)return note('SMD-площадка есть только на одном слое')}
  else if(!(occ[o][c]===-1&&B.base[l][c]===-1))return note('Здесь нельзя поставить переходное отверстие');
  marks[act].push(p.length);redoS[act]=[];last=act;p.push(o*N+c);if(occ[o][c]===-1)occ[o][c]=act;layer=o;draw();
}
// F: порядок излома
function toggleMode(){mode^=1;$('bMode').textContent=mode?'Излом: прямая, затем диагональ (F)':'Излом: диагональ, затем прямая (F)';draw()}
// Анимация: цепи эталона прокладываются по одной в порядке автотрассировщика, слой переключается вместе с «пером»
function animStart(){
  pause();hintN=null;
  const segs=[];let t=0;
  B.auto.ord.forEach(n=>{const p=B.auto.paths[n],dur=Math.max(450,p.length*40);segs.push({n,p,t0:t,dur});t+=dur+180});
  const sc=Math.min(1,12000/t);segs.forEach(g=>{g.t0*=sc;g.dur*=sc});t*=sc;   // вся анимация не длиннее ~12 с
  anim={start:performance.now(),segs,total:t,saveLayer:layer,paths:B.nets.map(()=>[]),complete:B.nets.map(()=>false),head:null,flash:[],text:'',finished:false};
  document.body.classList.add('anim');$('bAnim').textContent='Закрыть анимацию (A)';
  animTick(anim.start);
}
function animStop(){
  if(!anim)return;layer=anim.saveLayer;anim=null;
  document.body.classList.remove('anim');$('bAnim').textContent='Анимация эталона (A)';draw();
}
function animUpdate(now){
  const a=anim,el=now-a.start;let cur=null,n=0;a.flash=[];
  a.segs.forEach(s=>{
    const f=Math.min(1,Math.max(0,(el-s.t0)/s.dur)),i=f*(s.p.length-1),m=Math.floor(i);
    a.paths[s.n]=f<=0?[]:s.p.slice(0,m+1);a.complete[s.n]=f>=1;
    if(f>=1){n++;const age=el-s.t0-s.dur;if(age<600)a.flash.push({n:s.n,age})}
    else if(f>0)cur={s,m,fr:i-m};
  });
  a.head=null;
  if(cur){const{s,m,fr}=cur,p0=pt(s.p[m]%N),p1=pt(s.p[Math.min(m+1,s.p.length-1)]%N);layer=s.p[m]/N|0;a.head={n:s.n,x:p0[0]+(p1[0]-p0[0])*fr,y:p0[1]+(p1[1]-p0[1])*fr}}
  const tot=B.nets.length;
  a.text=`Эталонная трассировка: цепь ${Math.min(tot,n+(cur?1:0))} из ${tot}`;
  if(el>=a.total){a.finished=true;layer=0;a.text=`Эталон проложен\nДлина ${B.auto.len.toFixed(1)}, изгибы ${B.auto.bends}, переходы ${B.auto.vias}`}
}
function animTick(now){
  if(!anim)return;animUpdate(now);draw();
  if(!anim.finished)requestAnimationFrame(animTick);
}
const animToggle=()=>anim?animStop():animStart();
function pause(){act=null;$('keys').hidden=true;draw()}
function del(){if(act!==null){clearNet(act);act=null;draw()}}
function hint(){
  const i=B.nets.findIndex((_,k)=>!done(k)&&!paths[k].length);if(i<0)return;
  hintN=i;hints++;draw();clearTimeout(hintT);hintT=setTimeout(()=>{hintN=null;draw()},4000);
}

// Мышь: клики. Касание: нажать на площадку, вести палец, отпустить — участок фиксируется; двумя пальцами — сдвиг и масштаб
const ptrs=new Map(),TOUCH_DY=-36;let pinch=null,tg2=null;
function mouseDown(e){
  if(e.button!==0)return;
  hov=cellOf(e);const[x,y]=hov;if(x<0||y<0||x>=W||y>=H)return;
  const f=findStart(y*W+x);
  if(act!==null&&(!f||f.n===act))return commit();
  if(f)begin(f);
  draw();
}
function touchDown(e,px,py){
  hov=cellOf(e);const[x,y]=hov;
  const f=(x>=0&&y>=0&&x<W&&y<H)?findStart(y*W+x):null;
  if(f&&f.n!==act){begin(f);tg2={mode:'route',moved:false,start:true,px,py}}
  else if(act!==null)tg2={mode:'route',moved:false,start:false,px,py};
  else tg2={mode:'pan',x:px,y:py,tx:view.tx,ty:view.ty};
  draw();
}
cv.addEventListener('pointerdown',e=>{
  if(anim)return;
  if(cv.setPointerCapture&&e.pointerId!==undefined)try{cv.setPointerCapture(e.pointerId)}catch(_){}
  const[px,py]=toCv(e);ptrs.set(e.pointerId,{x:px,y:py});
  if(ptrs.size===2){const[a,b]=[...ptrs.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1,mx:(a.x+b.x)/2,my:(a.y+b.y)/2,k:view.k,tx:view.tx,ty:view.ty};tg2=null;return}
  if(ptrs.size>2)return;
  if(e.button===1){tg2={mode:'pan',x:px,y:py,tx:view.tx,ty:view.ty};return}
  if(e.pointerType==='touch')touchDown(e,px,py);else mouseDown(e);
});
cv.addEventListener('pointermove',e=>{
  if(!ptrs.has(e.pointerId)){hov=cellOf(e);draw();return}
  const[px,py]=toCv(e);ptrs.set(e.pointerId,{x:px,y:py});
  if(pinch&&ptrs.size===2){
    const[a,b]=[...ptrs.values()],d=Math.hypot(a.x-b.x,a.y-b.y)||1,mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    const wx=(pinch.mx-pinch.tx)/pinch.k,wy=(pinch.my-pinch.ty)/pinch.k;
    view.k=pinch.k*d/pinch.d;clampView();view.tx=mx-wx*view.k;view.ty=my-wy*view.k;clampView();draw();return;
  }
  if(!tg2){hov=cellOf(e);draw();return}
  if(tg2.mode==='pan'){view.tx=tg2.tx+px-tg2.x;view.ty=tg2.ty+py-tg2.y;clampView();draw();return}
  if(Math.hypot(px-tg2.px,py-tg2.py)>8)tg2.moved=true;
  hov=cellOf(e,tg2.moved?TOUCH_DY:0);draw();   // при движении метка чуть выше пальца, чтобы палец не закрывал точку
});
['pointerup','pointercancel'].forEach(t=>cv.addEventListener(t,e=>{
  const was=tg2;ptrs.delete(e.pointerId);if(ptrs.size<2)pinch=null;
  if(t==='pointerup'&&was&&was.mode==='route'&&act!==null&&(was.moved||!was.start))commit();
  tg2=null;if(e.pointerType==='touch')hov=null;
  draw();
}));
cv.addEventListener('pointerleave',()=>{if(!tg2){hov=null;draw()}});
cv.addEventListener('lostpointercapture',e=>{ptrs.delete(e.pointerId);if(ptrs.size<2)pinch=null});   // страховка от «потерянных» касаний
cv.addEventListener('wheel',e=>{e.preventDefault();const[px,py]=toCv(e);zoomAt(px,py,e.deltaY<0?1.15:1/1.15);draw()},{passive:false});
cv.addEventListener('contextmenu',e=>{
  e.preventDefault();
  if(act!==null)return undo();
  const[x,y]=cellOf(e);if(x<0||y<0||x>=W||y>=H)return;
  const n=Math.max(occ[layer][y*W+x],occ[1-layer][y*W+x]);if(n>=0){clearNet(n);draw()}
});
addEventListener('keydown',e=>{
  const tag=e.target.tagName;if(tag==='INPUT'||tag==='SELECT')return;
  if(anim){if(e.code==='KeyA'||e.key==='Escape')animStop();return}
  if(e.ctrlKey||e.metaKey){if(e.code==='KeyZ'){e.preventDefault();e.shiftKey?redo():undo()}else if(e.code==='KeyY'){e.preventDefault();redo()}return}
  if(e.code==='Space'){e.preventDefault();flip()}
  else if(e.code==='KeyF')toggleMode();
  else if(e.code==='KeyH')hint();
  else if(e.code==='KeyA')animStart();
  else if(e.key==='Escape')pause();
  else if(e.key==='Delete'||e.key==='Backspace')del();
});
addEventListener('click',e=>{
  if(!e.target.closest('#bKeys,#keys'))$('keys').hidden=true;
  if(e.target.tagName==='BUTTON'&&e.target.blur)e.target.blur();   // чтобы Пробел не нажимал последнюю кнопку
});

$('bKeys').onclick=()=>{
  const k=$('keys');k.hidden=!k.hidden;$('bKeys').setAttribute('aria-expanded',!k.hidden);
  if(k.hidden)return;
  const r=$('bKeys').getBoundingClientRect(),w=k.offsetWidth,h=k.offsetHeight;   // окно fixed: границы столбцов его не обрезают
  k.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
  k.style.top=(r.top-h-8>=8?r.top-h-8:Math.min(r.bottom+8,innerHeight-h-8))+'px';
};
$('bTheme').onclick=()=>setTheme(theme==='dark'?'light':'dark');
$('bNew').onclick=()=>newGame();
$('bSeed').onclick=()=>newGame(+$('seed').value||1);
$('bReset').onclick=reset;
$('bMode').onclick=toggleMode;
$('bUndo').onclick=undo;
$('bRedo').onclick=redo;
addEventListener('resize',()=>{$('keys').hidden=true});
$('bLayer').onclick=flip;
$('bHint').onclick=hint;
$('bAnim').onclick=animToggle;
$('bPause').onclick=pause;$('bDel').onclick=del;
$('zoom').oninput=()=>{zoomAt(cv.width/2,cv.height/2,+$('zoom').value/view.k);draw()};   // ползунок масштаба
const ACT={layer:flip,mode:toggleMode,undo,redo,pause,del,hint};   // нижняя панель на телефоне
document.querySelectorAll('[data-act]').forEach(b=>{b.onclick=()=>ACT[b.dataset.act]()});
$('lvl').onchange=()=>newGame();
$('bGhost').onclick=()=>{ghost=!ghost;$('bGhost').textContent=ghost?'Скрыть эталон':'Показать эталон';draw()};
setInterval(()=>{if(t0&&!tEnd)$('time').textContent=fmt(Date.now()-t0)},500);
setTheme(root.dataset.theme||((typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'));
newGame();
