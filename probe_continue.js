'use strict';
// Minimal test: interrupt a computation, respond integer 2 (continue), verify eval resumes.
// This confirms integer responses work; if eval resumes, integer 4 (inspect) failed for another reason.

const { WstpSession, setDiagHandler } = require('./build/Release/wstp.node');
const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const session = new WstpSession(KERNEL, { interactive: true });

    console.log('[JS] starting Do loop with Sum (computation, not Pause)');
    // Use Sum instead of Pause to have real computation context
    const mainEval = session.evaluate(
        'Do[iA$$ = k; Sum[1/n, {n, 1, 500}], {k, 1, 200}]; "done"',
        {
            onDialogBegin: (lvl) => console.log(`[JS] onDialogBegin level=${lvl}`),
            onDialogEnd:   (lvl) => console.log(`[JS] onDialogEnd level=${lvl}`),
            onDialogPrint: (line) => console.log(`[JS] onDialogPrint: ${line}`),
        }
    );

    await sleep(600);
    console.log('[JS] sending interrupt');
    session.interrupt();

    // Wait for result
    const result = await Promise.race([
        mainEval.then(r => { console.log('[JS] mainEval done:', JSON.stringify(r && r.result)); return r; }),
        sleep(15000).then(() => { console.log('[JS] 15s timeout — eval did NOT resume'); return null; }),
    ]);

    if (result) {
        console.log('[JS] SUCCESS: the kernel resumed after integer response and eval completed!');
    }
    session.close();
    console.log('[JS] done');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
