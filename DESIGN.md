# WSTP Backend — Design Document

## Overview

`wstp-backend` is a native Node.js addon (`.node` binary, v6) that exposes a Wolfram/Mathematica
kernel over [WSTP](https://reference.wolfram.com/language/guide/WSTP.html) (Wolfram Symbolic
Transfer Protocol) to JavaScript via the Node-API (NAPI) stable ABI.

Current source: `src/addon.cc` ~1673 lines.

It lets you write code like:

```js
const { WstpSession, WstpReader } = require('./build/Release/wstp.node');

const session = new WstpSession('/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel');

// Basic evaluation:
const result = await session.evaluate('Expand[(a+b)^5]');
// { cellIndex: 5, outputName: 'Out[5]=', result: { type:'function', ... },
//   print: [], messages: [], aborted: false }

// Streaming callbacks — fire in real time as the kernel produces output:
const r = await session.evaluate('Do[Print[i]; Pause[0.5], {i,1,5}]', {
    onPrint:   (line) => console.log('[live]', line),
    onMessage: (msg)  => console.warn('[msg]', msg),
});
// By the time `await` resolves, all onPrint callbacks have already fired.

// Multiple evaluate() calls are automatically serialised through an internal
// queue — no link corruption even if you fire them concurrently:
const [r1, r2, r3] = await Promise.all([
    session.evaluate('1'), session.evaluate('2'), session.evaluate('3'),
]);

// sub() — lightweight evaluation, always runs ahead of queued evaluate() calls:
const value = await session.sub('2 + 2');
// { type: 'integer', value: 4 }  — returns WExpr directly, not EvalResult
```

---

## File Structure

```
WSTP Backend/
├── src/
│   └── addon.cc          # All C++ source — ~1384 lines
├── build/                # Compiled output (gitignore candidate)
│   └── Release/
│       └── wstp.node
├── build.sh              # Build script (replaces node-gyp)
├── binding.gyp           # GYP config (kept for reference, not used)
├── package.json          # npm metadata + build/demo scripts
├── index.d.ts            # TypeScript declarations
├── demo.js               # 18-section feature showcase
├── monitor_demo.js       # Real-time variable monitoring (3 approaches)
└── DESIGN.md             # This file
```

---

## C++ Architecture (`src/addon.cc`)

The file is structured in four layers:

### Layer 1 — `WExpr` + `EvalResult`: Thread-safe data structs

```cpp
struct WExpr {
    enum Kind { Integer, Real, String, Symbol, Function, WError } kind;
    int64_t     intVal;
    double      realVal;
    std::string strVal;   // string content, symbol name, or error message
    std::string head;     // function head (for Kind::Function)
    std::vector<WExpr> args;
};

struct EvalResult {
    int64_t                  cellIndex;   // from InputNamePacket "In[42]:="
    std::string              outputName;  // from OutputNamePacket "Out[42]=" (empty if Null)
    WExpr                    result;      // the ReturnPacket payload
    std::vector<std::string> print;       // TextPacket lines (Print[] output)
    std::vector<std::string> messages;    // e.g. "Power::infy: Infinite expression..."
    bool                     aborted;
};
```

Both are plain C++ value types with no NAPI dependencies, safe to build and copy on **any thread**.

Four free functions operate on them:

| Function | Thread | Purpose |
|---|---|---|
| `ReadExprRaw(WSLINK, depth)` | thread pool | Recursively reads one expression from the link into a `WExpr` |
| `DrainToEvalResult(WSLINK)` | thread pool | Consumes all packets for one cell; populates an `EvalResult` |
| `WExprToNapi(Env, WExpr)` | main thread | Converts `WExpr` to a `Napi::Value` (used by `WstpReader`) |
| `EvalResultToNapi(Env, EvalResult)` | main thread | Converts `EvalResult` to a JS object with all fields |

Depth is capped at 512 to prevent stack overflow on pathological inputs.

### Layer 2 — `WstpSession`: Kernel lifecycle + evaluation

`WstpSession` wraps one WSTP link to a launched `WolframKernel` process.

**Constructor** (`WstpSession(kernelPath)`):
- Initialises WSTP (`WSInitialize`)
- Shell-quotes `kernelPath` to handle spaces: `"\"" + kernelPath + "\" -wstp"`
- Launches kernel with `WSOpenArgcArgv` (`-linkmode launch`; WSTP auto-selects SharedMemory on macOS)
- Activates the link with `WSActivate`
- Calls static helper `WarmUpOutputRouting(lp_)` — sends `EvaluatePacket[Print["$WARMUP$"]]`
  and checks for `TEXTPKT` in the response.  On approximately 20 % of launches the kernel starts
  with `$Output` routing broken (no `TEXTPKT` ever arrives, so `Print[]` / `Message[]` produce
  no output).  `WarmUpOutputRouting` runs up to 4 probe attempts (100 ms initial sleep, 200 ms
  between retries) and returns `false` if all fail.
- Outer **3-attempt restart loop**: if `WarmUpOutputRouting` returns `false`, the constructor
  executes `WSClose(lp_)` + `kill(kernelPid_, SIGTERM)` + 200 ms sleep and re-runs
  `WSOpenArgcArgv` / `WSActivate` / `WarmUpOutputRouting`.  In practice 1–2 attempts suffice
  on every observed case.  After 3 consecutive failures the constructor logs a warning and
  continues with the potentially-broken kernel rather than throwing.
- Calls static helper `FetchKernelPid(lp_)` — sends `$ProcessID` synchronously and stores the
  result in `kernelPid_` so `CleanUp()` can kill the child process later

**JS methods**:

| Method | Signature | Notes |
|---|---|---|
| `evaluate(expr, opts?)` | `string → Promise<EvalResult>` | Non-blocking — queued via `EvaluateWorker`; `opts` carries `onPrint`/`onMessage`/`onDialogBegin`/`onDialogPrint`/`onDialogEnd` callbacks and TSFN context |
| `sub(expr)` | `string → Promise<WExpr>` | Priority evaluation — always runs before any queued `evaluate()` calls |
| `dialogEval(expr)` | `string → Promise<WExpr>` | Evaluate inside the currently-open `Dialog[]` subsession using `EvaluatePacket`; rejects if no dialog is open |
| `exitDialog(retVal?)` | `string? → Promise<null>` | Close the open dialog by sending `EnterTextPacket["Return[]"]` (or `EnterTextPacket["Return[retVal]"]`); rejects if no dialog is open. **Required to exit a dialog** — `dialogEval('Return[]')` does NOT close the dialog (see note below) |
| `interrupt()` | `boolean` | Post `WSInterruptMessage` (best-effort — requires a Wolfram-side interrupt handler) |
| `abort()` | `boolean` | Thread-safe: calls `WSAbortMessage` + `WSPutMessage(WSABORTTAG)` |
| `createSubsession()` | `→ WstpSession` | Launches a second independent kernel |
| `close()` | `void` | Calls `CleanUp()`: `WSClose` → `WSDeinitialize` → `SIGTERM` on child PID |
| `isOpen` | getter | Returns whether the session is still alive |
| `isDialogOpen` | getter | Returns `true` while a `Dialog[]` subsession is open |

**`EvaluateWorker`** (extends `Napi::AsyncWorker`):
- Constructor parameters: `deferred`, `lp`, `expr`, `opts`, `abortFlag`, `completionCb`
- `Execute()` runs on the libuv thread pool:
  - Sends `EvaluatePacket[ToExpression["<expr>"]]` via `WSPutFunction` / `WSPutString` / `WSEndPacket`
  - Calls `DrainToEvalResult(lp_, &opts_)` — **blocks** until the kernel responds
  - `DrainToEvalResult` fires `opts_.onPrint` / `opts_.onMessage` callbacks **as each packet arrives** via TSFN, before `ReturnPacket`
  - Stores final result in `EvalResult result_` (no NAPI)
- `OnOK()` runs on the JS main thread:
  - Clears `abortFlag_`, invokes `completionCb_` to clear `busy_` and trigger `MaybeStartNext()`
  - Resolves the `Promise::Deferred` with `EvalResultToNapi(result_)`
- `OnError()` rejects the deferred and also calls `completionCb_`

**`DrainToEvalResult` internals**:
- `INPUTNAMEPKT ["In[n]:="]` → extracts `cellIndex` via simple bracket parser
- `OUTPUTNAMEPKT ["Out[n]="]` → stores `outputName`
- `TEXTPKT` (Print[]) → stripped by `rtrimNL` and appended to `print[]`; if `opts->onPrint` TSFN is set, it is called immediately (streaming — fires before `ReturnPacket`)
- `MESSAGEPKT` → **discards** the body with `WSNewPacket`; reads the following
  `TEXTPKT` and extracts the `Symbol::tag: description` line by searching for `::` and
  the `\012` delimiters; if `opts->onMessage` TSFN is set, fires immediately
- `BEGINDLGPKT` → reads dialog level integer; sets `dialogOpen_ = true`; fires `onDialogBegin` TSFN.
  Then enters the **dialog inner loop** (see below) until `ENDDLGPKT` is received.
  After the inner loop exits, the outer drain loop resumes waiting for the original `RETURNPKT`.
- `MENUPKT` (pkt=6) → the kernel interrupt-menu packet; sent when `WSInterruptMessage` is
  received and a Wolfram interrupt handler has opened the interrupt menu.  Protocol (per
  JLink `InterruptDialog.java`):
  1. `WSGetInteger64(lp, &menuType)` — consume menu type integer
  2. `WSGetString(lp, &menuPrompt)` — consume prompt string; release immediately
  3. `WSNewPacket(lp)` — flush any remainder
  4. `WSPutString(lp, "i")` + `WSEndPacket` + `WSFlush` — respond with bare string `"i"`
     to choose **inspect / Dialog** mode
  The kernel then sends: `TEXTPKT` (option list) → `BEGINDLGPKT` → `INPUTNAMEPKT`.
  The C++ code then enters the **menuDlgDone loop** (see below) to await `INPUTNAMEPKT`
  (which fires `isDialogOpen=true`) and to service `dialogQueue_` requests.
- `RETURNPKT` → reads payload with `ReadExprRaw`; checks for `$Aborted` symbol
  (context-prefix stripped by `stripCtx`) to set `aborted = true`
- `RETURNTEXTPKT` (pkt=4) → dialog/inspect-mode result returned as OutputForm text.  In
  the **SDR (serviceDialogRequest)** inner function: the text is read with `WSGetString`,
  trimmed, parsed as integer / real / string, and resolved as the `dialogEval` promise value.
  In the outer drain loop (cooperative `Dialog[]` path): treated as a safety exit — resolves
  with a `WError` sentinel rather than spinning forever.

**menuDlgDone loop** (entered after `MENUPKT` → `"i"` response; exits when dialog is
fully started):
- Polls `WSNextPacket` until `INPUTNAMEPKT` arrives (signalling the dialog is ready for input).
- Handles intermediate packets:
  - `TEXTPKT` with "Your options are" → filtered (not forwarded to `onDialogPrint`)
  - `TEXTPKT` other → forwarded to `onDialogPrint` if set
  - `BEGINDLGPKT` → reads level integer, discards; `isDialogOpen` will be set by next
    `INPUTNAMEPKT`
  - `INPUTNAMEPKT` → sets `dialogOpen_=true`, fires `onDialogBegin` TSFN; then immediately
    falls through to service `dialogQueue_` (SDR), same as the inner loop
  - `MENUPKT` (within dialog) → read type+prompt, respond `"c"` (continue) to dismiss the
    menu; sets `dialogOpen_=false`, fires `onDialogEnd`

**Dialog inner loop** (entered on `BEGINDLGPKT`, exits on `ENDDLGPKT`):
- Uses `WSReady(lp)` polling (2 ms sleep when not ready) instead of blocking `WSNextPacket`
  so that `dialogQueue_` can be serviced between kernel packets.
- On each iteration: **(a)** if `dialogPending_` is set, pops one `DialogRequest` from
  `dialogQueue_` and calls `serviceDialogRequest(req)` (a local lambda returning `bool`):
  - If `req.useEnterText == false` (normal `dialogEval`): sends `EvaluatePacket[ToExpression[expr]]`,
    drains until `RETURNPKT`, fires `resolve` TSFN with the result, returns `true`.
  - If `req.useEnterText == true` (called by `exitDialog()`): sends `EnterTextPacket[expr]`,
    then drains — if `ENDDLGPKT` arrives, sets `dialogOpen_=false`, fires `onDialogEnd` and
    `resolve` with Null, returns `false` (signals the inner loop to break).
  - The call site sets `dialogDone = true` when `serviceDialogRequest` returns `false`.
- **(b)** if `WSReady`, reads next packet:
  - `ENDDLGPKT` → sets `dialogOpen_ = false`, fires `onDialogEnd`, breaks
  - `TEXTPKT` → fires `onDialogPrint` TSFN
  - `MESSAGEPKT` → extracts/fires message (same as outer loop)
  - `RETURNPKT` inside dialog (spontaneous) → discarded with `WSNewPacket`
  - `INPUTNAMEPKT` / `OUTPUTNAMEPKT` → discarded
  - `0` / `ILLEGALPKT` → unrecoverable; clears `dialogOpen_` and returns error `EvalResult`

This two-phase split is the reason `abort()` works: `abort()` is called from JS (main thread)
while `Execute()` is blocked inside `DrainToEvalResult` on the thread pool. WSTP's
`WSAbortMessage` is documented as thread-safe, so it can interrupt the blocked read.

**Evaluation queue and `sub()` priority**:

`WstpSession` maintains two queues protected by `queueMutex_`:

```cpp
std::queue<QueuedEval>      queue_;         // evaluate() calls
std::queue<QueuedSubIdle>   subIdleQueue_;  // sub() calls — higher priority
```

`MaybeStartNext()` is called after every completed evaluation. It checks `subIdleQueue_`
first, then `queue_`, and starts at most one new worker. This guarantees that any `sub()`
calls always run before the next queued `evaluate()` call, regardless of arrival order.

`SubIdleWorker` (defined inline inside `StartSubIdleWorker`) handles `sub()` evaluations:
- Sends `EvaluatePacket[ToExpression[expr]]` and calls `DrainToEvalResult(lp_)` (no opts)
- Resolves the `Promise::Deferred` with `WExprToNapi(env, result.result)` — just the
  `WExpr`, not the full `EvalResult`

`sub()` semantics: always prioritised over `queue_`, but not preemptive. If the session is
currently busy, `sub()` waits for the in-flight evaluation to finish, then runs ahead of
any other queued `evaluate()` calls.

**`CleanUp()` and kernel process teardown**:
`CleanUp()` calls `WSClose(lp_)` and `WSDeinitialize(wsEnv_)`, then `kill(kernelPid_, SIGTERM)`.
`WSClose` alone does **not** terminate the child `WolframKernel` process — it only closes the
WS link from our side. Without the explicit `kill`, each `session.close()` / garbage-collected
session would leak an orphaned kernel process. `kernelPid_` is fetched synchronously from
`$ProcessID` in the constructor right after `WSActivate`, while the link is idle and no async
workers have been started yet.

The `WstpSession` private members relevant to lifecycle:
```cpp
WSEnvironment             wsEnv_;
WSLINK                    lp_;
bool                      open_;
pid_t                     kernelPid_;     // SIGTERM target in CleanUp()
std::atomic<bool>         abortFlag_;
std::atomic<bool>         busy_;
std::mutex                queueMutex_;
std::queue<QueuedEval>    queue_;
std::queue<QueuedSubIdle> subIdleQueue_;
// Dialog subsession state (written on main thread, consumed on thread pool):
std::mutex                  dialogMutex_;
std::queue<DialogRequest>   dialogQueue_;    // dialogEval() requests
std::atomic<bool>           dialogPending_;  // true when dialogQueue_ non-empty
std::atomic<bool>           dialogOpen_;     // true while inside Dialog[] inner loop
```

`DialogRequest` is a plain struct carrying the expression string, a routing flag, and a TSFN
that delivers the result back to the JS Promise:
```cpp
struct DialogRequest {
    std::string              expr;
    bool                     useEnterText = false;  // true → EnterTextPacket; false → EvaluatePacket
    Napi::ThreadSafeFunction resolve; // NonBlockingCall'd with WExprToNapi result
};
```

> **`EvaluatePacket` vs `EnterTextPacket` — critical protocol distinction**:
> - `EvaluatePacket[ToExpression["Return[]"]]` evaluates `Return[]` at the **top level** of a
>   fresh evaluation context — there is nothing to return from, so it evaluates to `Return[]`
>   unevaluated and the dialog stays open.
> - `EnterTextPacket["Return[]"]` feeds the string to the WSTP interactive-REPL context, where
>   `Return[]` **is** recognised as a dialog-exit command and triggers `ENDDLGPKT`.
> - Consequence: **`dialogEval('Return[]')` does not close a dialog**. Use `exitDialog()` instead.
> - Similarly, `$DialogLevel` is not accessible via `EvaluatePacket` (returns the symbol
>   unevaluated) and Do-loop variables from an outer evaluation are not in scope.

> **On `interrupt()` and `WSInterruptMessage`**: `interrupt()` posts `WSInterruptMessage`
> to the link (thread-safe, same as `abort()`). Whether this has any effect depends on
> whether a Wolfram-side interrupt handler has been installed, e.g.:
> ```
> Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]
> ```
> Without such a handler the kernel sends `MENUPKT` (the interrupt menu) directly.  With
> Wolfram 14 / Wolfram 3 the C++ outer drain loop handles `MENUPKT` automatically by
> reading its type+prompt payload and responding with bare `WSPutString(lp, "i")` (inspect
> mode), which causes the kernel to open `Dialog[]` inline.
>
> **MENUPKT response format** (`init.wl` interrupt handler path):
> The correct response is a bare `WSPutString` — **not** `EnterTextPacket` and **not** an
> integer.  The kernel WSTP protocol for `MENUPKT` requires reading the type integer
> (`WSGetInteger64`) and the prompt string (`WSGetString`) from the packet before
> responding; omitting these reads leaves the link in an inconsistent state.  This
> protocol was confirmed from JLink source
> (`com/wolfram/jlink/ui/InterruptDialog.java`).
>
> For a reliable path to a dialog subsession without an interrupt handler, call `Dialog[]`
> directly from Wolfram code instead.

### Layer 3 — `WstpReader`: Side-channel link reader

`WstpReader` wraps a WSTP link that was created by the kernel (via `LinkCreate`) rather than
launched. It is used to receive data that the kernel pushes asynchronously — for example,
periodic variable snapshots during a long computation.

**Constructor** (`WstpReader(linkName, protocol?)`):
- Calls `WSOpenArgcArgv` with `-linkmode connect -linkprotocol TCPIP -linkname <name>`
- Does **not** call `WSActivate` here — deferred to the first `ReadNextWorker::Execute()` call

**`activated_` atomic flag**: Prevents double-activation if `readNext()` is called concurrently.

**`ReadNextWorker`**:
- `Execute()` runs on the thread pool:
  - On first call: calls `WSActivate(lp_)` to complete the WSTP handshake.
    `WSActivate` is intentionally **not** called from the JS constructor because it blocks
    until the kernel enters its `LinkWrite` loop; calling it on the main thread would
    stall the event loop.
  - **Spin-wait loop**: calls `WSGetType(lp_)` in a 5 ms-sleep loop until the return
    value is non-zero.  On TCPIP connect-mode links `WSGetType` is blocking but can
    return 0 at expression boundaries.  Logging traces every distinct type change seen
    in the first 500 ms (useful for diagnosing timing anomalies).  Hard timeout: 5 s.
  - Calls `ReadExprRaw(lp_)` directly — **no** `WSNextPacket`, because `LinkWrite` in
    Wolfram sends bare expressions without packet headers.
  - **WSTKEND re-spin**: if `ReadExprRaw` returns a `WError` with "unexpected token type: 0"
    (meaning the spin exited on a protocol boundary marker rather than a data token),
    calls `WSNewPacket(lp_)` to advance past the boundary and re-spins to find real data.
  - **Post-read advance**: calls `WSNewPacket(lp_)` after every successful `ReadExprRaw`
    to normalise link state between consecutive expressions.  Without this the next
    `WSGetType` call sees a residual boundary token and appears to spin on empty data.
  - Stores result in `WExpr result_`.
- `OnOK()` resolves the deferred Promise with `WExprToNapi(result_)`

**JS methods**:

| Method | Signature | Notes |
|---|---|---|
| `readNext()` | `→ Promise<Value>` | Blocks on thread pool until next expression arrives |
| `close()` | `void` | Closes the link |
| `isOpen` | getter | Whether the link is still open |

### Layer 4 — Module-level diagnostic channel (`setDiagHandler`)

A global diagnostic channel enabled entirely at runtime — no recompile needed.

```cpp
static std::mutex               g_diagMutex;
static Napi::ThreadSafeFunction g_diagTsfn;
static bool                     g_diagActive = false;
static const bool               g_debugToStderr = /* getenv("DEBUG_WSTP")=="1" */;
static auto                     g_startTime = std::chrono::steady_clock::now();
```

`DiagLog(msg)` is a file-scoped helper that:
1. If `DEBUG_WSTP=1` is set in the environment, writes `[wstp +Nms] msg\n` synchronously
   to `stderr` via `fwrite` (no lock contention, safe from any thread).
2. If a JS handler is registered (`g_diagActive`), dispatches through the NAPI TSFN so
   the callback fires on the JS main thread.

Diagnostic messages are emitted from:
- `[Session]` — kernel launch, `WarmUpOutputRouting` results, restart attempts
- `[WarmUp]` — per-attempt `$WARMUP$` probe result
- `[Eval] pkt=N` — every `WSNextPacket` call in the outer drain loop
- `[Dialog] dpkt=N` — every packet in the dialog inner loop
- `[TSFN][onPrint]` — TSFN dispatch with `+Nms` timestamp for latency measurement
- `[WstpReader]` — `WSActivate`, spin-wait trace, `ReadExprRaw` result

**`setDiagHandler(fn)`** (JS-callable):
- Acquires `g_diagMutex`, releases any existing TSFN, creates a new one if `fn` is a function.
- The TSFN is `Unref()`'d so it does not prevent normal process exit.
- Passing `null` / no argument clears the handler.

**`DEBUG_WSTP` env var** — alternative when no JS handler is registered:
```bash
DEBUG_WSTP=1 node test.js 2>diag.txt
```

The `+Nms` timestamps are module-relative (milliseconds since the addon was loaded),
consistent across C++ and JS if the JS handler prepends its own `Date.now()` timestamp.

### Layer 5 — Module registration

```cpp
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    WstpSession::Init(env, exports);
    WstpReader::Init(env, exports);
    exports.Set("setDiagHandler",
        Napi::Function::New(env, SetDiagHandler, "setDiagHandler"));
    return exports;
}
NODE_API_MODULE(wstp, Init)
```

---

## Build System (`build.sh`)

### Why not node-gyp?

node-gyp generates `Makefiles` that do not quote paths. Both the WSTP SDK path
(`/Applications/Wolfram 3.app/...`) and the project directory (`WSTP Backend/`) contain spaces.
On macOS this causes the Makefile to split each path at the space, which breaks compilation.

### What `build.sh` does

1. Detects architecture: `uname -m` → `arm64` → `MacOSX-ARM64`, else `MacOSX-x86-64`
2. Locates Node headers via `node --prefix` or `~/.cache/node-gyp/<version>/include/node`
3. Invokes a single `clang++` command with all paths shell-quoted:
   ```bash
   clang++ -std=c++17 -O2 \
     -I"${NODE_HEADERS}" -I"${ADDON_API}" \
     -I"${WSTP_DIR}/wstp.h parent" \
     "${WSTP_DIR}/libWSTPi4.a" \
     -framework CoreFoundation -framework Foundation \
     -undefined dynamic_lookup -shared \
     -o build/Release/wstp_backend.node \
     src/addon.cc
   ```
4. Creates `build/Release/` if it doesn't exist

### Key library details

| Item | Value |
|---|---|
| WSTP static lib | `libWSTPi4.a` (not `wstp64i4s.a` — that's the Windows name) |
| Required macOS frameworks | `CoreFoundation`, `Foundation` |
| Shared lib flag (macOS) | `-undefined dynamic_lookup -shared` (not `-bundle`) |
| WSTP API version macro | `WSAPIREVISION` (not `WSAPI_1_5`) |
| Uninitialise function | `WSDeinitialize` (not `WSUninitialize`) |

---

## What Works Well

### 1. Complete cell capture
`evaluate()` captures everything the kernel sends for one cell: the cell index,
output label, return value, all `Print[]` output, and all warning/error messages.
No output is silently discarded.

### 2. Non-blocking event loop
All blocking WSTP I/O is on the libuv thread pool (`Execute()`). The JS event loop is never
stalled, so `abort()`, `Promise.all(...)`, and `setTimeout` all work correctly alongside
in-flight evaluations.

### 3. Abort works correctly
`abort()` posts `WSAbortMessage` (thread-safe) while `Execute()` is blocked inside
`DrainToEvalResult`. The kernel interrupts its computation and the `EvalResult` comes back
with `aborted: true` and `result: { type: "symbol", value: "$Aborted" }`. The kernel
remains alive and can accept subsequent evaluations.

### 4. Subsessions / parallel evaluation
`createSubsession()` launches a second kernel; multiple sessions can evaluate in parallel with
`Promise.all`. Each session is completely independent (separate process, separate link).

### 5. Streaming `Print[]` and messages
`evaluate()` accepts an optional `opts` object with `onPrint` and `onMessage` callbacks.
These fire **in real time** as each `TEXTPKT`/`MESSAGEPKT` arrives from the kernel —
before the `ReturnPacket` and before the Promise resolves. Callbacks are dispatched to the
JS main thread via NAPI Thread-Safe Functions (TSFNs) so they are safe to call from the
libuv thread pool.

```js
await session.evaluate('Do[Print[i]; Pause[0.3], {i,1,5}]', {
    onPrint:   (line) => console.log('[live]', line),  // fires 5 times during eval
    onMessage: (msg)  => console.warn('[msg]', msg),
});
```

### 6. Evaluation queue
`WstpSession` serialises all `evaluate()` and `sub()` calls through an internal
two-tier queue (`queue_` and `subIdleQueue_`). Concurrent `Promise.all` calls never
corrupt the link — they are queued and dispatched one at a time.

### 7. `sub()` priority evaluation
`sub(expr)` is always run before any pending `evaluate()` calls. Multiple `sub()` calls
are queued FIFO among themselves and all complete before the next `evaluate()` in the
queue starts. `sub()` returns `Promise<WExpr>` — just the result expression, without
the cell-index / output-label / print / message bookkeeping of `EvalResult`.

### 8. `WstpReader` side-channel
A long computation can periodically write to a `LinkCreate` link while the main link is blocked.
A `WstpReader` connecting to that link can `await reader.readNext()` in a loop to receive real-
time updates without interfering with the main evaluation.

### 9. TypeScript declarations (`index.d.ts`)
Full `.d.ts` file with `WExpr`, `EvalResult`, `EvalOptions`, `WstpSession`, and `WstpReader`
interfaces and JSDoc comments. IDE autocomplete and type-checking work out of the box.

### 10. Stable ABI (NAPI)
The addon is built against Node-API, which is ABI-stable across Node.js versions. You do not
need to rebuild if you upgrade Node.js (within the same major series).

### 11. Rich result type
`WExprToNapi` converts the full WSTP expression tree to a nested JS object:
```js
{ type: 'function', head: 'Plus', args: [ { type: 'function', head: 'Times', args: [2, 'x'] }, 1 ] }
```
All WSTP token kinds (integer, real, string, symbol, compound function) are handled.

### 13. Automatic kernel restart on broken `$Output` routing

On approximately 20 % of launches the kernel's `$Output` stream is not wired to the
WSTP link.  `Print[]` and `Message[]` calls produce no `TEXTPKT`, which breaks all
streaming callbacks and the `r.print` / `r.messages` batch arrays.  The constructor
detects this via `WarmUpOutputRouting()` and relaunches with a fresh kernel process
(up to 3 attempts).  In production this resolves silently within 1–2 attempts.

### 14. Runtime diagnostic channel (`setDiagHandler` / `DEBUG_WSTP`)

No-overhead when disabled (single `if (!g_diagActive)` check).  When enabled, every
WSTP packet receipt, TSFN dispatch, and kernel lifecycle event is logged with a
module-relative millisecond timestamp.  Useful for measuring TSFN delivery latency:
compare `[TSFN][onPrint] dispatch +Nms` in the C++ log with the timestamp the JS
callback records via `Date.now()`.

```js
const { setDiagHandler } = require('./build/Release/wstp.node');
setDiagHandler((msg) => {
    process.stderr.write(`[diag ${new Date().toISOString().slice(11,23)}] ${msg}\n`);
});
// or, without a JS handler:
// DEBUG_WSTP=1 node myscript.js 2>diag.txt
```

### 12. Dialog subsession support
`dialogEval(expr)` evaluates an expression inside a `Dialog[]` subsession using
`EvaluatePacket`. `exitDialog(retVal?)` closes the dialog by sending
`EnterTextPacket["Return[]"]` via the interactive-REPL packet path, which the
kernel recognises as a dialog exit (triggering `ENDDLGPKT`).

The dialog inner loop in `DrainToEvalResult` uses `WSReady` polling so it can
service `dialogQueue_` entries between kernel packets without blocking. Callbacks:
- `onDialogBegin(level)` — fires when `BEGINDLGPKT` arrives
- `onDialogPrint(line)` — fires for dialog-side `Print[]` output
- `onDialogEnd(level)` — fires when `ENDDLGPKT` arrives

The `isDialogOpen` getter reflects the current dialog state in real time.
`dialogEval()` and `exitDialog()` both reject immediately if no dialog is open.

**Key protocol note**: `dialogEval('Return[]')` does **not** close the dialog.
`Return[]` evaluated via `EvaluatePacket` at the top level of a dialog context
is unevaluated (there is no enclosing `Block`/`Module`/etc. to return from).
Only `EnterTextPacket["Return[]"]` — sent by `exitDialog()` — is processed by the
kernel's REPL layer and actually exits the dialog.

```js
// ✓ correct way to close a dialog:
await session.exitDialog();          // closes dialog, outer evaluate() resolves

// ✓ correct way to close with a return value:
await session.exitDialog('99');      // sends EnterTextPacket["Return[99]"]

// ✗ does NOT close the dialog:
await session.dialogEval('Return[]');        // Return[] is unevaluated at top level
await session.dialogEval('DialogReturn[]');  // front-end-only; kernel ignores it
```

---

## Test Coverage

All 28 tests in `test.js` pass (`node test.js`).  The table below lists each test,
the feature it exercises, and the key assertion(s).

| # | Name | Feature | Key assertions |
|---|------|---------|----------------|
| 1 | queue serialisation | Concurrent `evaluate()` calls are serialised | Three `Promise.all` results arrive in order with correct values |
| 2 | sub() priority over queued evaluate() | `sub()` runs ahead of queued evals | `sub('42')` completes in ≤ 1200 ms even while two `Pause[0.5]` evals are queued |
| 3 | sub() FIFO ordering | Multiple `sub()` calls are ordered FIFO | Three `sub()` calls return 1, 2, 3 in that order |
| 4 | streaming onPrint timing | `onPrint` fires in real-time; delivery confirmed by promise latch | Promise latch waits up to 5 s for all 4 callbacks; inter-line gap 50–700 ms; batch `r.print` matches |
| 5 | streaming onMessage | `onMessage` fires for kernel warnings | Promise latch confirms delivery; streaming value equals batch `r.messages[0]`; contains `::` |
| 6 | abort + session survives | `abort()` interrupts evaluation, session stays alive | `Do[Pause[0.1],{100}]` aborted after 800 ms; `aborted: true`, `result.value === '$Aborted'`; next eval returns 2 |
| 7 | abort drains queue | Queued evals after abort still run | Aborted eval has `aborted: true`; next queued eval returns `'after'` |
| 8 | sub() after abort | Session healthy after abort | `$ProcessID` via `sub()` returns a positive integer |
| 9 | cellIndex and result correctness | `EvalResult.cellIndex` and `.result` are valid | Three evals return 100, 200, 300; `cellIndex` is a number |
| 10 | EvalResult structure | Shape of `EvalResult` object | `outputName` is string; `print`/`messages` are arrays; `aborted` is boolean |
| 11 | WstpReader side-channel | `WstpReader` receives real-time values from kernel `LinkCreate` link | 5 values 1–5 received in order; `LinkWrite` before `Pause[0.3]`; `Pause[1]` before `LinkClose` |
| 12 | deep expression no crash | Depth-cap at 512 returns rejection, process survives | `Nest[f,x,600]` rejects with `'expression too deep'`; next eval returns 2 |
| 13 | syntax error no crash | Malformed input produces message, not crash | `1 +* 2` returns non-null result with messages or result field |
| 14 | close() is idempotent | Double-close does not throw | Fresh session closes; second `close()` is a no-op; `isOpen` is false |
| 15 | cooperative Dialog[] subsession | `Dialog[]`, `dialogEval()`, `exitDialog()`, callbacks | `onDialogBegin` fires; `dialogEval('1+1')` returns 2; `exitDialog()` closes dialog; outer eval returns `'after-dialog'`; `onDialogEnd` fires |
| 16 | dialogEval rejects with no open dialog | `dialogEval()` guard | Calling `dialogEval()` without a dialog rejects with message containing `'no dialog'` |
| 17 | unhandled dialog does not corrupt link | `exitDialog()` without `onDialogBegin` callback | Dialog opens without callback; `exitDialog()` closes it; outer `Dialog[]; 42` returns 42 |
| 18 | interrupt() does not throw | `interrupt()` method | Returns a boolean without throwing |
| 19 | exitDialog() with a return value | `exitDialog(retVal)` threads return through `Dialog[]` | `exitDialog('21')` makes `Dialog[]` return 21; outer `x$$*2` resolves to 42 |
| 20 | dialogEval sees outer variable state | Kernel global state visible inside subsession | `myVar$$=123` set before `Dialog[]`; `dialogEval('myVar$$')` returns 123 |
| 21 | dialogEval can mutate kernel state | Mutations inside dialog persist after exit | `dialogEval('mutated$$=777')`; after `exitDialog()`, `sub('mutated$$')` returns 777 |
| 22 | multiple dialogEval calls are serviced FIFO | FIFO ordering inside `dialogQueue_` | Three concurrent `dialogEval()` calls return 1, 2, 3 in order |
| 23 | isDialogOpen transitions correctly | `isDialogOpen` getter accuracy | `false` → `true` (on `BEGINDLGPKT`) → `false` (on `exitDialog()`) |
| 24 | onDialogPrint fires for Print[] inside dialog | `onDialogPrint` callback; promise latch | Latch waits up to 5 s for callback before `exitDialog()`; confirms `'hello-from-dialog'` |
| 25 | abort while dialog is open | `abort()` during dialog inner loop | `r.aborted === true`; `isDialogOpen` false after abort |
| 26 | exitDialog() rejects with no open dialog | `exitDialog()` guard (symmetric to test 16) | Rejects with message containing `'no dialog'` |
| 27 | evaluate() queued during dialog runs after closes | Post-dialog queue drain | `evaluate()` queued while dialog open; resolves with correct value after `exitDialog()` |
| S | streaming stress (10× Print callback) | TSFN delivery stability across repeated evaluations | 10 consecutive `Do[Print[...],{4}]` evals in same session; promise latch confirms all 4 callbacks each time |

### Dialog test detail (tests 15–27)

```js
// Test 15 — cooperative dialog with callbacks
const evalPromise = session.evaluate('Dialog[]; "after-dialog"', {
    onDialogBegin: (_level) => { dialogOpened = true; },
    onDialogEnd:   (_level) => { dialogClosed = true; },
});
await pollUntil(() => session.isDialogOpen);
const two = await session.dialogEval('1 + 1');  // returns { value: 2 }
await session.exitDialog();                     // sends EnterTextPacket["Return[]"]
const r = await evalPromise;                    // resolves to { value: 'after-dialog' }
// assert dialogOpened && dialogClosed && !session.isDialogOpen

// Test 16 — dialogEval guard
try { await session.dialogEval('1 + 1'); } catch (e) {
    assert(e.message.includes('no dialog'));
}

// Test 17 — exitDialog without onDialogBegin
const r17 = session.evaluate('Dialog[]; 42');
await pollUntil(() => session.isDialogOpen);
await session.exitDialog();
assert((await r17).result.value === 42);

// Test 19 — exitDialog with return value
const p19 = session.evaluate('x$$ = Dialog[]; x$$ * 2');
await pollUntil(() => session.isDialogOpen);
await session.exitDialog('21');         // EnterTextPacket["Return[21]"]
assert((await p19).result.value === 42);

// Test 20 — outer variable visible inside dialog
const p20 = session.evaluate('myVar$$ = 123; Dialog[]; myVar$$');
await pollUntil(() => session.isDialogOpen);
assert((await session.dialogEval('myVar$$')).value === 123);
await session.exitDialog(); await p20;

// Test 21 — mutation inside dialog persists
const p21 = session.evaluate('Dialog[]; mutated$$');
await pollUntil(() => session.isDialogOpen);
await session.dialogEval('mutated$$ = 777');
await session.exitDialog(); await p21;
assert((await session.sub('mutated$$')).value === 777);

// Test 22 — FIFO ordering in dialog queue
const p22 = session.evaluate('Dialog[]');
await pollUntil(() => session.isDialogOpen);
const [a, b, c] = await Promise.all([
    session.dialogEval('1'), session.dialogEval('2'), session.dialogEval('3'),
]);
assert(a.value === 1 && b.value === 2 && c.value === 3);
await session.exitDialog(); await p22;

// Test 23 — isDialogOpen transitions
assert(!session.isDialogOpen);
const p23 = session.evaluate('Dialog[]');
await pollUntil(() => session.isDialogOpen);
assert(session.isDialogOpen);
await session.exitDialog(); await p23;
assert(!session.isDialogOpen);

// Test 24 — onDialogPrint
const dialogLines = [];
const p24 = session.evaluate('Dialog[]', { onDialogPrint: l => dialogLines.push(l) });
await pollUntil(() => session.isDialogOpen);
await session.dialogEval('Print["hello-from-dialog"]');
await session.exitDialog(); await p24;
assert(dialogLines.includes('hello-from-dialog'));

// Test 25 — abort during dialog
const p25 = session.evaluate('Dialog[]');
await pollUntil(() => session.isDialogOpen);
session.abort();
const r25 = await p25;
assert(r25.aborted === true && !session.isDialogOpen);
assert((await session.sub('1+1')).value === 2);

// Test 26 — exitDialog guard (symmetric to test 16)
try { await session.exitDialog(); } catch (e) {
    assert(e.message.includes('no dialog'));
}

// Test 27 — queued evaluate runs after dialog closes
const p27a = session.evaluate('Dialog[]');
await pollUntil(() => session.isDialogOpen);
const p27b = session.evaluate('"queued-during-dialog"');  // queued while dialog open
await session.exitDialog(); await p27a;
assert((await p27b).result.value === 'queued-during-dialog');
```

### `pollUntil` helper

```js
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
```

Used by all dialog tests (15, 17, 19–27) to wait for `isDialogOpen` to become `true` without
hard-coding fixed `sleep()` durations.

---

## Known Issues and Limitations

### 1. Large expression overhead
Very large return values (millions of nodes) are copied twice: once into the `WExpr` tree
and once into the Napi object graph. For numeric array results a more efficient path
(e.g. `WSGetReal64Array`) would help.

### 2. No reconnection / crash recovery
If the kernel process exits unexpectedly, the session goes into an error state and no
reconnection is attempted. The caller must create a new `WstpSession`. The kernel PID is
captured at construction time (`kernelPid_`), which provides the groundwork for a future
"watch and restart" mechanism.

### 3. String-based evaluation only
`evaluate()` takes a Wolfram Language expression as a **string**, which the kernel parses
with `ToExpression`. This means:
- Syntax errors in the string produce a kernel-side message, not a JS exception.
- It is not possible to send pre-parsed/structured expressions from JS.

A `putExpr(WExpr)` path could be added to send structured expressions directly.

### 4. `WstpReader` requires kernel-side setup
The caller must first send Wolfram code to create the `LinkCreate` link and run the writing
loop. There is no automatic pairing between a `WstpSession` and its reader.

### 5. No timeout support on `evaluate()`
`evaluate()` can hang forever if the kernel stalls (e.g. waiting for user input). An
optional timeout (using `uv_timer_t` or `WSReady`) would improve robustness.
`WstpReader.readNext()` does have a 5-second hard timeout on the spin-wait phase, but
not on the blocking `WSGetType` call itself.

### 6. Kernel path is passed by caller
The caller passes the kernel path as a constructor argument. There is no auto-detection of
the Wolfram installation location. A helper `findKernel()` function could search standard
install locations or call `wolframscript -print $InstallationDirectory`.

---

## Potential Future Features

| Feature | Difficulty | Notes |
|---|---|---|
| Structured expression input | Medium | Add `evaluateExpr(obj)` that converts JS→WExpr→WSTP without string round-trip |
| Timeout on evaluate | Medium | Post abort after N ms using a `uv_timer_t` side-channel |
| Reconnect on crash | Hard | PID already captured in `kernelPid_`; add a watcher thread that re-launches and replays state on unexpected exit |
| Numeric array fast path | Easy | Use `WSGetReal64Array` for `PackedArray` results to avoid node-per-element overhead |
| Windows support | Medium | Test `binding.gyp` path; use `wstp32i4.lib`/`wstp64i4.lib` |
| Auto-detect Wolfram path | Easy | Search standard install locations; fall back to `wolframscript -print $InstallationDirectory` |
| Web Socket bridge | Medium | Wrap `WstpSession` in a WebSocket server for browser clients |
| Nested dialogs | Medium | `dialogQueue_` already tracks level from `BEGINDLGPKT`; inner `Dialog[]` inside a dialog would re-enter the same inner loop |
