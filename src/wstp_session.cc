#include "wstp_session.h"
#include "kernel_state.h"
#include "diag.h"
#include "drain.h"
#include "wstp_expr.h"

#include <chrono>
#include <signal.h>
#include <sys/types.h>
#include <thread>

#ifdef _WIN32
#  include <windows.h>
#  ifndef SIGTERM
#    define SIGTERM 15
#  endif
#  ifndef SIGKILL
#    define SIGKILL 9
#  endif
// On Windows, kill() doesn't exist — use TerminateProcess instead.
static int kill(pid_t pid, int /*sig*/) {
    HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
    if (!h) return -1;
    BOOL ok = TerminateProcess(h, 1);
    CloseHandle(h);
    return ok ? 0 : -1;
}
#endif

static const char* kDefaultKernel =
    "/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
Napi::Object WstpSession::Init(Napi::Env env, Napi::Object exports) {
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
        InstanceMethod<&WstpSession::RegisterDynamic>     ("registerDynamic"),
        InstanceMethod<&WstpSession::UnregisterDynamic>   ("unregisterDynamic"),
        InstanceMethod<&WstpSession::ClearDynamicRegistry>("clearDynamicRegistry"),
        InstanceMethod<&WstpSession::GetDynamicResults>   ("getDynamicResults"),
        InstanceMethod<&WstpSession::SetDynamicInterval>  ("setDynamicInterval"),
        InstanceMethod<&WstpSession::SetDynAutoMode>      ("setDynAutoMode"),
        InstanceAccessor<&WstpSession::IsOpen>        ("isOpen"),
        InstanceAccessor<&WstpSession::IsDialogOpen>  ("isDialogOpen"),
        InstanceAccessor<&WstpSession::IsReady>       ("isReady"),
        InstanceAccessor<&WstpSession::IsLinkDead>    ("isLinkDead"),
        InstanceAccessor<&WstpSession::KernelPid>     ("kernelPid"),
        InstanceAccessor<&WstpSession::DynamicActive>      ("dynamicActive"),
        InstanceAccessor<&WstpSession::GetKernelStateName> ("kernelState"),
    });

    Napi::FunctionReference* ctor = new Napi::FunctionReference();
    *ctor = Napi::Persistent(func);
    env.SetInstanceData(ctor);

    exports.Set("WstpSession", func);
    return exports;
}

// ---------------------------------------------------------------------------
// Constructor  new WstpSession(kernelPath?)
// ---------------------------------------------------------------------------
WstpSession::WstpSession(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WstpSession>(info), wsEnv_(nullptr), lp_(nullptr), open_(false)
{
    Napi::Env env = info.Env();

    std::string kernelPath = kDefaultKernel;
    if (info.Length() > 0 && info[0].IsString())
        kernelPath = info[0].As<Napi::String>().Utf8Value();

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

    std::string linkName = "\"" + kernelPath + "\" -wstp";
    const char* argv[] = { "wstp", "-linkname", linkName.c_str(),
                                    "-linkmode",  "launch" };

    int err = 0;
    for (int attempt = 0; attempt <= 2; ++attempt) {
        if (attempt > 0) {
            DiagLog("[Session] restart attempt " + std::to_string(attempt) +
                    " — $Output routing broken on previous kernel");
            WSClose(lp_);           lp_       = nullptr;
            if (kernelPid_ > 0 && !kernelKilled_) { kernelKilled_ = true; kill(kernelPid_, SIGTERM); }
            kernelKilled_ = false;
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

        kernelPid_ = FetchKernelPid(lp_);

        if (WarmUpOutputRouting(lp_)) break;

        if (attempt == 2)
            DiagLog("[Session] WARNING: $Output broken after 3 kernel launches");
    }

    open_ = true;
    abortFlag_.store(false);
}

WstpSession::~WstpSession() { CleanUp(); }

// ---------------------------------------------------------------------------
// evaluate(expr, opts?) → Promise<EvalResult>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::Evaluate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise  = deferred.Promise();

    if (!open_) {
        deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
        return promise;
    }
    if (linkDead_.load()) {
        deferred.Reject(Napi::Error::New(env, "WSTP link is dead").Value());
        return promise;
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        deferred.Reject(Napi::TypeError::New(env, "evaluate(expr: string, opts?: object)").Value());
        return promise;
    }

    std::string expr = info[0].As<Napi::String>().Utf8Value();

    EvalOptions opts;
    int interactiveOverride = -1;
    if (info.Length() >= 2 && info[1].IsObject()) {
        auto optsObj = info[1].As<Napi::Object>();
        bool wantPrint  = optsObj.Has("onPrint")        && optsObj.Get("onPrint").IsFunction();
        bool wantMsg    = optsObj.Has("onMessage")      && optsObj.Get("onMessage").IsFunction();
        bool wantDBegin = optsObj.Has("onDialogBegin")  && optsObj.Get("onDialogBegin").IsFunction();
        bool wantDPrint = optsObj.Has("onDialogPrint")  && optsObj.Get("onDialogPrint").IsFunction();
        bool wantDEnd   = optsObj.Has("onDialogEnd")    && optsObj.Get("onDialogEnd").IsFunction();
        if (optsObj.Has("interactive") && optsObj.Get("interactive").IsBoolean())
            interactiveOverride = optsObj.Get("interactive").As<Napi::Boolean>().Value() ? 1 : 0;
        if (optsObj.Has("rejectDialog") && optsObj.Get("rejectDialog").IsBoolean() &&
            optsObj.Get("rejectDialog").As<Napi::Boolean>().Value())
            opts.rejectDialog = true;

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
    opts.dialogMutex   = &dialogMutex_;
    opts.dialogQueue   = &dialogQueue_;
    opts.dialogPending = &dialogPending_;
    opts.dialogOpen    = &dialogOpen_;
    opts.menuPktPending = &menuPktPending_;
    opts.abortFlag     = &abortFlag_;
    opts.linkDead      = &linkDead_;
    opts.kernelStatus  = &ks_;
    opts.dynMutex      = &dynMutex_;
    opts.dynRegistry   = &dynRegistry_;
    opts.dynResults    = &dynResults_;
    opts.dynLastEval   = &dynLastEval_;
    opts.dynAutoMode   = dynAutoMode_.load();
    opts.dynIntervalMs = dynIntervalMs_.load();
    opts.dynTaskInstalledInterval = &dynTaskInstalledInterval_;
    opts.autoMutex        = &autoMutex_;
    opts.autoExprQueue    = &autoExprQueue_;
    opts.autoCompleted    = &autoCompleted_;
    opts.autoResolverTsfn = &autoResolverTsfn_;
    opts.autoTsfnActive   = &autoTsfnActive_;
    opts.sentLog          = &dynSentLog_;

    {
        std::lock_guard<std::mutex> lk(queueMutex_);
        queue_.push(QueuedEval{ std::move(expr), std::move(opts), std::move(deferred), interactiveOverride });
    }
    DiagLog("[Session] Evaluate: queued, busy=" + std::to_string(busy_.load()) +
            " linkDead=" + std::to_string(linkDead_.load()));
    MaybeStartNext();
    return promise;
}

// ---------------------------------------------------------------------------
// MaybeStartNext — pop the front of the queue and launch it.
// ---------------------------------------------------------------------------
void WstpSession::MaybeStartNext() {
    bool expected = false;
    if (!busy_.compare_exchange_strong(expected, true)) {
        DiagLog("[Session] MaybeStartNext: busy CAS failed");
        return;
    }
    DiagLog("[Session] MaybeStartNext: acquired busy lock");

    std::unique_lock<std::mutex> lk(queueMutex_);
    DiagLog("[Session] queues: subIdle=" + std::to_string(subIdleQueue_.size()) +
            " main=" + std::to_string(queue_.size()) +
            " whenIdle=" + std::to_string(whenIdleQueue_.size()));

    if (!subIdleQueue_.empty()) {
        auto item = std::move(subIdleQueue_.front());
        subIdleQueue_.pop();
        lk.unlock();
        SetActivity(ks_, Activity::SubIdle, "MaybeStartNext:subIdle");
        StartSubIdleWorker(std::move(item));
        return;
    }

    if (queue_.empty()) {
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
            SetActivity(ks_, Activity::WhenIdle, "MaybeStartNext:whenIdle");
            StartWhenIdleWorker(std::move(wiItem));
            return;
        }
        busy_.store(false);
        SetActivity(ks_, Activity::Idle, "MaybeStartNext:allEmpty");
        return;
    }
    auto item = std::move(queue_.front());
    queue_.pop();
    lk.unlock();

    DiagLog("[Session] MaybeStartNext: starting EvaluateWorker expr=" +
            item.expr.substr(0, 40));
    bool evalInteractive = (item.interactiveOverride == -1)
                            ? interactiveMode_
                            : (item.interactiveOverride == 1);
    SetActivity(ks_, Activity::Eval, "MaybeStartNext:eval");
    evalActive_.store(true);
    workerReadingLink_.store(true, std::memory_order_release);
    auto* worker = new EvaluateWorker(
        std::move(item.deferred),
        lp_,
        std::move(item.expr),
        std::move(item.opts),
        abortFlag_,
        workerReadingLink_,
        [this]() { evalActive_.store(false); PromoteAutoToWhenIdle(); SetActivity(ks_, Activity::Idle, "EvalWorker:done"); SetAbort(ks_, AbortState::None, "EvalWorker:done"); busy_.store(false); MaybeStartNext(); },
        nextLine_.fetch_add(1),
        evalInteractive
    );
    worker->Queue();
    DiagLog("[Session] MaybeStartNext: worker queued");
}

// ---------------------------------------------------------------------------
// StartSubIdleWorker
// ---------------------------------------------------------------------------
void WstpSession::StartSubIdleWorker(QueuedSubIdle item) {
    if (dynTaskInstalledInterval_ > 0) {
        item.expr = "Quiet["
                    "If[ValueQ[$wstpDynTask],RemoveScheduledTask[$wstpDynTask]];"
                    "$wstpDynTask=.];" + item.expr;
        dynTaskInstalledInterval_ = 0;
        DiagLog("[sub-idle] prepending ScheduledTask stop");
    }
    struct SubIdleWorker : public Napi::AsyncWorker {
        SubIdleWorker(Napi::Promise::Deferred d, WSLINK lp, std::string expr,
                      std::atomic<bool>& workerReadingLink,
                      std::function<void()> done)
            : Napi::AsyncWorker(d.Env()),
              deferred_(std::move(d)), lp_(lp), expr_(std::move(expr)),
              workerReadingLink_(workerReadingLink), done_(std::move(done)) {}

        void Execute() override {
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
            // rejectDialog: stale timer interrupts should not abort idle evals
            EvalOptions idleOpts;
            idleOpts.rejectDialog = true;
            result_ = DrainToEvalResult(lp_, &idleOpts);
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
    (new SubIdleWorker(std::move(item.deferred), lp_, std::move(item.expr),
                       workerReadingLink_,
                       [this]() { PromoteAutoToWhenIdle(); SetActivity(ks_, Activity::Idle, "SubIdleWorker:done"); busy_.store(false); MaybeStartNext(); }))->Queue();
}

// ---------------------------------------------------------------------------
// StartWhenIdleWorker
// ---------------------------------------------------------------------------
void WstpSession::StartWhenIdleWorker(QueuedWhenIdle item) {
    bool hadTask = (dynTaskInstalledInterval_ > 0);
    if (hadTask) {
        dynTaskInstalledInterval_ = 0;
        DiagLog("[when-idle] will remove ScheduledTask (close-while-idle approach)");
    }
    // Suppress the timer thread during idle eval — it would send
    // WSInterruptMessage (because busy_=true and dynRegistry not empty)
    // which interferes with the eval.
    dynIntervalMs_.store(0);
    struct WhenIdleWorker : public Napi::AsyncWorker {
        WhenIdleWorker(Napi::Promise::Deferred d, WSLINK lp,
                       bool needStop, std::string expr,
                       std::atomic<bool>& workerReadingLink,
                       std::function<void()> done)
            : Napi::AsyncWorker(d.Env()),
              deferred_(std::move(d)), lp_(lp),
              needStop_(needStop), expr_(std::move(expr)),
              workerReadingLink_(workerReadingLink), done_(std::move(done)) {}

        // Close any stale dialog that opened while the kernel was idle.
        // No kernel-level flags needed — just close with Return[$Failed].
        void closeStaleDialogs() {
            auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(500);
            while (std::chrono::steady_clock::now() < deadline) {
                if (!WSReady(lp_)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    continue;
                }
                int pkt = WSNextPacket(lp_);
                if (pkt == BEGINDLGPKT) {
                    wsint64 lvl = 0;
                    if (WSGetType(lp_) == WSTKINT) WSGetInteger64(lp_, &lvl);
                    WSNewPacket(lp_);
                    DiagLog("[when-idle] stale BEGINDLGPKT — closing");
                    // Wait for dialog's INPUTNAMEPKT
                    auto preDl = std::chrono::steady_clock::now() +
                                 std::chrono::milliseconds(500);
                    while (std::chrono::steady_clock::now() < preDl) {
                        if (!WSReady(lp_)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                            continue;
                        }
                        int ip = WSNextPacket(lp_);
                        WSNewPacket(lp_);
                        if (ip == INPUTNAMEPKT) break;
                        if (ip == 0 || ip == ILLEGALPKT) { WSClearError(lp_); return; }
                    }
                    // Close the dialog directly
                    const char* closeExpr = "Return[$Failed]";
                    WSPutFunction(lp_, "EnterTextPacket", 1);
                    WSPutUTF8String(lp_,
                        reinterpret_cast<const unsigned char*>(closeExpr),
                        static_cast<int>(std::strlen(closeExpr)));
                    WSEndPacket(lp_); WSFlush(lp_);
                    // Drain until ENDDLGPKT
                    auto bDl = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(2000);
                    while (std::chrono::steady_clock::now() < bDl) {
                        if (!WSReady(lp_)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                            continue;
                        }
                        int rp = WSNextPacket(lp_);
                        WSNewPacket(lp_);
                        if (rp == ENDDLGPKT) break;
                        if (rp == 0 || rp == ILLEGALPKT) { WSClearError(lp_); return; }
                    }
                    DiagLog("[when-idle] stale dialog closed");
                    // Reset the idle deadline — more stale data might follow
                    deadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(500);
                } else if (pkt == MENUPKT) {
                    wsint64 menuType = 0; WSGetInteger64(lp_, &menuType);
                    const char* prompt = nullptr; WSGetString(lp_, &prompt);
                    if (prompt) WSReleaseString(lp_, prompt);
                    WSNewPacket(lp_);
                    WSPutString(lp_, "a"); WSEndPacket(lp_); WSFlush(lp_);
                    deadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(500);
                } else {
                    WSNewPacket(lp_);
                    deadline = std::chrono::steady_clock::now() +
                               std::chrono::milliseconds(500);
                }
            }
        }

        void Execute() override {
            if (needStop_) {
                // --------------------------------------------------------
                // Phase A — remove ScheduledTask from inside its Dialog.
                //
                // The task fires Dialog[] every ~300ms even when the kernel
                // is idle.  We wait for the next BEGINDLGPKT, then send
                // RemoveScheduledTask + Return[$Failed] inside that dialog.
                // Once the task is removed, no more dialogs arrive.
                // --------------------------------------------------------
                DiagLog("[when-idle] phase A: waiting for ScheduledTask dialog");
                bool taskRemoved = false;
                auto deadline = std::chrono::steady_clock::now() +
                                std::chrono::milliseconds(2000);
                while (std::chrono::steady_clock::now() < deadline) {
                    if (!WSReady(lp_)) {
                        std::this_thread::sleep_for(
                            std::chrono::milliseconds(5));
                        continue;
                    }
                    int pkt = WSNextPacket(lp_);
                    DiagLog("[when-idle] phase A: pkt=" +
                            std::to_string(pkt));
                    if (pkt == BEGINDLGPKT) {
                        wsint64 lvl = 0;
                        if (WSGetType(lp_) == WSTKINT)
                            WSGetInteger64(lp_, &lvl);
                        WSNewPacket(lp_);
                        // Wait for INPUTNAMEPKT (dialog prompt)
                        {
                            auto pd = std::chrono::steady_clock::now() +
                                      std::chrono::milliseconds(500);
                            while (std::chrono::steady_clock::now() < pd) {
                                if (!WSReady(lp_)) {
                                    std::this_thread::sleep_for(
                                        std::chrono::milliseconds(2));
                                    continue;
                                }
                                int ipkt = WSNextPacket(lp_);
                                WSNewPacket(lp_);
                                if (ipkt == INPUTNAMEPKT) break;
                                if (ipkt == 0 || ipkt == ILLEGALPKT) {
                                    WSClearError(lp_); break;
                                }
                            }
                        }
                        // Stop task + close dialog in ONE EnterTextPacket.
                        // Wrapped in AbortProtect so a pending abort (from
                        // 'a' response to a prior MENUPKT) cannot prevent
                        // Return from executing.
                        std::string stopExpr =
                            "AbortProtect["
                            "Quiet[If[ValueQ[$wstpDynTask],"
                            "RemoveScheduledTask[$wstpDynTask]];"
                            "$wstpDynTask=.];"
                            "Return[$Failed]]";
                        WSPutFunction(lp_, "EnterTextPacket", 1);
                        WSPutUTF8String(lp_,
                            reinterpret_cast<const unsigned char*>(
                                stopExpr.c_str()),
                            static_cast<int>(stopExpr.size()));
                        WSEndPacket(lp_); WSFlush(lp_);
                        DiagLog("[when-idle] phase A: sent RemoveScheduledTask + Return inside dialog");
                        // Use a short timeout: the dialog may not send
                        // ENDDLGPKT due to interaction with pending abort.
                        // Phase B will work regardless.
                        drainUntilEndDialog(lp_, 500);
                        taskRemoved = true;
                        DiagLog("[when-idle] phase A: dialog closed, task removed");
                        break;
                    } else if (pkt == MENUPKT) {
                        // Stale interrupt from WSInterruptMessage.
                        // Respond 'a' (abort) — safe when kernel is idle.
                        wsint64 menuType = 0;
                        WSGetInteger64(lp_, &menuType);
                        const char* prompt = nullptr;
                        WSGetString(lp_, &prompt);
                        if (prompt) WSReleaseString(lp_, prompt);
                        WSNewPacket(lp_);
                        DiagLog("[when-idle] phase A: MENUPKT type=" +
                                std::to_string(menuType) +
                                " — responding 'a'");
                        WSPutString(lp_, "a");
                        WSEndPacket(lp_); WSFlush(lp_);
                        // Reset deadline — dialog should follow shortly.
                        deadline = std::chrono::steady_clock::now() +
                                   std::chrono::milliseconds(2000);
                    } else {
                        WSNewPacket(lp_);
                    }
                }
                if (!taskRemoved) {
                    DiagLog("[when-idle] phase A: no dialog found — "
                            "task may already be inactive");
                }
            } else {
                if (WSReady(lp_)) {
                    DiagLog("[when-idle] pre-eval: stale data — draining");
                    drainStalePackets(lp_, nullptr);
                }
                if (WSError(lp_) != WSEOK) {
                    DiagLog("[when-idle] pre-eval: clearing stale WSError=" +
                            std::to_string(WSError(lp_)));
                    WSClearError(lp_);
                }
            }

            // --------------------------------------------------------
            // Phase B — evaluate user expression on a clean link.
            // Prepend RemoveScheduledTask as defence in case Phase A
            // missed the task.  rejectDialog=true handles any stale
            // Dialog[] that slipped through.
            // --------------------------------------------------------
            std::string fullExpr;
            if (needStop_) {
                fullExpr = "Quiet["
                           "If[ValueQ[$wstpDynTask],RemoveScheduledTask[$wstpDynTask]];"
                           "$wstpDynTask=.];" + expr_;
            } else {
                fullExpr = expr_;
            }
            // Clear any link error left by Phase A's packet reading (e.g. on
            // Windows where INPUTNAMEPKT timing differs from macOS/Linux).
            if (WSError(lp_) != WSEOK) {
                DiagLog("[when-idle] phase B: clearing stale WSError=" +
                        std::to_string(WSError(lp_)) + " before EvaluatePacket");
                WSClearError(lp_);
            }
            DiagLog("[when-idle] phase B: sending EvaluatePacket");
            bool sendOk =
                WSPutFunction(lp_, "EvaluatePacket", 1) &&
                WSPutFunction(lp_, "ToExpression",   1) &&
                WSPutUTF8String(lp_, (const unsigned char *)fullExpr.c_str(), (int)fullExpr.size()) &&
                WSEndPacket(lp_) &&
                WSFlush(lp_);
            if (!sendOk) {
                workerReadingLink_.store(false, std::memory_order_release);
                SetError("subWhenIdle: failed to send EvaluatePacket");
                return;
            }
            EvalOptions idleOpts;
            idleOpts.rejectDialog = true;
            result_ = DrainToEvalResult(lp_, &idleOpts);
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
        bool                    needStop_;
        std::string             expr_;
        std::atomic<bool>&      workerReadingLink_;
        std::function<void()>   done_;
        EvalResult              result_;
    };

    workerReadingLink_.store(true, std::memory_order_release);
    (new WhenIdleWorker(std::move(item.deferred), lp_,
                        hadTask, std::move(item.expr),
                        workerReadingLink_,
                        [this]() {
                            DiagLog("[when-idle] done — promoting + next");
                            PromoteAutoToWhenIdle();
                            SetActivity(ks_, Activity::Idle, "WhenIdleWorker:done");
                            busy_.store(false);
                            DiagLog("[when-idle] whenIdleQ=" + std::to_string(whenIdleQueue_.size()) +
                                    " queue=" + std::to_string(queue_.size()));
                            MaybeStartNext();
                        }))->Queue();
}

// ---------------------------------------------------------------------------
// sub(expr) → Promise<WExpr>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::Sub(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise  = deferred.Promise();

    if (!open_) {
        deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
        return promise;
    }
    if (linkDead_.load()) {
        deferred.Reject(Napi::Error::New(env, "WSTP link is dead").Value());
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

// ---------------------------------------------------------------------------
// subWhenIdle(expr, opts?) → Promise<WExpr>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::SubWhenIdle(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise  = deferred.Promise();

    if (!open_) {
        deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
        return promise;
    }
    if (linkDead_.load()) {
        deferred.Reject(Napi::Error::New(env, "WSTP link is dead").Value());
        return promise;
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        deferred.Reject(Napi::TypeError::New(env,
            "subWhenIdle(expr: string, opts?: {timeout?: number})").Value());
        return promise;
    }
    std::string expr = info[0].As<Napi::String>().Utf8Value();

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

// ---------------------------------------------------------------------------
// subAuto(expr) → Promise<WExpr>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::SubAuto(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise  = deferred.Promise();

    if (!open_) {
        deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
        return promise;
    }
    if (linkDead_.load()) {
        deferred.Reject(Napi::Error::New(env, "WSTP link is dead").Value());
        return promise;
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        deferred.Reject(Napi::TypeError::New(env, "subAuto(expr: string)").Value());
        return promise;
    }
    std::string expr = info[0].As<Napi::String>().Utf8Value();

    if (!autoTsfnActive_.load()) {
        auto resolver = Napi::Function::New(env,
            [](const Napi::CallbackInfo& cbInfo) {
                auto* self = static_cast<WstpSession*>(cbInfo.Data());
                self->DrainAutoResults(cbInfo.Env());
            }, "autoResolver", this);
        autoResolverTsfn_ = Napi::ThreadSafeFunction::New(
            env, resolver, "subAutoResolver", 0, 1);
        autoResolverTsfn_.Unref(env);
        autoTsfnActive_.store(true);
    }

    if (!evalActive_.load()) {
        DiagLog("[subAuto] idle path for expr='" + expr + "'");
        {
            std::lock_guard<std::mutex> lk(queueMutex_);
            whenIdleQueue_.push(QueuedWhenIdle{
                std::move(expr), std::move(deferred),
                std::chrono::steady_clock::time_point::max() });
        }
        MaybeStartNext();
    } else {
        size_t id = autoNextId_.fetch_add(1);
        DiagLog("[subAuto] busy path id=" + std::to_string(id) +
                " expr='" + expr + "'");
        {
            std::lock_guard<std::mutex> lk(autoMutex_);
            autoExprQueue_.push_back({id, std::move(expr)});
        }
        autoDeferreds_.emplace(id, std::move(deferred));

        if (dynIntervalMs_.load() == 0) dynIntervalMs_.store(300);
        if (!dynTimerRunning_.load()) StartDynTimer();
    }
    return promise;
}

// ---------------------------------------------------------------------------
// DrainAutoResults — resolve pending subAuto deferreds on the main thread.
// ---------------------------------------------------------------------------
void WstpSession::DrainAutoResults(Napi::Env env) {
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

// ---------------------------------------------------------------------------
// PromoteAutoToWhenIdle
// ---------------------------------------------------------------------------
void WstpSession::PromoteAutoToWhenIdle() {
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

// ---------------------------------------------------------------------------
// exitDialog(retVal?) → Promise<void>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::ExitDialog(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise  = deferred.Promise();

    if (!open_) {
        deferred.Reject(Napi::Error::New(env, "Session is closed").Value());
        return promise;
    }
    if (!dialogOpen_.load()) {
        deferred.Reject(Napi::Error::New(env, "no dialog subsession is open").Value());
        return promise;
    }
    if (!busy_.load()) {
        FlushDialogQueueWithError("dialog closed: session idle");
        dialogOpen_.store(false);
        deferred.Resolve(env.Null());
        return promise;
    }
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

// ---------------------------------------------------------------------------
// dialogEval(expr) → Promise<WExpr>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::DialogEval(const Napi::CallbackInfo& info) {
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

    auto tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [deferred](const Napi::CallbackInfo& ci) mutable {
            Napi::Env e = ci.Env();
            if (ci.Length() > 0 && ci[0].IsObject()) {
                auto obj = ci[0].As<Napi::Object>();
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

// ---------------------------------------------------------------------------
// interrupt() → boolean
// ---------------------------------------------------------------------------
Napi::Value WstpSession::Interrupt(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!open_) return Napi::Boolean::New(env, false);
    int ok = WSPutMessage(lp_, WSInterruptMessage);
    return Napi::Boolean::New(env, ok != 0);
}

// ---------------------------------------------------------------------------
// registerDynamic(id, expr) → void
// ---------------------------------------------------------------------------
Napi::Value WstpSession::RegisterDynamic(const Napi::CallbackInfo& info) {
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

// ---------------------------------------------------------------------------
// unregisterDynamic(id) → void
// ---------------------------------------------------------------------------
Napi::Value WstpSession::UnregisterDynamic(const Napi::CallbackInfo& info) {
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

// ---------------------------------------------------------------------------
// clearDynamicRegistry() → void
// ---------------------------------------------------------------------------
Napi::Value WstpSession::ClearDynamicRegistry(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lk(dynMutex_);
    dynRegistry_.clear();
    dynResults_.clear();
    return info.Env().Undefined();
}

// ---------------------------------------------------------------------------
// getDynamicResults() → Record<string, DynResult>
// ---------------------------------------------------------------------------
Napi::Value WstpSession::GetDynamicResults(const Napi::CallbackInfo& info) {
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

// ---------------------------------------------------------------------------
// setDynamicInterval(ms) → void
// ---------------------------------------------------------------------------
Napi::Value WstpSession::SetDynamicInterval(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "setDynamicInterval(ms: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int ms = static_cast<int>(info[0].As<Napi::Number>().Int32Value());
    if (ms < 0) ms = 0;
    int prev = dynIntervalMs_.exchange(ms);
    dynAutoMode_.store(ms > 0);
    if (prev == 0 && ms > 0 && !dynTimerRunning_.load()) {
        StartDynTimer();
    }
    return env.Undefined();
}

// ---------------------------------------------------------------------------
// setDynAutoMode(auto) → void
// ---------------------------------------------------------------------------
Napi::Value WstpSession::SetDynAutoMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBoolean()) {
        Napi::TypeError::New(env, "setDynAutoMode(auto: boolean)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    bool newMode = info[0].As<Napi::Boolean>().Value();
    bool oldMode = dynAutoMode_.exchange(newMode);
    if (oldMode && !newMode) {
        dynIntervalMs_.store(0);
    }
    return env.Undefined();
}

// ---------------------------------------------------------------------------
// dynamicActive (accessor) → boolean
// ---------------------------------------------------------------------------
Napi::Value WstpSession::DynamicActive(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lk(dynMutex_);
    bool active = !dynRegistry_.empty() && dynIntervalMs_.load() > 0;
    return Napi::Boolean::New(info.Env(), active);
}

// ---------------------------------------------------------------------------
// abort() → boolean
// ---------------------------------------------------------------------------
Napi::Value WstpSession::Abort(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!open_) return Napi::Boolean::New(env, false);
    if (!busy_.load()) return Napi::Boolean::New(env, false);
    bool expected = false;
    if (!abortFlag_.compare_exchange_strong(expected, true))
        return Napi::Boolean::New(env, true);
    SetAbort(ks_, AbortState::Aborting, "Abort");
    FlushDialogQueueWithError("abort");
    dialogOpen_.store(false);
    if (GetLink(ks_) != LinkState::Alive) {
        DiagLog("[Abort] link dead — cannot send WSAbortMessage");
        return Napi::Boolean::New(env, false);
    }
    int ok = WSPutMessage(lp_, WSAbortMessage);
    return Napi::Boolean::New(env, ok != 0);
}

// ---------------------------------------------------------------------------
// closeAllDialogs() → boolean
// ---------------------------------------------------------------------------
Napi::Value WstpSession::CloseAllDialogs(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    bool wasOpen = dialogOpen_.load();
    FlushDialogQueueWithError("dialog closed by closeAllDialogs");
    dialogOpen_.store(false);
    return Napi::Boolean::New(env, wasOpen);
}

// ---------------------------------------------------------------------------
// createSubsession(kernelPath?) → WstpSession
// ---------------------------------------------------------------------------
Napi::Value WstpSession::CreateSubsession(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::FunctionReference* ctor = env.GetInstanceData<Napi::FunctionReference>();
    if (info.Length() > 0 && info[0].IsString())
        return ctor->New({ info[0] });
    return ctor->New({});
}

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------
Napi::Value WstpSession::Close(const Napi::CallbackInfo& info) {
    CleanUp();
    return info.Env().Undefined();
}

// Accessors
Napi::Value WstpSession::IsOpen(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), open_);
}
Napi::Value WstpSession::IsDialogOpen(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), dialogOpen_.load());
}
Napi::Value WstpSession::IsReady(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(),
        open_
        && !linkDead_.load(std::memory_order_relaxed)
        && !busy_.load(std::memory_order_relaxed)
        && !dialogOpen_.load(std::memory_order_relaxed)
        && queue_.empty()
        && subIdleQueue_.empty());
}
Napi::Value WstpSession::IsLinkDead(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), linkDead_.load());
}
Napi::Value WstpSession::KernelPid(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(kernelPid_));
}
Napi::Value WstpSession::GetKernelStateName(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), KernelStatusString(ks_));
}

// ---------------------------------------------------------------------------
// FlushDialogQueueWithError
// ---------------------------------------------------------------------------
void WstpSession::FlushDialogQueueWithError(const std::string& errMsg) {
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

// ---------------------------------------------------------------------------
// StartDynTimer
// ---------------------------------------------------------------------------
void WstpSession::StartDynTimer() {
    if (dynTimerRunning_.exchange(true)) return;
    if (dynTimerThread_.joinable()) dynTimerThread_.join();
    dynTimerThread_ = std::thread([this]() {
        while (open_) {
            int ms = dynIntervalMs_.load();
            if (ms <= 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
                continue;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(ms));
            if (!open_) break;
            if (!busy_.load()) continue;
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
            if (!hasDynRegs && !hasAutoEntries) continue;
            // In dynAutoMode the kernel's own ScheduledTask[Dialog[],…] opens
            // dialogs at each interval.  Sending WSInterruptMessage here would
            // race with an already-queued BEGINDLGPKT, leaving menuPktPending_
            // true for a dialog that has no MENUPKT → DialogSession pre-drain
            // hangs then the 'c' response closes the dialog prematurely.
            if (dynAutoMode_.load()) continue;
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - dynLastEval_).count();
            if (elapsed < dynIntervalMs_.load()) continue;

            if (workerReadingLink_.load() && !dialogOpen_.load()) {
                bool needInterrupt = (hasDynRegs || hasAutoEntries);
                if (needInterrupt && !menuPktPending_.exchange(true)) {
                    // Safeguard: verify state is safe before sending interrupt
                    if (GetLink(ks_) != LinkState::Alive) {
                        DiagLog("[DynTimer] Skip interrupt: link dead");
                        menuPktPending_.store(false);
                    } else if (GetAbort(ks_) != AbortState::None) {
                        DiagLog("[DynTimer] Skip interrupt: abort in progress");
                        menuPktPending_.store(false);
                    } else if (GetDialog(ks_) != DialogState::None) {
                        DiagLog("[DynTimer] Skip interrupt: dialog already open");
                        menuPktPending_.store(false);
                    } else {
                        dynSentLog_.append("SEND WSInterrupt");
                        WSPutMessage(lp_, WSInterruptMessage);
                    }
                }
            }
        }
        dynTimerRunning_.store(false);
    });
    dynTimerThread_.detach();
}

// ---------------------------------------------------------------------------
// CleanUp
// ---------------------------------------------------------------------------
void WstpSession::CleanUp() {
    dynIntervalMs_.store(0);
    dynTimerRunning_.store(false);
    linkDead_.store(false);

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

    {
        std::lock_guard<std::mutex> lk(queueMutex_);
        while (!whenIdleQueue_.empty()) {
            auto& wi = whenIdleQueue_.front();
            wi.deferred.Reject(
                Napi::Error::New(wi.deferred.Env(), "Session is closed").Value());
            whenIdleQueue_.pop();
        }
    }

    open_ = false;
    if (workerReadingLink_.load(std::memory_order_acquire) && lp_) {
        abortFlag_.store(true);
        SetAbort(ks_, AbortState::Aborting, "CleanUp");
        FlushDialogQueueWithError("session closed");
        dialogOpen_.store(false);
        WSPutMessage(lp_, WSAbortMessage);
        auto deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (workerReadingLink_.load(std::memory_order_acquire) &&
               std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        if (workerReadingLink_.load(std::memory_order_acquire) &&
            kernelPid_ > 0 && !kernelKilled_) {
            kernelKilled_ = true;
            kill(kernelPid_, SIGKILL);
            DiagLog("[CleanUp] SIGKILL pid " + std::to_string(kernelPid_) +
                    " — worker still reading after 2s");
            deadline = std::chrono::steady_clock::now() +
                       std::chrono::seconds(2);
            while (workerReadingLink_.load(std::memory_order_acquire) &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }
    if (lp_)    { WSClose(lp_);           lp_    = nullptr; }
    if (wsEnv_) { WSDeinitialize(wsEnv_); wsEnv_ = nullptr; }
    if (kernelPid_ > 0 && !kernelKilled_) { kernelKilled_ = true; kill(kernelPid_, SIGTERM); }
}

// ---------------------------------------------------------------------------
// WarmUpOutputRouting
// ---------------------------------------------------------------------------
bool WstpSession::WarmUpOutputRouting(WSLINK lp) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    for (int attempt = 0; attempt < 4; ++attempt) {
        if (attempt > 0)
            std::this_thread::sleep_for(std::chrono::milliseconds(200));

        if (!WSPutFunction(lp, "EvaluatePacket", 1) ||
            !WSPutFunction(lp, "Print",          1) ||
            !WSPutString  (lp, "$WARMUP$")          ||
            !WSEndPacket  (lp)                      ||
            !WSFlush      (lp))
            return false;

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
// FetchKernelPid
// ---------------------------------------------------------------------------
pid_t WstpSession::FetchKernelPid(WSLINK lp) {
    if (!WSPutFunction(lp, "EvaluatePacket", 1) ||
        !WSPutFunction(lp, "ToExpression",   1) ||
        !WSPutString  (lp, "$ProcessID")        ||
        !WSEndPacket  (lp)                      ||
        !WSFlush      (lp))
        return 0;

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
        WSNewPacket(lp);
    }
    return pid;
}
