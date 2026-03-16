#include "wstp_reader.h"
#include "diag.h"
#include "wstp_expr.h"

#include <chrono>
#include <string>
#include <thread>

// ---------------------------------------------------------------------------
// ReadNextWorker
// ---------------------------------------------------------------------------
ReadNextWorker::ReadNextWorker(Napi::Promise::Deferred deferred, WSLINK lp,
                               std::atomic<bool>& activated)
    : Napi::AsyncWorker(deferred.Env()),
      deferred_(deferred), lp_(lp), activated_(activated) {}

void ReadNextWorker::Execute() {
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
        // for both "no data in buffer yet" and a genuine WSTKEND boundary token.
        // Calling WSNewPacket when there is no data corrupts the link's internal
        // read state so that every subsequent WSGetType also returns 0.
        DiagLog("[WstpReader] activated.");
        activated_.store(true);
    }

    // Spin on WSGetType() waiting for the link buffer to become non-empty.
    // WSGetType() is non-blocking on TCPIP connect-mode links: it returns 0
    // immediately if no data is buffered.  We spin in 5 ms increments rather
    // than using WSWaitForLinkActivity(), which has been observed to return
    // WSWAITSUCCESS before the buffer is actually readable on fast consecutive
    // runs, leading to a ReadExprRaw(type=0) error.
    //
    // The first 500 ms are traced at each distinct type value.  Hard timeout: 5 s.
    {
        auto spinStart   = std::chrono::steady_clock::now();
        auto deadline    = spinStart + std::chrono::seconds(5);
        auto traceWindow = spinStart + std::chrono::milliseconds(500);
        int  iters = 0, lastLoggedType = -999;
        while (true) {
            int t = WSGetType(lp_);
            ++iters;
            auto now = std::chrono::steady_clock::now();
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
                DiagLog("[WstpReader] spin TIMEOUT after " + std::to_string(iters) + " iters (5s)");
                SetError("WstpReader: 5-second timeout — link dead or data never arrived");
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }

    result_ = ReadExprRaw(lp_);

    // If ReadExprRaw still encountered WSTKEND (type=0) it means the spin exited
    // on a protocol boundary token, not an expression token.  Skip it once with
    // WSNewPacket and re-spin for the real expression.
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
                DiagLog("[WstpReader] re-spin TIMEOUT after " + std::to_string(iters2) + " iters");
                result_ = WExpr::mkError("WstpReader: 5-second timeout after WSTKEND skip");
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        result_ = ReadExprRaw(lp_);
    }

    // After a successful expression read, advance past the expression boundary
    // so the next WSGetType() call sees the next expression's start marker
    // rather than a residual WSTKEND.
    if (result_.kind != WExpr::WError)
        WSNewPacket(lp_);

    DiagLog("[WstpReader] ReadExprRaw kind=" + std::to_string((int)result_.kind)
            + (result_.kind == WExpr::WError ? " err=" + result_.strVal : ""));
}

void ReadNextWorker::OnOK() {
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

void ReadNextWorker::OnError(const Napi::Error& e) {
    deferred_.Reject(e.Value());
}

// ---------------------------------------------------------------------------
// WstpReader
// ---------------------------------------------------------------------------
Napi::Object WstpReader::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "WstpReader", {
        InstanceMethod<&WstpReader::ReadNext>("readNext"),
        InstanceMethod<&WstpReader::Close>   ("close"),
        InstanceAccessor<&WstpReader::IsOpen>("isOpen"),
    });
    exports.Set("WstpReader", func);
    return exports;
}

WstpReader::WstpReader(const Napi::CallbackInfo& info)
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

    // WSActivate is deferred to the first ReadNextWorker::Execute() (thread-pool).
    open_ = true;
    activated_.store(false);
}

WstpReader::~WstpReader() { CleanUp(); }

Napi::Value WstpReader::ReadNext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    if (!open_) {
        deferred.Reject(Napi::Error::New(env, "WstpReader is closed").Value());
        return deferred.Promise();
    }
    (new ReadNextWorker(deferred, lp_, activated_))->Queue();
    return deferred.Promise();
}

Napi::Value WstpReader::Close(const Napi::CallbackInfo& info) {
    CleanUp();
    return info.Env().Undefined();
}

Napi::Value WstpReader::IsOpen(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), open_);
}

void WstpReader::CleanUp() {
    if (lp_)    { WSClose(lp_);           lp_    = nullptr; }
    if (wsEnv_) { WSDeinitialize(wsEnv_); wsEnv_ = nullptr; }
    open_ = false;
}
