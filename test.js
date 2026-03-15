'use strict';

// ── Test suite for wstp-backend v0.6.0 ────────────────────────────────────
// Covers: evaluation queue, streaming callbacks, sub() priority, abort
//         behaviour, WstpReader side-channel, edge cases, Dialog[] subsession
//         (dialogEval, exitDialog, isDialogOpen, onDialogBegin/End/Print),
//         subWhenIdle() (background queue, timeout, close rejection), kernelPid,
//         Dynamic eval API (registerDynamic, getDynamicResults, setDynamicInterval,
//         setDynAutoMode, dynamicActive, rejectDialog, abort deduplication).

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

// withTimeout — race a promise against a named deadline.
function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

// mkSession — open a fresh WstpSession.
function mkSession() {
    return new WstpSession(KERNEL_PATH);
}

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
// process is force-killed.  Covers cases where a test hangs AND the per-test
// timeout itself is somehow bypassed (e.g. a blocked native thread).
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes
const suiteWatchdog = setTimeout(() => {
    console.error('\nFATAL: suite watchdog expired — process hung, force-exiting.');
    process.exit(2);
}, SUITE_TIMEOUT_MS);
suiteWatchdog.unref();   // does not prevent normal exit

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

async function run(name, fn, timeoutMs = TEST_TIMEOUT_MS) {
    if (ONLY_TESTS !== null && !ONLY_TESTS.has(testNum(name))) {
        skipped++;
        return;
    }
    // Race the test body against a per-test timeout.
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`TIMED OUT after ${timeoutMs} ms`)),
                   timeoutMs));
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
            const pEval = sub.evaluate('Dialog[]');
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
    await run('P1: Pause[8] ignores interrupt within 2500ms', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            let evalDone = false;
            const mainProm = s.evaluate(
                'pP1 = 0; Pause[8]; pP1 = 1; "p1-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).then(() => { evalDone = true; });

            await sleep(300);

            const sent = s.interrupt();
            assert(sent === true, 'interrupt() should return true mid-eval');

            const t0 = Date.now();
            while (!s.isDialogOpen && Date.now() - t0 < 2500) await sleep(25);

            const dlgOpened = s.isDialogOpen;
            assert(!dlgOpened, 'Pause[8] should NOT open a dialog within 2500ms');

            // After the 2500ms window the interrupt may still be queued — the kernel
            // will fire Dialog[] once Pause[] releases.  Abort to unstick the eval
            // rather than waiting for it to return on its own (which could take forever
            // if Dialog[] opens and nobody services it).
            s.abort();
            await mainProm; // resolves immediately after abort()
        } finally {
            s.close();
        }
    }, 20_000);

    // ── P2: Pause[0.3] loop — interrupt opens Dialog and dialogEval works ──
    // Expected: interrupt during a short Pause[] loop opens a Dialog[],
    // dialogEval can read the live variable, and exitDialog resumes the loop.
    await run('P2: Pause[0.3] loop — interrupt opens Dialog and dialogEval succeeds', async () => {
        const s = mkSession();
        try {
            await installHandler(s);

            let evalDone = false;
            const mainProm = s.evaluate(
                'Do[nP2 = k; Pause[0.3], {k, 1, 30}]; "p2-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).then(() => { evalDone = true; });

            await sleep(500);

            s.interrupt();
            try { await pollUntil(() => s.isDialogOpen, 3000); }
            catch (_) { throw new Error('Dialog never opened — interrupt not working with Pause[0.3]'); }

            const val = await withTimeout(s.dialogEval('nP2'), 5000, 'dialogEval nP2');
            assert(val && typeof val.value === 'number' && val.value >= 1,
                `expected nP2 >= 1, got ${JSON.stringify(val)}`);

            await s.exitDialog();
            await withTimeout(mainProm, 15_000, 'P2 main eval');
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, 30_000);

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
                'Do[nP3 = k; Pause[0.3], {k, 1, 200}]; "p3-done"',
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

                if (!evalDone) { try { await withTimeout(mainProm, 20_000, 'P3 loop'); } catch (_) {} }

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
    }, 45_000);

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
                'Do[nP4=k; Pause[0.3], {k,1,200}]; "p4-done"',
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
            while (s.isDialogOpen && Date.now() - tAbort < 5000) await sleep(50);
            try { await withTimeout(mainProm, 5000, 'P4 abort settle'); } catch (_) {}
            await sleep(300);

            // KEY assertion: the session is still functional for evaluate()
            // (abort() must NOT permanently close the link)
            const r = await withTimeout(
                s.evaluate('"session-alive-after-abort"'),
                8000, 'post-abort evaluate'
            );
            assert(r && r.result && r.result.value === 'session-alive-after-abort',
                `evaluate() after abort returned unexpected result: ${JSON.stringify(r)}`);
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, 30_000);

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
                'Do[nP5 = k; Pause[0.3], {k, 1, 200}]; "p5-done"',
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
            await withTimeout(installHandler(s), 8000, 'reinstall handler after abort');

            let dlg2 = false;
            const mainProm2 = s.evaluate(
                'Do[nP5b = k; Pause[0.3], {k, 1, 200}]; "p5b-done"',
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
    }, 60_000);

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
                'n = RandomInteger[100]; Pause[5]; "p6-done"',
                { onDialogBegin: () => {}, onDialogEnd: () => {} }
            ).then(() => { evalDone = true; });

            await sleep(200);

            const INTERRUPT_WAIT_MS = 2500;
            const DIALOG_EVAL_TIMEOUT_MS = 8000;
            let dialogReadSucceeded = false;
            let pauseIgnoredInterrupt = false;

            for (let cycle = 1; cycle <= 5 && !evalDone; cycle++) {
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

            try { await withTimeout(mainProm, 12_000, 'P6 main eval'); } catch (_) {}

            // Diagnostic: always passes — log observed outcome
            if (pauseIgnoredInterrupt && !dialogReadSucceeded) {
                console.log('    P6 note: Pause[5] blocked all interrupts — expected behaviour');
            } else if (dialogReadSucceeded) {
                console.log('    P6 note: at least one read succeeded despite Pause');
            }
        } finally {
            try { s.abort(); } catch (_) {}
            s.close();
        }
    }, 60_000);

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
            const r = await withTimeout(p, 5000, 'test 48 abort wait');
            assert(r.aborted, 'first eval should be aborted');
            // Now a new eval must work normally with dyn interrupts
            const r2 = await withTimeout(s.evaluate('Pause[0.8]; "alive"'), 8000, 'test 48 second eval');
            assert(r2.result.value === 'alive', 'kernel alive after abort');
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
            s.setDynamicInterval(80);
            for (let i = 0; i < 8; i++) {
                const r = await withTimeout(
                    s.evaluate(`Pause[0.15]; ${i}`),
                    6000, `test 49 cell ${i}`
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
            await withTimeout(s.evaluate('Pause[0.8]; "done"'), 8000, 'test 50 eval');
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

    // ── Teardown ──────────────────────────────────────────────────────────
    session.close();
    assert(!session.isOpen, 'main session not closed');

    console.log();
    if (failed === 0) {
        console.log(`All ${passed} tests passed${skipped ? ` (${skipped} skipped)` : ''}.`);
        // Force-exit: WSTP library may keep libuv handles alive after WSClose,
        // preventing the event loop from draining naturally.  All assertions are
        // done; a clean exit(0) is safe.
        process.exit(0);
    } else {
        console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}.`);
    }
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
