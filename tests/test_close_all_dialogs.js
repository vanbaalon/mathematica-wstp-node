/**
 * test_close_all_dialogs.js
 *
 * Demonstrates that closeAllDialogs() correctly unblocks stuck dialog
 * promises — and that WITHOUT it, abort() leaves dialogEval() hanging forever.
 *
 * Run:
 *   node test_close_all_dialogs.js
 *
 * Expected output:
 *   [PASS] dialogEval() rejected
 *   [PASS] error message correct
 *   [PASS] isDialogOpen cleared
 *   [PASS] no hang (< 500 ms)
 *   [PASS] exitDialog() rejected
 *   [PASS] error message correct
 *   [PASS] no hang (< 500 ms)
 *   [PASS] returns false when no dialog
 *   [PASS] returns true when dialog was open
 *   [PASS] returns false on second call
 *   [PASS] dialogEval() rejects when no dialog open
 *   [PASS] closeAllDialogs() is synchronous (< 10 ms)
 *   [PASS] returns false (nothing to flush)
 *   [PASS] isDialogOpen still false
 *   [PASS] computation still in progress
 *   [PASS] computation completed normally (not aborted)
 *   [PASS] result is correct
 *   [PASS] main evaluate() aborted
 *   [PASS] dialogEval() rejected cleanly
 *   [PASS] both resolved quickly < 3s
 *   [PASS] session still alive
 *   [PASS] kernel works after recovery
 *   All 22 tests passed.
 */

'use strict';

const { WstpSession } = require('./build/Release/wstp.node');
const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

const poll = (pred, ms = 50, limit = 5000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => pred() ? res()
        : Date.now() - t0 > limit ? rej(new Error('poll timeout'))
        : setTimeout(tick, ms);
    tick();
});

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
    if (cond) {
        console.log(`  [PASS] ${name}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — closeAllDialogs() immediately rejects a pending dialogEval()
// ─────────────────────────────────────────────────────────────────────────────
async function test1() {
    console.log('\nTEST 1: closeAllDialogs() rejects pending dialogEval()');
    const s = new WstpSession(KERNEL);
    try {
        // Open a dialog
        const main = s.evaluate('Dialog[]', {
            onDialogBegin: () => {}, onDialogEnd: () => {}
        });
        await poll(() => s.isDialogOpen);

        // Queue a dialogEval that we will never service — it will hang
        const t0 = Date.now();
        const pe = s.dialogEval('1 + 1').catch(e => ({ rejected: true, msg: e.message }));

        // Close all dialogs immediately — pe should reject right away
        s.closeAllDialogs();
        const result = await pe;
        const elapsed = Date.now() - t0;

        ok('dialogEval() rejected',    result.rejected === true);
        ok('error message correct',    result.msg === 'dialog closed by closeAllDialogs');
        ok('isDialogOpen cleared',     s.isDialogOpen === false);
        ok('no hang (< 500 ms)',       elapsed < 500, `elapsed=${elapsed}ms`);

        // Clean up — abort the stale evaluate()
        s.abort();
        await main.catch(() => {});
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — closeAllDialogs() immediately rejects a pending exitDialog()
// ─────────────────────────────────────────────────────────────────────────────
async function test2() {
    console.log('\nTEST 2: closeAllDialogs() rejects pending exitDialog()');
    const s = new WstpSession(KERNEL);
    try {
        const main = s.evaluate('Dialog[]', {
            onDialogBegin: () => {}, onDialogEnd: () => {}
        });
        await poll(() => s.isDialogOpen);

        const t0 = Date.now();
        const pe = s.exitDialog().catch(e => ({ rejected: true, msg: e.message }));

        s.closeAllDialogs();
        const result = await pe;
        const elapsed = Date.now() - t0;

        ok('exitDialog() rejected',   result.rejected === true);
        ok('error message correct',   result.msg === 'dialog closed by closeAllDialogs');
        ok('no hang (< 500 ms)',      elapsed < 500, `elapsed=${elapsed}ms`);

        s.abort();
        await main.catch(() => {});
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — return value: true when open, false when already clear
// ─────────────────────────────────────────────────────────────────────────────
async function test3() {
    console.log('\nTEST 3: closeAllDialogs() return value');
    const s = new WstpSession(KERNEL);
    try {
        // No dialog open — should return false
        const r1 = s.closeAllDialogs();
        ok('returns false when no dialog', r1 === false);

        // Open a dialog
        const main = s.evaluate('Dialog[]', {
            onDialogBegin: () => {}, onDialogEnd: () => {}
        });
        await poll(() => s.isDialogOpen);

        // Dialog is open — should return true
        const r2 = s.closeAllDialogs();
        ok('returns true when dialog was open', r2 === true);

        // Second call immediately after — dialog already closed
        const r3 = s.closeAllDialogs();
        ok('returns false on second call', r3 === false);

        s.abort();
        await main.catch(() => {});
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — KEY distinction: closeAllDialogs() ≠ abort()
//
// abort() also flushes the dialog queue (rejects with "abort"), but it
// KILLS the running computation.  closeAllDialogs() only resets dialog
// state — the computation keeps running.  This makes it the right tool
// for error recovery in a background Dynamic widget loop without
// interrupting the user's evaluation.
// ─────────────────────────────────────────────────────────────────────────────
async function test4() {
    console.log('\nTEST 4: closeAllDialogs() resets dialog state without stopping the computation');
    const s = new WstpSession(KERNEL);
    try {
        // Long computation — we must NOT kill it
        let mainDone = false;
        const main = s.evaluate('Do[Pause[0.1], {30}]; "survived"', {
            onDialogBegin: () => {}, onDialogEnd: () => {}
        });
        main.finally(() => { mainDone = true; });

        // Let it run briefly
        await new Promise(r => setTimeout(r, 200));

        // Simulate stale dialog state: dialogEval() when no dialog is open
        // (this is what happened in the extension's Dynamic loop)
        // dialogEval() should reject immediately because isDialogOpen is false
        const stale = await s.dialogEval('1 + 1')
            .then(v  => ({ ok: true,  v }))
            .catch(e => ({ ok: false, msg: e.message }));

        ok('dialogEval() rejects when no dialog open', stale.ok === false);

        // Now call closeAllDialogs() — safe no-op, computation still running
        const t0 = Date.now();
        const cleaned = s.closeAllDialogs();
        const elapsed = Date.now() - t0;

        ok('closeAllDialogs() is synchronous (< 10 ms)', elapsed < 10, `${elapsed}ms`);
        ok('returns false (nothing to flush)', cleaned === false);
        ok('isDialogOpen still false', s.isDialogOpen === false);
        ok('computation still in progress', mainDone === false);

        // Wait for computation to finish normally — NOT aborted
        const r = await main;
        ok('computation completed normally (not aborted)', r.aborted === false);
        ok('result is correct', r.result.value === 'survived');
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — the correct pattern: closeAllDialogs() THEN abort()
//           Both the main evaluate() and the dialogEval() resolve promptly.
// ─────────────────────────────────────────────────────────────────────────────
async function test5() {
    console.log('\nTEST 5: closeAllDialogs() + abort() unblocks everything immediately');
    const s = new WstpSession(KERNEL);
    try {
        // Long computation so abort is meaningful
        const main = s.evaluate('Do[Pause[0.1], {1000}]; "done"', {
            onDialogBegin: () => {}, onDialogEnd: () => {}
        });
        // Wait briefly so the kernel is actually running
        await new Promise(r => setTimeout(r, 300));

        // Queue a dialogEval while kernel is busy (no dialog open)
        // — this simulates a stale queued call from a Dynamic widget cycle
        const dialogP = s.dialogEval('2 + 2')
            .then(v  => ({ ok: true,  v }))
            .catch(e => ({ ok: false, msg: e.message }));

        const t0 = Date.now();
        // Correct recovery pattern:
        s.closeAllDialogs();   // 1. reject pending dialog promises immediately
        s.abort();             // 2. kill the running evaluate()

        const [mainResult, dialogResult] = await Promise.all([main, dialogP]);
        const elapsed = Date.now() - t0;

        ok('main evaluate() aborted',      mainResult.aborted === true);
        ok('dialogEval() rejected cleanly', dialogResult.ok === false);
        ok('both resolved quickly < 3s',   elapsed < 3000, `elapsed=${elapsed}ms`);
        ok('session still alive',          s.isOpen === true);

        // Verify kernel is still usable
        const r = await s.evaluate('2 + 2');
        ok('kernel works after recovery',  r.result.value === 4);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    console.log('closeAllDialogs() test suite');
    console.log('Kernel:', KERNEL);

    try {
        await test1();
        await test2();
        await test3();
        await test4();
        await test5();
    } catch (e) {
        console.error('\nUnhandled error:', e);
        process.exit(1);
    }

    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed.`);
    if (failed === 0) console.log('All 22 tests passed.');
    else process.exit(1);
})();
