// =============================================================================
// wstp-backend/src/addon.cc   (v0.6.4 — stale-drain, timer+MENUPKT for subAuto)
//
// Architecture:
//   Execute()  runs on the libuv thread pool → does ALL blocking WSTP I/O,
//              stores result in plain C++ structs (WExpr / EvalResult, no NAPI).
//   OnOK()     runs on the JS main thread     → converts to Napi::Value.
//
// EvalResult captures everything the kernel sends for one cell:
//   cellIndex (1-based, tracked by WstpSession::nextLine_), outputName,
//   return value, Print[] lines, and messages.
// This means the Node.js event loop is NEVER blocked, so abort() fires
// correctly while Execute() is waiting inside WSNextPacket() on the thread pool.
// =============================================================================

#include <napi.h>
#include <wstp.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <thread>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <signal.h>   // kill(), SIGTERM
#include <sys/types.h>

// ===========================================================================
// Plain C++ expression tree — no NAPI, safe to build on any thread.
// ===========================================================================
struct WExpr {
    enum Kind { Integer, Real, String, Symbol, Function, WError } kind = WError;

    int64_t     intVal  = 0;
    double      realVal = 0.0;
    std::string strVal;          // string content, symbol name, or error msg
    std::string head;            // function head symbol
    std::vector<WExpr> args;     // function arguments

    static WExpr mkError(const std::string& msg) {
        WExpr e; e.kind = WError; e.strVal = msg; return e;
    }
    static WExpr mkSymbol(const std::string& name) {
        WExpr e; e.kind = Symbol; e.strVal = name; return e;
    }
};

// ---------------------------------------------------------------------------
// EvalResult — everything the kernel sends for one cell (thread-pool safe).
// ---------------------------------------------------------------------------
struct EvalResult {
    int64_t                  cellIndex  = 0;   // 1-based counter, tracked by WstpSession::nextLine_
    std::string              outputName;       // "Out[n]=" when result is non-Null, "" otherwise
    WExpr                    result;           // the ReturnPacket payload
    std::vector<std::string> print;            // TextPacket lines in order
    std::vector<std::string> messages;         // e.g. "Power::infy: Infinite expression..."
    bool                     aborted = false;
};

// ---------------------------------------------------------------------------
// EvalOptions — optional streaming callbacks for one evaluate() call.
// ThreadSafeFunctions (TSFNs) are safe to call from any thread, which is
// what makes streaming from Execute() (thread pool) possible.
// ---------------------------------------------------------------------------

// Latch that fires fn() once after ALL parties have called done().
// remaining is initialised to numTsfns + 1 (the +1 is for OnOK / OnError).
// IMPORTANT: all calls happen on the main thread — no atomics needed.
struct CompleteCtx {
    int                   remaining;
    std::function<void()> fn;   // set by OnOK/OnError; called when remaining → 0
    void done() {
        if (--remaining == 0) { if (fn) fn(); delete this; }
    }
};

// ---------------------------------------------------------------------------
// DialogRequest — one dialogEval() call queued for the thread pool.
// Written on the main thread; consumed exclusively on the thread pool while
// the dialog inner loop is running.  The TSFN delivers the result back.
// ---------------------------------------------------------------------------
struct DialogRequest {
    std::string              expr;
    bool                     useEnterText = false;  // true → EnterTextPacket; false → EvaluatePacket
    Napi::ThreadSafeFunction resolve;  // NonBlockingCall'd with the WExpr result
};

// ---------------------------------------------------------------------------
// Dynamic evaluation registration and result types.  Defined at file scope so
// both EvalOptions and WstpSession can use them without circular dependencies.
// ---------------------------------------------------------------------------
struct DynRegistration {
    std::string id;
    std::string expr;
};
struct DynResult {
    std::string id;
    std::string value;
    double      timestamp = 0.0;   // ms since epoch (set when stored)
    std::string error;             // non-empty if evaluation failed
};

// ---------------------------------------------------------------------------
// subAuto() — one-shot auto-routing evaluation types.
// When the kernel is busy, these are evaluated inline inside the next
// ScheduledTask Dialog[]; when idle, they fall through to subWhenIdle.
// ---------------------------------------------------------------------------
struct AutoExprEntry {
    size_t      id;
    std::string expr;
};
struct AutoResultEntry {
    size_t      id;
    std::string value;
    std::string error;
};

struct EvalOptions {
    Napi::ThreadSafeFunction onPrint;         // fires once per Print[] line
    Napi::ThreadSafeFunction onMessage;       // fires once per kernel message
    Napi::ThreadSafeFunction onDialogBegin;   // fires with dialog level (int)
    Napi::ThreadSafeFunction onDialogPrint;   // fires with dialog Print[] lines
    Napi::ThreadSafeFunction onDialogEnd;     // fires with dialog level (int)
    bool         hasOnPrint        = false;
    bool         hasOnMessage      = false;
    bool         hasOnDialogBegin  = false;
    bool         hasOnDialogPrint  = false;
    bool         hasOnDialogEnd    = false;
    // When true, DrainToEvalResult expects EnterExpressionPacket protocol:
    // INPUTNAMEPKT → OUTPUTNAMEPKT → RETURNEXPRPKT (or INPUTNAMEPKT for Null).
    bool         interactive       = false;
    // When true, any BEGINDLGPKT received during the drain is immediately
    // auto-closed (Return[$Failed] sent) without informing the JS layer.
    // Use for non-interactive VsCodeRender/handler-install evals to prevent
    // a concurrent interrupt from hanging the evaluation forever (Pattern C).
    bool         rejectDialog      = false;
    // Phase 2 Dynamic eval: pointers wired up by Evaluate() so DrainToEvalResult
    // can inline-evaluate registered Dynamic expressions inside BEGINDLGPKT.
    // When dynAutoMode is false, legacy JS-callback dialog path is used instead.
    std::mutex*                       dynMutex       = nullptr;
    std::vector<DynRegistration>*     dynRegistry    = nullptr;  // non-owning
    std::vector<DynResult>*           dynResults     = nullptr;  // non-owning
    std::chrono::steady_clock::time_point* dynLastEval = nullptr;
    bool         dynAutoMode       = true;   // mirrors dynAutoMode_ at time of queue dispatch
    int          dynIntervalMs     = 0;      // mirrors dynIntervalMs_ at time of queue dispatch
    int*         dynTaskInstalledInterval = nullptr; // non-owning; tracks installed ScheduledTask interval
    // subAuto() — one-shot inline Dialog[] evaluations.
    // Pointers wired by Evaluate() so DrainToEvalResult can evaluate
    // pending subAuto() entries inside BEGINDLGPKT alongside dynRegistry.
    std::mutex*                       autoMutex        = nullptr;
    std::deque<AutoExprEntry>*        autoExprQueue    = nullptr;
    std::vector<AutoResultEntry>*     autoCompleted    = nullptr;
    Napi::ThreadSafeFunction*         autoResolverTsfn = nullptr;
    std::atomic<bool>*                autoTsfnActive   = nullptr;
    CompleteCtx* ctx               = nullptr;  // non-owning; set when TSFNs are in use

    // Pointers to session's dialog queue — set by WstpSession::Evaluate() so the
    // drain loop can service dialogEval() requests from the thread pool.
    // Non-owning; valid for the lifetime of the EvaluateWorker.
    std::mutex*               dialogMutex   = nullptr;
    std::queue<DialogRequest>* dialogQueue  = nullptr;
    std::atomic<bool>*         dialogPending = nullptr;
    std::atomic<bool>*         dialogOpen    = nullptr;
    // Session-level abort flag — set by abort() on the main thread; checked in
    // the dialog inner loop to break out proactively when abort() is called.
    std::atomic<bool>*         abortFlag     = nullptr;
};

// ===========================================================================
// Module-level diagnostic channel.
// setDiagHandler(fn) registers a JS callback; DiagLog(msg) fires it from any
// C++ thread.  Both the global flag and the TSFN are guarded by g_diagMutex.
// The TSFN is Unref()'d so it does not prevent the Node.js event loop from
// exiting normally.
// ===========================================================================
static std::mutex               g_diagMutex;
static Napi::ThreadSafeFunction g_diagTsfn;
static bool                     g_diagActive = false;

// If DEBUG_WSTP=1 is set in the environment at module-load time, every
// DiagLog message is also written synchronously to stderr via fwrite.
// Useful when no JS setDiagHandler is registered (e.g. bare node runs).
static const bool g_debugToStderr = []() {
    const char* v = getenv("DEBUG_WSTP");
    return v && v[0] == '1';
}();

// Module-relative timestamp helper — milliseconds since module load.
// Used to embed C++ dispatch times in log messages so JS-side handler
// timestamps can be compared to measure TSFN delivery latency.
static auto g_startTime = std::chrono::steady_clock::now();
static long long diagMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - g_startTime).count();
}

static void DiagLog(const std::string& msg) {
    if (g_debugToStderr) {
        std::string out = "[wstp +" + std::to_string(diagMs()) + "ms] " + msg + "\n";
        fwrite(out.c_str(), 1, out.size(), stderr);
    }
    std::lock_guard<std::mutex> lk(g_diagMutex);
    if (!g_diagActive) return;
    // NonBlockingCall with lambda — copies msg by value into the captured closure.
    g_diagTsfn.NonBlockingCall(
        [msg](Napi::Env env, Napi::Function fn) {
            fn.Call({ Napi::String::New(env, msg) });
        });
}

// ---------------------------------------------------------------------------
// ReadExprRaw — build a WExpr from one WSTP token/expression (any thread).
// ---------------------------------------------------------------------------
static WExpr ReadExprRaw(WSLINK lp, int depth = 0) {
    if (depth > 512) return WExpr::mkError("expression too deep");

    int type = WSGetType(lp);

    if (type == WSTKINT) {
        wsint64 i = 0;
        if (!WSGetInteger64(lp, &i))
            return WExpr::mkError("WSGetInteger64 failed");
        WExpr e; e.kind = WExpr::Integer; e.intVal = i;
        return e;
    }
    if (type == WSTKREAL) {
        double d = 0.0;
        if (!WSGetReal64(lp, &d))
            return WExpr::mkError("WSGetReal64 failed");
        WExpr e; e.kind = WExpr::Real; e.realVal = d;
        return e;
    }
    if (type == WSTKSTR) {
        const char* s = nullptr;
        if (!WSGetString(lp, &s))
            return WExpr::mkError("WSGetString failed");
        WExpr e; e.kind = WExpr::String; e.strVal = s;
        WSReleaseString(lp, s);
        return e;
    }
    if (type == WSTKSYM) {
        const char* s = nullptr;
        if (!WSGetSymbol(lp, &s))
            return WExpr::mkError("WSGetSymbol failed");
        WExpr e; e.kind = WExpr::Symbol; e.strVal = s;
        WSReleaseSymbol(lp, s);
        return e;
    }
    if (type == WSTKFUNC) {
        const char* head = nullptr;
        int argc = 0;
        if (!WSGetFunction(lp, &head, &argc))
            return WExpr::mkError("WSGetFunction failed");
        WExpr e;
        e.kind = WExpr::Function;
        e.head = head;
        WSReleaseSymbol(lp, head);
        e.args.reserve(argc);
        for (int i = 0; i < argc; ++i) {
            WExpr child = ReadExprRaw(lp, depth + 1);
            if (child.kind == WExpr::WError) return child;
            e.args.push_back(std::move(child));
        }
        return e;
    }
    return WExpr::mkError("unexpected token type: " + std::to_string(type));
}

// Forward declaration — WExprToNapi is defined after WstpSession.
static Napi::Value WExprToNapi(Napi::Env env, const WExpr& e);

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
static void drainDialogAbortResponse(WSLINK lp) {
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
        WSNewPacket(lp); // discard intermediate packet (ENDDLGPKT, MENUPKT, …)
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
static void drainStalePackets(WSLINK lp, EvalOptions* opts) {
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
            DiagLog("[Eval] drainStalePackets: stale MENUPKT type=" + std::to_string(menuType) + " — dismissing");
            WSPutString(lp, "");
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
static bool drainUntilEndDialog(WSLINK lp, int timeoutMs,
                                WExpr* capturedOuterResult = nullptr) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!WSReady(lp)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }
        int pkt = WSNextPacket(lp);
        DiagLog("[drainEndDlg] pkt=" + std::to_string(pkt));
        if (pkt == ENDDLGPKT) {
            WSNewPacket(lp);
            return true;
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
static bool readDynResultWithTimeout(WSLINK lp, DynResult& dr, int timeoutMs,
                                     WExpr* capturedOuterResult = nullptr) {
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeoutMs);
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
        if (pkt == TEXTPKT || pkt == MESSAGEPKT ||
            pkt == OUTPUTNAMEPKT || pkt == INPUTNAMEPKT) {
            WSNewPacket(lp);
            continue;
        }
        if (pkt == 0 || pkt == ILLEGALPKT) {
            WSClearError(lp);
            dr.error = "WSTP link error during Dynamic eval";
            return false;
        }
        WSNewPacket(lp);
    }
    dr.error = "timeout";
    return false;
}

// ---------------------------------------------------------------------------
// DrainToEvalResult — consume all packets for one cell, capturing Print[]
// output and messages.  Blocks until RETURNPKT.  Thread-pool thread only.
// opts may be nullptr (no streaming callbacks).
// ---------------------------------------------------------------------------
static EvalResult DrainToEvalResult(WSLINK lp, EvalOptions* opts = nullptr) {
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
    // WSTP sends e.g. "System`MessageName" or "System`Power"; we want the bare name.
    auto stripCtx = [](const std::string& s) -> std::string {
        auto p = s.rfind('`');
        return p != std::string::npos ? s.substr(p + 1) : s;
    };

    // Remove trailing newline(s) that Print[] appends to TextPacket content.
    // WSTP delivers actual '\n' bytes on some platforms and the 4-char literal
    // "\012" (backslash + '0' + '1' + '2') on others (Wolfram's octal escape).
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
    // -----------------------------------------------------------------------
    auto handleMessage = [&](bool forDialog) {
        WSNewPacket(lp);  // discard message-name expression
        if (WSNextPacket(lp) == TEXTPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) {
                std::string text = s;
                WSReleaseString(lp, s);
                static const std::string NL = "\\012";
                std::string msg;
                // Extract the message starting from the Symbol::tag position.
                // Wolfram's TEXTPKT for MESSAGEPKT may contain multiple \012-separated
                // sections (e.g. the tag on one line, the body on subsequent lines).
                // Old code stopped at the first \012 after ::, which truncated long
                // messages like NIntegrate::ncvb to just their tag.
                // Fixed: take the whole text from the start of the Symbol name,
                // stripping only leading/trailing \012 groups, and replacing
                // internal \012 with spaces so the full message is one readable line.
                auto dc = text.find("::");
                size_t raw_start = 0;
                if (dc != std::string::npos) {
                    auto nl_before = text.rfind(NL, dc);
                    raw_start = (nl_before != std::string::npos) ? nl_before + 4 : 0;
                }
                // Strip trailing \012 sequences from the raw text
                std::string raw = text.substr(raw_start);
                while (raw.size() >= 4 && raw.compare(raw.size() - 4, 4, NL) == 0)
                    raw.resize(raw.size() - 4);
                // Strip leading spaces
                size_t sp = 0;
                while (sp < raw.size() && raw[sp] == ' ') ++sp;
                raw = raw.substr(sp);
                // Replace all remaining \012 with a single space
                for (size_t i = 0; i < raw.size(); ) {
                    if (raw.compare(i, 4, NL) == 0) { msg += ' '; i += 4; }
                    else { msg += raw[i++]; }
                }
                if (!forDialog) {
                    r.messages.push_back(msg);
                    if (opts && opts->hasOnMessage)
                        opts->onMessage.NonBlockingCall(
                            [msg](Napi::Env e, Napi::Function cb){
                                cb.Call({Napi::String::New(e, msg)}); });
                } else {
                    // Dialog messages: still append to outer result so nothing is lost.
                    r.messages.push_back(msg);
                    if (opts && opts->hasOnMessage)
                        opts->onMessage.NonBlockingCall(
                            [msg](Napi::Env e, Napi::Function cb){
                                cb.Call({Napi::String::New(e, msg)}); });
                }
            }
        }
        WSNewPacket(lp);
    };

    // -----------------------------------------------------------------------
    // Helper: service one pending DialogRequest from dialogQueue_.
    //
    // menuDlgProto = false (default, BEGINDLGPKT path):
    //   Sends EvaluatePacket[ToExpression[...]], drains until RETURNPKT.
    //
    // menuDlgProto = true  (MENUPKT-dialog path, interrupt-triggered Dialog[]):
    //   Sends EnterExpressionPacket[ToExpression[...]], drains until RETURNEXPRPKT.
    //   The kernel uses MENUPKT as the dialog-prompt between evaluations.
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
        // Send the expression to the kernel's dialog REPL.
        // menuDlgProto / EnterExpressionPacket — interrupt-triggered Dialog[] context
        // EvaluatePacket                       — BEGINDLGPKT Dialog[] context
        // EnterTextPacket                      — exitDialog (Return[] in interactive ctx)
        bool sent;
        if (!req.useEnterText) {
            if (menuDlgProto) {
                // MENUPKT-dialog (interrupt-triggered): text-mode I/O.
                // The kernel expects EnterTextPacket and returns OutputForm via TEXTPKT.
                sent = WSPutFunction(lp, "EnterTextPacket", 1) &&
                       WSPutUTF8String(lp, (const unsigned char *)req.expr.c_str(), (int)req.expr.size()) &&
                       WSEndPacket  (lp)                       &&
                       WSFlush      (lp);
            } else {
                // BEGINDLGPKT dialog: batch mode.
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
            // Send failure: resolve with a WError.
            WExpr err = WExpr::mkError("dialogEval: failed to send to kernel");
            req.resolve.NonBlockingCall(
                [err](Napi::Env e, Napi::Function cb){
                    Napi::Object o = Napi::Object::New(e);
                    o.Set("type",  Napi::String::New(e, "error"));
                    o.Set("error", Napi::String::New(e, err.strVal));
                    cb.Call({o});
                });
            req.resolve.Release();
            return true;  // link might still work; let outer loop decide
        }
        // Read response packets until RETURNPKT/RETURNEXPRPKT or ENDDLGPKT.
        WExpr result;
        std::string lastDlgText;  // accumulated OutputForm text for menuDlgProto dialogEval
        bool dialogEndedHere = false;
        bool menuDlgFirstSkipped = false;   // whether the pre-result setup MENUPKT was already skipped
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
                // ReturnTextPacket: the dialog/inspect-mode result as OutputForm text.
                // This is how 'i' (inspect) mode returns results in Wolfram 3.
                const char* s = nullptr; WSGetString(lp, &s);
                std::string txt = s ? rtrimNL(s) : ""; if (s) WSReleaseString(lp, s);
                WSNewPacket(lp);
                DiagLog("[SDR] RETURNTEXTPKT text='" + txt.substr(0, 60) + "'");
                if (txt.empty()) {
                    result = WExpr::mkSymbol("System`Null");
                } else {
                    // Try integer
                    try {
                        size_t pos = 0;
                        long long iv = std::stoll(txt, &pos);
                        if (pos == txt.size()) { result.kind = WExpr::Integer; result.intVal = iv; }
                        else { throw std::exception(); }
                    } catch (...) {
                        // Try real
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
                // EnterExpressionPacket path (menuDlgProto): collect structured result.
                // The kernel will follow with INPUTNAMEPKT or MENUPKT (next prompt);
                // we break after collecting and let the outer loop consume that.
                result = ReadExprRaw(lp);
                WSNewPacket(lp);
                if (!menuDlgProto) break;  // BEGINDLGPKT: also terminates
                // menuDlgProto: keep looping to consume OUTPUTNAMEPKT/INPUTNAMEPKT
                // and the trailing MENUPKT (which triggers the outer break below)
                continue;
            }
            if (p2 == ENDDLGPKT) {
                // The expression exited the dialog (e.g. Return[]).
                // Handle ENDDLGPKT here so the outer inner-loop doesn't see it.
                wsint64 endLevel = 0;
                if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &endLevel);
                WSNewPacket(lp);
                if (opts->dialogOpen) opts->dialogOpen->store(false);
                if (opts->hasOnDialogEnd)
                    opts->onDialogEnd.NonBlockingCall(
                        [endLevel](Napi::Env e, Napi::Function cb){
                            cb.Call({Napi::Number::New(e, static_cast<double>(endLevel))}); });
                // Resolve with Null — the caller asked for Return[], gets Null back.
                result.kind = WExpr::Symbol;
                result.strVal = "Null";
                dialogEndedHere = true;
                break;
            }
            if (p2 == MESSAGEPKT) { handleMessage(true); continue; }
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
                // MENUPKT in dialog context:
                //   * menuDlgProto && exitDialog: respond 'c' to resume main eval.
                //   * menuDlgProto && dialogEval: result arrived via TEXTPKT; parse it.
                //   * BEGINDLGPKT path: result via RETURNPKT (should already have it).
                if (req.useEnterText) {
                    // exitDialog: respond bare string 'c' (continue) per JLink MENUPKT protocol.
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
                    // dialogEval in text-mode dialog: result arrives as TEXTPKT before MENUPKT.
                    // However: the kernel may send a "setup" MENUPKT immediately after we
                    // send our expression (buffered from the dialog-open sequence), before
                    // sending the TEXTPKT result.  Skip that one MENUPKT and keep waiting.
                    WSNewPacket(lp);
                    if (lastDlgText.empty() && !menuDlgFirstSkipped) {
                        menuDlgFirstSkipped = true;
                        DiagLog("[SDR] menuDlg: skipping pre-result MENUPKT, waiting for TEXTPKT");
                        continue;  // keep waiting for TEXTPKT result
                    }
                    // Second MENUPKT (or first if we already have text): end of result.
                    DiagLog("[SDR] menuDlg: end-of-result MENUPKT, lastDlgText='" + lastDlgText + "'");
                    if (lastDlgText.empty()) {
                        result = WExpr::mkSymbol("System`Null");
                    } else {
                        // Try integer
                        try {
                            size_t pos = 0;
                            long long iv = std::stoll(lastDlgText, &pos);
                            if (pos == lastDlgText.size()) {
                                result.kind   = WExpr::Integer;
                                result.intVal = iv;
                            } else { throw std::exception(); }
                        } catch (...) {
                            // Try real
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
                    // BEGINDLGPKT path: result should have arrived via RETURNPKT.
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
        // Deliver result to the JS Promise via TSFN.
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
    // In EnterExpressionPacket mode the kernel sends:
    //   Non-Null result: OUTPUTNAMEPKT → RETURNEXPRPKT
    //                    followed by a trailing INPUTNAMEPKT (next prompt)
    //   Null result:     INPUTNAMEPKT only (no OUTPUTNAMEPKT/RETURNEXPRPKT)
    //
    // So: INPUTNAMEPKT as the FIRST packet (before any OUTPUTNAMEPKT) = Null.
    //     INPUTNAMEPKT after RETURNEXPRPKT = next-prompt trailer, consumed here
    //     so the next evaluate() starts clean.
    bool gotOutputName = false;
    bool gotResult     = false;
    while (true) {
        int pkt = WSNextPacket(lp);
        DiagLog("[Eval] pkt=" + std::to_string(pkt));

        if (pkt == RETURNPKT || pkt == RETURNEXPRPKT) {
            // RETURNPKT:     response to EvaluatePacket — no In/Out populated.
            // RETURNEXPRPKT: response to EnterExpressionPacket — main loop ran,
            //                In[n] and Out[n] are populated by the kernel.
            //
            // Safety for interactive RETURNEXPRPKT: peek at the token type before
            // calling ReadExprRaw.  Atomic results (symbol, int, real, string) are
            // safe to read — this covers $Aborted and simple values.
            // Complex results (List, Graphics, …) are skipped with WSNewPacket to
            // avoid a potential WSGetFunction crash on deep expression trees.
            // Out[n] is already set inside the kernel; JS renders via VsCodeRenderNth
            // which reads from $vsCodeLastResultList, not from the transferred result.
            if (opts && opts->interactive && pkt == RETURNEXPRPKT) {
                int tok = WSGetType(lp);
                if (tok == WSTKSYM || tok == WSTKINT || tok == WSTKREAL || tok == WSTKSTR) {
                    r.result = ReadExprRaw(lp);
                } else {
                    // Complex result — discard; Out[n] intact in kernel.
                    r.result = WExpr::mkSymbol("System`__VsCodeHasResult__");
                }
            } else {
                r.result = ReadExprRaw(lp);
            }
            WSNewPacket(lp);
            if (r.result.kind == WExpr::Symbol && stripCtx(r.result.strVal) == "$Aborted")
                r.aborted = true;
            gotResult = true;
            // Drain any stale packets (e.g. late BEGINDLGPKT from a concurrent
            // interrupt that arrived just as this cell's RETURNPKT was sent).
            // This prevents Pattern D: stale BEGINDLGPKT corrupting next eval.
            //
            // IMPORTANT: In interactive mode (EnterExpressionPacket), the kernel
            // follows RETURNEXPRPKT with a trailing INPUTNAMEPKT ("In[n+1]:=").
            // drainStalePackets must NOT run here because it would consume that
            // INPUTNAMEPKT and discard it, causing the outer loop to block forever
            // waiting for a packet that was already eaten.  Drain is deferred to
            // the INPUTNAMEPKT handler below.
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
                    // First packet = INPUTNAMEPKT with no preceding OUTPUTNAMEPKT:
                    // kernel evaluated to Null/suppressed — this IS the result signal.
                    // cellIndex is one less than this prompt's index.
                    int64_t nextIdx = parseCellIndex(nameStr);
                    r.cellIndex = (nextIdx > 1) ? nextIdx - 1 : nextIdx;
                    r.result = WExpr::mkSymbol("System`Null");
                    break;
                }
                // Trailing INPUTNAMEPKT after RETURNEXPRPKT — consume and exit.
                // Now safe to drain stale packets (Pattern D prevention) —
                // the trailing INPUTNAMEPKT has already been consumed above.
                if (!r.aborted) drainStalePackets(lp, opts);
                break;
            }
            r.cellIndex = parseCellIndex(nameStr);
        }
        else if (pkt == OUTPUTNAMEPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) {
                std::string name = s; WSReleaseString(lp, s);
                // Kernel sends "Out[n]= " with trailing space — normalize to "Out[n]=".
                while (!name.empty() && name.back() == ' ') name.pop_back();
                r.outputName = name;
                // Parse the n from "Out[n]=" to set cellIndex (interactive mode).
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
                    // Log C++ dispatch time so the JS handler timestamp gives latency.
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
            handleMessage(false);
        }
        else if (pkt == BEGINDLGPKT) {
            // ----------------------------------------------------------------
            // Dialog subsession opened by the kernel.
            // ----------------------------------------------------------------
            wsint64 level = 0;
            if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &level);
            WSNewPacket(lp);

            // ---- rejectDialog: auto-close without informing JS layer --------
            // Non-interactive evals (VsCodeRender, handler install, sub() exprs)
            // must never block waiting for JS dialogEval() that never comes.
            // Send Return[$Failed] immediately and continue waiting for RETURNPKT.
            if (opts && opts->rejectDialog) {
                DiagLog("[Eval] rejectDialog: auto-closing BEGINDLGPKT level=" + std::to_string(level));
                // Pre-drain INPUTNAMEPKT — Dialog[] from ScheduledTask sends
                // INPUTNAMEPKT before accepting EnterTextPacket.
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
                DiagLog("[Eval] rejectDialog: sent Return[$Failed], draining until ENDDLGPKT");
                // Drain until ENDDLGPKT — kernel will close the dialog level.
                // IMPORTANT: the outer eval's RETURNPKT may land inside the
                // dialog context (race with ScheduledTask Dialog[]).  We MUST
                // capture it here; otherwise the outer DrainToEvalResult loop
                // waits forever for a RETURNPKT that was already consumed.
                WExpr rejectCaptured;
                bool  rejectGotOuter = false;
                {
                    auto dlgDeadline = std::chrono::steady_clock::now() +
                                       std::chrono::milliseconds(2000);
                    while (std::chrono::steady_clock::now() < dlgDeadline) {
                        if (!WSReady(lp)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                            continue;
                        }
                        int rp = WSNextPacket(lp);
                        DiagLog("[Eval] rejectDialog: drain pkt=" + std::to_string(rp));
                        if ((rp == RETURNPKT || rp == RETURNEXPRPKT) && !rejectGotOuter) {
                            rejectCaptured  = ReadExprRaw(lp);
                            rejectGotOuter  = true;
                            DiagLog("[Eval] rejectDialog: captured outer RETURNPKT");
                        }
                        WSNewPacket(lp);
                        if (rp == ENDDLGPKT) break;
                        if (rp == 0 || rp == ILLEGALPKT) { WSClearError(lp); break; }
                    }
                }
                if (rejectGotOuter) {
                    DiagLog("[Eval] rejectDialog: returning captured outer result");
                    r.result = std::move(rejectCaptured);
                    if (r.result.kind == WExpr::Symbol &&
                        stripCtx(r.result.strVal) == "$Aborted")
                        r.aborted = true;
                    drainStalePackets(lp, opts);
                    return r;
                }
                // Continue outer drain loop — the original RETURNPKT is still coming.
                continue;
            }

            // ---- dynAutoMode / subAuto: C++-internal inline evaluation -------
            // Enter this block when:
            //   (a) dynAutoMode is true (Dynamic widgets active), OR
            //   (b) autoExprQueue has pending subAuto entries (⌥⇧↵ during busy)
            // All registered Dynamic expressions + pending subAuto entries are
            // evaluated inline inside the dialog — no JS roundtrip needed.
            // The dialog is then closed unconditionally with Return[$Failed].
            bool hasAutoEntries = false;
            if (opts && opts->autoMutex && opts->autoExprQueue) {
                std::lock_guard<std::mutex> lk(*opts->autoMutex);
                hasAutoEntries = !opts->autoExprQueue->empty();
            }
            if (!opts || opts->dynAutoMode || hasAutoEntries) {
                // Check if aborted before entering evaluation.
                if (opts && opts->abortFlag && opts->abortFlag->load()) {
                    if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                    r.result = WExpr::mkSymbol("System`$Aborted");
                    r.aborted = true;
                    drainDialogAbortResponse(lp);
                    return r;
                }

                // If the outer eval's EvaluatePacket was processed inside
                // this Dialog[] context (between-eval ScheduledTask fire),
                // its RETURNPKT will appear before our RETURNTEXTPKT.
                // capturedOuterResult captures that value so we can return
                // it as the cell result.
                WExpr capturedOuterResult;

                if (opts && opts->dynMutex && opts->dynRegistry && opts->dynResults) {
                    std::lock_guard<std::mutex> lk(*opts->dynMutex);

                    // Drain any initial packets (INPUTNAMEPKT, etc.) before
                    // sending expressions. Dialog[] from ScheduledTask may
                    // send INPUTNAMEPKT or TEXTPKT before accepting input.
                    {
                        auto drainDl = std::chrono::steady_clock::now() +
                                       std::chrono::milliseconds(500);
                        while (std::chrono::steady_clock::now() < drainDl) {
                            if (!WSReady(lp)) {
                                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                                continue;
                            }
                            int ipkt = WSNextPacket(lp);
                            DiagLog("[Eval] dynAutoMode(BEGINDLG): pre-drain pkt=" + std::to_string(ipkt));
                            if (ipkt == INPUTNAMEPKT) {
                                WSNewPacket(lp);
                                break; // ready for input
                            }
                            if (ipkt == 0 || ipkt == ILLEGALPKT) {
                                WSClearError(lp);
                                break;
                            }
                            WSNewPacket(lp); // consume TEXTPKT, MESSAGEPKT, etc.
                        }
                    }

                    // Current time in ms since epoch for timestamps.
                    auto nowMs = static_cast<double>(
                        std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                        .count());

                    for (const auto& reg : *opts->dynRegistry) {
                        // Send expression via EnterTextPacket so the kernel
                        // evaluates it in OutputForm text mode (string result).
                        DiagLog("[Eval] dynAutoMode(BEGINDLG): sending expr id=" + reg.id + " expr='" + reg.expr + "'");
                        bool sentDyn =
                            WSPutFunction(lp, "EnterTextPacket", 1) &&
                            WSPutUTF8String(lp,
                                reinterpret_cast<const unsigned char*>(reg.expr.c_str()),
                                static_cast<int>(reg.expr.size())) &&
                            WSEndPacket(lp) &&
                            WSFlush(lp);

                        DynResult dr;
                        dr.id        = reg.id;
                        dr.timestamp = nowMs;
                        if (!sentDyn) {
                            dr.error = "failed to send Dynamic expression";
                        } else {
                            readDynResultWithTimeout(lp, dr, 2000, &capturedOuterResult);
                        }
                        opts->dynResults->push_back(std::move(dr));

                        // If the outer result was captured, stop processing
                        // further dynamic expressions — the eval is done.
                        if (capturedOuterResult.kind != WExpr::WError ||
                            !capturedOuterResult.strVal.empty()) break;

                        // Abort check between expressions.
                        if (opts->abortFlag && opts->abortFlag->load()) break;
                    }

                    if (opts->dynLastEval)
                        *opts->dynLastEval = std::chrono::steady_clock::now();

                    // Check if the outer eval's RETURNPKT was captured inside
                    // this dialog.  If so, close the dialog and return the
                    // captured result directly — the outer eval is already done.
                    bool outerCaptured = capturedOuterResult.kind != WExpr::WError ||
                                         !capturedOuterResult.strVal.empty();
                    if (outerCaptured) {
                        DiagLog("[Eval] dynAutoMode: outer RETURNPKT captured inside dialog — returning directly");
                        // Close the dialog.
                        {
                            const char* closeExpr = "Return[$Failed]";
                            WSPutFunction(lp, "EnterTextPacket", 1);
                            WSPutUTF8String(lp,
                                reinterpret_cast<const unsigned char*>(closeExpr),
                                static_cast<int>(std::strlen(closeExpr)));
                            WSEndPacket(lp);
                            WSFlush(lp);
                        }
                        drainUntilEndDialog(lp, 3000);
                        r.result = std::move(capturedOuterResult);
                        if (r.result.kind == WExpr::Symbol &&
                            stripCtx(r.result.strVal) == "$Aborted")
                            r.aborted = true;
                        // Drain any remaining stale packets.
                        drainStalePackets(lp, opts);
                        return r;
                    }
                }

                // ---- Process one-shot subAuto() entries (dialog still open) ----
                if (opts && opts->autoMutex && opts->autoExprQueue && opts->autoCompleted) {
                    std::lock_guard<std::mutex> aLk(*opts->autoMutex);
                    while (!opts->autoExprQueue->empty()) {
                        auto entry = std::move(opts->autoExprQueue->front());
                        opts->autoExprQueue->pop_front();

                        DiagLog("[Eval] dynAutoMode(BEGINDLG): subAuto id=" +
                                std::to_string(entry.id) + " expr='" + entry.expr + "'");
                        bool sentAuto =
                            WSPutFunction(lp, "EnterTextPacket", 1) &&
                            WSPutUTF8String(lp,
                                reinterpret_cast<const unsigned char*>(entry.expr.c_str()),
                                static_cast<int>(entry.expr.size())) &&
                            WSEndPacket(lp) && WSFlush(lp);

                        if (!sentAuto) {
                            opts->autoCompleted->push_back({entry.id, "", "failed to send expression"});
                        } else {
                            DynResult dr;
                            readDynResultWithTimeout(lp, dr, 2000, &capturedOuterResult);
                            opts->autoCompleted->push_back({entry.id, dr.value, dr.error});
                        }
                        // If the outer eval's result arrived, stop processing.
                        bool autoOuterCaptured =
                            capturedOuterResult.kind != WExpr::WError ||
                            !capturedOuterResult.strVal.empty();
                        if (autoOuterCaptured) break;
                        if (opts->abortFlag && opts->abortFlag->load()) break;
                    }
                    // Signal main thread to resolve pending subAuto deferreds.
                    if (!opts->autoCompleted->empty() &&
                        opts->autoTsfnActive && opts->autoTsfnActive->load()) {
                        opts->autoResolverTsfn->NonBlockingCall(
                            [](Napi::Env, Napi::Function fn) { fn.Call({}); });
                    }
                }

                // Check if the outer eval was captured during autoQueue processing.
                {
                    bool outerCapturedInAuto =
                        capturedOuterResult.kind != WExpr::WError ||
                        !capturedOuterResult.strVal.empty();
                    if (outerCapturedInAuto) {
                        DiagLog("[Eval] dynAutoMode: outer RETURNPKT captured during subAuto — returning directly");
                        {
                            const char* closeExpr = "Return[$Failed]";
                            WSPutFunction(lp, "EnterTextPacket", 1);
                            WSPutUTF8String(lp,
                                reinterpret_cast<const unsigned char*>(closeExpr),
                                static_cast<int>(std::strlen(closeExpr)));
                            WSEndPacket(lp);
                            WSFlush(lp);
                        }
                        drainUntilEndDialog(lp, 3000);
                        r.result = std::move(capturedOuterResult);
                        if (r.result.kind == WExpr::Symbol &&
                            stripCtx(r.result.strVal) == "$Aborted")
                            r.aborted = true;
                        drainStalePackets(lp, opts);
                        return r;
                    }
                }

                // Close the dialog: send Return[$Failed] then drain ENDDLGPKT.
                {
                    const char* closeExpr = "Return[$Failed]";
                    WSPutFunction(lp, "EnterTextPacket", 1);
                    WSPutUTF8String(lp,
                        reinterpret_cast<const unsigned char*>(closeExpr),
                        static_cast<int>(std::strlen(closeExpr)));
                    WSEndPacket(lp);
                    WSFlush(lp);
                }
                bool exitOk = drainUntilEndDialog(lp, 3000, &capturedOuterResult);
                if (!exitOk) {
                    DiagLog("[Eval] dynAutoMode: drainUntilEndDialog timed out; aborting");
                    r.aborted = true;
                    r.result = WExpr::mkSymbol("System`$Aborted");
                    drainDialogAbortResponse(lp);
                    return r;
                }
                // Check if the outer eval's RETURNPKT was captured during the
                // drain (e.g. empty registry but between-eval Dialog[] race).
                {
                    bool outerCapturedInDrain =
                        capturedOuterResult.kind != WExpr::WError ||
                        !capturedOuterResult.strVal.empty();
                    if (outerCapturedInDrain) {
                        DiagLog("[Eval] dynAutoMode: outer RETURNPKT captured during drain — returning directly");
                        r.result = std::move(capturedOuterResult);
                        if (r.result.kind == WExpr::Symbol &&
                            stripCtx(r.result.strVal) == "$Aborted")
                            r.aborted = true;
                        drainStalePackets(lp, opts);
                        return r;
                    }
                }
                // Dialog closed — continue outer loop waiting for the original RETURNPKT.
                continue;
            }

            // ---- Safety fallback: no onDialogBegin callback registered -----
            // Legacy dialog loop (below) requires JS to call dialogEval()/
            // exitDialog() in response to the onDialogBegin callback.  If no
            // callback is registered (e.g. stale ScheduledTask Dialog[] call
            // arriving during a non-Dynamic cell), nobody will ever call those
            // functions and the eval hangs permanently.  Auto-close the dialog
            // using the same inline path as rejectDialog.
            if (!opts || !opts->hasOnDialogBegin) {
                DiagLog("[Eval] BEGINDLGPKT: no onDialogBegin callback — auto-closing "
                        "(dynAutoMode=false, hasOnDialogBegin=false)");
                // Pre-drain INPUTNAMEPKT — Dialog[] from ScheduledTask sends
                // INPUTNAMEPKT before accepting EnterTextPacket.
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
                // Continue outer drain loop — original RETURNPKT is still coming.
                continue;
            }

            if (opts && opts->dialogOpen)
                opts->dialogOpen->store(true);
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
                // Abort check — abort() sets abortFlag_ and sends WSAbortMessage.
                // The kernel may be slow to respond (or send RETURNPKT[$Aborted]
                // without a preceding ENDDLGPKT); bail out proactively to avoid
                // spinning forever.
                // CRITICAL: always drain the link before returning.  If we exit
                // here before the kernel sends its RETURNPKT[$Aborted], that
                // response stays on the link and corrupts the next evaluation.
                if (opts && opts->abortFlag && opts->abortFlag->load()) {
                    if (opts->dialogOpen) opts->dialogOpen->store(false);
                    r.result = WExpr::mkSymbol("System`$Aborted");
                    r.aborted = true;
                    drainDialogAbortResponse(lp); // consume pending abort response
                    return r;
                }

                // Service any pending dialogEval() requests first.
                if (opts && opts->dialogPending && opts->dialogPending->load()) {
                    if (!serviceDialogRequest()) {
                        dialogDone = true;  // ENDDLGPKT arrived inside the request
                        continue;
                    }
                }

                // Non-blocking check: is the kernel ready to send a packet?
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
                    if (opts && opts->hasOnDialogEnd)
                        opts->onDialogEnd.NonBlockingCall(
                            [endLevel](Napi::Env e, Napi::Function cb){
                                cb.Call({Napi::Number::New(e, static_cast<double>(endLevel))}); });
                    dialogDone = true;
                }
                else if (dpkt == RETURNPKT) {
                    // Could be the abort response (RETURNPKT[$Aborted] without a
                    // preceding ENDDLGPKT) or an unsolicited in-dialog result.
                    WExpr innerExpr = ReadExprRaw(lp);
                    WSNewPacket(lp);
                    if (innerExpr.kind == WExpr::Symbol &&
                        stripCtx(innerExpr.strVal) == "$Aborted") {
                        // Kernel ended the dialog due to abort — propagate upward.
                        if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                        r.result = innerExpr;  // already the $Aborted symbol
                        r.aborted = true;
                        return r;
                    }
                    // Otherwise discard — outer loop will see final RETURNPKT.
                }
                else if (dpkt == INPUTNAMEPKT || dpkt == OUTPUTNAMEPKT) {
                    WSNewPacket(lp);  // dialog prompts — discard
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
                    handleMessage(true);
                }
                else if (dpkt == 0 || dpkt == ILLEGALPKT) {
                    const char* m = WSErrorMessage(lp);
                    WSClearError(lp);
                    if (opts && opts->dialogOpen) opts->dialogOpen->store(false);
                    // If abort() was in flight, the ILLEGALPKT is the expected
                    // link-reset response — treat as clean abort, not an error.
                    if (opts && opts->abortFlag && opts->abortFlag->load()) {
                        r.result = WExpr::mkSymbol("System`$Aborted");
                        r.aborted = true;
                    } else {
                        r.result = WExpr::mkError(m ? m : "WSTP error in dialog");
                    }
                    return r;  // unrecoverable — bail out entirely
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
            r.result = WExpr::mkError(s);
            break;
        }
        else if (pkt == RETURNTEXTPKT) {
            // ReturnTextPacket carries the string-form of the result.
            // This should not normally appear with EvaluatePacket, but handle
            // it defensively so the loop always terminates.
            DiagLog("[Eval] unexpected RETURNTEXTPKT — treating as empty return");
            WSNewPacket(lp);
            // Leave r.result as default WError so the caller gets an informative error.
            r.result = WExpr::mkError("unexpected ReturnTextPacket from kernel");
            break;
        }
        else if (pkt == MENUPKT) {
            // ----------------------------------------------------------------
            // MENUPKT (6) — interrupt menu
            // ----------------------------------------------------------------
            wsint64 menuType_ = 0; WSGetInteger64(lp, &menuType_);
            const char* menuPrompt_ = nullptr; WSGetString(lp, &menuPrompt_);
            if (menuPrompt_) WSReleaseString(lp, menuPrompt_);
            WSNewPacket(lp);

            // Legacy dialog path: when dynAutoMode is false and the eval has
            // dialog callbacks, respond 'i' (inspect) so the kernel enters
            // inspect mode and the Internal`AddHandler fires Dialog[].
            // For type-1 (interrupt menu) without dialog callbacks, respond
            // 'a' (abort) rather than 'c' (continue).  On ARM64/Wolfram 3,
            // 'c' can leave the kernel in a stuck state when the interrupt
            // handler (Internal`AddHandler["Interrupt", Function[.., Dialog[]]])
            // is installed — Dialog[] interferes with the continuation and
            // the kernel never sends RETURNPKT.  Aborting cleanly produces
            // $Aborted and keeps the session alive.
            // For non-interrupt menus (type != 1), 'c' is still safe.
            // Respond 'i' (inspect → Dialog[]) when:
            //   - Legacy dialog path: dynAutoMode=false + hasOnDialogBegin
            //   - subAuto busy path: autoExprQueue has pending entries
            //     (dynAutoMode handler will process them and auto-close)
            bool wantInspect = opts && !opts->dynAutoMode && opts->hasOnDialogBegin;
            if (!wantInspect && opts && opts->autoMutex && opts->autoExprQueue) {
                std::lock_guard<std::mutex> lk(*opts->autoMutex);
                if (!opts->autoExprQueue->empty()) wantInspect = true;
            }
            const char* resp;
            if (wantInspect) {
                resp = "i";
            } else if (menuType_ == 1) {
                resp = "a";
            } else {
                resp = "c";
            }
            DiagLog("[Eval] MENUPKT type=" + std::to_string(menuType_) + " — responding '" + resp + "'");
            WSPutString(lp, resp);
            WSEndPacket(lp);
            WSFlush(lp);
        }
        else {
            DiagLog("[Eval] unknown pkt=" + std::to_string(pkt) + ", discarding");
            WSNewPacket(lp);  // discard unknown packets
        }
    }

    return r;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// WExprToNapi — convert WExpr → Napi::Value.  Main thread only.
// ---------------------------------------------------------------------------
static Napi::Value WExprToNapi(Napi::Env env, const WExpr& e) {
    switch (e.kind) {
        case WExpr::Integer: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "integer"));
            o.Set("value", Napi::Number::New(env, static_cast<double>(e.intVal)));
            return o;
        }
        case WExpr::Real: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "real"));
            o.Set("value", Napi::Number::New(env, e.realVal));
            return o;
        }
        case WExpr::String: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "string"));
            o.Set("value", Napi::String::New(env, e.strVal));
            return o;
        }
        case WExpr::Symbol: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "symbol"));
            o.Set("value", Napi::String::New(env, e.strVal));
            return o;
        }
        case WExpr::Function: {
            Napi::Array argsArr = Napi::Array::New(env, e.args.size());
            for (size_t i = 0; i < e.args.size(); ++i)
                argsArr.Set(static_cast<uint32_t>(i), WExprToNapi(env, e.args[i]));
            Napi::Object o = Napi::Object::New(env);
            o.Set("type", Napi::String::New(env, "function"));
            o.Set("head", Napi::String::New(env, e.head));
            o.Set("args", argsArr);
            return o;
        }
        case WExpr::WError:
        default:
            Napi::Error::New(env, e.strVal).ThrowAsJavaScriptException();
            return env.Undefined();
    }
}

// ---------------------------------------------------------------------------
// EvalResultToNapi — convert EvalResult → Napi::Object.  Main thread only.
// ---------------------------------------------------------------------------
static Napi::Value EvalResultToNapi(Napi::Env env, const EvalResult& r) {
    auto obj = Napi::Object::New(env);

    obj.Set("cellIndex",  Napi::Number::New(env, static_cast<double>(r.cellIndex)));
    obj.Set("outputName", Napi::String::New(env, r.outputName));
    obj.Set("result",     WExprToNapi(env, r.result));
    obj.Set("aborted",    Napi::Boolean::New(env, r.aborted));

    auto print = Napi::Array::New(env, r.print.size());
    for (size_t i = 0; i < r.print.size(); ++i)
        print.Set(static_cast<uint32_t>(i), Napi::String::New(env, r.print[i]));
    obj.Set("print", print);

    auto msgs = Napi::Array::New(env, r.messages.size());
    for (size_t i = 0; i < r.messages.size(); ++i)
        msgs.Set(static_cast<uint32_t>(i), Napi::String::New(env, r.messages[i]));
    obj.Set("messages", msgs);

    return obj;
}

// ===========================================================================
// EvaluateWorker — ALL blocking WSTP I/O runs on the libuv thread pool.
// ===========================================================================
class EvaluateWorker : public Napi::AsyncWorker {
public:
    EvaluateWorker(Napi::Promise::Deferred       deferred,
                   WSLINK                        lp,
                   std::string                   expr,
                   EvalOptions                   opts,
                   std::atomic<bool>&            abortFlag,
                   std::atomic<bool>&            workerReadingLink,
                   std::function<void()>         completionCb,
                   int64_t                       cellIndex,
                   bool                          interactive = false)
        : Napi::AsyncWorker(deferred.Env()),
          deferred_(std::move(deferred)),
          lp_(lp),
          expr_(std::move(expr)),
          interactive_(interactive),
          opts_(std::move(opts)),
          abortFlag_(abortFlag),
          workerReadingLink_(workerReadingLink),
          completionCb_(std::move(completionCb)),
          cellIndex_(cellIndex)
    {}

    // ---- thread-pool thread: send packet; block until response ----
    void Execute() override {
        // ---- Pre-eval drain: consume stale packets on the link --------
        // If an interrupt was sent just as the previous eval completed,
        // the kernel may have opened a Dialog[] (via the interrupt handler)
        // while idle.  The resulting BEGINDLGPKT sits unread on the link.
        // Without draining it first, our EvaluatePacket is processed inside
        // the stale Dialog context and its RETURNPKT is consumed during the
        // BEGINDLGPKT handler's drain — leaving the outer DrainToEvalResult
        // loop waiting forever for a RETURNPKT that was already eaten.
        // Only check if data is already buffered (WSReady) to avoid adding
        // latency in the normal case (no stale packets).
        if (WSReady(lp_)) {
            DiagLog("[Eval] pre-eval: stale data on link — draining");
            drainStalePackets(lp_, nullptr);
        }

        // ---- Phase 2: ScheduledTask[Dialog[], interval] management ----
        // Install a kernel-side ScheduledTask that calls Dialog[] periodically.
        // Only install when:
        //   (a) dynAutoMode is active
        //   (b) there are registered Dynamic expressions OR pending subAuto entries
        //   (c) interval > 0
        //   (d) the currently installed task has a DIFFERENT interval (or none)
        //
        // The task expression includes a stop-flag check so the old task can
        // be suppressed during the install eval (which uses rejectDialog=true).
        //
        // When there are no registrations (or interval=0), we do NOT send any
        // stop/remove eval. The old task keeps running but the dynAutoMode
        // handler handles empty-registry Dialog[]s by simply closing them.
        if (opts_.dynAutoMode && opts_.dynIntervalMs > 0) {
            bool hasRegs = false;
            if (opts_.dynMutex && opts_.dynRegistry) {
                std::lock_guard<std::mutex> lk(*opts_.dynMutex);
                hasRegs = !opts_.dynRegistry->empty();
            }
            // Also install if subAuto entries are pending (⌥⇧↵ without Dynamic widget).
            if (!hasRegs && opts_.autoMutex && opts_.autoExprQueue) {
                std::lock_guard<std::mutex> lk(*opts_.autoMutex);
                hasRegs = !opts_.autoExprQueue->empty();
            }

            int installedInterval = opts_.dynTaskInstalledInterval
                                  ? *opts_.dynTaskInstalledInterval : 0;
            bool needInstall = hasRegs && (installedInterval != opts_.dynIntervalMs);

            if (needInstall) {
                double intervalSec = opts_.dynIntervalMs / 1000.0;
                std::string taskExpr =
                    "Quiet[$wstpDynTaskStop = True;"
                    " If[ValueQ[$wstpDynTask], RemoveScheduledTask[$wstpDynTask]];"
                    " $wstpDynTaskStop =.;"
                    " $wstpDynTask = RunScheduledTask["
                    "If[!TrueQ[$wstpDynTaskStop], Dialog[]], " +
                    std::to_string(intervalSec) + "]]";
                DiagLog("[Eval] dynAutoMode: installing ScheduledTask interval=" +
                        std::to_string(intervalSec) + "s");
                EvalOptions taskOpts;
                taskOpts.rejectDialog = true;
                bool sentT =
                    WSPutFunction(lp_, "EvaluatePacket", 1) &&
                    WSPutFunction(lp_, "ToExpression",   1) &&
                    WSPutUTF8String(lp_,
                        reinterpret_cast<const unsigned char*>(taskExpr.c_str()),
                        static_cast<int>(taskExpr.size())) &&
                    WSEndPacket(lp_) &&
                    WSFlush(lp_);
                if (sentT) {
                    DrainToEvalResult(lp_, &taskOpts);
                    // Track the installed interval so we don't reinstall next time.
                    if (opts_.dynTaskInstalledInterval)
                        *opts_.dynTaskInstalledInterval = opts_.dynIntervalMs;
                }
            }
        }

        // ---- ScheduledTask Dialog[] suppression ----
        // When a ScheduledTask is installed (dynTaskInstalledInterval > 0),
        // its Dialog[] calls can fire between evals and during rejectDialog
        // setup/render evals, causing hangs and adding ~500ms per rejection.
        // Suppress the task during rejectDialog evals by prepending
        // $wstpDynTaskStop=True to the expression.  Resume it for the main
        // eval by prepending $wstpDynTaskStop=. so the dynAutoMode handler
        // can process Dynamic expressions during the cell's execution.
        int installedTask = opts_.dynTaskInstalledInterval
                          ? *opts_.dynTaskInstalledInterval : 0;
        std::string sendExpr = expr_;
        if (installedTask > 0) {
            if (opts_.rejectDialog) {
                sendExpr = "$wstpDynTaskStop=True;" + expr_;
                DiagLog("[Eval] prepend $wstpDynTaskStop=True (rejectDialog)");
            } else {
                sendExpr = "$wstpDynTaskStop=.;" + expr_;
                DiagLog("[Eval] prepend $wstpDynTaskStop=. (main eval)");
            }
        }

        bool sent;
        if (!interactive_) {
            // EvaluatePacket + ToExpression: non-interactive, does NOT populate In[n]/Out[n].
            sent = WSPutFunction(lp_, "EvaluatePacket", 1) &&
                   WSPutFunction(lp_, "ToExpression",   1) &&
                   WSPutUTF8String(lp_, (const unsigned char *)sendExpr.c_str(), (int)sendExpr.size()) &&
                   WSEndPacket  (lp_)                      &&
                   WSFlush      (lp_);
        } else {
            // EnterExpressionPacket[ToExpression[str]]: goes through the kernel's
            // full main loop — populates In[n] and Out[n] automatically, exactly
            // as the real Mathematica frontend does.  Responds with RETURNEXPRPKT.
            sent = WSPutFunction(lp_, "EnterExpressionPacket", 1) &&
                   WSPutFunction(lp_, "ToExpression",          1) &&
                   WSPutUTF8String(lp_, (const unsigned char *)sendExpr.c_str(), (int)sendExpr.size()) &&
                   WSEndPacket  (lp_)                             &&
                   WSFlush      (lp_);
        }
        if (!sent) {
            workerReadingLink_.store(false, std::memory_order_release);
            SetError("Failed to send packet to kernel");
        } else {
            opts_.interactive = interactive_;
            result_ = DrainToEvalResult(lp_, &opts_);
            // DrainToEvalResult may leave dialogOpen_=true (dynAutoMode suppresses
            // the timer during the exit protocol).  Clear it now that we're done.
            if (opts_.dialogOpen) opts_.dialogOpen->store(false);

            // ---- Cleanup: ScheduledTask that fires Dialog[] ----
            // The task is left running after the main eval completes.
            // Between evaluations, Dialog[]s from the task accumulate on the
            // link as stale BEGINDLGPKT packets. These are drained at the
            // start of the next eval by drainStalePackets(). The install
            // code at the top of Execute() also removes any old task before
            // installing a new one. On session close(), the kernel is
            // killed, which stops the task automatically.
            //
            // We CANNOT send a cleanup EvaluatePacket here because the
            // ScheduledTask fires Dialog[] preemptively during the cleanup
            // eval, and the RETURNPKT from the cleanup can get interleaved
            // with dialog packets, causing the drain to hang.

            workerReadingLink_.store(false, std::memory_order_release); // lp_ no longer in use
            if (!interactive_) {
                // EvaluatePacket mode: kernel never sends INPUTNAMEPKT/OUTPUTNAMEPKT,
                // so stamp the pre-captured counter and derive outputName manually.
                result_.cellIndex = cellIndex_;
                if (!result_.aborted && result_.result.kind == WExpr::Symbol) {
                    const std::string& sv = result_.result.strVal;
                    std::string bare = sv;
                    auto tick = sv.rfind('`');
                    if (tick != std::string::npos) bare = sv.substr(tick + 1);
                    if (bare != "Null")
                        result_.outputName = "Out[" + std::to_string(cellIndex_) + "]=";
                } else if (!result_.aborted && result_.result.kind != WExpr::WError) {
                    result_.outputName = "Out[" + std::to_string(cellIndex_) + "]=";
                }
            } else {
                // EnterExpressionPacket mode: DrainToEvalResult already populated
                // cellIndex/outputName from INPUTNAMEPKT/OUTPUTNAMEPKT.
                // Use our counter as fallback if the kernel didn't send them.
                if (result_.cellIndex == 0)
                    result_.cellIndex = cellIndex_;
            }
        }
        if (opts_.hasOnPrint)        opts_.onPrint.Release();
        if (opts_.hasOnMessage)      opts_.onMessage.Release();
        if (opts_.hasOnDialogBegin)  opts_.onDialogBegin.Release();
        if (opts_.hasOnDialogPrint)  opts_.onDialogPrint.Release();
        if (opts_.hasOnDialogEnd)    opts_.onDialogEnd.Release();
    }

    // ---- main thread: resolve promise after all TSFN callbacks delivered ----
    void OnOK() override {
        Napi::Env              env = Env();
        abortFlag_.store(false);

        EvalResult             r   = std::move(result_);
        Napi::Promise::Deferred d   = std::move(deferred_);
        std::function<void()>  cb  = completionCb_;

        auto resolveFn = [env, r = std::move(r), d = std::move(d), cb]() mutable {
            if (r.result.kind == WExpr::WError) {
                d.Reject(Napi::Error::New(env, r.result.strVal).Value());
            } else {
                Napi::Value v = EvalResultToNapi(env, r);
                if (env.IsExceptionPending())
                    d.Reject(env.GetAndClearPendingException().Value());
                else
                    d.Resolve(v);
            }
            cb();
        };

        if (opts_.ctx) {
            opts_.ctx->fn = std::move(resolveFn);
            opts_.ctx->done();
        } else {
            resolveFn();
        }
    }

    void OnError(const Napi::Error& e) override {
        Napi::Env              env = Env();
        std::string            msg = e.Message();
        Napi::Promise::Deferred d   = std::move(deferred_);
        std::function<void()>  cb  = completionCb_;

        auto rejectFn = [env, msg, d = std::move(d), cb]() mutable {
            d.Reject(Napi::Error::New(env, msg).Value());
            cb();
        };

        if (opts_.ctx) {
            opts_.ctx->fn = std::move(rejectFn);
            opts_.ctx->done();
        } else {
            rejectFn();
        }
    }

private:
    Napi::Promise::Deferred  deferred_;
    WSLINK                   lp_;
    std::string              expr_;
    EvalOptions              opts_;
    std::atomic<bool>&       abortFlag_;
    std::atomic<bool>&       workerReadingLink_;
    std::function<void()>    completionCb_;
    int64_t                  cellIndex_;
    bool                     interactive_;
    EvalResult               result_;
};

// ===========================================================================
// WstpSession  —  JS class:  new WstpSession(kernelPath?)
// ===========================================================================
static const char* kDefaultKernel =
    "/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel";

class WstpSession : public Napi::ObjectWrap<WstpSession> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "WstpSession", {
            InstanceMethod<&WstpSession::Evaluate>        ("evaluate"),
            InstanceMethod<&WstpSession::Sub>             ("sub"),
            InstanceMethod<&WstpSession::SubWhenIdle>     ("subWhenIdle"),
            InstanceMethod<&WstpSession::SubAuto>         ("subAuto"),
            InstanceMethod<&WstpSession::DialogEval>      ("dialogEval"),
            InstanceMethod<&WstpSession::ExitDialog>      ("exitDialog"),
            InstanceMethod<&WstpSession::Interrupt>       ("interrupt"),
            InstanceMethod<&WstpSession::Abort>           ("abort"),
            InstanceMethod<&WstpSession::CloseAllDialogs>  ("closeAllDialogs"),
            InstanceMethod<&WstpSession::CreateSubsession>("createSubsession"),
            InstanceMethod<&WstpSession::Close>           ("close"),
            // Dynamic evaluation API (Phase 2)
            InstanceMethod<&WstpSession::RegisterDynamic>     ("registerDynamic"),
            InstanceMethod<&WstpSession::UnregisterDynamic>   ("unregisterDynamic"),
            InstanceMethod<&WstpSession::ClearDynamicRegistry>("clearDynamicRegistry"),
            InstanceMethod<&WstpSession::GetDynamicResults>   ("getDynamicResults"),
            InstanceMethod<&WstpSession::SetDynamicInterval>  ("setDynamicInterval"),
            InstanceMethod<&WstpSession::SetDynAutoMode>      ("setDynAutoMode"),
            InstanceAccessor<&WstpSession::IsOpen>        ("isOpen"),
            InstanceAccessor<&WstpSession::IsDialogOpen>  ("isDialogOpen"),
            InstanceAccessor<&WstpSession::IsReady>       ("isReady"),
            InstanceAccessor<&WstpSession::KernelPid>     ("kernelPid"),
            InstanceAccessor<&WstpSession::DynamicActive> ("dynamicActive"),
        });

        Napi::FunctionReference* ctor = new Napi::FunctionReference();
        *ctor = Napi::Persistent(func);
        env.SetInstanceData(ctor);

        exports.Set("WstpSession", func);
        return exports;
    }

    // -----------------------------------------------------------------------
    // Constructor  new WstpSession(kernelPath?)
    // -----------------------------------------------------------------------
    WstpSession(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<WstpSession>(info), wsEnv_(nullptr), lp_(nullptr), open_(false)
    {
        Napi::Env env = info.Env();

        std::string kernelPath = kDefaultKernel;
        if (info.Length() > 0 && info[0].IsString())
            kernelPath = info[0].As<Napi::String>().Utf8Value();

        // Parse options object: new WstpSession(opts?) or new WstpSession(path, opts?)
        // Supported options: { interactive: true } — use EnterTextPacket instead of
        // EvaluatePacket so the kernel populates In[n]/Out[n] variables.
        int optsIdx = (info.Length() > 0 && info[0].IsObject()) ? 0
                    : (info.Length() > 1 && info[1].IsObject()) ? 1 : -1;
        if (optsIdx >= 0) {
            auto o = info[optsIdx].As<Napi::Object>();
            if (o.Has("interactive") && o.Get("interactive").IsBoolean())
                interactiveMode_ = o.Get("interactive").As<Napi::Boolean>().Value();
        }

        WSEnvironmentParameter params = WSNewParameters(WSREVISION, WSAPIREVISION);
        wsEnv_ = WSInitialize(params);
        WSReleaseParameters(params);
        if (!wsEnv_) {
            Napi::Error::New(env, "WSInitialize failed").ThrowAsJavaScriptException();
            return;
        }

        // Shell-quote the kernel path so spaces ("Wolfram 3.app") survive
        // being passed through /bin/sh by WSOpenArgcArgv.
        std::string linkName = "\"" + kernelPath + "\" -wstp";
        const char* argv[] = { "wstp", "-linkname", linkName.c_str(),
                                        "-linkmode",  "launch" };

        // Retry the entire kernel-launch sequence up to 3 times.  On ~20% of
        // consecutive launches the kernel starts with $Output routing broken
        // (Print[]/Message[] produce no TextPacket).  Killing the stale kernel
        // and spawning a fresh one resolves it reliably within 1-2 attempts.
        int err = 0;
        for (int attempt = 0; attempt <= 2; ++attempt) {
            if (attempt > 0) {
                DiagLog("[Session] restart attempt " + std::to_string(attempt) +
                        " — $Output routing broken on previous kernel");
                WSClose(lp_);           lp_       = nullptr;
                // Kill the stale kernel before relaunching; use the same guard
                // as CleanUp() to avoid double-kill on already-dead process.
                if (kernelPid_ > 0 && !kernelKilled_) { kernelKilled_ = true; kill(kernelPid_, SIGTERM); }
                kernelKilled_ = false;  // reset for the fresh kernel about to launch
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
            }

            err = 0;
            lp_ = WSOpenArgcArgv(wsEnv_, 5, const_cast<char**>(argv), &err);
            if (!lp_ || err != WSEOK) {
                std::string msg = "WSOpenArgcArgv failed (code " + std::to_string(err) + ")";
                WSDeinitialize(wsEnv_); wsEnv_ = nullptr;
                Napi::Error::New(env, msg).ThrowAsJavaScriptException();
                return;
            }

            if (!WSActivate(lp_)) {
                const char* m = WSErrorMessage(lp_);
                std::string s = std::string("WSActivate failed: ") + (m ? m : "?");
                WSClose(lp_); lp_ = nullptr;
                WSDeinitialize(wsEnv_); wsEnv_ = nullptr;
                Napi::Error::New(env, s).ThrowAsJavaScriptException();
                return;
            }

            // Get the kernel PID so CleanUp() can SIGTERM it.
            kernelPid_ = FetchKernelPid(lp_);

            // Confirm $Output→TextPacket routing is live.  If not, loop back
            // and restart with a fresh kernel process.
            if (WarmUpOutputRouting(lp_)) break;  // success — proceed

            // Last attempt — give up and continue with broken $Output rather
            // than looping indefinitely.
            if (attempt == 2)
                DiagLog("[Session] WARNING: $Output broken after 3 kernel launches");
        }

        open_ = true;
        abortFlag_.store(false);
    }

    ~WstpSession() { CleanUp(); }

    // -----------------------------------------------------------------------
    // evaluate(expr, opts?) → Promise<EvalResult>
    //
    // opts may contain { onPrint, onMessage } streaming callbacks.
    // Multiple calls are serialised through an internal queue — no link
    // corruption even if the caller doesn't await between calls.
    // -----------------------------------------------------------------------
    Napi::Value Evaluate(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
            return promise;
        }
        if (info.Length() < 1 || !info[0].IsString()) {
            deferred.Reject(Napi::TypeError::New(env, "evaluate(expr: string, opts?: object)").Value());
            return promise;
        }

        std::string expr = info[0].As<Napi::String>().Utf8Value();

        // Parse optional second argument: { onPrint?, onMessage?, onDialogBegin?,
        //                                    onDialogPrint?, onDialogEnd?,
        //                                    interactive?: boolean (override session default) }
        EvalOptions opts;
        int interactiveOverride = -1;  // -1 = use session default
        if (info.Length() >= 2 && info[1].IsObject()) {
            auto optsObj = info[1].As<Napi::Object>();
            bool wantPrint  = optsObj.Has("onPrint")        && optsObj.Get("onPrint").IsFunction();
            bool wantMsg    = optsObj.Has("onMessage")      && optsObj.Get("onMessage").IsFunction();
            bool wantDBegin = optsObj.Has("onDialogBegin")  && optsObj.Get("onDialogBegin").IsFunction();
            bool wantDPrint = optsObj.Has("onDialogPrint")  && optsObj.Get("onDialogPrint").IsFunction();
            bool wantDEnd   = optsObj.Has("onDialogEnd")    && optsObj.Get("onDialogEnd").IsFunction();
            // Per-call interactive override: opts.interactive = true/false
            if (optsObj.Has("interactive") && optsObj.Get("interactive").IsBoolean())
                interactiveOverride = optsObj.Get("interactive").As<Napi::Boolean>().Value() ? 1 : 0;
            // Per-call rejectDialog: auto-close any BEGINDLGPKT without JS roundtrip.
            if (optsObj.Has("rejectDialog") && optsObj.Get("rejectDialog").IsBoolean() &&
                optsObj.Get("rejectDialog").As<Napi::Boolean>().Value())
                opts.rejectDialog = true;

            // CompleteCtx: count = numTsfns + 1 (the extra slot is for OnOK/OnError).
            // This ensures the Promise resolves ONLY after every TSFN has been
            // finalized (= all queued callbacks delivered), regardless of whether
            // the TSFN finalizers or OnOK/OnError happen to run first.
            int tsfnCount = (wantPrint  ? 1 : 0) + (wantMsg    ? 1 : 0)
                          + (wantDBegin ? 1 : 0) + (wantDPrint ? 1 : 0)
                          + (wantDEnd   ? 1 : 0);
            CompleteCtx* ctx = (tsfnCount > 0) ? new CompleteCtx{ tsfnCount + 1, {} } : nullptr;

            auto makeTsfn = [&](const char* name, const char* key) {
                return Napi::ThreadSafeFunction::New(
                    env, optsObj.Get(key).As<Napi::Function>(), name, 0, 1,
                    ctx, [](Napi::Env, CompleteCtx* c) { c->done(); });
            };
            if (wantPrint)  { opts.onPrint       = makeTsfn("onPrint",       "onPrint");       opts.hasOnPrint       = true; }
            if (wantMsg)    { opts.onMessage     = makeTsfn("onMessage",     "onMessage");     opts.hasOnMessage     = true; }
            if (wantDBegin) { opts.onDialogBegin = makeTsfn("onDialogBegin", "onDialogBegin"); opts.hasOnDialogBegin = true; }
            if (wantDPrint) { opts.onDialogPrint = makeTsfn("onDialogPrint", "onDialogPrint"); opts.hasOnDialogPrint = true; }
            if (wantDEnd)   { opts.onDialogEnd   = makeTsfn("onDialogEnd",   "onDialogEnd");   opts.hasOnDialogEnd   = true; }
            opts.ctx = ctx;
        }
        // Wire up the dialog queue pointers so DrainToEvalResult can service
        // dialogEval() calls from the thread pool during a Dialog[] subsession.
        opts.dialogMutex   = &dialogMutex_;
        opts.dialogQueue   = &dialogQueue_;
        opts.dialogPending = &dialogPending_;
        opts.dialogOpen    = &dialogOpen_;
        opts.abortFlag     = &abortFlag_;
        // Wire up Dynamic eval pointers so DrainToEvalResult can evaluate
        // registered Dynamic expressions inline when BEGINDLGPKT arrives.
        opts.dynMutex      = &dynMutex_;
        opts.dynRegistry   = &dynRegistry_;
        opts.dynResults    = &dynResults_;
        opts.dynLastEval   = &dynLastEval_;
        opts.dynAutoMode   = dynAutoMode_.load();
        opts.dynIntervalMs = dynIntervalMs_.load();
        opts.dynTaskInstalledInterval = &dynTaskInstalledInterval_;
        // Wire up subAuto() pointers so DrainToEvalResult can evaluate
        // pending one-shot subAuto() entries inside BEGINDLGPKT.
        opts.autoMutex        = &autoMutex_;
        opts.autoExprQueue    = &autoExprQueue_;
        opts.autoCompleted    = &autoCompleted_;
        opts.autoResolverTsfn = &autoResolverTsfn_;
        opts.autoTsfnActive   = &autoTsfnActive_;

        {
            std::lock_guard<std::mutex> lk(queueMutex_);
            queue_.push(QueuedEval{ std::move(expr), std::move(opts), std::move(deferred), interactiveOverride });
        }
        MaybeStartNext();
        return promise;
    }

    // -----------------------------------------------------------------------
    // MaybeStartNext — pop the front of the queue and launch it, but only if
    // no evaluation is currently running (busy_ CAS ensures atomicity).
    // Called from: Evaluate() on main thread; completionCb_ on main thread.
    // Queue entry — one pending sub() call when the session is idle.
    struct QueuedSubIdle {
        std::string             expr;
        Napi::Promise::Deferred deferred;
    };

    // Queue entry — one pending subWhenIdle() call (lowest priority).
    // Executed only when both subIdleQueue_ and queue_ are empty.
    struct QueuedWhenIdle {
        std::string              expr;
        Napi::Promise::Deferred  deferred;
        // Absolute deadline; time_point::max() = no timeout.
        std::chrono::steady_clock::time_point deadline =
            std::chrono::steady_clock::time_point::max();
    };

    // Sub-idle evals are preferred over normal evals so sub()-when-idle gets
    // a quick result without waiting for a queued evaluate().
    // -----------------------------------------------------------------------
    void MaybeStartNext() {
        bool expected = false;
        if (!busy_.compare_exchange_strong(expected, true))
            return;  // already running

        std::unique_lock<std::mutex> lk(queueMutex_);

        // Check sub-idle queue first.
        if (!subIdleQueue_.empty()) {
            auto item = std::move(subIdleQueue_.front());
            subIdleQueue_.pop();
            lk.unlock();
            StartSubIdleWorker(std::move(item));
            return;
        }

        if (queue_.empty()) {
            // No normal evaluate() items — check lowest-priority when-idle queue.
            // Drain any timeout-expired entries first, then run the next live one.
            while (!whenIdleQueue_.empty()) {
                auto& front = whenIdleQueue_.front();
                bool expired =
                    (front.deadline != std::chrono::steady_clock::time_point::max() &&
                     std::chrono::steady_clock::now() >= front.deadline);
                if (expired) {
                    Napi::Env wenv = front.deferred.Env();
                    front.deferred.Reject(
                        Napi::Error::New(wenv, "subWhenIdle: timeout").Value());
                    whenIdleQueue_.pop();
                    continue;
                }
                auto wiItem = std::move(whenIdleQueue_.front());
                whenIdleQueue_.pop();
                lk.unlock();
                StartWhenIdleWorker(std::move(wiItem));
                return;
            }
            busy_.store(false);
            return;
        }
        auto item = std::move(queue_.front());
        queue_.pop();
        lk.unlock();

        // Resolve interactive mode: per-call override takes precedence over session default.
        bool evalInteractive = (item.interactiveOverride == -1)
                                ? interactiveMode_
                                : (item.interactiveOverride == 1);
        workerReadingLink_.store(true, std::memory_order_release);
        auto* worker = new EvaluateWorker(
            std::move(item.deferred),
            lp_,
            std::move(item.expr),
            std::move(item.opts),
            abortFlag_,
            workerReadingLink_,
            [this]() { PromoteAutoToWhenIdle(); busy_.store(false); MaybeStartNext(); },
            nextLine_.fetch_add(1),
            evalInteractive
        );
        worker->Queue();
    }

    // Launch a lightweight EvaluateWorker that resolves with just the WExpr
    // (not a full EvalResult) — used by sub() when the session is idle.
    void StartSubIdleWorker(QueuedSubIdle item) {
        struct SubIdleWorker : public Napi::AsyncWorker {
            SubIdleWorker(Napi::Promise::Deferred d, WSLINK lp, std::string expr,
                          std::atomic<bool>& workerReadingLink,
                          std::function<void()> done)
                : Napi::AsyncWorker(d.Env()),
                  deferred_(std::move(d)), lp_(lp), expr_(std::move(expr)),
                  workerReadingLink_(workerReadingLink), done_(std::move(done)) {}

            void Execute() override {
                // Drain stale ScheduledTask Dialog[] packets before sending
                // our EvaluatePacket — otherwise, the kernel processes our
                // packet inside the stale Dialog[] context and hangs.
                if (WSReady(lp_)) {
                    DiagLog("[sub-idle] pre-eval: stale data on link — draining");
                    drainStalePackets(lp_, nullptr);
                }
                if (!WSPutFunction(lp_, "EvaluatePacket", 1) ||
                    !WSPutFunction(lp_, "ToExpression",   1) ||
                    !WSPutUTF8String(lp_, (const unsigned char *)expr_.c_str(), (int)expr_.size()) ||
                    !WSEndPacket(lp_)                        ||
                    !WSFlush(lp_)) {
                    workerReadingLink_.store(false, std::memory_order_release);
                    SetError("sub (idle): failed to send EvaluatePacket");
                    return;
                }
                result_ = DrainToEvalResult(lp_);
                workerReadingLink_.store(false, std::memory_order_release); // lp_ no longer in use
            }
            void OnOK() override {
                Napi::Env env = Env();
                if (result_.result.kind == WExpr::WError) {
                    deferred_.Reject(Napi::Error::New(env, result_.result.strVal).Value());
                } else {
                    Napi::Value v = WExprToNapi(env, result_.result);
                    if (env.IsExceptionPending())
                        deferred_.Reject(env.GetAndClearPendingException().Value());
                    else
                        deferred_.Resolve(v);
                }
                done_();
            }
            void OnError(const Napi::Error& e) override {
                deferred_.Reject(e.Value());
                done_();
            }
        private:
            Napi::Promise::Deferred deferred_;
            WSLINK                  lp_;
            std::string             expr_;
            std::atomic<bool>&      workerReadingLink_;
            std::function<void()>   done_;
            EvalResult              result_;
        };

        workerReadingLink_.store(true, std::memory_order_release);
        (new SubIdleWorker(std::move(item.deferred), lp_, std::move(item.expr),
                           workerReadingLink_,
                           [this]() { busy_.store(false); MaybeStartNext(); }))->Queue();
    }

    // Launch a lightweight EvaluateWorker for one subWhenIdle() entry.
    // Identical to StartSubIdleWorker — reuses the same SubIdleWorker inner
    // class pattern; separated here so it can receive QueuedWhenIdle.
    void StartWhenIdleWorker(QueuedWhenIdle item) {
        struct WhenIdleWorker : public Napi::AsyncWorker {
            WhenIdleWorker(Napi::Promise::Deferred d, WSLINK lp, std::string expr,
                           std::atomic<bool>& workerReadingLink,
                           std::function<void()> done)
                : Napi::AsyncWorker(d.Env()),
                  deferred_(std::move(d)), lp_(lp), expr_(std::move(expr)),
                  workerReadingLink_(workerReadingLink), done_(std::move(done)) {}

            void Execute() override {
                // Drain stale ScheduledTask Dialog[] packets before sending
                // our EvaluatePacket — otherwise, the kernel processes our
                // packet inside the stale Dialog[] context and hangs.
                if (WSReady(lp_)) {
                    DiagLog("[when-idle] pre-eval: stale data on link — draining");
                    drainStalePackets(lp_, nullptr);
                }
                if (!WSPutFunction(lp_, "EvaluatePacket", 1) ||
                    !WSPutFunction(lp_, "ToExpression",   1) ||
                    !WSPutUTF8String(lp_, (const unsigned char *)expr_.c_str(), (int)expr_.size()) ||
                    !WSEndPacket(lp_)                        ||
                    !WSFlush(lp_)) {
                    workerReadingLink_.store(false, std::memory_order_release);
                    SetError("subWhenIdle: failed to send EvaluatePacket");
                    return;
                }
                result_ = DrainToEvalResult(lp_);
                workerReadingLink_.store(false, std::memory_order_release);
            }
            void OnOK() override {
                Napi::Env env = Env();
                if (result_.result.kind == WExpr::WError) {
                    deferred_.Reject(Napi::Error::New(env, result_.result.strVal).Value());
                } else {
                    Napi::Value v = WExprToNapi(env, result_.result);
                    if (env.IsExceptionPending())
                        deferred_.Reject(env.GetAndClearPendingException().Value());
                    else
                        deferred_.Resolve(v);
                }
                done_();
            }
            void OnError(const Napi::Error& e) override {
                deferred_.Reject(e.Value());
                done_();
            }
        private:
            Napi::Promise::Deferred deferred_;
            WSLINK                  lp_;
            std::string             expr_;
            std::atomic<bool>&      workerReadingLink_;
            std::function<void()>   done_;
            EvalResult              result_;
        };

        workerReadingLink_.store(true, std::memory_order_release);
        (new WhenIdleWorker(std::move(item.deferred), lp_, std::move(item.expr),
                            workerReadingLink_,
                            [this]() { busy_.store(false); MaybeStartNext(); }))->Queue();
    }

    // -----------------------------------------------------------------------
    // sub(expr) → Promise<WExpr>
    //
    // Queues a lightweight evaluation that resolves with just the WExpr result
    // (not a full EvalResult).  If the session is busy the sub() is prioritised
    // over any pending evaluate() calls and starts as soon as the current eval
    // finishes.  If idle it starts immediately.
    // -----------------------------------------------------------------------
    Napi::Value Sub(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
            return promise;
        }
        if (info.Length() < 1 || !info[0].IsString()) {
            deferred.Reject(Napi::TypeError::New(env, "sub(expr: string)").Value());
            return promise;
        }
        std::string expr = info[0].As<Napi::String>().Utf8Value();

        {
            std::lock_guard<std::mutex> lk(queueMutex_);
            subIdleQueue_.push(QueuedSubIdle{ std::move(expr), std::move(deferred) });
        }
        MaybeStartNext();
        return promise;
    }

    // -----------------------------------------------------------------------
    // subWhenIdle(expr, opts?) → Promise<WExpr>
    //
    // Queues a lightweight evaluation at the LOWEST priority: it runs only
    // when both subIdleQueue_ and queue_ are empty (kernel truly idle).
    // Ideal for background queries that must not compete with cell evaluations.
    //
    // opts may contain:
    //   timeout?: number  — milliseconds to wait before the Promise rejects
    // -----------------------------------------------------------------------
    Napi::Value SubWhenIdle(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
            return promise;
        }
        if (info.Length() < 1 || !info[0].IsString()) {
            deferred.Reject(Napi::TypeError::New(env,
                "subWhenIdle(expr: string, opts?: {timeout?: number})").Value());
            return promise;
        }
        std::string expr = info[0].As<Napi::String>().Utf8Value();

        // Parse optional timeout from opts object.
        auto deadline = std::chrono::steady_clock::time_point::max();
        if (info.Length() >= 2 && info[1].IsObject()) {
            auto optsObj = info[1].As<Napi::Object>();
            if (optsObj.Has("timeout") && optsObj.Get("timeout").IsNumber()) {
                double ms = optsObj.Get("timeout").As<Napi::Number>().DoubleValue();
                if (ms > 0)
                    deadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(static_cast<int64_t>(ms));
            }
        }

        {
            std::lock_guard<std::mutex> lk(queueMutex_);
            whenIdleQueue_.push(QueuedWhenIdle{
                std::move(expr), std::move(deferred), deadline });
        }
        MaybeStartNext();
        return promise;
    }

    // -----------------------------------------------------------------------
    // subAuto(expr) → Promise<WExpr>
    //
    // Auto-routing evaluator: when idle, evaluates via the subWhenIdle path;
    // when busy, evaluates inline inside the next ScheduledTask Dialog[] cycle.
    // Callers never need to check busy/idle — C++ handles the routing.
    //
    // Results are delivered as resolved/rejected Promises with a WExpr value
    // (same format as subWhenIdle: {type:"string", value:"..."}).
    // -----------------------------------------------------------------------
    Napi::Value SubAuto(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
            return promise;
        }
        if (info.Length() < 1 || !info[0].IsString()) {
            deferred.Reject(Napi::TypeError::New(env,
                "subAuto(expr: string)").Value());
            return promise;
        }
        std::string expr = info[0].As<Napi::String>().Utf8Value();

        // Lazy-init the auto-resolver TSFN on first subAuto() call.
        // The TSFN fires a bound callback on the main thread that drains
        // completed results and resolves the corresponding deferreds.
        if (!autoTsfnActive_.load()) {
            auto resolver = Napi::Function::New(env,
                [](const Napi::CallbackInfo& cbInfo) {
                    auto* self = static_cast<WstpSession*>(cbInfo.Data());
                    self->DrainAutoResults(cbInfo.Env());
                }, "autoResolver", this);
            autoResolverTsfn_ = Napi::ThreadSafeFunction::New(
                env, resolver, "subAutoResolver", 0, 1);
            autoResolverTsfn_.Unref(env);  // don't keep event loop alive
            autoTsfnActive_.store(true);
        }

        if (!busy_.load()) {
            // Idle path: forward to whenIdleQueue (same as subWhenIdle).
            DiagLog("[subAuto] idle path for expr='" + expr + "'");
            {
                std::lock_guard<std::mutex> lk(queueMutex_);
                whenIdleQueue_.push(QueuedWhenIdle{
                    std::move(expr), std::move(deferred),
                    std::chrono::steady_clock::time_point::max() });
            }
            MaybeStartNext();
        } else {
            // Busy path: queue for evaluation in the next Dialog[] cycle.
            size_t id = autoNextId_.fetch_add(1);
            DiagLog("[subAuto] busy path id=" + std::to_string(id) +
                    " expr='" + expr + "'");
            {
                std::lock_guard<std::mutex> lk(autoMutex_);
                autoExprQueue_.push_back({id, std::move(expr)});
            }
            autoDeferreds_.emplace(id, std::move(deferred));

            // Ensure dynAutoMode and ScheduledTask timer are active so the
            // Dialog[] mechanism fires and our expression gets evaluated.
            if (!dynAutoMode_.load()) dynAutoMode_.store(true);
            if (dynIntervalMs_.load() == 0) {
                dynIntervalMs_.store(300);
                if (!dynTimerRunning_.load()) StartDynTimer();
            }
        }
        return promise;
    }

    // -----------------------------------------------------------------------
    // DrainAutoResults — resolve pending subAuto deferreds on the main thread.
    // Called from the auto-resolver TSFN callback (main thread only).
    // -----------------------------------------------------------------------
    void DrainAutoResults(Napi::Env env) {
        std::vector<AutoResultEntry> results;
        {
            std::lock_guard<std::mutex> lk(autoMutex_);
            results.swap(autoCompleted_);
        }
        for (auto& ar : results) {
            auto it = autoDeferreds_.find(ar.id);
            if (it == autoDeferreds_.end()) continue;
            if (ar.error.empty()) {
                auto obj = Napi::Object::New(env);
                obj.Set("type",  Napi::String::New(env, "string"));
                obj.Set("value", Napi::String::New(env, ar.value));
                it->second.Resolve(obj);
            } else {
                it->second.Reject(Napi::Error::New(env, ar.error).Value());
            }
            autoDeferreds_.erase(it);
        }
    }

    // -----------------------------------------------------------------------
    // PromoteAutoToWhenIdle — move any pending subAuto entries that were not
    // evaluated during the busy cycle into the whenIdleQueue so they run
    // normally once the kernel is free.  Called on busy→idle transition.
    // -----------------------------------------------------------------------
    void PromoteAutoToWhenIdle() {
        std::deque<AutoExprEntry> remaining;
        {
            std::lock_guard<std::mutex> lk(autoMutex_);
            remaining.swap(autoExprQueue_);
        }
        if (remaining.empty()) return;
        DiagLog("[subAuto] promoting " + std::to_string(remaining.size()) +
                " pending entries to whenIdleQueue");
        std::lock_guard<std::mutex> qlk(queueMutex_);
        for (auto& entry : remaining) {
            auto it = autoDeferreds_.find(entry.id);
            if (it != autoDeferreds_.end()) {
                whenIdleQueue_.push(QueuedWhenIdle{
                    std::move(entry.expr),
                    std::move(it->second),
                    std::chrono::steady_clock::time_point::max()
                });
                autoDeferreds_.erase(it);
            }
        }
    }

    // -----------------------------------------------------------------------
    // exitDialog(retVal?) → Promise<void>
    //
    // Exits the currently-open Dialog[] subsession by entering
    // "Return[retVal]" as if the user typed it at the interactive prompt
    // (EnterTextPacket).  This is different from plain dialogEval('Return[]')
    // which uses EvaluatePacket and does NOT exit the dialog because Return[]
    // at the top level of EvaluatePacket is unevaluated.
    //
    // Returns a Promise that resolves (with Null) when ENDDLGPKT is received,
    // or rejects immediately if no dialog is open.
    // -----------------------------------------------------------------------
    Napi::Value ExitDialog(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
            return promise;
        }
        if (!dialogOpen_.load()) {
            deferred.Reject(Napi::Error::New(env,
                "no dialog subsession is open").Value());
            return promise;
        }
        // Stale-state guard: dialogOpen_=true but the drain loop has already
        // exited (busy_=false).  Nobody will service the queue, so resolve
        // immediately and clean up rather than enqueuing a hanging request.
        if (!busy_.load()) {
            FlushDialogQueueWithError("dialog closed: session idle");
            dialogOpen_.store(false);
            deferred.Resolve(env.Null());
            return promise;
        }
        // Build "Return[]" or "Return[retVal]" as the exit expression.
        std::string exitExpr = "Return[]";
        if (info.Length() >= 1 && info[0].IsString())
            exitExpr = "Return[" + info[0].As<Napi::String>().Utf8Value() + "]";

        auto tsfn = Napi::ThreadSafeFunction::New(
            env,
            Napi::Function::New(env, [deferred](const Napi::CallbackInfo& ci) mutable {
                Napi::Env e = ci.Env();
                if (ci.Length() > 0) {
                    auto obj = ci[0];
                    if (obj.IsObject()) {
                        auto o = obj.As<Napi::Object>();
                        if (o.Has("error") && o.Get("error").IsString()) {
                            deferred.Reject(Napi::Error::New(e,
                                o.Get("error").As<Napi::String>().Utf8Value()).Value());
                            return;
                        }
                    }
                }
                deferred.Resolve(e.Null());
            }),
            "exitDialogResolve", 0, 1);

        DialogRequest req;
        req.expr         = std::move(exitExpr);
        req.useEnterText = true;
        req.resolve      = std::move(tsfn);
        {
            std::lock_guard<std::mutex> lk(dialogMutex_);
            dialogQueue_.push(std::move(req));
        }
        dialogPending_.store(true);
        return promise;
    }

    // -----------------------------------------------------------------------
    // dialogEval(expr) → Promise<WExpr>
    // Rejects immediately if no dialog is open.
    // -----------------------------------------------------------------------
    Napi::Value DialogEval(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
            return promise;
        }
        if (!dialogOpen_.load()) {
            deferred.Reject(Napi::Error::New(env,
                "no dialog subsession is open — call Dialog[] first").Value());
            return promise;
        }
        if (info.Length() < 1 || !info[0].IsString()) {
            deferred.Reject(Napi::TypeError::New(env, "dialogEval(expr: string)").Value());
            return promise;
        }
        std::string expr = info[0].As<Napi::String>().Utf8Value();

        // Create a TSFN that resolves/rejects the deferred on the main thread.
        // The TSFN is Released by serviceDialogRequest() after the single call.
        auto tsfn = Napi::ThreadSafeFunction::New(
            env,
            Napi::Function::New(env, [deferred](const Napi::CallbackInfo& ci) mutable {
                Napi::Env e = ci.Env();
                if (ci.Length() > 0 && ci[0].IsObject()) {
                    auto obj = ci[0].As<Napi::Object>();
                    // Check for error sentinel: { error: string }
                    if (obj.Has("error") && obj.Get("error").IsString()) {
                        deferred.Reject(Napi::Error::New(e,
                            obj.Get("error").As<Napi::String>().Utf8Value()).Value());
                    } else {
                        deferred.Resolve(ci[0]);
                    }
                } else {
                    deferred.Reject(Napi::Error::New(e, "dialogEval: bad result").Value());
                }
            }),
            "dialogResolve", 0, 1);

        DialogRequest req;
        req.expr         = std::move(expr);
        req.useEnterText = false;
        req.resolve      = std::move(tsfn);
        {
            std::lock_guard<std::mutex> lk(dialogMutex_);
            dialogQueue_.push(std::move(req));
        }
        dialogPending_.store(true);
        return promise;
    }

    // -----------------------------------------------------------------------
    // interrupt() — send WSInterruptMessage (best-effort).
    //
    // This is NOT abort() — it does not cancel the evaluation.  Its effect
    // depends entirely on whether a Wolfram-side interrupt handler has been
    // installed (e.g. Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]).
    // On kernels without such a handler this is a no-op.
    // Main-thread only — same thread-safety guarantee as abort().
    // -----------------------------------------------------------------------
    Napi::Value Interrupt(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (!open_) return Napi::Boolean::New(env, false);
        int ok = WSPutMessage(lp_, WSInterruptMessage);
        return Napi::Boolean::New(env, ok != 0);
    }

    // -----------------------------------------------------------------------
    // registerDynamic(id, expr) → void
    // Register or replace a Dynamic expression for periodic evaluation.
    // -----------------------------------------------------------------------
    Napi::Value RegisterDynamic(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
            Napi::TypeError::New(env, "registerDynamic(id: string, expr: string)")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string id   = info[0].As<Napi::String>().Utf8Value();
        std::string expr = info[1].As<Napi::String>().Utf8Value();
        {
            std::lock_guard<std::mutex> lk(dynMutex_);
            for (auto& reg : dynRegistry_) {
                if (reg.id == id) { reg.expr = expr; return env.Undefined(); }
            }
            dynRegistry_.push_back({id, expr});
        }
        return env.Undefined();
    }

    // -----------------------------------------------------------------------
    // unregisterDynamic(id) → void
    // -----------------------------------------------------------------------
    Napi::Value UnregisterDynamic(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "unregisterDynamic(id: string)")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string id = info[0].As<Napi::String>().Utf8Value();
        {
            std::lock_guard<std::mutex> lk(dynMutex_);
            dynRegistry_.erase(
                std::remove_if(dynRegistry_.begin(), dynRegistry_.end(),
                    [&id](const DynRegistration& r){ return r.id == id; }),
                dynRegistry_.end());
        }
        return env.Undefined();
    }

    // -----------------------------------------------------------------------
    // clearDynamicRegistry() → void
    // -----------------------------------------------------------------------
    Napi::Value ClearDynamicRegistry(const Napi::CallbackInfo& info) {
        std::lock_guard<std::mutex> lk(dynMutex_);
        dynRegistry_.clear();
        dynResults_.clear();
        return info.Env().Undefined();
    }

    // -----------------------------------------------------------------------
    // getDynamicResults() → Record<string, DynResult>
    // Swaps and returns accumulated results; clears the internal buffer.
    // -----------------------------------------------------------------------
    Napi::Value GetDynamicResults(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        std::vector<DynResult> snap;
        {
            std::lock_guard<std::mutex> lk(dynMutex_);
            snap.swap(dynResults_);
        }
        auto obj = Napi::Object::New(env);
        for (const auto& dr : snap) {
            auto entry = Napi::Object::New(env);
            entry.Set("value",     Napi::String::New(env, dr.value));
            entry.Set("timestamp", Napi::Number::New(env, dr.timestamp));
            if (!dr.error.empty())
                entry.Set("error", Napi::String::New(env, dr.error));
            obj.Set(dr.id, entry);
        }
        return obj;
    }

    // -----------------------------------------------------------------------
    // setDynamicInterval(ms) → void
    // Set the auto-interrupt interval.  0 = disabled.
    // Starting/stopping the timer thread is handled here.
    // -----------------------------------------------------------------------
    Napi::Value SetDynamicInterval(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsNumber()) {
            Napi::TypeError::New(env, "setDynamicInterval(ms: number)")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        int ms = static_cast<int>(info[0].As<Napi::Number>().Int32Value());
        if (ms < 0) ms = 0;
        int prev = dynIntervalMs_.exchange(ms);
        // Auto-enable dynAutoMode when interval > 0, auto-disable when 0.
        dynAutoMode_.store(ms > 0);
        // Start timer thread if transitioning from 0 to non-zero.
        if (prev == 0 && ms > 0 && !dynTimerRunning_.load()) {
            StartDynTimer();
        }
        return env.Undefined();
    }

    // -----------------------------------------------------------------------
    // setDynAutoMode(auto) → void
    // true  = C++-internal inline dialog path
    // false = legacy JS dialogEval/exitDialog path (default; for debugger)
    // -----------------------------------------------------------------------
    Napi::Value SetDynAutoMode(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsBoolean()) {
            Napi::TypeError::New(env, "setDynAutoMode(auto: boolean)")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        bool newMode = info[0].As<Napi::Boolean>().Value();
        bool oldMode = dynAutoMode_.exchange(newMode);
        // When transitioning true→false (Dynamic cleanup), stop the timer
        // thread.  Prevents stale ScheduledTask Dialog[] calls from reaching
        // the BEGINDLGPKT handler after cleanup.  The safety fallback in
        // BEGINDLGPKT handles any Dialog[] that fires before this takes effect.
        if (oldMode && !newMode) {
            dynIntervalMs_.store(0);
        }
        return env.Undefined();
    }

    // -----------------------------------------------------------------------
    // dynamicActive (accessor) → boolean
    // True if registry non-empty and interval > 0.
    // -----------------------------------------------------------------------
    Napi::Value DynamicActive(const Napi::CallbackInfo& info) {
        std::lock_guard<std::mutex> lk(dynMutex_);
        bool active = !dynRegistry_.empty() && dynIntervalMs_.load() > 0;
        return Napi::Boolean::New(info.Env(), active);
    }

    // -----------------------------------------------------------------------
    // abort() — interrupt the currently running evaluation.
    Napi::Value Abort(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (!open_) return Napi::Boolean::New(env, false);
        // Only signal the kernel if an evaluation is actually in flight.
        // Sending WSAbortMessage to an idle kernel causes it to emit a
        // spurious RETURNPKT[$Aborted] that would corrupt the next evaluation.
        if (!busy_.load()) return Napi::Boolean::New(env, false);
        // Deduplication: if abortFlag_ is already true, another abort() is already
        // in flight — sending a second WSAbortMessage causes stale response packets
        // that corrupt the next evaluation.  Just return true (already aborting).
        bool expected = false;
        if (!abortFlag_.compare_exchange_strong(expected, true))
            return Napi::Boolean::New(env, true);  // already aborting — no-op
        // Flush any queued dialogEval/exitDialog requests so their promises
        // reject immediately instead of hanging forever.
        FlushDialogQueueWithError("abort");
        dialogOpen_.store(false);
        int ok = WSPutMessage(lp_, WSAbortMessage);
        return Napi::Boolean::New(env, ok != 0);
    }

    // -----------------------------------------------------------------------
    // closeAllDialogs() → boolean
    //
    // Unconditionally resets all dialog state on the JS side:
    //   • Drains dialogQueue_, rejecting every pending dialogEval/exitDialog
    //     promise with an error (so callers don't hang).
    //   • Clears dialogOpen_ so isDialogOpen returns false.
    //
    // This does NOT send any packet to the kernel — it only fixes the Node
    // side bookkeeping.  Use it in error-recovery paths (before abort() or
    // after an unexpected kernel state change) to guarantee clean state.
    //
    // Returns true if dialogOpen_ was set before the call (i.e. something
    // was actually cleaned up), false if it was already clear.
    // -----------------------------------------------------------------------
    Napi::Value CloseAllDialogs(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        bool wasOpen = dialogOpen_.load();
        FlushDialogQueueWithError("dialog closed by closeAllDialogs");
        dialogOpen_.store(false);
        return Napi::Boolean::New(env, wasOpen);
    }

    // -----------------------------------------------------------------------
    // createSubsession(kernelPath?) → WstpSession
    //
    // Spawns a completely independent WolframKernel process.  Its entire
    // state (variables, definitions, memory) is isolated from the parent
    // and from every other session.  Ideal for sandboxed or parallel work.
    // -----------------------------------------------------------------------
    Napi::Value CreateSubsession(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::FunctionReference* ctor = env.GetInstanceData<Napi::FunctionReference>();
        if (info.Length() > 0 && info[0].IsString())
            return ctor->New({ info[0] });
        return ctor->New({});
    }

    // -----------------------------------------------------------------------
    // close()
    // -----------------------------------------------------------------------
    Napi::Value Close(const Napi::CallbackInfo& info) {
        CleanUp();
        return info.Env().Undefined();
    }

    // -----------------------------------------------------------------------
    // isOpen  (read-only accessor)
    // -----------------------------------------------------------------------
    Napi::Value IsOpen(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), open_);
    }

    // -----------------------------------------------------------------------
    // isDialogOpen  (read-only accessor)
    // -----------------------------------------------------------------------
    Napi::Value IsDialogOpen(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), dialogOpen_.load());
    }

    // -----------------------------------------------------------------------
    // isReady  (read-only accessor)
    // true iff the session is open, the kernel has no active evaluation
    // (busy_ is false), no dialog is open, and the eval + sub queues are
    // both empty — i.e. the next evaluate() will start immediately.
    // All reads are on the JS main thread (same thread that writes open_ and
    // the queues), so no extra locking is needed.
    // -----------------------------------------------------------------------
    Napi::Value IsReady(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(),
            open_
            && !busy_.load(std::memory_order_relaxed)
            && !dialogOpen_.load(std::memory_order_relaxed)
            && queue_.empty()
            && subIdleQueue_.empty());
    }

    // -----------------------------------------------------------------------
    // kernelPid  (read-only accessor)
    // Returns the OS process ID of the WolframKernel child process.
    // Returns 0 if the PID could not be fetched (non-fatal, rare fallback).
    // The PID can be used by the caller to monitor or force-terminate the
    // kernel process independently of the WSTP link (e.g. after a restart).
    // -----------------------------------------------------------------------
    Napi::Value KernelPid(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), static_cast<double>(kernelPid_));
    }

private:
    // Queue entry — one pending evaluate() call.
    // interactiveOverride: -1 = use session default, 0 = force batch, 1 = force interactive
    struct QueuedEval {
        std::string             expr;
        EvalOptions             opts;
        Napi::Promise::Deferred deferred;
        int                     interactiveOverride = -1;
    };

    // -----------------------------------------------------------------------
    // FlushDialogQueueWithError — drain dialogQueue_, rejecting every pending
    // promise with errMsg.  Caller must hold no locks; this acquires
    // dialogMutex_ internally.  Resets dialogPending_.
    // -----------------------------------------------------------------------
    void FlushDialogQueueWithError(const std::string& errMsg) {
        std::queue<DialogRequest> toFlush;
        {
            std::lock_guard<std::mutex> lk(dialogMutex_);
            std::swap(toFlush, dialogQueue_);
            dialogPending_.store(false);
        }
        while (!toFlush.empty()) {
            DialogRequest req = std::move(toFlush.front());
            toFlush.pop();
            std::string msg = errMsg;
            req.resolve.NonBlockingCall([msg](Napi::Env e, Napi::Function cb) {
                auto obj = Napi::Object::New(e);
                obj.Set("error", Napi::String::New(e, msg));
                cb.Call({obj});
            });
            req.resolve.Release();
        }
    }

    // -----------------------------------------------------------------------
    // StartDynTimer — launches the background timer thread that sends
    // WSInterruptMessage at the configured interval when the kernel is busy
    // and Dynamic expressions are registered.
    // Called on the JS main thread; harmless to call if already running.
    // -----------------------------------------------------------------------
    void StartDynTimer() {
        if (dynTimerRunning_.exchange(true)) return;  // already running
        if (dynTimerThread_.joinable()) dynTimerThread_.join();
        dynTimerThread_ = std::thread([this]() {
            while (open_ && dynIntervalMs_.load() > 0) {
                int ms = dynIntervalMs_.load();
                std::this_thread::sleep_for(std::chrono::milliseconds(ms > 0 ? ms : 100));
                if (!open_) break;
                if (!busy_.load()) continue;                      // kernel idle
                bool hasDynRegs = false;
                {
                    std::lock_guard<std::mutex> lk(dynMutex_);
                    hasDynRegs = !dynRegistry_.empty();
                }
                bool hasAutoEntries = false;
                {
                    std::lock_guard<std::mutex> lk(autoMutex_);
                    hasAutoEntries = !autoExprQueue_.empty();
                }
                if (!hasDynRegs && !hasAutoEntries) continue;     // nothing to do
                if (dynIntervalMs_.load() == 0) break;
                // Check enough time has elapsed since last eval.
                auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - dynLastEval_).count();
                if (elapsed < dynIntervalMs_.load()) continue;

                if (workerReadingLink_.load() && !dialogOpen_.load()) {
                    // Decide whether to send an interrupt:
                    //  - dynAutoMode=false + hasDynRegs: legacy Dynamic path (no ScheduledTask)
                    //  - hasAutoEntries + no ScheduledTask: subAuto needs Dialog[] via interrupt
                    // When ScheduledTask IS installed (dynAutoMode=true + hasDynRegs),
                    // Dialog[] fires from the kernel side — no interrupt needed.
                    bool taskInstalled = dynAutoMode_.load() && (dynTaskInstalledInterval_ > 0);
                    bool needInterrupt = false;
                    if (!dynAutoMode_.load() && hasDynRegs) needInterrupt = true;
                    if (hasAutoEntries && !taskInstalled) needInterrupt = true;
                    if (needInterrupt) {
                        WSPutMessage(lp_, WSInterruptMessage);
                    }
                }
            }
            dynTimerRunning_.store(false);
        });
        dynTimerThread_.detach();
    }

    void CleanUp() {
        // Stop the Dynamic timer thread.
        dynIntervalMs_.store(0);
        dynTimerRunning_.store(false);

        // Release the subAuto resolver TSFN and reject pending deferreds.
        if (autoTsfnActive_.load()) {
            autoTsfnActive_.store(false);
            autoResolverTsfn_.Release();
        }
        for (auto& [id, def] : autoDeferreds_) {
            try { def.Reject(Napi::Error::New(def.Env(), "Session is closed").Value()); } catch (...) {}
        }
        autoDeferreds_.clear();
        {
            std::lock_guard<std::mutex> lk(autoMutex_);
            autoExprQueue_.clear();
            autoCompleted_.clear();
        }

        // Immediately reject all queued subWhenIdle() requests before the link
        // is torn down.  These items have never been dispatched to a worker so
        // they won't receive an OnError callback — we must reject them here.
        {
            std::lock_guard<std::mutex> lk(queueMutex_);
            while (!whenIdleQueue_.empty()) {
                auto& wi = whenIdleQueue_.front();
                wi.deferred.Reject(
                    Napi::Error::New(wi.deferred.Env(), "Session is closed").Value());
                whenIdleQueue_.pop();
            }
        }
        // If a worker thread is currently reading from lp_, calling WSClose()
        // on it from the JS main thread causes a concurrent-access crash
        // (heap-use-after-free / SIGSEGV).
        //
        // We spin on workerReadingLink_ (set false by Execute() on the background
        // thread) rather than busy_ (set false by OnOK/OnError on the main thread).
        // Spinning on busy_ from the main thread would deadlock because the main
        // thread's event loop is blocked — NAPI never gets to call OnOK.
        open_ = false; // prevent new evals from queuing during shutdown
        if (workerReadingLink_.load(std::memory_order_acquire) && lp_) {
            abortFlag_.store(true);
            FlushDialogQueueWithError("session closed");
            dialogOpen_.store(false);
            WSPutMessage(lp_, WSAbortMessage);
            // Phase 1: wait up to 2s for WSAbortMessage to unblock the worker.
            auto deadline =
                std::chrono::steady_clock::now() + std::chrono::seconds(2);
            while (workerReadingLink_.load(std::memory_order_acquire) &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            // Phase 2: if the worker is still stuck (e.g. Pause[] ignoring
            // WSAbortMessage), SIGKILL the kernel to break the link.  This
            // makes WSNextPacket return an error so the worker exits promptly.
            if (workerReadingLink_.load(std::memory_order_acquire) &&
                kernelPid_ > 0 && !kernelKilled_) {
                kernelKilled_ = true;
                kill(kernelPid_, SIGKILL);
                DiagLog("[CleanUp] SIGKILL pid " + std::to_string(kernelPid_) +
                        " — worker still reading after 2s");
                // Brief wait for the worker to notice the dead link.
                deadline = std::chrono::steady_clock::now() +
                           std::chrono::seconds(2);
                while (workerReadingLink_.load(std::memory_order_acquire) &&
                       std::chrono::steady_clock::now() < deadline)
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
        }
        if (lp_)    { WSClose(lp_);           lp_    = nullptr; }
        if (wsEnv_) { WSDeinitialize(wsEnv_); wsEnv_ = nullptr; }
        // Kill the child kernel process so it doesn't become a zombie.
        // WSClose() closes the link but does not terminate the WolframKernel
        // child process — without this, each session leaks a kernel.
        // kernelPid_ is intentionally NOT zeroed here so .kernelPid remains
        // readable after close() (useful for post-mortem logging / force-kill).
        // kernelKilled_ prevents a double-kill when the destructor later calls
        // CleanUp() a second time.
        if (kernelPid_ > 0 && !kernelKilled_) { kernelKilled_ = true; kill(kernelPid_, SIGTERM); }
    }


    // ---------------------------------------------------------------------------
    // Verify that $Output→TextPacket routing is live before the session is used.
    // Sends Print["$WARMUP$"] and looks for a TextPacket response, retrying up to
    // 5 times with a 100 ms pause between attempts.  On some WolframKernel
    // launches (observed ~20% of consecutive runs) the kernel processes the
    // first EvaluatePacket before its internal $Output stream is wired to the
    // WSTP link, causing ALL subsequent Print[]/Message[] calls to silently
    // drop their output.  One extra round-trip here forces the kernel to
    // complete its output-routing setup before any user code is evaluated.
    // Returns true if output routing is confirmed; false if it cannot be fixed.
    // ---------------------------------------------------------------------------
    static bool WarmUpOutputRouting(WSLINK lp) {
        // Brief initial pause after WSActivate: lets the kernel scheduler
        // fully wire $Output → WSTP TextPacket before the first probe.
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        for (int attempt = 0; attempt < 4; ++attempt) {
            if (attempt > 0)
                std::this_thread::sleep_for(std::chrono::milliseconds(200));

            // Send EvaluatePacket[Print["$WARMUP$"]]
            if (!WSPutFunction(lp, "EvaluatePacket", 1) ||
                !WSPutFunction(lp, "Print",          1) ||
                !WSPutString  (lp, "$WARMUP$")          ||
                !WSEndPacket  (lp)                      ||
                !WSFlush      (lp))
                return false;  // link error

            bool gotText = false;
            while (true) {
                int pkt = WSNextPacket(lp);
                if (pkt == TEXTPKT) {
                    WSNewPacket(lp);
                    gotText = true;
                } else if (pkt == RETURNPKT) {
                    WSNewPacket(lp);
                    break;
                } else if (pkt == 0 || pkt == ILLEGALPKT) {
                    WSClearError(lp);
                    return false;
                } else {
                    WSNewPacket(lp);
                }
            }
            if (gotText) {
                DiagLog("[WarmUp] $Output routing verified on attempt " + std::to_string(attempt + 1));
                return true;
            }
            DiagLog("[WarmUp] no TextPacket on attempt " + std::to_string(attempt + 1) + ", retrying...");
        }
        DiagLog("[WarmUp] $Output routing NOT confirmed — kernel restart needed");
        return false;
    }

    // ---------------------------------------------------------------------------
    // Synchronously evaluate $ProcessID and return the kernel's PID.
    // Called once from the constructor after WSActivate, while the link is idle.
    // Returns 0 on failure (non-fatal — cleanup falls back to no-kill).
    // ---------------------------------------------------------------------------
    static pid_t FetchKernelPid(WSLINK lp) {
        // Send:  EvaluatePacket[ToExpression["$ProcessID"]]
        if (!WSPutFunction(lp, "EvaluatePacket", 1) ||
            !WSPutFunction(lp, "ToExpression",   1) ||
            !WSPutString  (lp, "$ProcessID")        ||
            !WSEndPacket  (lp)                      ||
            !WSFlush      (lp))
            return 0;

        // Drain packets until we see ReturnPacket with an integer.
        pid_t pid = 0;
        while (true) {
            int pkt = WSNextPacket(lp);
            if (pkt == RETURNPKT) {
                if (WSGetType(lp) == WSTKINT) {
                    wsint64 v = 0;
                    WSGetInteger64(lp, &v);
                    pid = static_cast<pid_t>(v);
                }
                WSNewPacket(lp);
                break;
            }
            if (pkt == 0 || pkt == ILLEGALPKT) { WSClearError(lp); break; }
            WSNewPacket(lp);  // skip INPUTNAMEPKT, OUTPUTNAMEPKT, etc.
        }
        return pid;
    }

    WSEnvironment               wsEnv_;
    WSLINK                      lp_;
    bool                        open_;
    bool                        interactiveMode_ = false;  // true → EnterTextPacket, populates In/Out
    pid_t                       kernelPid_  = 0;  // child process PID — preserved after close() for .kernelPid accessor
    bool                        kernelKilled_ = false; // guards against double-kill across close() + destructor
    std::atomic<int64_t>        nextLine_{1};      // 1-based In[n] counter for EvalResult.cellIndex
    std::atomic<bool>           abortFlag_{false};
    std::atomic<bool>           busy_{false};
    // Set true before queuing a worker, set false from within Execute() (background
    // thread) right after DrainToEvalResult returns.  CleanUp() spins on this flag
    // rather than busy_ (which is cleared on the main thread and cannot be polled
    // from a main-thread spin loop).
    std::atomic<bool>           workerReadingLink_{false};
    std::mutex                  queueMutex_;
    std::queue<QueuedEval>      queue_;
    std::queue<QueuedSubIdle>   subIdleQueue_;    // sub() — runs before queue_ items
    std::queue<QueuedWhenIdle>  whenIdleQueue_;   // subWhenIdle() — lowest priority, runs when truly idle
    // Dialog subsession state — written on main thread, consumed on thread pool
    std::mutex                  dialogMutex_;
    std::queue<DialogRequest>   dialogQueue_;     // dialogEval() requests
    std::atomic<bool>           dialogPending_{false};
    std::atomic<bool>           dialogOpen_{false};

    // -----------------------------------------------------------------------
    // Dynamic evaluation state (Phase 2 — C++-internal Dynamic eval)
    // -----------------------------------------------------------------------
    std::mutex                            dynMutex_;
    std::vector<DynRegistration>          dynRegistry_;        // registered exprs
    std::vector<DynResult>                dynResults_;         // accumulated results (swapped on getDynamicResults)
    std::atomic<int>                      dynIntervalMs_{0};   // 0 = disabled
    std::atomic<bool>                     dynAutoMode_{false}; // true = inline C++ path; false = legacy JS path
    int                                   dynTaskInstalledInterval_{0}; // interval of currently installed ScheduledTask (0 = none)
    std::chrono::steady_clock::time_point dynLastEval_{};      // time of last successful dialog eval
    std::thread                           dynTimerThread_;
    std::atomic<bool>                     dynTimerRunning_{false};

    // -----------------------------------------------------------------------
    // subAuto() state — one-shot auto-routing evaluations
    // -----------------------------------------------------------------------
    std::atomic<size_t>                                autoNextId_{0};
    std::mutex                                         autoMutex_;          // protects autoExprQueue_ + autoCompleted_
    std::deque<AutoExprEntry>                          autoExprQueue_;      // pending exprs for next Dialog[] cycle
    std::vector<AutoResultEntry>                       autoCompleted_;      // results from worker thread
    std::unordered_map<size_t, Napi::Promise::Deferred> autoDeferreds_;    // main-thread only: id → deferred
    Napi::ThreadSafeFunction                           autoResolverTsfn_;   // signals main thread to drain results
    std::atomic<bool>                                  autoTsfnActive_{false};
};

// ===========================================================================
// ReadNextWorker — async "read one expression" for WstpReader
// ===========================================================================
class ReadNextWorker : public Napi::AsyncWorker {
public:
    ReadNextWorker(Napi::Promise::Deferred deferred, WSLINK lp, std::atomic<bool>& activated)
        : Napi::AsyncWorker(deferred.Env()), deferred_(deferred), lp_(lp), activated_(activated) {}

    // Thread-pool: activate on first call, then read next expression.
    void Execute() override {
        // WSActivate must happen on a thread-pool thread, never on the JS
        // main thread.  The kernel's WSTP runtime can only complete the
        // handshake once it is inside the Do-loop calling LinkWrite.
        if (!activated_.load()) {
            DiagLog("[WstpReader] WSActivate starting...");
            if (!WSActivate(lp_)) {
                const char* msg = WSErrorMessage(lp_);
                std::string err = std::string("WstpReader: WSActivate failed: ") + (msg ? msg : "?");
                DiagLog("[WstpReader] " + err);
                SetError(err);
                WSClearError(lp_);
                return;
            }
            // DO NOT call WSGetType / WSNewPacket here.
            // On TCPIP connect-mode links WSGetType is non-blocking: it returns 0
            // for *both* "no data in buffer yet" and a genuine WSTKEND boundary
            // token.  Calling WSNewPacket when there is no data in the buffer
            // corrupts the link's internal read state so that every subsequent
            // WSGetType also returns 0, making all future reads hang forever.
            // The WSTKEND / preamble case (if it occurs at all) is handled below
            // after WSWaitForLinkActivity returns and data is confirmed present.
            DiagLog("[WstpReader] activated.");
            activated_.store(true);
        }

        // Spin on WSGetType() waiting for the link buffer to become non-empty.
        //
        // WSGetType() is non-blocking on TCPIP connect-mode links: it returns
        // 0 immediately if no data is buffered.  We spin in 5 ms increments
        // rather than using WSWaitForLinkActivity(), which has been observed to
        // return WSWAITSUCCESS before the buffer is actually readable on fast
        // consecutive runs, leading to a ReadExprRaw(type=0) error.
        //
        // The first 500 ms are traced at each distinct type value so failures
        // can be diagnosed from the log.  Hard timeout: 5 seconds.
        {
            auto spinStart   = std::chrono::steady_clock::now();
            auto deadline    = spinStart + std::chrono::seconds(5);
            auto traceWindow = spinStart + std::chrono::milliseconds(500);
            int  iters = 0, lastLoggedType = -999;
            while (true) {
                int t = WSGetType(lp_);
                ++iters;
                auto now = std::chrono::steady_clock::now();
                // Within the first 500 ms log every distinct type change.
                if (now < traceWindow && t != lastLoggedType) {
                    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  now - spinStart).count();
                    DiagLog("[WstpReader] spin t=" + std::to_string(t)
                            + " +" + std::to_string(ms) + "ms iter=" + std::to_string(iters));
                    lastLoggedType = t;
                }
                if (t != 0) {
                    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  now - spinStart).count();
                    DiagLog("[WstpReader] spin done: type=" + std::to_string(t)
                            + " after " + std::to_string(iters) + " iters +"
                            + std::to_string(ms) + "ms");
                    break;
                }
                if (now >= deadline) {
                    DiagLog("[WstpReader] spin TIMEOUT after " + std::to_string(iters)
                            + " iters (5s)");
                    SetError("WstpReader: 5-second timeout — link dead or data never arrived");
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
        }

        result_ = ReadExprRaw(lp_);

        // If ReadExprRaw still encountered WSTKEND (type=0) it means the spin
        // exited on a protocol boundary token, not an expression token.  Skip
        // it once with WSNewPacket and re-spin for the real expression.
        if (result_.kind == WExpr::WError
                && result_.strVal.find("unexpected token type: 0") != std::string::npos) {
            DiagLog("[WstpReader] got WSTKEND from ReadExprRaw — skipping preamble, re-spinning");
            WSNewPacket(lp_);
            auto spinStart2 = std::chrono::steady_clock::now();
            auto deadline2  = spinStart2 + std::chrono::seconds(5);
            int  iters2 = 0;
            while (true) {
                int t = WSGetType(lp_);
                ++iters2;
                if (t != 0) {
                    DiagLog("[WstpReader] re-spin done: type=" + std::to_string(t)
                            + " after " + std::to_string(iters2) + " iters");
                    break;
                }
                if (std::chrono::steady_clock::now() >= deadline2) {
                    DiagLog("[WstpReader] re-spin TIMEOUT after " + std::to_string(iters2)
                            + " iters");
                    result_ = WExpr::mkError("WstpReader: 5-second timeout after WSTKEND skip");
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            result_ = ReadExprRaw(lp_);
        }

        // After a successful expression read, advance past the expression
        // boundary so the next WSGetType() call sees the next expression's
        // start marker rather than a residual WSTKEND.
        if (result_.kind != WExpr::WError)
            WSNewPacket(lp_);

        DiagLog("[WstpReader] ReadExprRaw kind=" + std::to_string((int)result_.kind)
                + (result_.kind == WExpr::WError ? " err=" + result_.strVal : ""));
   }

    void OnOK() override {
        Napi::Env env = Env();
        if (result_.kind == WExpr::WError) {
            deferred_.Reject(Napi::Error::New(env, result_.strVal).Value());
            return;
        }
        Napi::Value v = WExprToNapi(env, result_);
        if (env.IsExceptionPending())
            deferred_.Reject(env.GetAndClearPendingException().Value());
        else
            deferred_.Resolve(v);
    }

    void OnError(const Napi::Error& e) override {
        deferred_.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred deferred_;
    WSLINK            lp_;
    std::atomic<bool>& activated_;
    WExpr             result_;
};

// ===========================================================================
// WstpReader — connects to a named WSTP link created by a Wolfram kernel.
//
// Usage pattern:
//   1. Main kernel:  $link = LinkCreate[LinkProtocol->"TCPIP"]
//                    linkName = LinkName[$link]   // → "port@host,0@host"
//   2. JS:           const reader = new WstpReader(linkName)
//   3. Loop:         while (reader.isOpen) { const v = await reader.readNext() }
//
// Each call to readNext() blocks (on the thread pool) until the next
// expression is available, then resolves with an ExprTree.
// When the kernel closes the link (LinkClose[$link]), readNext() rejects
// with a "link closed" error.
// ===========================================================================
class WstpReader : public Napi::ObjectWrap<WstpReader> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "WstpReader", {
            InstanceMethod<&WstpReader::ReadNext>("readNext"),
            InstanceMethod<&WstpReader::Close>   ("close"),
            InstanceAccessor<&WstpReader::IsOpen>("isOpen"),
        });
        exports.Set("WstpReader", func);
        return exports;
    }

    // -----------------------------------------------------------------------
    // Constructor  new WstpReader(linkName, protocol?)
    //   linkName  — value returned by Wolfram's LinkName[$link]
    //   protocol  — link protocol string, default "TCPIP"
    // -----------------------------------------------------------------------
    WstpReader(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<WstpReader>(info), wsEnv_(nullptr), lp_(nullptr), open_(false)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "WstpReader(linkName: string, protocol?: string)")
                .ThrowAsJavaScriptException();
            return;
        }
        std::string linkName = info[0].As<Napi::String>().Utf8Value();
        std::string protocol = "TCPIP";
        if (info.Length() >= 2 && info[1].IsString())
            protocol = info[1].As<Napi::String>().Utf8Value();

        WSEnvironmentParameter params = WSNewParameters(WSREVISION, WSAPIREVISION);
        wsEnv_ = WSInitialize(params);
        WSReleaseParameters(params);
        if (!wsEnv_) {
            Napi::Error::New(env, "WSInitialize failed (WstpReader)")
                .ThrowAsJavaScriptException();
            return;
        }

        // Connect to the already-listening link.
        const char* argv[] = {
            "reader",
            "-linkname",     linkName.c_str(),
            "-linkmode",     "connect",
            "-linkprotocol", protocol.c_str()
        };
        int err = 0;
        lp_ = WSOpenArgcArgv(wsEnv_, 7, const_cast<char**>(argv), &err);
        if (!lp_ || err != WSEOK) {
            std::string msg = "WstpReader: WSOpenArgcArgv failed (code "
                              + std::to_string(err) + ") for link \"" + linkName + "\"";
            WSDeinitialize(wsEnv_); wsEnv_ = nullptr;
            Napi::Error::New(env, msg).ThrowAsJavaScriptException();
            return;
        }

        // Do NOT call WSActivate here — it would block the JS main thread.
        // Activation is deferred to the first ReadNextWorker::Execute() call,
        // which runs on the libuv thread pool.  The kernel's WSTP runtime
        // completes the handshake once it enters the Do-loop and calls LinkWrite.
        open_ = true;
        activated_.store(false);
    }

    ~WstpReader() { CleanUp(); }

    // readNext() → Promise<ExprTree>
    Napi::Value ReadNext(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        if (!open_) {
            deferred.Reject(Napi::Error::New(env, "WstpReader is closed").Value());
            return deferred.Promise();
        }
        (new ReadNextWorker(deferred, lp_, activated_))->Queue();
        return deferred.Promise();
    }

    // close()
    Napi::Value Close(const Napi::CallbackInfo& info) {
        CleanUp();
        return info.Env().Undefined();
    }

    // isOpen
    Napi::Value IsOpen(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), open_);
    }

private:
    void CleanUp() {
        if (lp_)    { WSClose(lp_);           lp_    = nullptr; }
        if (wsEnv_) { WSDeinitialize(wsEnv_); wsEnv_ = nullptr; }
        open_ = false;
    }

    WSEnvironment     wsEnv_;
    WSLINK            lp_;
    bool              open_;
    std::atomic<bool> activated_{false};
};

// ===========================================================================
// setDiagHandler(fn) — JS-callable; registers the global diagnostic callback.
// Pass null / no argument to clear.  The TSFN is Unref()'d so it does not
// hold the Node.js event loop open.
// ===========================================================================
static Napi::Value SetDiagHandler(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lk(g_diagMutex);
    if (g_diagActive) {
        g_diagTsfn.Release();
        g_diagActive = false;
    }
    if (info.Length() >= 1 && info[0].IsFunction()) {
        g_diagTsfn = Napi::ThreadSafeFunction::New(
            env,
            info[0].As<Napi::Function>(),
            "diagHandler",
            /*maxQueueSize=*/0,
            /*initialThreadCount=*/1);
        g_diagTsfn.Unref(env);   // do not prevent process exit
        g_diagActive = true;
    }
    return env.Undefined();
}

// ===========================================================================
// Module entry point
// ===========================================================================
Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
    WstpSession::Init(env, exports);
    WstpReader::Init(env, exports);
    exports.Set("setDiagHandler",
        Napi::Function::New(env, SetDiagHandler, "setDiagHandler"));
    // version — mirrors package.json "version"; read-only string constant.
    exports.Set("version", Napi::String::New(env, "0.6.6"));
    return exports;
}

NODE_API_MODULE(wstp, InitModule)
