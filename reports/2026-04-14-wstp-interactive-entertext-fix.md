# WSTP Change Track - 2026-04-14

## Scope
- Repository: WSTP Backend
- Goal: Keep interactive mode features, but eliminate `Throw::nocatch` for non-trivial assumptions in expressions like:
  - `Sum[f[i],{i,1,n}] + Sum[g[i],{i,1,n}]`

## Exact files changed
- `src/evaluate_worker.cc`
- `src/drain.cc`

## Exact code changes

### 1) Interactive send packet changed to text-mode top-level input
File: `src/evaluate_worker.cc`

- At line 68, diagnostic label changed from `EnterExpressionPacket` to `EnterTextPacket`.
- At lines 78-83, interactive send path changed from:
  - `EnterExpressionPacket[ToExpression[...]]`
  to:
  - `EnterTextPacket[raw text]`

Current changed block:

```cpp
DiagLog("[Eval] about to send " + std::string(interactive_ ? "EnterTextPacket" : "EvaluatePacket")
        + " expr=" + sendExpr.substr(0, 60));
...
} else {
    // Interactive mode mirrors front-end semantics: send raw text for
    // top-level evaluation instead of pre-wrapping with ToExpression.
    sent = WSPutFunction(lp_, "EnterTextPacket", 1) &&
           WSPutUTF8String(lp_, (const unsigned char *)sendExpr.c_str(), (int)sendExpr.size()) &&
           WSEndPacket  (lp_)                       &&
           WSFlush      (lp_);
}
```

### 2) Return packet handling unified for text-mode returns
File: `src/drain.cc`

- At line 1002, outer eval return condition changed from:
  - `RETURNPKT || RETURNEXPRPKT`
  to:
  - `RETURNPKT || RETURNEXPRPKT || RETURNTEXTPKT`

Current changed line:

```cpp
if (pkt == RETURNPKT || pkt == RETURNEXPRPKT || pkt == RETURNTEXTPKT) {
```

### 3) Redundant legacy RETURNTEXTPKT branch removed
File: `src/drain.cc`

- Removed the later dedicated `else if (pkt == RETURNTEXTPKT)` block (old fallback branch near line ~1440).
- Reason: branch became redundant after `RETURNTEXTPKT` moved into the main return handler at line 1002.

## Build and validation log

### Build
Command:

```bash
cd ".../WSTP Backend" && bash build.sh
```

Result:
- Build succeeded.
- Binary produced: `build/Release/wstp.node`

### Bug repro check (post-fix)
Command:

```bash
interactive=true/false with:
$Assumptions = a>b;
Sum[f[i],{i,1,n}] + Sum[g[i],{i,1,n}]
```

Result:
- `interactive=true`: `Throw::nocatch` no longer appears.
- `interactive=false`: still clean.

Observed summary:
- `mode true hasThrow false msgCount 0`
- `mode false hasThrow false msgCount 0`

### Fast suite
Command:

```bash
node tests/mini-test.js
```

Final result:
- `10 passed, 0 failed, 0 skipped out of 10`
- `All mini-tests PASSED`

## Deployment status
Deployment executed from parent project script:

```bash
cd ".../VSCodeWolframExtension" && bash deploy-extension.sh quick
```

Result:
- Quick deploy completed.
- Updated extension installed at:
  - `/Users/k0959535/.vscode/extensions/wolfbook.wolfbook-2.6.46`
- Script reported push to `origin/main` for Extension Development.

## Notes
- This change keeps interactive mode enabled and does not disable dynamic/watch-panel architecture.
- The fix specifically aligns interactive top-level cell input with text-entry semantics while preserving existing dialog/dynamic packet handling.
