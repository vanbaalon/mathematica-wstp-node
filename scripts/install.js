/**
 * scripts/install.js
 * Cross-platform build entry point invoked by `npm install` / `npm run build`.
 *
 * macOS / Linux  →  bash build.sh          (direct clang++ path, faster)
 * Windows        →  node-gyp rebuild       (MSVC via binding.gyp)
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const opts = { cwd: root, stdio: 'inherit' };

if (process.platform === 'win32') {
  // On Windows: use node-gyp via the local devDependency.
  // --msvs_version 2022 avoids gyp failing to auto-detect VS via PowerShell
  // (common when execution policy is Restricted or VS was just installed).
  // Falls back gracefully if an older VS is the only one present.
  const mode = process.argv[2] === 'debug' ? '--debug' : '--release';
  try {
    execSync(`npx node-gyp rebuild ${mode} --msvs_version 2022`, opts);
  } catch (_e) {
    // Retry without version pin in case they have VS 2019 etc.
    execSync(`npx node-gyp rebuild ${mode}`, opts);
  }
} else {
  // macOS / Linux: use the hand-crafted bash script (faster, no gyp overhead).
  const arg = process.argv[2] || '';   // '' | 'debug' | 'clean'
  execSync(`bash build.sh ${arg}`, opts);
}
