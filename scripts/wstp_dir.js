/**
 * wstp_dir.js
 * Cross-platform helper used by binding.gyp to locate the WSTP DeveloperKit.
 *
 * Usage in binding.gyp:  "wstp_dir%": "<!@(node scripts/wstp_dir.js)"
 *
 * Precedence:
 *   1. WSTP_DIR environment variable  (always wins)
 *   2. Platform-specific auto-detect below
 */

'use strict';

const path = require('path');
const fs   = require('fs');

function resolve () {
  // ── 1. Explicit override ────────────────────────────────────────────────
  if (process.env.WSTP_DIR) {
    return process.env.WSTP_DIR;
  }

  // ── 2. Windows ──────────────────────────────────────────────────────────
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\Wolfram Research\\Wolfram Engine';
    let versions;
    try {
      versions = fs.readdirSync(base)
        .filter(d => /^\d/.test(d))
        .sort()
        .reverse();
    } catch (e) {
      throw new Error(
        `WSTP DeveloperKit not found at "${base}".\n` +
        `Install Wolfram Engine or set WSTP_DIR to the CompilerAdditions folder.`
      );
    }
    if (!versions.length) throw new Error(`No Wolfram Engine version found under "${base}"`);
    return path.join(
      base, versions[0],
      'SystemFiles', 'Links', 'WSTP', 'DeveloperKit',
      'Windows-x86-64', 'CompilerAdditions'
    );
  }

  // ── 3. macOS ────────────────────────────────────────────────────────────
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    const machine = execSync('uname -m').toString().trim();
    const archDir  = machine === 'arm64' ? 'MacOSX-ARM64' : 'MacOSX-x86-64';
    return path.join(
      '/Applications/Wolfram 3.app/Contents/SystemFiles/Links/WSTP/DeveloperKit',
      archDir, 'CompilerAdditions'
    );
  }

  // ── 4. Linux ────────────────────────────────────────────────────────────
  {
    const { execSync } = require('child_process');
    const machine = execSync('uname -m').toString().trim();
    const archDir  = machine === 'aarch64' ? 'Linux-ARM64' : 'Linux-x86-64';
    const candidates = [
      path.join(process.env.HOME || '/root', 'Wolfram', 'WolframEngine',
                'SystemFiles', 'Links', 'WSTP', 'DeveloperKit', archDir, 'CompilerAdditions'),
      path.join('/usr/local/Wolfram/WolframEngine',
                'SystemFiles', 'Links', 'WSTP', 'DeveloperKit', archDir, 'CompilerAdditions'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error(
      'WSTP DeveloperKit not found for Linux.\n' +
      'Set WSTP_DIR to the CompilerAdditions directory.'
    );
  }
}

process.stdout.write(resolve());
