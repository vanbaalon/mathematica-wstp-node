// =============================================================================
// wstp-backend/src/addon.cc   (v6 — dialog subsession support)
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
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
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
                auto dc = text.find("::");
                if (dc != std::string::npos) {
                    auto nl_before = text.rfind(NL, dc);
                    size_t start = (nl_before != std::string::npos) ? nl_before + 4 : 0;
                    auto nl_after = text.find(NL, dc);
                    size_t end = (nl_after != std::string::npos) ? nl_after : text.size();
                    while (start < end && text[start] == ' ') ++start;
                    msg = text.substr(start, end - start);
                } else {
                    for (size_t i = 0; i < text.size(); ) {
                        if (text.compare(i, 4, NL) == 0) { msg += ' '; i += 4; }
                        else { msg += text[i++]; }
                    }
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
    // Sends EvaluatePacket, drains until RETURNPKT (or ENDDLGPKT if the
    // evaluated expression exits the dialog, e.g. Return[]).
    // Returns true  → dialog still open, continue inner loop.
    // Returns false → ENDDLGPKT arrived while handling this request;
    //                 the caller (dialog inner loop) must exit.
    // -----------------------------------------------------------------------
    auto serviceDialogRequest = [&]() -> bool {
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
        // EvaluatePacket  — for regular evaluations (Return[] is unevaluated at top level)
        // EnterTextPacket — for exit expressions (Return[] recognised in interactive context)
        bool sent;
        if (!req.useEnterText) {
            sent = WSPutFunction(lp, "EvaluatePacket", 1) &&
                   WSPutFunction(lp, "ToExpression",   1) &&
                   WSPutString  (lp, req.expr.c_str())    &&
                   WSEndPacket  (lp)                      &&
                   WSFlush      (lp);
        } else {
            sent = WSPutFunction(lp, "EnterTextPacket", 1) &&
                   WSPutString  (lp, req.expr.c_str())      &&
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
        // Read response packets until RETURNPKT or ENDDLGPKT.
        WExpr result;
        bool dialogEndedHere = false;
        while (true) {
            int p2 = WSNextPacket(lp);
            if (p2 == RETURNPKT) {
                result = ReadExprRaw(lp);
                WSNewPacket(lp);
                break;
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
                    if (opts->hasOnDialogPrint)
                        opts->onDialogPrint.NonBlockingCall(
                            [line](Napi::Env e, Napi::Function cb){
                                cb.Call({Napi::String::New(e, line)}); });
                }
                WSNewPacket(lp); continue;
            }
            if (p2 == INPUTNAMEPKT || p2 == OUTPUTNAMEPKT) { WSNewPacket(lp); continue; }
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
    while (true) {
        int pkt = WSNextPacket(lp);
        DiagLog("[Eval] pkt=" + std::to_string(pkt));

        if (pkt == RETURNPKT) {
            r.result = ReadExprRaw(lp);
            WSNewPacket(lp);
            if (r.result.kind == WExpr::Symbol && stripCtx(r.result.strVal) == "$Aborted")
                r.aborted = true;
            break;
        }
        else if (pkt == INPUTNAMEPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) { r.cellIndex = parseCellIndex(s); WSReleaseString(lp, s); }
            WSNewPacket(lp);
        }
        else if (pkt == OUTPUTNAMEPKT) {
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) { r.outputName = s; WSReleaseString(lp, s); }
            WSNewPacket(lp);
        }
        else if (pkt == TEXTPKT) {
            DiagLog("[Eval] TEXTPKT");
            const char* s = nullptr; WSGetString(lp, &s);
            if (s) {
                std::string line = rtrimNL(s);
                WSReleaseString(lp, s);
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
            // Read the dialog level integer, set dialogOpen_ flag, fire callback.
            // ----------------------------------------------------------------
            wsint64 level = 0;
            if (WSGetType(lp) == WSTKINT) WSGetInteger64(lp, &level);
            WSNewPacket(lp);

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
                if (opts && opts->abortFlag && opts->abortFlag->load()) {
                    if (opts->dialogOpen) opts->dialogOpen->store(false);
                    r.result = WExpr::mkSymbol("System`$Aborted");
                    r.aborted = true;
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
                   std::function<void()>         completionCb,
                   int64_t                       cellIndex)
        : Napi::AsyncWorker(deferred.Env()),
          deferred_(std::move(deferred)),
          lp_(lp),
          expr_(std::move(expr)),
          opts_(std::move(opts)),
          abortFlag_(abortFlag),
          completionCb_(std::move(completionCb)),
          cellIndex_(cellIndex)
    {}

    // ---- thread-pool thread: send packet; block until response ----
    void Execute() override {
        if (!WSPutFunction(lp_, "EvaluatePacket", 1) ||
            !WSPutFunction(lp_, "ToExpression",   1) ||
            !WSPutString(lp_, expr_.c_str())         ||
            !WSEndPacket(lp_)                        ||
            !WSFlush(lp_)) {
            SetError("Failed to send EvaluatePacket to kernel");
        } else {
            result_ = DrainToEvalResult(lp_, &opts_);
            // Stamp the cell index we pre-captured before queuing.
            result_.cellIndex = cellIndex_;
            // Derive outputName: "Out[n]=" unless result is Null or aborted.
            // EvaluatePacket never sends OutputNamePacket, so we compute it.
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
    std::function<void()>    completionCb_;
    int64_t                  cellIndex_;
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
            InstanceMethod<&WstpSession::DialogEval>      ("dialogEval"),
            InstanceMethod<&WstpSession::ExitDialog>      ("exitDialog"),
            InstanceMethod<&WstpSession::Interrupt>       ("interrupt"),
            InstanceMethod<&WstpSession::Abort>           ("abort"),
            InstanceMethod<&WstpSession::CreateSubsession>("createSubsession"),
            InstanceMethod<&WstpSession::Close>           ("close"),
            InstanceAccessor<&WstpSession::IsOpen>        ("isOpen"),
            InstanceAccessor<&WstpSession::IsDialogOpen>  ("isDialogOpen"),
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
                if (kernelPid_ > 0) { kill(kernelPid_, SIGTERM); kernelPid_ = 0; }
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
        //                                    onDialogPrint?, onDialogEnd? }
        EvalOptions opts;
        if (info.Length() >= 2 && info[1].IsObject()) {
            auto optsObj = info[1].As<Napi::Object>();
            bool wantPrint  = optsObj.Has("onPrint")        && optsObj.Get("onPrint").IsFunction();
            bool wantMsg    = optsObj.Has("onMessage")      && optsObj.Get("onMessage").IsFunction();
            bool wantDBegin = optsObj.Has("onDialogBegin")  && optsObj.Get("onDialogBegin").IsFunction();
            bool wantDPrint = optsObj.Has("onDialogPrint")  && optsObj.Get("onDialogPrint").IsFunction();
            bool wantDEnd   = optsObj.Has("onDialogEnd")    && optsObj.Get("onDialogEnd").IsFunction();

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

        {
            std::lock_guard<std::mutex> lk(queueMutex_);
            queue_.push(QueuedEval{ std::move(expr), std::move(opts), std::move(deferred) });
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
            busy_.store(false);
            return;
        }
        auto item = std::move(queue_.front());
        queue_.pop();
        lk.unlock();

        auto* worker = new EvaluateWorker(
            std::move(item.deferred),
            lp_,
            std::move(item.expr),
            std::move(item.opts),
            abortFlag_,
            [this]() { busy_.store(false); MaybeStartNext(); },
            nextLine_.fetch_add(1)
        );
        worker->Queue();
    }

    // Launch a lightweight EvaluateWorker that resolves with just the WExpr
    // (not a full EvalResult) — used by sub() when the session is idle.
    void StartSubIdleWorker(QueuedSubIdle item) {
        struct SubIdleWorker : public Napi::AsyncWorker {
            SubIdleWorker(Napi::Promise::Deferred d, WSLINK lp, std::string expr,
                          std::function<void()> done)
                : Napi::AsyncWorker(d.Env()),
                  deferred_(std::move(d)), lp_(lp), expr_(std::move(expr)),
                  done_(std::move(done)) {}

            void Execute() override {
                if (!WSPutFunction(lp_, "EvaluatePacket", 1) ||
                    !WSPutFunction(lp_, "ToExpression",   1) ||
                    !WSPutString(lp_, expr_.c_str())         ||
                    !WSEndPacket(lp_)                        ||
                    !WSFlush(lp_)) {
                    SetError("sub (idle): failed to send EvaluatePacket");
                    return;
                }
                result_ = DrainToEvalResult(lp_);
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
            std::function<void()>   done_;
            EvalResult              result_;
        };

        (new SubIdleWorker(std::move(item.deferred), lp_, std::move(item.expr),
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
    // abort() — interrupt the currently running evaluation.
    //
    // Sends WSAbortMessage on the link.  Per the WSTP spec WSPutMessage() is
    // thread-safe and will cause WSNextPacket() on the thread-pool thread to
    // return ILLEGALPKT (link reset).  The promise then rejects; a fresh
    // session must be created for further work after the kernel crashes/exits.
    //
    // For a softer (recoverable) interrupt use  evaluate("Interrupt[]")
    // before the long computation, or wrap the computation in TimeConstrained.
    // -----------------------------------------------------------------------
    Napi::Value Abort(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (!open_) return Napi::Boolean::New(env, false);
        abortFlag_.store(true);
        int ok = WSPutMessage(lp_, WSAbortMessage);
        return Napi::Boolean::New(env, ok != 0);
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

private:
    // Queue entry — one pending evaluate() call.
    struct QueuedEval {
        std::string             expr;
        EvalOptions             opts;
        Napi::Promise::Deferred deferred;
    };

    void CleanUp() {
        if (lp_)    { WSClose(lp_);           lp_    = nullptr; }
        if (wsEnv_) { WSDeinitialize(wsEnv_); wsEnv_ = nullptr; }
        // Kill the child kernel process so it doesn't become a zombie.
        // WSClose() closes the link but does not terminate the WolframKernel
        // child process — without this, each session leaks a kernel.
        if (kernelPid_ > 0) { kill(kernelPid_, SIGTERM); kernelPid_ = 0; }
        open_ = false;
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
    pid_t                       kernelPid_  = 0;  // child process — killed on CleanUp
    std::atomic<int64_t>        nextLine_{1};      // 1-based In[n] counter for EvalResult.cellIndex
    std::atomic<bool>           abortFlag_{false};
    std::atomic<bool>           busy_{false};
    std::mutex                  queueMutex_;
    std::queue<QueuedEval>      queue_;
    std::queue<QueuedSubIdle>   subIdleQueue_;    // sub() — runs before queue_ items
    // Dialog subsession state — written on main thread, consumed on thread pool
    std::mutex                  dialogMutex_;
    std::queue<DialogRequest>   dialogQueue_;     // dialogEval() requests
    std::atomic<bool>           dialogPending_{false};
    std::atomic<bool>           dialogOpen_{false};
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
    return exports;
}

NODE_API_MODULE(wstp, InitModule)
