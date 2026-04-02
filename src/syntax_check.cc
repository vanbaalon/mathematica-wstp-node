// =============================================================================
// src/syntax_check.cc  — pure C++ Wolfram Language structural syntax checker
//
// Checks (without launching a kernel):
//   • Unmatched / mismatched brackets  ( ) [ ] { }
//   • Unclosed string literals          "..."
//   • Unclosed / mismatched comments   (* ... *)  (supports nesting)
//   • \[NamedChar] sequences are ignored (the [ ] inside are not brackets)
//
// Return format (same as the WL VsCodeSyntaxCheck function):
//   {"errors":[]}
//   {"errors":[{"message":"...","line":N,"column":N}, ...]}
// =============================================================================

#include "syntax_check.h"
#include <string>
#include <vector>
#include <cstring>

namespace {

struct BracketEntry {
    char ch;
    int  line;
    int  col;
};

static std::string makeErr(const std::string& msg, int line, int col) {
    return "{\"message\":\"" + msg +
           "\",\"line\":"    + std::to_string(line) +
           ",\"column\":"    + std::to_string(col) + "}";
}

} // namespace

std::string wlSyntaxCheck(const std::string& code) {
    // 0 = NORMAL, 1 = IN_STRING, 2 = IN_COMMENT
    int state = 0;
    int commentDepth = 0;

    int line = 1, col = 1;
    int strLine = 1, strCol = 1;          // position of the opening "

    std::vector<BracketEntry> stk;        // open-bracket stack
    std::vector<std::string>  errors;

    const size_t n = code.size();

    for (size_t i = 0; i < n; ++i) {
        const char c  = code[i];
        const char nc = (i + 1 < n) ? code[i + 1] : '\0';

        // ----------------------------------------------------------------
        // Inside a string literal
        // ----------------------------------------------------------------
        if (state == 1) {  // IN_STRING
            if (c == '\\' && nc != '\0') {
                // Escape sequence — skip both chars
                if (nc == '\n') { line++; col = 1; } else { col++; }
                ++i;
            } else if (c == '"') {
                state = 0;  // NORMAL
                col++;
            } else if (c == '\n') {
                line++; col = 1;
            } else {
                col++;
            }

        // ----------------------------------------------------------------
        // Inside a (* ... *) comment  (nesting supported)
        // ----------------------------------------------------------------
        } else if (state == 2) {  // IN_COMMENT
            if (c == '(' && nc == '*') {
                commentDepth++;
                col += 2; ++i;
            } else if (c == '*' && nc == ')') {
                if (--commentDepth == 0) state = 0;  // NORMAL
                col += 2; ++i;
            } else if (c == '\n') {
                line++; col = 1;
            } else {
                col++;
            }

        // ----------------------------------------------------------------
        // Normal code
        // ----------------------------------------------------------------
        } else {
            if (c == '"') {
                // Start of a string literal
                state   = 1;  // IN_STRING
                strLine = line; strCol = col;
                col++;

            } else if (c == '(' && nc == '*') {
                // Start of a comment
                state        = 2;  // IN_COMMENT
                commentDepth = 1;
                col += 2; ++i;

            } else if (c == '\\' && nc == '[') {
                // \[NamedChar] — consume the [ Name ] without treating
                // the brackets as structural.
                i += 2;             // skip '\' and '['
                col += 2;
                while (i < n && code[i] != ']') {
                    if (code[i] == '\n') { line++; col = 1; }
                    else                 { col++; }
                    ++i;
                }
                // i is now at ']' (or past end if malformed — outer for handles it)
                if (i < n) col++;   // account for ']'
                // outer for loop's ++i will move past ']' on next iteration

            } else if (c == '(' || c == '[' || c == '{') {
                stk.push_back({c, line, col});
                col++;

            } else if (c == ')' || c == ']' || c == '}') {
                const char expected = (c == ')') ? '(' : (c == ']') ? '[' : '{';
                if (stk.empty()) {
                    errors.push_back(makeErr(
                        std::string("Unexpected '") + c + "'", line, col));
                } else if (stk.back().ch != expected) {
                    errors.push_back(makeErr(
                        std::string("Mismatched bracket: '") + stk.back().ch +
                        "' closed by '" + c + "'", line, col));
                    stk.pop_back();   // pop to avoid cascading errors
                } else {
                    stk.pop_back();
                }
                col++;

            } else if (c == '\n') {
                line++; col = 1;
            } else {
                col++;
            }
        }
    }

    // ------------------------------------------------------------------
    // End-of-input checks
    // ------------------------------------------------------------------
    if (state == 1) {  // IN_STRING
        errors.push_back(makeErr("Unclosed string", strLine, strCol));
    }
    if (state == 2) {  // IN_COMMENT
        errors.push_back(makeErr("Unclosed comment '(*'", 1, 1));
    }
    for (const auto& b : stk) {
        const char cl = (b.ch == '(') ? ')' : (b.ch == '[') ? ']' : '}';
        errors.push_back(makeErr(
            std::string("Unclosed '") + b.ch + "' (expected '" + cl + "')",
            b.line, b.col));
    }

    // ------------------------------------------------------------------
    // Build JSON result
    // ------------------------------------------------------------------
    std::string result;
    result.reserve(32 + errors.size() * 64);
    result = "{\"errors\":[";
    for (size_t i = 0; i < errors.size(); ++i) {
        if (i > 0) result += ',';
        result += errors[i];
    }
    result += "]}";
    return result;
}
