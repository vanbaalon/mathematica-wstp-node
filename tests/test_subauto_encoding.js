/**
 * test_subauto_encoding.js
 *
 * Verifies that subAuto returns IDENTICAL string values regardless of whether
 * the kernel is idle (EvaluatePacket path) or busy (EnterTextPacket/Dialog path).
 *
 * BUG: The busy path goes through OutputForm which inserts line-continuation
 * escapes (\\\n >) into long strings, corrupting HTML/MathML output.
 *
 * Test expressions of increasing complexity:
 *   1. Short string (no line breaks expected in either path)
 *   2. Medium MathML string (triggers OutputForm wrapping on busy path)
 *   3. Long HTML with special chars (SVG img tag, unicode, nested quotes)
 *
 * Run:
 *   node tests/test_subauto_encoding.js
 *   node tests/test_subauto_encoding.js 2>/dev/null   # suppress C++ diag
 *
 * Expected: all PASS (idle and busy results are byte-identical).
 */

'use strict';

const wstp = require('../build/Release/wstp.node');
const { WstpSession, setDiagHandler } = wstp;

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

// ── diagnostics ──────────────────────────────────────────────────────────
setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[C++ ${ts}] ${msg}\n`);
});

// ── helpers ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms)),
    ]);
}

// Suite watchdog
const watchdog = setTimeout(() => {
    console.log('\nFATAL: suite watchdog expired — force-exiting.');
    process.exit(2);
}, 90_000);
watchdog.unref();

let passed = 0, failed = 0;

async function run(name, fn, timeoutMs = 30_000) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`TEST: ${name}`);
    const t0 = Date.now();
    try {
        await withTimeout(fn(), timeoutMs, name);
        const ms = Date.now() - t0;
        console.log(`  [PASS]  (${ms} ms)`);
        passed++;
    } catch (err) {
        const ms = Date.now() - t0;
        console.log(`  [FAIL]  (${ms} ms)`);
        console.log(`  ERROR: ${err.message}`);
        failed++;
    }
}

/**
 * Show first diff between two strings for diagnostics.
 */
function showDiff(a, b, label) {
    if (a === b) return;
    // Find first differing position
    let pos = 0;
    while (pos < a.length && pos < b.length && a[pos] === b[pos]) pos++;
    const ctx = 40;
    const aSnip = a.slice(Math.max(0, pos - ctx), pos + ctx);
    const bSnip = b.slice(Math.max(0, pos - ctx), pos + ctx);
    console.log(`  ${label} — first diff at char ${pos}:`);
    console.log(`    idle: ...${JSON.stringify(aSnip)}...`);
    console.log(`    busy: ...${JSON.stringify(bSnip)}...`);
    console.log(`    idle length: ${a.length}, busy length: ${b.length}`);
}

// ── Test expressions ─────────────────────────────────────────────────────
// These are Wolfram expressions that return strings of various lengths.
// We use ToString + ExportString patterns to generate predictable HTML-like output.

const TEST_EXPRS = [
    {
        name: 'short string (< 80 chars)',
        // Returns a short string — no line breaking expected
        expr: 'ToString[{1, 2, 3, Pi, E}, InputForm]',
    },
    {
        name: 'medium MathML (~500 chars)',
        // Generates MathML output that would trigger line wrapping
        expr: 'ExportString[Sqrt[x^2 + y^2] / (1 + z), "MathML"]',
    },
    {
        name: 'long string with newlines and special chars',
        // Builds a long string with embedded newlines, quotes, HTML tags
        expr: "StringJoin[Table[\"<div class=\\\"item\\\" id=\\\"r\" <> ToString[i] <> \"\\\">\\n  <math xmlns='http://www.w3.org/1998/Math/MathML'>\\n    <mi>x</mi><mo>+</mo><mn>\" <> ToString[i] <> \"</mn>\\n  </math>\\n</div>\\n\", {i, 20}]]",
    },
    {
        name: 'realistic VsCodeRenderExpr-style HTML',
        // Simulates what VsCodeRenderExpr returns: a div with MathML inside
        expr: "\"<div class=\\\"mathml-output\\\" style=\\\"overflow-x:auto;\\\">\" <> ExportString[{1, 2, 3, x + y, Sqrt[z]}, \"MathML\"] <> \"</div>\"",
    },
    {
        name: 'long no-space alphabetical string (~200 chars)',
        // Pure letters, no spaces — plain space inserted by OutputForm wrapping
        // Fixed by SetOptions[$Output, PageWidth->Infinity] in init.wl
        expr: 'StringJoin[Table[FromCharacterCode[Mod[i, 26] + 97], {i, 200}]]',
    },
    {
        name: 'very long no-space string (~500 chars)',
        // Multiple wrapping points — requires PageWidth->Infinity to fix
        expr: 'StringJoin[Table[FromCharacterCode[Mod[i*7 + 3, 26] + 97], {i, 500}]]',
    },
];

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
    console.log('test_subauto_encoding.js — idle vs busy subAuto string identity\n');

    for (const { name, expr } of TEST_EXPRS) {
        await run(`idle vs busy: ${name}`, async () => {
            // Fresh session for each test to avoid state leakage
            const ts = new WstpSession(KERNEL);
            try {
                // Warm up
                await withTimeout(ts.evaluate('1+1'), 10000, 'warmup');
                // Install Dialog handler
                await withTimeout(
                    ts.evaluate('Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]'),
                    5000, 'install handler'
                );

                // ── Step 1: Get idle result ──────────────────────────────
                const idleResult = await withTimeout(
                    ts.subAuto(expr),
                    10000, 'idle subAuto'
                );
                if (idleResult.error) throw new Error('idle subAuto error: ' + idleResult.error);
                const idleVal = idleResult.value;
                console.log(`  idle result: ${idleVal.length} chars`);

                // Small pause before starting busy eval
                await sleep(500);

                // ── Step 2: Start a long eval to make kernel busy ────────
                const busyEvalP = ts.evaluate('Do[Pause[0.1], {200}]');

                // Wait for eval to start and Dialog[] to be available
                await sleep(2000);

                // ── Step 3: Get busy result ──────────────────────────────
                const busyResult = await withTimeout(
                    ts.subAuto(expr),
                    15000, 'busy subAuto'
                );
                if (busyResult.error) throw new Error('busy subAuto error: ' + busyResult.error);
                const busyVal = busyResult.value;
                console.log(`  busy result: ${busyVal.length} chars`);

                // ── Step 4: Compare ──────────────────────────────────────
                if (idleVal !== busyVal) {
                    showDiff(idleVal, busyVal, 'MISMATCH');
                    throw new Error(
                        `idle (${idleVal.length} chars) !== busy (${busyVal.length} chars)`
                    );
                }
                console.log(`  ✓ identical (${idleVal.length} chars)`);

                // ── Cleanup ──────────────────────────────────────────────
                ts.abort();
                try { await withTimeout(busyEvalP, 5000, 'abort settle'); } catch (_) {}
                await sleep(300);
            } finally {
                ts.close();
            }
        });
    }

    // ── Extra test: side-by-side with explicit PageWidth ─────────────────
    await run('busy with $PageWidth=Infinity workaround', async () => {
        const ts = new WstpSession(KERNEL);
        try {
            await withTimeout(ts.evaluate('1+1'), 10000, 'warmup');
            await withTimeout(
                ts.evaluate('Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]'),
                5000, 'install handler'
            );

            const expr = 'ExportString[Sqrt[x^2 + y^2] / (1 + z), "MathML"]';

            // idle baseline
            const idleR = await withTimeout(ts.subAuto(expr), 10000, 'idle');
            const idleVal = idleR.value;

            await sleep(500);

            // busy — wrap in Block[{$PageWidth = Infinity}, ...]
            const wrappedExpr = 'Block[{$PageWidth = Infinity}, ' + expr + ']';
            const busyEvalP = ts.evaluate('Do[Pause[0.1], {200}]');
            await sleep(2000);

            const busyR = await withTimeout(ts.subAuto(wrappedExpr), 15000, 'busy+pagewidth');
            const busyVal = busyR.value;

            console.log(`  idle: ${idleVal.length} chars, busy+PW: ${busyVal.length} chars`);
            if (idleVal !== busyVal) {
                showDiff(idleVal, busyVal, 'MISMATCH (even with $PageWidth=Infinity)');
                console.log('  NOTE: $PageWidth workaround did NOT fix it');
            } else {
                console.log('  ✓ $PageWidth=Infinity workaround WORKS');
            }

            ts.abort();
            try { await withTimeout(busyEvalP, 5000, 'abort'); } catch (_) {}
            await sleep(300);
        } finally {
            ts.close();
        }
    });

    // ── Summary ──────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Unhandled:', err);
    process.exit(2);
});
