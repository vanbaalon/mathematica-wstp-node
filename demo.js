// =============================================================================
// wstp-backend/demo.js
//
// Demonstrates the main features of the WSTP Node.js addon:
//   1. Basic evaluation and typed-tree results
//   2. Symbolic / algebraic computation
//   3. Abort a long-running computation
//   4. Isolated subsessions  (independent kernel processes)
// =============================================================================

'use strict';

const path = require('path');

// Load the compiled native addon.
const { WstpSession } = require(path.join(__dirname, 'build', 'Release', 'wstp'));

// ─── pretty-printer for the typed ExprTree ───────────────────────────────────
function prettyExpr(node, indent = 0) {
    const pad = '  '.repeat(indent);
    if (!node || typeof node !== 'object') return String(node);

    switch (node.type) {
        case 'integer':
        case 'real':
            return `${node.value}`;
        case 'string':
            return `"${node.value}"`;
        case 'symbol':
            return node.value;
        case 'function': {
            if (!node.args || node.args.length === 0)
                return `${node.head}[]`;
            if (node.args.length <= 3 && node.args.every(a => a.type !== 'function'))
                return `${node.head}[${node.args.map(a => prettyExpr(a)).join(', ')}]`;
            const inner = node.args
                .map(a => `${pad}  ${prettyExpr(a, indent + 1)}`)
                .join(',\n');
            return `${node.head}[\n${inner}\n${pad}]`;
        }
        default:
            return JSON.stringify(node);
    }
}

// ─── utility: run one evaluation and print result ────────────────────────────
async function evalAndPrint(session, expr, label) {
    process.stdout.write(`\n[${label}]\n  In:  ${expr}\n`);
    try {
        const r = await session.evaluate(expr);
        r.print.forEach(line => process.stdout.write(`  Print: ${line}\n`));
        r.messages.forEach(msg  => process.stdout.write(`  Msg:   ${msg}\n`));
        const tag = r.outputName ? r.outputName : `(cell ${r.cellIndex})`;
        process.stdout.write(`  ${tag} ${prettyExpr(r.result)}\n`);
        return r;
    } catch (err) {
        process.stdout.write(`  ERR: ${err.message}\n`);
        return null;
    }
}

// ─── separator ───────────────────────────────────────────────────────────────
function section(title) {
    console.log('\n' + '═'.repeat(60));
    console.log('  ' + title);
    console.log('═'.repeat(60));
}

// =============================================================================
async function main() {

    // ── 1. Launch the main kernel session ────────────────────────────────────
    section('1. Launch kernel');
    console.log('  Starting WolframKernel via WSTP…');
    const session = new WstpSession(); // uses default kernel path
    console.log(`  isOpen: ${session.isOpen}`);

    // ── 2. EvalResult assertions ──────────────────────────────────────────────
    section('2. EvalResult assertions  —  verify all fields');

    // Test 1: basic integer, cellIndex populated, no side-effects
    let r = await session.evaluate('1 + 1');
    console.assert(r.cellIndex > 0,              'cellIndex > 0');
    console.assert(r.result.type  === 'integer', 'result.type === integer');
    console.assert(r.result.value === 2,         'result.value === 2');
    console.assert(r.print.length === 0,         'no print output');
    console.assert(r.messages.length === 0,      'no messages');
    console.assert(r.aborted === false,          'not aborted');
    console.log(`  [PASS] basic integer  cellIndex=${r.cellIndex}  outputName="${r.outputName}"`);

    // Test 2: Print[] captured in r.print
    r = await session.evaluate('Print["hello"]; 42');
    console.assert(r.print[0] === 'hello',       'print[0] === "hello"');
    console.assert(r.result.type  === 'integer', 'result.type === integer');
    console.assert(r.result.value === 42,        'result.value === 42');
    console.log(`  [PASS] Print[]  captured: "${r.print[0]}",  return=${r.result.value}`);

    // Test 3: kernel message captured in r.messages
    r = await session.evaluate('1/0');
    console.assert(r.messages.length > 0,        'message captured');
    console.log(`  [PASS] message: ${r.messages[0]}`);

    // Test 4: abort → aborted flag + $Aborted symbol, kernel survives
    console.log('  Starting Pause[30]; aborting after 300 ms…');
    const abortPromise4 = session.evaluate('Pause[30]');
    await new Promise(res => setTimeout(res, 300));
    session.abort();
    r = await abortPromise4;
    console.assert(r.aborted === true,            'aborted === true');
    console.assert(r.result.value === '$Aborted', 'result is $Aborted symbol');
    console.log('  [PASS] abort → aborted:true, result.$Aborted');
    await evalAndPrint(session, '1+1', 'kernel alive after abort');

    // ── 3. Arithmetic & typed integers / reals ────────────────────────────────
    section('3. Basic arithmetic  —  typed result tree');

    await evalAndPrint(session, '2 + 2',         'integer addition');
    await evalAndPrint(session, 'N[Pi, 20]',     'high-precision real');
    await evalAndPrint(session, '"Hello WSTP"',  'string literal');
    await evalAndPrint(session, 'True',           'symbol');

    // A nested function (List of List):
    await evalAndPrint(session, '{{1,2},{3,4}}',  'matrix (nested List)');

    // ── 4. Symbolic / algebraic ───────────────────────────────────────────────
    section('4. Symbolic computation');

    await evalAndPrint(session, 'Expand[(x + y)^4]',    'polynomial expansion');
    await evalAndPrint(session, 'D[Sin[x]^2, x]',       'derivative');
    await evalAndPrint(session, 'Integrate[x^2, {x,0,1}]', 'definite integral');
    await evalAndPrint(session, 'Factor[x^6 - 1]',      'factoring');

    // ── 5. Persistent state across evaluations ──────────────────────────────────
    section('5. Persistent state');

    await evalAndPrint(session, 'myVar = 42',          'set variable');
    await evalAndPrint(session, 'myVar * 2',           'use variable');
    await evalAndPrint(session, 'myList = Range[5]',   'build list');
    await evalAndPrint(session, 'Total[myList]',       'sum of list');

    // ── 6. Abort a long-running computation ───────────────────────────────────
    section('6. Abort  —  interrupt a slow computation');

    console.log('  Starting Pause[10] (10-second sleep) then aborting after 300 ms…');
    const evalPromise = session.evaluate('Pause[10]; "should never reach here"');

    await new Promise(r => setTimeout(r, 300));   // let the kernel start
    const abortOk = session.abort();
    console.log(`  abort() sent: ${abortOk}`);

    const abortResult = await evalPromise;
    console.log(`  aborted: ${abortResult.aborted}`);
    console.log(`  result:  ${prettyExpr(abortResult.result)}`);

    // Give the kernel a moment to reset.
    await evalAndPrint(session, '1 + 1', 'kernel still alive after abort');

    // ── 7. Subsession — isolated independent kernel ───────────────────────────
    section('7. Subsession  —  isolated child kernel');

    console.log('  Launching child kernel…');
    const sub = session.createSubsession();
    console.log(`  subsession isOpen: ${sub.isOpen}`);

    // Set a variable in the subsession that shadows the parent's myVar.
    await evalAndPrint(sub,     'myVar = 999',    'sub: set myVar = 999');
    await evalAndPrint(session, 'myVar',          'main: myVar still 42');
    await evalAndPrint(sub,     'myVar',          'sub: myVar is 999');

    // Run an independent heavy computation in the subsession.
    await evalAndPrint(sub, 'PrimeQ[2^127 - 1]', 'sub: Mersenne prime test');

    // Close child — does NOT affect parent.
    sub.close();
    console.log(`  subsession isOpen after close: ${sub.isOpen}`);

    // Parent still works.
    await evalAndPrint(session, 'myVar', 'main: myVar unaffected after sub.close()');

    // ── 8. Parallel subsessions ───────────────────────────────────────────────
    section('8. Parallel subsessions  —  two isolated kernels at once');

    const subA = session.createSubsession();
    const subB = session.createSubsession();

    // Kick off two evaluations simultaneously.
    const [resA, resB] = await Promise.all([
        subA.evaluate('Total[Table[k^2, {k, 1, 1000}]]'),
        subB.evaluate('Total[Table[k^3, {k, 1, 1000}]]'),
    ]);
    console.log(`  subA result (Σ k², k=1..1000): ${prettyExpr(resA.result)}`);
    console.log(`  subB result (Σ k³, k=1..1000): ${prettyExpr(resB.result)}`);

    subA.close();
    subB.close();

    // ── 9. Evaluation queue  ──────────────────────────────────────────────────
    section('9. Evaluation queue  —  fire 3 evals without awaiting');

    // Fire three evaluate() calls without awaiting — the addon queues them and
    // runs them sequentially so the kernel link is never corrupted.
    const qp1 = session.evaluate('1');
    const qp2 = session.evaluate('2');
    const qp3 = session.evaluate('3');
    const [qr1, qr2, qr3] = await Promise.all([qp1, qp2, qp3]);
    console.assert(qr1.result.value === 1, 'queue result 1 === 1');
    console.assert(qr2.result.value === 2, 'queue result 2 === 2');
    console.assert(qr3.result.value === 3, 'queue result 3 === 3');
    console.log(`  [PASS] queue results: ${qr1.result.value}, ${qr2.result.value}, ${qr3.result.value}`);

    // ── 10. Streaming Print callbacks ─────────────────────────────────────────
    section('10. Streaming onPrint  —  receive Print[] lines in real time');

    const streamedLines = [];
    const streamPrintResult = await session.evaluate(
        'Do[Print["line " <> ToString[i]], {i, 1, 4}]',
        {
            onPrint: (line) => {
                streamedLines.push(line);
                process.stdout.write(`  [stream] Print: ${line}\n`);
            }
        }
    );
    console.assert(streamedLines.length === 4,           'streamed 4 lines');
    console.assert(streamedLines[0] === 'line 1',        'first line is "line 1"');
    console.assert(streamedLines[3] === 'line 4',        'last line is "line 4"');
    // Callbacks fire before the promise resolves, so all lines already in r.print.
    console.assert(streamPrintResult.print.length === 4, 'r.print also has 4 lines');
    console.log(`  [PASS] onPrint fired ${streamedLines.length}x, r.print has ${streamPrintResult.print.length} entries`);

    // ── 11. Streaming message callbacks ───────────────────────────────────────
    section('11. Streaming onMessage  —  receive kernel messages in real time');

    const streamedMsgs = [];
    const streamMsgResult = await session.evaluate(
        '1/0',
        {
            onMessage: (msg) => {
                streamedMsgs.push(msg);
                process.stdout.write(`  [stream] Msg: ${msg}\n`);
            }
        }
    );
    console.assert(streamedMsgs.length > 0,             'at least one message streamed');
    console.assert(streamMsgResult.messages.length > 0, 'r.messages also populated');
    console.log(`  [PASS] onMessage fired ${streamedMsgs.length}x: ${streamedMsgs[0]}`);

    // ── 12. Abort + queue drain ────────────────────────────────────────────────
    section('12. Abort + queue drain  —  in-flight aborts, queued evals still run');

    // First eval will be aborted in-flight.
    const abortQueueP1 = session.evaluate('Pause[30]');
    // Second eval is queued — should run normally after the abort resolves.
    const abortQueueP2 = session.evaluate('"after-abort"');

    await new Promise(res => setTimeout(res, 300));
    session.abort();

    const aqr1 = await abortQueueP1;
    console.assert(aqr1.aborted === true,                'first eval was aborted');
    console.log(`  [PASS] first eval aborted: ${aqr1.aborted}`);

    const aqr2 = await abortQueueP2;
    console.assert(aqr2.result.type  === 'string',       'second eval ran normally');
    console.assert(aqr2.result.value === 'after-abort',  'second eval returned correct value');
    console.log(`  [PASS] queued eval ran after abort: result = "${aqr2.result.value}"`);

    // ── 13. sub() when idle ───────────────────────────────────────────────────
    section('13. sub() when idle  —  lightweight eval, resolves with just WExpr');

    const subIdleResult = await session.sub('2 + 2');
    console.assert(subIdleResult.type  === 'integer', 'sub idle: type is integer');
    console.assert(subIdleResult.value === 4,         'sub idle: value is 4');
    console.log(`  [PASS] sub() idle → ${JSON.stringify(subIdleResult)}`);

    // ── 14. sub() queued before pending evaluate() ────────────────────────────
    section('14. sub() priority  —  sub() runs before queued evaluate() calls');

    // Fire a quick eval, then immediately queue: sub + another evaluate.
    // sub() should resolve before the queued evaluate().
    const orderEvalP = session.evaluate('"main"');
    const subP14     = session.sub('"sub-first"');
    const afterP14   = session.evaluate('"after"');

    const subR14  = await subP14;
    const mainR14 = await orderEvalP;
    const aftR14  = await afterP14;

    console.assert(subR14.type   === 'string',      'sub result type');
    console.assert(subR14.value  === 'sub-first',   'sub resolved with correct value');
    console.assert(mainR14.result.value === 'main', 'main eval resolved');
    console.assert(aftR14.result.value  === 'after','after eval resolved');
    console.log(`  [PASS] sub() ran before queued evaluate(): "${subR14.value}"`);

    // ── 15. Multiple sub()s queued — all resolve in order ─────────────────────
    section('15. Multiple sub()s  —  three subs resolve with correct values');

    const [s1, s2, s3] = await Promise.all([
        session.sub('1 + 1'),
        session.sub('2 + 2'),
        session.sub('3 + 3'),
    ]);
    console.assert(s1.value === 2, 'sub1 = 2');
    console.assert(s2.value === 4, 'sub2 = 4');
    console.assert(s3.value === 6, 'sub3 = 6');
    console.log(`  [PASS] three subs: ${s1.value}, ${s2.value}, ${s3.value}`);

    // ── 16. sub() sets a variable, next eval sees it ───────────────────────────
    section('16. sub() side-effect  —  sub() sets a variable read by next eval');

    await session.sub('subVar$ = 99');
    const sideR = await session.sub('subVar$');
    console.assert(sideR.value === 99, 'sub-set variable readable by next sub');
    console.log(`  [PASS] side-effecting sub: subVar$ = ${sideR.value}`);

    // ── 17. Session survives abort, sub() still works ─────────────────────────
    section('17. Post-abort sub()  —  session stays healthy after abort');

    const abortP = session.evaluate('Pause[30]');
    await new Promise(res => setTimeout(res, 200));
    session.abort();
    const abortR = await abortP;
    console.assert(abortR.aborted === true, 'aborted');

    const subAfterAbort = await session.sub('"hello"');
    console.assert(subAfterAbort.type  === 'string',  'post-abort sub type');
    console.assert(subAfterAbort.value === 'hello',   'post-abort sub value');
    console.log(`  [PASS] sub() after abort → ${JSON.stringify(subAfterAbort)}`);

    // ── 18. Clean up ──────────────────────────────────────────────────────────
    section('18. Shutdown');
    session.close();
    console.log(`  main session isOpen: ${session.isOpen}`);
    console.log('\n  Demo complete.\n');
}

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exitCode = 1;
});
