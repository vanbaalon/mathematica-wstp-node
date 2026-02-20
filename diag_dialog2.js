'use strict';
// Verbose dialog diagnostic — check every step.
const { WstpSession } = require('./build/Release/wstp.node');
const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

(async () => {
    const s = new WstpSession(KERNEL_PATH);
    console.log('Session open.');

    // ── Test A: Dialog[]; 42  ────────────────────────────────────────────
    console.log('\n=== Test A: Dialog[]; 42 ===');
    let didEnd = false;
    const pA = s.evaluate('Dialog[]; 42', {
        onDialogBegin: (lv) => console.log(`  [A] onDialogBegin(${lv})`),
        onDialogEnd:   (lv) => { didEnd = true; console.log(`  [A] onDialogEnd(${lv})`); },
    });

    for (let t = 0; t < 500 && !s.isDialogOpen; t++)
        await new Promise(r => setTimeout(r, 10));

    console.log('  isDialogOpen:', s.isDialogOpen);

    if (s.isDialogOpen) {
        // First try a harmless eval inside dialog
        const v = await s.dialogEval('1+1');
        console.log('  dialogEval(1+1):', JSON.stringify(v));  // expect 2

        // Now close with Return[]
        const rv = await s.dialogEval('Return[]');
        console.log('  dialogEval(Return[]):', JSON.stringify(rv));

        // Now wait for the outer eval to resolve (5 s timeout)
        const rA = await Promise.race([
            pA,
            new Promise((_, rj) => setTimeout(() => rj(new Error('evalPromise timeout')), 5000)),
        ]).catch(e => ({ error: e.message }));
        console.log('  final result:', JSON.stringify(rA.result ?? rA));
    } else {
        console.log('  Dialog did not open!');
        await pA.catch(e => console.log('  pA rejected:', e.message));
    }

    console.log('  didEnd:', didEnd);

    // ── Test B: Do[If[i===3,Dialog[]],{i,1,5}]; "done"  ─────────────────
    console.log('\n=== Test B: Do loop with Dialog ===');
    didEnd = false;
    const pB = s.evaluate('Do[If[i===3, Dialog[]], {i, 1, 5}]; "done"', {
        onDialogBegin: (lv) => console.log(`  [B] onDialogBegin(${lv})`),
        onDialogEnd:   (lv) => { didEnd = true; console.log(`  [B] onDialogEnd(${lv})`); },
    });

    for (let t = 0; t < 500 && !s.isDialogOpen; t++)
        await new Promise(r => setTimeout(r, 10));

    console.log('  isDialogOpen:', s.isDialogOpen);

    if (s.isDialogOpen) {
        const i = await s.dialogEval('i');
        console.log('  dialogEval(i):', JSON.stringify(i));   // expect 3

        const rv = await s.dialogEval('Return[]');
        console.log('  dialogEval(Return[]):', JSON.stringify(rv));

        const rB = await Promise.race([
            pB,
            new Promise((_, rj) => setTimeout(() => rj(new Error('evalPromise timeout')), 5000)),
        ]).catch(e => ({ error: e.message }));
        console.log('  final result:', JSON.stringify(rB.result ?? rB));
    } else {
        console.log('  Dialog did not open!');
        await pB.catch(e => console.log('  pB rejected:', e.message));
    }

    console.log('  didEnd:', didEnd);
    s.close();
    console.log('\nDone.');
})();
