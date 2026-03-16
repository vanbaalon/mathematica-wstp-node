#pragma once

#include "types.h"

#include <napi.h>
#include <wstp.h>
#include <atomic>

// ===========================================================================
// ReadNextWorker — reads a single expression from a WSTP connect-mode link.
// Used exclusively by WstpReader.
// ===========================================================================
class ReadNextWorker : public Napi::AsyncWorker {
public:
    ReadNextWorker(Napi::Promise::Deferred deferred, WSLINK lp,
                   std::atomic<bool>& activated);
    void Execute() override;
    void OnOK()    override;
    void OnError(const Napi::Error& e) override;

private:
    Napi::Promise::Deferred deferred_;
    WSLINK                  lp_;
    std::atomic<bool>&      activated_;
    WExpr                   result_;
};

// ===========================================================================
// WstpReader — attaches to a named WSTP link created by a Wolfram kernel.
//
// Usage pattern:
//   1. Kernel:  $link = LinkCreate[LinkProtocol->"TCPIP"]
//               linkName = LinkName[$link]         // → "port@host,0@host"
//   2. JS:      const reader = new WstpReader(linkName)
//   3. Loop:    while (reader.isOpen) { const v = await reader.readNext() }
//
// Each call to readNext() blocks on the thread-pool until the next expression
// is available, then resolves with an ExprTree object.  When the kernel closes
// the link (LinkClose[$link]), readNext() rejects with a "link closed" error.
// ===========================================================================
class WstpReader : public Napi::ObjectWrap<WstpReader> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    explicit WstpReader(const Napi::CallbackInfo& info);
    ~WstpReader();

    Napi::Value ReadNext(const Napi::CallbackInfo& info);
    Napi::Value Close   (const Napi::CallbackInfo& info);
    Napi::Value IsOpen  (const Napi::CallbackInfo& info);

private:
    void CleanUp();

    WSEnvironment     wsEnv_;
    WSLINK            lp_;
    bool              open_;
    std::atomic<bool> activated_{false};
};
