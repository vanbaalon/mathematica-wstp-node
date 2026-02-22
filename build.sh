#!/usr/bin/env bash
# =============================================================================
# build.sh  —  direct clang++ build of the WSTP NAPI addon
#
# Uses shell-level quoting everywhere, so paths containing spaces (like
# "WSTP Backend" and "Wolfram 3.app") are handled correctly.
#
# Usage:
#   bash build.sh          # Release build → build/Release/wstp.node
#   bash build.sh debug    # Debug build   → build/Debug/wstp.node
#   bash build.sh clean    # Remove build/
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# ── clean ─────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "clean" ]]; then
    rm -rf build
    echo "Cleaned."
    exit 0
fi

# ── mode ──────────────────────────────────────────────────────────────────────
BUILD_TYPE="${1:-release}"
if [[ "$BUILD_TYPE" == "debug" ]]; then
    OUT_DIR="$SCRIPT_DIR/build/Debug"
    OPT_FLAGS=(-O0 -g)
else
    OUT_DIR="$SCRIPT_DIR/build/Release"
    OPT_FLAGS=(-O2 -DNDEBUG)
fi
mkdir -p "$OUT_DIR"

OUTPUT="$OUT_DIR/wstp.node"

# ── locate node headers ───────────────────────────────────────────────────────
NODE_BIN="$(which node)"
NODE_PREFIX="$(node -p "'$NODE_BIN'.replace(/\\/(bin|MacOS)\\/node$/,'')" 2>/dev/null)"
NODE_HEADERS="${NODE_PREFIX}/include/node"

# Fallback: node-gyp cached headers
if [[ ! -f "$NODE_HEADERS/node_api.h" ]]; then
    NODE_VER="$(node -p "process.version.replace('v','')")"
    for candidate in \
        "$HOME/Library/Caches/node-gyp/$NODE_VER/include/node" \
        "$HOME/.node-gyp/$NODE_VER/include/node" \
        "$HOME/.cache/node-gyp/$NODE_VER/include/node"; do
        if [[ -f "$candidate/node_api.h" ]]; then
            NODE_HEADERS="$candidate"
            break
        fi
    done
fi
if [[ ! -f "$NODE_HEADERS/node_api.h" ]]; then
    echo "ERROR: Could not find node_api.h. Run: node-gyp install" >&2
    exit 1
fi
echo "Node headers : $NODE_HEADERS"

# ── locate node-addon-api headers ─────────────────────────────────────────────
NAPI_INCLUDE="$(node -p "require('node-addon-api').include.replace(/[\"']/g,'')" 2>/dev/null)"
if [[ -z "$NAPI_INCLUDE" || ! -f "$NAPI_INCLUDE/napi.h" ]]; then
    echo "ERROR: node-addon-api not found — run: npm install" >&2
    exit 1
fi
echo "NAPI headers  : $NAPI_INCLUDE"

# ── locate WSTP SDK ───────────────────────────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
    arm64)   WSTP_SUBDIR="MacOSX-ARM64"   ;;
    x86_64)  WSTP_SUBDIR="MacOSX-x86-64"  ;;
    *)        WSTP_SUBDIR="$ARCH"          ;;
esac

# WSTP_DIR overrides everything; otherwise derive from WOLFRAM_APP (default: Wolfram 3.app)
WOLFRAM_APP_DEFAULT="/Applications/Wolfram 3.app"
if [[ -z "${WSTP_DIR:-}" ]]; then
    WOLFRAM_APP="${WOLFRAM_APP:-$WOLFRAM_APP_DEFAULT}"
    WSTP_SDK="$WOLFRAM_APP/Contents/SystemFiles/Links/WSTP/DeveloperKit/$WSTP_SUBDIR/CompilerAdditions"
else
    WSTP_SDK="$WSTP_DIR"
fi

if [[ ! -f "$WSTP_SDK/wstp.h" ]]; then
    echo "ERROR: WSTP SDK not found at: $WSTP_SDK" >&2
    echo "  Set WOLFRAM_APP to your Wolfram/Mathematica app bundle, e.g.:" >&2
    echo "    WOLFRAM_APP=/Applications/Mathematica.app bash build.sh" >&2
    echo "  Or set WSTP_DIR directly to the CompilerAdditions directory." >&2
    exit 1
fi
echo "WSTP SDK      : $WSTP_SDK"

# ── find the node shared library for linking ──────────────────────────────────
# On macOS the node binary itself acts as the import library.
NODE_LIB="$(node -p "process.execPath")"
echo "Node lib      : $NODE_LIB"

# ── compile source ────────────────────────────────────────────────────────────
SOURCE="$SCRIPT_DIR/src/addon.cc"

echo ""
echo "Compiling $SOURCE …"

clang++ \
    -std=c++17 \
    "${OPT_FLAGS[@]}" \
    -Wall -Wextra \
    -fPIC \
    -fvisibility=hidden \
    -DBUILDING_NODE_EXTENSION \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -I "$NODE_HEADERS" \
    -I "$NAPI_INCLUDE" \
    -I "$WSTP_SDK" \
    -c "$SOURCE" \
    -o "$OUT_DIR/addon.o"

echo "Linking $OUTPUT …"

clang++ \
    -dynamiclib \
    -undefined dynamic_lookup \
    -o "$OUTPUT" \
    "$OUT_DIR/addon.o" \
    "$WSTP_SDK/libWSTPi4.a" \
    -framework Foundation \
    -framework SystemConfiguration \
    -framework CoreFoundation

echo ""
echo "Build succeeded: $OUTPUT"
