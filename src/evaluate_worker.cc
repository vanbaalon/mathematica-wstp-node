#include "evaluate_worker.h"
#include "diag.h"
#include "wstp_expr.h"
#include <thread>
#include <chrono>

EvaluateWorker::EvaluateWorker(Napi::Promise::Deferred       deferred,
                               WSLINK                        lp,
                               std::string                   expr,
                               EvalOptions                   opts,
                               std::atomic<bool>&            abortFlag,
                               std::atomic<bool>&            workerReadingLink,
                               std::function<void()>         completionCb,
                               int64_t                       cellIndex,
                               bool                          interactive)
    : Napi::AsyncWorker(deferred.Env()),
      deferred_(std::move(deferred)),
      lp_(lp),
      expr_(std::move(expr)),
      opts_(std::move(opts)),
      abortFlag_(abortFlag),
      workerReadingLink_(workerReadingLink),
      completionCb_(std::move(completionCb)),
      cellIndex_(cellIndex),
      interactive_(interactive)
{}

// ---- thread-pool thread: send packet; block until response ----
void EvaluateWorker::Execute() {
    DiagLog("[Eval] Execute() start — expr=" + expr_.substr(0, 40));
    // ---- Pre-eval drain: consume stale packets on the link --------
    // If an interrupt was sent just as the previous eval completed,
    // the kernel may have opened a Dialog[] (via the interrupt handler)
    // while idle.  The resulting BEGINDLGPKT sits unread on the link.
    // Without draining it first, our EvaluatePacket is processed inside
    // the stale Dialog context and its RETURNPKT is consumed during the
    // BEGINDLGPKT handler's drain — leaving the outer DrainToEvalResult
    // loop waiting forever for a RETURNPKT that was already eaten.
    // ── Active drain: if the timer sent an interrupt whose MENUPKT has
    // not been consumed yet, wait for it.  The MENUPKT may still be in
    // transit (kernel processing the interrupt handler), so poll with a
    // timeout.  This is the primary defense against stale MENUPKTs
    // leaking across evaluation boundaries.
    if (opts_.menuPktPending && opts_.menuPktPending->load()) {
        DiagLog("[Eval] pre-drain: menuPktPending — waiting for stale MENUPKT");
        auto waitDeadline = std::chrono::steady_clock::now() +
                            std::chrono::seconds(3);
        while (opts_.menuPktPending->load() &&
               std::chrono::steady_clock::now() < waitDeadline) {
            if (WSReady(lp_)) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        if (opts_.menuPktPending->load() && !WSReady(lp_)) {
            DiagLog("[Eval] pre-drain: menuPktPending still true after 3 s — force-clearing");
            opts_.menuPktPending->store(false);
        }
    }
    if (WSReady(lp_)) {
        DiagLog("[Eval] pre-eval: stale data on link — draining");
        drainStalePackets(lp_, &opts_);
    }

    // Dynamic polling is handled entirely by the C++ timer thread
    // (wstp_session.cc dynTimerThread_) which sends WSInterruptMessage
    // only while busy_ == true.  No kernel-level ScheduledTask needed.
    std::string sendExpr = expr_;

    DiagLog("[Eval] about to send " + std::string(interactive_ ? "EnterExpressionPacket" : "EvaluatePacket")
            + " expr=" + sendExpr.substr(0, 60));
    bool sent;
    if (!interactive_) {
        sent = WSPutFunction(lp_, "EvaluatePacket", 1) &&
               WSPutFunction(lp_, "ToExpression",   1) &&
               WSPutUTF8String(lp_, (const unsigned char *)sendExpr.c_str(), (int)sendExpr.size()) &&
               WSEndPacket  (lp_)                      &&
               WSFlush      (lp_);
    } else {
        sent = WSPutFunction(lp_, "EnterExpressionPacket", 1) &&
               WSPutFunction(lp_, "ToExpression",          1) &&
               WSPutUTF8String(lp_, (const unsigned char *)sendExpr.c_str(), (int)sendExpr.size()) &&
               WSEndPacket  (lp_)                             &&
               WSFlush      (lp_);
    }
    DiagLog("[Eval] send result: sent=" + std::to_string(sent));
    if (!sent) {
        workerReadingLink_.store(false, std::memory_order_release);
        SetError("Failed to send packet to kernel");
    } else {
        opts_.interactive = interactive_;
        DiagLog("[Eval] entering DrainToEvalResult");
        result_ = DrainToEvalResult(lp_, &opts_);
        if (opts_.dialogOpen) opts_.dialogOpen->store(false);

        workerReadingLink_.store(false, std::memory_order_release);
        if (!interactive_) {
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
void EvaluateWorker::OnOK() {
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

void EvaluateWorker::OnError(const Napi::Error& e) {
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
