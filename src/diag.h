#pragma once

#include <mutex>
#include <napi.h>
#include <string>

// ===========================================================================
// Module-level diagnostic channel.
// setDiagHandler(fn) registers a JS callback; DiagLog(msg) fires it from any
// C++ thread.  Both the global flag and the TSFN are guarded by g_diagMutex.
// The TSFN is Unref()'d so it does not prevent the Node.js event loop from
// exiting normally.
// ===========================================================================
extern std::mutex               g_diagMutex;
extern Napi::ThreadSafeFunction g_diagTsfn;
extern bool                     g_diagActive;

// Module-relative timestamp — milliseconds since module load.
long long diagMs();

// DiagLog(msg) — send msg to the registered JS handler (if any) and/or to
// stderr when DEBUG_WSTP=1 is set.  Safe to call from any thread.
void DiagLog(const std::string& msg);
