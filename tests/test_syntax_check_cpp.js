'use strict';
// Quick standalone test of syntaxCheck() — no kernel needed.
const { syntaxCheck } = require('../build/Release/wstp.node');

const CASES = [
    // --- Valid ---
    ['1 + 1',                          true],
    ['f[{a, b}, (c + d)]',             true],
    ['Do[\n  Print[i];,\n  {i,10}\n]', true],
    ['a[[1,2]]',                       true],
    ['(* outer (* inner *) *) 1',      true],
    ['"hello world"',                  true],
    ['"say \\"hi\\""',                 true],
    ['"hello',                         false],
    ['f[1, 2',                         false],
    ['{1, 2, 3',                       false],
    ['(* hello',                       false],
    ['1 + 1}',                         false],
    ['f[(1, 2])',                       false],
    ['Plot[Sin[x], {x, 0, 10}]',       true],
    ['Integrate[x, {x, 0, 1}',         false],

    // --- Boundary: brackets/braces INSIDE strings must be ignored ---
    ['"f[1, 2"',                        true],   // unclosed [ inside string → valid
    ['"{1, 2, 3"',                      true],   // unclosed { inside string → valid
    ['"}"',                             true],   // unmatched } inside string → valid
    ['"]"',                             true],   // unmatched ] inside string → valid
    ['"("',                             true],   // unmatched ( inside string → valid
    ['"[nested [brackets]]"',           true],   // matched brackets inside string → valid
    ['"line1 [ line2"',                 true],   // bracket across newline in string → valid

    // --- Boundary: brackets/braces INSIDE comments must be ignored ---
    ['(* f[1,2 *) 1',                   true],   // unclosed [ inside comment → valid
    ['(* { unclosed *) x',              true],   // unclosed { inside comment → valid
    ['(* } unmatched *) x',             true],   // unmatched } inside comment → valid
    ['1 (* [ *) + 2',                   true],   // [ inside inline comment → valid
    ['(* nested (* [ { *) *) x',        true],   // brackets inside nested comment → valid

    // --- Boundary: string opened after comment, bracket after string ---
    ['(* comment *) "str" + f[x]',      true],   // all clean
    ['(* comment *) "str[" + f[x]',     true],   // bracket inside string, outer valid
    ['(* comment *) "str[" + f[x',      false],  // outer unclosed [
    ['(* [{ *) f[x] + "}"',             true],   // brackets in comment and string → valid

    // --- Boundary: comment-open sequence (* inside a string ---
    ['"(* not a comment *)"',           true],   // (* inside string → no comment opened
    ['"(*" + 1',                        true],   // (* inside string → no comment opened
    ['1 + "(*" + f[x]',                 true],   // same

    // --- Boundary: quote inside comment ---
    ['(* say "hi" *) 1',                true],   // " inside comment → no string opened
    ['(* " unclosed? *) 1 + 1',         true],   // lone " in comment → valid
];

let pass = 0, fail = 0;
for (const [code, valid] of CASES) {
    const r      = syntaxCheck(code);
    const hasErr = JSON.parse(r).errors.length > 0;
    const ok     = hasErr === !valid;
    console.log((ok ? 'PASS' : 'FAIL'),
                JSON.stringify(code).slice(0, 42).padEnd(44),
                '->', r.slice(0, 80));
    ok ? pass++ : fail++;
}
console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail > 0 ? 1 : 0);
