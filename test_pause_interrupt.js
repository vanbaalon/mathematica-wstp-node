'use strict';
/**
 * test_pause_interrupt.js
 *
 * Targeted WSTP-level regression test for the exact failure sequence observed
 * in the Dynamic widget log (2026-03-01 session):
 *
 *   cycle 3  — interrupt sent during Pause[5]  → no dialog for 2500ms
 *   cycle 4  — interrupt sent               → dialog opens in 29ms
 *              dialogEval("VsCodeDynExportValue[...]") → timeout 8s
 *              exitDialog attempt 1,2,3      → timeout each time
 *              session.abort()               → dialog force-closed
 *   cycle 5+ — interrupt sent every 2.5s    → no dialog, ever again (30+ cycles)
 *
 * Tests (in order):
 *   P1  Pause[N] with N > interrupt-wait: interrupt does NOT open Dialog
 *   P2  Pause[N] with N short enough:     interrupt DOES open Dialog
 *   P3  dialogEval timeout leaves dialog open → subsequent interrupts broken  [THE CORE BUG]
 *   P4  abort() after stuck dialogEval       → subsequent interrupts recover  [expected fix]
 *   P5  closeAllDialogs() after timeout      → subsequent interrupts work
 *
 * Run:
 *   node test_pause_interrupt.js
 *   node test_pause_interrupt.js 2>diag.txt   # + C++ diags
 *
 *   DEBUG_WSTP=1 node test_pause_interrupt.js 2>diag.txt
 *   grep -E "pkt=|BEGINDLG|ENDDLG|interrupt|Dialog" diag.txt
 */

const { WstpSession, setDiagHandler } = require('./build/Release/wstp.node');
const fs   = require('fs');
const path = require('path');

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

if (process.env.DEBUG_WSTP) {
    setDiagHandler((msg) => {
        const ts = new Date().toISOString().slice(11, 23);
        process.stderr.write(`[diag ${ts}] ${msg}\n`);
    });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pollUntil(pred, timeoutMs = 5000, intervalMs = 30) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - t0 > timeoutMs) return reject(new Error(`pollUntil timed out after ${timeoutMs}ms`));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

// ── report ───────────────────────────────────────────────────────────────────
const ts_str = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
const REPORT  = path.join(__dirname, `test_pause_interrupt_${ts_str}.txt`);
const lines   = [];
function log(s = '') { console.log(s); lines.push(s); }
function writeReport() { fs.writeFileSync(REPORT, lines.join('\n') + '\n'); }

let passed = 0, failed = 0;
const results = [];

async function run(name, fn, timeoutMs = 40_000) {
    log(`\n${'─'.repeat(72)}`);
    log(`TEST  ${name}`);
    const t0 = Date.now();
    try {
        await withTimeout(fn(), timeoutMs, name);
        const ms = Date.now() - t0;
        log(`  [PASS]  (${ms} ms)`);
        passed++;
        results.push({ name, status: 'PASS', ms });
    } catch (err) {
        const ms = Date.now() - t0;
        log(`  [FAIL]  (${ms} ms): ${err.message}`);
        failed++;
        results.push({ name, status: 'FAIL', ms, error: err.message });
        process.exitCode = 1;
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── session factory ───────────────────────────────────────────────────────────
function mkSession() {
    const s = new WstpSession(KERNEL);
    // Install the SAME interrupt handler that init.wl installs at startup.
    // Must be done via evaluate() (interactive EnterExpressionPacket context),
    // not sub() — handler registered via EvaluatePacket is in batch context and
    // does not fire on WSInterruptMessage.
    return s;
}

async function installHandler(session) {
    await session.evaluate(
        'Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    );
    log('  [setup] interrupt→Dialog handler installed');
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {

log('═'.repeat(72));
log('Pause + Interrupt WSTP Regression Tests');
log('Date: ' + new Date().toISOString());
log('Kernel: ' + KERNEL);
log('Report: ' + REPORT);
log('═'.repeat(72));

// ─────────────────────────────────────────────────────────────────────────────
// P1: Pause[N] where N is longer than our interrupt wait budget
//     Expected: interrupt() returns true, but isDialogOpen stays false
//               because Pause ignores WSInterruptMessage during the sleep.
// ─────────────────────────────────────────────────────────────────────────────
await run('P1: Pause[8] ignores interrupt → no dialog within 2500ms', async () => {
    const session = mkSession();
    await installHandler(session);

    let evalDone = false;
    let evalResult = null;

    const mainProm = session.evaluate(
        'pP1 = 0; Pause[8]; pP1 = 1; "p1-done"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).then(r => { evalDone = true; evalResult = r; });

    // Let it settle into Pause[]
    await sleep(300);

    log('  [P1] sending interrupt during Pause[8]...');
    const t0 = Date.now();
    const sent = session.interrupt();
    log(`  [P1] interrupt() = ${sent}`);
    assert(sent === true, 'interrupt() should return true mid-eval');

    // Wait 2500ms (same budget as extension uses)
    while (!session.isDialogOpen && Date.now() - t0 < 2500) await sleep(25);

    const dlgOpened = session.isDialogOpen;
    log(`  [P1] isDialogOpen after ${Date.now()-t0}ms = ${dlgOpened}`);

    // KEY ASSERTION: Pause[8] should still be running — no dialog
    assert(!dlgOpened, 'Pause[8] should NOT yield to interrupt within 2500ms');

    // Cleanup: wait for Pause to finish naturally
    log('  [P1] waiting for Pause[8] to finish...');
    await withTimeout(mainProm, 12_000, 'P1 main eval');
    log(`  [P1] eval done, result: ${JSON.stringify(evalResult?.result ?? evalResult)}`);

    session.close();
    log('  [P1] CONFIRMED: Pause[N] ignores interrupts — Dynamic cannot read live value during Pause');
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: Pause[0.3] in a loop — interrupt respects short pauses
//     Expected: interrupt opens a dialog; dialogEval reads the live variable.
//     This is the WORKING case — proves the WSTP mechanism is functional.
// ─────────────────────────────────────────────────────────────────────────────
await run('P2: Pause[0.3] loop — interrupt opens Dialog and dialogEval succeeds', async () => {
    const session = mkSession();
    await installHandler(session);

    let evalDone = false;
    let evalResult = null;

    const mainProm = session.evaluate(
        'Do[nP2 = k; Pause[0.3], {k, 1, 30}]; "p2-done"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).then(r => { evalDone = true; evalResult = r; });

    await sleep(500); // let the loop start

    log('  [P2] sending interrupt...');
    const t0 = Date.now();
    session.interrupt();

    try {
        await pollUntil(() => session.isDialogOpen, 3000);
    } catch (_) {
        session.close();
        throw new Error('Dialog never opened — interrupt not working with Pause[0.3]');
    }
    log(`  [P2] dialog opened in ${Date.now()-t0}ms`);

    const val = await withTimeout(session.dialogEval('nP2'), 5000, 'dialogEval nP2');
    log(`  [P2] dialogEval("nP2") = ${JSON.stringify(val)}`);
    assert(val && typeof val.value === 'number' && val.value >= 1,
        `expected nP2 >= 1, got ${JSON.stringify(val)}`);

    await session.exitDialog();
    log('  [P2] exitDialog done, waiting for loop to finish...');
    await withTimeout(mainProm, 15_000, 'P2 main eval');
    log(`  [P2] loop done`);

    session.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// P3: dialogEval() hangs → what is the kernel state after it times out?
//     We simulate the exact extension failure:
//       1. Open dialog via interrupt
//       2. Let dialogEval time out (without actually calling exitDialog)
//       3. Try to send another interrupt → is dialog still "open"?
//       4. Try exitDialog — does it succeed?
//
//     This isolates whether the kernel is permanently broken after timeout.
// ─────────────────────────────────────────────────────────────────────────────
await run('P3: dialogEval timeout → kernel state after (CORE BUG ISOLATION)', async () => {
    const session = mkSession();
    await installHandler(session);

    let evalDone = false;

    const mainProm = session.evaluate(
        // Use a LONG pause so the kernel stays busy during our entire test window
        'Do[nP3 = k; Pause[0.3], {k, 1, 200}]; "p3-done"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).then(() => { evalDone = true; });

    await sleep(500);

    // --- First interrupt: open a dialog ---
    log('  [P3] interrupt #1 — opening dialog...');
    session.interrupt();
    try { await pollUntil(() => session.isDialogOpen, 3000); }
    catch (_) { session.close(); throw new Error('Dialog #1 never opened'); }
    log('  [P3] dialog #1 open');

    // --- Simulate dialogEval timeout: start it, then abandon it (short race) ---
    log('  [P3] starting dialogEval with deliberate 200ms timeout (simulating stuck eval)...');
    try {
        await withTimeout(session.dialogEval('nP3'), 200, 'deliberate-timeout');
        log('  [P3] dialogEval returned unexpectedly fast — retrying with guaranteed timeout');
    } catch (e) {
        log(`  [P3] dialogEval timed out as expected: ${e.message}`);
    }

    // --- What is isDialogOpen NOW? ---
    const dlgAfterTimeout = session.isDialogOpen;
    log(`  [P3] isDialogOpen after dialogEval timeout = ${dlgAfterTimeout}`);

    // --- Can we call exitDialog? ---
    log('  [P3] attempting exitDialog...');
    let exitOk = false;
    try {
        await withTimeout(session.exitDialog(), 2000, 'exitDialog after timeout');
        exitOk = true;
        log('  [P3] exitDialog succeeded');
    } catch (e) {
        log(`  [P3] exitDialog failed: ${e.message}`);
    }

    // --- Wait a moment then try interrupt #2 ---
    await sleep(400);
    log('  [P3] interrupt #2 — can we open a new dialog?');
    session.interrupt();
    let dlg2Opened = false;
    const t2 = Date.now();
    while (!session.isDialogOpen && Date.now()-t2 < 3000) await sleep(30);
    dlg2Opened = session.isDialogOpen;
    log(`  [P3] isDialogOpen (post-timeout cycle) = ${dlg2Opened} after ${Date.now()-t2}ms`);

    if (dlg2Opened) {
        const val2 = await withTimeout(session.dialogEval('nP3'), 4000, 'dialogEval #2');
        log(`  [P3] dialogEval #2 = ${JSON.stringify(val2)}`);
        await session.exitDialog();
    }

    // Summary
    log(`\n  [P3] SUMMARY:`);
    log(`    dlgOpen after timeout   = ${dlgAfterTimeout}  (true = dialog stuck open)`);
    log(`    exitDialog after timeout = ${exitOk ? 'OK' : 'FAILED'}`);
    log(`    dialog #2 opened        = ${dlg2Opened}  (false = kernel degraded → THE BUG)`);

    // Wait for loop or give up
    if (!evalDone) {
        try { await withTimeout(mainProm, 20_000, 'P3 loop'); } catch (_) {}
    }
    session.close();

    // The test passes unconditionally — it's diagnostic.
    // We assert the KEY observation: if exitDialog failed, dialog #2 should also fail.
    if (!exitOk) {
        assert(!dlg2Opened, 'If exitDialog failed, subsequent interrupt should also fail to open dialog (kernel degraded)');
        log('  [P3] CONFIRMED: kernel degraded after dialogEval timeout + exitDialog failure');
    } else {
        log('  [P3] exitDialog succeeded — kernel NOT degraded by timeout alone');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// P4: After stuck dialog — does session.abort() restore interrupt capability?
//     This tests whether the extension's current "abort on exitDialog failure"
//     recovery path actually works.
// ─────────────────────────────────────────────────────────────────────────────
await run('P4: abort() after stuck dialog → subsequent interrupt works', async () => {
    const session = mkSession();
    await installHandler(session);

    let evalDone = false;
    const mainProm = session.evaluate(
        'Do[nP4 = k; Pause[0.3], {k, 1, 200}]; "p4-done"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).then(() => { evalDone = true; });

    await sleep(500);

    // Open dialog #1
    log('  [P4] interrupt #1...');
    session.interrupt();
    try { await pollUntil(() => session.isDialogOpen, 3000); }
    catch (_) { session.close(); throw new Error('Dialog #1 never opened'); }
    log('  [P4] dialog #1 open — forcing dialogEval timeout then abort');

    // Force dialogEval timeout
    try { await withTimeout(session.dialogEval('nP4'), 300, 'deliberate'); } catch (_) {}

    // Abort instead of exitDialog — this is the extension's recovery path
    log('  [P4] calling session.abort()...');
    try { session.abort(); } catch(_) {}

    // Wait for dialog to close + eval to end
    const tAbort = Date.now();
    while (session.isDialogOpen && Date.now()-tAbort < 5000) await sleep(50);
    log(`  [P4] isDialogOpen after abort = ${session.isDialogOpen} (waited ${Date.now()-tAbort}ms)`);

    // Wait for the main eval to show as done
    if (!evalDone) {
        try { await withTimeout(mainProm, 5000, 'P4 abort settle'); } catch (_) {}
    }
    await sleep(500); // let kernel settle

    // Now start a fresh eval and try interrupt
    log('  [P4] starting fresh eval after abort + recovery...');
    const session2Eval = session.evaluate(
        'Do[nP4 = k; Pause[0.3], {k, 1, 50}]; "p4-done2"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).catch(() => {});

    await sleep(500);

    log('  [P4] interrupt #2 on fresh eval...');
    session.interrupt();
    let dlg2Opened = false;
    const t2 = Date.now();
    while (!session.isDialogOpen && Date.now()-t2 < 3000) await sleep(30);
    dlg2Opened = session.isDialogOpen;
    log(`  [P4] isDialogOpen after abort+recovery = ${dlg2Opened} after ${Date.now()-t2}ms`);

    if (dlg2Opened) {
        const val = await withTimeout(session.dialogEval('nP4'), 4000, 'dialogEval post-abort');
        log(`  [P4] dialogEval post-abort = ${JSON.stringify(val)}`);
        await session.exitDialog();
    }

    try { await withTimeout(session2Eval, 15_000, 'P4 loop2'); } catch (_) {}
    session.close();

    log(`\n  [P4] SUMMARY:`);
    log(`    dialog opened after abort+recovery = ${dlg2Opened}`);
    if (dlg2Opened) {
        log('  [P4] PASS: abort() restores interrupt capability');
    } else {
        log('  [P4] FAIL: abort() does NOT restore interrupt capability — kernel permanently degraded');
        throw new Error('abort() did not restore interrupt capability');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// P5: closeAllDialogs() after stuck dialog — lighter alternative to abort()
// ─────────────────────────────────────────────────────────────────────────────
await run('P5: closeAllDialogs() after stuck dialog → subsequent interrupt works', async () => {
    const session = mkSession();
    await installHandler(session);

    let evalDone = false;
    const mainProm = session.evaluate(
        'Do[nP5 = k; Pause[0.3], {k, 1, 200}]; "p5-done"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).then(() => { evalDone = true; });

    await sleep(500);

    // Open dialog #1
    log('  [P5] interrupt #1...');
    session.interrupt();
    try { await pollUntil(() => session.isDialogOpen, 3000); }
    catch (_) { session.close(); throw new Error('Dialog #1 never opened'); }
    log('  [P5] dialog #1 open — forcing timeout + closeAllDialogs');

    // Force timeout
    try { await withTimeout(session.dialogEval('nP5'), 300, 'deliberate'); } catch (_) {}

    // closeAllDialogs instead of abort
    log('  [P5] calling session.closeAllDialogs()...');
    try { session.closeAllDialogs(); } catch(_) {}

    await sleep(500);
    log(`  [P5] isDialogOpen after closeAllDialogs = ${session.isDialogOpen}`);
    await sleep(300);

    // Send interrupt #2
    log('  [P5] interrupt #2...');
    session.interrupt();
    let dlg2 = false;
    const t2 = Date.now();
    while (!session.isDialogOpen && Date.now()-t2 < 3000) await sleep(30);
    dlg2 = session.isDialogOpen;
    log(`  [P5] isDialogOpen after closeAllDialogs+recovery = ${dlg2} after ${Date.now()-t2}ms`);

    if (dlg2) {
        const v = await withTimeout(session.dialogEval('nP5'), 4000, 'dialogEval post-close');
        log(`  [P5] dialogEval = ${JSON.stringify(v)}`);
        await session.exitDialog();
    }

    try { await withTimeout(mainProm, 20_000, 'P5 loop'); } catch (_) {}
    session.close();

    log(`\n  [P5] SUMMARY: closeAllDialogs recovery = ${dlg2 ? 'WORKS' : 'BROKEN'}`);
    if (!dlg2) throw new Error('closeAllDialogs() did not restore interrupt capability');
});

// ─────────────────────────────────────────────────────────────────────────────
// P6: The actual extension scenario — Pause[5] cells with LiveEvaluations
//     Simulates exactly what happens when user runs Dynamic[n, LiveEvaluations->6]
//     and then evaluates `n = RandomInteger[100]; Pause[5]`
// ─────────────────────────────────────────────────────────────────────────────
await run('P6: Simulate Dynamic + n=RandomInteger[100]; Pause[5] — full scenario', async () => {
    const session = mkSession();
    await installHandler(session);

    let evalDone = false;

    log('  [P6] starting n=RandomInteger[100]; Pause[5] ...');
    const mainProm = session.evaluate(
        'n = RandomInteger[100]; Pause[5]; "p6-done"',
        { onDialogBegin: () => {}, onDialogEnd: () => {} }
    ).then(r => { evalDone = true; log(`  [P6] eval completed: ${JSON.stringify(r?.result)}`); });

    await sleep(200); // let eval start

    const INTERRUPT_WAIT_MS = 2500; // same as extension
    const DIALOG_EVAL_TIMEOUT_MS = 8000; // same as extension

    let dialogReadSucceeded = false;
    let pauseIgnoredInterrupt = false;
    let nValue = null;

    for (let cycle = 1; cycle <= 5 && !evalDone; cycle++) {
        log(`  [P6] cycle ${cycle}: busy=${!evalDone}, sending interrupt...`);
        const t0 = Date.now();
        session.interrupt();

        while (!session.isDialogOpen && Date.now()-t0 < INTERRUPT_WAIT_MS) await sleep(25);
        const dlg = session.isDialogOpen;
        log(`  [P6] cycle ${cycle}: dlgOpen=${dlg} after ${Date.now()-t0}ms`);

        if (!dlg) {
            log(`  [P6] cycle ${cycle}: Pause[] ignored interrupt (no dialog in ${INTERRUPT_WAIT_MS}ms)`);
            pauseIgnoredInterrupt = true;
            await sleep(300);
            continue;
        }

        // Dialog opened — try to read n
        try {
            const val = await withTimeout(
                session.dialogEval('n'),
                DIALOG_EVAL_TIMEOUT_MS,
                `P6 dialogEval cycle ${cycle}`
            );
            nValue = val?.value ?? val;
            log(`  [P6] cycle ${cycle}: n = ${JSON.stringify(nValue)}`);
            dialogReadSucceeded = true;
            await session.exitDialog();
            break;
        } catch (e) {
            log(`  [P6] cycle ${cycle}: dialogEval error: ${e.message}`);
            // Try exitDialog — if it fails, do abort
            let exitOk = false;
            for (let a = 0; a < 3 && !exitOk; a++) {
                try {
                    await withTimeout(session.exitDialog(), 2000, `exitDialog attempt ${a+1}`);
                    exitOk = true;
                } catch (ee) {
                    log(`  [P6] exitDialog attempt ${a+1} failed: ${ee.message}`);
                }
            }
            if (!exitOk) {
                log('  [P6] all exitDialog failed — aborting');
                try { session.abort(); } catch(_) {}
                await sleep(1000);
                break;
            }
        }
    }

    log(`\n  [P6] waiting for Pause[5] to finish naturally...`);
    try { await withTimeout(mainProm, 12_000, 'P6 main eval'); } catch (_) {}

    log(`\n  [P6] SUMMARY:`);
    log(`    Pause ignored interrupt    = ${pauseIgnoredInterrupt}`);
    log(`    Dialog read succeeded      = ${dialogReadSucceeded}`);
    log(`    n value read               = ${JSON.stringify(nValue)}`);
    log(`    CONCLUSION: ${pauseIgnoredInterrupt && !dialogReadSucceeded
        ? 'Pause[5] completely blocks Dynamic updates — this is the observed bug'
        : dialogReadSucceeded
            ? 'At least one read succeeded despite Pause'
            : 'Unexpected outcome'}`);

    session.close();
    // P6 is purely diagnostic — always passes (we log the observed behavior)
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
log('\n' + '═'.repeat(72));
log(`RESULTS: ${passed} passed, ${failed} failed`);
for (const r of results) {
    log(`  ${r.status === 'PASS' ? '✓' : '✗'}  ${r.name} (${r.ms}ms)${r.error ? '  → ' + r.error : ''}`);
}
log('═'.repeat(72));
writeReport();
log(`\nReport written → ${REPORT}`);

    process.exit(failed > 0 ? 1 : 0);

})().catch(e => {
    console.error('Fatal:', e);
    writeReport();
    process.exit(2);
});
