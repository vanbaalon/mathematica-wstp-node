#include "drain.h"
#include "kernel_state.h"
#include "diag.h"
#include "wstp_expr.h"

#include <chrono>
#include <cstring>
#include <thread>

// ---------------------------------------------------------------------------
// drainDialogAbortResponse — drain the WSTP link after aborting out of a
// dialog inner loop.
//
// When abort() fires proactively (abortFlag_ is true before the kernel has
// sent its response), WSAbortMessage has already been posted but the kernel's
// abort response — RETURNPKT[$Aborted] or ILLEGALPKT — has not yet been read.
// Leaving it on the link corrupts the next evaluation: it becomes the first
// packet seen by the next DrainToEvalResult call, which resolves immediately
// with $Aborted and leaves the real response on the link — permanently
// degrading the session and disabling subsequent interrupts.
//
// Reads and discards packets until RETURNPKT, RETURNEXPRPKT, ILLEGALPKT, or a
// 10-second wall-clock deadline.  Intermediate packets (ENDDLGPKT, TEXTPKT,
// MESSAGEPKT, MENUPKT, etc.) are silently consumed.
// ---------------------------------------------------------------------------
void drainDialogAbortResponse(WSLINK lp) {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline) {
        // Poll until data is available or the deadline passes.
        while (std::chrono::steady_clock::now() < deadline) {
            if (WSReady(lp)) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (!WSReady(lp)) return; // timed out — give up
        int pkt = WSNextPacket(lp);
        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT) {
            WSNewPacket(lp);
            return; // outer-eval abort response consumed — link is clean
        }
        if (pkt == ILLEGALPKT || pkt == 0) {
            WSClearError(lp);
            WSNewPacket(lp);
            return; // link reset — clean
        }
        // MENUPKT requires a response — the kernel waits for a string.
        // Discarding it via WSNewPacket without responding would hang
        // the kernel and corrupt the WSTP protocol for all future calls.
        if (pkt == MENUPKT) {
            WSNewPacket(lp);  // consume menu contents
            WSPutString(lp, "a");  // abort
            WSEndPacket(lp);
            WSFlush(lp);
            DiagLog("[drainAbort] MENUPKT — responded 'a'");
            continue;
        }
        WSNewPacket(lp); // discard intermediate packet (ENDDLGPKT, TEXTPKT, …)
    }
}

// ---------------------------------------------------------------------------
// drainStalePackets — after RETURNPKT, check for stale packets that arrived
// in the 50ms window after the kernel sent the main result.
//
// Scenario: an interrupt was sent just as the cell completed; the kernel may
// have queued a BEGINDLGPKT that arrives after RETURNPKT.  If left unread it
// corrupts the NEXT evaluation (Pattern D).
//
// If opts->rejectDialog is true the dialog is also closed via our inline
// path (same as the main BEGINDLGPKT handler).  If false, we still close
// stale dialogs silently to keep the link clean — the JS side never knew
// about this dialog so there's nobody to call exitDialog().
// ---------------------------------------------------------------------------
void drainStalePackets(WSLINK lp, EvalOptions* opts) {
    // Stale packets (from PREVIOUS evals) are already sitting on the link
    // and arrive instantly.  Use a short idle timeout: if nothing arrives
    // for idleMs, exit early.  The hard timeout caps the total drain time
    // in case packets keep arriving (e.g. nested Dialog[] rejections).
    int hardTimeoutMs = (opts && opts->dynAutoMode) ? 50 : 200;
    int idleMs = 5;  // exit after 5ms of silence
    auto hardDeadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(hardTimeoutMs);
    auto idleDeadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(idleMs);
    while (std::chrono::steady_clock::now() < hardDeadline &&
           std::chrono::steady_clock::now() < idleDeadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }
        // Packet arrived — reset idle deadline.
        idleDeadline = std::chrono::steady_clock::now() +
                       std::chrono::milliseconds(idleMs);
        int pkt = WSNextPacket(lp);
        if (pkt == BEGINDLGPKT) {
            // Stale dialog — consume level int then auto-close.
            wsint64 lvl = 0;
            if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &lvl);
            WSNewPacket(lp);
            DiagLog("[Eval] drainStalePackets: stale BEGINDLGPKT level=" + std::to_string(lvl) + " — auto-closing");
            // Pre-drain INPUTNAMEPKT — Dialog[] sends INPUTNAMEPKT before
            // accepting EnterTextPacket.
            {
                auto preDl = std::chrono::steady_clock::now() +
                             std::chrono::milliseconds(500);
                while (std::chrono::steady_clock::now() < preDl) {
                    if (!WSReady(lp)) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(2));
                        continue;
                    }
                    int ipkt = WSNextPacket(lp);
                    DiagLog("[Eval] drainStale: pre-drain pkt=" + std::to_string(ipkt));
                    WSNewPacket(lp);
                    if (ipkt == INPUTNAMEPKT) break;
                    if (ipkt == 0 || ipkt == ILLEGALPKT) { WSClearError(lp); break; }
                }
            }
            const char* closeExpr = "Return[$Failed]";
            WSPutFunction(lp, "EnterTextPacket", 1);
            WSPutUTF8String(lp,
                reinterpret_cast<const unsigned char*>(closeExpr),
                static_cast<int>(std::strlen(closeExpr)));
            WSEndPacket(lp);
            WSFlush(lp);
            DiagLog("[Eval] drainStale: sent Return[$Failed], draining...");
            // Drain until ENDDLGPKT.
            auto dlgDeadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(2000);
            while (std::chrono::steady_clock::now() < dlgDeadline) {
                if (!WSReady(lp)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                    continue;
                }
                int rp = WSNextPacket(lp);
                DiagLog("[Eval] drainStale: drain pkt=" + std::to_string(rp));
                WSNewPacket(lp);
                if (rp == ENDDLGPKT) break;
                if (rp == 0 || rp == ILLEGALPKT) { WSClearError(lp); break; }
            }
        } else if (pkt == MENUPKT) {
            // Stale interrupt menu — dismiss with empty response.
            wsint64 menuType = 0; WSGetInteger64(lp, &menuType);
            const char* menuPrompt = nullptr; WSGetString(lp, &menuPrompt);
            if (menuPrompt) WSReleaseString(lp, menuPrompt);
            WSNewPacket(lp);
            DiagLog("[Eval] drainStalePackets: stale MENUPKT type=" + std::to_string(menuType) + " — aborting");
            WSPutString(lp, "a");  // abort — clean response to stale interrupt
            WSEndPacket(lp); WSFlush(lp);
        } else {
            WSNewPacket(lp);  // discard any other stale packet
        }
    }
}

// ---------------------------------------------------------------------------
// drainUntilEndDialog — reads packets until ENDDLGPKT (dialog closed).
// Used by the C++-internal Dynamic eval path to finish a dialog level cleanly.
// Returns true on success, false on timeout or link error.
//
// If capturedOuterResult is non-null and a RETURNPKT/RETURNEXPRPKT arrives
// that looks like the outer eval's result (rather than Return[$Failed]'s
// response), it is saved there for the caller to use.
// ---------------------------------------------------------------------------
bool drainUntilEndDialog(WSLINK lp, int timeoutMs,
                         WExpr* capturedOuterResult) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);
    int nestLevel = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }
        int pkt = WSNextPacket(lp);
        DiagLog("[drainEndDlg] pkt=" + std::to_string(pkt) +
                " nest=" + std::to_string(nestLevel));
        if (pkt == ENDDLGPKT) {
            WSNewPacket(lp);
            if (nestLevel > 0) { nestLevel--; continue; }
            return true;
        }
        if (pkt == BEGINDLGPKT) {
            // Nested dialog opened (stale ScheduledTask / interrupt).
            // Auto-close: drain to INPUTNAMEPKT then send Return[$Failed].
            WSNewPacket(lp);
            nestLevel++;
            auto innerDl = std::chrono::steady_clock::now() +
                           std::chrono::milliseconds(500);
            while (std::chrono::steady_clock::now() < innerDl) {
                if (!WSReady(lp)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                    continue;
                }
                int ip = WSNextPacket(lp);
                DiagLog("[drainEndDlg] inner-drain pkt=" + std::to_string(ip));
                WSNewPacket(lp);
                if (ip == INPUTNAMEPKT) break;
                if (ip == 0 || ip == ILLEGALPKT) { WSClearError(lp); break; }
            }
            const char* closeExpr = "Return[$Failed]";
            WSPutFunction(lp, "EnterTextPacket", 1);
            WSPutUTF8String(lp,
                reinterpret_cast<const unsigned char*>(closeExpr),
                static_cast<int>(std::strlen(closeExpr)));
            WSEndPacket(lp); WSFlush(lp);
            DiagLog("[drainEndDlg] auto-closed inner dialog");
            continue;
        }
        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT) {
            // Capture the outer eval's RETURNPKT if requested and not yet set.
            if (capturedOuterResult &&
                capturedOuterResult->kind == WExpr::WError &&
                capturedOuterResult->strVal.empty()) {
                *capturedOuterResult = ReadExprRaw(lp);
                DiagLog("[drainEndDlg] captured outer result (pkt=" +
                        std::to_string(pkt) + ")");
            }
            WSNewPacket(lp);
            continue;
        }
        if (pkt == 0 || pkt == ILLEGALPKT) {
            WSClearError(lp);
            return false;
        }
        // MENUPKT requires a response string; discarding without responding
        // hangs the kernel and corrupts the WSTP link.
        if (pkt == MENUPKT) {
            WSNewPacket(lp);
            // Respond 'c' (continue) so the in-progress Return[] can
            // complete and the dialog actually closes.  Responding 'a'
            // (abort) kills the Return[], leaving the dialog open.
            WSPutString(lp, "c");
            WSEndPacket(lp);
            WSFlush(lp);
            DiagLog("[drainEndDlg] MENUPKT — responded 'c'");
            deadline = std::chrono::steady_clock::now() +
                       std::chrono::milliseconds(timeoutMs);
            continue;
        }
        WSNewPacket(lp);  // discard TEXTPKT, MESSAGEPKT, INPUTNAMEPKT, etc.
    }
    return false;  // timeout
}

// ---------------------------------------------------------------------------
// readDynResultWithTimeout — reads one result from an open Dialog level after
// the caller has already sent the expression (EnterTextPacket).
// On success sets dr.value (string form) and returns true.
// On failure sets dr.error and returns false.
//
// If capturedOuterResult is non-null and a RETURNPKT/RETURNEXPRPKT arrives
// (which is the outer eval's result that got evaluated inside the Dialog[]
// context), the value is saved there and the function continues waiting for
// the RETURNTEXTPKT that EnterTextPacket produces.
// ---------------------------------------------------------------------------
bool readDynResultWithTimeout(WSLINK lp, DynResult& dr, int timeoutMs,
                              WExpr* capturedOuterResult,
                              const std::string* retryExpr,
                              SentLog* log,
                              std::atomic<bool>* menuPktPending) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);
    // Only re-send expression on INPUTNAMEPKT if a MENUPKT interrupt actually
    // fired during this call.  A bare INPUTNAMEPKT after a successful eval is
    // the kernel's normal next-prompt; re-sending it would evaluate the
    // previous expression again and corrupt the result for the next entry.
    bool hadInterrupt = false;
    while (std::chrono::steady_clock::now() < deadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }
        int pkt = WSNextPacket(lp);
        DiagLog("[DynRead] pkt=" + std::to_string(pkt));
        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT || pkt == RETURNTEXTPKT) {
            WExpr val = ReadExprRaw(lp);
            WSNewPacket(lp);
            DiagLog("[DynRead] accepted pkt=" + std::to_string(pkt) +
                    " kind=" + std::to_string(val.kind) +
                    " val=" + (val.kind == WExpr::String ? val.strVal :
                               val.kind == WExpr::Integer ? std::to_string(val.intVal) :
                               val.kind == WExpr::Symbol ? val.strVal :
                               val.kind == WExpr::Real ? std::to_string(val.realVal) :
                               val.head.empty() ? "?" : val.head));
            // RETURNPKT/RETURNEXPRPKT inside a dialog means the outer eval's
            // EvaluatePacket was processed inside this Dialog[] context (race
            // condition when ScheduledTask fires between evals).  Save the
            // value for the caller and keep waiting for our RETURNTEXTPKT.
            if (pkt != RETURNTEXTPKT && capturedOuterResult) {
                DiagLog("[DynRead] captured outer result (pkt=" + std::to_string(pkt) + "), continuing");
                *capturedOuterResult = std::move(val);
                continue;
            }
            if (val.kind == WExpr::WError) {
                dr.error = val.strVal;
                return false;
            }
            switch (val.kind) {
                case WExpr::String:  dr.value = val.strVal;                        break;
                case WExpr::Integer: dr.value = std::to_string(val.intVal);        break;
                case WExpr::Real:    dr.value = std::to_string(val.realVal);       break;
                case WExpr::Symbol:  dr.value = val.strVal;                        break;
                default:             dr.value = val.head.empty() ? "?" : val.head; break;
            }
            return true;
        }
        if (pkt == TEXTPKT || pkt == MESSAGEPKT || pkt == OUTPUTNAMEPKT) {
            WSNewPacket(lp);
            continue;
        }
        // INPUTNAMEPKT: either (a) the kernel's normal next-prompt after a
        // completed evaluation, or (b) the dialog re-prompting after a MENUPKT
        // interrupt cleared our expression.  Only re-send the expression in
        // case (b) — i.e. when a MENUPKT was actually handled in this call.
        if (pkt == INPUTNAMEPKT) {
            WSNewPacket(lp);
            if (hadInterrupt && retryExpr && !retryExpr->empty()) {
                if (log) log->append("RECV INPUTNAMEPKT(midRead) — re-sending expr");
                DiagLog("[DynRead] INPUTNAMEPKT after interrupt — re-sending expr");
                bool resent =
                    WSPutFunction(lp, "EnterTextPacket", 1) &&
                    WSPutUTF8String(lp,
                        reinterpret_cast<const unsigned char*>(retryExpr->c_str()),
                        static_cast<int>(retryExpr->size())) &&
                    WSEndPacket(lp) &&
                    WSFlush(lp);
                if (!resent) {
                    dr.error = "failed to re-send expression after interrupt";
                    return false;
                }
                hadInterrupt = false;  // expression re-sent; reset for next occurrence
            } else {
                DiagLog("[DynRead] INPUTNAMEPKT — discarding (normal next-prompt)");
            }
            continue;
        }
        // Nested dialog: ScheduledTask fired Dialog[] during our expression
        // evaluation.  Auto-close it at C++ level and continue waiting.
        if (pkt == BEGINDLGPKT) {
            WSNewPacket(lp);
            // Drain to INPUTNAMEPKT (the nested dialog's prompt)
            auto innerDl = std::chrono::steady_clock::now() +
                           std::chrono::milliseconds(500);
            while (std::chrono::steady_clock::now() < innerDl) {
                if (!WSReady(lp)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                    continue;
                }
                int ip = WSNextPacket(lp);
                DiagLog("[DynRead] nested-drain pkt=" + std::to_string(ip));
                if (ip == MENUPKT) {
                    WSNewPacket(lp);
                    WSPutString(lp, "c");
                    WSEndPacket(lp); WSFlush(lp);
                    continue;
                }
                WSNewPacket(lp);
                if (ip == INPUTNAMEPKT) break;
                if (ip == 0 || ip == ILLEGALPKT) { WSClearError(lp); break; }
            }
            // Close nested dialog
            const char* closeNested = "Return[$Failed]";
            WSPutFunction(lp, "EnterTextPacket", 1);
            WSPutUTF8String(lp,
                reinterpret_cast<const unsigned char*>(closeNested),
                static_cast<int>(std::strlen(closeNested)));
            WSEndPacket(lp); WSFlush(lp);
            DiagLog("[DynRead] auto-closed nested dialog");
            // Drain until ENDDLGPKT for the nested dialog
            auto endDl = std::chrono::steady_clock::now() +
                         std::chrono::milliseconds(1000);
            while (std::chrono::steady_clock::now() < endDl) {
                if (!WSReady(lp)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                    continue;
                }
                int ep = WSNextPacket(lp);
                DiagLog("[DynRead] nested-end pkt=" + std::to_string(ep));
                if (ep == MENUPKT) {
                    WSNewPacket(lp);
                    WSPutString(lp, "c");
                    WSEndPacket(lp); WSFlush(lp);
                    continue;
                }
                WSNewPacket(lp);
                if (ep == ENDDLGPKT) break;
                if (ep == 0 || ep == ILLEGALPKT) { WSClearError(lp); break; }
            }
            continue;
        }
        // Stale WSInterruptMessage arrived inside dialog.  Respond 'c'
        // (continue) — the kernel resumes evaluating our expression.
        if (pkt == MENUPKT) {
            wsint64 mtype = 0; WSGetInteger64(lp, &mtype);
            const char* mprompt = nullptr; WSGetString(lp, &mprompt);
            if (mprompt) WSReleaseString(lp, mprompt);
            WSNewPacket(lp);
            WSPutString(lp, "c");
            WSEndPacket(lp);
            WSFlush(lp);
            hadInterrupt = true;  // INPUTNAMEPKT after this should trigger re-send
            // Clear menuPktPending — this MENUPKT is now consumed.
            if (menuPktPending) menuPktPending->store(false);
            if (log) {
                log->append("RECV MENUPKT(midRead type=" + std::to_string(mtype) + ") → 'c'");
                DiagLog("[DynRead] " + log->dump());
            }
            DiagLog("[DynRead] MENUPKT type=" + std::to_string(mtype) + " — responded 'c' (continue)");
            continue;
        }
        // Dialog closed before we got our result — don't silently time out.
        if (pkt == ENDDLGPKT) {
            WSNewPacket(lp);
            DiagLog("[DynRead] ENDDLGPKT — dialog closed unexpectedly before result");
            dr.error = "dialog closed before result";
            return false;
        }
        if (pkt == 0 || pkt == ILLEGALPKT) {
            WSClearError(lp);
            dr.error = "WSTP link error during Dynamic eval";
            return false;
        }
        DiagLog("[DynRead] unexpected pkt=" + std::to_string(pkt) + " — discarding");
        WSNewPacket(lp);
    }
    DiagLog("[DynRead] TIMEOUT after " + std::to_string(timeoutMs) + "ms waiting for result");
    dr.error = "timeout";
    return false;
}

// ---------------------------------------------------------------------------
// DialogSession — implementation
// ---------------------------------------------------------------------------

DialogSession::DialogSession(WSLINK lp, EvalOptions* opts)
    : lp_(lp), opts_(opts)
{
    // Pre-drain: consume INPUTNAMEPKT (the dialog's first prompt) and
    // optionally MENUPKT if one is in the WSTP pipe from WSInterruptMessage.
    bool waitForMenuPkt = opts_ && opts_->menuPktPending && opts_->menuPktPending->load();
    bool foundInputName = false;
    auto drainDl = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (std::chrono::steady_clock::now() < drainDl) {
        if (!WSReady(lp_)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }
        int ipkt = WSNextPacket(lp_);
        DiagLog("[DialogSession] pre-drain pkt=" + std::to_string(ipkt));
        if (ipkt == INPUTNAMEPKT) {
            WSNewPacket(lp_);
            if (!foundInputName) {
                foundInputName = true;
                if (!waitForMenuPkt) {
                    drainDl = std::chrono::steady_clock::now() +
                              std::chrono::milliseconds(100);
                    DiagLog("[DialogSession] INPUTNAMEPKT — no MENUPKT expected, 100ms grace");
                } else {
                    DiagLog("[DialogSession] INPUTNAMEPKT — MENUPKT in pipe, waiting");
                }
                if (opts_ && opts_->sentLog)
                    opts_->sentLog->append("RECV pre-drain INPUTNAMEPKT");
            } else {
                // Second (or later) INPUTNAMEPKT.
                // Only break if no MENUPKT is pending — i.e. we already consumed it
                // (or never expected one).  If menuPktPending is still set, a concurrent
                // interrupt delivered another INPUTNAMEPKT before its MENUPKT; keep looping.
                bool mpPending = opts_ && opts_->menuPktPending && opts_->menuPktPending->load();
                if (!mpPending) {
                    if (opts_ && opts_->sentLog)
                        opts_->sentLog->append("RECV pre-drain INPUTNAMEPKT(2nd clean)");
                    break;  // clean state — MENUPKT consumed or never expected
                }
                // else: another INPUTNAMEPKT while MENUPKT still in pipe — keep waiting
                DiagLog("[DialogSession] INPUTNAMEPKT(2nd) while menuPktPending — keep waiting for MENUPKT");
            }
            continue;
        }
        if (ipkt == MENUPKT) {
            WSNewPacket(lp_);
            WSPutString(lp_, "c");
            WSEndPacket(lp_); WSFlush(lp_);
            if (opts_ && opts_->menuPktPending) opts_->menuPktPending->store(false);
            waitForMenuPkt = false;
            foundInputName = false;
            DiagLog("[DialogSession] pre-drain MENUPKT — responded 'c', waiting for fresh INPUTNAMEPKT");
            if (opts_ && opts_->sentLog)
                opts_->sentLog->append("RECV pre-drain MENUPKT \u2192 'c'");
            drainDl = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
            continue;
        }
        if (foundInputName) {
            // Stale packet in grace window after INPUTNAMEPKT — discard.
            WSNewPacket(lp_);
            continue;
        }
        if (ipkt == 0 || ipkt == ILLEGALPKT) {
            WSClearError(lp_);
            DiagLog("[DialogSession] pre-drain: link error — valid=false");
            return;  // valid_ stays false
        }
        WSNewPacket(lp_);
    }
    if (waitForMenuPkt && foundInputName)
        DiagLog("[DialogSession] WARNING — MENUPKT not seen within timeout");
    else if (foundInputName)
        DiagLog("[DialogSession] pre-drain done");
    else
        DiagLog("[DialogSession] pre-drain: no INPUTNAMEPKT — proceeding anyway");
    valid_ = true;
}

bool DialogSession::evaluate(const std::string& id, const std::string& expr,
                             DynResult& dr, WExpr* capturedOuter)
{
    if (!valid_ || closed_) { dr.error = "dialog not open"; return false; }
    if (opts_ && opts_->sentLog)
        opts_->sentLog->append("SEND EnterText[" + id + "]: " + expr.substr(0, 40));

    bool sent = WSPutFunction(lp_, "EnterTextPacket", 1) &&
                WSPutUTF8String(lp_,
                    reinterpret_cast<const unsigned char*>(expr.c_str()),
                    static_cast<int>(expr.size())) &&
                WSEndPacket(lp_) && WSFlush(lp_);
    if (!sent) {
        dr.error = "failed to send Dynamic expression";
        return false;
    }
    return readDynResultWithTimeout(lp_, dr, 2000,
                                    capturedOuter, &expr,
                                    opts_ ? opts_->sentLog : nullptr,
                                    opts_ ? opts_->menuPktPending : nullptr);
}

bool DialogSession::close(WExpr* capturedOuter)
{
    if (closed_) return true;
    closed_ = true;
    static const char* kClose = "Return[$Failed]";
    bool sent = WSPutFunction(lp_, "EnterTextPacket", 1) &&
                WSPutUTF8String(lp_,
                    reinterpret_cast<const unsigned char*>(kClose),
                    static_cast<int>(std::strlen(kClose))) &&
                WSEndPacket(lp_) && WSFlush(lp_);
    if (!sent) return false;
    return drainUntilEndDialog(lp_, 3000, capturedOuter);
}

// ---------------------------------------------------------------------------
// DrainToEvalResult — consume all packets for one cell, capturing Print[]
// output and messages.  Blocks until RETURNPKT.  Thread-pool thread only.
// opts may be nullptr (no streaming callbacks).
// ---------------------------------------------------------------------------
EvalResult DrainToEvalResult(WSLINK lp, EvalOptions* opts) {
    DiagLog("[Drain] DrainToEvalResult entered, rejectDialog=" +
            std::to_string(opts ? opts->rejectDialog : false) +
            " interactive=" + std::to_string(opts ? opts->interactive : false));
    // Diagnostic: poll for 3s to see if kernel will ever respond
    for (int i = 0; i < 60; ++i) {
        if (WSReady(lp)) {
            DiagLog("[Drain] data arrived after " + std::to_string(i * 50) + "ms");
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!WSReady(lp)) {
        DiagLog("[Drain] WARNING: no data from kernel after 3s poll");
    }
    EvalResult r;

    // Parse "In[42]:=" → 42
    auto parseCellIndex = [](const std::string& s) -> int64_t {
        auto a = s.find('[');
        auto b = s.find(']');
        if (a == std::string::npos || b == std::string::npos) return 0;
        try { return std::stoll(s.substr(a + 1, b - a - 1)); }
        catch (...) { return 0; }
    };

    // Strip "Context`" prefix from fully-qualified symbol names.
    auto stripCtx = [](const std::string& s) -> std::string {
        auto p = s.rfind('`');
        return p != std::string::npos ? s.substr(p + 1) : s;
    };

    // Remove trailing newline(s) that Print[] appends to TextPacket content.
    auto rtrimNL = [](std::string s) -> std::string {
        // Strip actual ASCII newlines / carriage returns
        while (!s.empty() && (s.back() == '\n' || s.back() == '\r'))
            s.pop_back();
        // Strip Wolfram's 4-char literal octal escape "\\012"
        while (s.size() >= 4 && s.compare(s.size() - 4, 4, "\\012") == 0)
            s.resize(s.size() - 4);
        return s;
    };

    // -----------------------------------------------------------------------
    // Helper: handle a MESSAGEPKT (already current) — shared by outer and
    // dialog inner loops.  Reads the follow-up TEXTPKT, extracts the message
    // string, appends it to r.messages, and fires the onMessage TSFN.
    // Returns false if the link died during message handling.
    // -----------------------------------------------------------------------
    auto handleMessage = [&]([[maybe_unused]] bool forDialog) -> bool {
        WSNewPacket(lp);  // discard message-name expression
        int nextPkt = WSNextPacket(lp);
        if (nextPkt == 0 || nextPkt == ILLEGALPKT) {
            // Link died between MESSAGEPKT and TEXTPKT — propagate immediately.
            const char* m = WSErrorMessage(lp);
            std::string s = m ? m : "WSTP link error (during message)";
            WSClearError(lp);
            DiagLog("[Eval] handleMessage: pkt=0 after MESSAGEPKT — link dead");
            if (opts && opts->linkDead) opts->linkDead->store(true);
            if (opts && opts->kernelStatus) SetLink(*opts->kernelStatus, LinkState::Dead, "drain:handleMessage:linkDead");
            r.result = WExpr::mkError(s);
            return false;
        }
        if (nextPkt == TEXTPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) {
                std::string text = s;
                WSReleaseString(lp, s);
                static const std::string NL = "\\012";
                std::string msg;
                auto dc = text.find("::");
                size_t raw_start = 0;
                if (dc != std::string::npos) {
                    auto nl_before = text.rfind(NL, dc);
                    raw_start = (nl_before != std::string::npos) ? nl_before + 4 : 0;
                }
                std::string raw = text.substr(raw_start);
                while (raw.size() >= 4 && raw.compare(raw.size() - 4, 4, NL) == 0)
                    raw.resize(raw.size() - 4);
                size_t sp = 0;
                while (sp < raw.size() && raw[sp] == ' ') ++sp;
                raw = raw.substr(sp);
                for (size_t i = 0; i < raw.size(); ) {
                    if (raw.compare(i, 4, NL) == 0) { msg += ' '; i += 4; }
                    else { msg += raw[i++]; }
                }
                // Both outer and dialog messages go onto r.messages.
                r.messages.push_back(msg);
                if (opts && opts->hasOnMessage)
                    opts->onMessage.NonBlockingCall(
                        [msg](Napi::Env e, Napi::Function cb){
                            cb.Call({Napi::String::New(e, msg)}); });
            }
        }
        WSNewPacket(lp);
        return true;
    };

    // -----------------------------------------------------------------------
    // Helper: service one pending DialogRequest from dialogQueue_.
    //
    // menuDlgProto = false (default, BEGINDLGPKT path):
    //   Sends EvaluatePacket[ToExpression[...]], drains until RETURNPKT.
    //
    // menuDlgProto = true  (MENUPKT-dialog path, interrupt-triggered Dialog[]):
    //   Sends EnterExpressionPacket[ToExpression[...]], drains until RETURNEXPRPKT.
    //
    // Returns true  → dialog still open.
    // Returns false → dialog closed (ENDDLGPKT or exitDialog via MENUPKT 'c').
    // -----------------------------------------------------------------------
    auto serviceDialogRequest = [&](bool menuDlgProto = false) -> bool {
        DialogRequest req;
        {
            std::lock_guard<std::mutex> lk(*opts->dialogMutex);
            if (opts->dialogQueue->empty()) return true;
            req = std::move(opts->dialogQueue->front());
            opts->dialogQueue->pop();
            if (opts->dialogQueue->empty())
                opts->dialogPending->store(false);
        }
        bool sent;
        if (!req.useEnterText) {
            if (menuDlgProto) {
                sent = WSPutFunction(lp, "EnterTextPacket", 1) &&
                       WSPutUTF8String(lp, (const unsigned char *)req.expr.c_str(), (int)req.expr.size()) &&
                       WSEndPacket  (lp)                       &&
                       WSFlush      (lp);
            } else {
                sent = WSPutFunction(lp, "EvaluatePacket", 1) &&
                       WSPutFunction(lp, "ToExpression",   1) &&
                       WSPutUTF8String(lp, (const unsigned char *)req.expr.c_str(), (int)req.expr.size()) &&
                       WSEndPacket  (lp)                      &&
                       WSFlush      (lp);
            }
        } else {
            sent = WSPutFunction(lp, "EnterTextPacket", 1) &&
                   WSPutUTF8String(lp, (const unsigned char *)req.expr.c_str(), (int)req.expr.size()) &&
                   WSEndPacket  (lp)                        &&
                   WSFlush      (lp);
        }
        if (!sent) {
            WExpr err = WExpr::mkError("dialogEval: failed to send to kernel");
            req.resolve.NonBlockingCall(
                [err](Napi::Env e, Napi::Function cb){
                    Napi::Object o = Napi::Object::New(e);
                    o.Set("type",  Napi::String::New(e, "error"));
                    o.Set("error", Napi::String::New(e, err.strVal));
                    cb.Call({o});
                });
            req.resolve.Release();
            return true;
        }
        WExpr result;
        std::string lastDlgText;
        bool dialogEndedHere = false;
        bool menuDlgFirstSkipped = false;
        DiagLog("[SDR] waiting for response, menuDlgProto=" + std::to_string(menuDlgProto)
                + " useEnterText=" + std::to_string(req.useEnterText));
        while (true) {
            int p2 = WSNextPacket(lp);
            DiagLog("[SDR] p2=" + std::to_string(p2));
            if (p2 == RETURNPKT) {
                result = ReadExprRaw(lp);
                WSNewPacket(lp);
                break;
            }
            if (p2 == RETURNTEXTPKT) {
                const char* s = nullptr; WSGetString(lp, &s);
                std::string txt = s ? rtrimNL(s) : ""; if (s) WSReleaseString(lp, s);
                WSNewPacket(lp);
                DiagLog("[SDR] RETURNTEXTPKT text='" + txt.substr(0, 60) + "'");
                if (txt.empty()) {
                    result = WExpr::mkSymbol("System`Null");
                } else {
                    try {
                        size_t pos = 0;
                        long long iv = std::stoll(txt, &pos);
                        if (pos == txt.size()) { result.kind = WExpr::Integer; result.intVal = iv; }
                        else { throw std::exception(); }
                    } catch (...) {
                        try {
                            size_t pos = 0;
                            double rv = std::stod(txt, &pos);
                            if (pos == txt.size()) { result.kind = WExpr::Real; result.realVal = rv; }
                            else { throw std::exception(); }
                        } catch (...) {
                            result.kind = WExpr::String; result.strVal = txt;
                        }
                    }
                }
                break;
            }
            if (p2 == RETURNEXPRPKT) {
                result = ReadExprRaw(lp);
                WSNewPacket(lp);
                if (!menuDlgProto) break;
                continue;
            }
            if (p2 == ENDDLGPKT) {
                wsint64 endLevel = 0;
                if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &endLevel);
                WSNewPacket(lp);
                if (opts->dialogOpen) opts->dialogOpen->store(false);
                if (opts->hasOnDialogEnd)
                    opts->onDialogEnd.NonBlockingCall(
                        [endLevel](Napi::Env e, Napi::Function cb){
                            cb.Call({Napi::Number::New(e, static_cast<double>(endLevel))}); });
                result.kind = WExpr::Symbol;
                result.strVal = "Null";
                dialogEndedHere = true;
                break;
            }
            if (p2 == MESSAGEPKT) { if (!handleMessage(true)) { r.result = WExpr::mkError("WSTP link error during dialog message"); break; } continue; }
            if (p2 == TEXTPKT) {
                const char* s = nullptr; WSGetString(lp, &s);
                if (s) {
                    std::string line = rtrimNL(s); WSReleaseString(lp, s);
                    if (menuDlgProto && !req.useEnterText) {
                        DiagLog("[SDR] TEXTPKT(menuDlg) text='" + line + "'");
                        if (!line.empty()) {
                            if (!lastDlgText.empty()) lastDlgText += "\n";
                            lastDlgText += line;
                        }
                    } else {
                        if (opts->hasOnDialogPrint)
                            opts->onDialogPrint.NonBlockingCall(
                                [line](Napi::Env e, Napi::Function cb){
                                    cb.Call({Napi::String::New(e, line)}); });
                    }
                }
                WSNewPacket(lp); continue;
            }
            if (p2 == INPUTNAMEPKT || p2 == OUTPUTNAMEPKT) { WSNewPacket(lp); continue; }
            if (p2 == MENUPKT) {
                if (req.useEnterText) {
                    wsint64 menuType2_ = 0; WSGetInteger64(lp, &menuType2_);
                    const char* menuPrompt2_ = nullptr; WSGetString(lp, &menuPrompt2_);
                    if (menuPrompt2_) WSReleaseString(lp, menuPrompt2_);
                    WSNewPacket(lp);
                    WSPutString(lp, "c");
                    WSEndPacket(lp);
                    WSFlush(lp);
                    if (opts->dialogOpen) opts->dialogOpen->store(false);
                    if (opts->hasOnDialogEnd)
                        opts->onDialogEnd.NonBlockingCall(
                            [](Napi::Env e, Napi::Function cb){
                                cb.Call({Napi::Number::New(e, 0.0)}); });
                    result.kind = WExpr::Symbol;
                    result.strVal = "Null";
                    dialogEndedHere = true;
                } else if (menuDlgProto) {
                    WSNewPacket(lp);
                    if (lastDlgText.empty() && !menuDlgFirstSkipped) {
                        menuDlgFirstSkipped = true;
                        DiagLog("[SDR] menuDlg: skipping pre-result MENUPKT, waiting for TEXTPKT");
                        continue;
                    }
                    DiagLog("[SDR] menuDlg: end-of-result MENUPKT, lastDlgText='" + lastDlgText + "'");
                    if (lastDlgText.empty()) {
                        result = WExpr::mkSymbol("System`Null");
                    } else {
                        try {
                            size_t pos = 0;
                            long long iv = std::stoll(lastDlgText, &pos);
                            if (pos == lastDlgText.size()) {
                                result.kind   = WExpr::Integer;
                                result.intVal = iv;
                            } else { throw std::exception(); }
                        } catch (...) {
                            try {
                                size_t pos = 0;
                                double rv = std::stod(lastDlgText, &pos);
                                if (pos == lastDlgText.size()) {
                                    result.kind    = WExpr::Real;
                                    result.realVal = rv;
                                } else { throw std::exception(); }
                            } catch (...) {
                                result.kind   = WExpr::String;
                                result.strVal = lastDlgText;
                            }
                        }
                    }
                } else {
                    WSNewPacket(lp);
                    if (result.kind == WExpr::WError)
                        result = WExpr::mkSymbol("System`Null");
                }
                break;
            }
            if (p2 == 0 || p2 == ILLEGALPKT) {
                const char* m = WSErrorMessage(lp); WSClearError(lp);
                result = WExpr::mkError(m ? m : "WSTP error in dialogEval");
                break;
            }
            WSNewPacket(lp);
        }
        WExpr res = result;
        req.resolve.NonBlockingCall(
            [res](Napi::Env e, Napi::Function cb){ cb.Call({WExprToNapi(e, res)}); });
        req.resolve.Release();
        return !dialogEndedHere;
    };

    // -----------------------------------------------------------------------
    // Outer drain loop — blocking WSNextPacket (unchanged for normal evals).
    // Dialog packets trigger the inner loop below.
    // -----------------------------------------------------------------------
    bool gotOutputName = false;
    bool gotResult     = false;
    while (true) {
        if (opts && opts->rejectDialog)
            DiagLog("[Eval] WSNextPacket waiting... (rejectDialog)");
        int pkt = WSNextPacket(lp);
        DiagLog("[Eval] pkt=" + std::to_string(pkt));

        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT) {
            if (opts && opts->interactive && pkt == RETURNEXPRPKT) {
                int tok = WSGetType(lp);
                if (tok == WSTKSYM || tok == WSTKINT || tok == WSTKREAL || tok == WSTKSTR) {
                    r.result = ReadExprRaw(lp);
                } else {
                    r.result = WExpr::mkSymbol("System`__VsCodeHasResult__");
                }
            } else {
                r.result = ReadExprRaw(lp);
            }
            WSNewPacket(lp);
            if (r.result.kind == WExpr::Symbol && stripCtx(r.result.strVal) == "$Aborted")
                r.aborted = true;
            gotResult = true;
            if (!opts || !opts->interactive) {
                if (!r.aborted) drainStalePackets(lp, opts);
                break;
            }
            // Interactive mode: fall through to consume trailing INPUTNAMEPKT.
        }
        else if (pkt == INPUTNAMEPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            std::string nameStr = s ? s : "";
            if (s) WSReleaseString(lp, s);
            WSNewPacket(lp);
            if (opts && opts->interactive) {
                if (!gotOutputName && !gotResult) {
                    int64_t nextIdx = parseCellIndex(nameStr);
                    r.cellIndex = (nextIdx > 1) ? nextIdx - 1 : nextIdx;
                    r.result = WExpr::mkSymbol("System`Null");
                    break;
                }
                if (!r.aborted) drainStalePackets(lp, opts);
                break;
            }
            r.cellIndex = parseCellIndex(nameStr);
        }
        else if (pkt == OUTPUTNAMEPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) {
                std::string name = s; WSReleaseString(lp, s);
                while (!name.empty() && name.back() == ' ') name.pop_back();
                r.outputName = name;
                r.cellIndex = parseCellIndex(name);
            }
            WSNewPacket(lp);
            gotOutputName = true;
        }
        else if (pkt == TEXTPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) {
                std::string line = rtrimNL(s);
                WSReleaseString(lp, s);
                DiagLog("[Eval] TEXTPKT content='" + line.substr(0, 60) + "'");
                r.print.emplace_back(line);
                if (opts && opts->hasOnPrint) {
                    DiagLog("[TSFN][onPrint] dispatch +" + std::to_string(diagMs())
                            + "ms \"" + line.substr(0, 30) + "\"");
                    opts->onPrint.NonBlockingCall(
                        [line](Napi::Env env, Napi::Function cb){
                            cb.Call({ Napi::String::New(env, line) }); });
                }
            }
            WSNewPacket(lp);
        }
        else if (pkt == MESSAGEPKT) {
            if (!handleMessage(false)) break;
        }
        else if (pkt == BEGINDLGPKT) {
            // ----------------------------------------------------------------
            // Dialog subsession opened by the kernel.
            // ----------------------------------------------------------------
            wsint64 level = 0;
            if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &level);
            WSNewPacket(lp);

            // ---- rejectDialog: auto-close without informing JS layer --------
            if (opts && opts->rejectDialog) {
                DiagLog("[Eval] rejectDialog: auto-closing BEGINDLGPKT level=" + std::to_string(level));
                // Wait for INPUTNAMEPKT (dialog prompt) before sending input
                bool dialogAlreadyClosed = false;
                {
                    auto preDl = std::chrono::steady_clock::now() +
                                 std::chrono::milliseconds(500);
                    while (std::chrono::steady_clock::now() < preDl) {
                        if (!WSReady(lp)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                            continue;
                        }
                        int ipkt = WSNextPacket(lp);
                        DiagLog("[Eval] rejectDialog: pre-drain pkt=" + std::to_string(ipkt));
                        WSNewPacket(lp);
                        if (ipkt == INPUTNAMEPKT) break;
                        if (ipkt == 0 || ipkt == ILLEGALPKT) { WSClearError(lp); dialogAlreadyClosed = true; break; }
                    }
                }
                // Close the dialog with Return[].
                // No kernel-level flag needed — C++ handles all state.
                // Return[] exits the Dialog and resumes the outer eval.
                // drainUntilEndDialog handles any nested dialogs from
                // ScheduledTask firing while we drain.
                if (!dialogAlreadyClosed) {
                    const char* closeExpr = "Return[]";
                    WSPutFunction(lp, "EnterTextPacket", 1);
                    WSPutUTF8String(lp,
                        reinterpret_cast<const unsigned char*>(closeExpr),
                        static_cast<int>(std::strlen(closeExpr)));
                    WSEndPacket(lp); WSFlush(lp);
                    DiagLog("[Eval] rejectDialog: sent Return[], draining until ENDDLGPKT");
                    drainUntilEndDialog(lp, 3000);
                }
                DiagLog("[Eval] rejectDialog: dialog closed, continuing outer loop");
                continue;
            }

            // ---- dynAutoMode / subAuto: C++-internal inline evaluation -------
            bool hasAutoEntries = false;
            if (opts && opts->autoMutex && opts->autoExprQueue) {
                std::lock_guard<std::mutex> lk(*opts->autoMutex);
                hasAutoEntries = !opts->autoExprQueue->empty();
            }
            if (!opts || opts->dynAutoMode || hasAutoEntries) {
                // Signal the timer thread that a dialog is open so it
                // doesn't send WSInterruptMessage while we do link I/O.
                if (opts && opts->dialogOpen) opts->dialogOpen->store(true);
                if (opts && opts->sentLog) opts->sentLog->append("RECV BEGINDLGPKT");
                if (opts && opts->kernelStatus)
                    SetDialog(*opts->kernelStatus, DialogState::DynDialog, "drain:BEGINDLGPKT:dynAuto");
                // Safeguard: if abort is in progress, don't enter DynDialog — just close
                if (opts && opts->kernelStatus && GetAbort(*opts->kernelStatus) != AbortState::None) {
                    DiagLog("[Eval] BEGINDLGPKT dynAuto: abort in progress — auto-closing");
                    if (opts->dialogOpen) opts->dialogOpen->store(false);
                    if (opts->menuPktPending) opts->menuPktPending->store(false);
                    SetDialog(*opts->kernelStatus, DialogState::None, "drain:BEGINDLGPKT:abortReject");
                    const char* closeExpr = "Return[$Failed]";
                    WSPutFunction(lp, "EnterTextPacket", 1);
                    WSPutUTF8String(lp, reinterpret_cast<const unsigned char*>(closeExpr),
                                   static_cast<int>(std::strlen(closeExpr)));
                    WSEndPacket(lp); WSFlush(lp);
                    drainUntilEndDialog(lp, 3000);
                    continue;
                }
                // Capture whether a MENUPKT is currently in the WSTP pipe
                // menuPktPending is read inside DialogSession's constructor
                // (which now owns the pre-drain logic); no need to read it here.

                if (opts && opts->abortFlag && opts->abortFlag->load()) {
                    if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                    if (opts && opts->menuPktPending) opts->menuPktPending->store(false);
                    r.result = WExpr::mkSymbol("System`$Aborted");
                    r.aborted = true;
                    drainDialogAbortResponse(lp);
                    return r;
                }

                // ── Open dialog session (pre-drains to INPUTNAMEPKT) ──────────
                WExpr capturedOuter;
                {
                    DialogSession dlg(lp, opts);

                    if (dlg.valid()) {
                        // ── dynRegistry: evaluate registered Dynamic expressions ──
                        if (opts && opts->dynMutex && opts->dynRegistry && opts->dynResults) {
                            std::lock_guard<std::mutex> lk(*opts->dynMutex);
                            if (opts->kernelStatus)
                                SetSubWork(*opts->kernelStatus, SubWork::DynExpr, "drain:dynExpr:start");
                            auto nowMs = static_cast<double>(
                                std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::system_clock::now().time_since_epoch())
                                .count());
                            for (const auto& reg : *opts->dynRegistry) {
                                if (opts->kernelStatus && GetLink(*opts->kernelStatus) != LinkState::Alive) {
                                    DiagLog("[Eval] dynExpr: link died, stopping"); break;
                                }
                                if (opts->kernelStatus && GetAbort(*opts->kernelStatus) != AbortState::None) {
                                    DiagLog("[Eval] dynExpr: abort detected, stopping"); break;
                                }
                                DiagLog("[Eval] dynExpr id=" + reg.id + " expr='" + reg.expr + "'");
                                DynResult dr; dr.id = reg.id; dr.timestamp = nowMs;
                                dlg.evaluate(reg.id, reg.expr, dr, &capturedOuter);
                                opts->dynResults->push_back(std::move(dr));
                                bool outerSet = capturedOuter.kind != WExpr::WError ||
                                               !capturedOuter.strVal.empty();
                                if (outerSet) break;
                                if (opts->abortFlag && opts->abortFlag->load()) break;
                            }
                            if (opts->dynLastEval)
                                *opts->dynLastEval = std::chrono::steady_clock::now();
                            if (opts->kernelStatus)
                                SetSubWork(*opts->kernelStatus, SubWork::None, "drain:dynExpr:done");
                        }

                        // ── subAuto: one-shot inline evaluations ──────────────
                        bool outerSetBeforeAuto = capturedOuter.kind != WExpr::WError ||
                                                  !capturedOuter.strVal.empty();
                        if (!outerSetBeforeAuto &&
                            opts && opts->autoMutex && opts->autoExprQueue && opts->autoCompleted) {
                            std::lock_guard<std::mutex> aLk(*opts->autoMutex);
                            while (!opts->autoExprQueue->empty()) {
                                if (opts->kernelStatus && GetLink(*opts->kernelStatus) != LinkState::Alive) {
                                    DiagLog("[Eval] subAuto: link died, stopping"); break;
                                }
                                if (opts->kernelStatus && GetAbort(*opts->kernelStatus) != AbortState::None) {
                                    DiagLog("[Eval] subAuto: abort detected, stopping"); break;
                                }
                                auto entry = std::move(opts->autoExprQueue->front());
                                opts->autoExprQueue->pop_front();
                                if (opts->kernelStatus)
                                    SetSubWork(*opts->kernelStatus, SubWork::SubBusy, "drain:subAuto");
                                DiagLog("[Eval] subAuto id=" + std::to_string(entry.id) + " expr='" + entry.expr + "'");
                                DynResult dr;
                                dlg.evaluate(std::to_string(entry.id), entry.expr, dr, &capturedOuter);
                                opts->autoCompleted->push_back({entry.id, dr.value, dr.error});
                                bool outerSet2 = capturedOuter.kind != WExpr::WError ||
                                                 !capturedOuter.strVal.empty();
                                if (outerSet2) break;
                                if (opts->abortFlag && opts->abortFlag->load()) break;
                            }
                            if (opts->kernelStatus)
                                SetSubWork(*opts->kernelStatus, SubWork::None, "drain:subAuto:done");
                            if (!opts->autoCompleted->empty() &&
                                opts->autoTsfnActive && opts->autoTsfnActive->load()) {
                                opts->autoResolverTsfn->NonBlockingCall(
                                    [](Napi::Env, Napi::Function fn) { fn.Call({}); });
                            }
                        }
                    }

                    // ── Close dialog: Return[$Failed] + drain ENDDLGPKT ──────
                    bool closeOk = dlg.close(&capturedOuter);
                    if (!closeOk) {
                        DiagLog("[Eval] dynAutoMode: drainUntilEndDialog timed out; aborting");
                        if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                        if (opts && opts->menuPktPending) opts->menuPktPending->store(false);
                        if (opts && opts->kernelStatus)
                            SetDialog(*opts->kernelStatus, DialogState::None, "drain:dynDialog:timeout");
                        r.aborted = true;
                        r.result = WExpr::mkSymbol("System`$Aborted");
                        drainDialogAbortResponse(lp);
                        return r;
                    }
                }  // DialogSession destroyed — dialog closed

                // ── Clean up state, return or continue ───────────────────────
                if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                if (opts && opts->menuPktPending) opts->menuPktPending->store(false);
                if (opts && opts->kernelStatus)
                    SetDialog(*opts->kernelStatus, DialogState::None, "drain:dynDialog:closed");

                {
                    bool outerCaptured = capturedOuter.kind != WExpr::WError ||
                                         !capturedOuter.strVal.empty();
                    if (outerCaptured) {
                        DiagLog("[Eval] dynAutoMode: outer RETURNPKT captured — returning directly");
                        r.result = std::move(capturedOuter);
                        if (r.result.kind == WExpr::Symbol &&
                            stripCtx(r.result.strVal) == "$Aborted")
                            r.aborted = true;
                        drainStalePackets(lp, opts);
                        return r;
                    }
                }
                // Dialog closed — continue outer loop waiting for RETURNPKT.
                continue;
            }

            // ---- Safety fallback: no onDialogBegin callback registered -----
            // ---- Safety fallback: no onDialogBegin callback registered -----
            if (!opts || !opts->hasOnDialogBegin) {
                DiagLog("[Eval] BEGINDLGPKT: no onDialogBegin callback — auto-closing "
                        "(dynAutoMode=false, hasOnDialogBegin=false)");
                {
                    auto preDl = std::chrono::steady_clock::now() +
                                 std::chrono::milliseconds(500);
                    while (std::chrono::steady_clock::now() < preDl) {
                        if (!WSReady(lp)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                            continue;
                        }
                        int ipkt = WSNextPacket(lp);
                        DiagLog("[Eval] BEGINDLGPKT safety: pre-drain pkt=" + std::to_string(ipkt));
                        WSNewPacket(lp);
                        if (ipkt == INPUTNAMEPKT) break;
                        if (ipkt == 0 || ipkt == ILLEGALPKT) { WSClearError(lp); break; }
                    }
                }
                const char* closeExpr = "Return[$Failed]";
                WSPutFunction(lp, "EnterTextPacket", 1);
                WSPutUTF8String(lp,
                    reinterpret_cast<const unsigned char*>(closeExpr),
                    static_cast<int>(std::strlen(closeExpr)));
                WSEndPacket(lp);
                WSFlush(lp);
                DiagLog("[Eval] BEGINDLGPKT safety: sent Return[$Failed], draining until ENDDLGPKT");
                WExpr safetyCaptured;
                bool  safetyGotOuter = false;
                {
                    auto dlgDeadline = std::chrono::steady_clock::now() +
                                       std::chrono::milliseconds(2000);
                    while (std::chrono::steady_clock::now() < dlgDeadline) {
                        if (!WSReady(lp)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                            continue;
                        }
                        int rp = WSNextPacket(lp);
                        DiagLog("[Eval] BEGINDLGPKT safety: drain pkt=" + std::to_string(rp));
                        if ((rp == RETURNPKT || rp == RETURNEXPRPKT) && !safetyGotOuter) {
                            safetyCaptured = ReadExprRaw(lp);
                            safetyGotOuter = true;
                            DiagLog("[Eval] BEGINDLGPKT safety: captured outer RETURNPKT");
                        }
                        WSNewPacket(lp);
                        if (rp == ENDDLGPKT) break;
                        if (rp == 0 || rp == ILLEGALPKT) { WSClearError(lp); break; }
                    }
                }
                if (safetyGotOuter) {
                    DiagLog("[Eval] BEGINDLGPKT safety: returning captured outer result");
                    r.result = std::move(safetyCaptured);
                    if (r.result.kind == WExpr::Symbol &&
                        stripCtx(r.result.strVal) == "$Aborted")
                        r.aborted = true;
                    drainStalePackets(lp, opts);
                    return r;
                }
                continue;
            }

            if (opts && opts->dialogOpen)
                opts->dialogOpen->store(true);
            if (opts && opts->kernelStatus)
                SetDialog(*opts->kernelStatus, DialogState::UserDialog, "drain:BEGINDLGPKT:user");
            if (opts && opts->hasOnDialogBegin)
                opts->onDialogBegin.NonBlockingCall(
                    [level](Napi::Env e, Napi::Function cb){
                        cb.Call({Napi::Number::New(e, static_cast<double>(level))}); });

            // ----------------------------------------------------------------
            // Dialog inner loop — WSReady-gated so dialogQueue_ can be serviced
            // between kernel packets without blocking indefinitely.
            // ----------------------------------------------------------------
            bool dialogDone = false;
            while (!dialogDone) {
                if (opts && opts->abortFlag && opts->abortFlag->load()) {
                    if (opts->dialogOpen) opts->dialogOpen->store(false);
                    r.result = WExpr::mkSymbol("System`$Aborted");
                    r.aborted = true;
                    drainDialogAbortResponse(lp);
                    return r;
                }

                if (opts && opts->dialogPending && opts->dialogPending->load()) {
                    if (!serviceDialogRequest()) {
                        dialogDone = true;
                        continue;
                    }
                }

                if (!WSReady(lp)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                    continue;
                }

                int dpkt = WSNextPacket(lp);
                DiagLog("[Dialog] dpkt=" + std::to_string(dpkt));
                if (dpkt == ENDDLGPKT) {
                    wsint64 endLevel = 0;
                    if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &endLevel);
                    WSNewPacket(lp);
                    if (opts && opts->dialogOpen)
                        opts->dialogOpen->store(false);
                    if (opts && opts->kernelStatus)
                        SetDialog(*opts->kernelStatus, DialogState::None, "drain:userDialog:closed");
                    if (opts && opts->hasOnDialogEnd)
                        opts->onDialogEnd.NonBlockingCall(
                            [endLevel](Napi::Env e, Napi::Function cb){
                                cb.Call({Napi::Number::New(e, static_cast<double>(endLevel))}); });
                    dialogDone = true;
                }
                else if (dpkt == RETURNPKT) {
                    WExpr innerExpr = ReadExprRaw(lp);
                    WSNewPacket(lp);
                    if (innerExpr.kind == WExpr::Symbol &&
                        stripCtx(innerExpr.strVal) == "$Aborted") {
                        if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                        r.result = innerExpr;
                        r.aborted = true;
                        return r;
                    }
                    // Otherwise discard — outer loop will see final RETURNPKT.
                }
                else if (dpkt == INPUTNAMEPKT || dpkt == OUTPUTNAMEPKT) {
                    WSNewPacket(lp);
                }
                else if (dpkt == TEXTPKT) {
                    DiagLog("[Dialog] TEXTPKT");
                    const char* s = nullptr; WSGetString(lp, &s);
                    if (s) {
                        std::string line = rtrimNL(s); WSReleaseString(lp, s);
                        if (opts && opts->hasOnDialogPrint)
                            opts->onDialogPrint.NonBlockingCall(
                                [line](Napi::Env e, Napi::Function cb){
                                    cb.Call({Napi::String::New(e, line)}); });
                    }
                    WSNewPacket(lp);
                }
                else if (dpkt == MESSAGEPKT) {
                    if (!handleMessage(true)) {
                        r.result = WExpr::mkError("WSTP link error during message");
                        return r;
                    }
                }
                else if (dpkt == 0 || dpkt == ILLEGALPKT) {
                    const char* m = WSErrorMessage(lp);
                    WSClearError(lp);
                    if (opts && opts->linkDead) opts->linkDead->store(true);
                    if (opts && opts->kernelStatus) SetLink(*opts->kernelStatus, LinkState::Dead, "drain:dialog:linkDead");
                    if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                    if (opts && opts->abortFlag && opts->abortFlag->load()) {
                        r.result = WExpr::mkSymbol("System`$Aborted");
                        r.aborted = true;
                    } else {
                        r.result = WExpr::mkError(m ? m : "WSTP error in dialog");
                    }
                    return r;
                }
                else {
                    WSNewPacket(lp);
                }
            }
            // Dialog closed — continue outer loop waiting for the original RETURNPKT.
        }
        else if (pkt == 0 || pkt == ILLEGALPKT) {
            const char* m = WSErrorMessage(lp);
            std::string s = m ? m : "WSTP link error";
            WSClearError(lp);
            DiagLog("[Eval] pkt=0 in outer loop — link dead: " + s);
            if (opts && opts->linkDead) opts->linkDead->store(true);
            if (opts && opts->kernelStatus) SetLink(*opts->kernelStatus, LinkState::Dead, "drain:outerLoop:linkDead");
            r.result = WExpr::mkError(s);
            break;
        }
        else if (pkt == RETURNTEXTPKT) {
            // An EvaluatePacket may produce RETURNTEXTPKT instead of
            // RETURNPKT when the eval was interrupted by a pending abort
            // (MENUPKT type=0 from a prior 'a' response while idle).
            // Capture the value as the eval result.
            r.result = ReadExprRaw(lp);
            WSNewPacket(lp);
            if (r.result.kind == WExpr::Symbol && stripCtx(r.result.strVal) == "$Aborted")
                r.aborted = true;
            gotResult = true;
            DiagLog("[Eval] RETURNTEXTPKT captured kind=" +
                    std::to_string(r.result.kind) +
                    " val=" + (r.result.kind == WExpr::String ? r.result.strVal : "?"));
            if (!opts || !opts->interactive) {
                if (!r.aborted) drainStalePackets(lp, opts);
                break;
            }
            // Interactive mode: fall through to consume trailing INPUTNAMEPKT.
        }
        else if (pkt == MENUPKT) {
            // ----------------------------------------------------------------
            // MENUPKT (6) — interrupt menu
            // ----------------------------------------------------------------
            wsint64 menuType_ = 0; WSGetInteger64(lp, &menuType_);
            const char* menuPrompt_ = nullptr; WSGetString(lp, &menuPrompt_);
            if (menuPrompt_) WSReleaseString(lp, menuPrompt_);
            WSNewPacket(lp);

            bool wantInspect = opts && !opts->dynAutoMode && opts->hasOnDialogBegin;
            // In dynAutoMode the timer sends WSInterruptMessage during busy
            // evals.  Enter Dialog if there are registered Dynamic entries.
            if (!wantInspect && opts && opts->dynAutoMode && opts->dynMutex && opts->dynRegistry) {
                std::lock_guard<std::mutex> lk(*opts->dynMutex);
                if (!opts->dynRegistry->empty()) wantInspect = true;
            }
            if (!wantInspect && opts && opts->autoMutex && opts->autoExprQueue) {
                std::lock_guard<std::mutex> lk(*opts->autoMutex);
                if (!opts->autoExprQueue->empty()) wantInspect = true;
            }
            const char* resp;
            if (wantInspect) {
                resp = "i";
            } else if (opts && opts->rejectDialog) {
                resp = "c";
            } else if (menuType_ == 1) {
                resp = "a";
            } else {
                resp = "c";
            }
            DiagLog("[Eval] MENUPKT type=" + std::to_string(menuType_) + " — responding '" + resp + "'");
            WSPutString(lp, resp);
            WSEndPacket(lp);
            WSFlush(lp);
            // Always clear menuPktPending when MENUPKT is consumed — regardless
            // of the response character.  This is the critical fix for Path B:
            // when MENUPKT arrives before BEGINDLGPKT and we respond 'i',
            // menuPktPending must become false so the pre-drain does not wait
            // for a MENUPKT that was already consumed here.
            if (opts && opts->menuPktPending)
                opts->menuPktPending->store(false);
        }
        else {
            DiagLog("[Eval] unknown pkt=" + std::to_string(pkt) + ", discarding");
            WSNewPacket(lp);
        }
    }

    return r;
}
