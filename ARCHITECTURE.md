# Architecture

This document describes the purpose of each source file in `src/` after the v0.7.0 refactor (previously everything lived in a single 3 564-line `addon.cc`).

## Source file map

| File | Role |
|------|------|
| `addon.cc` | **Thin entry point.** Registers `WstpSession`, `WstpReader`, and `setDiagHandler` with the Node.js module system via `NODE_API_MODULE`. Contains nothing else. |
| `types.h` | **Shared data structures.** Plain C++ structs used across multiple modules: `WExpr` (expression tree node), `EvalResult`, `EvalOptions`, `CompleteCtx`, `DialogRequest`, `DynRegistration`, `DynResult`, `AutoExprEntry`, `AutoResultEntry`. No logic, only layout. |
| `diag.h` / `diag.cc` | **Diagnostic logging channel.** Global `g_diagTsfn` ThreadSafeFunction and its mutex/flag; `diagMs()` (milliseconds since process start); `DiagLog(msg)` which timestamps and dispatches to the JS handler set by `setDiagHandler()`. |
| `wstp_expr.h` / `wstp_expr.cc` | **WSTP expression I/O.** Three free functions: `ReadExprRaw(lp)` — reads one expression from the link and returns a `WExpr` tree; `WExprToNapi(env, expr)` — converts a `WExpr` tree to a JavaScript value; `EvalResultToNapi(env, result)` — converts a full `EvalResult` to the JS object returned to callers. |
| `drain.h` / `drain.cc` | **Packet-draining helpers and main evaluation drain loop.** Five free functions: `drainDialogAbortResponse` (send ReturnPacket Null into a dialog then drain ENDDLGPKT), `drainStalePackets` (discard stale packets before a new eval), `drainUntilEndDialog` (consume all packets until ENDDLGPKT), `readDynResultWithTimeout` (read a single result inside a dialog with 5-second timeout), and the central `DrainToEvalResult(lp, opts)` which drives the full evaluation loop: handles TextPacket (Print), MessagePacket, BeginDialogPacket, dynamic evaluation (via ScheduledTask / BEGINDLGPKT), abort, and assembles the final `EvalResult`. |
| `evaluate_worker.h` / `evaluate_worker.cc` | **Async evaluation worker.** `EvaluateWorker` is a `Napi::AsyncWorker` subclass. `Execute()` runs on the libuv thread pool: (1) pre-drains stale packets; (2) installs/reinstalls the ScheduledTask if needed — the install expression keeps `$wstpDynTaskStop=True` so the task starts suppressed and cannot open a Dialog[] race before the main eval starts; (3) prepends `$wstpDynTaskStop=.` (main eval) or `$wstpDynTaskStop=True` (rejectDialog) to the expression; (4) sends the packet and calls `DrainToEvalResult`. `OnOK()` and `OnError()` convert and resolve/reject the Promise on the main thread. |
| `wstp_session.h` / `wstp_session.cc` | **Main kernel session class.** `WstpSession` wraps a `WSEnvironment`+`WSLINK` pair. It exposes the full JS API: `evaluate`, `sub`, `subWhenIdle`, `subAuto`, `dialogEval`, `exitDialog`, `interrupt`, `abort`, `closeAllDialogs`, `createSubsession`, `close`, `registerDynamic`, `unregisterDynamic`, `clearDynamicRegistry`, `getDynamicResults`, `setDynamicInterval`, `setDynAutoMode`, and accessors `isOpen`, `isDialogOpen`, `isReady`, `kernelPid`, `dynamicActive`. Internally it maintains an evaluation queue, a sub-idle queue, a when-idle queue, subAuto async deferred tracking, and a dynamic-polling timer thread. Constructor launches the kernel (up to 3 retries if `$Output` routing fails). `CleanUp()` signals abort, spins until the worker releases the link, then calls `WSClose`. `WhenIdleWorker` (internal struct inside `StartWhenIdleWorker`) uses a **two-phase execute**: Phase A drains all pending ScheduledTask Dialog[] packets from the link — entering each one via `EnterTextPacket` to stop the task and send `Return[$Failed]`, then waiting 400 ms of silence before proceeding; Phase B sends the actual `EvaluatePacket` on a guaranteed-clean link. This prevents the link-corruption bug where a task-fired `Dialog[]` would consume the `EvaluatePacket` as dialog input (see `archive/SCHEDULEDTASK_DIALOG_RACE_FIX.md`). |
| `wstp_reader.h` / `wstp_reader.cc` | **Connect-mode side-channel reader.** `WstpReader` opens a TCPIP connect-mode link to a `LinkName` created by the running kernel (`LinkCreate[]`). `ReadNextWorker` (an async worker used internally) activates the link on its first call (deferred from the constructor to avoid blocking the main thread), then spins on `WSGetType()` until data arrives and calls `ReadExprRaw`. The public JS API is `readNext() → Promise<ExprTree>`, `close()`, and `isOpen`. |

## Data flow overview

```
JS caller
   │
   ├─ evaluate(expr, opts) ──► WstpSession.queue_
   │                               │
   │              MaybeStartNext() │ (main thread)
   │                               ▼
   │                        EvaluateWorker
   │                        ┌─────────────────────────────────┐
   │                        │ Execute()  [thread pool]        │
   │                        │   WSPutFunction EvaluatePacket  │
   │                        │   DrainToEvalResult(lp, opts)   │
   │                        │     ← TextPacket  → onPrint CB  │
   │                        │     ← MessagePkt  → onMessage CB│
   │                        │     ← BeginDlgPkt → dialogQueue │
   │                        │     ← ReturnPkt   → result       │
   │                        └─────────────────────────────────┘
   │                        OnOK() [main thread]
   │                          EvalResultToNapi → Promise.resolve
   │
   ├─ subWhenIdle(expr) ──► WstpSession.whenIdleQueue_
   │                         (queued until evaluate queue is empty)
   │
   ├─ sub(expr) ──────────► WstpSession.subIdleQueue_
   │                         (queued, highest priority)
   │
   ├─ subAuto(expr) ──────► if idle: forwarded to whenIdleQueue_
   │                         if busy: autoExprQueue_ + dynTimer interrupt
   │
   ├─ registerDynamic ────► dynRegistry_ + dynTimer (background thread)
   │                         Timer interrupts kernel → BEGINDLGPKT channel
   │                         → dynResults_ populated
   │
   └─ new WstpReader(name) ──► ReadNextWorker (thread pool)
                               WSActivate + spin-poll WSGetType
                               → ReadExprRaw → Promise.resolve
```

## Threading model

- **Main thread (JS event loop):** all Napi calls, queue mutations, Promise resolution/rejection.
- **libuv thread pool:** `EvaluateWorker::Execute()`, `ReadNextWorker::Execute()`, `SubIdleWorker::Execute()`, `WhenIdleWorker::Execute()` — all blocking WSTP I/O.
- **Dynamic timer thread:** a single detached `std::thread` per session; sends `WSInterruptMessage` at the configured interval when dynamic registrations are active and the kernel is busy.
- **ThreadSafeFunctions (TSFNs):** used by `onPrint`, `onMessage`, `onDialogBegin`, `onDialogPrint`, `onDialogEnd`, `DiagLog`, and `subAuto` resolver to safely call back into the JS event loop from worker threads.

## ScheduledTask suppression protocol (`$wstpDynTaskStop`)

The ScheduledTask fires `Dialog[]` at a fixed interval to allow C++ to poll dynamic registrations.  Because the kernel's WSTP link is shared and the task can fire at any time, every packet-sending path must interlock correctly with the task:

| Path | What it sends | Effect on task |
|------|--------------|----------------|
| **EvaluateWorker install** | `Quiet[$wstpDynTaskStop=True; …RunScheduledTask[If[!TrueQ[$wstpDynTaskStop],Dialog[]],…]]` | Creates task in **suppressed** state; no Dialog fires while install is in flight |
| **EvaluateWorker main eval** | `$wstpDynTaskStop=.; <expr>` | Unsuppresses task; Dialog fires at next interval *during* eval (handled by `DrainToEvalResult` dynAutoMode path) |
| **EvaluateWorker rejectDialog eval** | `$wstpDynTaskStop=True; <expr>` | Keeps task suppressed; any Dialog that fires is instantly rejected |
| **WhenIdleWorker Phase A** | `EnterTextPacket` inside each open Dialog: `$wstpDynTaskStop=True; RemoveScheduledTask[…]; Return[$Failed]` | Stops task permanently; `dynTaskInstalledInterval_` reset to 0 so next EvaluateWorker reinstalls it |
| **WhenIdleWorker Phase B** | `EvaluatePacket` — the actual `subAuto`/`subWhenIdle` expression (no suppression prepend) | Sent on a clean link; no ScheduledTask active |

## Known bugs & fixes

### v0.7.1 — ScheduledTask Dialog[] consumes WhenIdleWorker EvaluatePacket (2026-03-22)

**Symptom:** Running three notebook cells in sequence — (1) `n=0; Dynamic[n]`, (2) `Do[n=k; Pause[1]; Print[n], {k,1,6}]; "done"` with `interactive:true`, (3) `1+1` — caused the kernel to permanently hang after cell 2 finished.

**Root cause (two interacting bugs):**

1. **WhenIdleWorker sent `EvaluatePacket` while Dialog[] was open.**  After cell 2 completed, the ScheduledTask was still running and fired `Dialog[]`.  `WhenIdleWorker` sent `drainStalePackets(lp, nullptr)` (which closed *one* Dialog) but a second Dialog could fire in the ~160 ms between the drain completing and the `EvaluatePacket` being sent.  The kernel's Dialog input loop consumed the `EvaluatePacket` as dialog input, leaving the link in an undefined state.  Every subsequent `evaluate()` call hung permanently.

2. **`DrainToEvalResult(lp, nullptr)` entered the dynAutoMode path.**  The condition at `drain.cc:735` was `if (!opts || opts->dynAutoMode || hasAutoEntries)`.  Because `WhenIdleWorker` passes `opts=nullptr`, `!opts` was true and the full dynAutoMode Dialog handler ran — including capturing the outer `RETURNPKT` mid-drain.  This caused `dynTaskInstalledInterval_` to be reset to 0, which then triggered a ScheduledTask reinstall in the next `EvaluateWorker`, which set up the race again.

**Fix:** `WhenIdleWorker::Execute()` was rewritten with explicit two-phase logic:
- **Phase A:** Read packets from the link in a loop.  On every `BEGINDLGPKT`, pre-drain `INPUTNAMEPKT`, then send `EnterTextPacket` with `$wstpDynTaskStop=True; RemoveScheduledTask[…]; Return[$Failed]`, then call `drainUntilEndDialog`.  Loop until 400 ms of silence (comfortably longer than the ScheduledTask interval).
- **Phase B:** Send the actual `EvaluatePacket` with the kernel guaranteed to be at dialog level 0.

Additionally, the ScheduledTask install expression in `EvaluateWorker` was changed to **not** unset `$wstpDynTaskStop` after `RunScheduledTask` — the variable stays `True` (suppressed) until Phase 3's `$wstpDynTaskStop=.;` prepend at the start of the main expression.  This eliminates the window where the first task firing could open a `Dialog[]` before the kernel finished reading the EvaluatePacket.

**Tests:** mini-test M7, full-suite tests 65–70 (`tests/test_subauto_idle_hang.js`).
Full details in `archive/SCHEDULEDTASK_DIALOG_RACE_FIX.md`.
