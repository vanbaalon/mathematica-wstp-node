#pragma once

#include "types.h"
#include <wstp.h>

// ---------------------------------------------------------------------------
// drainDialogAbortResponse — drain the WSTP link after aborting out of a
// dialog inner loop.  Reads and discards packets until RETURNPKT,
// RETURNEXPRPKT, ILLEGALPKT, or a 10-second wall-clock deadline.
// ---------------------------------------------------------------------------
void drainDialogAbortResponse(WSLINK lp);

// ---------------------------------------------------------------------------
// drainStalePackets — after RETURNPKT, check for stale packets that arrived
// in a short window after the kernel sent the main result (e.g. a late
// BEGINDLGPKT from a concurrent interrupt).  Auto-closes any stale dialogs.
// ---------------------------------------------------------------------------
void drainStalePackets(WSLINK lp, EvalOptions* opts);

// ---------------------------------------------------------------------------
// drainUntilEndDialog — reads packets until ENDDLGPKT (dialog closed).
// capturedOuterResult, if non-null, receives any RETURNPKT that arrives
// before ENDDLGPKT (outer eval result captured inside the dialog).
// Returns true on success, false on timeout or link error.
// ---------------------------------------------------------------------------
bool drainUntilEndDialog(WSLINK lp, int timeoutMs,
                         WExpr* capturedOuterResult = nullptr);

// ---------------------------------------------------------------------------
// readDynResultWithTimeout — reads one result from an open Dialog level after
// the caller has already sent the expression via EnterTextPacket.
// Sets dr.value on success or dr.error on failure.
// capturedOuterResult, if non-null, receives a RETURNPKT/RETURNEXPRPKT that
// arrives before the expected RETURNTEXTPKT.
// ---------------------------------------------------------------------------
bool readDynResultWithTimeout(WSLINK lp, DynResult& dr, int timeoutMs,
                              WExpr* capturedOuterResult = nullptr);

// ---------------------------------------------------------------------------
// DrainToEvalResult — consume all packets for one cell, capturing Print[]
// output and messages.  Blocks until RETURNPKT.  Thread-pool thread only.
// opts may be nullptr (no streaming callbacks).
// ---------------------------------------------------------------------------
EvalResult DrainToEvalResult(WSLINK lp, EvalOptions* opts = nullptr);
