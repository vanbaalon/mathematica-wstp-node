# Task: Diagnose and fix interrupt-triggered Dialog[] subsession

## Problem summary

The VS Code extension sends `session.interrupt()` while a long `session.evaluate()` is
running (e.g. `Do[i = k; Pause[0.3], {k, 1, 200}]`).  The interrupt handler installed by
`init.wl` at startup is:

```wolfram
Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]
```

The expected effect is that `session.isDialogOpen` flips to `true` within ~1 s.  In
practice it never does — the JS side times out after 8 s with no dialog.

The existing test suite (`test.js`, tests 15–21) already covers *cooperative* Dialog[]
(the evaluate expression itself calls `Dialog[]`).  **There is no test for the
interrupt-triggered path.**  That is the missing piece.

---

## Step 1 — Add these two tests to `test.js`, then run `node test.js`

Insert them after test 21 (or at the end of the existing block, before the `session.close()`).

### Test A — interrupt opens Dialog[] (the core scenario)

```js
// ── 22. interrupt() triggers Dialog[] via installed handler ──────────────
// This is the critical path used by the VS Code extension ⌥⇧↵ feature.
// Pre-requisite: the interrupt handler must be installed in the kernel's
// INTERACTIVE main loop (EnterExpressionPacket context), NOT via sub()
// (EvaluatePacket / batch context).  The install call must itself be an
// interactive evaluate() so the handler is registered in the right context.
await run('22. interrupt() → Dialog[] handler opens subsession', async () => {
    // 1. Install the handler via interactive evaluate() — same path as init.wl
    //    except init.wl runs via sub() (batch).  If sub() is what init.wl uses,
    //    test BOTH: first confirm which context actually registers the handler.
    await session.evaluate(
        'Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]'
    );

    // 2. Start a long computation — must have onDialogBegin/End callbacks or
    //    the C++ drain loop won't service BEGINDLGPKT correctly.
    let dialogOpened = false;
    const mainEval = session.evaluate(
        'Do[i$test = k; Pause[0.1], {k, 1, 100}]; "main done"',
        {
            onDialogBegin: (_level) => { dialogOpened = true; },
            onDialogEnd:   (_level) => {},
        }
    );

    // Give the Pause loop a moment to actually start running
    await new Promise(r => setTimeout(r, 400));

    // 3. Send WSInterruptMessage
    const sent = session.interrupt();
    assert(sent === true, 'interrupt() should return true while eval is in flight');

    // 4. Wait for BEGINDLGPKT → isDialogOpen must flip within 3 s
    try {
        await pollUntil(() => session.isDialogOpen, 50, 3000);
    } catch (_) {
        // Force cleanup
        mainEval.catch(() => {});
        assert(false, 'isDialogOpen never became true after interrupt() — dialog did not open');
    }
    assert(session.isDialogOpen, 'isDialogOpen must be true');
    assert(dialogOpened, 'onDialogBegin callback must have fired');

    // 5. Evaluate something inside the dialog
    const val = await session.dialogEval('i$test');
    assert(
        val !== null && typeof val.value === 'number' && val.value >= 1,
        `expected i$test >= 1 inside dialog, got ${JSON.stringify(val)}`
    );

    // 6. Exit the dialog so the main eval can resume
    await session.exitDialog();
    assert(!session.isDialogOpen, 'isDialogOpen must be false after exitDialog()');

    // 7. Main eval should now complete
    const r = await mainEval;
    assert(
        r.result.value === 'main done',
        `main eval result: ${JSON.stringify(r.result)}`
    );
});
```

### Test B — same but with handler installed via `sub()` (batch context, init.wl path)

```js
// ── 23. interrupt() → Dialog[] handler installed via sub() (batch context) ──
// init.wl loads via sub(), which uses EvaluatePacket (bypasses main loop).
// This test verifies whether that context difference matters.
// If test 22 passes but test 23 fails, the fix is to move the AddHandler call
// into an interactive evaluate() instead of sub().
await run('23. interrupt() → Dialog[] handler via sub() (batch path)', async () => {
    // Re-install via sub() (batch — EvaluatePacket)
    await session.sub(
        'Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]'
    );

    let dialogOpened = false;
    const mainEval = session.evaluate(
        'Do[j$test = k; Pause[0.1], {k, 1, 100}]; "main done 23"',
        {
            onDialogBegin: (_level) => { dialogOpened = true; },
            onDialogEnd:   (_level) => {},
        }
    );

    await new Promise(r => setTimeout(r, 400));
    session.interrupt();

    try {
        await pollUntil(() => session.isDialogOpen, 50, 3000);
    } catch (_) {
        mainEval.catch(() => {});
        assert(false, 'isDialogOpen never became true (sub()/batch handler path)');
    }

    await session.exitDialog();
    const r = await mainEval;
    assert(r.result.value === 'main done 23', `result: ${JSON.stringify(r.result)}`);
});
```

---

## Step 2 — Expected outcomes and diagnostic path

### If both tests PASS
The C++ layer is correct. The failure is in how the VS Code extension launches the session.
Check whether the session is created with `{ interactive: true }` — the README states that
for `isDialogOpen` to work correctly, the in-flight `evaluate()` must pass `onDialogBegin`,
`onDialogEnd`, and `onDialogPrint` callbacks. Without them the C++ drain loop may not enter
the BEGINDLGPKT handling path.

### If test 22 passes but test 23 fails
`Internal\`AddHandler` registered via `EvaluatePacket` (sub/batch context) is in a
different handler scope than the kernel's interactive main loop.  `WSInterruptMessage` fires
in the interactive loop context only, so the batch-registered handler is never invoked.

**Fix:** In `init.wl`, change the AddHandler call to use `Once[...]` or just leave it as is
but note that the extension's `launchKernel()` must install the handler via
`session.evaluate()` (interactive), NOT `session.sub()`. The init.wl Quiet[] call will
silently fail (or be ignored) unless run in the interactive context.

### If test 22 also fails
The problem is in `addon.cc`, in one of:

1. **`interrupt()` sends the wrong message type.**
   Search for `WSPutMessage` in `addon.cc`. It must send `WSInterruptMessage` (value 2),
   not `WSAbortMessage` (value 4) or `WSTerminateMessage` (value 1).
   ```cpp
   // Correct:
   WSPutMessage(link_, WSInterruptMessage);
   // Wrong (aborts rather than interrupts):
   WSPutMessage(link_, WSAbortMessage);
   ```

2. **The drain loop doesn't handle `BEGINDLGPKT`.**
   Look for the main packet-reading loop (likely `while (true)` that calls `WSNextPacket()`
   or `WSGetType()`). Check whether it handles `BEGINDLGPKT` (packet type 8).
   If absent, `isDialogOpen` never gets set. The loop must:
   - Detect `BEGINDLGPKT` → set `isDialogOpen_ = true` → fire `onDialogBegin` TSFN
   - Then enter a dialog inner-loop reading `InputNamePacket["Dialog>..."]` and
     dispatching queued `dialogEval()` / `exitDialog()` calls
   - Detect `ENDDLGPKT` → set `isDialogOpen_ = false` → fire `onDialogEnd` TSFN
   - Then return to the outer drain loop to continue the main eval

3. **The `onDialogBegin`/`onDialogEnd` callbacks are wired but `isDialogOpen_` is not set.**
   Two separate issues: the flag must be set synchronously on the thread-pool thread
   (so `session.isDialogOpen` getter returns the new value immediately), AND the TSFN
   callback to JS fires on the main thread.

---

## Step 3 — Key C++ constants to verify (WSTP packet enum)

```
WSTP packet types (WSNextPacket return values):
  2  = RETURNPKT         (EvaluatePacket result)
  3  = INPUTNAMEPKT      (kernel waiting for input — "In[n]:= ")
  8  = BEGINDLGPKT       (Dialog[] opened)
  9  = ENDDLGPKT         (Dialog[] closed)
 10  = INPUTPKT          (kernel waiting for raw input)
 13  = RETURNTEXTPKT     (text result)
 16  = OUTPUTNAMEPKT     ("Out[n]= " label)
```

After `WSInterruptMessage` is sent, the kernel will emit `BEGINDLGPKT` followed by
`INPUTNAMEPKT["Dialog> In[1]:= "]`.  The drain loop must consume `BEGINDLGPKT` and
set `isDialogOpen_ = true` **before** trying to read the `INPUTNAMEPKT`.

---

## Step 4 — Run with diagnostics on

```bash
cd /Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/WSTP\ Backend
DEBUG_WSTP=1 node test.js 2>diag.txt
grep -E "pkt=|DIALOG|Interrupt|BEGINDLG|ENDDLG" diag.txt
```

Look for `pkt=8` (BEGINDLGPKT) appearing after the interrupt is sent. If it never appears,
the interrupt isn't reaching the kernel. If `pkt=8` appears but `isDialogOpen` stays false,
the drain loop is not handling BEGINDLGPKT correctly.

---

## Summary of what to report back

1. Do tests 22 and 23 pass or fail, and what assertion do they fail on?
2. Does `DEBUG_WSTP` output show `pkt=8` after the interrupt?
3. What message type does `interrupt()` send? (grep for `WSPutMessage` in `addon.cc`)
4. Does the drain loop in `addon.cc` have a case for `BEGINDLGPKT` (packet type 8)?
