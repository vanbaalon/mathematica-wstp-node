// =============================================================================
// wstp-backend/monitor_demo.js
//
// Shows three approaches to monitoring a running Wolfram computation in real
// time.  The computation under observation is:
//
//   Do[ i++; Pause[1], {i, 0, N-1} ]   – increments i each second
//
// ── WHY a parallel subsession can't directly spy on the main kernel ─────────
//
// A WSTP subsession is a completely independent WolframKernel process; it has
// its own memory. You cannot query "i in kernel A" from "kernel B" — there is
// no shared address space.
//
// Additionally, while the main kernel is busy inside a Do-loop, its WSTP link
// is occupied: sending a second EvaluatePacket on the same link would be
// ignored / corrupt the link.
//
// ── The three working patterns ───────────────────────────────────────────────
//
//  APPROACH 1  (JS-driven loop)
//    Drive the loop from JS.  Each `session.evaluate('i++')` returns the new
//    value of i to JS immediately.  JS controls the pacing and can read i
//    between any two steps.  No extra kernel or link needed.
//
//  APPROACH 2  (side-channel link via LinkWrite)
//    The kernel creates a named WSTP listener link, hands its name to JS, then
//    runs the Do-loop.  Inside the loop it calls  LinkWrite[$mon, i]  after
//    each step.  A WstpReader in JS receives every value the instant it is
//    written — the two directions are fully independent:
//      · main link  carries EvaluatePacket[Do[...]]  (busy, one-way)
//      · monitor link carries integer values         (streaming, read-only)
//    This is true real-time monitoring of a running kernel.
//
//  APPROACH 3  (shared temp file)
//    Simplest, zero extra protocol: the loop writes i to /tmp/wstp_i.txt each
//    tick; a Node.js setInterval reads the file every 500 ms.  Works well
//    when you don't want to write any C++ addon code.
// =============================================================================

'use strict';

const path = require('path');
const fs   = require('fs');

const { WstpSession, WstpReader } =
    require(path.join(__dirname, '..', 'build', 'Release', 'wstp'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function section(title) {
    console.log('\n' + '═'.repeat(62));
    console.log('  ' + title);
    console.log('═'.repeat(62));
}

// ── pretty-print a typed ExprTree (integers just shown as number) ─────────────
function pp(node) {
    if (!node) return String(node);
    if (node.type === 'integer' || node.type === 'real') return String(node.value);
    if (node.type === 'string')  return `"${node.value}"`;
    if (node.type === 'symbol')  return node.value;
    if (node.type === 'function')
        return `${node.head}[${(node.args || []).map(pp).join(', ')}]`;
    return JSON.stringify(node);
}

// =============================================================================
async function main() {
    const STEPS = 8;   // number of iterations (each sleeps 1 s in the kernel)

    // =========================================================================
    section('APPROACH 1 — JS-driven loop');
    console.log(`
  Instead of sending "Do[i++; Pause[1], {STEPS}]" as a single blocked call,
  drive each step from JS.  After every evaluate() call you receive the
  current value of i and can print, log, or react to it.
`);
    const s1 = new WstpSession();
    await s1.evaluate('i = 0');

    for (let step = 0; step < STEPS; step++) {
        const result = await s1.evaluate('i++; i');   // increment and return
        process.stdout.write(`  step ${step + 1}/${STEPS}  →  i = ${pp(result)}\n`);
        // The 1 s pause is simulated here on the JS side; replace with
        // your real inter-step work if needed.
        await sleep(1000);
    }
    s1.close();
    console.log('  Session closed.\n');


    // =========================================================================
    section('APPROACH 2 — side-channel link (WstpReader + LinkWrite)');
    console.log(`
  The kernel creates a TCPIP WSTP listener link.  A WstpReader in JS connects
  to it.  The Do-loop writes i to the monitor link after each step; JS
  receives every integer the moment it is written, while the main evaluation
  is still running.
`);
    const s2 = new WstpSession();

    // Step A: make the kernel create a listener link and tell us its name.
    // $monLink is a LinkObject["port@host,port@host", id, n].
    // [[1]] extracts the connection-name string directly.
    console.log('  Creating monitor link inside kernel…');
    await s2.evaluate('$monLink = LinkCreate[LinkProtocol -> "TCPIP"]');
    const linkNameExpr = await s2.evaluate('$monLink[[1]]');
    const linkName = linkNameExpr.value;
    if (!linkName) throw new Error('Could not read link name: ' + JSON.stringify(linkNameExpr));
    console.log(`  Monitor link name: ${linkName}`);

    // Step B: connect from JS — constructor is now non-blocking.
    // WSActivate (the WSTP handshake) is deferred to the thread pool
    // inside the first readNext() call, so it runs concurrently with the loop.
    const reader = new WstpReader(linkName, 'TCPIP');
    console.log('  WstpReader opened (handshake deferred to first read).');

    // Step C: start the Do-loop WITHOUT awaiting — it runs on the thread pool.
    // The kernel enters the loop and calls LinkWrite after each Pause[1].
    // This is what allows WSActivate (called inside readNext) to complete:
    // the kernel's WSTP runtime processes the pending connection from the
    // reader as soon as it starts calling LinkWrite.
    const loopDone = s2.evaluate(
        `Do[ i++; LinkWrite[$monLink, i]; Pause[1], {i, 0, ${STEPS - 1}} ]; ` +
        'LinkClose[$monLink]; "loop-done"'
    );

    // Step D: read values as they stream in.
    // The first readNext() also completes the WSActivate handshake on the
    // thread pool — no blocking of the JS event loop at any point.
    console.log('  Reading monitor stream:');
    let received = 0;
    while (received < STEPS) {
        try {
            const val = await reader.readNext();
            process.stdout.write(`  monitor → i = ${pp(val)}\n`);
            received++;
        } catch (err) {
            // Link was closed by the kernel (normal end).
            console.log(`  Monitor link closed: ${err.message}`);
            break;
        }
    }

    // Step E: wait for the main evaluation to finish.
    const loopResult = await loopDone;
    console.log(`  Main eval result: ${pp(loopResult)}`);
    reader.close();
    s2.close();


    // =========================================================================
    section('APPROACH 3 — shared temp file (no addon changes needed)');
    console.log(`
  The loop writes i to /tmp/wstp_i.txt after each step.
  A Node.js setInterval polls the file every 500 ms.
  Simplest option — no extra WSTP infrastructure.
`);
    const POLL_FILE = '/tmp/wstp_monitor_i.txt';
    const s3 = new WstpSession();

    // Start the loop in background.
    const loopDone3 = s3.evaluate(
        `Do[ i++; Export["${POLL_FILE}", i, "Text"]; Pause[1], {i, 0, ${STEPS - 1}} ]; ` +
        '"file-loop-done"'
    );

    // Poll from JS.
    let lastSeen = null;
    const poll = setInterval(() => {
        try {
            const txt = fs.readFileSync(POLL_FILE, 'utf8').trim();
            if (txt !== lastSeen) {
                lastSeen = txt;
                process.stdout.write(`  poll → i = ${txt}\n`);
            }
        } catch (_) { /* file not written yet */ }
    }, 500);

    await loopDone3;
    clearInterval(poll);
    // Final read to catch the last value.
    try {
        process.stdout.write(`  final file value: ${fs.readFileSync(POLL_FILE, 'utf8').trim()}\n`);
    } catch (_) {}
    s3.close();


    // =========================================================================
    section('Summary');
    console.log(`
  ┌──────────────────────────┬────────────┬────────────┬───────────────────┐
  │ Approach                 │ Real-time? │ New addon? │ Notes             │
  ├──────────────────────────┼────────────┼────────────┼───────────────────┤
  │ 1. JS-driven loop        │ yes        │ no         │ JS controls pace  │
  │ 2. WstpReader side chan.  │ yes        │ WstpReader │ true streaming    │
  │ 3. Temp file polling     │ ~500 ms    │ no         │ simplest setup    │
  └──────────────────────────┴────────────┴────────────┴───────────────────┘
`);
}

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exitCode = 1;
});
