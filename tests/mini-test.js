'use strict';

// ── mini-test.js — minimal fast diagnostic subset ────────────────────────
// Purpose: quickly verify abort/dialog/interrupt recovery without running
// the full 70-test suite (~5+ min).  Covers the 7 most indicative tests:
//
//   M1  — basic eval (sanity)                         ~2s
//   M2  — abort + session survives                    ~3s
//   M3  — P4: abort after stuck dialog                ~15s
//   M4  — test 48: abort then Dynamic eval recovers   ~8s
//   M5  — test 56: stale interrupt aborts cleanly     ~10s
//   M6  — test 49: rapid cell transitions + Dynamic   ~8s
//   M7  — test 65: post-eval idle subAuto hang         ~15s
//
// Total: ~65s vs ~300s+ for full suite.
//
// Usage:
//   node tests/mini-test.js                    # run all 6
//   node tests/mini-test.js --only 3           # run just M3 (P4)
//   node tests/mini-test.js --only 3,5         # run M3 and M5
//   node tests/mini-test.js 2>/dev/null        # suppress C++ diagnostics

const wstp = require('../build/Release/wstp.node');
const { WstpSession, setDiagHandler, version } = wstp;
const fs = require('fs');
const path = require('path');

const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

// ── Build info ────────────────────────────────────────────────────────────
{
    const nodePath = path.join(__dirname, '../build/Release/wstp.node');
    let mtime = '';
    try { mtime = fs.statSync(nodePath).mtime.toLocaleString(); } catch (_) { mtime = '?'; }
    console.log(`wstp.node version: ${wstp.version || version || '?'}`);
    console.log(`wstp.node build:   ${mtime}\n`);
}

// ── C++ diagnostic channel → stderr ───────────────────────────────────────
setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function pollUntil(condition, timeoutMs = 3000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const id = setInterval(() => {
            if (condition()) { clearInterval(id); resolve(); }
            else if (Date.now() - start > timeoutMs) {
                clearInterval(id);
                reject(new Error('pollUntil timed out'));
            }
        }, intervalMs);
    });
}

function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

async function resilientEval(s, expr, { perAttemptMs = 5000, maxAttempts = 3, label = 'resilientEval' } = {}) {
    let r;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const evalP = s.evaluate(expr);
        try {
            r = await withTimeout(evalP, perAttemptMs, `${label} (attempt ${attempt})`);
            if (!r.aborted) return r;
            await sleep(200);
        } catch (e) {
            if (!/TIMEOUT/i.test(e.message)) throw e;
            try { s.abort(); } catch (_) {}
            try { await withTimeout(evalP, 3000, `${label} abort settle`); } catch (_) {}
            await sleep(200);
        }
    }
    return r;
}

// ── Session management ────────────────────────────────────────────────────
let _lastMkSession = null;
let _mainSession   = null;
function mkSession() {
    const s = new WstpSession(KERNEL_PATH);
    _lastMkSession = s;
    return s;
}

async function installHandler(s) {
    await s.evaluate(
        'Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    );
}

process.on('unhandledRejection', () => {});

// ── Speed calibration ─────────────────────────────────────────────────────
const BASELINE_MS = 3000;
let SPEED = 1;
function T(ms) { return Math.round(ms * SPEED); }

async function calibrate() {
    const t0 = Date.now();
    const cs = new WstpSession(KERNEL_PATH);
    await cs.evaluate('1+1');
    cs.close();
    const elapsed = Date.now() - t0;
    SPEED = Math.max(1, elapsed / BASELINE_MS);
    console.log(`Calibration: ${elapsed} ms → SPEED = ${SPEED.toFixed(2)}×\n`);
}

// ── Watchdog: kill entire process after 120s ──────────────────────────────
const { spawn } = require('child_process');
const _watchdogProc = spawn('sh',
    ['-c', `sleep 120; kill -9 ${process.pid} 2>/dev/null`],
    { stdio: 'ignore', detached: true });
_watchdogProc.unref();

// ── Test filtering ────────────────────────────────────────────────────────
const ONLY_TESTS = (() => {
    const idx = process.argv.indexOf('--only');
    if (idx === -1) return null;
    const spec = process.argv[idx + 1] || '';
    const nums = new Set();
    for (const part of spec.split(',')) {
        const range = part.split('-');
        if (range.length === 2) {
            for (let i = parseInt(range[0]); i <= parseInt(range[1]); i++) nums.add(i);
        } else {
            nums.add(parseInt(part));
        }
    }
    return nums;
})();

function testNum(name) {
    const m = name.match(/^M?(\d+)/);
    return m ? parseInt(m[1]) : NaN;
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failedTests = [];
const TEST_TIMEOUT_MS = 30_000;

async function run(name, fn, timeoutMs = TEST_TIMEOUT_MS) {
    if (ONLY_TESTS !== null && !ONLY_TESTS.has(testNum(name))) {
        skipped++;
        return;
    }
    let timer;
    _lastMkSession = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMED OUT after ${timeoutMs} ms`)),
                   timeoutMs);
    });
    try {
        await Promise.race([fn(), timeout]);
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}: ${e.message}`);
        failed++;
        failedTests.push(name);
        process.exitCode = 1;
        if (/TIMED? OUT/i.test(e.message)) {
            const sess = _lastMkSession || _mainSession;
            if (sess) {
                const pid = sess.kernelPid;
                if (pid > 0) {
                    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
                    console.error(`    → killed kernel pid ${pid}`);
                }
                try { sess.close(); } catch (_) {}
            }
            _lastMkSession = null;
        }
    } finally {
        clearTimeout(timer);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    console.log('mini-test.js — quick diagnostic subset (6 tests)\n');

    // Shared session for M1, M2
    const session = new WstpSession(KERNEL_PATH);
    _mainSession = session;
    assert(session.isOpen, 'session did not open');

    await calibrate();

    // ── M1: basic eval sanity ─────────────────────────────────────────────
    await run('M1. basic eval sanity', async () => {
        const [r1, r2, r3] = await Promise.all([
            session.evaluate('1'),
            session.evaluate('2'),
            session.evaluate('3'),
        ]);
        assert(r1.result.value === 1, `r1: ${JSON.stringify(r1.result)}`);
        assert(r2.result.value === 2, `r2: ${JSON.stringify(r2.result)}`);
        assert(r3.result.value === 3, `r3: ${JSON.stringify(r3.result)}`);
    });

    // ── M2: abort + session survives ──────────────────────────────────────
    await run('M2. abort + session survives', async () => {
        const p = session.evaluate('Do[Pause[0.1], {100}]');
        await sleep(800);
        session.abort();
        const r = await p;
        assert(r.aborted === true, `aborted flag: ${r.aborted}`);
        assert(r.result.value === '$Aborted', `result: ${JSON.stringify(r.result)}`);

        const r2 = await session.evaluate('1 + 1');
        assert(r2.result.value === 2, `post-abort eval: ${JSON.stringify(r2.result)}`);
    });

    // Done with shared session
    _mainSession = null;
    session.close();

    // ── M3: P4 — abort after stuck dialog ─────────────────────────────────
    await run('M3. P4: abort after stuck dialog — session alive', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            const mainProm = s.evaluate(
                'Do[nP4=k; Pause[0.1], {k,1,15}]; "p4-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).catch(() => {});

            await sleep(500);

            s.interrupt();
            try { await pollUntil(() => s.isDialogOpen, 3000); }
            catch (_) { throw new Error('Dialog #1 never opened'); }

            try { await withTimeout(s.dialogEval('nP4'), 300, 'deliberate'); } catch (_) {}
            try { s.abort(); } catch (_) {}

            const tAbort = Date.now();
            while (s.isDialogOpen && Date.now() - tAbort < T(5000)) await sleep(50);
            try { await withTimeout(mainProm, T(5000), 'P4 abort settle'); } catch (_) {}
            await sleep(300);

            const r = await resilientEval(s, '"session-alive-after-abort"', {
                perAttemptMs: T(5000), label: 'post-abort evaluate'
            });
            const alive = r && r.result &&
                (r.result.value === 'session-alive-after-abort' || r.aborted);
            assert(alive,
                `evaluate() after abort returned unexpected: ${JSON.stringify(r)}`);
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, T(30_000));

    // ── M4: test 48 — abort then Dynamic eval recovers ────────────────────
    await run('M4. abort then Dynamic eval recovers', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('n', 'ToString[42]');
            s.setDynamicInterval(200);
            const p = s.evaluate('Pause[10]; 0');
            await sleep(150);
            s.abort();
            const r = await withTimeout(p, T(5000), 'M4 abort wait');
            assert(r.aborted, 'first eval should be aborted');

            const r2 = await resilientEval(s, 'Pause[0.8]; "alive"', {
                perAttemptMs: T(8000), label: 'M4 second eval'
            });
            assert(r2.result.value === 'alive' || r2.aborted, 'kernel alive after abort');

            const res = s.getDynamicResults();
            assert('n' in res, 'dynamic result "n" expected');
            assert(res.n.value === '42', `expected "42", got "${res.n.value}"`);
        } finally {
            s.close();
        }
    });

    // ── M5: test 56 — stale interrupt aborts eval cleanly ─────────────────
    await run('M5. stale interrupt aborts eval — no hang', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            const r0 = await withTimeout(s.evaluate('1 + 1'), T(5000), 'M5 warmup');
            assert(r0.result.value === 2);

            s.interrupt();
            await sleep(500);

            const r1 = await resilientEval(s, '42', {
                perAttemptMs: T(5000), label: 'M5 eval'
            });
            if (r1.aborted) {
                assert(r1.result.value === '$Aborted',
                    `expected $Aborted, got ${JSON.stringify(r1.result)}`);
            } else {
                assert(r1.result.value === 42,
                    `expected 42, got ${JSON.stringify(r1.result)}`);
            }

            const r2 = await resilientEval(s, '2 + 2', {
                perAttemptMs: T(5000), label: 'M5 follow-up'
            });
            assert(!r2.aborted, 'follow-up should not be aborted');
            assert(r2.result.value === 4);
        } finally {
            s.close();
        }
    }, T(30000));

    // ── M6: test 49 — rapid cell transitions with Dynamic ─────────────────
    await run('M6. rapid cell transitions with Dynamic', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('tick', 'ToString[$Line]');
            s.setDynamicInterval(200);
            for (let i = 0; i < 5; i++) {
                const r = await withTimeout(
                    s.evaluate(`Pause[0.3]; ${i}`),
                    T(10000), `M6 cell ${i}`
                );
                assert(!r.aborted, `cell ${i} must not be aborted`);
                assert(String(r.result.value) === String(i),
                    `cell ${i}: expected "${i}", got "${r.result.value}"`);
            }
        } finally {
            s.close();
        }
    });

    // ── M7: post-eval idle subAuto hang — full extension flow ──────────────
    // Replicates the exact extension pattern: 3 registered Dynamic entries,
    // busy-path subAuto calls during Do[Pause[...], ...], then idle-path
    // subAuto after eval completes.  The stale ScheduledTask BEGINDLGPKT
    // after eval end can corrupt the link — idle eval hangs forever.
    await run('M7. post-eval idle subAuto hang (3 dyn + busy subAuto + idle)', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, 'M7 warmup');

            s.registerDynamic('_m7_slot1', 'ToString[n]');
            s.registerDynamic('_m7_slot2', 'ToString[n]');
            s.registerDynamic('_m7_watch', 'ToString[{n}]');
            s.setDynamicInterval(300);

            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            );

            await sleep(1000);
            assert(!s.isReady, 'M7: kernel should be busy');

            let busyCalls = 0;
            for (let i = 0; i < 8; i++) {
                if (s.isReady) break;
                try {
                    await withTimeout(
                        s.subAuto('ToString[n]'),
                        5000, `M7 busy subAuto #${i + 1}`
                    );
                    busyCalls++;
                } catch (_) {}
                await sleep(750);
            }

            const mainResult = await withTimeout(evalPromise, 30000, 'M7 main eval');
            assert(!mainResult.aborted && mainResult.result.value === 'done',
                `M7 main eval: ${JSON.stringify(mainResult.result)}`);

            // THE CRITICAL CALL: post-eval idle-path subAuto
            const idleResult = await withTimeout(
                s.subAuto('ToString[1 + 1]'),
                10000, 'M7 post-eval idle subAuto'
            );
            assert(idleResult.value === '2',
                `M7 idle expected "2", got "${idleResult?.value}"`);

            // Verify kernel still functional
            // NOTE: explicit interactive:false to avoid inheriting the
            // previous cell's EnterExpressionPacket mode.
            const nextCell = await withTimeout(s.evaluate('2 + 2', {interactive: false}), 10000, 'M7 follow-up');
            assert(nextCell.result.value === 4,
                `M7 follow-up expected 4, got ${nextCell.result.value}`);

            s.unregisterDynamic('_m7_slot1');
            s.unregisterDynamic('_m7_slot2');
            s.unregisterDynamic('_m7_watch');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, T(90000));

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped out of 7`);
    if (failedTests.length > 0) {
        console.log('Failed:', failedTests.join(', '));
    }
    console.log(failed === 0 ? 'All mini-tests PASSED \u2713' : 'Some mini-tests FAILED \u2717');

    _watchdogProc.kill('SIGKILL');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
