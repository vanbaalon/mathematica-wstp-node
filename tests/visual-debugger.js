'use strict';
// ── visual-debugger.js v2 — browser-based timeline test debugger ───────
// Usage:  node tests/visual-debugger.js
// Opens http://localhost:9111 — pick a mini-test and see a live timeline.
// Features: zoom/pan (Chrome-style), flag on/off spans, state-at-cursor,
// rich diagnostic tags, minimap, keyboard shortcuts.

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 9111;
const MINI_TEST = path.join(__dirname, 'mini-test.js');
const ROOT = path.join(__dirname, '..');

// ── Serve static HTML ─────────────────────────────────────────────────────
function serveHTML(res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
}

// ── SSE: run a single mini-test and stream events ─────────────────────────
function runTest(testNum, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.write('retry: 1000\n\n');

    const send = (type, data) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const t0 = Date.now();
    send('start', { testNum, t0 });

    const child = spawn('node', [MINI_TEST, '--only', String(testNum)], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const ms = Date.now() - t0;
            if (/✓/.test(trimmed))      send('result', { ms, line: trimmed, pass: true });
            else if (/✗/.test(trimmed)) send('result', { ms, line: trimmed, pass: false });
            else                        send('stdout', { ms, line: trimmed });
        }
    });

    child.stderr.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const ms = Date.now() - t0;
            const m = trimmed.match(/^\[diag\s+([\d:.]+)\]\s+\[([^\]]+)\]\s+(.*)/);
            if (m) send('diag', { ms, ts: m[1], cat: m[2], msg: m[3] });
            else   send('stderr', { ms, line: trimmed });
        }
    });

    child.on('close', (code) => { send('done', { ms: Date.now() - t0, code }); res.end(); });
    child.on('error', (err) => { send('error', { ms: Date.now() - t0, error: err.message }); res.end(); });

    res.on('close', () => {
        try { child.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
    });
}

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/run') {
        const num = parseInt(url.searchParams.get('test') || '1');
        runTest(num, res);
    } else {
        serveHTML(res);
    }
});

server.listen(PORT, () => {
    console.log(`\n  Visual Test Debugger v2 → http://localhost:${PORT}\n`);
});

// ══════════════════════════════════════════════════════════════════════════
// HTML page (inline)
// ══════════════════════════════════════════════════════════════════════════
const HTML_PAGE = /*html*/ `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>WSTP Timeline Debugger</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'SF Mono','Fira Code',Consolas,monospace;background:#0d1117;color:#c9d1d9;overflow:hidden}
header{padding:6px 14px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:10px;height:36px;flex-shrink:0}
header h1{font-size:13px;font-weight:600;color:#58a6ff;white-space:nowrap}
select,button{font-family:inherit;font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;cursor:pointer}
button{background:#238636;border-color:#238636;color:#fff;font-weight:600}
button:hover{background:#2ea043}button:disabled{opacity:.5;cursor:default}
.btn-sm{background:#21262d;border-color:#30363d;color:#c9d1d9;font-weight:400;min-width:28px}
.btn-sm:hover{background:#30363d}
#status{font-size:11px;color:#8b949e;flex:1}
#zoom-info{font-size:9px;color:#484f58}

#main{display:flex;flex-direction:column;height:calc(100vh - 36px)}
#minimap{height:22px;background:#0d1117;border-bottom:1px solid #21262d;position:relative;cursor:pointer;flex-shrink:0}
#minimap canvas{display:block;width:100%;height:100%}
#minimap .vp{position:absolute;top:0;height:100%;background:#58a6ff18;border-left:1px solid #58a6ff66;border-right:1px solid #58a6ff66;pointer-events:none}
#timeline-wrap{flex:1;position:relative;overflow:hidden;min-height:180px}
#timeline-wrap canvas{display:block}
#state-bar{height:24px;background:#161b22;border-top:1px solid #30363d;border-bottom:1px solid #30363d;padding:0 10px;font-size:9px;display:flex;align-items:center;gap:12px;color:#8b949e;flex-shrink:0;overflow-x:auto;white-space:nowrap}
.st-lbl{color:#58a6ff;font-weight:600}.st-on{color:#f85149}.st-off{color:#3fb950}
#log-panel{height:240px;border-top:1px solid #30363d;overflow-y:auto;padding:3px 6px;font-size:10px;flex-shrink:0;resize:vertical}
#log-panel::-webkit-scrollbar{width:5px}
#log-panel::-webkit-scrollbar-track{background:#0d1117}
#log-panel::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}

.log-line{padding:1px 3px;white-space:pre-wrap;word-break:break-all;border-radius:2px;line-height:1.35;cursor:pointer}
.log-line:hover{background:#161b22}.log-line.sel{background:#1f3a5f}
.c-Eval{color:#79c0ff}.c-DynRead{color:#a5d6ff}.c-drainEndDlg{color:#d2a8ff}
.c-when-idle{color:#ffa657}.c-subAuto{color:#7ee787}.c-WarmUp{color:#8b949e}
.c-Session{color:#f0883e}.c-CleanUp{color:#f85149}.c-SDR{color:#db61a2}
.c-Dialog{color:#f778ba}.c-stdout{color:#e6edf3}.c-stderr{color:#d29922}
.c-pass{color:#3fb950;font-weight:bold}.c-fail{color:#f85149;font-weight:bold}

.tag{display:inline;padding:0 3px;border-radius:2px;font-size:9px;margin-left:3px}
.t-send{background:#1f6feb33;color:#58a6ff}.t-recv{background:#23863633;color:#3fb950}
.t-btn{background:#d2992233;color:#d29922}.t-warn{background:#f8514933;color:#f85149}
.t-dlg{background:#f778ba33;color:#f778ba}.t-print{background:#8b949e33;color:#c9d1d9}

#tooltip{position:absolute;display:none;background:#1c2128;border:1px solid #30363d;border-radius:5px;padding:6px 10px;font-size:10px;max-width:550px;pointer-events:none;z-index:20;white-space:pre-wrap;word-break:break-all;box-shadow:0 3px 10px #00000088;line-height:1.35}
#cursor-line{position:absolute;top:0;width:1px;height:100%;background:#58a6ff44;pointer-events:none;display:none;z-index:5}
#cursor-time{position:absolute;top:2px;background:#161b22dd;border:1px solid #30363d;border-radius:3px;padding:1px 5px;font-size:9px;color:#58a6ff;pointer-events:none;display:none;z-index:6}
</style></head><body>
<header>
<h1>WSTP Timeline Debugger</h1>
<select id="tsel">
<option value="1">M1 — basic eval</option>
<option value="2">M2 — abort+survive</option>
<option value="3">M3 — abort stuck dlg</option>
<option value="4">M4 — abort+Dynamic</option>
<option value="5">M5 — stale interrupt</option>
<option value="6">M6 — rapid transitions</option>
<option value="7" selected>M7 — idle subAuto</option>
<option value="8">M8 — busy subAuto</option>
</select>
<button id="run-btn">&#9654; Run</button>
<button class="btn-sm" id="fit-btn" title="Fit all (F)">&#8596;</button>
<button class="btn-sm" id="zin-btn" title="Zoom in (+)">+</button>
<button class="btn-sm" id="zout-btn" title="Zoom out (-)">&#8722;</button>
<span id="status"></span>
<span id="zoom-info"></span>
</header>
<div id="main">
<div id="minimap"><canvas id="mm-cv"></canvas><div class="vp" id="mm-vp"></div></div>
<div id="timeline-wrap">
<canvas id="cv"></canvas>
<div id="tooltip"></div>
<div id="cursor-line"></div>
<div id="cursor-time"></div>
</div>
<div id="state-bar">
<span class="st-lbl">Cursor:</span>
<span id="st-t">—</span>
<span id="st-fl"></span>
<span id="st-act"></span>
</div>
<div id="log-panel"></div>
</div>
<script>
// ──────────────────────────────────────────────────────────────────────────
// Colors
// ──────────────────────────────────────────────────────────────────────────
const CC={Eval:'#79c0ff',DynRead:'#a5d6ff',drainEndDlg:'#d2a8ff','when-idle':'#ffa657',
subAuto:'#7ee787',WarmUp:'#8b949e',Session:'#f0883e',CleanUp:'#f85149',SDR:'#db61a2',Dialog:'#f778ba',
'State:activity':'#58a6ff','State:dialog':'#f778ba','State:sub':'#ffa657','State:abort':'#f85149','State:link':'#3fb950'};

// ──────────────────────────────────────────────────────────────────────────
// Markers
// ──────────────────────────────────────────────────────────────────────────
const MK=[
{r:/abort/i,l:'Abort',c:'#f85149',s:'diamond'},
{r:/WSInterruptMessage/i,l:'Interrupt',c:'#d29922',s:'diamond'},
{r:/EvaluatePacket/i,l:'EvalPkt\\u25b8',c:'#58a6ff',s:'arrow-r'},
{r:/EnterTextPacket/i,l:'EnterTxt\\u25b8',c:'#bc8cff',s:'arrow-r'},
{r:/BEGINDLGPKT|pkt=19\\b/,l:'DlgBegin',c:'#f778ba',s:'bar-start'},
{r:/ENDDLGPKT|pkt=20\\b/,l:'DlgEnd',c:'#f778ba',s:'bar-end'},
{r:/RETURNPKT(?!EXT)|(?:^|\\s)pkt=3\\b/,l:'ReturnPkt',c:'#3fb950',s:'tick'},
{r:/RETURNTEXTPKT|(?:^|\\s)pkt=4\\b/,l:'RetTextPkt',c:'#56d364',s:'tick'},
{r:/MENUPKT|pkt=6\\b/,l:'MenuPkt',c:'#d29922',s:'triangle'},
{r:/INPUTNAMEPKT|(?:^|\\s)pkt=8\\b/,l:'InNamePkt',c:'#8b949e',s:'dot'},
{r:/ScheduledTask/i,l:'SchedTask',c:'#ffa657',s:'star'},
{r:/rejectDialog/i,l:'RejectDlg',c:'#ff7b72',s:'cross'},
{r:/TIMEOUT/i,l:'Timeout',c:'#f85149',s:'cross'},
{r:/SIGKILL/i,l:'SIGKILL',c:'#ff0000',s:'cross'},
];

// ──────────────────────────────────────────────────────────────────────────
// Flag definitions — on/off patterns to track as horizontal spans
// ──────────────────────────────────────────────────────────────────────────
const FD=[
{onRe:/workerReadingLink.*true|workerReadingLink\.store\(true/i,
 offRe:/workerReadingLink.*false|workerReadingLink\.store\(false/i,
 label:'WorkerReading',onC:'#d29922',offC:'#8b949e'},
{onRe:/busy_\.store\(true|busy CAS.*true|acquired busy/i,
 offRe:/busy_\.store\(false|busy\.store\(false/i,
 label:'Busy',onC:'#bc8cff',offC:'#8b949e'},
{onRe:/BEGINDLGPKT|Dialog Begin|pkt=19\b/i,
 offRe:/ENDDLGPKT|Dialog End|pkt=20\b/i,
 label:'Dialog',onC:'#f778ba',offC:'#8b949e'},
];

// ──────────────────────────────────────────────────────────────────────────
// State-dimension definitions — each value gets its own coloured bar.
// Parsed from [State:<dim>] Old -> New (caller) log lines.
// ──────────────────────────────────────────────────────────────────────────
const SD={
  activity:{label:'Activity', colors:{Idle:'#484f58',Eval:'#58a6ff',SubIdle:'#79c0ff',WhenIdle:'#a5d6ff'}},
  dialog:  {label:'Dialog',   colors:{None:'#484f58',UserDialog:'#f778ba',DynDialog:'#da3633'}},
  sub:     {label:'SubWork',  colors:{None:'#484f58',DynExpr:'#ffa657',SubBusy:'#d29922'}},
  abort:   {label:'Abort',    colors:{None:'#484f58',Aborting:'#f85149'}},
  link:    {label:'Link',     colors:{Alive:'#484f58',Dead:'#f85149'}},
};
let sdSpans={};  // {dimKey: [{startMs,endMs,color,value}]}

// Tag rules for enriching log lines
const TR=[
{r:/sending expr.*?expr='([^']+)'/,t:'send',f:m=>'SEND:'+m[1]},
{r:/sent expr inside dialog/,t:'send',f:()=>'SEND(inside dlg)'},
{r:/sent Return\\[/,t:'send',f:()=>'SEND Return[]'},
{r:/sent.*flag|\\$wstpDynTaskStop=True/i,t:'send',f:()=>'FLAG=True'},
{r:/EvaluatePacket/,t:'send',f:()=>'EvalPkt'},
{r:/EnterTextPacket/,t:'send',f:()=>'EnterTxtPkt'},
{r:/responding\\s+'([^']+)'/,t:'btn',f:m=>'BTN:'+m[1]},
{r:/accepted.*val=(.+)/,t:'recv',f:m=>'VAL:'+m[1]},
{r:/result='([^']*)'/,t:'recv',f:m=>'RESULT:'+m[1]},
{r:/MENUPKT type=([0-9]+)/,t:'dlg',f:m=>'MENU('+m[1]+')'},
{r:/BEGINDLGPKT|Dialog Begin/i,t:'dlg',f:()=>'DLG\\u25b6'},
{r:/ENDDLGPKT|Dialog End/i,t:'dlg',f:()=>'DLG\\u25c0'},
{r:/Print|TextPacket/i,t:'print',f:()=>'Print'},
{r:/warning|::.+:/i,t:'warn',f:()=>'Warn'},
{r:/^(\w+)\s*->\s*(\w+)/,t:'state',f:m=>m[1]+'\u2192'+m[2]},
];

// ──────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────
let evts=[], fspans={}, running=false, totalMs=1000;
function sdKeys(){return Object.keys(sdSpans).filter(k=>sdSpans[k].length>0)}
let vpL=0, vpR=1000; // viewport left/right in ms

// ──────────────────────────────────────────────────────────────────────────
// DOM
// ──────────────────────────────────────────────────────────────────────────
const cv=document.getElementById('cv'), c=cv.getContext('2d');
const logP=document.getElementById('log-panel');
const tip=document.getElementById('tooltip');
const statE=document.getElementById('status');
const runB=document.getElementById('run-btn');
const tsel=document.getElementById('tsel');
const zi=document.getElementById('zoom-info');
const cLine=document.getElementById('cursor-line'),cTime=document.getElementById('cursor-time');
const stT=document.getElementById('st-t'),stFl=document.getElementById('st-fl'),stAct=document.getElementById('st-act');
const mmCv=document.getElementById('mm-cv'),mc=mmCv.getContext('2d');
const mmVp=document.getElementById('mm-vp'),mmW=document.getElementById('minimap');
const dpr=devicePixelRatio||1;

// ──────────────────────────────────────────────────────────────────────────
// Sizing
// ──────────────────────────────────────────────────────────────────────────
function resize(){
  const r=cv.parentElement.getBoundingClientRect();
  cv.width=r.width*dpr;cv.height=r.height*dpr;
  cv.style.width=r.width+'px';cv.style.height=r.height+'px';
  c.setTransform(dpr,0,0,dpr,0,0);
  const mr=mmW.getBoundingClientRect();
  mmCv.width=mr.width*dpr;mmCv.height=mr.height*dpr;
  mmCv.style.width=mr.width+'px';mmCv.style.height=mr.height+'px';
  mc.setTransform(dpr,0,0,dpr,0,0);
  paint();paintMM();
}
addEventListener('resize',resize);

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function fmt(ms){if(ms>=10000)return(ms/1000).toFixed(1)+'s';if(ms>=1000)return(ms/1000).toFixed(2)+'s';return Math.round(ms)+'ms'}
function nice(range){const r=range/8,m=Math.pow(10,Math.floor(Math.log10(r))),n=r/m;if(n<=1)return m;if(n<=2)return 2*m;if(n<=5)return 5*m;return 10*m}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function cats(){const c=[],s=new Set();for(const e of evts)if(!s.has(e.cat)){s.add(e.cat);c.push(e.cat)}return c}
function flagKeys(){return Object.keys(fspans).filter(k=>fspans[k].length>0)}

// Layout
const ML=90,MR=20,MT=28,LH=18,FH=13;

// ──────────────────────────────────────────────────────────────────────────
// Main draw
// ──────────────────────────────────────────────────────────────────────────
function paint(){
  const W=cv.width/dpr,H=cv.height/dpr;
  c.clearRect(0,0,W,H);
  if(!evts.length){c.fillStyle='#484f58';c.font='13px sans-serif';c.textAlign='center';c.fillText('Select a test and press Run',W/2,H/2);return}

  const cs=cats(),fk=flagKeys(),tW=W-ML-MR,rng=Math.max(vpR-vpL,1);
  const xOf=ms=>ML+((ms-vpL)/rng)*tW;
  const msOf=x=>vpL+((x-ML)/tW)*rng;

  // Time axis
  c.strokeStyle='#30363d';c.lineWidth=1;
  c.beginPath();c.moveTo(ML,MT-6);c.lineTo(ML+tW,MT-6);c.stroke();
  const tk=nice(rng),t0=Math.floor(vpL/tk)*tk;
  c.fillStyle='#484f58';c.font='8px monospace';c.textAlign='center';
  for(let t=t0;t<=vpR;t+=tk){const x=xOf(t);if(x<ML-5||x>ML+tW+5)continue;c.beginPath();c.moveTo(x,MT-10);c.lineTo(x,MT-2);c.stroke();c.fillText(fmt(t),x,MT-12)}

  let y=MT;

  // Flag lanes
  for(const fl of fk){
    const spans=fspans[fl];
    c.fillStyle='#8b949e';c.font='8px monospace';c.textAlign='right';
    c.fillText(fl,ML-3,y+FH/2+3);
    c.fillStyle='#161b2225';c.fillRect(ML,y,tW,FH);
    for(const sp of spans){
      const x1=xOf(sp.startMs),x2=xOf(sp.endMs!=null?sp.endMs:totalMs);
      const xl=Math.max(x1,ML),xr=Math.min(x2,ML+tW);
      if(xr<ML||xl>ML+tW)continue;
      c.fillStyle=sp.color+'44';c.fillRect(xl,y+2,Math.max(xr-xl,2),FH-4);
      c.fillStyle=sp.color;c.fillRect(xl,y+1,2,FH-2);
      if(sp.endMs!=null)c.fillRect(xr-1,y+1,2,FH-2);
    }
    y+=FH;
  }
  if(fk.length)y+=3;

  // State-dimension lanes
  const sk=sdKeys();
  for(const dk of sk){
    const spans=sdSpans[dk],def=SD[dk],lbl=def?def.label:dk;
    c.fillStyle='#8b949e';c.font='8px monospace';c.textAlign='right';
    c.fillText(lbl,ML-3,y+FH/2+3);
    c.fillStyle='#161b2218';c.fillRect(ML,y,tW,FH);
    for(const sp of spans){
      if(sp.color==='#484f58')continue; // skip idle/none — just background
      const x1=xOf(sp.startMs),x2=xOf(sp.endMs!=null?sp.endMs:totalMs);
      const xl=Math.max(x1,ML),xr=Math.min(x2,ML+tW);
      if(xr<ML||xl>ML+tW)continue;
      c.fillStyle=sp.color+'55';c.fillRect(xl,y+2,Math.max(xr-xl,2),FH-4);
      c.fillStyle=sp.color;c.fillRect(xl,y+1,2,FH-2);
      if(sp.endMs!=null)c.fillRect(xr-1,y+1,2,FH-2);
      // Value label if span wide enough
      const w=xr-xl;
      if(w>28){c.fillStyle=sp.color;c.font='7px monospace';c.textAlign='left';c.fillText(sp.value,xl+4,y+FH/2+2)}
    }
    y+=FH;
  }
  if(sk.length)y+=3;

  // Category lanes
  for(let ci=0;ci<cs.length;ci++){
    const cat=cs[ci],yB=y+ci*LH,col=CC[cat]||'#484f58';
    c.fillStyle=col;c.font='8px monospace';c.textAlign='right';
    c.fillText(cat,ML-3,yB+LH/2+3);
    c.fillStyle=ci%2?'#161b2230':'#161b2218';c.fillRect(ML,yB,tW,LH);

    for(const ev of evts){
      if(ev.cat!==cat)continue;
      const x=xOf(ev.ms);
      if(x<ML-8||x>ML+tW+8)continue;
      // Base tick
      c.fillStyle=col+'77';c.fillRect(x-.5,yB+4,1,LH-8);
      // Markers
      for(const mk of ev.markers)drawMk(c,mk.s,x,yB+LH/2,mk.c);
    }
  }

  // Vertical guides
  const guideSet=new Set(['Abort','DlgBegin','DlgEnd','SIGKILL','Timeout','RejectDlg','Interrupt']);
  c.save();c.globalAlpha=.15;
  for(const ev of evts)for(const mk of ev.markers){
    if(!guideSet.has(mk.l))continue;
    const x=xOf(ev.ms);if(x<ML||x>ML+tW)continue;
    c.strokeStyle=mk.c;c.lineWidth=1;c.setLineDash([2,3]);
    c.beginPath();c.moveTo(x,MT);c.lineTo(x,y+cs.length*LH);c.stroke();c.setLineDash([]);
  }
  c.restore();

  cv._L={cs,fk,sk,tW,xOf,msOf,y,rng};
  zi.textContent=fmt(vpL)+' – '+fmt(vpR)+' ('+Math.round(rng/Math.max(totalMs,1)*100)+'%)';
}

function drawMk(c,s,x,y,col){
  c.fillStyle=col;c.strokeStyle=col;c.lineWidth=1.5;const S=3.5;
  switch(s){
  case'diamond':c.beginPath();c.moveTo(x,y-S);c.lineTo(x+S,y);c.lineTo(x,y+S);c.lineTo(x-S,y);c.closePath();c.fill();break;
  case'arrow-r':c.beginPath();c.moveTo(x-2,y-S);c.lineTo(x+S,y);c.lineTo(x-2,y+S);c.closePath();c.fill();break;
  case'bar-start':c.fillRect(x,y-S,2,S*2);c.fillRect(x,y-S,5,1.5);c.fillRect(x,y+S-1.5,5,1.5);break;
  case'bar-end':c.fillRect(x,y-S,2,S*2);c.fillRect(x-4,y-S,5,1.5);c.fillRect(x-4,y+S-1.5,5,1.5);break;
  case'tick':c.beginPath();c.moveTo(x,y-S);c.lineTo(x,y+S);c.stroke();break;
  case'triangle':c.beginPath();c.moveTo(x,y-S);c.lineTo(x+S,y+S-1);c.lineTo(x-S,y+S-1);c.closePath();c.fill();break;
  case'dot':c.beginPath();c.arc(x,y,2.5,0,Math.PI*2);c.fill();break;
  case'star':{c.beginPath();for(let i=0;i<10;i++){const r=i%2?S/2:S,a=i*Math.PI/5-Math.PI/2;const px=x+Math.cos(a)*r,py=y+Math.sin(a)*r;i?c.lineTo(px,py):c.moveTo(px,py)}c.closePath();c.fill();break}
  case'cross':c.beginPath();c.moveTo(x-S,y-S);c.lineTo(x+S,y+S);c.stroke();c.beginPath();c.moveTo(x+S,y-S);c.lineTo(x-S,y+S);c.stroke();break;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Minimap
// ──────────────────────────────────────────────────────────────────────────
function paintMM(){
  const W=mmCv.width/dpr,H=mmCv.height/dpr;
  mc.clearRect(0,0,W,H);if(!evts.length)return;
  const tMax=Math.max(totalMs,1);
  for(const ev of evts){
    const x=(ev.ms/tMax)*W;mc.fillStyle=(CC[ev.cat]||'#484f58')+'66';
    mc.fillRect(x,0,Math.max(1,1),H);
  }
  const vl=(vpL/tMax)*W,vr=(vpR/tMax)*W;
  mmVp.style.left=Math.max(vl,0)+'px';mmVp.style.width=Math.max(vr-vl,3)+'px';
}

// ──────────────────────────────────────────────────────────────────────────
// Zoom & Pan
// ──────────────────────────────────────────────────────────────────────────
function zoomAt(ctr,f){const r=vpR-vpL,nr=Math.max(r*f,5),ratio=(ctr-vpL)/r;vpL=ctr-ratio*nr;vpR=vpL+nr;clamp();paint();paintMM()}
function panMs(d){vpL+=d;vpR+=d;clamp();paint();paintMM()}
function fitAll(){vpL=0;vpR=Math.max(totalMs*1.05,100);paint();paintMM()}
function clamp(){const r=vpR-vpL,mx=totalMs*1.1;if(vpL<-r*.1)vpL=-r*.1;if(vpR>mx+r*.1){vpR=mx+r*.1;vpL=vpR-r}}

cv.addEventListener('wheel',e=>{
  e.preventDefault();if(!cv._L)return;
  const ms=cv._L.msOf(e.clientX-cv.getBoundingClientRect().left);
  if(e.ctrlKey||e.metaKey||Math.abs(e.deltaY)>Math.abs(e.deltaX)){
    zoomAt(ms,e.deltaY>0?1.15:.87);
  }else{panMs(e.deltaX*(vpR-vpL)*.001)}
},{passive:false});

let drag=null;
cv.addEventListener('mousedown',e=>{if(e.button===1||(e.button===0&&e.shiftKey)){drag={x:e.clientX,l:vpL,r:vpR};e.preventDefault()}});
addEventListener('mousemove',e=>{if(drag){const dx=e.clientX-drag.x,r=cv.getBoundingClientRect(),mpp=(drag.r-drag.l)/(r.width-ML-MR);vpL=drag.l-dx*mpp;vpR=vpL+(drag.r-drag.l);clamp();paint();paintMM()}});
addEventListener('mouseup',()=>{drag=null});
mmW.addEventListener('click',e=>{const f=(e.clientX-mmW.getBoundingClientRect().left)/mmW.getBoundingClientRect().width,r=vpR-vpL,ctr=f*totalMs;vpL=ctr-r/2;vpR=vpL+r;clamp();paint();paintMM()});
document.getElementById('fit-btn').onclick=fitAll;
document.getElementById('zin-btn').onclick=()=>zoomAt((vpL+vpR)/2,.5);
document.getElementById('zout-btn').onclick=()=>zoomAt((vpL+vpR)/2,2);

// ──────────────────────────────────────────────────────────────────────────
// Cursor + tooltip + state bar
// ──────────────────────────────────────────────────────────────────────────
cv.addEventListener('mousemove',e=>{
  if(drag)return;
  if(!cv._L||!evts.length){tip.style.display=cLine.style.display=cTime.style.display='none';return}
  const rect=cv.getBoundingClientRect(),mx=e.clientX-rect.left,my=e.clientY-rect.top;
  const{cs,tW,xOf,msOf,y}=cv._L;

  // Cursor
  if(mx>=ML&&mx<=ML+tW){
    cLine.style.display='block';cLine.style.left=mx+'px';
    const ms=msOf(mx);cTime.style.display='block';cTime.style.left=(mx+4)+'px';cTime.textContent=fmt(ms);
    updateState(ms);
  }else{cLine.style.display=cTime.style.display='none'}

  // Tooltip — nearest event
  let best=null,bd=14;
  for(const ev of evts){
    const x=xOf(ev.ms),ci=cs.indexOf(ev.cat);if(ci<0)continue;
    const ey=y+ci*LH+LH/2;const d=Math.hypot(mx-x,my-ey);
    if(d<bd){bd=d;best=ev}
  }
  if(best){
    let t=fmt(best.ms)+'  ['+best.cat+']\\n'+best.msg;
    if(best.markers.length)t+='\\n\\u2500\\u2500 '+best.markers.map(m=>m.l).join(', ');
    if(best.tags.length)t+='\\n\\u2500\\u2500 '+best.tags.map(t=>t.text).join(' | ');
    tip.textContent=t;tip.style.display='block';
    tip.style.left=Math.min(mx+12,rect.width-450)+'px';
    tip.style.top=Math.min(my+12,rect.height-80)+'px';
  }else{tip.style.display='none'}
});
cv.addEventListener('mouseleave',()=>{tip.style.display=cLine.style.display=cTime.style.display='none'});

function updateState(ms){
  stT.textContent=fmt(ms);
  // Flags at this time
  let fh='';
  for(const[lb,spans]of Object.entries(fspans)){
    let on=false;
    for(const sp of spans)if(ms>=sp.startMs&&(sp.endMs==null||ms<=sp.endMs)){on=true;break}
    fh+='<span class="'+(on?'st-on':'st-off')+'">'+esc(lb)+'='+(on?'ON':'off')+'</span>  ';
  }
  // State dimensions at this time
  for(const dk of Object.keys(SD)){
    const spans=sdSpans[dk];
    if(!spans)continue;
    let cur=null;
    for(const sp of spans)if(ms>=sp.startMs&&(sp.endMs==null||ms<=sp.endMs)){cur=sp;break}
    const val=cur?cur.value:'?';
    const col=cur?cur.color:'#484f58';
    fh+='<span style="color:'+col+'">'+esc(SD[dk].label)+'='+esc(val)+'</span>  ';
  }
  stFl.innerHTML=fh;
  // Last activity
  let last=null;for(const e of evts)if(e.ms<=ms)last=e;
  stAct.textContent=last?'['+last.cat+'] '+last.msg.substring(0,90):'';
}

// Click to select
cv.addEventListener('click',e=>{
  if(drag)return;if(!cv._L||!evts.length)return;
  const rect=cv.getBoundingClientRect(),mx=e.clientX-rect.left,my=e.clientY-rect.top;
  const{cs,xOf,y}=cv._L;
  let best=null,bd=14;
  for(const ev of evts){const x=xOf(ev.ms),ci=cs.indexOf(ev.cat);if(ci<0)continue;const ey=y+ci*LH+LH/2;const d=Math.hypot(mx-x,my-ey);if(d<bd){bd=d;best=ev}}
  if(best&&best._li!=null){
    logP.querySelectorAll('.sel').forEach(el=>el.classList.remove('sel'));
    const el=logP.children[best._li];
    if(el){el.classList.add('sel');el.scrollIntoView({behavior:'smooth',block:'center'})}
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Log panel
// ──────────────────────────────────────────────────────────────────────────
function addLog(o){
  const d=document.createElement('div');
  d.className='log-line '+(o.cls||'');
  let h='<span style="color:#484f58">'+String(Math.round(o.ms)).padStart(7)+'</span>  '+esc(o.text);
  if(o.tags)for(const t of o.tags)h+=' <span class="tag t-'+t.tag+'">'+esc(t.text)+'</span>';
  d.innerHTML=h;
  if(o.ei!=null)d.addEventListener('click',()=>{
    logP.querySelectorAll('.sel').forEach(el=>el.classList.remove('sel'));d.classList.add('sel');
    const ev=evts[o.ei];if(ev&&cv._L){const r=vpR-vpL;vpL=ev.ms-r/2;vpR=vpL+r;clamp();paint();paintMM()}
  });
  logP.appendChild(d);logP.scrollTop=logP.scrollHeight;
}

// ──────────────────────────────────────────────────────────────────────────
// Run test
// ──────────────────────────────────────────────────────────────────────────
runB.addEventListener('click',()=>{
  if(running)return;running=true;runB.disabled=true;
  evts=[];fspans={};sdSpans={};logP.innerHTML='';totalMs=1000;vpL=0;vpR=1000;

  const tn=tsel.value;statE.textContent='Running M'+tn+'...';
  const src=new EventSource('/run?test='+tn);

  src.addEventListener('start',e=>{const d=JSON.parse(e.data);addLog({ms:0,text:'\\u2500\\u2500 Test M'+d.testNum+' started \\u2500\\u2500',cls:'c-stdout'})});

  src.addEventListener('diag',e=>{
    const d=JSON.parse(e.data);
    const ev={ms:d.ms,cat:d.cat,msg:d.msg,markers:[],tags:[],_li:logP.children.length};
    for(const mk of MK)if(mk.r.test(d.msg))ev.markers.push({l:mk.l,c:mk.c,s:mk.s});
    for(const tr of TR){const m=d.msg.match(tr.r);if(m)ev.tags.push({tag:tr.t,text:tr.f(m)})}
    for(const fd of FD){
      if(fd.onRe.test(d.msg)){if(!fspans[fd.label])fspans[fd.label]=[];fspans[fd.label].push({startMs:d.ms,endMs:null,color:fd.onC})}
      if(fd.offRe.test(d.msg)&&fspans[fd.label]){const o=fspans[fd.label].findLast(s=>s.endMs==null);if(o)o.endMs=d.ms}
    }
    // State-dimension spans: [State:<dim>] Old -> New (caller)
    const sm=d.cat.match(/^State:(\w+)$/);
    if(sm){
      const dk=sm[1],def=SD[dk];
      if(def){
        const vm=d.msg.match(/^(\w+)\s*->\s*(\w+)/);
        if(vm){
          const newVal=vm[2],col=def.colors[newVal]||'#8b949e';
          if(!sdSpans[dk])sdSpans[dk]=[];
          const prev=sdSpans[dk].findLast(s=>s.endMs==null);
          if(prev)prev.endMs=d.ms;
          sdSpans[dk].push({startMs:d.ms,endMs:null,color:col,value:newVal});
        }
      }
    }
    const idx=evts.length;evts.push(ev);
    if(d.ms>totalMs){totalMs=d.ms*1.1;vpR=Math.max(vpR,totalMs)}
    addLog({ms:d.ms,text:'['+d.cat+'] '+d.msg,cls:'c-'+d.cat,tags:ev.tags,ei:idx});
    paint();paintMM();
  });

  src.addEventListener('result',e=>{const d=JSON.parse(e.data);addLog({ms:d.ms,text:d.line,cls:d.pass?'c-pass':'c-fail'})});
  src.addEventListener('stdout',e=>{const d=JSON.parse(e.data);addLog({ms:d.ms,text:d.line,cls:'c-stdout'})});
  src.addEventListener('stderr',e=>{const d=JSON.parse(e.data);addLog({ms:d.ms,text:d.line,cls:'c-stderr'})});

  src.addEventListener('done',e=>{
    const d=JSON.parse(e.data);
    const ok=d.code===0;
    statE.textContent=(ok?'\\u2713 PASSED':'\\u2717 FAILED (exit '+d.code+')')+' \\u2014 '+fmt(d.ms);
    addLog({ms:d.ms,text:'\\u2500\\u2500 '+(ok?'PASSED':'FAILED')+' \\u2500\\u2500',cls:ok?'c-pass':'c-fail'});
    for(const spans of Object.values(fspans))for(const sp of spans)if(sp.endMs==null)sp.endMs=d.ms;
    src.close();running=false;runB.disabled=false;fitAll();
  });

  src.addEventListener('error',()=>{statE.textContent='Connection lost';src.close();running=false;runB.disabled=false});
});

// Keyboard
document.addEventListener('keydown',e=>{
  if(e.key==='f'||e.key==='Home'){fitAll();e.preventDefault()}
  if(e.key==='+'||e.key==='='){zoomAt((vpL+vpR)/2,.7);e.preventDefault()}
  if(e.key==='-'){zoomAt((vpL+vpR)/2,1.4);e.preventDefault()}
  if(e.key==='ArrowLeft'){panMs(-(vpR-vpL)*.15);e.preventDefault()}
  if(e.key==='ArrowRight'){panMs((vpR-vpL)*.15);e.preventDefault()}
});

requestAnimationFrame(resize);
</script></body></html>`;
