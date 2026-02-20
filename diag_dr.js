'use strict';
const { WstpSession } = require('./build/Release/wstp.node');
const fs = require('fs');
const out = (s) => { fs.appendFileSync('/tmp/diag_dialog_out.txt', s + '\n'); process.stdout.write(s + '\n'); };

const s = new WstpSession('/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel');
(async () => {
    out('Session open.');
    let ended = false;

    const p = s.evaluate('Dialog[]; 42', {
        onDialogBegin: (lv) => out('begin ' + lv),
        onDialogEnd:   (lv) => { ended = true; out('end ' + lv); },
    });

    for (let t = 0; t < 500 && !s.isDialogOpen; t++)
        await new Promise(r => setTimeout(r, 10));

    out('isDialogOpen: ' + s.isDialogOpen);

    if (!s.isDialogOpen) { out('Dialog did not open'); process.exit(1); }

    const dlvl = await s.dialogEval('$DialogLevel');
    out('$DialogLevel: ' + JSON.stringify(dlvl));

    const dr = await s.exitDialog();
    out('exitDialog() result: ' + JSON.stringify(dr));

    const r = await Promise.race([
        p,
        new Promise((_, rj) => setTimeout(() => rj(new Error('timeout after 5s')), 5000)),
    ]).catch(e => ({ error: e.message }));
    out('final result: ' + JSON.stringify(r.result ?? r));
    out('onDialogEnd fired: ' + ended);

    s.close();
    out('Done.');
    process.exit(0);
})();
