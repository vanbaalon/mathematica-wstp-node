'use strict';

// ── Interrupt → Dialog[] subsession diagnostic test ──────────────────────────
//
// Tests the specific flow used by the VS Code extension ⌥⇧↵ feature:
//   1. Install interrupt handler (via evaluate OR sub — we test both)
//   2. Start a long-running evaluate() in the background
//   3. Call session.interrupt() → kernel handler opens Dialog[]
//   4. Poll session.isDialogOpen — must flip to true within 3 s
//   5. Call session.dialogEval() inside the dialog
//   6. Call session.exitDialog() → main eval resumes
//
// Run:
//   node test_interrupt_dialog.js
//
// With C++ diagnostics:
//   DEBUG_WSTP=1 node test_interrupt_dialog.js 2>diag.txt
//   grep -E "pkt=|interrupt|dialog|BEGINDLG|ENDDLG" diag.txt
// ─────────────────────────────────────────────────────────────────────────────

const { WstpSession, setDiagHandler } = require('./build/Release/wstp.node');

const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function pollUntil(pred, timeoutMs = 3000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = setInterval(() => {
            if (pred()) { clearInterval(tick); resolve(); }
            else if (Date.now() - start > timeoutMs) {
                clearInterval(tick);
                reject(new Error(`pollUntil timed out after ${timeoutMs} ms`));
            }
        }, intervalMs);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TEST_TIMEOUT_MS = 20_000;
let passed = 0, failed = 0;

async function run(name, fn) {
    process.stdout.write(`  ${name} … `);
    const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`TIMED OUT after ${TEST_TIMEOUT_MS} ms`)), TEST_TIMEOUT_MS));
    try {
        await Promise.race([fn(), timeout]);
        console.log('✓ PASS');
        passed++;
    } catch (e) {
        console.log(`✗ FAIL: ${e.message}`);
        failed++;
        process.exitCode = 1;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runInterruptDialogTest(session, installVia, varName, testNum) {
    // Install the interrupt handler.
    // We test two paths:
    //   installVia = 'evaluate' → EnterExpressionPacket (interactive main loop)
    //   installVia = 'sub'      → EvaluatePacket (batch, bypasses main loop)
    const handlerExpr = 'Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]';
    if (installVia === 'evaluate') {
        await session.evaluate(handlerExpr, {
            // Pass all three Dialog callbacks so C++ drain loop can service BEGINDLGPKT
            // even if the evaluate() call itself immediately triggers the dialog logic.
            onDialogBegin: () => {},
            onDialogEnd:   () => {},
            onDialogPrint: () => {},
        });
    } else {
        await session.sub(handlerExpr);
    }

    // Start a long computation.  It must have onDialogBegin/End callbacks — without
    // them the C++ drain loop may not enter the BEGINDLGPKT handling path at all.
    let dialogOpened = false;
    let dialogClosed = false;
    // Use a shorter loop so it can complete within the test timeout if needed.
    // 30 iterations × 0.15 s = ~4.5 s after dialog exits.
    const mainExpr = `Do[${varName} = k; Pause[0.15], {k, 1, 30}]; "main done ${testNum}"`;

    const mainEval = session.evaluate(mainExpr, {
        onDialogBegin: (_level) => { dialogOpened = true; },
        onDialogEnd:   (_level) => { dialogClosed = true; },
        onDialogPrint: () => {},
    });

    // Wait for the loop to actually start running.
    await sleep(300);

    // Send WSInterruptMessage.
    const sent = session.interrupt();
    assert(sent === true, `interrupt() returned ${sent} — expected true (eval was in flight)`);
    console.log(`\n    [interrupt sent via ${installVia}]`);

    // CRITICAL: isDialogOpen must flip to true within 3 s.
    // If this assertion fires, the C++ backend is not processing BEGINDLGPKT.
    try {
        await pollUntil(() => session.isDialogOpen, 3000, 30);
    } catch (_) {
        // Cancel the stuck eval before throwing
        mainEval.catch(() => {});
        throw new Error(
            `isDialogOpen never became true after interrupt() (handler via ${installVia}). ` +
            `C++ drain loop may not handle BEGINDLGPKT, or WSInterruptMessage ` +
            `was sent to the wrong link / with wrong message type.`
        );
    }

    assert(session.isDialogOpen, 'isDialogOpen should be true inside Dialog[]');
    assert(dialogOpened, 'onDialogBegin callback was never fired');

    // Evaluate an expression inside the dialog — verifies dialogEval() works.
    const val = await session.dialogEval(varName);
    assert(
        val !== null && typeof val.value === 'number' && val.value >= 1,
        `dialogEval('${varName}') returned ${JSON.stringify(val)} — expected a number >= 1`
    );
    console.log(`    [dialog open, ${varName} = ${val.value}]`);

    // Close the dialog — main eval must resume.
    await session.exitDialog();
    assert(!session.isDialogOpen, 'isDialogOpen must be false after exitDialog()');
    assert(dialogClosed, 'onDialogEnd callback was never fired');

    // The main eval must now complete normally.
    const r = await mainEval;
    assert(
        r && r.result && r.result.value === `main done ${testNum}`,
        `main eval result after exitDialog(): ${JSON.stringify(r && r.result)}`
    );
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n=== Interrupt → Dialog[] subsession tests ===\n');

    // Test A: handler installed via interactive evaluate() (EnterExpressionPacket)
    // The README says this is the correct context for interrupt handlers.
    // EXPECTED: PASS
    {
        console.log('Opening session A (interactive: true) …');
        const sessionA = new WstpSession(KERNEL_PATH, { interactive: true });
        assert(sessionA.isOpen, 'session A failed to open');

        await run(
            'Test A — interrupt() → Dialog[] (handler via evaluate/interactive)',
            () => runInterruptDialogTest(sessionA, 'evaluate', 'iA$$', 'A')
        );

        sessionA.close();
        console.log('  Session A closed.\n');
    }

    // Brief pause between sessions to let kernel process cleanup.
    await sleep(1000);

    // Test B: handler installed via sub() (EvaluatePacket / batch context)
    // This is the path init.wl currently uses (loaded via session.sub()).
    // If this FAILS while test A passes: the extension must install the handler
    // via session.evaluate() instead of relying on init.wl's sub() load.
    // If this also PASSES: the batch vs interactive context does not matter.
    {
        console.log('Opening session B (interactive: true) …');
        const sessionB = new WstpSession(KERNEL_PATH, { interactive: true });
        assert(sessionB.isOpen, 'session B failed to open');

        await run(
            'Test B — interrupt() → Dialog[] (handler via sub/batch)',
            () => runInterruptDialogTest(sessionB, 'sub', 'iB$$', 'B')
        );

        sessionB.close();
        console.log('  Session B closed.\n');
    }

    // ── Results ──
    console.log('─'.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log();

    if (failed > 0) {
        console.log('DIAGNOSIS GUIDE');
        console.log('───────────────');
        console.log('Re-run with C++ diagnostics:');
        console.log('  DEBUG_WSTP=1 node test_interrupt_dialog.js 2>diag.txt');
        console.log('  grep -E "pkt=|interrupt|BEGINDLG|ENDDLG|isDialog" diag.txt');
        console.log();
        console.log('What to look for in diag.txt:');
        console.log('  • After "interrupt sent", does "pkt=8" appear?');
        console.log('    pkt=8 = BEGINDLGPKT — if absent, WSInterruptMessage is not');
        console.log('    reaching the kernel, or the handler is not installed.');
        console.log('  • If pkt=8 appears but isDialogOpen stays false: the C++ drain');
        console.log('    loop receives BEGINDLGPKT but does not set isDialogOpen_ = true.');
        console.log();
        console.log('Key things to check in addon.cc:');
        console.log('  1. interrupt(): WSPutMessage(link_, WSInterruptMessage)');
        console.log('     — must be WSInterruptMessage (=2), not WSAbortMessage (=4)');
        console.log('  2. Drain loop: case for BEGINDLGPKT (packet type 8)');
        console.log('     — must set isDialogOpen_ = true and fire onDialogBegin TSFN');
        console.log('  3. Drain loop: inner dialog loop handling ENDDLGPKT (type 9)');
        console.log('     — must set isDialogOpen_ = false and fire onDialogEnd TSFN');
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
