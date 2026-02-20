'use strict';
// Quick diagnostic: does Dialog[] actually send BEGINDLGPKT in -wstp mode?
const { WstpSession } = require('./build/Release/wstp.node');
const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

(async () => {
    console.log('Opening session...');
    const s = new WstpSession(KERNEL_PATH);
    console.log('Session open.');

    let didBegin = false;
    let didEnd   = false;

    const p = s.evaluate('Dialog[]; 42', {
        onDialogBegin: (lv) => { didBegin = true; console.log(`  onDialogBegin(level=${lv})`); },
        onDialogEnd:   (lv) => { didEnd   = true; console.log(`  onDialogEnd(level=${lv})`);   },
    });

    // Poll for up to 5 s
    for (let t = 0; t < 500; t++) {
        if (s.isDialogOpen) break;
        await new Promise(r => setTimeout(r, 10));
    }

    console.log('After 5 s poll:');
    console.log('  s.isDialogOpen:', s.isDialogOpen);
    console.log('  didBegin:', didBegin);

    if (s.isDialogOpen) {
        console.log('  Dialog opened — sending dialogEval("Return[]")...');
        const dr = await s.dialogEval('Return[]');
        console.log('  dialogEval result:', JSON.stringify(dr));
        const r = await p;
        console.log('  evaluate result:', JSON.stringify(r.result));
    } else {
        console.log('  Dialog did NOT open — Dialog[] may be a no-op in -wstp mode.');
        // evalPromise may already be resolved if Dialog[] returned synchronously.
        const r = await Promise.race([
            p,
            new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 3000)),
        ]).catch(e => ({ error: e.message }));
        console.log('  evaluate result:', JSON.stringify(r));
    }

    s.close();
    console.log('Done.');
})();
