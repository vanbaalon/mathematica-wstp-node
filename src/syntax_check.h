#pragma once
#include <string>

// Pure C++ Wolfram Language structural syntax checker.
// Checks bracket/brace/paren matching, unclosed strings, and unclosed
// nested comments (* ... *).  No kernel required — runs synchronously
// in the Node.js thread.
//
// Returns a JSON string in the same format as VsCodeSyntaxCheck:
//   {"errors":[]}                                       — no errors
//   {"errors":[{"message":"...","line":N,"column":N}]}  — one or more errors
std::string wlSyntaxCheck(const std::string& code);
