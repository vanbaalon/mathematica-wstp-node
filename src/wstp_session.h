#pragma once

#include "types.h"
#include "kernel_state.h"
#include "evaluate_worker.h"
#include <napi.h>
#include <wstp.h>

#include <atomic>
#include <chrono>
#include <deque>
#include <mutex>
#include <queue>
#include <string>
#include <sys/types.h>
#include <thread>
#include <unordered_map>
#include <vector>

// ===========================================================================
// WstpSession  —  JS class:  new WstpSession(kernelPath?)
// ===========================================================================
class WstpSession : public Napi::ObjectWrap<WstpSession> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    WstpSession(const Napi::CallbackInfo& info);
    ~WstpSession();

    Napi::Value Evaluate         (const Napi::CallbackInfo& info);
    Napi::Value Sub              (const Napi::CallbackInfo& info);
    Napi::Value SubWhenIdle      (const Napi::CallbackInfo& info);
    Napi::Value SubAuto          (const Napi::CallbackInfo& info);
    Napi::Value ExitDialog       (const Napi::CallbackInfo& info);
    Napi::Value DialogEval       (const Napi::CallbackInfo& info);
    Napi::Value Interrupt        (const Napi::CallbackInfo& info);
    Napi::Value Abort            (const Napi::CallbackInfo& info);
    Napi::Value CloseAllDialogs  (const Napi::CallbackInfo& info);
    Napi::Value CreateSubsession (const Napi::CallbackInfo& info);
    Napi::Value Close            (const Napi::CallbackInfo& info);
    Napi::Value RegisterDynamic      (const Napi::CallbackInfo& info);
    Napi::Value UnregisterDynamic    (const Napi::CallbackInfo& info);
    Napi::Value ClearDynamicRegistry (const Napi::CallbackInfo& info);
    Napi::Value GetDynamicResults    (const Napi::CallbackInfo& info);
    Napi::Value SetDynamicInterval   (const Napi::CallbackInfo& info);
    Napi::Value SetDynAutoMode       (const Napi::CallbackInfo& info);

    // Accessors
    Napi::Value IsOpen       (const Napi::CallbackInfo& info);
    Napi::Value IsDialogOpen (const Napi::CallbackInfo& info);
    Napi::Value IsReady      (const Napi::CallbackInfo& info);
    Napi::Value IsLinkDead   (const Napi::CallbackInfo& info);
    Napi::Value KernelPid    (const Napi::CallbackInfo& info);
    Napi::Value DynamicActive   (const Napi::CallbackInfo& info);
    Napi::Value GetKernelStateName(const Napi::CallbackInfo& info);

    // Called from EvaluateWorker lambda (must be public)
    void DrainAutoResults   (Napi::Env env);
    void PromoteAutoToWhenIdle();

private:
    // -----------------------------------------------------------------------
    // Nested queue entry types
    // -----------------------------------------------------------------------
    struct QueuedEval {
        std::string             expr;
        EvalOptions             opts;
        Napi::Promise::Deferred deferred;
        int                     interactiveOverride = -1;
    };
    struct QueuedSubIdle {
        std::string             expr;
        Napi::Promise::Deferred deferred;
    };
    struct QueuedWhenIdle {
        std::string              expr;
        Napi::Promise::Deferred  deferred;
        std::chrono::steady_clock::time_point deadline =
            std::chrono::steady_clock::time_point::max();
    };

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------
    void MaybeStartNext();
    void StartSubIdleWorker (QueuedSubIdle  item);
    void StartWhenIdleWorker(QueuedWhenIdle item);
    void FlushDialogQueueWithError(const std::string& errMsg);
    void StartDynTimer();
    void CleanUp();

    static bool WarmUpOutputRouting(WSLINK lp);
    static pid_t FetchKernelPid(WSLINK lp);

    // -----------------------------------------------------------------------
    // Data members
    // -----------------------------------------------------------------------
    WSEnvironment               wsEnv_;
    WSLINK                      lp_;
    bool                        open_;
    bool                        interactiveMode_ = false;
    pid_t                       kernelPid_    = 0;
    bool                        kernelKilled_ = false;
    std::atomic<int64_t>        nextLine_{1};
    std::atomic<bool>           abortFlag_{false};
    std::atomic<bool>           busy_{false};
    std::atomic<bool>           evalActive_{false};
    std::atomic<bool>           workerReadingLink_{false};
    std::atomic<bool>           linkDead_{false};

    std::mutex                  queueMutex_;
    std::queue<QueuedEval>      queue_;
    std::queue<QueuedSubIdle>   subIdleQueue_;
    std::queue<QueuedWhenIdle>  whenIdleQueue_;

    std::mutex                  dialogMutex_;
    std::queue<DialogRequest>   dialogQueue_;
    std::atomic<bool>           dialogPending_{false};
    std::atomic<bool>           dialogOpen_{false};
    std::atomic<bool>           interruptPending_{false};
    KernelStatus                ks_;  // multi-dimensional kernel state

    // Dynamic evaluation state (Phase 2)
    std::mutex                            dynMutex_;
    std::vector<DynRegistration>          dynRegistry_;
    std::vector<DynResult>                dynResults_;
    std::atomic<int>                      dynIntervalMs_{0};
    std::atomic<bool>                     dynAutoMode_{false};
    int                                   dynTaskInstalledInterval_{0};
    std::chrono::steady_clock::time_point dynLastEval_{};
    std::thread                           dynTimerThread_;
    std::atomic<bool>                     dynTimerRunning_{false};

    // subAuto() state
    std::atomic<size_t>                                autoNextId_{0};
    std::mutex                                         autoMutex_;
    std::deque<AutoExprEntry>                          autoExprQueue_;
    std::vector<AutoResultEntry>                       autoCompleted_;
    std::unordered_map<size_t, Napi::Promise::Deferred> autoDeferreds_;
    Napi::ThreadSafeFunction                           autoResolverTsfn_;
    std::atomic<bool>                                  autoTsfnActive_{false};
};
