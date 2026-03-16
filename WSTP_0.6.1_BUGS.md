# WSTP 0.6.1 — Bug Report & Required Fixes

**Date:** 2026-03-16  
**Context:** Wolfbook extension v2.2.0, Wolfram 3 on ARM64 (Apple Silicon)  
**Ref:** `DYNAMIC_EVAL_SPEC.md` (the original spec for the C++-internal Dynamic eval path)

---

## Summary

Two user-visible bugs remain after the 0.6.1 update.  Both trace to interactions
between the `dynAutoMode_` state, the BEGINDLGPKT handler, and the MENUPKT handler.
The root cause is a **missing safety fallback** in the BEGINDLGPKT handler — not the
`dynAutoMode_{false}` default, which is correct (changing it to `true` breaks 11
existing Dialog[] tests: 15, 17, 19–23, P2–P5).

| # | Bug | Severity | Root Cause |
|---|-----|----------|------------|
| 1 | Cell hangs when rendering output (last sub-expression has no semicolons) | **Critical** — kernel stuck | BEGINDLGPKT falls to legacy dialog loop with nobody to service it |
| 2 | Live-watch panel does not update during long evaluations | Medium | MENUPKT responds `'c'` — interrupt dismissed, no Dialog[] for live-watch |

---

## Bug 1 — Cell Hang on VsCodeRender (Critical)

### Reproduction

1. Start fresh kernel
2. Run any cell with `Dynamic[...]` (e.g. `Dynamic[n]; Do[Pause[0.2], {n,1,35}]`)
3. Wait for it to complete
4. Run cell: `Xtal=1; Ytal=2; Ztal=3; dd=ddfdddddd; n=1`  (no trailing semicolon)
5. Cell spinner never stops — kernel is stuck

Cell with trailing semicolons (`n=1;`) works because no VsCodeRender is called.

### Root Cause — Stale ScheduledTask + dynAutoMode=false

The chain of events:

```
Step 1: Dynamic cell runs
  → subsession.js calls setDynamicInterval(300)
  → C++ auto-sets dynAutoMode_=true
  → C++ installs kernel ScheduledTask: RunScheduledTask[Dialog[], 0.3]

Step 2: Dynamic cell completes
  → subsession.js cleanup calls setDynAutoMode(false)
  → dynAutoMode_=false
  → BUT: ScheduledTask is NOT stopped — it keeps calling Dialog[] every 300ms
  → AND: dynIntervalMs_ stays at 300 (not reset to 0)

Step 3: Next cell evaluates (non-Dynamic)
  → evaluate('n=1') dispatched with opts.dynAutoMode=false (copied from dynAutoMode_)
  → Kernel evaluates n=1 → RETURNPKT sent
  → Meanwhile, ScheduledTask fires → kernel calls Dialog[] → BEGINDLGPKT arrives

Step 4: BEGINDLGPKT handler in DrainToEvalResult
  → rejectDialog=false  (interactive eval)
  → dynAutoMode=false    (from step 2 cleanup)
  → Falls to LEGACY dialog inner loop
  → Sets dialogOpen_=true
  → Enters while(!dialogDone) loop waiting for JS dialogEval()/exitDialog()

Step 5: No JS callback fires
  → onDialogBegin was REMOVED from checkout.js (to fix the idle-MENUPKT hang)
  → hasOnDialogBegin=false → no NAPI callback → JS never learns about dialog
  → dialogQueue_ stays empty → nobody calls exitDialog()
  → PERMANENT HANG
```

### Why This Didn't Happen Before

In prior builds (spec draft), `dynAutoMode_` defaulted to `true`.  BEGINDLGPKT always
took the C++-internal path, which auto-closes the dialog.  But that default broke
11 Dialog[] tests (15, 17, 19–23, P2–P5) because `isDialogOpen` never became `true`
and `dialogEval()`/`exitDialog()` could never work.

The fix: `dynAutoMode_{false}` as default — correct for Dialog[] interactivity.  But
this exposed a gap: the BEGINDLGPKT handler's legacy dialog loop has no guard against
`hasOnDialogBegin=false`.  When `dynAutoMode=false` AND `hasOnDialogBegin=false`,
the handler enters the legacy loop with nobody to service it → permanent hang.

### Why `dynAutoMode_` Defaults to `false` (Not a Spec Bug)

`DYNAMIC_EVAL_SPEC.md` §4.2.2 originally specified `dynAutoMode_{true}`.
The implementation changed it to `dynAutoMode_{false}` *intentionally* because
`dynAutoMode=true` breaks the existing Dialog[] test suite.

**Tests that fail with `dynAutoMode_{true}`:** 15, 17, 19, 20, 21, 22, 23, P2, P3, P4, P5.

The reason: with `dynAutoMode=true`, the BEGINDLGPKT handler always takes the
C++-internal path (`if (!opts || opts->dynAutoMode)`) which auto-closes the
dialog with `Return[$Failed]`.  This prevents JS from ever seeing `isDialogOpen=true`,
so `dialogEval()` and `exitDialog()` cannot work.  These 11 tests all rely on
Dialog[] remaining open for JS interaction.

The MENUPKT handler also breaks:
```cpp
bool wantInspect = opts && !opts->dynAutoMode && opts->hasOnDialogBegin;
```
With `dynAutoMode=true`, `wantInspect` is always `false` → responds `'c'` →
interrupt never opens Dialog[].  Tests P2–P5 (interrupt→Dialog) all fail.

**Bottom line:** `dynAutoMode_{false}` is the correct default for the current
handler design.  The bug is not the default — it is the missing safety fallback
when `dynAutoMode=false` AND `hasOnDialogBegin=false`.

### Required Fix — Two Parts

**Fix 1A (immediate): Safety fallback in BEGINDLGPKT handler**

In `DrainToEvalResult`, the BEGINDLGPKT handler currently has three paths:
1. `rejectDialog=true` → auto-close ✓
2. `dynAutoMode=true` → C++-internal Dynamic eval + auto-close ✓
3. Legacy dialog inner loop (wait for JS dialogEval/exitDialog)

Path 3 hangs when `hasOnDialogBegin=false`.  Add a check **before** entering the
legacy loop:

```cpp
// After the dynAutoMode block, before "if (opts && opts->dialogOpen)":

// Safety fallback: if no JS dialog callbacks are registered, auto-close
// the dialog.  Without onDialogBegin, JS has no way to discover the
// dialog and will never call dialogEval()/exitDialog() → permanent hang.
if (!opts || !opts->hasOnDialogBegin) {
    DiagLog("[Eval] BEGINDLGPKT: no onDialogBegin callback — auto-closing "
            "(dynAutoMode=false, hasOnDialogBegin=false)");

    // Evaluate any registered Dynamic expressions before closing
    // (same inline logic as the dynAutoMode=true path above).
    if (opts && opts->dynMutex && opts->dynRegistry && opts->dynResults) {
        std::lock_guard<std::mutex> lk(*opts->dynMutex);
        // ... [same inline eval as dynAutoMode block] ...
    }

    // Close dialog: pre-drain INPUTNAMEPKT, send Return[$Failed], drain ENDDLGPKT
    // ... [same as rejectDialog path] ...

    continue;  // back to outer drain loop waiting for RETURNPKT
}

// Legacy dialog inner loop (only reached when hasOnDialogBegin=true)
// ... existing code ...
```

This guarantees: **BEGINDLGPKT never enters the legacy loop unless JS explicitly asked
for dialog callbacks.**  Stale ScheduledTask Dialog[] calls are silently handled.

**Fix 1B: ScheduledTask cleanup in setDynAutoMode(false)**

When `setDynAutoMode(false)` is called, send a kernel eval to stop the ScheduledTask:

```cpp
Napi::Value SetDynAutoMode(const Napi::CallbackInfo& info) {
    // ... existing validation ...
    bool newMode = info[0].As<Napi::Boolean>().Value();
    bool oldMode = dynAutoMode_.exchange(newMode);

    // NEW: When transitioning true→false, stop the kernel-side ScheduledTask
    // to prevent stale Dialog[] calls.
    if (oldMode && !newMode) {
        // Queue a sub-when-idle expression to set the stop flag.
        // (Can't do a full evaluate here — we're on the main thread.)
        // Option A: Use subWhenIdle to send "$wstpDynTaskStop = True"
        // Option B: Just set dynIntervalMs_ to 0 and let the next evaluate()
        //           reinstall/stop as needed.  The safety fallback from Fix 1A
        //           prevents any hang in the meantime.
        dynIntervalMs_.store(0);  // at minimum, stop the timer thread
    }
    return env.Undefined();
}
```

**Note:** The safety fallback (Fix 1A) is the correct fix.  Do NOT change `dynAutoMode_`
default to `true` — that would break 11 existing Dialog[] tests (15, 17, 19–23, P2–P5)
which rely on Dialog[] staying open for JS `dialogEval()`/`exitDialog()` interaction.

---

## Bug 2 — No Live-Watch Updates During Long Evaluation

### Reproduction

1. Open live-watch panel (shows current variable values)
2. Run: `Do[Pause[0.5], {n, 1, 25}]`
3. During the 12.5 seconds of evaluation, the live panel shows stale values
4. Values only update after the cell completes

### Root Cause — MENUPKT Responds 'c', Dismissing Interrupt

Live-watch (in `debugController.js`) uses this flow for non-Dynamic cells:
1. `ctrl.session.interrupt()` → sends WSInterruptMessage
2. Wait for `isDialogOpen` to become true (poll up to 2.5s)
3. `dialogEval(wlExpr)` to read watch values
4. `exitDialog()` to close dialog and resume evaluation

Step 2 fails because of the MENUPKT handler:
```cpp
// addon.cc line 1301
bool wantInspect = opts && !opts->dynAutoMode && opts->hasOnDialogBegin;
```

With the fix that removed `onDialogBegin` from checkout.js:
- `hasOnDialogBegin = false` → `wantInspect = false` → responds `'c'`
- Interrupt is dismissed, no Dialog[] opens
- Live-watch times out after 2.5s, sets `_liveWatchNoDialog=true`
- All subsequent interrupts suppressed for the rest of the cell

### Why onDialogBegin Was Removed

On Wolfram 3/ARM64, responding `'i'` to a MENUPKT when the kernel is **idle** (expression
already finished but RETURNPKT not yet consumed by C++) does NOT produce a clean
`Dialog[]`.  Instead of sending BEGINDLGPKT, the kernel hangs indefinitely.  This is
a Wolfram 3 ARM64-specific behavior — older x86 kernels handle idle-`'i'` gracefully.

Since we can't distinguish "busy MENUPKT" (expression computing) from "idle MENUPKT"
(expression finished, stale interrupt) at the C++ level, responding `'i'` always risks
the idle hang.  Removing `onDialogBegin` makes `wantInspect=false` → always `'c'` →
safe but live-watch stops working.

### Required Fix — Use dynAutoMode for Live-Watch

The live-watch should NOT use the interrupt → MENUPKT → Dialog[] path.  Instead, it
should use the same `registerDynamic()` / `getDynamicResults()` mechanism as Dynamic
widgets.

**JS-side change (debugController.js):** Instead of `interrupt()` + `dialogEval()`:
```javascript
// Register the watch expression
ctrl.session.registerDynamic('live-watch', wlExpr);

// Ensure ScheduledTask-based Dialog[] is active
ctrl.session.setDynamicInterval(1000);

// Poll for results (in the live-watch timer)
const results = ctrl.session.getDynamicResults();
if (results['live-watch']) {
    this._applyWatchWexpr(wl, results['live-watch']);
}

// On cleanup: unregister
ctrl.session.unregisterDynamic('live-watch');
// If no other Dynamic registrations, stop:
if (!ctrl._dynamicWidgets?.size)
    ctrl.session.setDynamicInterval(0);
```

**C++ requirement:** The dynAutoMode path must be active for live-watch evals.
`setDynamicInterval(ms>0)` auto-enables `dynAutoMode_=true` (current behavior via
`dynAutoMode_.store(ms > 0)` in `SetDynamicInterval`), so live-watch just needs to
call `setDynamicInterval()`.  This is the correct approach — the global default
must remain `false` to preserve Dialog[] interactivity in tests 15, 17, 19–23, P2–P5.

**C++ ScheduledTask install also needs to work:** currently, the ScheduledTask
is installed in `EvaluateWorker::Execute()` only when `opts_.dynAutoMode && opts_.dynIntervalMs > 0`.
This is correct — the task is installed on the first cell eval after `setDynamicInterval()`
is called.

### Interaction with the Debugger

The debugger uses its own interrupt → Dialog[] path for step-through.  It explicitly:
1. Calls `setDynAutoMode(false)` to use the legacy dialog path
2. Passes `onDialogBegin` callback to `evaluate()` → `hasOnDialogBegin=true`
3. Therefore `wantInspect=true` → MENUPKT responds `'i'` → Dialog[] → works

The debugger is not affected by this change because it always has `hasOnDialogBegin=true`.

---

## Summary of Required C++ Changes

### Critical (fixes the hang)

| Change | Where | What |
|--------|-------|------|
| BEGINDLGPKT safety fallback | `DrainToEvalResult`, BEGINDLGPKT case (after dynAutoMode block, before legacy loop) | When `hasOnDialogBegin=false`: evaluate registered Dynamic expressions (if any) and auto-close dialog. Never enter legacy loop without JS callbacks. |

### Recommended (cleanup)

| Change | Where | What |
|--------|-------|------|
| `setDynAutoMode(false)` cleanup | `SetDynAutoMode()` | Also set `dynIntervalMs_=0` to stop the timer thread. The kernel ScheduledTask stop is handled by the next `Execute()` or by the safety fallback. |

**Note:** Do NOT change `dynAutoMode_{false}` to `{true}` — that breaks tests 15, 17,
19–23, P2–P5 (11 tests total) because Dialog[] gets auto-closed before JS can interact.

### Test Cases

```
Test BUG1-A: Stale ScheduledTask + non-Dynamic cell
  - Register a Dynamic expr, setDynamicInterval(300)
  - Evaluate: Do[Pause[0.1], {i, 50}]   (5 seconds)
  - Unregister Dynamic, setDynAutoMode(false)   <-- cleanup
  - Immediately evaluate: n=1              <-- non-Dynamic, produces output
  - Verify: evaluate resolves normally (no hang)
  - Verify: next evaluate (1+1) also works

Test BUG1-B: BEGINDLGPKT with dynAutoMode=false, no callbacks
  - Set dynAutoMode=false
  - Install kernel ScheduledTask manually:
      evaluate('RunScheduledTask[Dialog[], 0.3]', {interactive:false, rejectDialog:true})
  - Evaluate: Do[Pause[0.5], {i, 10}]    (5 seconds, multiple Dialog[] from task)
  - Verify: evaluate resolves normally — each BEGINDLGPKT auto-closed
  - Verify: no hang, no stale dialogs

Test BUG2-A: Live-watch via registerDynamic
  - registerDynamic('watch', 'ToString[n, InputForm]')
  - setDynamicInterval(500)
  - Evaluate: Do[n=i; Pause[0.3], {i, 1, 20}]
  - Poll getDynamicResults() every 200ms
  - Verify: at least 5 results appear with changing n values
  - Verify: evaluate resolves normally

Test BUG2-B: Live-watch cleanup stops timer
  - registerDynamic('watch', 'ToString[n, InputForm]')
  - setDynamicInterval(500)
  - Evaluate: Do[n=i; Pause[0.3], {i, 1, 10}]
  - Verify: getDynamicResults returns results
  - Unregister + setDynamicInterval(0)
  - Evaluate: 1+1
  - Verify: no stale Dialog[] issues, getDynamicResults returns empty
  - Verify: existing Dialog[] tests (15, 17, 19-23, P2-P5) still pass
```

---

## Failing JavaScript Test (for current addon)

This test demonstrates Bug 1 using the current addon API:

```javascript
const wstp = require('./build/Release/wstp.node');

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';
const sess = new wstp.Session();
sess.start(KERNEL, ['-noprompt', '-rawterm']);

// Wait for kernel ready
await new Promise(r => setTimeout(r, 3000));

// Install interrupt handler
await sess.evaluate(
    'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]',
    { interactive: false }
);

// Step 1: Simulate what subsession.js does for a Dynamic cell
sess.registerDynamic('dyn-0', 'ToString[AbsoluteTime[], InputForm]');
sess.setDynamicInterval(300);  // installs ScheduledTask, sets dynAutoMode=true

// Step 2: Evaluate a cell (ScheduledTask fires Dialog[] during this)
const r1 = await sess.evaluate('Do[Pause[0.1], {i, 30}]');
console.log('Cell 1 done:', r1.result);  // should complete

// Step 3: Simulate cleanup — subsession.js calls setDynAutoMode(false)
sess.unregisterDynamic('dyn-0');
sess.setDynAutoMode(false);
// NOTE: does NOT call setDynamicInterval(0) — this is the bug trigger
// The ScheduledTask keeps running, calling Dialog[] every 300ms

// Step 4: Evaluate a NON-Dynamic cell (no onDialogBegin callback)
// BUG: This hangs because ScheduledTask Dialog[] → BEGINDLGPKT →
//      dynAutoMode=false, hasOnDialogBegin=false → legacy loop → nobody services it
const r2 = await Promise.race([
    sess.evaluate('n = 1'),  // simple expression
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: Bug 1 reproduced — evaluate hung')), 10000))
]);
console.log('Cell 2 done:', r2.result);  // never reaches here without fix

sess.stop();
```

**Expected with fix:** Both evaluations complete.  
**Current behavior:** `evaluate('n = 1')` hangs forever (10s timeout fires).
