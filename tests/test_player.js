'use strict';
const wstp = require('../build/Release/wstp.node');
const { WstpSession } = wstp;
const KERNEL_PATH = process.argv[2] || '/Applications/Wolfram Engine.app/Contents/Resources/Wolfram Player.app/Contents/MacOS/WolframKernel';

(async () => {
    console.log('Testing launch of:', KERNEL_PATH);
    try {
        const s = new WstpSession(KERNEL_PATH);
        console.log('Launch S1: OK (PID ' + s.kernelPid + ')');
        const s2 = new WstpSession(KERNEL_PATH);
        console.log('Launch S2: OK (PID ' + s2.kernelPid + ')');
        const res = await s.evaluate('1+1');
        console.log('Eval S1 (1+1): ' + res.result.value);
        const res2 = await s2.evaluate('Prime[10]');
        console.log('Eval S2 (Prime[10]): ' + res2.result.value);
        s.close();
        s2.close();
        console.log('Test finished successfully.');
    } catch (e) {
        console.error('FAILED:', e);
        process.exit(1);
    }
})();