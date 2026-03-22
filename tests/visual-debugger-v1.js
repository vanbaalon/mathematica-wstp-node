'use strict';
// ── visual-debugger.js — browser-based timeline test debugger ──────────
// Usage:  node tests/visual-debugger.js
// Opens http://localhost:9111 — pick a mini-test and see a live timeline.

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const ms = Date.now() - t0;
            if (/✓/.test(trimmed)) {
                send('result', { ms, line: trimmed, pass: true });
            } else if (/✗/.test(trimmed)) {
                send('result', { ms, line: trimmed, pass: false });
            } else {
                send('stdout', { ms, line: trimmed });
            }
        }
    });

    child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const ms = Date.now() - t0;
            // Parse diag lines: [diag HH:MM:SS.mmm] [Category] message
            const m = trimmed.match(/^\[diag\s+([\d:.]+)\]\s+\[([^\]]+)\]\s+(.*)/);
            if (m) {
                send('diag', { ms, ts: m[1], cat: m[2], msg: m[3] });
            } else {
                send('stderr', { ms, line: trimmed });
            }
        }
    });

    child.on('close', (code) => {
        send('done', { ms: Date.now() - t0, code, stdout, stderr });
        res.end();
    });

    child.on('error', (err) => {
        send('error', { ms: Date.now() - t0, error: err.message });
        res.end();
    });

    // Kill child if client disconnects
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
    console.log(`\n  Visual Test Debugger → http://localhost:${PORT}\n`);
});

// ── HTML page (inline) ───────────────────────────────────────────────────
const HTML_PAGE = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WSTP Visual Test Debugger</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0d1117; color: #c9d1d9; }
header { padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 16px; }
header h1 { font-size: 15px; font-weight: 600; color: #58a6ff; }
select, button { font-family: inherit; font-size: 13px; padding: 5px 12px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; }
button { background: #238636; border-color: #238636; color: #fff; font-weight: 600; }
button:hover { background: #2ea043; }
button:disabled { opacity: 0.5; cursor: default; }
#status { font-size: 12px; color: #8b949e; }

/* Layout */
#container { display: flex; height: calc(100vh - 48px); }
#timeline-panel { flex: 1; overflow: hidden; position: relative; }
#log-panel { width: 420px; border-left: 1px solid #30363d; overflow-y: auto; padding: 8px; font-size: 11px; }

/* Timeline */
canvas { display: block; width: 100%; height: 100%; }

/* Logs */
.log-line { padding: 1px 4px; white-space: pre-wrap; word-break: break-all; border-radius: 3px; }
.log-line:hover { background: #161b22; }
.log-line.selected { background: #1f3a5f; }
.log-cat-Eval { color: #79c0ff; }
.log-cat-DynRead { color: #a5d6ff; }
.log-cat-drainEndDlg { color: #d2a8ff; }
.log-cat-when-idle { color: #ffa657; }
.log-cat-subAuto { color: #7ee787; }
.log-cat-WarmUp { color: #8b949e; }
.log-cat-Session { color: #f0883e; }
.log-cat-CleanUp { color: #f85149; }
.log-cat-SDR { color: #db61a2; }
.log-cat-Dialog { color: #f778ba; }
.log-cat-stdout { color: #e6edf3; }
.log-cat-result-pass { color: #3fb950; font-weight: bold; }
.log-cat-result-fail { color: #f85149; font-weight: bold; }

/* Legend */
#legend { position: absolute; top: 8px; right: 8px; background: #161b22ee; border: 1px solid #30363d; border-radius: 8px; padding: 8px 12px; font-size: 11px; }
#legend div { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
#legend span.swatch { display: inline-block; width: 14px; height: 10px; border-radius: 2px; }

/* Tooltip */
#tooltip { position: absolute; display: none; background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; font-size: 11px; max-width: 500px; pointer-events: none; z-index: 10; white-space: pre-wrap; word-break: break-all; box-shadow: 0 4px 12px #00000088; }
</style>
</head>
<body>
<header>
    <h1>WSTP Visual Test Debugger</h1>
    <select id="test-select">
        <option value="1">M1 — basic eval sanity</option>
        <option value="2">M2 — abort + session survives</option>
        <option value="3">M3 — abort after stuck dialog</option>
        <option value="4">M4 — abort then Dynamic eval recovers</option>
        <option value="5">M5 — stale interrupt aborts eval</option>
        <option value="6">M6 — rapid cell transitions with Dynamic</option>
        <option value="7" selected>M7 — post-eval idle subAuto hang</option>
        <option value="8">M8 — busy-path subAuto after ScheduledTask</option>
    </select>
    <button id="run-btn">▶ Run</button>
    <span id="status"></span>
</header>
<div id="container">
    <div id="timeline-panel">
        <canvas id="canvas"></canvas>
        <div id="legend"></div>
        <div id="tooltip"></div>
    </div>
    <div id="log-panel" id="logs"></div>
</div>

<script>
// ── Color map for event categories ─────────────────────────────────────
const CAT_COLORS = {
    'Eval':         '#79c0ff',
    'DynRead':      '#a5d6ff',
    'drainEndDlg':  '#d2a8ff',
    'when-idle':    '#ffa657',
    'subAuto':      '#7ee787',
    'WarmUp':       '#8b949e',
    'Session':      '#f0883e',
    'CleanUp':      '#f85149',
    'SDR':          '#db61a2',
    'Dialog':       '#f778ba',
};

// ── Keyword-based sub-categories for special visual treatment ──────────
const KEYWORD_MARKERS = [
    { pattern: /abort/i,              label: 'Abort',            color: '#f85149', shape: 'diamond' },
    { pattern: /WSInterruptMessage/i, label: 'Interrupt',        color: '#d29922', shape: 'diamond' },
    { pattern: /EvaluatePacket/i,     label: 'EvaluatePacket',   color: '#58a6ff', shape: 'arrow-r' },
    { pattern: /EnterTextPacket/i,    label: 'EnterTextPacket',  color: '#bc8cff', shape: 'arrow-r' },
    { pattern: /BEGINDLGPKT/i,       label: 'Dialog Begin',     color: '#f778ba', shape: 'bar-start' },
    { pattern: /ENDDLGPKT/i,         label: 'Dialog End',       color: '#f778ba', shape: 'bar-end' },
    { pattern: /RETURNPKT|pkt=3\b/,  label: 'ReturnPkt',        color: '#3fb950', shape: 'tick' },
    { pattern: /RETURNEXPRPKT|pkt=4\b/, label: 'ReturnExprPkt', color: '#56d364', shape: 'tick' },
    { pattern: /MENUPKT|pkt=6\b/,    label: 'MenuPkt',          color: '#d29922', shape: 'triangle' },
    { pattern: /INPUTNAMEPKT|pkt=9\b/, label: 'InputNamePkt',   color: '#8b949e', shape: 'dot' },
    { pattern: /\\$wstpDynTaskStop/,  label: 'DynTaskStop flag', color: '#f85149', shape: 'flag' },
    { pattern: /ScheduledTask/i,      label: 'ScheduledTask',   color: '#ffa657', shape: 'star' },
    { pattern: /rejectDialog/i,       label: 'RejectDialog',    color: '#ff7b72', shape: 'cross' },
    { pattern: /TIMEOUT/i,            label: 'Timeout',         color: '#f85149', shape: 'cross' },
    { pattern: /SIGKILL/i,            label: 'SIGKILL',         color: '#ff0000', shape: 'cross' },
    { pattern: /drainStale/i,         label: 'DrainStale',      color: '#c9d1d9', shape: 'dot' },
];

const FLAG_PATTERNS = [
    { pattern: /\\$wstpDynTaskStop\s*=\s*True/i, label: '$wstpDynTaskStop=True', color: '#f85149' },
    { pattern: /\\$wstpDynTaskStop\s*=\s*\./i,   label: '$wstpDynTaskStop=.',    color: '#3fb950' },
];

// ── State ─────────────────────────────────────────────────────────────────
let events = [];     // { ms, cat, msg, markers: [{label, color, shape}], flags: [{label, color}] }
let logEntries = []; // for the log panel
let running = false;
let maxMs = 1000;

// ── DOM ───────────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const ctx      = canvas.getContext('2d');
const logPanel = document.getElementById('log-panel');
const tooltip  = document.getElementById('tooltip');
const legend   = document.getElementById('legend');
const status   = document.getElementById('status');
const runBtn   = document.getElementById('run-btn');
const testSel  = document.getElementById('test-select');

// ── Legend ─────────────────────────────────────────────────────────────────
function buildLegend() {
    let html = '<div style="margin-bottom:4px;font-weight:600;color:#58a6ff;">Categories</div>';
    for (const [cat, col] of Object.entries(CAT_COLORS)) {
        html += '<div><span class="swatch" style="background:' + col + '"></span>' + cat + '</div>';
    }
    html += '<div style="margin-top:6px;margin-bottom:4px;font-weight:600;color:#58a6ff;">Markers</div>';
    const seen = new Set();
    for (const km of KEYWORD_MARKERS) {
        if (seen.has(km.label)) continue;
        seen.add(km.label);
        html += '<div><span class="swatch" style="background:' + km.color + '"></span>' + km.label + '</div>';
    }
    legend.innerHTML = html;
}
buildLegend();

// ── Canvas sizing ─────────────────────────────────────────────────────────
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
}
window.addEventListener('resize', resizeCanvas);

// ── Drawing ───────────────────────────────────────────────────────────────
const MARGIN_L = 70;
const MARGIN_R = 20;
const MARGIN_T = 40;
const ROW_H = 7;
const CAT_ROW_H = 22;

function catOrder() {
    const cats = [];
    const seen = new Set();
    for (const e of events) {
        if (!seen.has(e.cat)) { seen.add(e.cat); cats.push(e.cat); }
    }
    return cats;
}

function draw() {
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, W, H);

    if (events.length === 0) {
        ctx.fillStyle = '#484f58';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Select a test and click ▶ Run', W / 2, H / 2);
        return;
    }

    const cats = catOrder();
    const tW = W - MARGIN_L - MARGIN_R;
    const tMax = Math.max(maxMs, 100);
    const xOf = (ms) => MARGIN_L + (ms / tMax) * tW;

    // ── Time axis ──────────────────────────────────────────────────────
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN_L, MARGIN_T - 10);
    ctx.lineTo(MARGIN_L + tW, MARGIN_T - 10);
    ctx.stroke();

    // Tick marks
    const tickInterval = niceInterval(tMax);
    ctx.fillStyle = '#484f58';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (let t = 0; t <= tMax; t += tickInterval) {
        const x = xOf(t);
        ctx.beginPath();
        ctx.moveTo(x, MARGIN_T - 14);
        ctx.lineTo(x, MARGIN_T - 6);
        ctx.stroke();
        ctx.fillText(fmtMs(t), x, MARGIN_T - 16);
    }

    // ── Category swim lanes ────────────────────────────────────────────
    for (let ci = 0; ci < cats.length; ci++) {
        const cat = cats[ci];
        const yBase = MARGIN_T + ci * CAT_ROW_H;
        const color = CAT_COLORS[cat] || '#484f58';

        // Lane label
        ctx.fillStyle = color;
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(cat, MARGIN_L - 6, yBase + ROW_H + 3);

        // Lane background
        ctx.fillStyle = '#161b2240';
        ctx.fillRect(MARGIN_L, yBase, tW, CAT_ROW_H - 2);

        // Events in this category
        const catEvents = events.filter(e => e.cat === cat);
        for (const ev of catEvents) {
            const x = xOf(ev.ms);

            // Base event dot
            ctx.fillStyle = color + 'aa';
            ctx.fillRect(x - 1, yBase + 2, 3, ROW_H);

            // Keyword markers
            for (const mk of ev.markers) {
                drawMarker(ctx, mk.shape, x, yBase + ROW_H / 2 + 2, mk.color);
            }
        }

        // Flag spans (red/green lines)
        for (const ev of catEvents) {
            for (const fl of ev.flags) {
                const x = xOf(ev.ms);
                ctx.strokeStyle = fl.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, yBase);
                ctx.lineTo(x, yBase + CAT_ROW_H - 2);
                ctx.stroke();
                ctx.lineWidth = 1;
            }
        }
    }

    // ── Vertical guide lines for major events (Abort, Dialog, ScheduledTask) ──
    ctx.save();
    ctx.globalAlpha = 0.15;
    for (const ev of events) {
        for (const mk of ev.markers) {
            if (['Abort', 'Dialog Begin', 'Dialog End', 'SIGKILL', 'Timeout', 'RejectDialog'].includes(mk.label)) {
                const x = xOf(ev.ms);
                ctx.strokeStyle = mk.color;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(x, MARGIN_T);
                ctx.lineTo(x, MARGIN_T + cats.length * CAT_ROW_H);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    }
    ctx.restore();

    // Store layout for hit-testing
    canvas._layout = { cats, tMax, tW, xOf };
}

function drawMarker(ctx, shape, x, y, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    switch (shape) {
        case 'diamond':
            ctx.beginPath();
            ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.closePath();
            ctx.fill();
            break;
        case 'arrow-r':
            ctx.beginPath();
            ctx.moveTo(x - 3, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x - 3, y + 4);
            ctx.closePath(); ctx.fill();
            break;
        case 'bar-start':
            ctx.fillRect(x, y - 5, 2, 10);
            ctx.fillRect(x, y - 5, 6, 2);
            ctx.fillRect(x, y + 3, 6, 2);
            break;
        case 'bar-end':
            ctx.fillRect(x, y - 5, 2, 10);
            ctx.fillRect(x - 4, y - 5, 6, 2);
            ctx.fillRect(x - 4, y + 3, 6, 2);
            break;
        case 'tick':
            ctx.beginPath();
            ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - 3, y + 2); ctx.lineTo(x, y + 5); ctx.lineTo(x + 3, y + 2); ctx.stroke();
            break;
        case 'triangle':
            ctx.beginPath();
            ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y + 3); ctx.lineTo(x - 4, y + 3);
            ctx.closePath(); ctx.fill();
            break;
        case 'dot':
            ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
            break;
        case 'flag':
            ctx.beginPath();
            ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y - 5); ctx.lineTo(x + 6, y - 3); ctx.lineTo(x, y - 1);
            ctx.closePath(); ctx.fill();
            break;
        case 'star':
            drawStar(ctx, x, y, 5, 4, 2);
            break;
        case 'cross':
            ctx.beginPath();
            ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
            break;
    }
}

function drawStar(ctx, cx, cy, spikes, outerR, innerR) {
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const angle = (i * Math.PI) / spikes - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
}

function niceInterval(maxMs) {
    const raw = maxMs / 8;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    if (norm <= 1) return mag;
    if (norm <= 2) return 2 * mag;
    if (norm <= 5) return 5 * mag;
    return 10 * mag;
}

function fmtMs(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
    return ms + 'ms';
}

// ── Tooltip (hover) ───────────────────────────────────────────────────────
canvas.addEventListener('mousemove', (e) => {
    if (!canvas._layout || events.length === 0) { tooltip.style.display = 'none'; return; }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { cats, tMax, tW, xOf } = canvas._layout;

    // Find closest event
    let best = null, bestDist = 20;
    for (const ev of events) {
        const ci = cats.indexOf(ev.cat);
        if (ci < 0) continue;
        const ex = xOf(ev.ms);
        const ey = MARGIN_T + ci * CAT_ROW_H + ROW_H / 2 + 2;
        const d = Math.hypot(mx - ex, my - ey);
        if (d < bestDist) { bestDist = d; best = ev; }
    }

    if (best) {
        const markers = best.markers.map(m => m.label).join(', ');
        const flags = best.flags.map(f => f.label).join(', ');
        let text = best.ms + 'ms [' + best.cat + ']\\n' + best.msg;
        if (markers) text += '\\n── markers: ' + markers;
        if (flags) text += '\\n── flags: ' + flags;
        tooltip.textContent = text;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(e.clientX - rect.left + 10, rect.width - 400) + 'px';
        tooltip.style.top = (e.clientY - rect.top + 10) + 'px';
    } else {
        tooltip.style.display = 'none';
    }
});
canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

// ── Click to highlight in log ─────────────────────────────────────────────
canvas.addEventListener('click', (e) => {
    if (!canvas._layout || events.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { cats, xOf } = canvas._layout;

    let best = null, bestDist = 20;
    for (const ev of events) {
        const ci = cats.indexOf(ev.cat);
        if (ci < 0) continue;
        const ex = xOf(ev.ms);
        const ey = MARGIN_T + ci * CAT_ROW_H + ROW_H / 2 + 2;
        const d = Math.hypot(mx - ex, my - ey);
        if (d < bestDist) { bestDist = d; best = ev; }
    }

    if (best && best._logIdx != null) {
        document.querySelectorAll('.log-line.selected').forEach(el => el.classList.remove('selected'));
        const el = logPanel.children[best._logIdx];
        if (el) {
            el.classList.add('selected');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
});

// ── Log panel ─────────────────────────────────────────────────────────────
function addLog(entry) {
    logEntries.push(entry);
    const div = document.createElement('div');
    div.className = 'log-line ' + (entry.cssClass || '');
    const msStr = String(entry.ms).padStart(6);
    div.textContent = msStr + '  ' + entry.text;
    logPanel.appendChild(div);
    logPanel.scrollTop = logPanel.scrollHeight;
}

// ── Run test ──────────────────────────────────────────────────────────────
runBtn.addEventListener('click', () => {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    events = [];
    logEntries = [];
    logPanel.innerHTML = '';
    maxMs = 1000;

    const testNum = testSel.value;
    status.textContent = 'Running M' + testNum + '...';

    const src = new EventSource('/run?test=' + testNum);

    src.addEventListener('start', (e) => {
        const d = JSON.parse(e.data);
        addLog({ ms: 0, text: '── Test M' + d.testNum + ' started ──', cssClass: 'log-cat-stdout' });
    });

    src.addEventListener('diag', (e) => {
        const d = JSON.parse(e.data);
        const ev = {
            ms: d.ms,
            cat: d.cat,
            msg: d.msg,
            markers: [],
            flags: [],
            _logIdx: logEntries.length,
        };
        // Match keyword markers
        for (const km of KEYWORD_MARKERS) {
            if (km.pattern.test(d.msg)) {
                ev.markers.push({ label: km.label, color: km.color, shape: km.shape });
            }
        }
        // Match flags
        for (const fp of FLAG_PATTERNS) {
            if (fp.pattern.test(d.msg)) {
                ev.flags.push({ label: fp.label, color: fp.color });
            }
        }
        events.push(ev);
        if (d.ms > maxMs) maxMs = d.ms * 1.1;
        addLog({ ms: d.ms, text: '[' + d.cat + '] ' + d.msg, cssClass: 'log-cat-' + d.cat });
        draw();
    });

    src.addEventListener('result', (e) => {
        const d = JSON.parse(e.data);
        addLog({ ms: d.ms, text: d.line, cssClass: d.pass ? 'log-cat-result-pass' : 'log-cat-result-fail' });
    });

    src.addEventListener('stdout', (e) => {
        const d = JSON.parse(e.data);
        addLog({ ms: d.ms, text: d.line, cssClass: 'log-cat-stdout' });
    });

    src.addEventListener('stderr', (e) => {
        const d = JSON.parse(e.data);
        addLog({ ms: d.ms, text: d.line, cssClass: '' });
    });

    src.addEventListener('done', (e) => {
        const d = JSON.parse(e.data);
        const result = d.code === 0 ? '✓ PASSED' : '✗ FAILED (exit ' + d.code + ')';
        status.textContent = result + ' — ' + fmtMs(d.ms);
        addLog({ ms: d.ms, text: '── ' + result + ' ──', cssClass: d.code === 0 ? 'log-cat-result-pass' : 'log-cat-result-fail' });
        src.close();
        running = false;
        runBtn.disabled = false;
        draw();
    });

    src.addEventListener('error', () => {
        status.textContent = 'Connection lost';
        src.close();
        running = false;
        runBtn.disabled = false;
    });
});

// ── Initial draw ──────────────────────────────────────────────────────────
requestAnimationFrame(resizeCanvas);
</script>
</body>
</html>`;
