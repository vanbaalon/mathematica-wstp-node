# wstp-backend — API Reference

**Author:** Nikolay Gromov

Native Node.js addon for Wolfram kernel communication over WSTP — supports full
notebook-style evaluation with automatic `In`/`Out` history, real-time streaming,
and an internal evaluation queue.  All blocking I/O runs on the libuv thread pool;
the JS event loop is never stalled.

```js
const { WstpSession, WstpReader, setDiagHandler } = require('./build/Release/wstp.node');
```

---

## Table of Contents

1. [Installation](#installation)
2. [Batch mode vs interactive mode](#batch-mode-vs-interactive-mode)
3. [Return types — `WExpr` and `EvalResult`](#return-types)
4. [`WstpSession` — main evaluation session](#wstpsession)
   - [Constructor](#constructor) — launch a kernel and open a session
   - [`evaluate(expr, opts?)`](#evaluateexpr-opts) — queue an expression for evaluation; supports streaming `Print` callbacks
   - [`sub(expr)`](#subexpr) — priority evaluation that jumps ahead of the queue, for quick queries during a long computation
   - [`abort()`](#abort) — interrupt the currently running evaluation
   - [`dialogEval(expr)`](#dialogevalexpr) — evaluate inside an active `Dialog[]` subsession
   - [`exitDialog(retVal?)`](#exitdialogretval) — exit the current dialog and resume the main evaluation
   - [`interrupt()`](#interrupt) — send a low-level interrupt signal to the kernel
   - [`createSubsession(kernelPath?)`](#createsubsessionkernelpath) — spawn an independent parallel kernel session
   - [`close()`](#close) — gracefully shut down the kernel and free resources
   - [`isOpen` / `isDialogOpen`](#isopen--isdialogopen) — read-only status flags
5. [`WstpReader` — kernel-pushed side channel](#wstpreader)
6. [`setDiagHandler(fn)`](#setdiaghandlerfn)
5. [Usage examples](#usage-examples)
   - [Basic evaluation](#basic-evaluation)
   - [Interactive mode — In/Out history](#interactive-mode--inout-history)
   - [Streaming output](#streaming-output)
   - [Concurrent evaluations](#concurrent-evaluations)
   - [Priority `sub()` calls](#priority-sub-calls)
   - [Abort a long computation](#abort-a-long-computation)
   - [Dialog subsessions](#dialog-subsessions)
   - [Variable monitor — peeking at a running loop](#variable-monitor--peeking-at-a-running-loop)
   - [Real-time side channel (`WstpReader`)](#real-time-side-channel-wstpreader)
   - [Parallel independent kernels](#parallel-independent-kernels)
6. [Error handling](#error-handling)
7. [Diagnostic logging](#diagnostic-logging)

---

## Installation

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| macOS | Tested on macOS 13+; Linux should work with minor path changes |
| Node.js ≥ 18 | Earlier versions may work but are untested |
| Clang / Xcode Command Line Tools | `xcode-select --install` |
| Wolfram Mathematica or Wolfram Engine | Provides `WolframKernel` and the WSTP SDK headers/libraries |

### 1. Clone

```bash
git clone https://github.com/vanbaalon/mathematica-wstp-node.git
cd mathematica-wstp-node
```

### 2. Install Node dependencies

```bash
npm install
```

This pulls in `node-addon-api` and `node-gyp` (used by the build script).

### 3. Compile the native addon

```bash
bash build.sh
```

Output: `build/Release/wstp.node`

The script automatically locates the WSTP SDK inside the default Wolfram installation
(`/Applications/Wolfram 3.app/...`).  If your Wolfram is installed elsewhere, edit the
`WSTP_INC` and `WSTP_LIB` variables at the top of `build.sh`.

### 4. Run the test suite

```bash
node test.js
```

Expected last line: `All 28 tests passed.`

A more comprehensive suite (both modes + In/Out + comparison) lives in `tmp/tests_all.js`:

```bash
node tmp/tests_all.js
```

Expected last line: `All 56 tests passed.`

### 5. Quick smoke test

```js
const { WstpSession } = require('./build/Release/wstp.node');

(async () => {
  const session = new WstpSession();
  const r = await session.evaluate('Prime[10]');
  console.log(r.result.value);   // 29
  console.log(r.cellIndex);      // 1
  console.log(r.outputName);     // "Out[1]="  (may vary by session)
  session.close();
})();
```

**Default kernel path** (macOS): `/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel`

Pass an explicit path as the first argument to `new WstpSession(path)` if yours differs.

---

## Batch mode vs interactive mode

The session constructor accepts an optional second argument:

```js
// Batch mode (default) — EvaluatePacket, bypasses kernel main loop
const session = new WstpSession(kernelPath);
// or explicitly:
const session = new WstpSession(kernelPath, { interactive: false });

// Interactive mode — EnterExpressionPacket, full notebook-style evaluation
const session = new WstpSession(kernelPath, { interactive: true });
```

### Batch mode (`interactive: false`, default)

Uses `EvaluatePacket` which **bypasses** the kernel's main evaluation loop.
Fast and lightweight — the kernel evaluates the expression and returns the result
without touching `In[n]`/`Out[n]`/`$Line`.

- `In[n]`, `Out[n]`, `%`, `%%` are **not** populated by evaluations
- `$Line` stays at 1 regardless of how many evaluations are run
- `outputName` in `EvalResult` is always `""` in steady state
- Suitable for scripting and batch processing where history is not needed

### Interactive mode (`interactive: true`)

Uses `EnterExpressionPacket` which runs each evaluation through the kernel's full
main loop — exactly as a Mathematica notebook does.

- `In[n]`, `Out[n]`, `%`, `%%` all work and persist across evaluations
- `$Line` increments with every evaluation
- `cellIndex` in `EvalResult` reflects the actual kernel `$Line` (not a JS counter)
- `outputName` in `EvalResult` is `"Out[n]="` for non-Null results, `""` for suppressed
- `$HistoryLength` controls memory usage (default `100`)
- Suitable for notebook-like workflows and sessions that rely on running history

---

## Return Types

### `WExpr`

A Wolfram Language expression as a plain JS object.  The `type` field determines the shape:

| `type` | Additional fields | Example |
|--------|------------------|---------|
| `"integer"` | `value: number` | `{ type: "integer", value: 42 }` |
| `"real"` | `value: number` | `{ type: "real", value: 3.14 }` |
| `"string"` | `value: string` | `{ type: "string", value: "hello" }` |
| `"symbol"` | `value: string` | `{ type: "symbol", value: "Pi" }` |
| `"function"` | `head: string`, `args: WExpr[]` | `{ type: "function", head: "Plus", args: [{type:"integer",value:1}, {type:"symbol",value:"x"}] }` |
| *(absent)* | `error: string` | internal error — normally never seen |

Symbols are returned with their context stripped: `System\`Pi` → `"Pi"`.

### `EvalResult`

The full result of one `evaluate()` call:

```ts
{
  cellIndex:  number;   // Batch: JS-tracked counter (1-based per session).
                        // Interactive: kernel $Line at time of evaluation.
  outputName: string;   // Interactive: "Out[n]=" for non-Null results; "" for suppressed.
                        // Batch: derived from kernel OUTPUTNAMEPKT if sent.
  result:     WExpr;    // the expression returned by the kernel
  print:      string[]; // lines written by Print[], EchoFunction[], etc.
  messages:   string[]; // kernel messages, e.g. "Power::infy: Infinite expression..."
  aborted:    boolean;  // true when the evaluation was stopped by abort()
}
```

---

## `WstpSession`

### Constructor

```js
const session = new WstpSession(kernelPath?, options?);
```

Launches a `WolframKernel` process, connects over WSTP, and verifies that `$Output` routing
is working.  Consecutive kernel launches occasionally start with broken output routing (a WSTP
quirk); the constructor detects this automatically and retries up to 3 times, so it is
transparent to callers.

| Parameter | Type | Default |
|-----------|------|---------|
| `kernelPath` | `string` | `/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel` |
| `options.interactive` | `boolean` | `false` — see [Batch mode vs interactive mode](#batch-mode-vs-interactive-mode) |

Throws if the kernel cannot be launched or the WSTP link fails to activate.

---

### `evaluate(expr, opts?)`

```ts
session.evaluate(expr: string, opts?: EvalOptions): Promise<EvalResult>
```

Evaluate `expr` in the kernel and return the full result.

`expr` is passed to `ToExpression[]` on the kernel side, so it must be valid Wolfram Language
syntax.  Multiple concurrent calls are serialised through an internal queue — it is safe to
fire them without awaiting.

**One call = one cell.**  Newlines and semicolons inside `expr` do not split it into multiple
evaluations; the kernel sees them as a single `CompoundExpression` and returns only the last
value.  Use separate `evaluate()` calls to get separate `cellIndex` / `outputName` values.
A trailing semicolon suppresses the return value (the kernel returns `Null` and `outputName`
will be `""`).

**`opts` fields** (all optional):

| Option | Type | Description |
|--------|------|-------------|
| `onPrint(line: string)` | callback | Each `Print[]` or similar output line, as it arrives |
| `onMessage(msg: string)` | callback | Each kernel warning/error, as it arrives |
| `onDialogBegin(level: number)` | callback | When `Dialog[]` opens |
| `onDialogPrint(line: string)` | callback | `Print[]` output inside a dialog |
| `onDialogEnd(level: number)` | callback | When the dialog closes |
| `interactive` | `boolean` | **Per-call override** of the session's interactive mode. `true` forces `EnterExpressionPacket` (populates `In`/`Out`); `false` forces `EvaluatePacket` (batch, no history). Omit to use the session default set in the constructor. |

All callbacks fire on the JS main thread before the Promise resolves.  The Promise is
guaranteed not to resolve until all queued callback deliveries have completed.

```js
const r = await session.evaluate('Do[Print[i]; Pause[0.3], {i,1,4}]', {
    onPrint: (line) => console.log('live:', line),  // fires 4 times during eval
});
// r.print is also ['1','2','3','4'] — same data, delivered after eval completes

// Session is interactive (default), but force this one call to be batch (no Out/In side-effects):
const internal = await session.evaluate('VsCodeRenderNth[1, "SVG", 1.0]', { interactive: false });

// Session is batch (default), but force this one call to go through the main loop:
const r2 = await session.evaluate('x = 42', { interactive: true });
console.log(r2.outputName);  // "Out[1]="
console.log(r2.cellIndex);   // 1
```

---

### `sub(expr)`

```ts
session.sub(expr: string): Promise<WExpr>
```

Lightweight evaluation that resolves with just the result `WExpr` (no cell index,
no print/messages arrays).

`sub()` has **higher priority** than `evaluate()`: it always runs before the next
queued `evaluate()`, regardless of arrival order.  If the session is currently busy,
`sub()` waits for the in-flight evaluation to finish, then runs ahead of all other
queued `evaluate()` calls.  Multiple `sub()` calls are ordered FIFO among themselves.

```js
const pid  = await session.sub('$ProcessID');   // { type: 'integer', value: 12345 }
const info = await session.sub('$Version');     // { type: 'string', value: '14.1 ...' }
```

---

### `abort()`

```ts
session.abort(): boolean
```

Interrupt the currently-running `evaluate()` call.  Thread-safe — safe to call from
any callback or timer.

The in-flight `evaluate()` Promise resolves (not rejects) with:
```js
{ aborted: true, result: { type: 'symbol', value: '$Aborted' }, ... }
```

The kernel remains alive after abort.  Subsequent `evaluate()` and `sub()` calls work
normally.

```js
const p = session.evaluate('Do[Pause[0.1], {1000}]');  // ~100 s computation
await sleep(500);
session.abort();       // cancels after ~500 ms
const r = await p;
// r.aborted === true
// r.result  === { type: 'symbol', value: '$Aborted' }
```

---

### `dialogEval(expr)`

```ts
session.dialogEval(expr: string): Promise<WExpr>
```

Evaluate `expr` inside the currently-open `Dialog[]` subsession.  Rejects immediately
if `isDialogOpen` is false.

Returns just the `WExpr` result, not a full `EvalResult`.

> **Important**: kernel global state persists into and out of a dialog.
> Variables set before `Dialog[]` are in scope inside; mutations made with `dialogEval()`
> persist after the dialog closes.

```js
const p = session.evaluate('x = 10; Dialog[]; x^2');
await pollUntil(() => session.isDialogOpen);

const xVal = await session.dialogEval('x');      // { value: 10 }
await session.dialogEval('x = 99');              // mutates kernel state
await session.exitDialog();

const r = await p;  // r.result.value === 9801  (99^2)
```

---

### `exitDialog(retVal?)`

```ts
session.exitDialog(retVal?: string): Promise<null>
```

Close the currently-open `Dialog[]` subsession.

Sends `EnterTextPacket["Return[retVal]"]` — the interactive-REPL packet that the kernel
recognises as "exit the dialog".  This is **not** the same as `dialogEval('Return[]')`,
which uses `EvaluatePacket` and leaves `Return[]` unevaluated.

Resolves with `null` when `EndDialogPacket` is received.
Rejects immediately if `isDialogOpen` is false.

| Call | Effect |
|------|--------|
| `exitDialog()` | `Dialog[]` evaluates to `Null` |
| `exitDialog('42')` | `Dialog[]` evaluates to `42` |
| `exitDialog('myVar')` | `Dialog[]` evaluates to the current value of `myVar` |

```js
// Pattern: open dialog, interact, close with a return value
const p = session.evaluate('result = Dialog[]; result * 2');
await pollUntil(() => session.isDialogOpen);
await session.dialogEval('Print["inside the dialog"]');
await session.exitDialog('21');
const r = await p;  // r.result.value === 42
```

---

### `interrupt()`

```ts
session.interrupt(): boolean
```

Send `WSInterruptMessage` to the kernel (best-effort).  The C++ backend handles the
kernel's `MENUPKT` interrupt-menu response automatically by reading the type+prompt
payload and replying with bare string `"i"` (inspect mode), causing the kernel to open a
`Dialog[]` subsession.  `isDialogOpen` will flip to `true` when `BEGINDLGPKT` arrives.

> The evaluated expression **must** have been started with `onDialogBegin` / `onDialogEnd`
> callbacks for the dialog to be serviced correctly.

```js
// interrupt() — no Wolfram-side handler needed (C++ handles MENUPKT automatically)
// The evaluate() call must include dialog callbacks:
const mainEval = session.evaluate('Do[Pause[0.1], {1000}]', {
    onDialogBegin: () => {},
    onDialogEnd:   () => {},
});
session.interrupt();
await pollUntil(() => session.isDialogOpen);
const val = await session.dialogEval('$Line');
await session.exitDialog();
await mainEval;
```

> Optionally, install a Wolfram-side handler to bypass `MENUPKT` entirely:
> ```js
> await session.evaluate('Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]');
> ```

---

### `createSubsession(kernelPath?)`

```ts
session.createSubsession(kernelPath?: string): WstpSession
```

Launch a completely independent kernel as a new `WstpSession`.  The child has isolated
state (variables, definitions, memory) and must be closed with `child.close()`.

---

### `close()`

```ts
session.close(): void
```

Terminate the kernel process, close the WSTP link, and free all resources.
Idempotent — safe to call multiple times.  After `close()`, calls to `evaluate()` reject
immediately with `"Session is closed"`.

---

### `isOpen` / `isDialogOpen`

```ts
session.isOpen:       boolean  // true while the link is open and the kernel is running
session.isDialogOpen: boolean  // true while inside a Dialog[] subsession
```

---

## `WstpReader`

A reader that **connects to** a named WSTP link created by the kernel (via `LinkCreate`)
and receives expressions pushed from the kernel side (via `LinkWrite`).

Use this when you need real-time data from the kernel while the main link is blocked on a
long evaluation.

### Constructor

```js
const reader = new WstpReader(linkName, protocol?);
```

| Parameter | Type | Default |
|-----------|------|---------|
| `linkName` | `string` | *(required)* — value of `linkObject[[1]]` or `LinkName[linkObject]` on the Wolfram side |
| `protocol` | `string` | `"TCPIP"` |

Throws if the connection fails.  The WSTP handshake (`WSActivate`) is deferred to the
first `readNext()` call, so the constructor never blocks the JS main thread.

### `readNext()`

```ts
reader.readNext(): Promise<WExpr>
```

Block (on the thread pool) until the kernel writes the next expression with `LinkWrite`.
Resolves with the expression as a `WExpr`.

Rejects when the kernel closes the link (`LinkClose[link]`) or the link encounters an error.

### `close()` / `isOpen`

```ts
reader.close(): void
reader.isOpen:  boolean
```

### Full pattern

```wolfram
(* Wolfram side — create a push link *)
$mon = LinkCreate[LinkProtocol -> "TCPIP"];
linkName = $mon[[1]];   (* share this string with the JS side somehow *)

(* Write immediately, then pause (not: pause then write) *)
Do[
    LinkWrite[$mon, {i, randomVal}];
    Pause[0.5],
    {i, 1, 20}
];
Pause[1];               (* give reader time to drain final value *)
LinkClose[$mon];
```

```js
// JS side — connect and read
const reader = new WstpReader(linkName, 'TCPIP');
try {
    while (reader.isOpen) {
        const v = await reader.readNext();
        console.log('received:', JSON.stringify(v));
    }
} catch (e) {
    if (!e.message.includes('closed')) throw e;  // normal link-close rejection
} finally {
    reader.close();
}
```

> **Timing rules for reliable delivery**:
> - Call `LinkWrite[link, expr]` *before* any `Pause[]` after each value.
>   A `Pause` before `LinkWrite` can cause the reader to block inside `WSGetType`, which
>   then races with the simultaneous `LinkClose` on the last value.
> - Add `Pause[1]` before `LinkClose` so the reader receives the final expression before
>   the link-close signal arrives.

---

## `setDiagHandler(fn)`

```ts
setDiagHandler(fn: ((msg: string) => void) | null | undefined): void
```

Register a JS callback that receives internal diagnostic messages from the C++ layer.
The callback fires on the JS main thread.  Pass `null` to clear.

Messages cover:
- `[Session]` — kernel launch, restart attempts, WarmUp results
- `[WarmUp]` — per-attempt `$WARMUP$` probe  
- `[Eval] pkt=N` — every WSTP packet in the evaluation drain loop
- `[TSFN][onPrint] dispatch +Nms "..."` — TSFN call timestamp (compare with your
  JS callback timestamp to measure delivery latency)
- `[WstpReader]` — WSActivate, spin-wait trace, ReadExprRaw result

```js
setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

// Disable:
setDiagHandler(null);
```

**Alternative** — set `DEBUG_WSTP=1` in the environment to write the same messages
directly to `stderr` (no JS handler needed, useful in scripts):

```bash
DEBUG_WSTP=1 node compute.js 2>diag.txt
```

---

## Usage Examples

### Basic evaluation

```js
const { WstpSession } = require('./build/Release/wstp.node');

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';
const session = new WstpSession(KERNEL);

// Simple expression
const r = await session.evaluate('Expand[(a + b)^4]');
console.log(r.result);
// { type: 'function', head: 'Plus', args: [ ... ] }

// Integer result
const n = await session.evaluate('Prime[100]');
console.log(n.result.value);  // 541

// String result
const v = await session.evaluate('"Hello, " <> "World"');
console.log(v.result.value);  // "Hello, World"

session.close();
```

---

### Interactive mode — In/Out history

With `{ interactive: true }` the kernel runs each evaluation through its full main loop,
populating `In[n]`, `Out[n]`, and `%`/`%%` exactly as in a Mathematica notebook.

```js
const session = new WstpSession(KERNEL, { interactive: true });

// Out[n] is populated automatically; cellIndex reflects the kernel's actual $Line
const r1 = await session.evaluate('Prime[10]');
console.log(r1.cellIndex);      // e.g. 1
console.log(r1.outputName);     // "Out[1]="
console.log(r1.result.value);   // 29

// % and %% return last / second-to-last outputs
const r2 = await session.evaluate('42');
const pct = await session.evaluate('%');
console.log(pct.result.value);  // 42

// Out[n] is accessible from later evaluations
const r3 = await session.evaluate('6 * 7');
const arith = await session.evaluate(`Out[${r3.cellIndex}] + 1`);
console.log(arith.result.value);  // 43

// In[n] stores the input; it evaluates to the result of the expression
const r4 = await session.evaluate('2 + 2');
const inVal = await session.sub(`In[${r4.cellIndex}]`);
console.log(inVal.value);  // 4

// Suppressed evaluations (trailing ;) have empty outputName
// but Out[n] is still stored internally by the kernel
const r5 = await session.evaluate('77;');
console.log(r5.outputName);   // ""
console.log(r5.result.value); // "System`Null"
const out5 = await session.sub(`Out[${r5.cellIndex}]`);
console.log(out5.value);       // 77  (stored internally)

// $Line tracks the kernel counter
const line = await session.sub('$Line');
console.log(line.value);  // r5.cellIndex + 1

session.close();
```

---

### Streaming output

Callbacks fire in real time as the kernel produces output, before the Promise resolves.

```js
const lines = [];
const r = await session.evaluate(
    'Do[Print["step " <> ToString[k]]; Pause[0.5], {k, 1, 5}]',
    {
        onPrint:   (line) => { lines.push(line); console.log('[live]', line); },
        onMessage: (msg)  => console.warn('[msg]', msg),
    }
);
// lines === ['step 1', 'step 2', 'step 3', 'step 4', 'step 5']
// r.print === ['step 1', 'step 2', 'step 3', 'step 4', 'step 5']  (same data)
// r.result.value === 'Null'

// Use a promise latch if you need to confirm delivery before acting:
let resolveAll;
const allFired = new Promise(r => resolveAll = r);
let count = 0;
await session.evaluate('Do[Print[i]; Pause[0.2], {i, 4}]', {
    onPrint: () => { if (++count === 4) resolveAll(); }
});
await Promise.race([allFired, timeout(5000)]);
console.assert(count === 4);
```

---

### Concurrent evaluations

All queued evaluations run in strict FIFO order — the link is never corrupted.

```js
// Fire all three at once; results arrive in the same order they were queued.
const [r1, r2, r3] = await Promise.all([
    session.evaluate('Pause[1]; "first"'),
    session.evaluate('Pause[1]; "second"'),
    session.evaluate('Pause[1]; "third"'),
]);
// Total time: ~3 s (serialised, not parallel)
// r1.result.value === 'first', r2.result.value === 'second', etc.
```

---

### Priority `sub()` calls

`sub()` always jumps ahead of queued `evaluate()` calls — ideal for UI queries like
"what is the current value of this variable?" while a long computation is running.

```js
// Start a slow batch job
const batch = session.evaluate('Pause[5]; result = 42');

// While it runs, query progress via sub() — fires after the in-flight eval finishes
// but before any other queued evaluate():
const val = await session.sub('$Version');         // runs next
const pid  = await session.sub('$ProcessID');      // runs after val

await batch;
```

---

### Abort a long computation

```js
// Use Do[Pause[...]] so the kernel checks for abort signals regularly
const p = session.evaluate('Do[Pause[0.1], {1000}]');

await new Promise(r => setTimeout(r, 500));
session.abort();

const r = await p;
console.log(r.aborted);       // true
console.log(r.result.value);  // '$Aborted'

// Session is still alive — keep evaluating
const r2 = await session.evaluate('2 + 2');
console.log(r2.result.value);  // 4
```

---

### Dialog subsessions

`Dialog[]` opens an interactive subsession inside the kernel.  Use `dialogEval()` to
send expressions to it and `exitDialog()` to close it.

```js
// Basic dialog round-trip
const evalDone = session.evaluate('Dialog[]; "finished"', {
    onDialogBegin: (level) => console.log('dialog opened at level', level),
    onDialogEnd:   (level) => console.log('dialog closed at level', level),
});

// Wait for the dialog to open (isDialogOpen flips to true when BEGINDLGPKT arrives)
await pollUntil(() => session.isDialogOpen);

const two = await session.dialogEval('1 + 1');   // { type: 'integer', value: 2 }
const pi  = await session.dialogEval('N[Pi]');   // { type: 'real', value: 3.14159... }

await session.exitDialog();     // sends EnterTextPacket["Return[]"]
const r = await evalDone;       // r.result.value === 'finished'

// exitDialog with a return value
const p2 = session.evaluate('x = Dialog[]; x^2');
await pollUntil(() => session.isDialogOpen);
await session.exitDialog('7');  // Dialog[] returns 7
const r2 = await p2;            // r2.result.value === 49

// dialogEval with Print[] inside
const prints = [];
const p3 = session.evaluate('Dialog[]', {
    onDialogPrint: (line) => prints.push(line),
});
await pollUntil(() => session.isDialogOpen);
await session.dialogEval('Print["hello from the dialog"]');
// Use a promise latch if you need delivery confirmation before exitDialog:
await session.exitDialog();
await p3;
// prints === ['hello from the dialog']
```

> **`dialogEval('Return[]')` does NOT close the dialog.**
> `Return[]` via `EvaluatePacket` is unevaluated at top level — there is no enclosing
> structure to return from.  Only `exitDialog()` (which uses `EnterTextPacket`) truly
> exits the dialog.

---

### Variable monitor — peeking at a running loop

You can inspect the current value of any variable while a long computation runs, without
aborting it.  The trick is to use the `Dialog[]`/interrupt mechanism to pause the kernel
briefly, peek, then resume — all transparent to the running evaluation.

#### How it works

1. `session.interrupt()` posts `WSInterruptMessage` to the kernel.
2. The kernel suspends the running evaluation and sends `MENUPKT` (the interrupt menu).
3. The C++ backend automatically handles `MENUPKT` by reading its type+prompt payload and
   responding with the bare string `"i"` (inspect mode) — no Wolfram-side handler needed.
4. The kernel opens `Dialog[]` inline: sends `TEXTPKT` (option list) → `BEGINDLGPKT` →
   `INPUTNAMEPKT`.  `isDialogOpen` flips to `true` when `INPUTNAMEPKT` arrives.
5. The JS monitor calls `session.dialogEval('i')` to read the current loop variable, then
   `session.exitDialog()` to resume.
6. When the main eval resolves the monitor stops.

> **Wolfram-side interrupt handler (optional):**
> If `Internal\`AddHandler["Interrupt", Function[{}, Dialog[]]]` is installed in
> `init.wl`, the Wolfram handler opens `Dialog[]` directly and the kernel sends
> `BEGINDLGPKT` without going through `MENUPKT`.  Either path works — the C++ backend
> handles both the `MENUPKT` (interrupt-menu) path and the direct `BEGINDLGPKT` path.

#### Prerequisites

No special Wolfram-side configuration is required.  The C++ backend handles `MENUPKT`
automatically.  The evaluated expression **must** be started with `onDialogBegin` /
`onDialogEnd` callbacks so the drain loop is in dialog-aware mode:

```js
// The evaluate() call must include dialog callbacks so the drain loop
// handles BEGINDLGPKT / ENDDLGPKT correctly.
const mainEval = session.evaluate(expr, {
    onDialogBegin: (_level) => {},
    onDialogEnd:   (_level) => {},
});
```

#### Full example

```js
const { WstpSession } = require('./build/Release/wstp.node');
const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';
const session = new WstpSession(KERNEL);

// Helper: poll until predicate returns true or deadline expires
const pollUntil = (pred, intervalMs = 50, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() > deadline) return reject(new Error('pollUntil: timeout'));
            setTimeout(tick, intervalMs);
        };
        tick();
    });

// Step 1: install the interrupt handler
await session.evaluate(
    'Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]'
);

// Step 2: start the long computation — NOT awaited, runs in background
//         evaluate() accepts onDialogBegin/End so the drain loop services dialogs
const mainEval = session.evaluate(
    'Do[i = k; Pause[0.2], {k, 1, 50}]; "done"',
    {
        onDialogBegin: (_level) => { /* optional: log */ },
        onDialogEnd:   (_level) => { /* optional: log */ },
    }
);

// Step 3: variable monitor — peek at `i` every second until mainEval resolves
let running = true;
mainEval.finally(() => { running = false; });

async function monitor() {
    while (running) {
        await new Promise(r => setTimeout(r, 1000));
        if (!running) break;

        // Send WSInterruptMessage → Wolfram handler opens Dialog[]
        const sent = session.interrupt();
        if (!sent) break;  // session closed or idle

        // Wait for BEGINDLGPKT to arrive (C++ sets isDialogOpen = true)
        try {
            await pollUntil(() => session.isDialogOpen, 50, 3000);
        } catch (_) {
            // Dialog didn't open — computation may have already finished
            break;
        }

        // Read current value of the loop variable
        let val;
        try {
            val = await session.dialogEval('i');
        } catch (e) {
            await session.exitDialog().catch(() => {});
            break;
        }
        console.log(`[monitor] i = ${val.value}`);

        // Resume the main evaluation
        await session.exitDialog();
    }
}

await Promise.all([
    mainEval,
    monitor(),
]);

const r = await mainEval;
console.log('final:', r.result.value);  // "done"
session.close();
```

Expected output (approximate — timing depends on CPU load):

```
[monitor] i = 5
[monitor] i = 10
[monitor] i = 15
...
final: done
```

#### Extension implementation note

For a VS Code notebook extension using this backend:

- **No Wolfram-side interrupt handler is required** — the C++ backend handles `MENUPKT`
  automatically by responding with `"i"` (inspect mode).  Optionally, installing
  `Internal\`AddHandler["Interrupt", Function[{}, Dialog[]]]` in `init.wl` bypasses
  `MENUPKT` entirely and sends `BEGINDLGPKT` directly; both paths are supported.
- The ⌥⇧↵ command flow is: `session.interrupt()` → poll `isDialogOpen` → `session
  .dialogEval(cellCode)` → render result as `"Dialog: Out"` in the cell → `session
  .exitDialog()`.
- The `evaluate()` call for the main long computation **must** pass `onDialogBegin`,
  `onDialogPrint`, and `onDialogEnd` callbacks; these wire the C++ `BEGINDLGPKT` /
  `ENDDLGPKT` handlers that drive `isDialogOpen` and the dialog inner loop.
- `dialogEval()` and `exitDialog()` push to `dialogQueue_` in C++, which the drain loop
  on the thread-pool thread services between kernel packets — no second link/thread needed.
- Dialog results from inspect mode are returned as `RETURNTEXTPKT` (OutputForm text) rather
  than `RETURNPKT` (full WL expression); the C++ SDR layer parses these transparently.

---

### Real-time side channel (`WstpReader`)

Use `WstpReader` to receive kernel-pushed data while a long evaluation is running on the
main link.

```js
// Step 1: create the push link inside the kernel and get its name
await session.evaluate('$pushLink = LinkCreate[LinkProtocol -> "TCPIP"]');
const { result: nameExpr } = await session.evaluate('$pushLink[[1]]');
const linkName = nameExpr.value;  // e.g. "60423@127.0.0.1,0@127.0.0.1"

// Step 2: connect the JS reader
const reader = new WstpReader(linkName, 'TCPIP');

// Step 3: start the kernel writer (NOT awaited — runs concurrently)
const bgWriter = session.evaluate(
    'Do[LinkWrite[$pushLink, {i, RandomReal[]}]; Pause[0.5], {i, 1, 10}];' +
    'Pause[1]; LinkClose[$pushLink]; "writer done"'
);

// Step 4: read 10 values in real time
const received = [];
try {
    for (let i = 0; i < 10; i++) {
        const v = await reader.readNext();
        // v = { type: 'function', head: 'List', args: [{value:i}, {value:rand}] }
        received.push(v);
        console.log(`item ${i + 1}:`, v.args[0].value, v.args[1].value);
    }
} finally {
    reader.close();
    try { await bgWriter; } catch (_) {}
}
```

---

### Parallel independent kernels

Each `WstpSession` is an entirely separate process with its own state.

```js
// Launch two kernels in parallel
const [ka, kb] = await Promise.all([
    Promise.resolve(new WstpSession(KERNEL)),
    Promise.resolve(new WstpSession(KERNEL)),
]);

// Run independent computations simultaneously
const [ra, rb] = await Promise.all([
    ka.evaluate('Sum[1/k^2, {k, 1, 10000}]'),
    kb.evaluate('Sum[1/k^3, {k, 1, 10000}]'),
]);

console.log(ra.result);  // Pi^2/6 approximation
console.log(rb.result);  // Apéry's constant approximation

ka.close();
kb.close();
```

---

## Error Handling

| Situation | Behaviour |
|-----------|-----------|
| Syntax error in `expr` | Kernel sends a message; `evaluate()` resolves with `messages: ['...']` and `result: { type: 'symbol', value: 'Null' }` or `'$Failed'` |
| Expression too deep (> 512 nesting levels) | `evaluate()` **rejects** with `"expression too deep"` — the session stays alive |
| Abort | `evaluate()` **resolves** with `aborted: true`, `result.value === '$Aborted'` |
| Kernel crashes | `evaluate()` rejects with a link error message — create a new `WstpSession` |
| `dialogEval()` / `exitDialog()` when no dialog open | Rejects with `"no dialog subsession is open"` |
| `evaluate()` after `close()` | Rejects with `"Session is closed"` |
| `WstpReader.readNext()` after link closes | Rejects with a link-closed error |

```js
// Robust evaluate wrapper
async function safeEval(session, expr) {
    try {
        const r = await session.evaluate(expr);
        if (r.aborted)           return { ok: false, reason: 'aborted' };
        if (r.messages.length)   console.warn('kernel messages:', r.messages);
        return { ok: true, result: r.result };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}
```

---

## Diagnostic Logging

Two mechanisms — both disabled by default, zero overhead when off:

### `setDiagHandler(fn)` — JS callback

```js
const { setDiagHandler } = require('./build/Release/wstp.node');

setDiagHandler((msg) => {
    process.stderr.write(`[${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
});

// Measure TSFN delivery latency:
//   C++ logs: "[TSFN][onPrint] dispatch +142ms ..."
//   Your handler timestamp - 142ms = module load time offset
//   Comparing both gives end-to-end callback delivery time

setDiagHandler(null);  // disable
```

### `DEBUG_WSTP=1` — direct stderr from C++

```bash
DEBUG_WSTP=1 node compute.js 2>diag.txt
cat diag.txt
# [wstp +23ms] [Session] restart attempt 1 — $Output routing broken on previous kernel
# [wstp +1240ms] [WarmUp] $Output routing verified on attempt 1
# [wstp +1503ms] [Eval] pkt=8
# [wstp +1503ms] [Eval] pkt=2
# [wstp +1503ms] [TSFN][onPrint] dispatch +1503ms "step 1"
# ...
```

Timestamps are module-relative milliseconds (since the addon was loaded).
