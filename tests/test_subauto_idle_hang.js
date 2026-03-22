/**
 * test_subauto_idle_hang.js
 *
 * Isolated reproduction of the post-eval idle-path subAuto hang.
 *
 * BUG: After a busy eval (Do[Pause[...], ...]) with multiple registered Dynamic
 * entries and many busy-path subAuto calls, the FIRST idle-path subAuto call
 * after the eval completes hangs the WSTP link permanently.
 *
 * The hang occurs because:
 *   1. During the busy eval, ScheduledTask fires Dialog[] cycles (~300ms apart),
 *      each evaluating all registered Dynamic entries + any queued subAuto exprs.
 *   2. When the eval completes, the ScheduledTask fires ONE MORE TIME, producing
 *      a stale BEGINDLGPKT on the link.
 *   3. C++ drains the stale BEGINDLGPKT (sends Return[$Failed], reads ENDDLGPKT).
 *   4. The drain succeeds, but the C++ session state is now corrupted.
 *   5. The next idle-path eval hangs permanently (WSGetNext blocks forever).
 *
 * Run:
 *   node test_subauto_idle_hang.js             # full output
 *   node test_subauto_idle_hang.js 2>/dev/null # suppress C++ diagnostics
 *
 * Expected result with bug present: TIMEOUT on "idle-path subAuto" (test FAIL).
 * Expected result when fixed: all tests PASS.
 */

'use strict';

const wstp = require('../build/Release/wstp.node');
const { WstpSession, setDiagHandler } = wstp;
const fs   = require('fs');
const path = require('path');

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

// ── diagnostics ──────────────────────────────────────────────────────────────
setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[C++ ${ts}] ${msg}\n`);
});

// ── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

// Suite watchdog — force-kills if anything hangs beyond 2 minutes.
const watchdog = setTimeout(() => {
    console.log('\nFATAL: suite watchdog expired — force-exiting.');
    process.exit(2);
}, 120_000);
watchdog.unref();

let passed = 0, failed = 0;

async function run(name, fn, timeoutMs = 45_000) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`TEST: ${name}`);
    const t0 = Date.now();
    try {
        await withTimeout(fn(), timeoutMs, name);
        const ms = Date.now() - t0;
        console.log(`  [PASS]  (${ms} ms)`);
        passed++;
    } catch (err) {
        const ms = Date.now() - t0;
        console.log(`  [FAIL]  (${ms} ms)`);
        console.log(`  ERROR: ${err.message}`);
        failed++;
        // If the kernel is hosed, we might want to exit early rather than hanging on every subsequent test
        if (err.message.includes('TIMEOUT')) {
            console.log('Detected TIMEOUT - kernel likely hosed. Exiting suite to free terminal.');
            process.exit(1);
        }
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function mkSession() { return new WstpSession(KERNEL); }

// ─────────────────────────────────────────────────────────────────────────────
// TEST A: Exact reproduction of the extension flow
//
// 3 registered Dynamic entries (2 widget slots + 1 watch panel)
// + JS subAuto calls during busy eval (~750ms apart)
// + post-eval idle subAuto
//
// This is the EXACT pattern that hangs in the extension:
//   Cell 1: n = 0; Dynamic[n]
//   Cell 2: Dynamic[n, LiveCells -> 0]; Do[n = k; Pause[1]; Print[n], {k,1,6}]
//   → Dynamic loop polls all slots via subAuto every ~750ms
//   → After cell 2 finishes, next idle subAuto hangs forever
// ─────────────────────────────────────────────────────────────────────────────
async function testA() {
    const s = mkSession();
    try {
        // Warm up kernel
        await withTimeout(s.evaluate('1+1'), 30000, 'warmup');

        // Register 3 Dynamic entries — mirrors the real extension
        s.registerDynamic('slot1', 'ToString[n]');      // cell 1 Dynamic[n]
        s.registerDynamic('slot2', 'ToString[n]');      // cell 2 Dynamic[n,LiveCells->0]
        s.registerDynamic('__watch__', 'ToString[{n}]');  // watch panel
        s.setDynamicInterval(300);

        // Start busy eval (interactive for Dialog[] support)
        const evalPromise = s.evaluate(
            'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
            { interactive: true }
        );

        // Wait for eval to start and ScheduledTask to begin firing
        await sleep(1000);
        assert(!s.isReady, 'kernel should be busy');

        // subAuto calls during busy eval (mirrors extension Dynamic loop)
        let busyCalls = 0;
        for (let i = 0; i < 8; i++) {
            if (s.isReady) break;
            try {
                await withTimeout(
                    s.subAuto('ToString[n]'),
                    5000, `busy subAuto #${i + 1}`
                );
                busyCalls++;
            } catch (_) {}
            await sleep(750);
        }
        console.log(`  busy-path subAuto calls completed: ${busyCalls}`);

        // Wait for main eval to complete
        const mainResult = await withTimeout(evalPromise, 30000, 'main eval');
        assert(mainResult.result.value === 'done',
            `main eval expected "done", got "${mainResult.result.value}"`);
        console.log('  main eval completed OK');

        // THE CRITICAL CALL: post-eval idle-path subAuto
        // This hangs permanently in the buggy version.
        const t0 = Date.now();
        const idleResult = await withTimeout(
            s.subAuto('ToString[1 + 1]'),
            10000, 'post-eval idle-path subAuto'
        );
        console.log(`  idle subAuto returned: ${idleResult?.value} (${Date.now() - t0}ms)`);
        assert(idleResult.value === '2', `expected "2", got "${idleResult?.value}"`);

        // Verify kernel still functional
        const nextCell = await withTimeout(
            s.evaluate('2 + 2'),
            10000, 'follow-up evaluate'
        );
        assert(nextCell.result.value === 4, `follow-up expected 4, got ${nextCell.result.value}`);

        s.unregisterDynamic('slot1');
        s.unregisterDynamic('slot2');
        s.unregisterDynamic('__watch__');
        s.setDynAutoMode(false);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST B: Minimal reproduction — 3 registered entries, NO JS subAuto calls
//
// Tests whether the C++-internal Dialog cycle processing alone (without any
// JS-initiated subAuto) can trigger the hang.
// ─────────────────────────────────────────────────────────────────────────────
async function testB() {
    const s = mkSession();
    try {
        await withTimeout(s.evaluate('1+1'), 30000, 'warmup');

        s.registerDynamic('slot1', 'ToString[n]');
        s.registerDynamic('slot2', 'ToString[n]');
        s.registerDynamic('__watch__', 'ToString[{n}]');
        s.setDynamicInterval(300);

        const evalPromise = s.evaluate(
            'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
            { interactive: true }
        );

        // Just wait — no JS subAuto calls.  Only C++ automatic Dialog processing.
        const mainResult = await withTimeout(evalPromise, 30000, 'main eval');
        assert(mainResult.result.value === 'done',
            `main eval expected "done", got "${mainResult.result.value}"`);
        console.log('  main eval completed OK (no JS subAuto during busy)');

        // Post-eval idle subAuto
        const t0 = Date.now();
        const idleResult = await withTimeout(
            s.subAuto('ToString[1 + 1]'),
            10000, 'post-eval idle-path subAuto'
        );
        console.log(`  idle subAuto returned: ${idleResult?.value} (${Date.now() - t0}ms)`);
        assert(idleResult.value === '2', `expected "2", got "${idleResult?.value}"`);

        // Verify
        const nextCell = await withTimeout(s.evaluate('2 + 2'), 10000, 'follow-up');
        assert(nextCell.result.value === 4, `follow-up expected 4, got ${nextCell.result.value}`);

        s.unregisterDynamic('slot1');
        s.unregisterDynamic('slot2');
        s.unregisterDynamic('__watch__');
        s.setDynAutoMode(false);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST C: Single registered entry + many JS subAuto calls
//
// Tests whether the bug requires multiple registered entries or if many
// JS-initiated busy-path subAuto calls alone are sufficient.
// ─────────────────────────────────────────────────────────────────────────────
async function testC() {
    const s = mkSession();
    try {
        await withTimeout(s.evaluate('1+1'), 30000, 'warmup');

        // Only 1 registered entry (like test 64)
        s.registerDynamic('slot1', 'ToString[n]');
        s.setDynamicInterval(300);

        const evalPromise = s.evaluate(
            'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
            { interactive: true }
        );

        await sleep(1000);

        // Many JS subAuto calls
        let busyCalls = 0;
        for (let i = 0; i < 8; i++) {
            if (s.isReady) break;
            try {
                await withTimeout(
                    s.subAuto('ToString[n]'),
                    5000, `busy subAuto #${i + 1}`
                );
                busyCalls++;
            } catch (_) {}
            await sleep(750);
        }
        console.log(`  busy-path subAuto calls: ${busyCalls}`);

        const mainResult = await withTimeout(evalPromise, 30000, 'main eval');
        assert(mainResult.result.value === 'done',
            `main eval expected "done", got "${mainResult.result.value}"`);
        console.log('  main eval completed OK');

        const t0 = Date.now();
        const idleResult = await withTimeout(
            s.subAuto('ToString[1 + 1]'),
            10000, 'post-eval idle-path subAuto'
        );
        console.log(`  idle subAuto returned: ${idleResult?.value} (${Date.now() - t0}ms)`);
        assert(idleResult.value === '2', `expected "2", got "${idleResult?.value}"`);

        const nextCell = await withTimeout(s.evaluate('2 + 2'), 10000, 'follow-up');
        assert(nextCell.result.value === 4, `follow-up expected 4, got ${nextCell.result.value}`);

        s.unregisterDynamic('slot1');
        s.setDynAutoMode(false);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST D: Immediate idle subAuto after eval — no sleep
//
// Same as A but calls subAuto IMMEDIATELY after eval completes (no cooldown).
// The extension calls this within the same event-loop tick after _evalDispatched
// goes false (Dynamic loop timer fires immediately).
// ─────────────────────────────────────────────────────────────────────────────
async function testD() {
    const s = mkSession();
    try {
        await withTimeout(s.evaluate('1+1'), 30000, 'warmup');

        s.registerDynamic('slot1', 'ToString[n]');
        s.registerDynamic('slot2', 'ToString[n]');
        s.registerDynamic('__watch__', 'ToString[{n}]');
        s.setDynamicInterval(300);

        let evalDone = false;

        const evalPromise = s.evaluate(
            'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
            { interactive: true }
        ).then(r => { evalDone = true; return r; });

        await sleep(1000);

        // Busy subAuto calls
        for (let i = 0; i < 8 && !evalDone; i++) {
            try {
                await withTimeout(s.subAuto('ToString[n]'), 5000, `busy #${i + 1}`);
            } catch (_) {}
            await sleep(750);
        }

        const mainResult = await withTimeout(evalPromise, 30000, 'main eval');
        console.log('  main eval completed');

        // Immediately call subAuto (no sleep/cooldown)
        const t0 = Date.now();
        const idleResult = await withTimeout(
            s.subAuto('ToString[1 + 1]'),
            10000, 'immediate post-eval subAuto'
        );
        console.log(`  idle subAuto returned: ${idleResult?.value} (${Date.now() - t0}ms)`);
        assert(idleResult.value === '2', `expected "2", got "${idleResult?.value}"`);

        s.unregisterDynamic('slot1');
        s.unregisterDynamic('slot2');
        s.unregisterDynamic('__watch__');
        s.setDynAutoMode(false);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST E: subWhenIdle after busy eval with Dialog cycles
//
// Same scenario but uses subWhenIdle() directly (instead of subAuto) for the
// post-eval call. Tests whether the bug is in subAuto routing or in the
// underlying idle-path evaluation.
// ─────────────────────────────────────────────────────────────────────────────
async function testE() {
    const s = mkSession();
    try {
        await withTimeout(s.evaluate('1+1'), 30000, 'warmup');

        s.registerDynamic('slot1', 'ToString[n]');
        s.registerDynamic('slot2', 'ToString[n]');
        s.registerDynamic('__watch__', 'ToString[{n}]');
        s.setDynamicInterval(300);

        let evalDone = false;
        const evalPromise = s.evaluate(
            'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
            { interactive: true }
        ).then(r => { evalDone = true; return r; });

        await sleep(1000);
        for (let i = 0; i < 8 && !evalDone; i++) {
            try {
                await withTimeout(s.subAuto('ToString[n]'), 5000, `busy #${i + 1}`);
            } catch (_) {}
            await sleep(750);
        }

        await withTimeout(evalPromise, 30000, 'main eval');
        console.log('  main eval completed');

        // Use subWhenIdle() directly
        const t0 = Date.now();
        const idleResult = await withTimeout(
            s.subWhenIdle('ToString[1 + 1]'),
            10000, 'post-eval subWhenIdle'
        );
        console.log(`  subWhenIdle returned: ${idleResult?.value} (${Date.now() - t0}ms)`);
        assert(idleResult.value === '2', `expected "2", got "${idleResult?.value}"`);

        s.unregisterDynamic('slot1');
        s.unregisterDynamic('slot2');
        s.unregisterDynamic('__watch__');
        s.setDynAutoMode(false);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST F: evaluate() after busy eval with Dialog cycles
//
// Same but uses evaluate() instead of subAuto/subWhenIdle for the post-eval call.
// If this hangs too, the bug is in the core idle evaluation path.
// ─────────────────────────────────────────────────────────────────────────────
async function testF() {
    const s = mkSession();
    try {
        await withTimeout(s.evaluate('1+1'), 30000, 'warmup');

        s.registerDynamic('slot1', 'ToString[n]');
        s.registerDynamic('slot2', 'ToString[n]');
        s.registerDynamic('__watch__', 'ToString[{n}]');
        s.setDynamicInterval(300);

        let evalDone = false;
        const evalPromise = s.evaluate(
            'Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"',
            { interactive: true }
        ).then(r => { evalDone = true; return r; });

        await sleep(1000);
        for (let i = 0; i < 8 && !evalDone; i++) {
            try {
                await withTimeout(s.subAuto('ToString[n]'), 5000, `busy #${i + 1}`);
            } catch (_) {}
            await sleep(750);
        }

        await withTimeout(evalPromise, 30000, 'main eval');
        console.log('  main eval completed');

        // Use regular evaluate()
        const t0 = Date.now();
        const nextResult = await withTimeout(
            s.evaluate('1 + 1'),
            10000, 'post-eval evaluate()'
        );
        console.log(`  evaluate returned: ${nextResult.result.value} (${Date.now() - t0}ms)`);
        assert(nextResult.result.value === 2, `expected 2, got ${nextResult.result.value}`);

        s.unregisterDynamic('slot1');
        s.unregisterDynamic('slot2');
        s.unregisterDynamic('__watch__');
        s.setDynAutoMode(false);
    } finally {
        s.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    console.log('wstp.node version:', wstp.version);
    console.log('');

    await run('A. Full extension flow (3 dyn entries + many busy subAuto + idle subAuto)',
        testA, 90000);

    await run('B. 3 dyn entries, NO JS subAuto during busy, idle subAuto after',
        testB, 90000);

    await run('C. 1 dyn entry + many JS subAuto during busy, idle subAuto after',
        testC, 90000);

    await run('D. Full flow + IMMEDIATE idle subAuto (no cooldown)',
        testD, 90000);

    await run('E. Full flow + subWhenIdle instead of subAuto',
        testE, 90000);

    await run('F. Full flow + evaluate() instead of subAuto',
        testF, 90000);

    console.log(`\n${'─'.repeat(70)}`);
    if (failed === 0) {
        console.log(`\nAll ${passed} tests passed.`);
    } else {
        console.log(`\n${passed} passed, ${failed} FAILED.`);
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
