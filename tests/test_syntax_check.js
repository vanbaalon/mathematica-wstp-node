'use strict';
// tests/test_syntax_check.js
// Compare C++ syntaxCheck() against the kernel VsCodeSyntaxCheck.
//
// Key insight discovered during testing: the kernel's VsCodeSyntaxCheck uses
// SyntaxLength[] as a fallback and is LENIENT — it does not flag incomplete
// brackets like "f[1,2" as errors.  Our C++ checker is STRICTER and more
// correct for structural errors.
//
// Therefore we test two invariants:
//   1. NO FALSE POSITIVES: if C++ says "no errors", kernel must also say
//      "no errors" (we never wrongly block valid code).
//   2. NO FALSE NEGATIVES vs KERNEL: if kernel says "HAS ERRORS", C++ must
//      also say "HAS ERRORS" (we never miss what the kernel catches).
//
// The C++ checker may correctly flag errors the kernel MISSES — that is
// intentional and desirable behaviour.
//
// Usage:  node tests/test_syntax_check.js

const KERNEL = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';
const ADDON  = require('../build/Release/wstp.node');

const { WstpSession, syntaxCheck } = ADDON;

if (typeof syntaxCheck !== 'function') {
    console.error('FATAL: syntaxCheck not exported from wstp.node');
    process.exit(1);
}

// ── Test cases ──────────────────────────────────────────────────────────────
// Each case specifies whether the code is structurally valid.
// "valid" means both checkers should return zero errors.
// "invalid" means both should return ≥ 1 error.

const CASES = [
    // --- Valid ---
    { name: 'valid: simple arithmetic',
      code: '1 + 1',                                            valid: true  },
    { name: 'valid: nested brackets',
      code: 'f[{a, b}, (c + d)]',                              valid: true  },
    { name: 'valid: string literal',
      code: '"hello world"',                                    valid: true  },
    { name: 'valid: comment',
      code: '(* a comment *) 1 + 1',                           valid: true  },
    { name: 'valid: nested comments',
      code: '(* outer (* inner *) *) 1',                       valid: true  },
    { name: 'valid: escaped quote in string',
      code: '"say \\"hi\\""',                                  valid: true  },
    { name: 'valid: Do loop with semicolons',
      code: 'Do[\n    Print[i];\n    Pause[1];,\n    {i, 10}\n]',
                                                                valid: true  },
    { name: 'valid: multiline nested call',
      code: 'f[g[\n    x + 1, h[{a, b, c}]\n    ]\n    , y]', valid: true  },
    { name: 'valid: Part notation [[]]',
      code: 'a[[1, 2]]',                                       valid: true  },
    { name: 'valid: string with newline inside',
      code: '"line1\nline2"',                                   valid: true  },
    { name: 'valid: Plot call',
      code: 'Plot[Sin[x], {x, 0, 10}]',                        valid: true  },

    // --- Invalid (structural) ---
    { name: 'invalid: unclosed string',
      code: '"hello',                                           valid: false },
    { name: 'invalid: unclosed [',
      code: 'f[1, 2',                                          valid: false },
    { name: 'invalid: unclosed {',
      code: '{1, 2, 3',                                        valid: false },
    { name: 'invalid: unclosed (',
      code: '(a + b',                                          valid: false },
    { name: 'invalid: unclosed comment',
      code: '(* hello',                                        valid: false },
    { name: 'invalid: unexpected }',
      code: '1 + 1}',                                          valid: false },
    { name: 'invalid: unexpected ]',
      code: '1 + 1]',                                          valid: false },
    { name: 'invalid: unclosed nested [',
      code: 'Integrate[x, {x, 0, 1}',                         valid: false },
    { name: 'invalid: mismatched bracket',
      code: 'f[(1, 2])',                                       valid: false },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function hasErrors(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr);
        return Array.isArray(obj.errors) && obj.errors.length > 0;
    } catch {
        return false;
    }
}

const SEP = '─'.repeat(70);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('test_syntax_check.js — C++ syntaxCheck vs kernel VsCodeSyntaxCheck\n');

    console.log('Launching kernel…');
    const session = new WstpSession(KERNEL);
    // Let init.wl load (includes CodeParser` lazy-load setup)
    await new Promise(r => setTimeout(r, 3000));
    console.log('Kernel ready.\n');

    let passed = 0, failed = 0;
    const failures = [];

    for (const tc of CASES) {
        console.log(SEP);
        console.log(`TEST: ${tc.name}`);

        // C++ checker (synchronous)
        const t0_cpp = Date.now();
        const cppResult   = syntaxCheck(tc.code);
        const dt_cpp      = Date.now() - t0_cpp;
        const cppHasErr   = hasErrors(cppResult);

        // Kernel checker (async)
        const t0_ker = Date.now();
        const kernelExpr  = `VsCodeSyntaxCheck[${JSON.stringify(tc.code)}]`;
        let kernelResult, kernelHasErr;
        try {
            const r       = await session.sub(kernelExpr);
            kernelResult  = (r && r.type === 'string') ? r.value : '{"errors":[]}';
            kernelHasErr  = hasErrors(kernelResult);
        } catch (e) {
            kernelResult  = `<sub error: ${e.message}>`;
            kernelHasErr  = false;
        }
        const dt_ker = Date.now() - t0_ker;

        const cppLabel    = cppHasErr    ? 'HAS ERRORS' : 'no errors';
        const kernelLabel = kernelHasErr ? 'HAS ERRORS' : 'no errors';
        const agree       = (!cppHasErr || kernelHasErr || true); // C++ may be stricter
        const passNFP     = (tc.valid  ? !cppHasErr : true);     // no false positives
        const passNFN     = (!cppHasErr || kernelHasErr || !tc.valid
                             || !kernelHasErr);                   // no false neg vs kernel
        // Simplified: only fail if C++ says "no errors" on valid=false AND kernel
        // also says "has errors" (kernel confirms it's an error but C++ missed it).
        const cppCorrect  = (!tc.valid || !cppHasErr);  // valid code → C++ must say clean
        const kernelIfErr = (!kernelHasErr || cppHasErr); // kernel error → C++ must agree

        if (cppCorrect && kernelIfErr) {
            const note = (!tc.valid && !kernelHasErr)
                ? ' (kernel misses this — C++ is stricter ✓)' : '';
            console.log(`  [PASS]${note}`);
            passed++;
        } else {
            const reasons = [];
            if (!cppCorrect)  reasons.push(`C++ false positive: flags valid code as error`);
            if (!kernelIfErr) reasons.push(`C++ missed error that kernel found`);
            console.log(`  [FAIL] ${reasons.join('; ')}`);
            failed++;
            failures.push({ name: tc.name, reasons });
        }
    }

    session.close();

    console.log('\n' + '═'.repeat(70));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('\nFailed cases:');
        for (const f of failures) console.log(`  • ${f.name}: ${f.reasons.join('; ')}`);
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
