#include "evaluate_worker.h"
#include "diag.h"
#include "wstp_expr.h"

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
    if (WSReady(lp_)) {
        DiagLog("[Eval] pre-eval: stale data on link — draining");
        drainStalePackets(lp_, nullptr);
    }

    // ---- Phase 2: ScheduledTask[Dialog[], interval] management ----
    DiagLog("[Eval] phase2 check: dynAutoMode=" + std::to_string(opts_.dynAutoMode)
            + " dynIntervalMs=" + std::to_string(opts_.dynIntervalMs));
    if (opts_.dynAutoMode && opts_.dynIntervalMs > 0) {
        bool hasRegs = false;
        if (opts_.dynMutex && opts_.dynRegistry) {
            std::lock_guard<std::mutex> lk(*opts_.dynMutex);
            hasRegs = !opts_.dynRegistry->empty();
        }
        if (!hasRegs && opts_.autoMutex && opts_.autoExprQueue) {
            std::lock_guard<std::mutex> lk(*opts_.autoMutex);
            hasRegs = !opts_.autoExprQueue->empty();
        }

        int installedInterval = opts_.dynTaskInstalledInterval
                              ? *opts_.dynTaskInstalledInterval : 0;
        bool needInstall = hasRegs && (installedInterval != opts_.dynIntervalMs);

        if (needInstall) {
            double intervalSec = opts_.dynIntervalMs / 1000.0;
            // $wstpDynTaskStop stays True — the ScheduledTask is
            // initially suppressed.  Phase 3's "$wstpDynTaskStop=.;"
            // unsuppresses it only once the kernel is evaluating the
            // main expression, avoiding a race where Dialog[] fires
            // before the kernel reads the main EvaluatePacket.
            std::string taskExpr =
                "Quiet[$wstpDynTaskStop = True;"
                " If[ValueQ[$wstpDynTask], RemoveScheduledTask[$wstpDynTask]];"
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
                if (opts_.dynTaskInstalledInterval)
                    *opts_.dynTaskInstalledInterval = opts_.dynIntervalMs;
            }
        }
    }

    // ---- ScheduledTask Dialog[] suppression ----
    int installedTask = opts_.dynTaskInstalledInterval
                      ? *opts_.dynTaskInstalledInterval : 0;
    DiagLog("[Eval] suppress check: installedTask=" + std::to_string(installedTask));
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
