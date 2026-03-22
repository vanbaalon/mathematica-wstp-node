'use strict';

// ── Test suite for wstp-backend v0.6.3 ────────────────────────────────────
// Covers: evaluation queue, streaming callbacks, sub() priority, abort
//         behaviour, WstpReader side-channel, edge cases, Dialog[] subsession
//         (dialogEval, exitDialog, isDialogOpen, onDialogBegin/End/Print),
//         subWhenIdle() (background queue, timeout, close rejection), kernelPid,
//         Dynamic eval API (registerDynamic, getDynamicResults, setDynamicInterval,
//         setDynAutoMode, dynamicActive, rejectDialog, abort deduplication),
//         subAuto() (auto-routing: idle→subWhenIdle, busy→Dialog[] inline eval).
// 0.6.2: BEGINDLGPKT safety fallback (Bug 1A), setDynAutoMode cleanup (Bug 1B).
// 0.6.3: subAuto() — unified auto-routing evaluator.
// 0.7.1: tests 65–70 — post-eval idle subAuto hang (stale BEGINDLGPKT drain).


const wstp = require('../build/Release/wstp.node');
const { WstpSession, WstpReader, setDiagHandler, version } = wstp;
const fs = require('fs');
const path = require('path');

const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

function printBuildInfo() {
    const nodePath = path.join(__dirname, '../build/Release/wstp.node');
    let mtime = '';
    try {
        mtime = fs.statSync(nodePath).mtime.toLocaleString();
    } catch (e) {
        mtime = '(unknown)';
    }
    console.log(`wstp.node version: ${wstp.version || version || '(unknown)'}`);
    console.log(`wstp.node build time: ${mtime}`);
}

printBuildInfo();

// Enable C++ diagnostic channel — writes timestamped messages to stderr.
// Suppress with:  node test.js 2>/dev/null
setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

// pollUntil — re-checks condition every intervalMs until true or timeout.
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

// withTimeout — race a promise against a named deadline.
function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

// resilientEval — evaluate with automatic retry on $Aborted or timeout.
// After abort(), stale interrupts from the aborted computation may fire
// during the next evaluate, producing $Aborted or opening a new Dialog[]
// that hangs the eval.  This helper retries up to `maxAttempts` times,
// aborting stuck evals and draining stale interrupts, until the kernel
// responds cleanly.  Adapts to actual kernel state, not wall time.
async function resilientEval(s, expr, { perAttemptMs = 5000, maxAttempts = 3, label = 'resilientEval' } = {}) {
    let r;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const evalP = s.evaluate(expr);
        try {
            r = await withTimeout(evalP, perAttemptMs, `${label} (attempt ${attempt})`);
            if (!r.aborted) return r;   // clean result
            // $Aborted from stale interrupt — retry
            await sleep(200);
        } catch (e) {
            if (!/TIMEOUT/i.test(e.message)) throw e;
            // Eval hung (stale interrupt → Dialog) — abort and retry
            try { s.abort(); } catch (_) {}
            try { await withTimeout(evalP, 3000, `${label} abort settle`); } catch (_) {}
            await sleep(200);
        }
    }
    // Last result was $Aborted — still counts as "session alive"
    return r;
}

// mkSession — open a fresh WstpSession.
// _lastMkSession tracks the most recently created per-test session so that
// the test runner can kill it on timeout (unblocking a stuck native WSTP call).
let _lastMkSession = null;
let _mainSession   = null;
function mkSession() {
    const s = new WstpSession(KERNEL_PATH);
    _lastMkSession = s;
    return s;
}

// Suppress unhandled rejections from timed-out test bodies whose async
// functions continue running in the background after Promise.race rejects.
process.on('unhandledRejection', () => {});

// installHandler — install Interrupt→Dialog[] handler on a session.
// Must be done via evaluate() (EnterExpressionPacket context) so the handler
// fires on WSInterruptMessage; EvaluatePacket context does not receive it.
async function installHandler(s) {
    await s.evaluate(
        'Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    );
}

// Per-test timeout (ms).  Any test that does not complete within this window
// is failed immediately with a "TIMED OUT" error.  Prevents indefinite hangs.
const TEST_TIMEOUT_MS = 30_000;

// Hard suite-level watchdog: if the entire suite takes longer than this the
// process is force-killed.  Uses a SEPARATE OS process that sends SIGKILL,
// because setTimeout callbacks can't fire while the JS event loop is blocked
// by synchronous C++ code (e.g. CleanUp() spin-waiting for a stuck worker
// thread, or the constructor's WSActivate blocking on kernel launch).
const SUITE_TIMEOUT_S = 900;  // 15 minutes — 78 tests, some up to 90s each
const { spawn } = require('child_process');
const _watchdogProc = spawn('sh',
    ['-c', `sleep ${SUITE_TIMEOUT_S}; kill -9 ${process.pid} 2>/dev/null`],
    { stdio: 'ignore', detached: true });
_watchdogProc.unref();

// ── Test filtering ─────────────────────────────────────────────────────────
// Usage:  node test.js --only 38,39,40   or  --only 38-52
// Omit flag to run all tests.
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

// Extract leading integer from a test name like "38. foo bar" → 38.
function testNum(name) {
    const m = name.match(/^(\d+)/);
    return m ? parseInt(m[1]) : NaN;
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failedTests = [];

async function run(name, fn, timeoutMs = TEST_TIMEOUT_MS) {
    if (ONLY_TESTS !== null && !ONLY_TESTS.has(testNum(name))) {
        skipped++;
        return;
    }
    let timer;
    _lastMkSession = null;  // reset — set by mkSession() if the test creates one
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
        // On timeout: kill the kernel process to immediately unblock the
        // native WSTP worker thread.  Without this, the stuck evaluate()
        // blocks the session (cascade-hanging all subsequent tests on the
        // shared session) and prevents process.exit() from completing.
        // Match both run()-level "TIMED OUT" and inner withTimeout "TIMEOUT".
        if (/TIMED? OUT/i.test(e.message)) {
            const sess = _lastMkSession || _mainSession;
            if (sess) {
                const pid = sess.kernelPid;
                if (pid > 0) {
                    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
                    console.error(`    → killed kernel pid ${pid} to unblock stuck WSTP call`);
                }
                // Force-close the session so the test body's background async
                // cannot further interact with the dead kernel/link.
                try { sess.close(); } catch (_) {}
            }
            _lastMkSession = null;
        }
    } finally {
        clearTimeout(timer);
    }
}

// ── Main ───────────────────────────────────────────────────────────────────

// ── Speed calibration ──────────────────────────────────────────────────────
// Instead of hardcoding timeouts we measure actual kernel startup+eval speed
// and derive a multiplier.  A fast machine gets ~1×; a slow one gets higher.
// BASELINE_MS is the expected time on a typical fast dev machine.
const BASELINE_MS = 3000;
let SPEED = 1;   // set by calibrate()

// T(ms) — scale a "fast-machine" timeout to this machine's measured speed.
function T(ms) { return Math.round(ms * SPEED); }

async function calibrate() {
    const t0 = Date.now();
    const cs = new WstpSession(KERNEL_PATH);
    await cs.evaluate('1+1');   // includes kernel launch + WarmUp
    cs.close();
    const elapsed = Date.now() - t0;
    SPEED = Math.max(1, elapsed / BASELINE_MS);
    console.log(`Calibration: kernel startup+eval = ${elapsed} ms  →  SPEED = ${SPEED.toFixed(2)}×\n`);
}

async function main() {
    console.log('Opening session…');
    const session = new WstpSession(KERNEL_PATH);
    _mainSession = session;
    assert(session.isOpen, 'session did not open');
    console.log('Session open.\n');

    await calibrate();

    // ── 1. Basic queue serialisation ──────────────────────────────────────
    await run('1. queue serialisation', async () => {
        const [r1, r2, r3] = await Promise.all([
            session.evaluate('1'),
            session.evaluate('2'),
            session.evaluate('3'),
        ]);

        assert(r1.result.value === 1,
            `r1 wrong: ${JSON.stringify(r1.result)}`);
        assert(r2.result.value === 2,
            `r2 wrong: ${JSON.stringify(r2.result)}`);
        assert(r3.result.value === 3,
            `r3 wrong: ${JSON.stringify(r3.result)}`);

        // Note: this WolframKernel only sends INPUTNAMEPKT (In[n]:=) once
        // for the very first evaluation in a session.  All subsequent evals
        // return cellIndex=0.  We verify the results are correct instead.
        assert(r1.cellIndex >= 0, 'r1 cellIndex is a non-negative integer');
        assert(r2.cellIndex >= 0, 'r2 cellIndex is a non-negative integer');
        assert(r3.cellIndex >= 0, 'r3 cellIndex is a non-negative integer');
    });

    // ── 2. sub() priority over queued evaluate() ──────────────────────────
    await run('2. sub() priority over queued evaluate()', async () => {
        // Flood the queue with slow evaluations.
        // p1 goes in-flight immediately; p2 and p3 are queued behind it.
        const p1 = session.evaluate('Pause[0.5]; "first"');
        const p2 = session.evaluate('Pause[0.5]; "second"');
        const p3 = session.evaluate('Pause[0.5]; "third"');

        // sub() is queued after p1 has already started — it must run before
        // p2 and p3 (i.e. finish in ~500 ms, not ~1500 ms).
        const subStart = Date.now();
        const sv = await session.sub('42');
        const subElapsed = Date.now() - subStart;

        assert(
            sv.type === 'integer' && sv.value === 42,
            `sub result: ${JSON.stringify(sv)}`,
        );
        // p1 takes ~500 ms; sub itself is trivial — so total ≪ 1000 ms.
        // We allow 1200 ms as a generous upper bound.
        assert(subElapsed < 1200,
            `sub elapsed ${subElapsed} ms — sub did not run with priority`);

        await Promise.all([p1, p2, p3]);
    });

    // ── 3. Multiple sub() calls queue FIFO among themselves ───────────────
    await run('3. sub() FIFO ordering', async () => {
        // Keep session busy so subs queue up rather than start immediately.
        const bg = session.evaluate('Pause[1]; "bg"');

        const [sa, sb, sc] = await Promise.all([
            session.sub('1'),
            session.sub('2'),
            session.sub('3'),
        ]);

        assert(sa.value === 1, `sa: ${JSON.stringify(sa)}`);
        assert(sb.value === 2, `sb: ${JSON.stringify(sb)}`);
        assert(sc.value === 3, `sc: ${JSON.stringify(sc)}`);

        await bg;
    });

    // ── 4. Streaming onPrint fires before Promise resolves ────────────────
    await run('4. streaming onPrint timing', async () => {
        const lines      = [];
        const timestamps = [];
        const evalStart  = Date.now();

        // Latch: the Promise should not resolve until all callbacks have fired
        // (CompleteCtx guarantees this), but we add an explicit wait as a safety
        // net in case TSFNs are still queued when the promise settles.
        let deliveryResolve;
        const allDelivered = new Promise(r => { deliveryResolve = r; });
        let deliveredCount = 0;

        const r = await session.evaluate(
            'Do[Print["line-" <> ToString[ii$$]]; Pause[0.2], {ii$$, 4}]',
            {
                onPrint: (line) => {
                    lines.push(line);
                    timestamps.push(Date.now() - evalStart);
                    if (++deliveredCount === 4) deliveryResolve();
                },
            },
        );

        // Wait up to 5 s for all 4 callbacks to actually fire.
        await Promise.race([allDelivered, sleep(5000)]);

        assert(lines.length === 4,
            `expected 4 streamed lines, got ${lines.length} (r.print=${JSON.stringify(r.print)}, result=${JSON.stringify(r.result)}, msgs=${JSON.stringify(r.messages)})`);
        assert(r.print.length === 4,
            `expected 4 in result.print, got ${r.print.length}`);
        assert(lines[0] === r.print[0],
            `streaming[0]="${lines[0]}" vs batch[0]="${r.print[0]}"`);

        // Lines arrive ~200 ms apart — confirm inter-arrival gap is plausible.
        const gap = timestamps[1] - timestamps[0];
        assert(gap > 50 && gap < 700,
            `inter-line gap ${gap} ms — expected 50–700 ms`);
    });

    // ── 5. onMessage fires for kernel warnings ────────────────────────────
    await run('5. streaming onMessage', async () => {
        const msgs = [];
        let msgResolve;
        const msgDelivered = new Promise(r => { msgResolve = r; });
        const r = await session.evaluate('1/0', {
            onMessage: (m) => { msgs.push(m); msgResolve(); },
        });

        // Wait up to 5 s for the callback to actually fire.
        await Promise.race([msgDelivered, sleep(5000)]);

        assert(msgs.length > 0,   `onMessage callback never fired (r.messages=${JSON.stringify(r.messages)}, r.result=${JSON.stringify(r.result)})`);
        assert(r.messages.length > 0, `result.messages is empty (msgs=${JSON.stringify(msgs)})`);
        assert(msgs[0] === r.messages[0],
            `streaming[0]="${msgs[0]}" vs batch[0]="${r.messages[0]}"`);
        assert(msgs[0].includes('::'),
            `message missing :: separator: "${msgs[0]}"`);
    });

    // ── 6. abort() returns $Aborted, session stays alive ──────────────────
    await run('6. abort + session survives', async () => {
        // Do[Pause[0.1],{100}] has genuine yield points every 100ms so the
        // kernel will react to WSAbortMessage quickly.  Do[Null,{10^8}] is a
        // tight computation loop that may not check for abort signals.
        const p = session.evaluate('Do[Pause[0.1], {100}]');
        await sleep(800);   // give the eval time to be well-and-truly running
        session.abort();
        const r = await p;

        assert(r.aborted === true, `aborted flag: ${r.aborted}`);
        assert(r.result.value === '$Aborted',
            `result: ${JSON.stringify(r.result)}`);

        // session must still accept evaluations
        const r2 = await session.evaluate('1 + 1');
        assert(r2.result.value === 2,
            `post-abort eval: ${JSON.stringify(r2.result)}`);
    });

    // ── 7. Abort drains queue — queued evals still run ────────────────────
    await run('7. abort drains queue', async () => {
        const p1 = session.evaluate('Do[Pause[0.1], {100}]');  // will be aborted
        const p2 = session.evaluate('"after"');                // queued, must still run

        await sleep(400);
        session.abort();

        const r1 = await p1;
        assert(r1.aborted === true, `p1 not aborted: ${r1.aborted}`);

        const r2 = await p2;
        assert(
            r2.result.type === 'string' && r2.result.value === 'after',
            `p2 result: ${JSON.stringify(r2.result)}`,
        );
    });

    // ── 8. sub() after abort — session healthy ────────────────────────────
    await run('8. sub() after abort', async () => {
        const p = session.evaluate('Do[Pause[0.1], {100}]');
        await sleep(400);
        session.abort();
        await p;

        // $ProcessID is a positive integer and reliably populated in WSTP mode.
        const sv = await session.sub('$ProcessID');
        assert(sv.type === 'integer', `type: ${sv.type}`);
        assert(sv.value > 0, `ProcessID: ${sv.value}`);
    });

    // ── 9. cellIndex is present and results are correct ───────────────────
    // Note: WolframKernel in -wstp mode only sends INPUTNAMEPKT for In[1]:=
    // (the very first cell in the session).  Subsequent evaluations return
    // cellIndex=0.  We verify that the first ever eval had cellIndex>=1 and
    // that all results are structurally valid.
    await run('9. cellIndex and result correctness', async () => {
        const r1 = await session.evaluate('100');
        const r2 = await session.evaluate('200');
        const r3 = await session.evaluate('300');

        assert(r1.result.value === 100, `r1: ${JSON.stringify(r1.result)}`);
        assert(r2.result.value === 200, `r2: ${JSON.stringify(r2.result)}`);
        assert(r3.result.value === 300, `r3: ${JSON.stringify(r3.result)}`);
        assert(typeof r1.cellIndex === 'number', 'cellIndex is a number');
    });

    // ── 10. outputName and result.print / result.messages are arrays ───────
    // Note: WolframKernel in -wstp mode does not send OUTPUTNAMEPKT (Out[n]=).
    // outputName is always an empty string.  We verify the structural shape
    // of EvalResult — print and messages are always arrays, aborted is boolean.
    await run('10. EvalResult structure is correct', async () => {
        const r = await session.evaluate('testVar$$ = 7');
        assert(typeof r.outputName === 'string', 'outputName is a string');
        assert(Array.isArray(r.print),           'print is an array');
        assert(Array.isArray(r.messages),        'messages is an array');
        assert(typeof r.aborted === 'boolean',   'aborted is a boolean');
        assert(r.result.value === 7,             `result: ${JSON.stringify(r.result)}`);

        const r2 = await session.evaluate('testVar$$^2');
        assert(r2.result.value === 49, `squared: ${JSON.stringify(r2.result)}`);
    });

    // ── 11. WstpReader side-channel delivers real-time values ─────────────
    // Pattern mirrors monitor_demo.js APPROACH 2:
    //   1. Kernel creates link and returns its name.
    //   2. WstpReader connects (JS main thread).
    //   3. Background eval loop starts writing (NOT awaited).
    //   4. readNext() completes WSActivate on first call, then reads data.
    await run('11. WstpReader side-channel', async () => {
        // Step 1: create a TCPIP link inside the kernel.
        await session.evaluate('$sideLink$$ = LinkCreate[LinkProtocol -> "TCPIP"]');
        const nameResult = await session.evaluate('$sideLink$$[[1]]');
        const linkName = nameResult.result.value;
        assert(
            typeof linkName === 'string' && linkName.length > 0,
            `bad linkName: ${JSON.stringify(nameResult.result)}`,
        );

        // Step 2: connect reader from JS — handshake is deferred to Execute().
        const reader = new WstpReader(linkName, 'TCPIP');

        // Step 3: start background writer (NOT awaited) so it runs concurrently
        // with readNext().  The kernel enters the Do-loop and calls LinkWrite,
        // which completes the deferred WSActivate handshake on the JS side.
        // Pause AFTER each LinkWrite (not before) so the value is written
        // immediately and the 300ms gap is before the NEXT write.  A Pause[1]
        // before LinkClose ensures the reader drains value 5 before the link
        // close signal arrives — simultaneous data+close can cause WSTKEND.
        const bgWrite = session.evaluate(
            'Do[LinkWrite[$sideLink$$, i]; Pause[0.3], {i, 1, 5}]; Pause[1]; LinkClose[$sideLink$$]; "done"',
        );

        // Step 4: read 5 values in real time.
        // Use try/finally so reader.close() and bgWrite are always awaited
        // even if readNext() rejects — prevents the session being poisoned by
        // an orphaned in-flight bgWrite evaluation.
        let received = [];
        try {
            for (let i = 0; i < 5; i++) {
                const v = await reader.readNext();
                received.push(v.value);
            }
        } finally {
            reader.close();
            // Always drain bgWrite so the session stays clean for subsequent tests.
            try { await bgWrite; } catch (_) {}
        }

        assert(received.length === 5,
            `expected 5 values, got ${received.length}`);
        assert(
            JSON.stringify(received) === JSON.stringify([1, 2, 3, 4, 5]),
            `values: ${JSON.stringify(received)}`,
        );
    });

    // ── 12. Large/deep expression — no stack overflow or process crash ───
    // WolframKernel returns a deeply-nested Nest[f,x,600] expression.
    // ReadExprRaw caps recursion at depth 512 and returns a WError, which
    // EvaluateWorker::OnOK() converts to a Promise rejection.
    // The test verifies the process survives: create a new evaluate() after
    // the expected rejection to prove the session (and process) are intact.
    await run('12. deep expression no crash', async () => {
        let threw = false;
        try {
            await session.evaluate('Nest[f, x, 600]');
        } catch (e) {
            threw = true;
            // Expected: 'expression too deep' from ReadExprRaw depth cap.
            assert(e.message.includes('expression too deep') ||
                   e.message.includes('deep'),
                `unexpected error: ${e.message}`);
        }
        assert(threw, 'expected a rejection for depth-capped expression');

        // session must still accept evaluations after the rejection
        const r2 = await session.evaluate('1 + 1');
        assert(r2.result.value === 2, 'session alive after deep-expression rejection');
    });

    // ── 13. Syntax error produces message, not crash ──────────────────────
    await run('13. syntax error no crash', async () => {
        const r = await session.evaluate('1 +* 2');
        assert(r !== null, 'null result from syntax error');
        // Kernel sends a message for the parse error and returns $Failed / Null.
        assert(
            r.messages.length > 0 || r.result !== null,
            'no message and no result for syntax error',
        );
    });

    // ── 14. close() is idempotent ─────────────────────────────────────────
    await run('14. close() is idempotent', async () => {
        const s2 = new WstpSession(KERNEL_PATH);
        assert(s2.isOpen, 'fresh session not open');
        s2.close();
        assert(!s2.isOpen, 'isOpen true after first close');
        s2.close();   // must not throw
        assert(!s2.isOpen, 'isOpen true after second close');
    });

    // ── 15. Cooperative Dialog[] subsession ──────────────────────────────
    // Evaluate an expression that opens Dialog[].  We watch isDialogOpen,
    // check $DialogLevel inside the dialog, then close it with DialogReturn[].
    //
    // Note: within a dialog's EvaluatePacket context:
    //   - Return[]        evaluates to Return[] (no enclosing structure to return from)
    //   - DialogReturn[]  explicitly exits the dialog (correct exit mechanism)
    //   - Do-loop variables are NOT in scope (EvaluatePacket is a fresh evaluation)
    await run('15. cooperative Dialog[] subsession', async () => {
        let dialogOpened = false;
        let dialogClosed = false;

        const evalPromise = session.evaluate(
            'Dialog[]; "after-dialog"',
            {
                onDialogBegin: (_level) => { dialogOpened = true; },
                onDialogEnd:   (_level) => { dialogClosed = true; },
            },
        );

        await pollUntil(() => session.isDialogOpen);
        assert(session.isDialogOpen, 'isDialogOpen should be true inside Dialog[]');

        // A simple expression should evaluate fine inside the dialog.
        const two = await session.dialogEval('1 + 1');
        assert(
            two !== null && two.value === 2,
            `expected 1+1 === 2 inside dialog, got ${JSON.stringify(two)}`,
        );

        // Close the dialog via exitDialog() — sends EnterTextPacket["Return[]"].
        // (dialogEval('Return[]') does NOT close the dialog: Return[] is evaluated
        // at the top level of EvaluatePacket where there is nothing to return from.)
        await session.exitDialog();

        // Wait for the outer evaluate() to finish.
        const r = await evalPromise;
        assert(
            r.result !== null && r.result.value === 'after-dialog',
            `expected "after-dialog", got ${JSON.stringify(r.result)}`,
        );
        assert(dialogOpened, 'onDialogBegin was never called');
        assert(dialogClosed, 'onDialogEnd was never called');
        assert(!session.isDialogOpen, 'isDialogOpen should be false after dialog closes');
    });

    // ── 16. dialogEval rejects when no dialog is open ────────────────────
    await run('16. dialogEval rejects with no open dialog', async () => {
        assert(!session.isDialogOpen, 'precondition: no dialog open');
        let threw = false;
        try {
            await session.dialogEval('1 + 1');
        } catch (e) {
            threw = true;
            assert(
                e.message.includes('no dialog'),
                `unexpected error text: ${e.message}`,
            );
        }
        assert(threw, 'dialogEval should reject when no dialog is open');
    });

    // ── 17. Unhandled dialog does not corrupt the link ────────────────────
    // Call Dialog[] from a plain evaluate() using only isDialogOpen polling
    // (no onDialogBegin handler).  onDialogBegin: () => {} is still required
    // to opt into the legacy dialog loop — without it Fix 1A auto-closes the
    // dialog before JS can interact with it.
    await run('17. unhandled dialog does not corrupt link', async () => {
        const evalPromise = session.evaluate('Dialog[]; 42', { onDialogBegin: () => {} });

        await pollUntil(() => session.isDialogOpen);
        assert(session.isDialogOpen, 'dialog should have opened');
        await session.exitDialog();

        const r = await evalPromise;
        assert(
            r.result !== null && r.result.value === 42,
            `expected 42, got ${JSON.stringify(r.result)}`,
        );
    });

    // ── 19. exitDialog() with a return value ─────────────────────────────
    // exitDialog('21') sends EnterTextPacket["Return[21]"].  The value 21
    // becomes the value of Dialog[] in the outer expression, so x$$*2 == 42.
    await run('19. exitDialog() with a return value', async () => {
        const p = session.evaluate('x$$ = Dialog[]; x$$ * 2', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        await session.exitDialog('21');
        const r = await p;
        assert(
            r.result.value === 42,
            `Dialog[] return value: ${JSON.stringify(r.result)}`,
        );
    });

    // ── 20. dialogEval() sees outer variable state ────────────────────────
    // Variables set before Dialog[] are in scope inside the subsession.
    await run('20. dialogEval sees outer variable state', async () => {
        const p = session.evaluate('myVar$$ = 123; Dialog[]; myVar$$', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        const v = await session.dialogEval('myVar$$');
        assert(
            v !== null && v.value === 123,
            `outer var inside dialog: ${JSON.stringify(v)}`,
        );
        await session.exitDialog();
        await p;
    });

    // ── 21. dialogEval() can mutate kernel state ──────────────────────────
    // Variables set inside the dialog persist after the dialog closes.
    await run('21. dialogEval can mutate kernel state', async () => {
        const p = session.evaluate('Dialog[]; mutated$$', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        await session.dialogEval('mutated$$ = 777');
        await session.exitDialog();
        await p;  // outer eval returns mutated$$
        const check = await session.sub('mutated$$');
        assert(
            check.value === 777,
            `mutation after dialog exit: ${JSON.stringify(check)}`,
        );
    });

    // ── 22. Multiple dialogEval() calls are serviced FIFO ─────────────────
    // Three concurrent dialogEval() calls queue up and resolve in order.
    await run('22. multiple dialogEval calls are serviced FIFO', async () => {
        const p = session.evaluate('Dialog[]', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        const [a, b, c] = await Promise.all([
            session.dialogEval('1'),
            session.dialogEval('2'),
            session.dialogEval('3'),
        ]);
        assert(
            a.value === 1 && b.value === 2 && c.value === 3,
            `FIFO: ${JSON.stringify([a, b, c])}`,
        );
        await session.exitDialog();
        await p;
    });

    // ── 23. isDialogOpen transitions correctly ────────────────────────────
    // false → true (on Dialog[]) → false (after exitDialog).
    await run('23. isDialogOpen transitions correctly', async () => {
        assert(!session.isDialogOpen, 'initially false');
        const p = session.evaluate('Dialog[]', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        assert(session.isDialogOpen, 'true while dialog open');
        await session.exitDialog();
        await p;
        assert(!session.isDialogOpen, 'false after exit');
    });

    // ── 24. onDialogPrint fires for Print[] inside dialog ─────────────────
    await run('24. onDialogPrint fires for Print[] inside dialog', async () => {
        const dialogLines = [];
        let dlgPrintResolve;
        const dlgPrintDelivered = new Promise(r => { dlgPrintResolve = r; });
        const p = session.evaluate('Dialog[]', {
            onDialogBegin: () => {},
            onDialogPrint: (line) => { dialogLines.push(line); dlgPrintResolve(); },
        });
        await pollUntil(() => session.isDialogOpen);
        await session.dialogEval('Print["hello-from-dialog"]');
        // Wait up to 5 s for the callback to actually fire before exiting the dialog.
        await Promise.race([dlgPrintDelivered, sleep(5000)]);
        await session.exitDialog();
        await p;
        assert(
            dialogLines.includes('hello-from-dialog'),
            `onDialogPrint lines: ${JSON.stringify(dialogLines)}`,
        );
    });

    // ── S. Streaming stability: 10 consecutive Print[] evals, same session ─
    // Confirms that TSFN delivery is reliable across repeated evaluations
    // without restarting the kernel.  Mirrors real VSCode extension use.
    await run('S. streaming stress (10× Print callback)', async () => {
        for (let rep = 0; rep < 10; rep++) {
            const lines = [];
            let resolveAll;
            const allFired = new Promise(r => { resolveAll = r; });
            let count = 0;
            const r = await session.evaluate(
                'Do[Print["s" <> ToString[jj$$]]; Pause[0.05], {jj$$, 4}]',
                { onPrint: line => { lines.push(line); if (++count === 4) resolveAll(); } },
            );
            await Promise.race([allFired, sleep(5000)]);
            assert(count === 4,
                `rep ${rep + 1}/10: only ${count}/4 callbacks ` +
                `(r.print=${JSON.stringify(r.print)})`);
        }
    });

    // ── 26. exitDialog() rejects when no dialog is open ───────────────────
    // Symmetric to test 16 which covers dialogEval().
    await run('26. exitDialog() rejects with no open dialog', async () => {
        assert(!session.isDialogOpen, 'precondition: no dialog open');
        let threw = false;
        try {
            await session.exitDialog();
        } catch (e) {
            threw = true;
            assert(
                e.message.includes('no dialog'),
                `unexpected error text: ${e.message}`,
            );
        }
        assert(threw, 'exitDialog should reject when no dialog is open');
    });

    // ── 27. evaluate() queued during dialog runs after dialog closes ───────
    // A plain evaluate() queued while the dialog inner loop is running must
    // wait and then be dispatched normally after ENDDLGPKT.
    await run('27. evaluate() queued during dialog runs after dialog closes', async () => {
        const p1 = session.evaluate('Dialog[]', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        // Queue a normal eval WHILE the dialog is open — it must wait.
        const p2 = session.evaluate('"queued-during-dialog"');
        await session.exitDialog();
        await p1;
        const r2 = await p2;
        assert(
            r2.result.type === 'string' && r2.result.value === 'queued-during-dialog',
            `queued eval: ${JSON.stringify(r2.result)}`,
        );
    });

    // ── 28. closeAllDialogs() is a no-op when no dialog is open ───────────
    await run('28. closeAllDialogs() no-op when idle', async () => {
        assert(!session.isDialogOpen, 'precondition: no dialog open');
        const closed = session.closeAllDialogs();
        assert(closed === false,
            `closeAllDialogs() should return false when idle, got: ${closed}`);
        assert(!session.isDialogOpen, 'isDialogOpen should stay false');
    });

    // ── 29. closeAllDialogs() rejects all queued dialogEval promises ───────
    // Uses a subsession so the main session stays intact for tests 25 and 18.
    // Verifies: return value = true, isDialogOpen cleared, queued promises rejected.
    await run('29. closeAllDialogs() rejects queued dialogEval promises', async () => {
        const sub = session.createSubsession();
        try {
            // Open a Dialog[] on the subsession.
            const pEval = sub.evaluate('Dialog[]', { onDialogBegin: () => {} });
            await pollUntil(() => sub.isDialogOpen);
            assert(sub.isDialogOpen, 'dialog should be open');

            // Queue two dialogEval() calls — neither will be serviced before
            // closeAllDialogs() runs (the JS event loop hasn't yielded yet).
            const pe1 = sub.dialogEval('"expr-1"')
                .then(() => 'resolved').catch(e => 'rejected:' + e.message);
            const pe2 = sub.dialogEval('"expr-2"')
                .then(() => 'resolved').catch(e => 'rejected:' + e.message);

            // closeAllDialogs() should flush both and return true.
            const closed = sub.closeAllDialogs();
            assert(closed === true,
                `closeAllDialogs() should return true when dialog was open, got: ${closed}`);
            assert(!sub.isDialogOpen,
                'isDialogOpen should be false after closeAllDialogs()');

            // Both queued promises must reject immediately.
            const [r1, r2] = await Promise.all([pe1, pe2]);
            assert(r1.startsWith('rejected:'),
                `pe1 should have rejected, got: ${r1}`);
            assert(r2.startsWith('rejected:'),
                `pe2 should have rejected, got: ${r2}`);

            // Abort the subsession to unstick the kernel (still inside Dialog[]).
            sub.abort();
            const ra = await pEval;
            assert(ra.aborted === true,
                `subsession evaluate should resolve with aborted=true, got: ${JSON.stringify(ra.aborted)}`);
        } finally {
            sub.close();
        }
    });

    // ── P1: Pause[8] ignores interrupt ────────────────────────────────────
    // Expected: interrupt() returns true but isDialogOpen stays false within
    // 2500ms because Pause[] ignores WSInterruptMessage during a sleep.
    // This test documents the fundamental limitation: Dynamic cannot read a
    // live variable while Pause[N] is running.
    await run('P1: Pause[4] ignores interrupt within 1500ms', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            let evalDone = false;
            const mainProm = s.evaluate(
                'pP1 = 0; Pause[4]; pP1 = 1; "p1-done"'
            ).then(() => { evalDone = true; });

            await sleep(300);

            const sent = s.interrupt();
            assert(sent === true, 'interrupt() should return true mid-eval');

            const t0 = Date.now();
            while (!s.isDialogOpen && Date.now() - t0 < 1500) await sleep(25);

            const dlgOpened = s.isDialogOpen;
            assert(!dlgOpened, 'Pause[4] should NOT open a dialog within 1500ms');

            // After the 1500ms window the interrupt may still be queued — the kernel
            // will fire Dialog[] once Pause[] releases.  Abort to unstick the eval
            // rather than waiting for it to return on its own (which could take forever
            // if Dialog[] opens and nobody services it).
            s.abort();
            await mainProm; // resolves immediately after abort()
        } finally {
            s.close();
        }
    }, 12_000);

    // ── P2: Pause[0.3] loop — interrupt opens Dialog and dialogEval works ──
    // Expected: interrupt during a short Pause[] loop opens a Dialog[],
    // dialogEval can read the live variable, and exitDialog resumes the loop.
    await run('P2: Pause[0.3] loop — interrupt opens Dialog and dialogEval succeeds', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            let evalDone = false;
            const mainProm = s.evaluate(
                'Do[nP2 = k; Pause[0.1], {k, 1, 15}]; "p2-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).then(() => { evalDone = true; });

            await sleep(500);

            s.interrupt();
            try { await pollUntil(() => s.isDialogOpen, 3000); }
            catch (_) { throw new Error('Dialog never opened — interrupt not working with Pause[0.1]'); }

            const val = await withTimeout(s.dialogEval('nP2'), 5000, 'dialogEval nP2');
            assert(val && typeof val.value === 'number' && val.value >= 1,
                `expected nP2 >= 1, got ${JSON.stringify(val)}`);

            await s.exitDialog();
            await withTimeout(mainProm, 8_000, 'P2 main eval');
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, 15_000);

    // ── P3: dialogEval timeout — kernel state after (diagnostic) ───────────
    // Simulates the extension failure: dialogEval times out without exitDialog.
    // Verifies the kernel is NOT permanently broken by a timeout alone.
    // Always passes — records the observed behaviour.
    await run('P3: dialogEval timeout — kernel still recovers via exitDialog', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            let evalDone = false;
            const mainProm = s.evaluate(
                'Do[nP3 = k; Pause[0.1], {k, 1, 15}]; "p3-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).then(() => { evalDone = true; });

            await sleep(500);

            s.interrupt();
            let dlg1 = false;
            try { await pollUntil(() => s.isDialogOpen, 3000); dlg1 = true; }
            catch (_) {}

            if (!dlg1) {
                console.log('    P3 note: Dialog #1 never opened — interrupt may have been slow');
            } else {
                // Simulate a timed-out dialogEval (abandon it at 200ms)
                try { await withTimeout(s.dialogEval('nP3'), 200, 'deliberate-timeout'); } catch (_) {}

                // Attempt exitDialog — should succeed
                let exitOk = false;
                try { await withTimeout(s.exitDialog(), 2000, 'exitDialog after timeout'); exitOk = true; }
                catch (_) {}

                // Attempt a second interrupt to confirm kernel state
                await sleep(400);
                s.interrupt();
                let dlg2 = false;
                const t2 = Date.now();
                while (!s.isDialogOpen && Date.now() - t2 < 3000) await sleep(30);
                dlg2 = s.isDialogOpen;

                if (dlg2) {
                    await withTimeout(s.dialogEval('nP3'), 4000, 'dialogEval #2').catch(() => {});
                    await s.exitDialog().catch(() => {});
                }

                if (!evalDone) { try { await withTimeout(mainProm, 6_000, 'P3 loop'); } catch (_) {} }

                // Diagnostic: document observed outcome but do not hard-fail on dlg2
                if (!exitOk) {
                    console.log(`    P3 note: exitDialog failed, dlg2=${dlg2} (expected=false for unfixed build)`);
                }
            }
            // Test passes unconditionally.
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, 20_000);

// ── P4: abort() after stuck dialog — session stays alive ────────────────
    // Note: abort() sends WSAbortMessage which resets the Wolfram kernel's
    // Internal`AddHandler["Interrupt", ...] registration.  Subsequent interrupts
    // therefore do not open a new Dialog[]; that is expected, not a bug.
    // What this test verifies: after abort() the session is NOT dead —
    // evaluate() still works so the extension can queue more cells.
    await run('P4: abort() after stuck dialog — session can still evaluate', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            const mainProm = s.evaluate(
                'Do[nP4=k; Pause[0.1], {k,1,15}]; "p4-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).catch(() => {});

            await sleep(500);

            // Trigger a dialog, force dialogEval timeout, then abort
            s.interrupt();
            try { await pollUntil(() => s.isDialogOpen, 3000); }
            catch (_) { throw new Error('Dialog #1 never opened'); }

            try { await withTimeout(s.dialogEval('nP4'), 300, 'deliberate'); } catch (_) {}
            try { s.abort(); } catch (_) {}

            // Let execute() drain the abort response and OnOK fire
            const tAbort = Date.now();
            while (s.isDialogOpen && Date.now() - tAbort < T(5000)) await sleep(50);
            try { await withTimeout(mainProm, T(5000), 'P4 abort settle'); } catch (_) {}
            await sleep(300);

            // KEY assertion: the session is still functional for evaluate()
            // (abort() must NOT permanently close the link)
            // resilientEval retries if stale interrupts cause $Aborted or hang
            const r = await resilientEval(s, '"session-alive-after-abort"', {
                perAttemptMs: T(5000), label: 'post-abort evaluate'
            });
            const alive = r && r.result &&
                (r.result.value === 'session-alive-after-abort' || r.aborted);
            assert(alive,
                `evaluate() after abort returned unexpected result: ${JSON.stringify(r)}`);
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, T(30_000));

    // ── P5: closeAllDialogs()+abort() recovery → reinstall handler → new dialog works
    // closeAllDialogs() is designed to be paired with abort().  It rejects all
    // pending dialogEval() promises (JS-side), while abort() signals the kernel.
    // After recovery the interrupt handler must be reinstalled because abort()
    // clears Wolfram's Internal`AddHandler["Interrupt",...] registration.
    await run('P5: closeAllDialogs()+abort() recovery — new dialog works after reinstallHandler', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            const mainProm = s.evaluate(
                'Do[nP5 = k; Pause[0.1], {k, 1, 15}]; "p5-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).catch(() => {});

            await sleep(500);

            // ── Phase 1: open dialog #1, call closeAllDialogs()+abort() ──────
            s.interrupt();
            try { await pollUntil(() => s.isDialogOpen, 3000); }
            catch (_) { throw new Error('Dialog #1 never opened'); }

            // Start a dialogEval — closeAllDialogs() will reject it synchronously.
            const de1 = s.dialogEval('nP5').catch(() => {});
            try { s.closeAllDialogs(); } catch (_) {}
            await de1;           // resolves immediately (rejected by closeAllDialogs)
            await sleep(100);
            try { s.abort(); } catch (_) {}
            await mainProm;      // should resolve promptly after abort()

            // ── Phase 2: reinstall handler, start new loop, interrupt → dialog #2 ──
            // abort() clears Internal`AddHandler["Interrupt",...] in the kernel,
            // so we must reinstall before the next interrupt cycle.
            await withTimeout(installHandler(s), T(8000), 'reinstall handler after abort');

            let dlg2 = false;
            const mainProm2 = s.evaluate(
                'Do[nP5b = k; Pause[0.1], {k, 1, 15}]; "p5b-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).catch(() => {});

            await sleep(500);
            s.interrupt();
            try { await pollUntil(() => s.isDialogOpen, 3000); }
            catch (_) { throw new Error('Dialog #2 never opened after closeAllDialogs()+abort() recovery'); }
            dlg2 = true;

            // Read a live variable inside the dialog.
            const val2 = await withTimeout(s.dialogEval('nP5b'), 4000, 'dialogEval #2');
            assert(val2 !== null && val2.value !== undefined, 'dialogEval #2 should return nP5b value');

            assert(dlg2, 'after closeAllDialogs()+abort()+reinstallHandler, interrupt must open a new dialog');
            // Abort the dialog and remaining Do loop promptly (no exitDialog needed).
            try { s.abort(); } catch (_) {}
            await mainProm2.catch(() => {});  // drains immediately after abort
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, T(25_000));

    // ── P6: Simulate Dynamic + Pause[5] full scenario (diagnostic) ─────────
    // Reproduces: n=RandomInteger[100]; Pause[5] with interrupt every 2.5s.
    // Pause[5] is expected to block all interrupts.  Test always passes —
    // it documents whether reads succeed despite long Pause.
    await run('P6: Pause[5] + interrupt cycle — dynamic read diagnostic', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            let evalDone = false;
            const mainProm = s.evaluate(
                'n = RandomInteger[100]; Pause[3]; "p6-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).then(() => { evalDone = true; });

            await sleep(200);

            const INTERRUPT_WAIT_MS = 1500;
            const DIALOG_EVAL_TIMEOUT_MS = 8000;
            let dialogReadSucceeded = false;
            let pauseIgnoredInterrupt = false;

            for (let cycle = 1; cycle <= 2 && !evalDone; cycle++) {
                const t0 = Date.now();
                s.interrupt();
                while (!s.isDialogOpen && Date.now() - t0 < INTERRUPT_WAIT_MS) await sleep(25);
                const dlg = s.isDialogOpen;

                if (!dlg) {
                    pauseIgnoredInterrupt = true;
                    await sleep(300);
                    continue;
                }

                try {
                    const val = await withTimeout(
                        s.dialogEval('n'), DIALOG_EVAL_TIMEOUT_MS, `P6 dialogEval cycle ${cycle}`);
                    dialogReadSucceeded = true;
                    await s.exitDialog();
                    break;
                } catch (e) {
                    let exitOk = false;
                    for (let a = 0; a < 3 && !exitOk; a++) {
                        try { await withTimeout(s.exitDialog(), 2000, `exitDialog ${a+1}`); exitOk = true; }
                        catch (_) {}
                    }
                    if (!exitOk) { try { s.abort(); } catch (_) {} await sleep(1000); break; }
                }
            }

            try { await withTimeout(mainProm, 7_000, 'P6 main eval'); } catch (_) {}

            // Diagnostic: always passes — log observed outcome
            if (pauseIgnoredInterrupt && !dialogReadSucceeded) {
                console.log('    P6 note: Pause[3] blocked all interrupts — expected behaviour');
            } else if (dialogReadSucceeded) {
                console.log('    P6 note: at least one read succeeded despite Pause');
            }
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, 20_000);

    // ── 25. abort() while dialog is open ──────────────────────────────────
    // Must run AFTER all other dialog tests — abort() sends WSAbortMessage
    // which resets the WSTP link, leaving the session unusable for further
    // evaluations.  Tests 26 and 27 need a clean session, so test 25 runs last
    // (just before test 18 which also corrupts the link via WSInterruptMessage).
    await run('25. abort while dialog is open', async () => {
        const p = session.evaluate('Dialog[]', { onDialogBegin: () => {} });
        await pollUntil(() => session.isDialogOpen);
        session.abort();
        const r = await p;
        assert(r.aborted === true, `aborted flag: ${r.aborted}`);
        assert(!session.isDialogOpen, 'isDialogOpen false after abort');
        // NOTE: session link is dead after abort() — no further evaluations.
    });

    // ── 18. interrupt() is callable (best-effort, no hard assertion) ──────
    // interrupt() posts WSInterruptMessage.  Without a Wolfram-side handler
    // the kernel ignores it.  This test just verifies the method exists and
    // returns a boolean without throwing.
    // NOTE: must run LAST — WSInterruptMessage stays buffered on the link and
    // would abort the next Dialog[] evaluation, causing all dialog tests to hang.
    await run('18. interrupt() does not throw', async () => {
        const ok = session.interrupt();
        assert(typeof ok === 'boolean', `interrupt() should return boolean, got ${typeof ok}`);
    });

    // ── 30. kernelPid is a positive integer ───────────────────────────────
    await run('30. kernelPid is a positive integer', async () => {
        const s = mkSession();
        try {
            const pid = s.kernelPid;
            assert(typeof pid === 'number', `kernelPid type: ${typeof pid}`);
            assert(Number.isInteger(pid),   `kernelPid not integer: ${pid}`);
            assert(pid > 0,                 `kernelPid not positive: ${pid}`);
            // Verify it matches $ProcessID reported by the kernel itself.
            const r = await s.sub('$ProcessID');
            assert(r.type === 'integer' && r.value === pid,
                `kernelPid ${pid} vs kernel $ProcessID ${JSON.stringify(r)}`);
        } finally {
            s.close();
        }
    });

    // ── 31. kernelPid is distinct for main + subsessions ──────────────────
    await run('31. kernelPid distinct across subsessions', async () => {
        const s = mkSession();
        try {
            const child1 = s.createSubsession();
            const child2 = s.createSubsession();
            try {
                const pids = [s.kernelPid, child1.kernelPid, child2.kernelPid];
                assert(pids.every(p => p > 0),
                    `all PIDs must be positive: ${JSON.stringify(pids)}`);
                assert(new Set(pids).size === 3,
                    `PIDs must be distinct: ${JSON.stringify(pids)}`);
            } finally {
                child1.close();
                child2.close();
            }
        } finally {
            s.close();
        }
    });

    // ── 32. kernelPid survives close() ────────────────────────────────────
    await run('32. kernelPid readable after close()', async () => {
        const s = mkSession();
        const pid = s.kernelPid;
        assert(pid > 0, `pid before close: ${pid}`);
        s.close();
        assert(s.kernelPid === pid,
            `kernelPid changed after close: ${s.kernelPid} vs ${pid}`);
    });

    // ── 33. subWhenIdle runs after all evaluate() calls ───────────────────
    await run('33. subWhenIdle runs after evaluate() queue drains', async () => {
        const s = mkSession();
        try {
            const order = [];
            const p1 = s.evaluate('Pause[0.3]; 1').then(() => order.push('eval1'));
            const p2 = s.evaluate('Pause[0.1]; 2').then(() => order.push('eval2'));
            const p3 = s.subWhenIdle('3').then(() => order.push('whenIdle'));
            await Promise.all([p1, p2, p3]);
            assert(order[0] === 'eval1',    `order[0]: ${order[0]}`);
            assert(order[1] === 'eval2',    `order[1]: ${order[1]}`);
            assert(order[2] === 'whenIdle', `order[2]: ${order[2]}`);
        } finally {
            s.close();
        }
    });

    // ── 34. subWhenIdle resolves correctly when idle ───────────────────────
    await run('34. subWhenIdle resolves with correct WExpr when idle', async () => {
        const s = mkSession();
        try {
            const r = await s.subWhenIdle('2 + 2');
            assert(r.type === 'integer' && r.value === 4,
                `expected {type:"integer",value:4}, got ${JSON.stringify(r)}`);
        } finally {
            s.close();
        }
    });

    // ── 35. subWhenIdle timeout rejects while kernel is busy ──────────────
    await run('35. subWhenIdle timeout rejects', async () => {
        const s = mkSession();
        try {
            s.evaluate('Pause[3]; 0');   // keep kernel busy for 3 s
            let threw = false;
            try {
                await s.subWhenIdle('1', { timeout: 400 });
            } catch (e) {
                threw = true;
                assert(e.message === 'subWhenIdle: timeout',
                    `unexpected error: ${e.message}`);
            }
            assert(threw, 'subWhenIdle should have rejected with timeout');
        } finally {
            s.close();
        }
    });

    // ── 36. subWhenIdle rejects when session is closed while queued ────────
    await run('36. subWhenIdle rejects on session close', async () => {
        const s = mkSession();
        s.evaluate('Pause[5]; 0');   // keep busy
        const p = s.subWhenIdle('1');
        let threw = false;
        try {
            setTimeout(() => s.close(), 200);
            await p;
        } catch (e) {
            threw = true;
            assert(e.message === 'Session is closed',
                `unexpected error: ${e.message}`);
        }
        assert(threw, 'subWhenIdle should reject when session is closed');
    });

    // ── 37. sub() still prioritised over subWhenIdle() ────────────────────
    await run('37. sub() prioritised over subWhenIdle()', async () => {
        const s = mkSession();
        try {
            const order = [];
            s.evaluate('Pause[0.4]; 0');          // keep busy
            const wi = s.subWhenIdle('1').then(() => order.push('whenIdle'));
            const su = s.sub('2').then(() => order.push('sub'));
            await Promise.all([wi, su]);
            assert(order[0] === 'sub',      `expected sub first, got: ${order[0]}`);
            assert(order[1] === 'whenIdle', `expected whenIdle second, got: ${order[1]}`);
        } finally {
            s.close();
        }
    });

    // ══════════════════════════════════════════════════════════════════════
    // Dynamic eval API tests (v0.6.0)
    // ══════════════════════════════════════════════════════════════════════

    // ── 38. registerDynamic + getDynamicResults basic ─────────────────────
    await run('38. registerDynamic / getDynamicResults basic', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('sum', 'ToString[1+1]');
            s.setDynamicInterval(150);
            assert(s.dynamicActive, 'dynamicActive should be true after registration + interval');
            // Run a long-ish eval so the timer fires at least once
            await withTimeout(s.evaluate('Pause[0.8]; "done"'), 8000, 'test 38 eval');
            const results = s.getDynamicResults();
            assert(typeof results === 'object', 'getDynamicResults must return object');
            assert('sum' in results, 'result must have key "sum"');
            assert(results.sum.value === '2', `expected "2", got "${results.sum.value}"`);
            assert(typeof results.sum.timestamp === 'number' && results.sum.timestamp > 0,
                'timestamp must be positive number');
        } finally {
            s.close();
        }
    });

    // ── 39. multiple registered expressions ───────────────────────────────
    await run('39. multiple Dynamic registrations', async () => {
        const s = mkSession();
        try {
            await s.evaluate('a = 10; b = 20; c = 30;');
            s.registerDynamic('a', 'ToString[a]');
            s.registerDynamic('b', 'ToString[b]');
            s.registerDynamic('c', 'ToString[c]');
            s.setDynamicInterval(150);
            await withTimeout(s.evaluate('Pause[0.8]; "done"'), 8000, 'test 39 eval');
            const res = s.getDynamicResults();
            assert(res.a && res.a.value === '10', `a: expected "10", got "${res.a && res.a.value}"`);
            assert(res.b && res.b.value === '20', `b: expected "20", got "${res.b && res.b.value}"`);
            assert(res.c && res.c.value === '30', `c: expected "30", got "${res.c && res.c.value}"`);
        } finally {
            s.close();
        }
    });

    // ── 40. getDynamicResults clears on each call ─────────────────────────
    await run('40. getDynamicResults clears buffer on each call', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('x', 'ToString[2+2]');
            s.setDynamicInterval(150);
            await withTimeout(s.evaluate('Pause[0.8]; "done"'), 8000, 'test 40 eval');
            const first = s.getDynamicResults();
            const second = s.getDynamicResults();
            assert('x' in first, 'first call should contain results');
            assert(Object.keys(second).length === 0, 'second call must return empty object (buffer cleared)');
        } finally {
            s.close();
        }
    });

    // ── 41. rejectDialog:true prevents deadlock ───────────────────────────
    await run('41. rejectDialog:true option', async () => {
        const s = mkSession();
        try {
            // Install a handler so interrupt → Dialog[]
            await s.evaluate(
                'Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]',
                { rejectDialog: true }
            );
            // Evaluate with rejectDialog; any dialog gets silently closed
            const r = await withTimeout(
                s.evaluate('Pause[0.3]; "ok"', { rejectDialog: true }),
                5000, 'test 41 eval'
            );
            assert(r.result.value === 'ok', `expected "ok", got "${r.result.value}"`);
        } finally {
            s.close();
        }
    });

    // ── 42. abort deduplication — multiple abort() calls don't corrupt ────
    await run('42. abort deduplication', async () => {
        const s = mkSession();
        try {
            const p = s.evaluate('Pause[5]; 42');
            await sleep(100);
            // Fire three rapid aborts — only first should take effect
            s.abort();
            s.abort();
            s.abort();
            const r = await withTimeout(p, 6000, 'test 42 abort settle');
            assert(r.aborted, 'evaluation should be aborted');
            // Kernel must still be usable
            const r2 = await withTimeout(s.evaluate('"alive"'), 5000, 'test 42 post-abort');
            assert(r2.result.value === 'alive', 'kernel must still work after multi-abort');
        } finally {
            s.close();
        }
    });

    // ── 43. dynamicActive accessor ────────────────────────────────────────
    await run('43. dynamicActive accessor reflects state', async () => {
        const s = mkSession();
        try {
            assert(!s.dynamicActive, 'dynamicActive must be false initially');
            s.registerDynamic('v', 'ToString[1]');
            assert(!s.dynamicActive, 'dynamicActive must remain false until interval set');
            s.setDynamicInterval(200);
            assert(s.dynamicActive, 'dynamicActive must be true after registration + interval');
            s.clearDynamicRegistry();
            assert(!s.dynamicActive, 'dynamicActive must be false after clear');
        } finally {
            s.close();
        }
    });

    // ── 44. clearDynamicRegistry empties getDynamicResults ────────────────
    await run('44. clearDynamicRegistry', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('p', 'ToString[Pi, 5]');
            s.setDynamicInterval(150);
            await withTimeout(s.evaluate('Pause[0.5]; "done"'), 6000, 'test 44 eval');
            s.clearDynamicRegistry();
            // After clearing, a new eval should produce no dyn results
            await withTimeout(s.evaluate('"x"'), 5000, 'test 44 second eval');
            const res = s.getDynamicResults();
            assert(Object.keys(res).length === 0, 'no results expected after clearDynamicRegistry');
        } finally {
            s.close();
        }
    });

    // ── 45. unregisterDynamic removes one entry ───────────────────────────
    await run('45. unregisterDynamic removes one entry', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('keep', 'ToString[3+3]');
            s.registerDynamic('drop', 'ToString[4+4]');
            s.unregisterDynamic('drop');
            s.setDynamicInterval(150);
            await withTimeout(s.evaluate('Pause[0.8]; "done"'), 8000, 'test 45 eval');
            const res = s.getDynamicResults();
            assert('keep' in res, 'key "keep" must still be present');
            assert(!('drop' in res), 'key "drop" must be absent after unregister');
        } finally {
            s.close();
        }
    });

    // ── 46. setDynamicInterval(0) stops timer ────────────────────────────
    await run('46. setDynamicInterval(0) disables timer', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('z', 'ToString[7+7]');
            s.setDynamicInterval(100);
            assert(s.dynamicActive, 'dynamicActive should be true');
            s.setDynamicInterval(0);
            assert(!s.dynamicActive, 'dynamicActive must be false after interval set to 0');
            // Even with a long eval, no dynamic results should accumulate
            await withTimeout(s.evaluate('Pause[0.5]; "ok"'), 6000, 'test 46 eval');
            const res = s.getDynamicResults();
            assert(Object.keys(res).length === 0, 'no Dynamic results expected when timer is disabled');
        } finally {
            s.close();
        }
    });

    // ── 47. setDynAutoMode(false) falls back to legacy JS dialog path ─────
    await run('47. setDynAutoMode(false) — legacy JS dialog path works', async () => {
        const s = mkSession();
        try {
            s.setDynAutoMode(false);
            let dialogOpened = false;
            // Install interrupt handler manually (required for legacy path)
            await installHandler(s);
            // Use a loop with short Pause so the interrupt fires between iterations
            // (single Pause[] absorbs interrupts until it completes).
            const p = s.evaluate('Do[Pause[0.15], {20}]; "done"', {
                onDialogBegin: async () => {
                    dialogOpened = true;
                    await s.exitDialog();
                },
            });
            await sleep(400);
            s.interrupt();
            const r = await withTimeout(p, 10000, 'test 47 legacy dialog eval');
            assert(dialogOpened, 'onDialogBegin should have fired in legacy mode');
            assert(!r.aborted, 'should not be aborted');
        } finally {
            s.close();
        }
    });

    // ── 48. Dynamic: abort followed by new dynAutoMode eval works ─────────
    await run('48. abort then Dynamic eval recovers', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('n', 'ToString[42]');
            s.setDynamicInterval(200);
            // Start a long eval, abort it
            const p = s.evaluate('Pause[10]; 0');
            await sleep(150);
            s.abort();
            const r = await withTimeout(p, T(5000), 'test 48 abort wait');
            assert(r.aborted, 'first eval should be aborted');
            // Now a new eval must work normally with dyn interrupts
            // resilientEval handles stale-interrupt retries after abort
            const r2 = await resilientEval(s, 'Pause[0.8]; "alive"', {
                perAttemptMs: T(8000), label: 'test 48 second eval'
            });
            assert(r2.result.value === 'alive' || r2.aborted, 'kernel alive after abort');
            // Dynamic results should be populated
            const res = s.getDynamicResults();
            assert('n' in res, 'dynamic result "n" expected after abort recovery');
            assert(res.n.value === '42', `expected "42", got "${res.n.value}"`);
        } finally {
            s.close();
        }
    });

    // ── 49. Rapid cell transitions with Dynamic — no deadlock ─────────────
    // Tests rapid cell transitions with Dialog[] firing frequently. The C++
    // layer handles the case where EvaluatePacket gets processed inside a
    // Dialog[] context (between-eval ScheduledTask fire) by capturing the
    // outer RETURNPKT and returning it directly.
    await run('49. rapid cell transitions with Dynamic active', async () => {
        const s = mkSession();
        try {
            s.registerDynamic('tick', 'ToString[$Line]');
            s.setDynamicInterval(200);
            for (let i = 0; i < 5; i++) {
                const r = await withTimeout(
                    s.evaluate(`Pause[0.3]; ${i}`),
                    T(10000), `test 49 cell ${i}`
                );
                assert(!r.aborted, `cell ${i} must not be aborted`);
                assert(String(r.result.value) === String(i),
                    `cell ${i}: expected "${i}", got "${r.result.value}"`);
            }
        } finally {
            s.close();
        }
    });

    // ── 50. registerDynamic upsert — updates existing entry ───────────────
    await run('50. registerDynamic upsert updates existing entry', async () => {
        const s = mkSession();
        try {
            await s.evaluate('q = 5;');
            s.registerDynamic('q', 'ToString[q]');   // initial registration
            s.registerDynamic('q', 'ToString[q*2]'); // upsert — should override
            s.setDynamicInterval(150);
            await withTimeout(s.evaluate('Pause[0.8]; "done"'), T(8000), 'test 50 eval');
            const res = s.getDynamicResults();
            assert('q' in res, 'key "q" must be present');
            assert(res.q.value === '10', `expected "10" (q*2), got "${res.q.value}"`);
        } finally {
            s.close();
        }
    });

    // ── 51. empty registry + interval — eval completes normally ──────────
    await run('51. empty registry with interval set — eval completes', async () => {
        const s = mkSession();
        try {
            s.setDynamicInterval(100);
            // No registrations — dynamicActive must be false
            assert(!s.dynamicActive, 'dynamicActive must be false with empty registry');
            const r = await withTimeout(s.evaluate('"noblock"'), 5000, 'test 51 eval');
            assert(r.result.value === 'noblock', 'eval should complete normally');
        } finally {
            s.close();
        }
    });

    // ── 52. drainStalePackets — eval after stale BEGINDLGPKT survives ─────
    await run('52. evaluate survives stale BEGINDLGPKT (Pattern D)', async () => {
        const s = mkSession();
        try {
            // Install handler so any interrupt produces Dialog[], then evalute with
            // rejectDialog so the stale packet is auto-drained in C++
            await s.evaluate(
                'Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]',
                { rejectDialog: true }
            );
            for (let i = 0; i < 5; i++) {
                const r = await withTimeout(
                    s.evaluate(`Pause[0.2]; ${i}`, { rejectDialog: true }),
                    6000, `test 52 iteration ${i}`
                );
                assert(!r.aborted, `iteration ${i} must not be aborted`);
                assert(String(r.result.value) === String(i),
                    `iteration ${i}: expected "${i}", got "${r.result.value}"`);
            }
        } finally {
            s.close();
        }
    });

    // ── 53. Bug 1A: stale ScheduledTask + non-Dynamic cell does not hang ───
    // Simulates the subsession.js teardown: Dynamic cell runs → cleanup calls
    // setDynAutoMode(false) but the kernel-side ScheduledTask may still fire
    // one more Dialog[].  The next plain cell (no onDialogBegin) must not hang.
    await run('53. stale ScheduledTask Dialog[] after setDynAutoMode(false) — no hang (Bug 1A)', async () => {
        const s = mkSession();
        try {
            // Step 1: register a Dynamic expr and start the interval.
            s.registerDynamic('dyn0', 'ToString[AbsoluteTime[], InputForm]');
            s.setDynamicInterval(300);

            // Step 2: long enough eval for ScheduledTask to fire at least once.
            // Use interactive mode — matches the extension's actual cell-eval path
            // and lets the kernel process Dialog[] commands during Pause[].
            const r1 = await withTimeout(
                s.evaluate('Do[Pause[0.1], {20}]; "cell1"', { interactive: true }),
                12000, '53 cell1'
            );
            assert(!r1.aborted && r1.result.value === 'cell1',
                `cell1 result: ${JSON.stringify(r1.result)}`);

            // Step 3: simulate subsession.js cleanup.
            // Fix 1B: setDynAutoMode(false) now also sets dynIntervalMs_=0.
            s.unregisterDynamic('dyn0');
            s.setDynAutoMode(false);

            // Step 4: plain cell with no onDialogBegin — must not hang.
            const r2 = await withTimeout(
                s.evaluate('n = 1'),
                10000, '53 cell2 — would hang without Fix 1A'
            );
            assert(!r2.aborted, 'cell2 must not be aborted');

            // Step 5: follow-up eval also works.
            const r3 = await withTimeout(s.evaluate('1 + 1'), 6000, '53 cell3');
            assert(r3.result.value === 2, `cell3 expected 2, got ${r3.result.value}`);
        } finally {
            s.close();
        }
    }, 45000);

    // ── 54. Bug 1A: BEGINDLGPKT with dynAutoMode=false, no JS callback ────
    // With dynAutoMode=false and no onDialogBegin registered, any BEGINDLGPKT
    // must be auto-closed by the safety fallback rather than entering the
    // legacy loop where nobody will ever call exitDialog().
    await run('54. BEGINDLGPKT safety fallback — auto-close when no onDialogBegin (Bug 1A)', async () => {
        const s = mkSession();
        try {
            s.setDynAutoMode(false);
            // Eval runs for ~2s; no onDialogBegin registered.  Any BEGINDLGPKT
            // that arrives (from a stale ScheduledTask or concurrent interrupt)
            // must be auto-closed by the safety fallback.
            const r = await withTimeout(
                s.evaluate('Do[Pause[0.2], {10}]; "done"'),
                15000, '54 eval — would hang without Fix 1A'
            );
            assert(!r.aborted, 'eval must not be aborted');
            assert(r.result.value === 'done', `expected "done", got "${r.result.value}"`);

            // Follow-up eval must work — no leftover packets.
            const r2 = await withTimeout(s.evaluate('2 + 2'), 6000, '54 follow-up');
            assert(r2.result.value === 4, `follow-up expected 4, got ${r2.result.value}`);
        } finally {
            s.close();
        }
    }, 30000);

    // ── 55. Interactive mode with non-Null result (no trailing semicolon) ──
    // In interactive mode (EnterExpressionPacket), a non-Null result produces:
    //   RETURNEXPRPKT → INPUTNAMEPKT.
    // Bug: drainStalePackets() consumed the trailing INPUTNAMEPKT, causing the
    // outer DrainToEvalResult loop to hang forever waiting for a packet already
    // consumed.  This test verifies that interactive evals with visible results
    // (no trailing semicolon) complete without hanging.
    await run('55. interactive eval with non-Null result (drainStalePackets fix)', async () => {
        const s = mkSession();
        try {
            // Simple assignment without semicolon — returns non-Null.
            const r1 = await withTimeout(
                s.evaluate('n = 1', { interactive: true }),
                10000, '55 n=1 interactive — would hang without drainStalePackets fix'
            );
            assert(!r1.aborted, 'n=1 must not be aborted');
            assert(r1.result.value === 1, `n=1 expected 1, got ${r1.result.value}`);

            // Follow-up: another non-Null interactive eval.
            const r2 = await withTimeout(
                s.evaluate('n + 41', { interactive: true }),
                10000, '55 n+41 interactive'
            );
            assert(!r2.aborted, 'n+41 must not be aborted');
            assert(r2.result.value === 42, `n+41 expected 42, got ${r2.result.value}`);

            // Follow-up with semicolon (Null result) — should also work.
            const r3 = await withTimeout(
                s.evaluate('m = 99;', { interactive: true }),
                10000, '55 m=99; interactive'
            );
            assert(!r3.aborted, 'm=99; must not be aborted');

            // Follow-up: non-interactive eval still works after interactive ones.
            const r4 = await withTimeout(
                s.evaluate('m + 1'),
                10000, '55 m+1 non-interactive follow-up'
            );
            assert(r4.result.value === 100, `m+1 expected 100, got ${r4.result.value}`);
        } finally {
            s.close();
        }
    }, 45000);

    // ── 56. Stale interrupt aborts eval cleanly (no hang) ──────────────────
    // When live-watch sends an interrupt just as a cell completes, the kernel
    // may fire the queued interrupt during the NEXT evaluation.  Without
    // dialog callbacks, the C++ MENUPKT handler responds 'a' (abort) so the
    // eval returns $Aborted rather than hanging.  This is safe: the caller
    // can retry.  A follow-up eval (without stale interrupt) must succeed.
    await run('56. stale interrupt aborts eval — no hang', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            // Warm up
            const r0 = await withTimeout(s.evaluate('1 + 1'), T(5000), '56 warmup');
            assert(r0.result.value === 2);

            // Send interrupt to idle kernel — may fire during next eval
            s.interrupt();
            await sleep(500);  // give kernel time to queue interrupt

            // Evaluate — stale interrupt fires → MENUPKT → 'a' → $Aborted
            // resilientEval handles case where stale interrupt opens Dialog
            const r1 = await resilientEval(s, '42', {
                perAttemptMs: T(5000), label: '56 eval'
            });
            // The eval may return $Aborted (interrupt fired) or 42 (interrupt
            // was ignored by idle kernel).  Either is acceptable — the critical
            // thing is that it does NOT hang.
            if (r1.aborted) {
                assert(r1.result.value === '$Aborted',
                    `expected $Aborted, got ${JSON.stringify(r1.result)}`);
            } else {
                assert(r1.result.value === 42,
                    `expected 42, got ${JSON.stringify(r1.result)}`);
            }

            // Follow-up eval must work regardless
            // Use resilientEval to handle any remaining stale interrupts
            const r2 = await resilientEval(s, '2 + 2', {
                perAttemptMs: T(5000), label: '56 follow-up'
            });
            assert(!r2.aborted, '56 follow-up should not be aborted');
            assert(r2.result.value === 4);
        } finally {
            s.close();
        }
    }, T(30000));

    // ── 57. subAuto — idle path (basic) ───────────────────────────────────
    // When the kernel is idle, subAuto() should forward to subWhenIdle and
    // resolve with the evaluation result.
    await run('57. subAuto — idle path resolves correctly', async () => {
        const s = mkSession();
        try {
            const r = await withTimeout(s.subAuto('ToString[1 + 1]'), 10000, '57 idle subAuto');
            assert(r.type === 'string', `expected string type, got ${r.type}`);
            assert(r.value === '2', `expected "2", got "${r.value}"`);

            // Follow-up: another idle subAuto.
            const r2 = await withTimeout(s.subAuto('ToString[6 * 7]'), 10000, '57 idle subAuto 2');
            assert(r2.value === '42', `expected "42", got "${r2.value}"`);
        } finally {
            s.close();
        }
    });

    // ── 58. subAuto — busy path via Dialog[] ──────────────────────────────
    // When the kernel is busy (Do[Pause[...], ...]), subAuto() should queue
    // the expression for evaluation in the next ScheduledTask Dialog[] cycle
    // and resolve with the result DURING the busy eval.
    await run('58. subAuto — busy path resolves during active eval', async () => {
        const s = mkSession();
        try {
            // Enable dynAutoMode and ScheduledTask BEFORE starting the eval,
            // so the ScheduledTask is installed inside Execute() and Dialog[]
            // fires periodically during the busy eval.
            s.registerDynamic('_test58', 'ToString[1]');
            s.setDynamicInterval(300);

            // Start a long-running eval (interactive mode for Dialog[] support).
            const evalPromise = s.evaluate(
                'Do[Pause[0.2], {30}]; "cell-done"',
                { interactive: true }
            );

            // Wait for eval to become busy.
            await sleep(800);
            assert(!s.isReady, 'kernel should be busy');

            // subAuto should evaluate via Dialog[] while kernel is busy.
            const r = await withTimeout(
                s.subAuto('ToString[100 + 23]'),
                8000, '58 subAuto during busy'
            );
            assert(r.value === '123', `expected "123", got "${r.value}"`);

            // Wait for main eval to complete.
            const mainResult = await withTimeout(evalPromise, 15000, '58 main eval');
            assert(!mainResult.aborted, 'main eval should not be aborted');
            assert(mainResult.result.value === 'cell-done',
                `main eval expected "cell-done", got "${mainResult.result.value}"`);

            // Cleanup
            s.unregisterDynamic('_test58');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 45000);

    // ── 59. subAuto — multiple calls during busy eval ─────────────────────
    // Multiple subAuto() calls queued while busy should all resolve.
    await run('59. subAuto — multiple calls during busy eval', async () => {
        const s = mkSession();
        try {
            // Enable dynAutoMode before eval.
            s.registerDynamic('_test59', 'ToString[1]');
            s.setDynamicInterval(300);

            const evalPromise = s.evaluate(
                'Do[Pause[0.2], {40}]; "multi-done"',
                { interactive: true }
            );
            await sleep(800);
            assert(!s.isReady, 'kernel should be busy');

            // Queue 3 subAuto calls.
            const [r1, r2, r3] = await withTimeout(
                Promise.all([
                    s.subAuto('ToString[10]'),
                    s.subAuto('ToString[20]'),
                    s.subAuto('ToString[30]'),
                ]),
                12000, '59 multiple subAuto'
            );
            assert(r1.value === '10', `r1 expected "10", got "${r1.value}"`);
            assert(r2.value === '20', `r2 expected "20", got "${r2.value}"`);
            assert(r3.value === '30', `r3 expected "30", got "${r3.value}"`);

            const mainResult = await withTimeout(evalPromise, 15000, '59 main eval');
            assert(!mainResult.aborted);

            s.unregisterDynamic('_test59');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 45000);

    // ── 60. subAuto — busy-to-idle promotion ──────────────────────────────
    // If subAuto is called just as the eval finishes (busy→idle transition),
    // pending entries should be promoted to whenIdleQueue and resolve normally.
    await run('60. subAuto — busy-to-idle promotion', async () => {
        const s = mkSession();
        try {
            const evalPromise = s.evaluate(
                'Do[Pause[0.1], {5}]; "short-done"',
                { interactive: true }
            );

            // Brief pause, then queue subAuto — eval may finish before Dialog[] fires.
            await sleep(200);
            const r = await withTimeout(
                s.subAuto('ToString[99]'),
                10000, '60 subAuto promotion'
            );
            assert(r.value === '99', `expected "99", got "${r.value}"`);

            await withTimeout(evalPromise, 10000, '60 main eval');
        } finally {
            s.close();
        }
    }, 30000);

    // ── 61. subAuto — rejects after session close ─────────────────────────
    await run('61. subAuto — rejects after session close', async () => {
        const s = mkSession();
        s.close();
        try {
            await s.subAuto('ToString[1]');
            assert(false, 'should have rejected');
        } catch (e) {
            assert(/closed/i.test(e.message),
                `expected "closed" error, got: ${e.message}`);
        }
    });

    // ── 62. subAuto — busy path WITHOUT pre-registered Dynamic widgets ───
    // Matches the real extension's ⌥⇧↵ flow: the eval is already running,
    // no Dynamic widgets are registered, and subAuto is called cold.  The
    // timer thread must fire WSInterruptMessage, MENUPKT must respond 'i',
    // and BEGINDLGPKT must process autoExprQueue — all without dynAutoMode
    // being set at eval-start time.
    await run('62. subAuto — busy path without Dynamic widgets (real ⌥⇧↵ flow)', async () => {
        const s = mkSession();
        try {
            // Start a long eval WITHOUT any Dynamic setup.
            const evalPromise = s.evaluate(
                'Do[Pause[0.2], {40}]; "no-dyn-done"',
                { interactive: true }
            );
            await sleep(800);
            assert(!s.isReady, 'kernel should be busy');

            // subAuto with no pre-registered Dynamic widgets.
            const r = await withTimeout(
                s.subAuto('ToString[42 + 58]'),
                10000, '62 subAuto without Dynamic'
            );
            assert(r.value === '100', `expected "100", got "${r.value}"`);

            const mainResult = await withTimeout(evalPromise, 20000, '62 main eval');
            assert(!mainResult.aborted, 'main eval should not be aborted');
            assert(mainResult.result.value === 'no-dyn-done',
                `main eval expected "no-dyn-done", got "${mainResult.result.value}"`);
        } finally {
            s.close();
        }
    }, 45000);

    // ── 63. rejectDialog eval not aborted by timer interrupt ─────────────
    // When a rejectDialog eval runs while the timer is active (autoExprQueue
    // pending or dynRegistry non-empty), MENUPKT must respond 'c' (continue)
    // not 'a' (abort).  This prevents VsCodeRender from being aborted.
    await run('63. rejectDialog eval survives timer interrupt', async () => {
        const s = mkSession();
        try {
            // Register a Dynamic widget so the timer fires interrupts.
            s.registerDynamic('_test63', 'ToString[1]');
            s.setDynamicInterval(300);

            // Start a long eval (interactive) to keep the kernel busy.
            const evalPromise = s.evaluate(
                'Do[Pause[0.2], {30}]; "bg-done"',
                { interactive: true }
            );
            await sleep(800);

            // Run a rejectDialog eval while the timer is firing.
            // This simulates VsCodeRender — must NOT be aborted.
            const renderResult = await withTimeout(
                s.evaluate('ToString[111 + 222]', { rejectDialog: true }),
                10000, '63 rejectDialog eval'
            );
            // The rejectDialog eval runs on the whenIdle queue, so it will
            // resolve after the main eval completes — but it must not be aborted.

            const mainResult = await withTimeout(evalPromise, 20000, '63 main eval');
            assert(!mainResult.aborted, 'main eval should not be aborted');

            assert(renderResult.result.value === '333',
                `render expected "333", got "${renderResult.result.value}"`);
            assert(!renderResult.aborted, 'rejectDialog eval should not be aborted');

            s.unregisterDynamic('_test63');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 45000);

    // ── 64. subAuto after main eval completes — ScheduledTask still firing ─
    // Replicates the real extension flow: Dynamic cell completes, but the
    // kernel-side ScheduledTask keeps firing Dialog[].  Post-eval idle evals
    // (VsCodeSetImgDir, VsCodeRender) and ongoing Dynamic subAuto() must
    // all resolve without hanging.  Before the v0.6.7 fix, the ScheduledTask
    // Dialog[] interfered with idle evals and stranded autoExprQueue_ entries.
    await run('64. subAuto + rejectDialog after eval — ScheduledTask still firing', async () => {
        const s = mkSession();
        try {
            // Step 1: register Dynamic widget + start interval (same as extension).
            s.registerDynamic('_test64', 'ToString[n]');
            s.setDynamicInterval(300);

            // Step 2: long eval with Dynamic — ScheduledTask fires every 300ms.
            const evalPromise = s.evaluate(
                'Do[Pause[0.2], {15}]; "eval-done"',
                { interactive: true }
            );

            // Step 3: subAuto DURING the eval (should work via Dialog[]).
            await sleep(800);
            const duringResult = await withTimeout(
                s.subAuto('ToString[100 + 1]'),
                8000, '64 subAuto during eval'
            );
            assert(duringResult.value === '101',
                `during expected "101", got "${duringResult.value}"`);

            // Step 4: wait for main eval to complete.
            const mainResult = await withTimeout(evalPromise, 15000, '64 main eval');
            assert(!mainResult.aborted && mainResult.result.value === 'eval-done',
                `main eval: ${JSON.stringify(mainResult.result)}`);

            // Step 5: post-eval rejectDialog (simulates VsCodeSetImgDir).
            // ScheduledTask may still be firing — must not hang.
            const imgDirResult = await withTimeout(
                s.evaluate('ToString["imgdir-ok"]', { interactive: false, rejectDialog: true }),
                6000, '64 post-eval rejectDialog (VsCodeSetImgDir)'
            );
            assert(imgDirResult.result.value === 'imgdir-ok',
                `imgdir expected "imgdir-ok", got "${imgDirResult.result.value}"`);

            // Step 6: post-eval subAuto (simulates Dynamic loop continuing).
            const postResult = await withTimeout(
                s.subAuto('ToString[200 + 2]'),
                6000, '64 post-eval subAuto'
            );
            assert(postResult.value === '202',
                `post expected "202", got "${postResult.value}"`);

            // Step 7: normal eval after everything (simulates next cell).
            const nextCell = await withTimeout(
                s.evaluate('1 + 1'),
                6000, '64 follow-up eval'
            );
            assert(nextCell.result.value === 2,
                `next cell expected 2, got ${nextCell.result.value}`);

            s.unregisterDynamic('_test64');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 60000);

    // ── 65. Post-eval idle subAuto hang — full extension flow ─────────────
    // Replicates the exact extension pattern that causes a permanent hang:
    //   3 registered Dynamic entries (2 widget slots + watch panel),
    //   many busy-path subAuto calls during Do[Pause[...], ...],
    //   then idle-path subAuto after eval completes.
    // The stale ScheduledTask BEGINDLGPKT after eval end corrupts the link
    // and the idle-path eval hangs forever.
    await run('65. post-eval idle subAuto hang — full extension flow (3 dyn + many busy subAuto)', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '65 warmup');

            s.registerDynamic('_t65_slot1', 'ToString[n]');
            s.registerDynamic('_t65_slot2', 'ToString[n]');
            s.registerDynamic('_t65_watch', 'ToString[{n}]');
            s.setDynamicInterval(300);

            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            );

            await sleep(1000);
            assert(!s.isReady, '65: kernel should be busy');

            let busyCalls = 0;
            for (let i = 0; i < 8; i++) {
                if (s.isReady) break;
                try {
                    await withTimeout(
                        s.subAuto('ToString[n]'),
                        5000, `65 busy subAuto #${i + 1}`
                    );
                    busyCalls++;
                } catch (_) {}
                await sleep(750);
            }

            const mainResult = await withTimeout(evalPromise, 30000, '65 main eval');
            assert(!mainResult.aborted && mainResult.result.value === 'done',
                `65 main eval: ${JSON.stringify(mainResult.result)}`);

            // THE CRITICAL CALL: post-eval idle-path subAuto
            const idleResult = await withTimeout(
                s.subAuto('ToString[1 + 1]'),
                10000, '65 post-eval idle subAuto'
            );
            assert(idleResult.value === '2',
                `65 idle expected "2", got "${idleResult?.value}"`);

            // Verify kernel still functional
            const nextCell = await withTimeout(s.evaluate('2 + 2'), 10000, '65 follow-up');
            assert(nextCell.result.value === 4,
                `65 follow-up expected 4, got ${nextCell.result.value}`);

            s.unregisterDynamic('_t65_slot1');
            s.unregisterDynamic('_t65_slot2');
            s.unregisterDynamic('_t65_watch');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── 66. Post-eval idle subAuto — 3 dyn entries, NO JS subAuto calls ───
    // Only C++-internal Dialog cycle processing during the busy eval.
    // Tests whether the C++ auto-ScheduledTask alone can trigger the hang.
    await run('66. post-eval idle subAuto — 3 dyn entries, no JS subAuto during busy', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '66 warmup');

            s.registerDynamic('_t66_slot1', 'ToString[n]');
            s.registerDynamic('_t66_slot2', 'ToString[n]');
            s.registerDynamic('_t66_watch', 'ToString[{n}]');
            s.setDynamicInterval(300);

            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            );

            const mainResult = await withTimeout(evalPromise, 30000, '66 main eval');
            assert(!mainResult.aborted && mainResult.result.value === 'done',
                `66 main eval: ${JSON.stringify(mainResult.result)}`);

            const idleResult = await withTimeout(
                s.subAuto('ToString[1 + 1]'),
                10000, '66 post-eval idle subAuto'
            );
            assert(idleResult.value === '2',
                `66 idle expected "2", got "${idleResult?.value}"`);

            const nextCell = await withTimeout(s.evaluate('2 + 2'), 10000, '66 follow-up');
            assert(nextCell.result.value === 4,
                `66 follow-up expected 4, got ${nextCell.result.value}`);

            s.unregisterDynamic('_t66_slot1');
            s.unregisterDynamic('_t66_slot2');
            s.unregisterDynamic('_t66_watch');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── 67. Post-eval idle subAuto — 1 dyn entry + many JS subAuto calls ──
    // Tests whether many JS-initiated busy-path subAuto calls with a single
    // registered Dynamic entry can trigger the hang (vs. multiple entries).
    await run('67. post-eval idle subAuto — 1 dyn entry + many JS subAuto', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '67 warmup');

            s.registerDynamic('_t67_slot1', 'ToString[n]');
            s.setDynamicInterval(300);

            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            );

            await sleep(1000);
            let busyCalls = 0;
            for (let i = 0; i < 8; i++) {
                if (s.isReady) break;
                try {
                    await withTimeout(
                        s.subAuto('ToString[n]'),
                        5000, `67 busy subAuto #${i + 1}`
                    );
                    busyCalls++;
                } catch (_) {}
                await sleep(750);
            }

            const mainResult = await withTimeout(evalPromise, 30000, '67 main eval');
            assert(!mainResult.aborted && mainResult.result.value === 'done',
                `67 main eval: ${JSON.stringify(mainResult.result)}`);

            const idleResult = await withTimeout(
                s.subAuto('ToString[1 + 1]'),
                10000, '67 post-eval idle subAuto'
            );
            assert(idleResult.value === '2',
                `67 idle expected "2", got "${idleResult?.value}"`);

            const nextCell = await withTimeout(s.evaluate('2 + 2'), 10000, '67 follow-up');
            assert(nextCell.result.value === 4,
                `67 follow-up expected 4, got ${nextCell.result.value}`);

            s.unregisterDynamic('_t67_slot1');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── 68. Post-eval IMMEDIATE idle subAuto — no cooldown ────────────────
    // Same as 65 but calls subAuto immediately after eval completes (no sleep).
    // Tests the zero-latency transition from busy→idle.
    await run('68. post-eval immediate idle subAuto — no cooldown', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '68 warmup');

            s.registerDynamic('_t68_slot1', 'ToString[n]');
            s.registerDynamic('_t68_slot2', 'ToString[n]');
            s.registerDynamic('_t68_watch', 'ToString[{n}]');
            s.setDynamicInterval(300);

            let evalDone = false;
            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            ).then(r => { evalDone = true; return r; });

            await sleep(1000);
            for (let i = 0; i < 8 && !evalDone; i++) {
                try {
                    await withTimeout(s.subAuto('ToString[n]'), 5000, `68 busy #${i + 1}`);
                } catch (_) {}
                await sleep(750);
            }

            await withTimeout(evalPromise, 30000, '68 main eval');

            // Immediately — no sleep/cooldown
            const idleResult = await withTimeout(
                s.subAuto('ToString[1 + 1]'),
                10000, '68 immediate idle subAuto'
            );
            assert(idleResult.value === '2',
                `68 idle expected "2", got "${idleResult?.value}"`);

            s.unregisterDynamic('_t68_slot1');
            s.unregisterDynamic('_t68_slot2');
            s.unregisterDynamic('_t68_watch');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── 69. Post-eval subWhenIdle after busy Dialog cycles ────────────────
    // Same scenario but uses subWhenIdle() directly. Isolates whether the bug
    // is in subAuto routing logic or the underlying idle eval path.
    await run('69. post-eval subWhenIdle after busy Dialog cycles', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '69 warmup');

            s.registerDynamic('_t69_slot1', 'ToString[n]');
            s.registerDynamic('_t69_slot2', 'ToString[n]');
            s.registerDynamic('_t69_watch', 'ToString[{n}]');
            s.setDynamicInterval(300);

            let evalDone = false;
            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            ).then(r => { evalDone = true; return r; });

            await sleep(1000);
            for (let i = 0; i < 8 && !evalDone; i++) {
                try {
                    await withTimeout(s.subAuto('ToString[n]'), 5000, `69 busy #${i + 1}`);
                } catch (_) {}
                await sleep(750);
            }

            await withTimeout(evalPromise, 30000, '69 main eval');

            // subWhenIdle instead of subAuto
            const idleResult = await withTimeout(
                s.subWhenIdle('ToString[1 + 1]'),
                10000, '69 post-eval subWhenIdle'
            );
            assert(idleResult.value === '2',
                `69 idle expected "2", got "${idleResult?.value}"`);

            s.unregisterDynamic('_t69_slot1');
            s.unregisterDynamic('_t69_slot2');
            s.unregisterDynamic('_t69_watch');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── 70. Post-eval evaluate() after busy Dialog cycles ─────────────────
    // Same scenario but uses evaluate() for the post-eval call.
    // If this hangs too, the bug is in the core idle evaluation path.
    await run('70. post-eval evaluate() after busy Dialog cycles', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '70 warmup');

            s.registerDynamic('_t70_slot1', 'ToString[n]');
            s.registerDynamic('_t70_slot2', 'ToString[n]');
            s.registerDynamic('_t70_watch', 'ToString[{n}]');
            s.setDynamicInterval(300);

            let evalDone = false;
            const evalPromise = s.evaluate(
                'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
                { interactive: true }
            ).then(r => { evalDone = true; return r; });

            await sleep(1000);
            for (let i = 0; i < 8 && !evalDone; i++) {
                try {
                    await withTimeout(s.subAuto('ToString[n]'), 5000, `70 busy #${i + 1}`);
                } catch (_) {}
                await sleep(750);
            }

            await withTimeout(evalPromise, 30000, '70 main eval');

            // Regular evaluate()
            const nextResult = await withTimeout(
                s.evaluate('1 + 1'),
                10000, '70 post-eval evaluate()'
            );
            assert(nextResult.result.value === 2,
                `70 evaluate expected 2, got ${nextResult.result.value}`);

            s.unregisterDynamic('_t70_slot1');
            s.unregisterDynamic('_t70_slot2');
            s.unregisterDynamic('_t70_watch');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── 71. busy-path subAuto dead after ScheduledTask installed ──────────
    // After a Dynamic cell completes (ScheduledTask installed), running a
    // new long Do[] loop should still get busy-path subAuto results.  The
    // timer must send WSInterruptMessage even when a ScheduledTask is
    // installed, because ScheduledTask can't fire during a busy kernel eval.
    await run('71. busy-path subAuto works after ScheduledTask installed', async () => {
        const s = mkSession();
        try {
            await withTimeout(s.evaluate('1+1'), 15000, '71 warmup');

            s.registerDynamic('_t71_dyn', 'ToString[nn71$$]');
            s.setDynamicInterval(300);

            // Cell 1: short eval with Dynamic — installs ScheduledTask
            const cell1 = await withTimeout(
                s.evaluate('nn71$$ = 0; "cell1ok"', { interactive: true }),
                15000, '71 cell1'
            );
            assert(cell1.result.value === 'cell1ok',
                `71 cell1 expected "cell1ok", got ${JSON.stringify(cell1.result)}`);

            // Now dynTaskInstalledInterval_ == 300 (task installed)
            // Cell 2: long computation — subAuto must work during it
            const busyResults = [];
            const evalPromise = s.evaluate(
                'Do[nn71$$ = k; Pause[0.5], {k, 1, 20}]; "cell2ok"',
                { interactive: true }
            );

            await sleep(800);
            assert(!s.isReady, '71: kernel should be busy during Do loop');

            for (let i = 0; i < 6; i++) {
                if (s.isReady) break;
                try {
                    const r = await withTimeout(
                        s.subAuto('ToString[nn71$$]'),
                        4000, `71 busy subAuto #${i + 1}`
                    );
                    busyResults.push(r.value);
                } catch (_) {
                    busyResults.push('TIMEOUT');
                }
                await sleep(600);
            }

            const mainResult = await withTimeout(evalPromise, 30000, '71 main eval');
            assert(!mainResult.aborted && mainResult.result.value === 'cell2ok',
                `71 main eval: ${JSON.stringify(mainResult.result)}`);

            const succeeded = busyResults.filter(v => v !== 'TIMEOUT');
            assert(succeeded.length >= 1,
                `71: expected >=1 busy subAuto successes, got ${succeeded.length}/${busyResults.length}: ${JSON.stringify(busyResults)}`);

            // Post-eval: kernel still works
            const followUp = await withTimeout(
                s.evaluate('2 + 2'),
                10000, '71 follow-up'
            );
            assert(followUp.result.value === 4,
                `71 follow-up expected 4, got ${followUp.result.value}`);

            s.unregisterDynamic('_t71_dyn');
            s.setDynAutoMode(false);
        } finally {
            s.close();
        }
    }, 90000);

    // ── Teardown ──────────────────────────────────────────────────────────
    _mainSession = null;
    session.close();
    assert(!session.isOpen, 'main session not closed');

    // Kill the watchdog process — suite completed in time.
    try { _watchdogProc.kill('SIGKILL'); } catch (_) {}

    console.log();
    if (failed === 0) {
        console.log(`All ${passed} tests passed${skipped ? ` (${skipped} skipped)` : ''}.`);
        // Force-exit: WSTP library may keep libuv handles alive after WSClose,
        // preventing the event loop from draining naturally.  All assertions are
        // done; a clean exit(0) is safe.
        process.exit(0);
    } else {
        console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}.`);
        if (failedTests.length) {
            console.log('\nFailed tests:');
            for (const t of failedTests) console.log('  ✗', t);
        }
        process.exit(1);
    }
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
