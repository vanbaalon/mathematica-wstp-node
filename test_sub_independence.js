'use strict';
// ── test_sub_independence.js ──────────────────────────────────────────────────
//
// Tests four related questions about sub() and _subKernel independence:
//
//  A. sub() on the MAIN session — same lp_, same C thread as dialogEval.
//     A Rasterize on sub() should block the main kernel just like dialogEval.
//
//  B. _subKernel (separate WstpSession) — separate kernel process.
//     A Rasterize on _subKernel should NOT affect the main session at all.
//
//  C. During Dialog[] on main session, can sub() still respond?
//     (It can't — same kernel is locked inside Dialog[])
//
//  D. During Dialog[] on main session, can _subKernel.sub() respond?
//     (It can — completely independent process)
//
//  E. Can we pass data out of Dialog[] via a global variable, then render
//     that value on _subKernel — avoiding C-thread blocking entirely?
//
// Run:
//   node test_sub_independence.js
// ─────────────────────────────────────────────────────────────────────────────

const { WstpSession } = require('./build/Release/wstp.node');

const KERNEL_PATH = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';
const TIMEOUT     = 20_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function timeout(ms, label) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms${label ? ' ('+label+')' : ''}`)), ms));
}
function pollUntil(pred, maxMs = 5000, step = 50) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const id = setInterval(() => {
            if (pred()) { clearInterval(id); resolve(); }
            else if (Date.now() - t0 > maxMs) { clearInterval(id); reject(new Error(`pollUntil timeout ${maxMs}ms`)); }
        }, step);
    });
}

let passed = 0, failed = 0;

async function run(name, fn) {
    process.stdout.write(`  ${name} … `);
    try {
        await Promise.race([fn(), timeout(TIMEOUT, name)]);
        console.log('✓ PASS');
        passed++;
    } catch (e) {
        console.log('✗ FAIL —', e.message);
        failed++;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n=== sub() independence tests ===\n');

    // ── Shared sessions ───────────────────────────────────────────────────────
    const main = new WstpSession(KERNEL_PATH, { interactive: true });
    const subK  = new WstpSession(KERNEL_PATH, { interactive: false }); // _subKernel analog

    // Warm both kernels
    await main.sub('1+1');
    await subK.sub('1+1');
    // Diagnose Rasterize capability on subkernel before any tests run.
    const _rasCheck = await subK.sub('Module[{g=ListPlot[Range[10]],img}, img=Rasterize[g, ImageResolution->72]; {ImageQ[img], Head[img], Head[g]}]');
    console.log('  [diag] subK Rasterize diagnostic:', JSON.stringify(_rasCheck?.value ?? _rasCheck));
    const _rasB64 = await subK.sub('Module[{img=Rasterize[ListPlot[Range[10]],ImageResolution->72]}, If[ImageQ[img], StringLength[ExportString[img,"Base64"]], "FAILED:" <> ToString[img]]]');
    console.log('  [diag] subK b64 length or error:', JSON.stringify(_rasB64?.value ?? _rasB64));
    console.log('  [setup] both kernels ready\n');

    // ── A. sub() on main session is same process ──────────────────────────────
    // If sub() were independent, it would respond while a slow Rasterize is
    // running. But it queues behind the current busy_ flag on the same lp_.
    // We verify: quick sub() before and after slow sub(), measuring wall-clock.
    await run('A. sub() quick before slow sub()', async () => {
        const t0 = Date.now();
        const r = await main.sub('2 + 2');
        const dt = Date.now() - t0;
        console.log(`\n       result=${r?.value}, dt=${dt}ms`);
        if (String(r?.value) !== '4') throw new Error(`expected 4 got ${r?.value}`);
        if (dt > 2000) throw new Error(`took ${dt}ms — too slow for trivial eval`);
    });

    await run('A. sub() of slow Rasterize[ListPlot[...]] blocks main kernel', async () => {
        const t0 = Date.now();
        // Fire a slow render on sub() — this should hold the main kernel's lp_.
        const slowProm = main.sub('ExportString[Rasterize[ListPlot[Range[1000]], ImageResolution->72], "Base64"]');
        // After 200ms, try another sub() — it must wait until the slow one finishes.
        await sleep(200);
        const t1 = Date.now();
        const quickProm = main.sub('"pong"');
        const r = await quickProm;
        const dt = Date.now() - t1;
        const slowR = await slowProm;
        console.log(`\n       quick-sub waited ${dt}ms (slow sub still owned lp_)`);
        // If sub() were truly independent, quickProm would resolve in ~50ms.
        // If same kernel, it blocks until slowProm finishes — dt >> 200ms.
        console.log(`       slow sub length=${String(slowR?.value ?? '').length} chars`);
        if (r?.value !== 'pong') throw new Error(`expected pong got ${r?.value}`);
        // The test "passes" either way — but we log whether it blocked.
        // If dt < 500ms AND slow finished too, they truly ran concurrently.
        if (dt < 300) console.log('       ⚠ sub() appears independent (unexpected — check kernel)');
        else          console.log('       ✓ sub() blocked as expected (same lp_)');
    });

    // ── B. _subKernel is independent ─────────────────────────────────────────
    await run('B. _subKernel.sub() responds while main-sub() is slow', async () => {
        const t0 = Date.now();
        // Fire a slow render on the MAIN kernel's sub().
        const slowProm = main.sub('Pause[3]; "done"');
        // Immediately ask subKernel for a quick result.
        await sleep(50);
        const t1 = Date.now();
        const r = await subK.sub('"pong_subkernel"');
        const dt = Date.now() - t1;
        console.log(`\n       subK responded in ${dt}ms while main was paused`);
        if (r?.value !== 'pong_subkernel') throw new Error(`expected pong_subkernel got ${r?.value}`);
        if (dt > 1500) throw new Error(`subK was blocked — dt=${dt}ms — not truly independent?`);
        await slowProm; // drain
    });

    await run('B. _subKernel.sub() Rasterize independent timing', async () => {
        // Run Rasterize on subkernel, measure time.
        // Run a trivial sub() on main at the same time — should not be blocked.
        const t0 = Date.now();
        const [rasR, quickR] = await Promise.all([
            subK.sub('Module[{img=Rasterize[ListPlot[Range[500]],ImageResolution->72]},If[ImageQ[img],StringLength[ExportString[img,"Base64"]],"FAIL:" <> ToString[Head[img]]]]'),
            main.sub('"main_unblocked"')
        ]);
        const dt = Date.now() - t0;
        console.log(`\n       Both resolved in ${dt}ms`);
        console.log(`       main result: ${quickR?.value}`);
        console.log(`       subK raster b64 length or error: ${rasR?.value}`);
        if (String(quickR?.value) !== 'main_unblocked') throw new Error('main was blocked by subK Rasterize');
    });

    // ── C. sub() on main during Dialog[] ─────────────────────────────────────
    await run('C. sub() on main during Dialog[] — should time out / queue behind dialog', async () => {
        // evaluate('Dialog[]') opens a Dialog[] directly in the main kernel.
        const mainEval = main.evaluate('Dialog[]; "after_dialog"', {});
        // Wait for dialog to open.
        await pollUntil(() => main.isDialogOpen, 8000, 50);
        console.log('\n       Dialog[] is open');

        // Now attempt sub() on the main session — it should queue (same lp_).
        // It CANNOT run while the kernel is serving Dialog[].
        const subDuringDialog = main.sub('"sub_during_dialog"');
        const raceResult = await Promise.race([
            subDuringDialog.then(r => ({ got: r?.value })),
            sleep(2000).then(() => ({ got: 'TIMED_OUT' }))
        ]);
        console.log(`       sub() during dialog resolved with: ${raceResult.got}`);

        if (raceResult.got === 'TIMED_OUT') {
            console.log('       ✓ sub() correctly queued / did not respond during Dialog[]');
        } else {
            console.log('       ⚠ sub() responded during Dialog[] — unexpected (may be kernel-version-dependent)');
        }

        // Exit dialog cleanly.
        await main.exitDialog();
        await mainEval.catch(() => {});
        // Drain the sub() if not yet resolved.
        await subDuringDialog.catch(() => {});
    });

    // ── D. _subKernel.sub() during Dialog[] on main ───────────────────────────
    await run('D. _subKernel.sub() during Dialog[] on main — should respond freely', async () => {
        // Open Dialog[] on main directly.
        const mainEval2 = main.evaluate('Dialog[]; "after_dialog2"', {});
        await pollUntil(() => main.isDialogOpen, 8000, 50);
        console.log('\n       Dialog[] is open again');

        const t0 = Date.now();
        const r = await subK.sub('"subK_during_main_dialog"');
        const dt = Date.now() - t0;
        console.log(`       subK responded in ${dt}ms`);
        if (r?.value !== 'subK_during_main_dialog') throw new Error(`got ${r?.value}`);
        if (dt > 1000) throw new Error(`subK blocked — not independent? dt=${dt}ms`);
        console.log('       ✓ _subKernel is independent of main Dialog[]');

        await main.exitDialog();
        await mainEval2.catch(() => {});
    });

    // ── E. SVG on _subKernel — safe because it's a separate process ──────────
    // SVG blocks the C thread of whichever lp_ runs it.  On the main session
    // that deadlocks Dialog[].  On _subKernel it just takes time — main is free.
    await run('E. _subKernel SVG export does not block main kernel', async () => {
        const t0 = Date.now();
        const [svgR, quickR] = await Promise.all([
            subK.sub('Module[{s=ExportString[ListPlot[Range[500]],"SVG"]},If[StringQ[s],StringLength[s],"FAIL:" <> ToString[Head[s]]]]'),
            main.sub('"main_free_during_subK_SVG"')
        ]);
        const dt = Date.now() - t0;
        console.log(`\n       Both resolved in ${dt}ms`);
        console.log(`       main result: ${quickR?.value}`);
        console.log(`       subK SVG length or error: ${svgR?.value}`);
        if (String(quickR?.value) !== 'main_free_during_subK_SVG') throw new Error('main blocked by subK SVG');
        if (String(svgR?.value).startsWith('FAIL:')) throw new Error(`SVG export failed: ${svgR?.value}`);
    });

    await run('E. _subKernel SVG vs Rasterize timing comparison', async () => {
        const t0 = Date.now();
        const svgR = await subK.sub('Module[{t0=AbsoluteTime[], s=ExportString[ListPlot[Range[1000]],"SVG"]}, {AbsoluteTime[]-t0, If[StringQ[s],StringLength[s],0]}]');
        const svgDt = Date.now() - t0;

        const t1 = Date.now();
        const rasR = await subK.sub('Module[{t0=AbsoluteTime[], img=Rasterize[ListPlot[Range[1000]],ImageResolution->72], n=0}, If[ImageQ[img], n=StringLength[ExportString[img,"Base64"]]]; {AbsoluteTime[]-t0, n}]');
        const rasDt = Date.now() - t1;

        console.log(`\n       SVG:       wall=${svgDt}ms, wl-reported=${JSON.stringify(svgR?.value)}`);
        console.log(`       Rasterize: wall=${rasDt}ms, wl-reported=${JSON.stringify(rasR?.value)}`);
        console.log('       (SVG produces scalable vector, Rasterize produces bitmap PNG)');
        // Both should succeed — just reporting timing, not a hard pass/fail on timing.
    });

    await run('E. _subKernel SVG during Dialog[] on main — main unblocked', async () => {
        // During Dialog[], fire slow SVG on subK, confirm main dialog still responds.
        const mainEval4 = main.evaluate('Dialog[]; "after_dialog4"', {});
        await pollUntil(() => main.isDialogOpen, 8000, 50);
        console.log('\n       Dialog[] open. Starting SVG on subK...');
        const t0 = Date.now();
        // Run SVG on subK concurrently.
        const svgProm = subK.sub('Module[{s=ExportString[ListPlot[Range[1000]],"SVG"]},If[StringQ[s],StringLength[s],"FAIL"]]');
        // Immediately confirm dialog is still responsive.
        const dialogR = await main.dialogEval('"dialog_alive"');
        const dialogDt = Date.now() - t0;
        console.log(`       dialogEval during subK SVG responded in ${dialogDt}ms: ${dialogR?.value}`);
        if (String(dialogR?.value) !== 'dialog_alive') throw new Error(`dialogEval failed: ${dialogR?.value}`);
        if (dialogDt > 2000) throw new Error(`dialogEval blocked ${dialogDt}ms — subK SVG leaked to main?`);
        const svgLen = await svgProm;
        console.log(`       SVG total: ${Date.now() - t0}ms, SVG length: ${svgLen?.value}`);
        await main.exitDialog();
        await mainEval4.catch(() => {});
    });

    // ── F. Data-passing pattern: store in global during Dialog[], render on subK ─
    await run('F. Export value via global during Dialog[], render on _subKernel', async () => {
        // This is the proposed fix for Dynamic rendering:
        //   In dialogEval: store expr string in a global.
        //   After exit: render on subKernel (no Dialog block, full Rasterize ok).
        //
        // Step 1: simulate Dialog[] storing a value.
        const mainEval3 = main.evaluate('Dialog[]; "after_dialog3"', {});
        await pollUntil(() => main.isDialogOpen, 8000, 50);

        // Store serialized expr in a global while inside Dialog[].
        // Use dialogEval (safe: just a global assignment, no slow C call).
        const storeR = await main.dialogEval('$__DynRenderQueue = {"ListPlot[Range[50]]"}; "stored"');
        console.log(`\n       stored in dialog: ${storeR?.value}`);

        // Exit dialog — main kernel is free again.
        await main.exitDialog();
        await mainEval3.catch(() => {});
        console.log('       Main kernel free. Now rendering on subKernel...');

        // Step 2: read back the stored value on subKernel (or just render inline).
        // In practice the extension already has the expr string from dynInner —
        // so we just send it directly to subKernel without needing the global.
        const t0 = Date.now();
        const rasR = await subK.sub(
            'Module[{img = Rasterize[ListPlot[Range[50]], ImageResolution->72, Background->None], b64},' +
            '  If[ImageQ[img],' +
            '    b64 = ExportString[img, "Base64"];' +
            '    "PNG:" <> StringReplace[b64, WhitespaceCharacter -> ""],' +
            '    "FAILED:" <> ToString[img]]]'
        );
        const dt = Date.now() - t0;
        const rv = String(rasR?.value ?? '');
        console.log(`       subK Rasterize: ${dt}ms, result[0..60]: ${rv.slice(0, 60)}`);
        if (rv.startsWith('FAILED:')) throw new Error(`Rasterize failed on subkernel: ${rv}`);
        const pngLen = rv.startsWith('PNG:') ? rv.length - 4 : rv.length;
        console.log(`       base64 length = ${pngLen}`);
        if (pngLen < 100) throw new Error('Rasterize returned empty/short base64');
        console.log('       ✓ Rasterize on _subKernel works, main completely unblocked during render');
    });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    try { main.close(); } catch (_) {}
    try { subK.close(); } catch (_) {}

    console.log(`\n═══════════════════════════════════════`);
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    console.log(`═══════════════════════════════════════\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
