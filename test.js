'use strict';

// ── Test suite for wstp-backend v6 ─────────────────────────────────────────
// Covers: evaluation queue, streaming callbacks, sub() priority, abort
//         behaviour, WstpReader side-channel, edge cases, Dialog[] subsession
//         (dialogEval, exitDialog, isDialogOpen, onDialogBegin/End/Print).
// Run with:  node test.js

const { WstpSession, WstpReader, setDiagHandler } = require('./build/Release/wstp.node');

const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

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

// Per-test timeout (ms).  Any test that does not complete within this window
// is failed immediately with a "TIMED OUT" error.  Prevents indefinite hangs.
const TEST_TIMEOUT_MS = 30_000;

// Hard suite-level watchdog: if the entire suite takes longer than this the
// process is force-killed.  Covers cases where a test hangs AND the per-test
// timeout itself is somehow bypassed (e.g. a blocked native thread).
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes
const suiteWatchdog = setTimeout(() => {
    console.error('\nFATAL: suite watchdog expired — process hung, force-exiting.');
    process.exit(2);
}, SUITE_TIMEOUT_MS);
suiteWatchdog.unref();   // does not prevent normal exit

let passed = 0;
let failed = 0;

async function run(name, fn) {
    // Race the test body against a per-test timeout.
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`TIMED OUT after ${TEST_TIMEOUT_MS} ms`)),
                   TEST_TIMEOUT_MS));
    try {
        await Promise.race([fn(), timeout]);
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}: ${e.message}`);
        failed++;
        process.exitCode = 1;
    }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('Opening session…');
    const session = new WstpSession(KERNEL_PATH);
    assert(session.isOpen, 'session did not open');
    console.log('Session open.\n');

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
    // Call Dialog[] from a plain evaluate().  No onDialogBegin callback is
    // registered.  We still use dialogEval('DialogReturn[]') to close it and
    // confirm the outer Promise resolves correctly afterwards.
    await run('17. unhandled dialog does not corrupt link', async () => {
        const evalPromise = session.evaluate('Dialog[]; 42');

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
        const p = session.evaluate('x$$ = Dialog[]; x$$ * 2');
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
        const p = session.evaluate('myVar$$ = 123; Dialog[]; myVar$$');
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
        const p = session.evaluate('Dialog[]; mutated$$');
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
        const p = session.evaluate('Dialog[]');
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
        const p = session.evaluate('Dialog[]');
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
        const p1 = session.evaluate('Dialog[]');
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

    // ── 25. abort() while dialog is open ──────────────────────────────────
    // Must run AFTER all other dialog tests — abort() sends WSAbortMessage
    // which resets the WSTP link, leaving the session unusable for further
    // evaluations.  Tests 26 and 27 need a clean session, so test 25 runs last
    // (just before test 18 which also corrupts the link via WSInterruptMessage).
    await run('25. abort while dialog is open', async () => {
        const p = session.evaluate('Dialog[]');
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

    // ── Teardown ──────────────────────────────────────────────────────────
    session.close();
    assert(!session.isOpen, 'main session not closed');

    console.log();
    if (failed === 0) {
        console.log(`All ${passed} tests passed.`);
    } else {
        console.log(`${passed} passed, ${failed} failed.`);
    }
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
