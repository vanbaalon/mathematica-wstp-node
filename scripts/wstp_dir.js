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
    const base = process.env.PROGRAMFILES || 'C:\\Program Files';

    // Wolfram products to try, in priority order
    const products = [
      'Wolfram Research\\Wolfram Engine',
      'Wolfram Research\\Mathematica',
      'Wolfram Research\\WolframEngine',
    ];

    for (const product of products) {
      const productDir = path.join(base, product);
      let entries;
      try { entries = fs.readdirSync(productDir); } catch (e) { continue; }

      // Find version subfolders (e.g. "14.2", "13.1") — any dir starting with a digit
      const versions = entries
        .filter(d => {
          if (!/^\d/.test(d)) return false;
          try { return fs.statSync(path.join(productDir, d)).isDirectory(); } catch (e) { return false; }
        })
        .sort()
        .reverse();

      if (!versions.length) {
        // Help diagnose: show what IS there
        process.stderr.write(
          `wstp_dir: found "${productDir}" but no version subfolder.\n` +
          `  Contents: ${entries.join(', ') || '(empty)'}\n`
        );
        continue;
      }

      const wstp = path.join(
        productDir, versions[0],
        'SystemFiles', 'Links', 'WSTP', 'DeveloperKit',
        'Windows-x86-64', 'CompilerAdditions'
      );
      if (!fs.existsSync(path.join(wstp, 'wstp.h')) &&
          !fs.existsSync(path.join(wstp, 'wstp64i4s.lib'))) {
        process.stderr.write(
          `wstp_dir: found version "${versions[0]}" but WSTP DeveloperKit missing.\n` +
          `  Expected these files inside:\n` +
          `    ${wstp}\n` +
          `      wstp.h          (C header)\n` +
          `      wstp64i4s.lib   (static import library)\n`
        );
        continue;
      }
      return wstp;
    }

    throw new Error(
      `WSTP DeveloperKit not found.\n` +
      `Searched under "${base}" for: ${products.join(', ')}\n\n` +
      `The build needs these two files:\n` +
      `  wstp.h          (C header)\n` +
      `  wstp64i4s.lib   (static import library)\n\n` +
      `Run the diagnostic script to find them:\n` +
      `  powershell -ExecutionPolicy Bypass -File scripts\\diagnose-windows.ps1\n\n` +
      `Then set WSTP_DIR to the folder containing both files and retry:\n` +
      `  set WSTP_DIR=C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.2\\SystemFiles\\Links\\WSTP\\DeveloperKit\\Windows-x86-64\\CompilerAdditions\n` +
      `  npm install`
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
