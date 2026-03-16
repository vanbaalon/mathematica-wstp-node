#include "diag.h"

#include <chrono>
#include <cstdio>

std::mutex               g_diagMutex;
Napi::ThreadSafeFunction g_diagTsfn;
bool                     g_diagActive = false;

// If DEBUG_WSTP=1 is set in the environment at module-load time, every
// DiagLog message is also written synchronously to stderr via fwrite.
// Useful when no JS setDiagHandler is registered (e.g. bare node runs).
static const bool g_debugToStderr = []() {
    const char* v = getenv("DEBUG_WSTP");
    return v && v[0] == '1';
}();

// Module-relative timestamp helper — milliseconds since module load.
static auto g_startTime = std::chrono::steady_clock::now();

long long diagMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - g_startTime).count();
}

void DiagLog(const std::string& msg) {
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
