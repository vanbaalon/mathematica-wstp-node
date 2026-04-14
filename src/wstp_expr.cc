#include "wstp_expr.h"

// ---------------------------------------------------------------------------
// ReadExprRaw — build a WExpr from one WSTP token/expression (any thread).
// ---------------------------------------------------------------------------
WExpr ReadExprRaw(WSLINK lp, int depth) {
    if (depth > 512) return WExpr::mkError("expression too deep");

    int type = WSGetType(lp);

    if (type == WSTKINT) {
        // Use WSGetNumberAsString so arbitrarily-large integers don't crash the link.
        // WSGetInteger64 closes the link on overflow; WSGetNumberAsString is safe for any size.
        const char* s = nullptr;
        if (!WSGetNumberAsString(lp, &s))
            return WExpr::mkError("WSGetNumberAsString failed for integer");
        std::string str(s);
        WSReleaseString(lp, s);
        // Try to parse as int64 first (common case — small integers).
        try {
            size_t pos = 0;
            int64_t iv = std::stoll(str, &pos);
            if (pos == str.size()) {
                WExpr e; e.kind = WExpr::Integer; e.intVal = iv; return e;
            }
        } catch (...) {}
        // Doesn't fit in int64 — return as BigInteger (decimal string).
        WExpr e; e.kind = WExpr::BigInteger; e.strVal = std::move(str); return e;
    }
    if (type == WSTKREAL) {
        double d = 0.0;
        if (!WSGetReal64(lp, &d))
            return WExpr::mkError("WSGetReal64 failed");
        WExpr e; e.kind = WExpr::Real; e.realVal = d;
        return e;
    }
    if (type == WSTKSTR) {
        const char* s = nullptr;
        if (!WSGetString(lp, &s))
            return WExpr::mkError("WSGetString failed");
        WExpr e; e.kind = WExpr::String; e.strVal = s;
        WSReleaseString(lp, s);
        return e;
    }
    if (type == WSTKSYM) {
        const char* s = nullptr;
        if (!WSGetSymbol(lp, &s))
            return WExpr::mkError("WSGetSymbol failed");
        WExpr e; e.kind = WExpr::Symbol; e.strVal = s;
        WSReleaseSymbol(lp, s);
        return e;
    }
    if (type == WSTKFUNC) {
        const char* head = nullptr;
        int argc = 0;
        if (!WSGetFunction(lp, &head, &argc))
            return WExpr::mkError("WSGetFunction failed");
        WExpr e;
        e.kind = WExpr::Function;
        e.head = head;
        WSReleaseSymbol(lp, head);
        e.args.reserve(argc);
        for (int i = 0; i < argc; ++i) {
            WExpr child = ReadExprRaw(lp, depth + 1);
            if (child.kind == WExpr::WError) return child;
            e.args.push_back(std::move(child));
        }
        return e;
    }
    return WExpr::mkError("unexpected token type: " + std::to_string(type));
}

// ---------------------------------------------------------------------------
// WExprToNapi — convert WExpr → Napi::Value.  Main thread only.
// ---------------------------------------------------------------------------
Napi::Value WExprToNapi(Napi::Env env, const WExpr& e) {
    switch (e.kind) {
        case WExpr::Integer: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "integer"));
            o.Set("value", Napi::Number::New(env, static_cast<double>(e.intVal)));
            return o;
        }
        case WExpr::BigInteger: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "biginteger"));
            o.Set("value", Napi::String::New(env, e.strVal));
            return o;
        }
        case WExpr::Real: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "real"));
            o.Set("value", Napi::Number::New(env, e.realVal));
            return o;
        }
        case WExpr::String: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "string"));
            o.Set("value", Napi::String::New(env, e.strVal));
            return o;
        }
        case WExpr::Symbol: {
            Napi::Object o = Napi::Object::New(env);
            o.Set("type",  Napi::String::New(env, "symbol"));
            o.Set("value", Napi::String::New(env, e.strVal));
            return o;
        }
        case WExpr::Function: {
            Napi::Array argsArr = Napi::Array::New(env, e.args.size());
            for (size_t i = 0; i < e.args.size(); ++i)
                argsArr.Set(static_cast<uint32_t>(i), WExprToNapi(env, e.args[i]));
            Napi::Object o = Napi::Object::New(env);
            o.Set("type", Napi::String::New(env, "function"));
            o.Set("head", Napi::String::New(env, e.head));
            o.Set("args", argsArr);
            return o;
        }
        case WExpr::WError:
        default:
            Napi::Error::New(env, e.strVal).ThrowAsJavaScriptException();
            return env.Undefined();
    }
}

// ---------------------------------------------------------------------------
// EvalResultToNapi — convert EvalResult → Napi::Object.  Main thread only.
// ---------------------------------------------------------------------------
Napi::Value EvalResultToNapi(Napi::Env env, const EvalResult& r) {
    auto obj = Napi::Object::New(env);

    obj.Set("cellIndex",  Napi::Number::New(env, static_cast<double>(r.cellIndex)));
    obj.Set("outputName", Napi::String::New(env, r.outputName));
    obj.Set("result",     WExprToNapi(env, r.result));
    obj.Set("aborted",    Napi::Boolean::New(env, r.aborted));

    auto print = Napi::Array::New(env, r.print.size());
    for (size_t i = 0; i < r.print.size(); ++i)
        print.Set(static_cast<uint32_t>(i), Napi::String::New(env, r.print[i]));
    obj.Set("print", print);

    auto msgs = Napi::Array::New(env, r.messages.size());
    for (size_t i = 0; i < r.messages.size(); ++i)
        msgs.Set(static_cast<uint32_t>(i), Napi::String::New(env, r.messages[i]));
    obj.Set("messages", msgs);

    return obj;
}
