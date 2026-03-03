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
    const pf   = process.env.PROGRAMFILES        || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA        || '';

    // All candidate root directories to search under
    const searchRoots = [
      path.join(pf,   'Wolfram Research'),
      path.join(pf86, 'Wolfram Research'),
      local ? path.join(local, 'Programs', 'Wolfram Research') : null,
    ].filter(Boolean);

    // Product subfolder names to try
    const productNames = ['Mathematica', 'Wolfram Engine', 'WolframEngine'];

    for (const root of searchRoots) {
      let rootEntries;
      try { rootEntries = fs.readdirSync(root); } catch (e) { continue; }

      for (const product of productNames) {
        const productDir = path.join(root, product);
        let entries;
        try { entries = fs.readdirSync(productDir); } catch (e) { continue; }

        // Skip if this looks like WSL rather than a Wolfram product
        if (entries.includes('wsl.exe') || entries.includes('wslservice.exe')) {
          process.stderr.write(
            `wstp_dir: skipping "${productDir}" — looks like WSL, not Wolfram\n`
          );
          continue;
        }

        // Find version subfolders (e.g. "14.2", "13.1") — dirs starting with a digit
        const versions = entries
          .filter(d => {
            if (!/^\d/.test(d)) return false;
            try { return fs.statSync(path.join(productDir, d)).isDirectory(); } catch (e) { return false; }
          })
          .sort()
          .reverse();

        if (!versions.length) {
          process.stderr.write(
            `wstp_dir: "${productDir}" has no version subfolder — skipping\n` +
            `  Contents: ${entries.join(', ')}\n`
          );
          continue;
        }

        const wstp = path.join(
          productDir, versions[0],
          'SystemFiles', 'Links', 'WSTP', 'DeveloperKit',
          'Windows-x86-64', 'CompilerAdditions'
        );

        const hasHeader = fs.existsSync(path.join(wstp, 'wstp.h'));
        const hasLib    = fs.existsSync(path.join(wstp, 'wstp64i4s.lib'));

        if (!hasHeader || !hasLib) {
          process.stderr.write(
            `wstp_dir: found version "${versions[0]}" but WSTP DeveloperKit missing.\n` +
            `  Expected both files inside:\n` +
            `    ${wstp}\n` +
            `      wstp.h          (C header)   — ${hasHeader ? 'FOUND' : 'MISSING'}\n` +
            `      wstp64i4s.lib   (import lib)  — ${hasLib    ? 'FOUND' : 'MISSING'}\n`
          );
          continue;
        }

        return wstp;
      }
    }

    throw new Error(
      `WSTP DeveloperKit not found on Windows.\n\n` +
      `The build requires two files from the Wolfram Engine / Mathematica installation:\n` +
      `  wstp.h          (C header)\n` +
      `  wstp64i4s.lib   (static import library)\n\n` +
      `These live inside:\n` +
      `  <WolframEngine>\\<version>\\SystemFiles\\Links\\WSTP\\DeveloperKit\\Windows-x86-64\\CompilerAdditions\\\n\n` +
      `Run the diagnostic to find them:\n` +
      `  powershell -ExecutionPolicy Bypass -File scripts\\diagnose-windows.ps1\n\n` +
      `Then set WSTP_DIR and retry:\n` +
      `  set WSTP_DIR=<path shown above>\n` +
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
