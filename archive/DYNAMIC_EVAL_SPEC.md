# WSTP Dynamic Evaluation — Technical Specification

**Status:** Partially implemented — Bug fixes landed in v0.6.2  
**Author:** Wolfbook Extension Team  
**Date:** 2026-03-15 (updated 2026-03-16)  
**Affected file:** `WSTP Backend/src/addon.cc`

---

## 1. Problem Statement

The current Dynamic widget system evaluates expressions during a running computation by
interrupting the kernel (WSInterruptMessage → Dialog[] → dialogEval → exitDialog).
This lifecycle is managed across **three separate layers** — C++ (`DrainToEvalResult`),
JS (`subsession.js`), and kernel-side (`Internal`AddHandler`) — with asynchronous
handoffs between them. The resulting race conditions cause **permanent deadlocks** that
no amount of JS-side timeout/recovery can reliably fix.

### 1.1 Observed Deadlock Patterns (all confirmed with scroll debug logs)

| # | Pattern | Root Cause |
|---|---------|-----------|
| A | `dispatched: false` spinning forever after abort | Multiple `abort()` calls send redundant `WSAbortMessage`; stale abort response corrupts next evaluation |
| B | `cND: 1` spinning, no dialog ever opens | Interrupt handler (`Internal`AddHandler`) destroyed by abort; `sub()` reinstall stuck behind busy kernel |
| C | `_renderingActive` stuck true | Dynamic loop interrupts VsCodeRender `evaluate()` → Dialog opens mid-render → exitDialog timeout → abort → `evaluate()` promise never resolves → `finally` block never clears the flag. **Fix: `rejectDialog: true` (§10)** |
| D | BEGINDLGPKT arrives after RETURNPKT | Interrupt sent just as cell completes → kernel enters Dialog[] → BEGINDLGPKT sits unread in link buffer → next evaluation's `DrainToEvalResult` encounters stale dialog |
| E | `exitDialog()` rejects with "no dialog subsession is open" | The kernel-side Dialog[] is open but `dialogOpen_` was cleared by a previous `closeAllDialogs()` or `abort()` |

### 1.2 Why JS-Side Recovery Cannot Work

The recovery mechanisms (timers, abort escalation, force-clear flags) suffer from a fundamental problem: they use the same fragile primitives (interrupt, abort, sub, exitDialog) that caused the deadlock. Recovery actions often create secondary deadlocks:

- **Abort during recovery** → destroys interrupt handler → subsequent interrupts produce no Dialog
- **Multiple recovery loops firing simultaneously** → multiple `abort()` calls → stale abort responses
- **`sub()` for handler reinstall** → goes to `subIdleQueue_` which only runs when `busy_=false` → if the next cell already started, `busy_=true` and the reinstall never executes in time
- **`exitDialog()` fails** → `dialogOpen_` was already cleared by `abort()` / `closeAllDialogs()` even though the kernel is still in Dialog[]

The root cause is **the JS ↔ C++ ↔ kernel roundtrip**: JS sends interrupt, C++ forwards it, kernel opens Dialog, C++ sets `dialogOpen_=true`, JS detects it, JS calls `dialogEval()`, C++ sends expression, kernel evaluates, C++ returns result, JS calls `exitDialog()`, C++ sends `Return[$Failed]`, kernel resumes. Any timing slip in this 8-step chain causes a deadlock.

---

## 2. Proposed Solution: C++-Internal Dynamic Evaluation

**Move the entire interrupt → Dialog → evaluate → exitDialog lifecycle into the C++ drain loop.** JS registers Dynamic expressions and polls results. The C++ layer handles all timing, races, and recovery atomically within the existing `DrainToEvalResult` thread.

### 2.1 Design Principles

1. **Zero JS roundtrips during dialog** — When `BEGINDLGPKT` arrives, C++ evaluates all registered Dynamic expressions and closes the dialog, all within the same `DrainToEvalResult` call. No NAPI callback, no JS event loop involvement.

2. **Interrupt sending from C++** — A timer within the C++ layer sends `WSInterruptMessage` at a configurable interval. No JS-side interrupt logic needed.

3. **Stale packet immunity** — After every RETURNPKT, drain remaining packets from the link buffer. Unexpected BEGINDLGPKT packets are handled by auto-closing the dialog (after evaluating registered Dynamic expressions, if any).

4. **Abort deduplication** — `abort()` is a no-op if `abortFlag_` is already set. Prevents multiple WSAbortMessage from corrupting the link.

5. **Handler resilience** — The interrupt handler (`Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]`) is reinstalled automatically by the C++ layer at the start of every `evaluate()`, not by JS.

---

## 3. New API Surface

### 3.1 `registerDynamic(id: string, expr: string): void`

Register a Dynamic expression for periodic evaluation during computations.

```typescript
session.registerDynamic('slot-0', 'ToString[AbsoluteTime[], InputForm]');
session.registerDynamic('slot-1', 'ToString[myVar, InputForm]');
```

- **id**: Unique identifier for the expression (used to retrieve results)
- **expr**: Wolfram Language expression string. Must return a string (use `ToString[..., InputForm]`)
- Replaces any existing registration with the same `id`
- Thread-safe (uses `std::mutex`)

### 3.2 `unregisterDynamic(id: string): void`

Remove a Dynamic expression from the registry.

```typescript
session.unregisterDynamic('slot-0');
```

- If `id` is not registered, no-op
- Thread-safe

### 3.3 `clearDynamicRegistry(): void`

Remove all registered Dynamic expressions.

```typescript
session.clearDynamicRegistry();
```

### 3.4 `getDynamicResults(): Record<string, DynResult>`

Poll for new Dynamic evaluation results. Returns all results accumulated since the last call and clears the internal buffer.

```typescript
interface DynResult {
    value: string;       // result string from kernel
    timestamp: number;   // ms since epoch when this was evaluated
    error?: string;      // set if evaluation failed (e.g. syntax error)
}

const results = session.getDynamicResults();
// results: { 'slot-0': { value: '3964185.123456', timestamp: 1742018509000 },
//            'slot-1': { value: '"Hello"', timestamp: 1742018509000 } }
```

- Returns `{}` if no new results available
- Thread-safe (swaps internal buffer)
- Non-blocking — never waits for the kernel

### 3.5 `setDynamicInterval(ms: number): void`

Set the interval (in milliseconds) between Dynamic interrupt attempts. The C++ layer sends `WSInterruptMessage` at this interval only when:
- `busy_ == true` (kernel is computing)
- `dynamicRegistry_` is non-empty
- No dialog is currently being serviced
- At least `ms` milliseconds have elapsed since the last successful dialog evaluation

```typescript
session.setDynamicInterval(500); // interrupt every 500ms
```

- Default: `0` (disabled — no automatic interrupts)
- Set to `0` to disable automatic interrupts
- Thread-safe

### 3.6 `readonly dynamicActive: boolean` (accessor)

True if the Dynamic registry is non-empty and the interval is > 0.

---

## 4. C++ Implementation Details

### 4.1 New Data Structures

```cpp
// In WstpSession private members:

struct DynRegistration {
    std::string id;
    std::string expr;
};

struct DynResult {
    std::string id;
    std::string value;
    double      timestamp;   // ms since epoch
    std::string error;       // empty if success
};

std::mutex                          dynMutex_;
std::vector<DynRegistration>        dynRegistry_;     // registered exprs
std::vector<DynResult>              dynResults_;      // accumulated results (swap on getDynamicResults)
std::atomic<int>                    dynIntervalMs_{0};
std::chrono::steady_clock::time_point dynLastEval_;   // last successful dialog eval time
```

### 4.2 Changes to `DrainToEvalResult`

#### 4.2.1 BEGINDLGPKT handler — replace JS callback with inline evaluation

**Current behavior (lines 714–832):** Sets `dialogOpen_=true`, fires `onDialogBegin` NAPI callback, enters WSReady polling loop waiting for JS to call `dialogEval()` / `exitDialog()`.

**New behavior:**

```cpp
case BEGINDLGPKT: {
    wsint64 level = 0;
    if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &level);
    WSNewPacket(lp);

    if (opts && opts->dialogOpen)
        opts->dialogOpen->store(true);

    // ---- NEW: C++-internal Dynamic evaluation ----
    // Evaluate all registered Dynamic expressions inside the Dialog level.
    // This replaces the JS dialogEval() roundtrip entirely.
    {
        std::lock_guard<std::mutex> lk(dynMutex_);
        for (const auto& reg : dynRegistry_) {
            // Send expression via EnterTextPacket
            WSPutFunction(lp, "EnterTextPacket", 1);
            WSPutUTF8String(lp, reinterpret_cast<const unsigned char*>(reg.expr.c_str()),
                            static_cast<int>(reg.expr.size()));
            WSEndPacket(lp);
            WSFlush(lp);

            // Read result (with timeout)
            DynResult dr;
            dr.id = reg.id;
            dr.timestamp = /* current time in ms */;
            if (!readDynResultWithTimeout(lp, dr, /*timeoutMs=*/2000)) {
                dr.error = "timeout evaluating Dynamic expression";
            }
            dynResults_.push_back(std::move(dr));
        }
        dynLastEval_ = std::chrono::steady_clock::now();
    }

    // ---- Close the dialog ----
    WSPutFunction(lp, "EnterTextPacket", 1);
    WSPutUTF8String(lp, reinterpret_cast<const unsigned char*>("Return[$Failed]"), 16);
    WSEndPacket(lp);
    WSFlush(lp);

    // Wait for ENDDLGPKT (with timeout)
    bool exitOk = drainUntilEndDialog(lp, /*timeoutMs=*/3000);

    if (opts && opts->dialogOpen)
        opts->dialogOpen->store(false);

    if (!exitOk) {
        // Dialog didn't close in time — fall back to abort
        r.aborted = true;
        r.result = WExpr::mkSymbol("System`$Aborted");
        drainDialogAbortResponse(lp);
        return r;
    }

    // Continue outer loop — the original RETURNPKT is still expected.
    break;
}
```

#### 4.2.2 Backward Compatibility — Debugger Dialog Path

The debugger uses `dialogEval()` and `exitDialog()` for interactive step-through debugging.
This path is **separate** from Dynamic evaluation and must be preserved.

**Approach:** Add a flag `dynAutoMode_` (default: `false`). When `true`, BEGINDLGPKT is handled
inline as above. When `false`, the current JS-callback path is used (required for Dialog[]
interactivity — `dynAutoMode_{true}` breaks 11 existing tests).

> **v0.6.2 implementation note:** The default was changed from `true` (spec) to `false`
> (implementation) to preserve Dialog[] interactivity for the full test suite. See
> `WSTP_0.6.1_BUGS.md` for details.

```cpp
std::atomic<bool> dynAutoMode_{false}; // default false preserves Dialog[] interactivity

// In BEGINDLGPKT handler:
if (dynAutoMode_.load()) {
    // New: inline Dynamic eval + auto-close
} else {
    // Legacy: fire onDialogBegin, enter WSReady polling loop for JS dialogEval/exitDialog
}
```

The debugger calls `session.setDynAutoMode(false)` before starting a debug session and
`session.setDynAutoMode(true)` when the debug session ends.

```typescript
setDynAutoMode(auto: boolean): void
```

#### 4.2.3 Post-RETURNPKT Stale Packet Drain

After receiving `RETURNPKT` and before breaking out of the drain loop, check for and
consume any stale packets remaining in the link buffer:

```cpp
case RETURNPKT: {
    r.result = ReadExprRaw(lp);
    WSNewPacket(lp);
    if (stripCtx(r.result.strVal) == "$Aborted") r.aborted = true;

    // ---- NEW: drain stale packets ----
    // An interrupt sent just before RETURNPKT may have opened a Dialog
    // that we haven't seen yet. Check and consume it.
    drainStalePackets(lp, opts);

    break;  // exit drain loop
}
```

```cpp
// New helper: drain any packets that arrived after RETURNPKT
static void drainStalePackets(WSLINK lp, EvalOptions* opts) {
    // Wait briefly for any packet the kernel may have queued
    // after sending RETURNPKT (e.g. late BEGINDLGPKT from interrupt).
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            continue;
        }
        int pkt = WSNextPacket(lp);
        if (pkt == BEGINDLGPKT) {
            // Stale dialog from a late interrupt — auto-close it.
            wsint64 level = 0;
            if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &level);
            WSNewPacket(lp);

            // Optionally evaluate Dynamic expressions before closing
            if (opts) {
                // ... same inline evaluation as 4.2.1 ...
            }

            // Close dialog
            WSPutFunction(lp, "EnterTextPacket", 1);
            WSPutUTF8String(lp, (const unsigned char*)"Return[$Failed]", 16);
            WSEndPacket(lp); WSFlush(lp);
            drainUntilEndDialog(lp, 3000);
        }
        else if (pkt == MENUPKT) {
            // Stale interrupt menu — auto-respond to dismiss it
            WSNewPacket(lp);
            WSPutFunction(lp, "EnterTextPacket", 1);
            WSPutUTF8String(lp, (const unsigned char*)"", 0);
            WSEndPacket(lp); WSFlush(lp);
        }
        else {
            WSNewPacket(lp);  // discard any other stale packet
        }
    }
}
```

### 4.3 Automatic Interrupt Timer

When `dynIntervalMs_ > 0` and `dynRegistry_` is non-empty, a background mechanism sends
`WSInterruptMessage` at the configured interval.

**Implementation options:**

**Option A — Timer thread** (simplest):
```cpp
std::thread dynTimerThread_;  // started when dynIntervalMs_ changes from 0

void dynTimerLoop() {
    while (open_ && dynIntervalMs_.load() > 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(dynIntervalMs_.load()));

        if (!busy_.load()) continue;              // kernel idle — nothing to interrupt
        if (dynRegistry_.empty()) continue;       // no Dynamic exprs registered
        if (dialogOpen_.load()) continue;         // dialog already open
        if (workerReadingLink_.load()) {
            // Worker is in DrainToEvalResult — safe to interrupt
            WSPutMessage(lp_, WSInterruptMessage);
        }
    }
}
```

**Option B — Piggyback on WSReady loop** (no extra thread):
Instead of a timer thread, check the elapsed time in the existing `BEGINDLGPKT` / dialog
polling or in the drain loop itself. However option A is cleaner.

### 4.4 Abort Deduplication

Prevent multiple `abort()` calls from sending redundant `WSAbortMessage`:

```cpp
Napi::Value Abort(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!open_) return Napi::Boolean::New(env, false);
    if (!busy_.load()) return Napi::Boolean::New(env, false);

    // NEW: deduplicate — if abort already in flight, just return true
    bool expected = false;
    if (!abortFlag_.compare_exchange_strong(expected, true)) {
        return Napi::Boolean::New(env, true);  // already aborting
    }

    FlushDialogQueueWithError("abort");
    dialogOpen_.store(false);
    int ok = WSPutMessage(lp_, WSAbortMessage);
    return Napi::Boolean::New(env, ok != 0);
}
```

### 4.5 Automatic Handler Installation

At the start of every `EvaluateWorker::Execute()`, before sending the user expression,
install the interrupt handler. This eliminates the need for JS to do handler reinstall:

```cpp
void Execute() override {
    // ---- NEW: ensure interrupt handler is always installed ----
    if (!dynRegistry_.empty() || dynAutoMode_.load()) {
        WSPutFunction(lp_, "EvaluatePacket", 1);
        WSPutFunction(lp_, "ToExpression", 1);
        WSPutUTF8String(lp_, (const unsigned char*)
            "Quiet[Internal`AddHandler[\"Interrupt\", Function[Null, Dialog[]]]]",
            /* len */ 68);
        WSEndPacket(lp_); WSFlush(lp_);

        // Drain the handler-install RETURNPKT (result is Null, discard)
        EvalResult discard = DrainToEvalResult(lp_, &opts_);
        // If this itself was aborted, the handler wasn't installed — ok, DrainToEvalResult
        // will handle stale dialog gracefully.
    }

    // Original code — send user expression
    bool sent;
    if (!interactive_) {
        sent = WSPutFunction(lp_, "EvaluatePacket", 1) && ...
    }
    ...
}
```

### 4.6 New Helper: `readDynResultWithTimeout`

Reads a single Dialog-level evaluation result with a timeout:

```cpp
static bool readDynResultWithTimeout(WSLINK lp, DynResult& dr, int timeoutMs) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }
        int pkt = WSNextPacket(lp);
        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT || pkt == RETURNTEXTPKT) {
            const char* s = nullptr;
            if (pkt == RETURNTEXTPKT) {
                WSGetString(lp, &s);
                if (s) { dr.value = s; WSReleaseString(lp, s); }
            } else {
                WExpr val = ReadExprRaw(lp);
                dr.value = val.strVal;  // or serialize appropriately
            }
            WSNewPacket(lp);
            return true;
        }
        if (pkt == TEXTPKT || pkt == MESSAGEPKT || pkt == OUTPUTNAMEPKT || pkt == INPUTNAMEPKT) {
            WSNewPacket(lp);  // discard intermediate packets
            continue;
        }
        if (pkt == 0 || pkt == ILLEGALPKT) {
            WSClearError(lp);
            dr.error = "WSTP link error during Dynamic eval";
            return false;
        }
        WSNewPacket(lp);
    }
    dr.error = "timeout";
    return false;
}
```

### 4.7 New Helper: `drainUntilEndDialog`

Reads packets until `ENDDLGPKT` is received (dialog closed):

```cpp
static bool drainUntilEndDialog(WSLINK lp, int timeoutMs) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }
        int pkt = WSNextPacket(lp);
        if (pkt == ENDDLGPKT) {
            WSNewPacket(lp);
            return true;
        }
        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT) {
            // Might be Return[$Failed] response — consume and check for ENDDLGPKT next
            WSNewPacket(lp);
            continue;
        }
        if (pkt == 0 || pkt == ILLEGALPKT) {
            WSClearError(lp);
            return false;
        }
        WSNewPacket(lp);  // discard
    }
    return false;  // timeout
}
```

---

## 5. JS-Side Simplification

### 5.1 New `subsession.js` Dynamic Loop (conceptual)

The entire `runLoop` function in `subsession.js` reduces to:

```javascript
const runLoop = async () => {
    // Register Dynamic expressions with C++
    for (const de of dynExprs) {
        self.session.registerDynamic(
            'cell-' + cellUri + '-slot-' + de.slotIndex,
            'ToString[' + de.dynInner + ', InputForm]'
        );
    }

    // Set interrupt interval (e.g. 500ms)
    self.session.setDynamicInterval(500);

    // Poll for results
    while (state.active && self._sessionEpoch === epoch) {
        const results = self.session.getDynamicResults();

        // Update cell outputs with new results
        for (const de of dynExprs) {
            const key = 'cell-' + cellUri + '-slot-' + de.slotIndex;
            if (results[key]) {
                htmlBySlot[de.slotIndex] = renderToHtml(results[key].value);
            }
        }

        if (Object.keys(results).length > 0) {
            await _putAllOutputs(htmlBySlot, 'live');
        }

        // Check expiry limits
        // ... (same as current)

        await new Promise(r => setTimeout(r, 200));  // poll interval
    }

    // Cleanup
    for (const de of dynExprs) {
        self.session.unregisterDynamic('cell-' + cellUri + '-slot-' + de.slotIndex);
    }
    if (self.session.getDynamicResults && !self._dynamicWidgets?.size) {
        self.session.setDynamicInterval(0);
    }
};
```

### 5.2 What Gets Deleted from `subsession.js`

All of these become unnecessary:

- `_consecutiveNoDialog` tracking and `_cndSkipCycles` retry logic
- `_notDispatchedSince` timer and recovery
- `_renderingActiveSince` timer and recovery
- `_firstNoDialogTime` abort escalation
- `_staleDialogCycles` counter
- `_handlerNeedsReinstall` / `_reinstallPromise` / handler reinstall via `sub()`
- The `_dynIdleMutex` serialization (no mutex needed — C++ handles serialization)
- All `dialogEval()` calls
- All `exitDialog()` calls (from Dynamic path)
- All `closeAllDialogs()` calls (from Dynamic path)
- All `abort()` calls for recovery
- The `interrupt()` call (C++ handles this)
- The stale dialog detection / deferred-dialog exitDialog logic
- The render-dialog workaround

### 5.3 What Gets Deleted from `checkout.js`

- Handler reinstall `evaluate()` at cell start (C++ does this automatically)
- `_evalDispatched` flag management (no longer needed — C++ doesn't care about JS dispatch state)

---

## 6. Edge Cases and Handling

### 6.1 Interrupt During Non-Interruptible Code

When the kernel is in `Pause[]`, C-level code, or `LinkRead`, `WSInterruptMessage` is
received but `Dialog[]` may not open. The C++ timer simply sends the interrupt; if
`BEGINDLGPKT` doesn't appear during the drain loop's packet reading, nothing happens.
The next interrupt attempt will try again. No special tracking needed.

### 6.2 Cell Completion During Dialog Evaluation

If the main evaluation finishes (RETURNPKT) while Dynamic expressions are being
evaluated inside the dialog, the sequence is:
1. Dynamic expr evaluation completes → RETURNPKT inside dialog
2. `Return[$Failed]` sent → ENDDLGPKT
3. Continue drain → outer RETURNPKT for the main cell

This is handled naturally by the nested drain.

### 6.3 Abort During Dynamic Evaluation

If `abort()` is called while Dynamic expressions are being evaluated inside the dialog:
1. `abortFlag_` is set
2. `DrainToEvalResult` checks `abortFlag_` at the top of the dialog loop
3. Calls `drainDialogAbortResponse()` to clean the link
4. Returns `$Aborted`

Same as current behavior, but now the dialog eval is C++-internal so there's no JS
callback that might race with the abort.

### 6.4 Debugger Dialog Coexistence

The debugger uses Dialog[] for step-through debugging. When a debug session is active:
1. `session.setDynAutoMode(false)` — reverts to legacy JS-callback dialog path
2. `session.setDynamicInterval(0)` — disables automatic interrupts
3. The debugger manages Dialog[] via `dialogEval()` / `exitDialog()` as before
4. When the debug session ends, `session.setDynAutoMode(true)` re-enables auto mode

### 6.5 Multiple Dynamic Cells

Multiple cells may have active Dynamic widgets simultaneously. Each registers its own
expressions with unique IDs. The C++ layer evaluates ALL registered expressions in a
single Dialog session, returning results for all of them at once. This is more efficient
than the current approach (one interrupt per widget per cycle).

### 6.6 Long-Running Dynamic Expressions

If a Dynamic expression takes too long (> 2s timeout in `readDynResultWithTimeout`),
the C++ layer:
1. Records an error result for that expression
2. Continues with the next expression
3. Sends `Return[$Failed]` to close the dialog
4. The JS poll sees the error and can display a warning

### 6.7 Stale BEGINDLGPKT After RETURNPKT

Handled by `drainStalePackets()` (Section 4.2.3). After every RETURNPKT:
1. Check `WSReady()` for 50ms
2. If BEGINDLGPKT found → evaluate registered Dynamics → auto-close dialog
3. If MENUPKT found → auto-dismiss
4. If nothing found within 50ms → safe to proceed

---

## 7. Test Plan

### 7.1 Unit Tests (C++ level — addon_test.cc or node test harness)

```
Test 1: registerDynamic + getDynamicResults basic flow
  - Register expr "ToString[1+1]"
  - Evaluate a long-running cell: Do[Pause[0.1], {i, 100}]
  - setDynamicInterval(200)
  - Poll getDynamicResults() — expect at least 3 results with value "2"
  - unregisterDynamic
  - Verify getDynamicResults() returns {} after unregister

Test 2: Multiple registered expressions
  - Register "ToString[1]" as "a", "ToString[2]" as "b", "ToString[3]" as "c"
  - Run long cell with setDynamicInterval(300)
  - getDynamicResults() should contain all three keys with correct values

Test 3: Stale BEGINDLGPKT handling
  - Register a Dynamic expr
  - setDynamicInterval(50) (very fast)
  - Evaluate: Do[Pause[0.01], {i, 100}]
  - The fast interval ensures some interrupts arrive just as the cell completes
  - Next evaluate("1+1") must succeed (no stale packets corrupt it)
  - Repeat 20 times to stress-test

Test 4: Abort during Dynamic evaluation
  - Register a slow Dynamic: "ToString[Pause[5]; 1]"
  - Start long cell, setDynamicInterval(200)
  - Call abort() while Dynamic eval is in flight
  - Verify: cell is aborted, no deadlock, next evaluate works

Test 5: Abort deduplication
  - Start long cell
  - Call abort() three times in rapid succession
  - Verify: only one WSAbortMessage sent (first sets abortFlag_, others are no-op)
  - Next evaluate works normally

Test 6: Handler auto-reinstall after abort
  - Register Dynamic expr
  - Evaluate long cell
  - Call abort()
  - Evaluate another long cell
  - Verify: Dynamic evaluations resume (handler was auto-reinstalled by Execute())

Test 7: Rapid cell transitions
  - Register Dynamic expr, setDynamicInterval(100)
  - Evaluate 10 short cells in sequence: evaluate("1+1"), evaluate("2+2"), ...
  - Verify: no deadlocks, all cells complete, Dynamic results accumulated

Test 8: Empty registry
  - setDynamicInterval(200) but don't register any exprs
  - Evaluate long cell
  - Verify: no interrupts sent, cell completes normally

Test 9: dynAutoMode toggle (debugger coexistence)
  - setDynAutoMode(false)
  - Verify: BEGINDLGPKT uses legacy JS-callback path (dialogEval/exitDialog work)
  - setDynAutoMode(true)
  - Verify: BEGINDLGPKT uses C++-internal path again

Test 10: Cell completes during interrupt
  - Register Dynamic expr, setDynamicInterval(50)
  - Evaluate: Pause[0.05]; "done"
  - The cell is so short that interrupts arrive after RETURNPKT
  - Verify: stale dialog drained, next evaluate works, Dynamic results may or may not appear (both ok)
```

### 7.2 Integration Tests (JS level — test harness with real kernel)

```
Test I1: Dynamic[AbsoluteTime[]] + multiple cells
  - Create a cell: n=10; Dynamic[AbsoluteTime[]]; Sqrt[n+1]; Range[1000]; Plot[Sin[x],{x,0,10}]
  - Evaluate it
  - Immediately evaluate 10 more simple cells (1+1, 2+2, etc.)
  - Verify: all cells complete, Dynamic output updates at least 3 times, no stuck spinner

Test I2: Dynamic + Pause (non-interruptible)
  - Cell: Dynamic[n]; Do[Pause[0.5], {n, 1, 20}]
  - Verify: Dynamic updates appear periodically, cell completes, no recovery messages

Test I3: Dynamic + long computation
  - Cell: Dynamic[n]; Do[n = PrimePi[10^6], {100}]
  - Verify: Dynamic shows changing n values, completes without abort

Test I4: Multiple Dynamic cells
  - Cell A: Dynamic[AbsoluteTime[]]
  - Cell B: Dynamic[RandomReal[]]
  - Evaluate both, then run more cells
  - Verify: both update, both survive cell transitions

Test I5: Stress test — rapid Run All
  - Notebook with 30 cells, one of which has Dynamic[AbsoluteTime[]]
  - Run All Cells
  - Verify: no deadlocks, all cells complete, Dynamic updates appear
```

### 7.3 Regression Tests

```
Test R1: Debugger step-through still works
  - Start debug session → setDynAutoMode(false)
  - Step through Do loop
  - Verify: Dialog-based debugging works as before

Test R2: User abort (Cmd+.) works
  - Evaluate long cell, press Cmd+.
  - Verify: cell aborted, kernel responsive for next cell

Test R3: Kernel restart
  - Register Dynamic, start long eval
  - Restart kernel
  - Verify: stale registrations cleared, no errors
```

---

## 8. Migration Path

### Phase 1 (Minimal, Non-Breaking)

Implement only:
- **4.4 Abort deduplication** — single `compare_exchange_strong` in `Abort()`
- **4.2.3 Post-RETURNPKT stale packet drain** — `drainStalePackets()` after RETURNPKT
- **4.5 Auto handler install** — in `Execute()` before user expression

These three changes alone eliminate patterns A, B, and D from Section 1.1 without
changing any API surface. JS-side recovery code can be removed incrementally.

### Phase 2 (New API)

Implement:
- **3.1–3.5** New API methods
- **4.2.1** C++-internal Dynamic evaluation in BEGINDLGPKT handler
- **4.3** Automatic interrupt timer

This replaces the JS Dynamic loop with a simple register/poll interface and eliminates
patterns C and E.

### Phase 3 (Cleanup)

Remove from JS:
- All recovery timers and mechanisms from `subsession.js`
- Handler reinstall from `checkout.js`
- Interrupt sending from JS
- `_consecutiveNoDialog`, `_notDispatchedSince`, `_renderingActiveSince`, etc.

---

## 9. Summary of Changes

| Component | Current | Proposed |
|-----------|---------|----------|
| Interrupt sending | JS (`self.session.interrupt()`) | C++ timer thread |
| Dialog open detection | C++ sets flag → JS polls `isDialogOpen` | C++ handles inline |
| Dialog evaluation | JS calls `dialogEval()` (NAPI roundtrip) | C++ evaluates inline in drain loop |
| Dialog close | JS calls `exitDialog()` (NAPI roundtrip) | C++ sends `Return[$Failed]` inline |
| Handler reinstall | JS `evaluate()` or `sub()` | C++ auto-installs in `Execute()` |
| Stale packet handling | None (root cause of deadlocks) | `drainStalePackets()` after RETURNPKT |
| Abort dedup | None (multiple abort = corruption) | `compare_exchange_strong` |
| Non-interactive dialog guard | JS timer (`_renderingActiveSince`) | `rejectDialog: true` option (§10) |
| Recovery mechanisms | 6+ timers, abort escalation, force-clear | None needed |
| JS complexity | ~500 lines of race-handling code | ~50 lines of register/poll |

---

## 10. `rejectDialog` Option for Non-Interactive Evaluations

### 10.1 Problem

Non-interactive `evaluate()` calls — VsCodeRender (SVG export), interrupt handler
install, `VsCodeSetImgDir`, and `sub()` expressions — must never open a Dialog.
However, a concurrent Dynamic interrupt can arrive just as one of these evaluations
starts, causing the kernel to emit `BEGINDLGPKT` mid-call. The current
`DrainToEvalResult` enters the full dialog-servicing loop, awaiting JS `dialogEval()`
calls that never come because the JS side believes no dialog is open. This causes:

- **Pattern C** (`_renderingActive` stuck): VsCodeRender's `evaluate()` hangs inside
  the dialog loop → the `finally` block never runs → `_renderingActive` stays `true`
  forever → every subsequent Dynamic cycle skips interrupt → Dynamic freezes.
- **Handler reinstall hangs**: handler install `evaluate()` blocks in dialog loop →
  `_handlerNeedsReinstall` stays true → Dynamic loop can never fire again.

The JS workaround (`_renderingActiveSince` 30s timer) only masks the symptom and fires
too late to be useful in practice.

### 10.2 Proposed API Change

Add a `rejectDialog` option to `evaluate()`:

```typescript
// Existing evaluate() options (EvaluateOptions in index.d.ts)
interface EvaluateOptions {
    interactive?: boolean;   // existing
    // ... existing options ...
    rejectDialog?: boolean;  // NEW
}

// Usage:
await session.evaluate(
    'VsCodeRender[...]',
    { interactive: false, rejectDialog: true }
);
```

When `rejectDialog: true`, any `BEGINDLGPKT` received during the drain loop is
**immediately auto-closed** by sending `Return[$Failed]` and waiting for `ENDDLGPKT`,
then continuing the drain loop to collect the main `RETURNPKT`. The `evaluate()`
promise resolves normally (with whatever result the kernel produces for the
non-dialog part of the expression).

### 10.3 C++ Implementation

Add `rejectDialog` to `EvalOptions`:

```cpp
// In EvalOptions struct (around line 119 in addon.cc):
struct EvalOptions {
    bool interactive     = false;
    bool rejectDialog    = false;  // NEW: auto-close any BEGINDLGPKT immediately
    // ... existing fields ...
};
```

In `DrainToEvalResult`, the `BEGINDLGPKT` handler gains a fast early-exit branch:

```cpp
// Inside the BEGINDLGPKT case (currently at line 714):
if (opts && opts->rejectDialog) {
    // Non-interactive eval — auto-close dialog without touching dialogOpen_ state.
    // Read and discard the level integer:
    if (WSGetType(lp) == WSTKINT) {
        wsint64 lvl = 0;
        WSGetInteger64(lp, &lvl);
    }
    WSNewPacket(lp);

    // Send Return[$Failed] to close the dialog level:
    WSPutFunction(lp, "EnterTextPacket", 1);
    const char* closeExpr = "Return[$Failed]";
    WSPutUTF8String(lp,
        reinterpret_cast<const unsigned char*>(closeExpr),
        static_cast<int>(std::strlen(closeExpr)));
    WSEndPacket(lp);
    WSFlush(lp);

    // Drain until ENDDLGPKT (2s timeout):
    drainUntilEndDialog(lp, 2000);

    // Continue outer drain loop — the original RETURNPKT is still coming.
    continue;
}
// ... existing interactive dialog handling below ...
```

### 10.4 Effect on dialogOpen_

`rejectDialog` must **not** set `dialogOpen_=true`. The dialog is opened and closed
entirely within the C++ drain loop; the JS layer never learns it happened.
This is safe because:
- The JS side already cannot call `dialogEval()` or `exitDialog()` (it doesn't know
  the dialog exists)
- The Dynamic widget loop is not affected — it sees `isDialogOpen=false` throughout
- The debugger is not involved (debugger sessions use `interactive=true` evals which
  necessarily have `rejectDialog=false`)

### 10.5 Interaction With C++-Internal Dynamic Evaluation (Section 4)

When the Phase 2 C++-internal Dynamic evaluation is implemented, `rejectDialog` no
longer applies to the main `evaluate()` call (since `BEGINDLGPKT` is handled inside
the new inline path). However, it **still applies** to non-interactive `sub()`
expressions and to the internal handler-install evaluation that `Execute()` performs.
Those paths remain non-interactive and should still auto-close any stale dialog.

Until Phase 2 is complete, `rejectDialog` in Phase 1 provides immediate relief for
Pattern C without requiring any other changes.

### 10.6 JS-Side Changes When rejectDialog Is Implemented

All non-interactive calls in `checkout.js` and `subsession.js` that are currently
guarded by `_renderingActive` or wrapped in timeout recovery gain `rejectDialog: true`:

```javascript
// checkout.js — VsCodeRender
// Before:
await self.session.evaluate('VsCodeRender[...]', { interactive: false });

// After:
await self.session.evaluate('VsCodeRender[...]', { interactive: false, rejectDialog: true });

// checkout.js — interrupt handler install
await self.session.evaluate(
    'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]',
    { interactive: false, rejectDialog: true }
);

// checkout.js — VsCodeSetImgDir
await self.session.evaluate(
    'VsCodeSetImgDir[...]',
    { interactive: false, rejectDialog: true }
);
```

With these changes:
- `_renderingActive` flag and its 30s recovery timer can be **deleted**
- `_handlerNeedsReinstall` and its 5s timeout can be **deleted**
- The `render-dialog` special case in `subsession.js` (exitDialog when dialog opens
  inside VsCodeRender) can be **deleted**

### 10.7 Tests

```
Test RD1: VsCodeRender + concurrent interrupt
  - Register a Dynamic expr, setDynamicInterval(50) (very frequent)
  - Evaluate a cell with a plot (triggers VsCodeRender)
  - The fast interrupt should cause BEGINDLGPKT to arrive during VsCodeRender eval
  - Verify: VsCodeRender evaluate() resolves normally (no hang)
  - Verify: _renderingActive is cleared (or not needed)
  - Verify: cell output contains the plot
  - Repeat 20 times

Test RD2: Handler install + concurrent interrupt
  - Configure checkout.js to use rejectDialog:true for handler install
  - Start a cell with Dynamic + setDynamicInterval(50)
  - Evaluate many cells in sequence
  - Verify: handler is always installed, Dynamic continues to update
  - No _handlerNeedsReinstall timeouts in logs

Test RD3: rejectDialog does not affect interactive evals
  - Evaluate an interactive cell that spawns Dialog[] legitimately
  - (e.g. debugger step-through, or explicit Dialog[] call)
  - Verify: dialog handling works normally (rejectDialog:false by default)

Test RD4: Back-to-back dialog close + main RETURNPKT
  - For evaluate({ rejectDialog: true }): simulate BEGINDLGPKT followed by
    ENDDLGPKT followed by RETURNPKT[42]
  - Verify: result is 42 (main RETURNPKT correctly consumed after dialog close)

Test RD5: Two stale dialogs in one non-interactive eval
  - Simulate two BEGINDLGPKT packets before the main RETURNPKT
  - (Possible if two interrupts fire in quick succession)
  - Verify: both dialogs are closed, main RETURNPKT consumed, result correct
```
