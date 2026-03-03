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
  // npx picks up the node-gyp installed in node_modules/.bin.
  const mode = process.argv[2] === 'debug' ? '--debug' : '--release';
  execSync(`npx node-gyp rebuild ${mode}`, opts);
} else {
  // macOS / Linux: use the hand-crafted bash script (faster, no gyp overhead).
  const arg = process.argv[2] || '';   // '' | 'debug' | 'clean'
  execSync(`bash build.sh ${arg}`, opts);
}
