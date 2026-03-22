# ScheduledTask Dialog[] Race Condition — Research & Fix

**Date:** 2026-03-22  
**Version fixed:** 0.7.1 (bug present since ScheduledTask was introduced in 0.6.x)  
**Reporter:** user notebook workflow  
**Files changed:** `src/wstp_session.cc`, `src/evaluate_worker.cc`

---

## 1. User-visible symptom

Running three notebook cells in sequence:

```wolfram
(* Cell 1 *)   n = 0; Dynamic[n]
(* Cell 2 *)   Do[n = k; Pause[1]; Print[n], {k, 1, 6}]; "done"   (* interactive:true *)
(* Cell 3 *)   1 + 1
```

Cell 2 completed normally ("done"), cell 3 hung permanently — the kernel was entirely unresponsive. `sub()`, `subAuto()`, and `evaluate()` all timed out.

The same pattern appeared in the real extension: after a long interactive computation with Dynamic widgets the kernel would wedge and require a full reload.

---

## 2. Background: the ScheduledTask mechanism

When `registerDynamic` + `setDynAutoMode(true)` are active, `EvaluateWorker` installs a kernel-side `ScheduledTask` that fires `Dialog[]` every ~300 ms.  Inside the Dialog, C++ sends the registered Dynamic expressions via `EnterTextPacket`, reads their results, then closes the Dialog with `Return[$Failed]`.  This gives live-update values to the JS side without interrupting the running evaluation.

The task is guarded by `$wstpDynTaskStop`:
- `$wstpDynTaskStop = True` → the task fires but does nothing (suppressed)
- `$wstpDynTaskStop =.` → the task fires and opens `Dialog[]` (active)

The `EvaluateWorker` protocol:
1. **Install** (if `dynTaskInstalledInterval_ != dynIntervalMs`): send `EvaluatePacket` with `Quiet[$wstpDynTaskStop=True; …RunScheduledTask[…]]`
2. **Main eval**: prepend `$wstpDynTaskStop=.;` to unsuppress, then send the actual expression
3. **DrainToEvalResult** handles every `BEGINDLGPKT` via the `dynAutoMode` path

---

## 3. What happens at cell 2 → cell 3 transition

### 3a. Normal path (no race)

```
kernel finishes Do[…] → sends RETURNPKT("done") + INPUTNAMEPKT
EvaluateWorker sees RETURNPKT → returns result, calls completion callback
MaybeStartNext() picks up the post-eval idle subAuto (ToString[1+1])
WhenIdleWorker starts:
  - prepends $wstpDynTaskStop=True;RemoveScheduledTask[…];$wstpDynTaskStop=.;$wstpDynTask=.
  - drainStalePackets (closes at most one stale Dialog)
  - sends EvaluatePacket(toString[1+1])
  - kernel replies RETURNPKT("2")  ✓
```

### 3b. Race path (the bug)

```
[T=0]    kernel finishes Do[…] → RETURNPKT on link (unread)
[T=0]    ScheduledTask fires   → BEGINDLGPKT on link (stale)

[T=50ms] main eval sees RETURNPKT first → completes
          MaybeStartNext() → WhenIdleWorker starts
          drainStalePackets → drains the first BEGINDLGPKT → exits on 5ms idle
          
[T=160ms] ScheduledTask fires AGAIN → second BEGINDLGPKT on link

[T=161ms] WhenIdleWorker sends EvaluatePacket("ToString[1+1]")
           ↑ This EvaluatePacket arrives at the kernel while it is inside Dialog[]
           The kernel reads it as dialog input (not a top-level expression)
           → kernel processes the expression, sends RETURNTEXTPKT inside the Dialog
           → Dialog waits for more input (EvaluatePacket is consumed, channel corrupted)

[T=∞]    WhenIdleWorker's DrainToEvalResult waits for top-level RETURNPKT — never arrives
          All subsequent evaluate() calls queue behind a permanently blocked link
```

### 3c. Why `drainStalePackets` was insufficient

`drainStalePackets` exits after **5 ms of silence**.  The ScheduledTask fires every **300 ms**.  After closing the first stale Dialog there was a ~160 ms window before the next firing.  During that window everything looked quiet, so `drainStalePackets` returned `false` (idle), and `WhenIdleWorker` sent its packet straight into the next Dialog.

### 3d. Why the link was permanently broken (not just one eval)

Once an `EvaluatePacket` is consumed as Dialog input:
- The kernel sends a `RETURNTEXTPKT` or `RETURNPKT` for the expression *inside* the Dialog
- But the Dialog is still open, waiting for `EnterTextPacket` / `Return[…]` to close it
- `DrainToEvalResult(lp, nullptr)` (opts=null, WhenIdleWorker) entered the `dynAutoMode` path because of the condition `if (!opts || …)` at `drain.cc:735` — `!opts` is true for null opts
- Inside that handler, the code called `drainUntilEndDialog` which captured the `RETURNPKT` from the EvaluatePacket used-as-dialog-input as the "outer result", returned it as the subAuto result, then reset `dynTaskInstalledInterval_ = 0`
- The next `EvaluateWorker` saw `dynTaskInstalledInterval_ == 0` and `dynAutoMode_ == true` → reinstalled the ScheduledTask via a **separate EvaluatePacket**
- That install completed, but now the kernel link was in an invalid state (the Dialog from step 3b was never properly closed)
- The follow-up `evaluate('2+2')` sent into a link that appeared open but whose kernel-side state was undefined → permanent silence

---

## 4. Diagnostic trace (from `node tests/mini-test.js --only 7`)

```
[50.320] [Eval] pkt=8           ← main eval INPUTNAMEPKT — eval done
[50.815] [subAuto] idle path    ← cell 3 subAuto queued
[50.815] [when-idle] prepending ScheduledTask stop
[50.815] [when-idle] pre-eval: stale data on link
[50.815] [Eval] drainStalePackets: stale BEGINDLGPKT level=1 — auto-closing
[50.815] [Eval] drainStale: sent Return[$Failed], draining...
[50.818] [Eval] drainStale: drain pkt=20  ← first Dialog closed
            (5 ms idle → drainStalePackets returns)
[50.958] [Eval] pkt=19          ← SECOND BEGINDLGPKT — ScheduledTask fired again!
[50.958] [drainEndDlg] pkt=8
[50.960] [drainEndDlg] pkt=3   ← RETURNPKT captured inside Dialog (our EvalPacket result)
[50.960] [drainEndDlg] captured outer result (pkt=3)
[50.960] [drainEndDlg] pkt=20
[50.960] [Eval] dynAutoMode: outer RETURNPKT captured during drain — returning directly
[50.966] [Eval] dynAutoMode: installing ScheduledTask interval=0.300000s
            ← follow-up evaluate('2+2') enters, reinstalls task
            ← task fires Dialog again, EvalPacket(2+2) consumed as dialog input
            ← permanent hang (no more log output)
```

The timing `50.958 - 50.818 = 140 ms` matches `300 ms interval / 2` (the task had been running for ~150 ms when the drain finished).

---

## 5. Fix: WhenIdleWorker two-phase execute

The fix is in `src/wstp_session.cc`, `StartWhenIdleWorker`.

### Old approach (broken)

```cpp
if (dynTaskInstalledInterval_ > 0) {
    item.expr = "Quiet[$wstpDynTaskStop=True; RemoveScheduledTask[…]; …];" + item.expr;
    dynTaskInstalledInterval_ = 0;
}
// ...Execute():
if (WSReady(lp_)) drainStalePackets(lp_, nullptr);    // ← closes at most one Dialog
WSPutFunction(lp_, "EvaluatePacket", 1);               // ← sent into potentially-open Dialog
```

The stop command was prepended to the expression and sent *inside* the expression — but the expression itself needed to reach the kernel at top-level first.

### New approach (fixed)

**Phase A — drain all Dialogs from within the Dialog protocol:**

```cpp
while (still_time_left) {
    if (!WSReady(lp_)) {
        if (silence > 400ms) break;   // > one interval → task definitely stopped
        continue;
    }
    pkt = WSNextPacket(lp_);
    if (pkt == BEGINDLGPKT) {
        // pre-drain until INPUTNAMEPKT (Dialog waiting for input)
        drain_until(INPUTNAMEPKT, 500ms);
        // stop the task + exit Dialog in ONE EnterTextPacket (correct packet type)
        WSPutFunction(lp_, "EnterTextPacket", 1);
        WSPutUTF8String(lp_, "$wstpDynTaskStop=True;"
                             "Quiet[If[ValueQ[$wstpDynTask], RemoveScheduledTask[$wstpDynTask]]];"
                             "$wstpDynTask=.;"
                             "Return[$Failed]", …);
        WSEndPacket(lp_); WSFlush(lp_);
        drainUntilEndDialog(lp_, 3000);   // wait for ENDDLGPKT
    } else WSNewPacket(lp_);
}
```

Key insight: **dialog input must be sent as `EnterTextPacket`, not `EvaluatePacket`.**  Using the wrong packet type is what caused the original corruption.

**Phase B — send the actual eval on a clean link:**

```cpp
WSPutFunction(lp_, "EvaluatePacket", 1);   // now safe: kernel is at level 0
WSPutUTF8String(lp_, expr_, …);
result_ = DrainToEvalResult(lp_);           // opts=nullptr: simple drain
```

### Fix in evaluate_worker.cc

Secondary fix: the ScheduledTask install expression used to unset `$wstpDynTaskStop` immediately after `RunScheduledTask`:

```cpp
// OLD (broken) — task could fire Dialog before next EvaluatePacket was read
"Quiet[$wstpDynTaskStop=True; RemoveScheduledTask[…]; $wstpDynTaskStop=.; $wstpDynTask=RunScheduledTask[…]]"
```

Changed to keep `$wstpDynTaskStop=True` so the task starts suppressed:

```cpp
// NEW — task stays suppressed until Phase-3 prepend "$wstpDynTaskStop=.;" runs inside the expr
"Quiet[$wstpDynTaskStop=True; RemoveScheduledTask[…]; $wstpDynTask=RunScheduledTask[…]]"
```

This is a defence-in-depth measure.  The primary fix (WhenIdleWorker Phase A) is sufficient by itself.

---

## 6. Why 400 ms idle threshold

The ScheduledTask fires every `dynIntervalMs` ms (default 300 ms).  Waiting 400 ms of silence guarantees:
- At least one full interval has elapsed with no new Dialog
- i.e., the task has been stopped (or never was active)

If the task is still running, it would fire within 300 ms and Phase A would catch it.  400 ms > 300 ms → complete.

Hard deadline is 2000 ms to prevent infinite hang if the task somehow cannot be stopped.

---

## 7. Test coverage

| Test | What it reproduces |
|------|--------------------|
| `mini-test.js M7` | Full extension flow: 3 dyn + many busy subAuto + idle subAuto + follow-up eval |
| `test.js 65` | Same as M7 |
| `test.js 66` | 3 dyn, NO busy subAuto during main eval |
| `test.js 67` | 1 dyn + many busy subAuto |
| `test.js 68` | Immediate post-eval idle subAuto (no sleep before) |
| `test.js 69` | `subWhenIdle` instead of `subAuto` |
| `test.js 70` | `evaluate()` directly instead of subAuto |
| `test_subauto_idle_hang.js` | Standalone A–F variations for isolated testing |

All 77 tests pass on macOS ARM64 after the fix.

---

## 8. WSTP packet type reference (relevant constants)

| Number | Name | Direction | Meaning |
|--------|------|-----------|---------|
| 3 | RETURNPKT | kernel→client | result of EvaluatePacket |
| 4 | RETURNTEXTPKT | kernel→client | text result of EnterTextPacket |
| 8 | INPUTNAMEPKT | kernel→client | `In[n]:=` prompt (Dialog waiting for input) |
| 9 | OUTPUTNAMEPKT | kernel→client | `Out[n]=` prefix |
| 16 | INPUTPKT | kernel→client | raw input prompt |
| 19 | BEGINDLGPKT | kernel→client | Dialog[] opened |
| 20 | ENDDLGPKT | kernel→client | Dialog[] closed |

**Critical rule:** inside a Dialog, the kernel accepts only `EnterTextPacket` or `EnterExpressionPacket` — **not** `EvaluatePacket`.  Sending `EvaluatePacket` inside a Dialog puts the link in an undefined state.
