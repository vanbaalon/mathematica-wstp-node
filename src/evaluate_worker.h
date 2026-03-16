#pragma once

#include "types.h"
#include "drain.h"
#include <napi.h>
#include <wstp.h>
#include <atomic>
#include <functional>
#include <string>

// ===========================================================================
// EvaluateWorker — ALL blocking WSTP I/O runs on the libuv thread pool.
//
// Execute()  — thread pool: sends EvaluatePacket/EnterExpressionPacket,
//              blocks on DrainToEvalResult, stores result in plain C++ structs.
// OnOK()     — main thread: converts EvalResult to Napi::Value, resolves
//              the Promise.
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
                   bool                          interactive = false);

    void Execute() override;
    void OnOK() override;
    void OnError(const Napi::Error& e) override;

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
