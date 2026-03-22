#pragma once

#include <napi.h>

#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <unordered_map>
#include <vector>

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
    bool         rejectDialog      = false;
    // Phase 2 Dynamic eval: pointers wired up by Evaluate() so DrainToEvalResult
    // can inline-evaluate registered Dynamic expressions inside BEGINDLGPKT.
    std::mutex*                       dynMutex       = nullptr;
    std::vector<DynRegistration>*     dynRegistry    = nullptr;  // non-owning
    std::vector<DynResult>*           dynResults     = nullptr;  // non-owning
    std::chrono::steady_clock::time_point* dynLastEval = nullptr;
    bool         dynAutoMode       = true;   // mirrors dynAutoMode_ at time of queue dispatch
    int          dynIntervalMs     = 0;      // mirrors dynIntervalMs_ at time of queue dispatch
    int*         dynTaskInstalledInterval = nullptr; // non-owning; tracks installed ScheduledTask interval
    // subAuto() — one-shot inline Dialog[] evaluations.
    std::mutex*                       autoMutex        = nullptr;
    std::deque<AutoExprEntry>*        autoExprQueue    = nullptr;
    std::vector<AutoResultEntry>*     autoCompleted    = nullptr;
    Napi::ThreadSafeFunction*         autoResolverTsfn = nullptr;
    std::atomic<bool>*                autoTsfnActive   = nullptr;
    CompleteCtx* ctx               = nullptr;  // non-owning; set when TSFNs are in use

    // Pointers to session's dialog queue — set by WstpSession::Evaluate() so the
    // drain loop can service dialogEval() requests from the thread pool.
    std::mutex*               dialogMutex   = nullptr;
    std::queue<DialogRequest>* dialogQueue  = nullptr;
    std::atomic<bool>*         dialogPending = nullptr;
    std::atomic<bool>*         dialogOpen    = nullptr;
    // Session-level abort flag — set by abort() on the main thread; checked in
    // the dialog inner loop to break out proactively when abort() is called.
    std::atomic<bool>*         abortFlag     = nullptr;
    // Link-dead flag — set by DrainToEvalResult on pkt=0; early-rejects
    // future evaluate/sub/subAuto calls without touching the broken link.
    std::atomic<bool>*         linkDead      = nullptr;
    // Interrupt pending flag — set by StartDynTimer when WSInterruptMessage sent,
    // cleared by MENUPKT handler after responding.  Prevents runaway interrupts.
    std::atomic<bool>*         interruptPending = nullptr;
};
