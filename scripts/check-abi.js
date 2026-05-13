/**
 * check-abi.js
 * Verifies the ABI of the rebuilt wstp.node matches the expected Electron
 * version and that the prebuilt has been copied to the wolfbook extension
 * directory.
 *
 * Usage:
 *   WSTP_EXPECTED_ABI=140 node scripts/check-abi.js
 *   node scripts/check-abi.js 140
 *
 * The expected ABI is taken from (in order):
 *   1. $WSTP_EXPECTED_ABI environment variable
 *   2. process.argv[2]
 *   3. default 140  (ABI 140 = Electron 39.x = VS Code 1.109+ / Code-OSS 1.117+)
 *
 * Exit:  0 on MATCH + EXISTS, 1 on MISMATCH or MISSING.
 *
 * Reads:  build/config.gypi (variables.node_module_version)
 *         ../wolfbook/wstp/prebuilt/wstp-linux-x64.node (existence)
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const EXPECTED_ABI = Number(
    process.env.WSTP_EXPECTED_ABI || process.argv[2] || 140
);
if (!Number.isFinite(EXPECTED_ABI) || EXPECTED_ABI <= 0) {
    console.error('check-abi: invalid EXPECTED_ABI value');
    process.exit(2);
}

const configPath   = path.join(__dirname, '../build/config.gypi');
const prebuiltPath = path.join(__dirname,
    '../../wolfbook/wstp/prebuilt/wstp-linux-x64.node');

let builtAbi;
try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw.replace(/#.*$/mg, ''));
    builtAbi = json.variables.node_module_version;
} catch (e) {
    console.error('ERROR: cannot read build/config.gypi:', e.message);
    process.exit(1);
}

const prebuiltExists = fs.existsSync(prebuiltPath);

const match = (Number(builtAbi) === EXPECTED_ABI);
console.log(`build/Release/wstp.node  ABI: ${builtAbi} | expected: ${EXPECTED_ABI} | ${match ? 'MATCH' : 'MISMATCH'}`);
console.log(`wolfbook prebuilt:        ${prebuiltExists ? 'EXISTS' : 'MISSING'} (${prebuiltPath})`);
if (!match) {
    console.error('FAIL: ABI mismatch — rebuild did not target the expected Electron version');
    process.exit(1);
}
if (!prebuiltExists) {
    console.error('FAIL: prebuilt not copied yet');
    process.exit(1);
}
console.log('OK: ABI match confirmed, prebuilt in place');
