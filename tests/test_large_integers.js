'use strict';

// ── Large-integer / bignum stress tests ──────────────────────────────────
// Tests the scenario where the kernel returns integers larger than int64.
// 100! has 158 digits — far outside int64 range (max ~9.2 × 10^18).
// The WSTP C++ layer must NOT call WSGetInteger64 for these; it should
// fall back to WSGetString / treat them as strings, or the link breaks.
//
// Test cases:
//   1.  100!          — 158-digit integer
//   2.  1000!         — 2568-digit integer  
//   3.  10^100        — googol
//   4.  2^1000        — 302-digit integer
//   5.  Fibonacci[1000] — large Fibonacci
//   6.  10!           — small integer that MUST still work as integer
//   7.  Range[5]      — list of small integers
//   8.  1+1           — trivial sanity check after all the above
//   9.  {100!, 2^500, "hello", 1.5} — mixed list
//  10.  N[100!, 50]   — arbitrary-precision floating point (large Real)

const wstp = require('../build/Release/wstp.node');
const { WstpSession, setDiagHandler } = wstp;

const KERNEL_PATH = process.env.WSTP_TEST_KERNEL ||
    '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';

setDiagHandler((msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[diag ${ts}] ${msg}\n`);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + (msg || 'assertion failed'));
}

// ── Pretty-print a WExpr result ───────────────────────────────────────────
function describeResult(r) {
    if (!r) return '(null)';
    if (r.type === 'integer') return `Integer(${String(r.value)})`;
    if (r.type === 'real')    return `Real(${String(r.value)})`;
    if (r.type === 'string')  return `String(${JSON.stringify(r.value.slice(0, 80))}${r.value.length > 80 ? '…' : ''})`;
    if (r.type === 'symbol')  return `Symbol(${r.value})`;
    if (r.type === 'function') return `Function(${r.head}, ${r.args?.length ?? 0} args)`;
    return JSON.stringify(r).slice(0, 100);
}

// ── evaluate helper — wraps session.evaluate() with a timeout ────────────
function evaluate(session, expr, timeoutMs = 30000) {
    return Promise.race([
        session.evaluate(expr),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms) for: ${expr}`)), timeoutMs)
        ),
    ]);
}

// ── Run all tests ─────────────────────────────────────────────────────────
async function runTests() {
    console.log(`\n=== Large-Integer WSTP Tests ===`);
    console.log(`Kernel: ${KERNEL_PATH}\n`);

    const session = new WstpSession(KERNEL_PATH);
    await sleep(2000); // let kernel start

    let passed = 0, failed = 0;

    async function test(name, expr, check) {
        process.stdout.write(`  [${String(passed + failed + 1).padStart(2)}] ${name} ... `);
        try {
            const r = await evaluate(session, expr);
            const res = r?.result ?? r;
            const desc = describeResult(res);
            check(res, desc);
            console.log(`PASS  (${desc})`);
            passed++;
        } catch (e) {
            console.log(`FAIL  ${e.message}`);
            failed++;
        }
    }

    // 1. Trivial sanity — must work before and after all big-int tests
    await test('1+1 (sanity before)', '1+1', (r) => {
        assert(r?.type === 'integer' || r?.type === 'string', 'expected integer or string');
    });

    // 2. 10! — small integer that fits in int64 (3628800)
    await test('10! (fits int64)', '10!', (r) => {
        assert(r != null, `got null result`);
        // Should come back as integer or string; either is fine — link must not crash
    });

    // 3. 100! — 158 digits, overflows int64
    await test('100! (158 digits, overflows int64)', '100!', (r, desc) => {
        assert(r != null, `got null — link likely crashed`);
        // Accept any non-error result (string repr or biginteger type)
        assert(r.type !== 'function' || r.head !== '$Failed', `got $Failed`);
    });

    // 4. 1000! — 2568 digits
    await test('1000! (2568 digits)', '1000!', (r) => {
        assert(r != null, 'got null — link crashed');
    });

    // 5. 2^1000 — 302  digits
    await test('2^1000 (302 digits)', '2^1000', (r) => {
        assert(r != null, 'got null — link crashed');
    });

    // 6. 10^100 — googol
    await test('10^100 (googol)', '10^100', (r) => {
        assert(r != null, 'got null — link crashed');
    });

    // 7. Fibonacci[1000]
    await test('Fibonacci[1000]', 'Fibonacci[1000]', (r) => {
        assert(r != null, 'got null — link crashed');
    });

    // 8. N[100!, 50] — arbitrary-precision Real (also large)
    await test('N[100!, 50] (large Real)', 'N[100!, 50]', (r) => {
        assert(r != null, 'got null — link crashed');
        // May come back as real or string; either fine
    });

    // 9. Mixed list {100!, 1.5, "hi", Pi}
    await test('{100!, 1.5, "hi", Pi} (mixed)', '{100!, 1.5, "hi", Pi}', (r) => {
        assert(r != null, 'got null — link crashed');
        assert(r.type === 'function' || r.type === 'string', `expected List or string, got: ${r.type}`);
    });

    // 10. Range[5] — list of small integers
    await test('Range[5] (int list)', 'Range[5]', (r) => {
        assert(r != null, 'got null');
        assert(r.type === 'function' || r.type === 'string', 'expected List function');
    });

    // 11. Sanity check AFTER all big-int evaluations — critical to verify link survived
    await test('1+1 (sanity AFTER)', '1+1', (r) => {
        assert(r?.type === 'integer' || r?.type === 'string', `link broken after big-int tests: got ${r?.type}`);
    });

    // 12. ToString[100!] — the workaround that already works
    await test('ToString[100!] (string workaround)', 'ToString[100!]', (r) => {
        assert(r != null, 'got null');
        assert(r.type === 'string', `expected string, got ${r.type}`);
        assert(r.value.length > 100, `expected 158-char string, got ${r.value.length}`);
    });

    console.log(`\n  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

    try { session.close(); } catch (_) {}
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
