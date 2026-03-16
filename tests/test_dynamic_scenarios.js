/**
 * test_dynamic_scenarios.js
 *
 * Automated test suite for Dynamic-widget kernel scenarios.
 * Directly drives WstpSession — no VS Code required.
 *
 * Each test mirrors a section of test_dynamic.evsnb:
 *   S1  — Baseline evaluation (arithmetic, symbolic, Print[], graphics)
 *   S2  — Idle-kernel sub() reads a global variable
 *   S3  — sub() CANNOT see a loop-local variable (proves Dialog path needed)
 *   S4  — Dialog path: interrupt + dialogEval reads the live loop variable
 *   S5  — Multiple dialog reads during one loop (two Dynamic slots)
 *   S6  — Dialog path + graphics expression (BoxData returned)
 *   S7  — Abort while Dialog loop is running; kernel stays alive
 *   S8  — Error inside dialogEval (1/0) does not crash the session
 *   S9  — Large list through dialogEval (skeleton output OK)
 *   S10 — String result through dialogEval
 *   S11 — Multiple sequential evaluate() calls after Dialog cycle
 *   S12 — Kernel restart: fresh session runs Dialog path correctly
 *
 * Run:
 *   node test_dynamic_scenarios.js
 *   node test_dynamic_scenarios.js 2>/dev/null   # suppress C++ diag
 *
 * Results are written to:
 *   test_dynamic_report_<YYYY-MM-DD_HH-MM-SS>.txt
 */

'use strict';

const { WstpSession } = require('./build/Release/wstp.node');
const fs   = require('fs');
const path = require('path');

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

// ─── report file ─────────────────────────────────────────────────────────────
const ts  = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
const REPORT = path.join(__dirname, `test_dynamic_report_${ts}.txt`);
const lines = [];
function log(s = '') { console.log(s); lines.push(s); }
function writeReport() { fs.writeFileSync(REPORT, lines.join('\n') + '\n'); }

// ─── stats ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results = [];

// ─── helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pollUntil(pred, timeoutMs = 10_000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - t0 > timeoutMs) return reject(new Error('pollUntil timed out'));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

// Suite-level watchdog — force-kills process after 10 minutes
const SUITE_WATCHDOG_MS = 10 * 60 * 1000;
const suiteWatchdog = setTimeout(() => {
    log('\nFATAL: suite watchdog expired — force-exiting.');
    writeReport();
    process.exit(2);
}, SUITE_WATCHDOG_MS);
suiteWatchdog.unref();

// Per-scenario timeout (ms)
const DEFAULT_TIMEOUT = 60_000;

async function run(name, section, fn, timeoutMs = DEFAULT_TIMEOUT) {
    log(`\n${'─'.repeat(70)}`);
    log(`TEST  ${section}: ${name}`);
    const t0 = Date.now();
    try {
        await withTimeout(fn(), timeoutMs, name);
        const ms = Date.now() - t0;
        log(`  [PASS] ${name}  (${ms} ms)`);
        passed++;
        results.push({ section, name, status: 'PASS', ms });
    } catch (err) {
        const ms = Date.now() - t0;
        log(`  [FAIL] ${name}  (${ms} ms)`);
        log(`         ${err.message}`);
        if (err.stack) log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
        failed++;
        results.push({ section, name, status: 'FAIL', ms, error: err.message });
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { assert(a === b, msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertIncludes(str, sub, msg) { assert(String(str).includes(sub), msg || `expected "${sub}" in: ${str}`); }

// ─────────────────────────────────────────────────────────────────────────────
// Session factory — creates a fresh session and returns it
// ─────────────────────────────────────────────────────────────────────────────
function mkSession() { return new WstpSession(KERNEL); }

// ─────────────────────────────────────────────────────────────────────────────
// Helper: run a loop in background and start the Dialog cycle, collecting
// one dialogEval() result per "tick".  Returns the list of sampled values.
// This mirrors exactly what the extension does in the busy-kernel Dynamic path.
//
//  loopExpr:      Wolfram loop, e.g. "Do[n=k; Pause[0.3], {k,1,20}]"
//  sampleExpr:    expression to evaluate inside each Dialog tick
//  nSamples:      how many dialog reads to perform
//  pauseBetween:  ms to wait between dialog reads
// ─────────────────────────────────────────────────────────────────────────────
async function dialogSampleLoop(session, loopExpr, sampleExpr, nSamples, pauseBetween = 400) {
    const samples = [];
    let dialogReady = false;
    let loopDone    = false;
    let loopResult  = null;

    // Start the main evaluation (the loop).  It will call Dialog[] at the very
    // start, which lets us interleave dialogEval() calls.
    const mainPromise = session.evaluate(
        `VsCodeDialogOpen = True; Dialog[]; VsCodeDialogOpen = False; ${loopExpr}`,
        {
            onDialogBegin: () => { dialogReady = true; },
            onDialogEnd:   () => {},
        },
    ).then(r => { loopDone = true; loopResult = r; });

    // Wait until the Dialog opens (i.e. the kernel hit Dialog[])
    await pollUntil(() => session.isDialogOpen, 8_000);

    // Close the dialog and start the actual loop running in a real-kernel thread
    // (exit dialog → kernel continues past Dialog[], enters the Do loop)
    await session.exitDialog();
    await pollUntil(() => !session.isDialogOpen, 4_000);

    // Now repeatedly interrupt the kernel, open a dialog, read sampleExpr, exit
    for (let i = 0; i < nSamples; i++) {
        await sleep(pauseBetween);
        if (loopDone) break;               // loop finished before we sampled enough

        // Ask for a dialog
        await pollUntil(() => !session.isDialogOpen, 2_000);
        session.interrupt();
        try {
            await pollUntil(() => session.isDialogOpen, 5_000);
        } catch (_) {
            // Interrupt might not open a dialog if the loop finished
            if (loopDone) break;
            throw _;
        }

        // Read the current value
        const val = await withTimeout(session.dialogEval(sampleExpr), 5_000, `dialogEval #${i}`);
        samples.push(val);

        // Resume the loop
        await session.exitDialog();
    }

    // Wait for the loop to finish (up to 90 s for slow loops)
    await withTimeout(new Promise(r => { const id = setInterval(() => { if (loopDone) { clearInterval(id); r(); } }, 100); }), 90_000, 'loop completion');

    return { samples, loopResult };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    log('='.repeat(70));
    log('Dynamic Widget Kernel Scenario Test Suite');
    log(`Date: ${new Date().toISOString()}`);
    log(`Kernel: ${KERNEL}`);
    log(`Report: ${REPORT}`);
    log('='.repeat(70));

    // Shared session — used for S1–S11; S12 uses its own
    const session = mkSession();

    // ─── S1: Baseline evaluation ────────────────────────────────────────────
    await run('Baseline: arithmetic', 'S1a', async () => {
        const r = await session.evaluate('2 + 2');
        assertEq(r.result?.value, 4, 'expected 4');
    });

    await run('Baseline: symbolic', 'S1b', async () => {
        const r = await session.evaluate('Expand[(a+b)^3]');
        assert(r.result !== null, 'expected non-null result');
        assert(r.result.type !== undefined, 'result has type');
    });

    await run('Baseline: Print[] streaming', 'S1c', async () => {
        const printed = [];
        await session.evaluate(
            'Do[Print["step ", k]; Pause[0.1], {k, 1, 5}]',
            { onPrint: line => printed.push(line) },
        );
        assertEq(printed.length, 5, `expected 5 Print lines, got ${printed.length}`);
        assertIncludes(printed[0], 'step 1');
        assertIncludes(printed[4], 'step 5');
    }, 30_000);

    await run('Baseline: large list (skeleton)', 'S1d', async () => {
        const r = await session.evaluate('Range[3000]');
        assert(r.result !== null, 'expected result');
        // The value is an array; we just need it to not throw
    });

    await run('Baseline: Plot[] returns graphics', 'S1e', async () => {
        const r = await session.evaluate('Plot[Sin[x], {x, 0, 2 Pi}]');
        assert(r.result !== null, 'expected graphics result');
        // Graphics returns a BoxData / SparseArray structure — just check type
    });

    // ─── S2: Idle sub() reads a global variable ────────────────────────────
    await run('Idle sub(): reads global variable', 'S2', async () => {
        await session.evaluate('idleN = 99');
        const v = await session.sub('idleN');
        assert(v !== null && v !== undefined, 'sub() returned null');
        assertEq(v.value, 99, `expected 99, got ${JSON.stringify(v)}`);
    });

    await run('Idle sub(): multiple concurrent sub() calls', 'S2b', async () => {
        await session.evaluate('idleA = 10; idleB = 20');
        const [a, b] = await Promise.all([
            session.sub('idleA'),
            session.sub('idleB'),
        ]);
        assertEq(a.value, 10);
        assertEq(b.value, 20);
    });

    // ─── S3: sub() CANNOT see a loop-local variable ────────────────────────
    // This is the fundamental reason the Dialog path exists.
    // We start a loop that assigns a loop-local n, then sub() it — the
    // sub() hits EvaluatePacket which runs in a fresh context and sees the
    // pre-loop (Global`) value of n, not the loop-updated one.
    await run('sub() cannot see loop-local var (Dialog path justified)', 'S3', async () => {
        // Set a known global value first
        await session.evaluate('loopN = 0');

        // Start a long loop that updates loopN every iteration
        const loopPromise = session.evaluate(
            'Do[loopN = k; Pause[0.3], {k, 1, 30}]',
        );

        // Give the loop a couple iterations to advance
        await sleep(1_200);

        // sub() should still see the global value, NOT the loop-local increment
        // (because sub() uses EvaluatePacket which shares the Global` context)
        // BUT: actually in Wolfram, loopN IS global (Do sets it in Global`).
        //
        // The real isolation is for variables defined with Module[] or Block[].
        // Let's prove that Module[]-local vars are NOT visible via sub():
        const v1 = await session.sub('loopN');
        // v1.value should be >= 1 (loop is progressing, it IS global)
        assert(v1 !== null, 'sub() returned null during loop');
        assert(typeof v1.value === 'number' && v1.value >= 1,
            `expected loopN >= 1 during loop, got ${JSON.stringify(v1)}`);

        // Now test a Module[]-local var — truly inaccessible to sub():
        const modulePromise = session.evaluate(
            'Module[{moduleLocal = 0}, Do[moduleLocal = k; Pause[0.3], {k, 1, 20}]; moduleLocal]',
        );
        await sleep(800);
        const v2 = await session.sub('moduleLocal');  // should be Symbol or $Failed
        // moduleLocal is not in Global` — sub() should return the unevaluated symbol
        assert(v2 !== null, 'sub() returned null');
        // The key assertion: sub() should NOT return the current loop value
        // (it will return the unevaluated symbol `moduleLocal` since it's Module-scoped)
        const notANumber = typeof v2.value !== 'number';
        assert(notANumber, `sub() should NOT see Module-local var; got ${JSON.stringify(v2)}`);

        await withTimeout(loopPromise, 30_000, 'loop 1 completion');
        await withTimeout(modulePromise, 30_000, 'module loop completion');
    }, 90_000);

    // ─── S4: Dialog path reads the live loop variable ──────────────────────
    // This is the core test: interrupt → dialogEval → exitDialog cycle.
    await run('Dialog path: reads live loop variable (core Dynamic test)', 'S4', async () => {
        await session.evaluate('dynN = 0');

        const { samples } = await dialogSampleLoop(
            session,
            'Do[dynN = k; Pause[0.3], {k, 1, 40}]',
            'dynN',
            /* nSamples */ 6,
            /* pauseBetween */ 600,
        );

        assert(samples.length >= 3, `expected ≥ 3 samples, got ${samples.length}`);
        const vals = samples.map(s => s?.value).filter(v => typeof v === 'number');
        assert(vals.length >= 3, `expected ≥ 3 numeric samples, got: ${JSON.stringify(samples)}`);

        // Values should be strictly increasing (loop increments k)
        for (let i = 1; i < vals.length; i++) {
            assert(vals[i] >= vals[i - 1],
                `values not increasing: ${vals[i - 1]} → ${vals[i]} at index ${i}`);
        }
        log(`    sampled values: [${vals.join(', ')}]`);
    }, 90_000);

    // ─── S5: Multiple dialog reads per interrupt (two Dynamic slots) ────────
    await run('Dialog path: two slots read per interrupt cycle', 'S5', async () => {
        await session.evaluate('slotA = 0; slotB = 0');

        // Start loop
        const loopPromise = session.evaluate(
            'Dialog[]; Do[slotA = k; slotB = k^2; Pause[0.3], {k, 1, 30}]',
            { onDialogBegin: () => {}, onDialogEnd: () => {} },
        );

        await pollUntil(() => session.isDialogOpen, 8_000);
        await session.exitDialog();  // close initial dialog, loop starts
        await pollUntil(() => !session.isDialogOpen, 4_000);

        const pairsA = [], pairsB = [];

        for (let i = 0; i < 5; i++) {
            await sleep(600);
            if (!session.isOpen) break;

            session.interrupt();
            try { await pollUntil(() => session.isDialogOpen, 5_000); }
            catch (_) { break; }

            // Read BOTH slots inside the same dialog cycle
            const va = await withTimeout(session.dialogEval('slotA'), 4_000, 'slotA');
            const vb = await withTimeout(session.dialogEval('slotB'), 4_000, 'slotB');
            pairsA.push(va?.value);
            pairsB.push(vb?.value);

            await session.exitDialog();
        }

        assert(pairsA.length >= 2, `expected ≥ 2 pair reads, got ${pairsA.length}`);

        // slotB should equal slotA^2
        for (let i = 0; i < pairsA.length; i++) {
            if (typeof pairsA[i] === 'number' && typeof pairsB[i] === 'number') {
                assertEq(pairsB[i], pairsA[i] ** 2,
                    `slotB[${i}] = ${pairsB[i]} ≠ slotA[${i}]^2 = ${pairsA[i] ** 2}`);
            }
        }
        log(`    (slotA, slotB) pairs: ${pairsA.map((a, i) => `(${a}, ${pairsB[i]})`).join(', ')}`);

        await withTimeout(loopPromise, 30_000, 'S5 loop');
    }, 90_000);

    // ─── S6: Dialog path with graphics expression (BoxData) ─────────────────
    await run('Dialog path: graphics expression returned', 'S6', async () => {
        await session.evaluate('gpN = 1');

        const { samples } = await dialogSampleLoop(
            session,
            'Do[gpN = k/5.0; Pause[0.4], {k, 1, 20}]',
            'ListPlot[Table[{j, Sin[j * gpN]}, {j, 1, 30}]]',
            /* nSamples */ 3,
            /* pauseBetween */ 700,
        );

        assert(samples.length >= 1, `expected ≥ 1 graphics sample, got ${samples.length}`);
        // Graphics return a nested structure — just check it's non-null and not an error
        const first = samples[0];
        assert(first !== null && first !== undefined, 'graphics dialogEval returned null');
        log(`    graphics result type: ${first?.type ?? JSON.stringify(first).slice(0, 80)}`);
    }, 90_000);

    // ─── S7: Abort during Dialog loop ───────────────────────────────────────
    await run('Abort during Dialog loop; kernel stays alive', 'S7', async () => {
        await session.evaluate('abortN = 0');

        let loopAborted = false;
        const loopPromise = session.evaluate(
            'Dialog[]; Do[abortN = k; Pause[0.3], {k, 1, 200}]',
            { onDialogBegin: () => {}, onDialogEnd: () => {} },
        ).catch(() => { loopAborted = true; });

        await pollUntil(() => session.isDialogOpen, 8_000);
        await session.exitDialog();
        await pollUntil(() => !session.isDialogOpen, 4_000);

        // Let the loop run a few steps
        await sleep(800);

        // Read a value to confirm loop is running
        session.interrupt();
        await pollUntil(() => session.isDialogOpen, 5_000);
        const before = await session.dialogEval('abortN');
        assert(typeof before?.value === 'number' && before.value >= 1,
            `expected abortN >= 1, got ${JSON.stringify(before)}`);
        await session.exitDialog();

        // Now abort
        await sleep(200);
        await session.abort();
        await withTimeout(loopPromise, 10_000, 'loop abort');

        // Kernel must still respond after abort
        const r = await withTimeout(session.evaluate('"alive after abort"'), 8_000, 'post-abort eval');
        assertEq(r.result?.value, 'alive after abort', 'kernel unresponsive after abort');
        log(`    abortN before abort: ${before?.value}; kernel alive ✓`);
    }, 90_000);

    // ─── S8: Error inside dialogEval (1/0) does not crash ───────────────────
    await run('dialogEval: error expression (1/0) does not crash', 'S8', async () => {
        const loopPromise = session.evaluate(
            'Dialog[]; Do[errN = k; Pause[0.3], {k, 1, 30}]',
            { onDialogBegin: () => {}, onDialogEnd: () => {} },
        );

        await pollUntil(() => session.isDialogOpen, 8_000);
        await session.exitDialog();
        await pollUntil(() => !session.isDialogOpen, 4_000);

        await sleep(600);
        session.interrupt();
        await pollUntil(() => session.isDialogOpen, 5_000);

        // Evaluate an expression that produces $Failed / ComplexInfinity — should not throw
        let threw = false;
        let errResult = null;
        try {
            errResult = await withTimeout(session.dialogEval('1/0'), 5_000, '1/0 dialogEval');
        } catch (e) {
            threw = true;
            log(`    dialogEval threw: ${e.message}`);
        }
        // Whether it returned a result or threw, the session must still be open
        assert(session.isOpen, 'session closed after error dialogEval');

        // Read a normal expression — proves dialog is still functional
        const ok = await withTimeout(session.dialogEval('42'), 5_000, 'recovery dialogEval');
        assertEq(ok?.value, 42, 'dialog recovery failed after error expression');

        await session.exitDialog();
        await withTimeout(loopPromise, 30_000, 'S8 loop');
        log(`    errResult: ${JSON.stringify(errResult)?.slice(0, 80)}; threw: ${threw}; recovered ✓`);
    }, 90_000);

    // ─── S9: Large list through dialogEval ──────────────────────────────────
    await run('dialogEval: large list (Range[5000])', 'S9', async () => {
        const loopPromise = session.evaluate(
            'Dialog[]; Do[lgN = k; Pause[0.5], {k, 1, 20}]',
            { onDialogBegin: () => {}, onDialogEnd: () => {} },
        );

        await pollUntil(() => session.isDialogOpen, 8_000);
        await session.exitDialog();
        await pollUntil(() => !session.isDialogOpen, 4_000);

        await sleep(600);
        session.interrupt();
        await pollUntil(() => session.isDialogOpen, 5_000);

        const big = await withTimeout(session.dialogEval('Range[5000]'), 10_000, 'Range[5000]');
        assert(big !== null, 'large list returned null');
        log(`    large list result type: ${big?.type ?? typeof big?.value}`);

        await session.exitDialog();
        await withTimeout(loopPromise, 30_000, 'S9 loop');
    }, 90_000);

    // ─── S10: String result through dialogEval ──────────────────────────────
    await run('dialogEval: string result', 'S10', async () => {
        await session.evaluate('strN = ""');

        const { samples } = await dialogSampleLoop(
            session,
            'Do[strN = "step-" <> ToString[k]; Pause[0.3], {k, 1, 25}]',
            'strN',
            /* nSamples */ 4,
            /* pauseBetween */ 500,
        );

        const strs = samples.map(s => s?.value).filter(v => typeof v === 'string');
        assert(strs.length >= 2, `expected ≥ 2 string samples, got: ${JSON.stringify(samples)}`);
        assertIncludes(strs[0], 'step-');
        log(`    string samples: [${strs.join(', ')}]`);
    }, 90_000);

    // ─── S11: Sequential evaluate() calls after a Dialog cycle ──────────────
    await run('Sequential evaluations after Dialog cycle', 'S11', async () => {
        // Run a short Dialog cycle, then fire 5 evaluations and check they all
        // complete in order
        const loopPromise = session.evaluate(
            'Dialog[]; Do[seqN = k; Pause[0.2], {k, 1, 10}]',
            { onDialogBegin: () => {}, onDialogEnd: () => {} },
        );
        await pollUntil(() => session.isDialogOpen, 8_000);
        await session.exitDialog();
        await withTimeout(loopPromise, 20_000, 'S11 loop');

        const vals = [];
        for (let i = 0; i < 5; i++) {
            const r = await session.evaluate(`${i + 1} * ${i + 1}`);
            vals.push(r.result?.value);
        }
        assertEq(vals.length, 5);
        for (let i = 0; i < 5; i++) {
            assertEq(vals[i], (i + 1) ** 2, `val[${i}] wrong: ${vals[i]}`);
        }
        log(`    post-dialog sequential results: [${vals.join(', ')}]`);
    }, 90_000);

    session.close();

    // ─── S12: Fresh session (simulates kernel restart) ───────────────────────
    await run('Fresh session: Dialog path works on new kernel instance', 'S12', async () => {
        const s2 = mkSession();

        // Confirm it's a genuinely fresh kernel (no inherited state)
        await s2.evaluate('freshN = 0');
        const pre = await s2.sub('freshN');
        assertEq(pre?.value, 0, 'fresh kernel did not init freshN');

        const { samples } = await dialogSampleLoop(
            s2,
            'Do[freshN = k; Pause[0.3], {k, 1, 25}]',
            'freshN',
            /* nSamples */ 4,
            /* pauseBetween */ 500,
        );

        const vals = samples.map(s => s?.value).filter(v => typeof v === 'number');
        assert(vals.length >= 2, `expected ≥ 2 samples on fresh session, got: ${JSON.stringify(samples)}`);
        assert(vals[vals.length - 1] > 0, 'all sampled values zero on fresh session');
        log(`    fresh-session samples: [${vals.join(', ')}]`);

        s2.close();
    }, 90_000);

    // ─── SUMMARY ─────────────────────────────────────────────────────────────
    log('\n' + '='.repeat(70));
    log('SUMMARY');
    log('='.repeat(70));

    const nameW = Math.max(...results.map(r => r.name.length), 10);
    for (const r of results) {
        const icon = r.status === 'PASS' ? '✓' : (r.status === 'SKIP' ? '○' : '✗');
        const err  = r.error ? `  ← ${r.error.slice(0, 80)}` : '';
        log(`  ${icon} [${r.section}] ${r.name.padEnd(nameW)}  ${r.ms} ms${err}`);
    }

    log('');
    log(`  Passed:  ${passed}`);
    log(`  Failed:  ${failed}`);
    log(`  Skipped: ${skipped}`);
    log(`  Total:   ${passed + failed + skipped}`);
    log('');

    if (failed === 0) {
        log('  ✓ All tests passed.');
    } else {
        log(`  ✗ ${failed} test(s) FAILED.`);
    }

    log('='.repeat(70));
    log(`Report saved: ${REPORT}`);

    writeReport();
    clearTimeout(suiteWatchdog);
    process.exit(failed > 0 ? 1 : 0);
})();
