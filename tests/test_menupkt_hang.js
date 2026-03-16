'use strict';
// Reproduces the cell-3 hang:
// evaluate('n=1', { onDialogBegin: ()=>{} }) + interrupt at +800ms
// With dynAutoMode=false (0.6.1 default) + hasOnDialogBegin=true
// -> C++ responds 'i' to MENUPKT -> hangs on Wolfram 3/ARM64

const { WstpSession, setDiagHandler } = require('./build/Release/wstp.node');
const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

setDiagHandler(msg => process.stderr.write(`[diag] ${msg}\n`));

function withTimeout(p, ms, label) {
    return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms))]);
}

async function main() {
    const s = new WstpSession(KERNEL);
    console.log('Session open, PID:', s.kernelPid);

    // Mimic checkout.js setup evaluates (interactive:false, rejectDialog:true)
    await s.evaluate(
        'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]',
        { interactive: false, rejectDialog: true }
    );
    console.log('interrupt handler installed');

    // Mimic subs 0-3 (semicoloned, no output) — WITH empty onDialogBegin as checkout.js does
    for (const expr of ['x1=1;', 'x2=2;', 'x3=3;', 'dd=dddddddd;']) {
        await s.evaluate(expr, { onDialogBegin: () => {}, onDialogEnd: () => {} });
    }
    console.log('subs 0-3 done');

    // ---- TEST A: WITH empty onDialogBegin (current checkout.js behavior) ----
    // hasOnDialogBegin=true -> C++ responds 'i' to MENUPKT -> HANGS on ARM64
    console.log('\n--- TEST A: WITH empty onDialogBegin (current broken behavior) ---');
    console.log('Starting evaluate("n=1", { onDialogBegin: ()=>{} }) ...');
    const t0 = Date.now();
    const pA = s.evaluate('n=1', { onDialogBegin: () => {}, onDialogEnd: () => {} });

    setTimeout(() => {
        console.log(`  interrupt at +${Date.now() - t0}ms`);
        s.interrupt();
    }, 800);

    try {
        const r = await withTimeout(pA, 5000, 'n=1 with onDialogBegin');
        console.log(`PASS: dt=${Date.now() - t0}ms | result: ${r.result?.value}`);
    } catch (e) {
        console.log(`FAIL (${e.message}) -- REPRODUCED THE HANG`);
        // Restart session for next test
        s.close();
        console.log('Session closed. Starting new session for TEST B...\n');

        const s2 = new WstpSession(KERNEL);
        await s2.evaluate(
            'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]',
            { interactive: false, rejectDialog: true }
        );
        for (const expr of ['x1=1;', 'x2=2;', 'x3=3;', 'dd=dddddddd;']) {
            await s2.evaluate(expr);
        }

        // ---- TEST B: WITHOUT onDialogBegin (the fix) ----
        // hasOnDialogBegin=false -> C++ responds 'c' to MENUPKT -> no hang
        console.log('--- TEST B: WITHOUT onDialogBegin (the fix) ---');
        console.log('Starting evaluate("n=1", {}) ...');
        const t1 = Date.now();
        const pB = s2.evaluate('n=1');
        setTimeout(() => {
            console.log(`  interrupt at +${Date.now() - t1}ms`);
            s2.interrupt();
        }, 800);
        try {
            const r2 = await withTimeout(pB, 5000, 'n=1 without onDialogBegin');
            console.log(`PASS: dt=${Date.now() - t1}ms | result: ${r2.result?.value}`);
        } catch (e2) {
            console.log(`FAIL (${e2.message})`);
        }
        s2.close();
        return;
    }

    // ---- TEST B (same session, if TEST A passed unexpectedly) ----
    console.log('\n--- TEST B: WITHOUT onDialogBegin ---');
    const t1 = Date.now();
    const pB = s.evaluate('m=2');
    setTimeout(() => {
        console.log(`  interrupt at +${Date.now() - t1}ms`);
        s.interrupt();
    }, 800);
    try {
        const r2 = await withTimeout(pB, 5000, 'm=2 without onDialogBegin');
        console.log(`PASS: dt=${Date.now() - t1}ms | result: ${r2.result?.value}`);
    } catch (e) {
        console.log(`FAIL (${e.message})`);
    }

    s.close();
    console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
