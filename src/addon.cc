// =============================================================================
// wstp-backend/src/addon.cc   (v1.0.0 — thin entry point after refactor)
//
// This file is intentionally minimal.  All implementation lives in the
// other source files listed in binding.gyp:
//   diag.cc            — diagnostic logging channel
//   wstp_expr.cc       — WSTP expression reading + Napi conversion
//   drain.cc           — packet-draining helpers + DrainToEvalResult
//   evaluate_worker.cc — EvaluateWorker async worker
//   wstp_session.cc    — WstpSession class (main kernel session)
//   wstp_reader.cc     — WstpReader + ReadNextWorker (connect-mode reader)
// =============================================================================

#include "diag.h"
#include "wstp_session.h"
#include "wstp_reader.h"
#include "syntax_check.h"

// ---------------------------------------------------------------------------
// setDiagHandler(fn | null) — register the global diagnostic callback.
// The TSFN is Unref()'d so it does not hold the Node.js event loop open.
// ---------------------------------------------------------------------------
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
        g_diagTsfn.Unref(env);
        g_diagActive = true;
    }
    return env.Undefined();
}

// ---------------------------------------------------------------------------
// syntaxCheck(code) — pure C++ structural syntax check, no kernel needed.
// Returns the same JSON format as the WL VsCodeSyntaxCheck function.
// ---------------------------------------------------------------------------
static Napi::Value SyntaxCheck(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return Napi::String::New(env, "{\"errors\":[]}");
    }
    const std::string code   = info[0].As<Napi::String>().Utf8Value();
    const std::string result = wlSyntaxCheck(code);
    return Napi::String::New(env, result);
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------
Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
    WstpSession::Init(env, exports);
    WstpReader::Init(env, exports);
    exports.Set("setDiagHandler",
        Napi::Function::New(env, SetDiagHandler, "setDiagHandler"));
    exports.Set("syntaxCheck",
        Napi::Function::New(env, SyntaxCheck, "syntaxCheck"));
#ifndef WSTP_ADDON_VERSION
#  define WSTP_ADDON_VERSION "dev"
#endif
#ifndef WSTP_ADDON_BUILD_DATE
#  define WSTP_ADDON_BUILD_DATE "unknown"
#endif
    exports.Set("version",   Napi::String::New(env, WSTP_ADDON_VERSION));
    exports.Set("buildDate", Napi::String::New(env, WSTP_ADDON_BUILD_DATE));
    return exports;
}

NODE_API_MODULE(wstp, InitModule)
