'use strict';
const {WstpSession, setDiagHandler} = require('../build/Release/wstp.node');
setDiagHandler(() => {});

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

(async () => {
    const s = new WstpSession(KERNEL);
    await s.evaluate('1+1');
    await s.evaluate('Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]');

    // idle result first — no-space string
    const expr = 'StringJoin[Table[FromCharacterCode[Mod[i, 26] + 97], {i, 200}]]';
    const idleR = await s.subAuto(expr);

    // busy
    await new Promise(r => setTimeout(r, 500));
    const p = s.evaluate('Do[Pause[0.1], {200}]');
    await new Promise(r => setTimeout(r, 2000));
    const busyR = await Promise.race([
        s.subAuto(expr),
        new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 15000)),
    ]);

    const iv = idleR.value;
    const bv = busyR.value;

    // Find first diff
    let pos = 0;
    while (pos < iv.length && pos < bv.length && iv[pos] === bv[pos]) pos++;

    console.log('idle len:', iv.length, '  busy len:', bv.length);
    console.log('first diff at pos:', pos);

    const ctx = 20;
    const iSlice = iv.slice(Math.max(0, pos - ctx), pos + ctx);
    const bSlice = bv.slice(Math.max(0, pos - ctx), pos + ctx);
    console.log('\nidle bytes around diff:');
    console.log('  str:', JSON.stringify(iSlice));
    console.log('  hex:', Buffer.from(iSlice).toString('hex'));
    console.log('  dec:', [...Buffer.from(iSlice)].join(' '));

    console.log('\nbusy bytes around diff:');
    console.log('  str:', JSON.stringify(bSlice));
    console.log('  hex:', Buffer.from(bSlice).toString('hex'));
    console.log('  dec:', [...Buffer.from(bSlice)].join(' '));

    // Show the exact continuation bytes
    const contStart = pos;
    let contEnd = pos;
    while (contEnd < bv.length && iv[contEnd - (bv.length - iv.length)] !== bv[contEnd]) contEnd++;
    const cont = bv.slice(contStart, contEnd + 5);
    console.log('\ncontinuation sequence:');
    console.log('  str:', JSON.stringify(cont));
    console.log('  hex:', Buffer.from(cont).toString('hex'));
    console.log('  bytes:', [...Buffer.from(cont)].map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

    s.abort();
    try { await p; } catch(_) {}
    s.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
