# wstp-backend — API Reference

Node.js native addon that connects to a WolframKernel process over WSTP and exposes a
Promise-based JavaScript API.  All blocking I/O runs on the libuv thread pool; the JS event
loop is never stalled.

```js
const { WstpSession, WstpReader, setDiagHandler } = require('./build/Release/wstp.node');
```

---

## Table of Contents

1. [Setup](#setup)
2. [Return types — `WExpr` and `EvalResult`](#return-types)
3. [`WstpSession` — main evaluation session](#wstpsession)
   - [Constructor](#constructor)
   - [`evaluate(expr, opts?)`](#evaluateexpr-opts)
   - [`sub(expr)`](#subexpr)
   - [`abort()`](#abort)
   - [`dialogEval(expr)`](#dialogevalexpr)
   - [`exitDialog(retVal?)`](#exitdialogretval)
   - [`interrupt()`](#interrupt)
   - [`createSubsession(kernelPath?)`](#createsubsessionkernelpath)
   - [`close()`](#close)
   - [`isOpen` / `isDialogOpen`](#isopen--isdialogopen)
4. [`WstpReader` — kernel-pushed side channel](#wstpreader)
5. [`setDiagHandler(fn)`](#setdiaghandlerfn)
6. [Usage examples](#usage-examples)
   - [Basic evaluation](#basic-evaluation)
   - [Streaming output](#streaming-output)
   - [Concurrent evaluations](#concurrent-evaluations)
   - [Priority `sub()` calls](#priority-sub-calls)
   - [Abort a long computation](#abort-a-long-computation)
   - [Dialog subsessions](#dialog-subsessions)
   - [Real-time side channel (`WstpReader`)](#real-time-side-channel-wstpreader)
   - [Parallel independent kernels](#parallel-independent-kernels)
7. [Error handling](#error-handling)
8. [Diagnostic logging](#diagnostic-logging)

---

## Setup

Build the native addon (requires Clang and the Wolfram WSTP SDK):

```bash
cd "WSTP Backend"
bash build.sh
```

Output: `build/Release/wstp.node`

**Default kernel path** (macOS): `/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel`

Pass an explicit path to the `WstpSession` constructor if yours differs.

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
  cellIndex:  number;   // n from "In[n]:=" — increases by 1 each evaluation
  outputName: string;   // "Out[n]=" for non-Null results, "" otherwise
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
const session = new WstpSession(kernelPath?);
```

Launches a `WolframKernel` process, connects over WSTP, and verifies that `$Output` routing
is working.  If the kernel starts with broken output routing (happens on ~20 % of launches)
the constructor automatically kills it and retries up to 3 times.

| Parameter | Type | Default |
|-----------|------|---------|
| `kernelPath` | `string` | `/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel` |

Throws if the kernel cannot be launched or the WSTP link fails to activate.

---

### `evaluate(expr, opts?)`

```ts
session.evaluate(expr: string, opts?: EvalOptions): Promise<EvalResult>
```

Evaluate `expr` in the kernel and return the full result.

`expr` is passed to `ToExpression[]` on the kernel side.  Multiple concurrent calls are
serialised automatically through an internal queue — it is safe to fire them without awaiting.

**`opts` streaming callbacks** (all optional):

| Callback | When it fires |
|----------|---------------|
| `onPrint(line: string)` | Each `Print[]` or similar output line, as it arrives |
| `onMessage(msg: string)` | Each kernel warning/error, as it arrives |
| `onDialogBegin(level: number)` | When `Dialog[]` opens |
| `onDialogPrint(line: string)` | `Print[]` output inside a dialog |
| `onDialogEnd(level: number)` | When the dialog closes |

All callbacks fire on the JS main thread before the Promise resolves.  The Promise is
guaranteed not to resolve until all queued callback deliveries have completed.

```js
const r = await session.evaluate('Do[Print[i]; Pause[0.3], {i,1,4}]', {
    onPrint: (line) => console.log('live:', line),  // fires 4 times during eval
});
// r.print is also ['1','2','3','4'] — same data, delivered after eval completes
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

Send `WSInterruptMessage` to the kernel (best-effort).  Without a Wolfram-side interrupt
handler this is a no-op.  To open an interactive dialog from JS, call `Dialog[]` directly:

```js
// Install a handler in Wolfram that opens a dialog on interrupt:
await session.evaluate('Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]');
// Later, trigger it:
session.interrupt();
await pollUntil(() => session.isDialogOpen);
```

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
