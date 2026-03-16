'use strict';
// Probe: what packets does the kernel send after 'i' (inspect) to the interrupt menu?
// Logs every packet type and content for 10 seconds after 'i' is chosen.

const { WstpSession, setDiagHandler } = require('./build/Release/wstp.node');
const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

// We'll attach our own drain via raw session data by temporarily NOT calling dialogEval.
// Instead, we just monitor isDialogOpen and dump logs.

setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const session = new WstpSession(KERNEL, { interactive: true });

    // Install NO interrupt handler — let the pure interrupt-menu mechanism operate.
    // We'll test: interrupt → 'i' → ??? what comes next?

    // Start a loop
    let dialogOpened = false;
    const mainEval = session.evaluate(
        'Do[iA$$ = k; Pause[0.15], {k, 1, 200}]; "done"',
        {
            onDialogBegin: (lvl) => { console.log(`[JS] onDialogBegin level=${lvl}`); dialogOpened = true; },
            onDialogEnd:   (lvl) => { console.log(`[JS] onDialogEnd level=${lvl}`); },
            onDialogPrint: (line) => { console.log(`[JS] onDialogPrint: ${line}`); },
        }
    );

    await sleep(600);
    console.log('[JS] sending interrupt');
    session.interrupt();

    // Poll for isDialogOpen for 15 seconds
    const start = Date.now();
    while (Date.now() - start < 15000) {
        if (session.isDialogOpen) {
            console.log('[JS] isDialogOpen = TRUE!');
            break;
        }
        await sleep(100);
    }
    if (!session.isDialogOpen) {
        console.log('[JS] isDialogOpen never became true after 15s');
    } else {
        // Dialog is open — call dialogEval to evaluate an expression
        console.log('[JS] calling dialogEval("iA$$")');
        await sleep(300); // let the TEXTPKT drain first
        try {
            const dlgResult = await Promise.race([
                session.dialogEval('iA$$'),
                sleep(8000).then(() => ({ result: { type: 'timeout' } }))
            ]);
            console.log('[JS] dialogEval result:', JSON.stringify(dlgResult && dlgResult.result));
        } catch(e) {
            console.log('[JS] dialogEval error:', e.message);
        }
    }

    // In any case, wait for mainEval to finish or timeout
    await Promise.race([
        mainEval.then(r => console.log('[JS] mainEval done:', JSON.stringify(r && r.result))),
        sleep(5000).then(() => console.log('[JS] 5s timeout'))
    ]);
    session.close();
    console.log('[JS] session closed');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
