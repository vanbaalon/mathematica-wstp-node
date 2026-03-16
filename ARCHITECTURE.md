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
| `evaluate_worker.h` / `evaluate_worker.cc` | **Async evaluation worker.** `EvaluateWorker` is a `Napi::AsyncWorker` subclass. `Execute()` runs on the libuv thread pool: sends `EvaluatePacket` or `EnterExpressionPacket` (interactive mode), then calls `DrainToEvalResult`. `OnOK()` and `OnError()` convert the result and resolve or reject the Promise on the main thread. |
| `wstp_session.h` / `wstp_session.cc` | **Main kernel session class.** `WstpSession` wraps a `WSEnvironment`+`WSLINK` pair. It exposes the full JS API: `evaluate`, `sub`, `subWhenIdle`, `subAuto`, `dialogEval`, `exitDialog`, `interrupt`, `abort`, `closeAllDialogs`, `createSubsession`, `close`, `registerDynamic`, `unregisterDynamic`, `clearDynamicRegistry`, `getDynamicResults`, `setDynamicInterval`, `setDynAutoMode`, and accessors `isOpen`, `isDialogOpen`, `isReady`, `kernelPid`, `dynamicActive`. Internally it maintains an evaluation queue, a sub-idle queue, a when-idle queue, subAuto async deferred tracking, and a dynamic-polling timer thread. Constructor launches the kernel (up to 3 retries if `$Output` routing fails). `CleanUp()` signals abort, spins until the worker releases the link, then calls `WSClose`. |
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
