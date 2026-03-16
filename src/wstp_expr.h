#pragma once

#include "types.h"
#include <napi.h>
#include <wstp.h>

// ---------------------------------------------------------------------------
// ReadExprRaw — build a WExpr from one WSTP token/expression.  Any thread.
// ---------------------------------------------------------------------------
WExpr ReadExprRaw(WSLINK lp, int depth = 0);

// ---------------------------------------------------------------------------
// WExprToNapi — convert WExpr → Napi::Value.  Main thread only.
// ---------------------------------------------------------------------------
Napi::Value WExprToNapi(Napi::Env env, const WExpr& e);

// ---------------------------------------------------------------------------
// EvalResultToNapi — convert EvalResult → Napi::Object.  Main thread only.
// ---------------------------------------------------------------------------
Napi::Value EvalResultToNapi(Napi::Env env, const EvalResult& r);
