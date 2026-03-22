#!/usr/bin/env bash
# WSTP Backend/release.sh
#
# One-command release: bump → rebuild → test → commit+tag+push → npm publish
#                      → wait for GitHub Actions → download binaries
#
# Usage:
#   ./release.sh                    — bump patch, full release
#   ./release.sh minor              — bump minor version
#   ./release.sh major              — bump major version
#   ./release.sh --skip-npm         — skip npm publish (useful when token needs 2FA)
#   ./release.sh --otp=123456       — supply npm 2FA OTP directly
#   ./release.sh --no-wait          — don't wait for CI / download binaries
#
# Environment variables (override flags):
#   NPM_OTP=123456                  — npm 2FA OTP
#   GITHUB_TOKEN=ghp_...            — GitHub PAT (falls back to git credential helper)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ─────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PREBUILT_DIR="$REPO_ROOT/Extension Development/wstp/prebuilt"
REPO="vanbaalon/mathematica-wstp-node"

# ─────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────
BUMP_TYPE="patch"
SKIP_NPM=0
NO_WAIT=0
OTP="${NPM_OTP:-}"

for arg in "$@"; do
    case "$arg" in
        patch|minor|major) BUMP_TYPE="$arg" ;;
        --skip-npm)        SKIP_NPM=1 ;;
        --no-wait)         NO_WAIT=1 ;;
        --otp=*)           OTP="${arg#--otp=}" ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ─────────────────────────────────────────────────────────────
# GitHub auth token (used for polling API and downloading assets)
# ─────────────────────────────────────────────────────────────
get_github_token() {
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        echo "$GITHUB_TOKEN"
        return
    fi
    # Try git credential helper
    local token
    token=$(printf 'protocol=https\nhost=github.com\n' \
        | git credential fill 2>/dev/null \
        | grep '^password=' | cut -d= -f2-)
    if [[ -z "$token" ]]; then
        echo "⚠️  No GitHub token found. Set GITHUB_TOKEN or configure git credentials." >&2
        echo ""
    else
        echo "$token"
    fi
}

gh_api() {
    # Usage: gh_api <endpoint> [extra curl args...]
    local url="https://api.github.com$1"; shift
    local token; token=$(get_github_token)
    local auth_header=()
    [[ -n "$token" ]] && auth_header=(-H "Authorization: token $token")
    curl -fsSL "${auth_header[@]}" \
         -H "Accept: application/vnd.github.v3+json" \
         "$url" "$@"
}

gh_download() {
    # Download a GitHub Release asset (needs auth header for private repos)
    local url="$1" dest="$2"
    local token; token=$(get_github_token)
    local auth_header=()
    [[ -n "$token" ]] && auth_header=(-H "Authorization: token $token")
    curl -fsSL "${auth_header[@]}" \
         -H "Accept: application/octet-stream" \
         -L -o "$dest" "$url"
}

# ─────────────────────────────────────────────────────────────
# Step 1 — Bump version
# ─────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════"
echo " Step 1 — Bump $BUMP_TYPE version"
echo "══════════════════════════════════════════════════"

CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP_TYPE" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEW_VER="$MAJOR.$MINOR.$PATCH"

echo "  $CURRENT  →  $NEW_VER"

# Update package.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VER\"/" package.json

# Update src/addon.cc comment + version string
sed -i '' "s/v$CURRENT/v$NEW_VER/g" src/addon.cc
sed -i '' "s/\"$CURRENT\"/\"$NEW_VER\"/g" src/addon.cc

echo "  ✓  package.json and src/addon.cc updated"

# ─────────────────────────────────────────────────────────────
# Step 2 — Rebuild
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Step 2 — Rebuild wstp.node"
echo "══════════════════════════════════════════════════"
bash build.sh
echo "  ✓  build/Release/wstp.node ready"

# ─────────────────────────────────────────────────────────────
# Step 3 — Run quick tests
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Step 3 — Quick tests (mini-test.js)"
echo "══════════════════════════════════════════════════"
node tests/mini-test.js
echo "  ✓  All mini-tests passed"

# ─────────────────────────────────────────────────────────────
# Step 4 — Commit, tag, push
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Step 4 — Commit + tag + push"
echo "══════════════════════════════════════════════════"

git add package.json src/addon.cc

# Also stage anything else already tracked and modified
git add -u

if git diff --cached --quiet; then
    echo "  ℹ️  Nothing to commit — already clean"
else
    git commit -F - <<ENDMSG
v$NEW_VER: release

Bumped version to $NEW_VER via release.sh
ENDMSG
    echo "  ✓  Committed"
fi

# Tag (skip if already exists)
if git rev-parse "v$NEW_VER" >/dev/null 2>&1; then
    echo "  ℹ️  Tag v$NEW_VER already exists — skipping"
else
    git tag "v$NEW_VER"
    echo "  ✓  Tagged v$NEW_VER"
fi

git push origin main
git push origin "v$NEW_VER"
echo "  ✓  Pushed branch + tag to GitHub"

# ─────────────────────────────────────────────────────────────
# Step 5 — npm publish
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Step 5 — npm publish"
echo "══════════════════════════════════════════════════"

if [[ $SKIP_NPM -eq 1 ]]; then
    echo "  ℹ️  Skipped (--skip-npm)"
else
    NPM_ARGS=()
    if [[ -n "$OTP" ]]; then
        NPM_ARGS+=(--otp="$OTP")
        echo "  Using OTP from flag/env"
    else
        # Check if .npmrc token is an Automation token (starts with npm_auto)
        # Regular tokens need OTP; automation tokens don't
        TOKEN_LINE=$(grep '_authToken=' .npmrc 2>/dev/null | head -1 || true)
        if [[ -z "$TOKEN_LINE" ]]; then
            echo "  ⚠️  No npm token found in .npmrc — skipping npm publish"
            SKIP_NPM=1
        else
            echo "  ℹ️  If publish fails with 2FA error, run:"
            echo "      NPM_OTP=<code> ./release.sh --skip-npm=false"
            echo "      or: npm publish --otp=<code>"
            echo "  ℹ️  To avoid this permanently, replace the token in .npmrc with"
            echo "      an Automation token from npmjs.com/settings/vanbaalon/tokens"
        fi
    fi

    if [[ $SKIP_NPM -eq 0 ]]; then
        if npm publish "${NPM_ARGS[@]}"; then
            echo "  ✓  Published wstp-node@$NEW_VER to npm"
        else
            echo ""
            echo "  ❌ npm publish failed."
            echo "     If you see a 2FA error, run:"
            echo "       cd '$SCRIPT_DIR' && npm publish --otp=<your-otp-code>"
            echo "     Or replace .npmrc token with an Automation token."
            echo ""
            echo "  Continuing to wait for GitHub CI..."
        fi
    fi
fi

# ─────────────────────────────────────────────────────────────
# Step 6 — Wait for GitHub Actions to complete and release created
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Step 6 — Wait for GitHub Release v$NEW_VER"
echo "══════════════════════════════════════════════════"

if [[ $NO_WAIT -eq 1 ]]; then
    echo "  ℹ️  Skipped (--no-wait)"
    echo ""
    echo "  When CI finishes, download binaries with:"
    echo "    ./release.sh --no-wait --skip-npm  # (re-run just the download step)"
    exit 0
fi

GH_TOKEN=$(get_github_token)
if [[ -z "$GH_TOKEN" ]]; then
    echo "  ⚠️  No GitHub token — cannot poll CI.  Set GITHUB_TOKEN and re-run."
    echo "     Binaries will be at: https://github.com/$REPO/releases/tag/v$NEW_VER"
    exit 0
fi

echo "  Waiting for GitHub Actions to build and create release v$NEW_VER..."
echo "  (This typically takes 10-20 minutes for Linux builds.)"
echo "  Follow: https://github.com/$REPO/actions"
echo ""

POLL_INTERVAL=30   # seconds between polls
MAX_WAIT=2400      # 40 minutes total
ELAPSED=0
RELEASE_ID=""

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
    RESPONSE=$(gh_api "/repos/$REPO/releases/tags/v$NEW_VER" 2>/dev/null || echo '{}')
    RELEASE_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

    if [[ -n "$RELEASE_ID" && "$RELEASE_ID" != "null" ]]; then
        # Check that at least one binary asset exists
        ASSET_COUNT=$(echo "$RESPONSE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
nodes=[a for a in d.get('assets',[]) if a['name'].endswith('.node')]
print(len(nodes))
" 2>/dev/null || echo "0")

        if [[ "$ASSET_COUNT" -gt 0 ]]; then
            echo "  ✓  Release v$NEW_VER is live with $ASSET_COUNT binary asset(s)!"
            break
        else
            printf "  … Release created but no binaries yet — waiting [%ds elapsed]\r" "$ELAPSED"
        fi
    else
        printf "  … No release yet — waiting [%ds elapsed]\r" "$ELAPSED"
    fi

    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

echo ""

if [[ -z "$RELEASE_ID" || "$RELEASE_ID" == "null" ]]; then
    echo "  ⚠️  Timed out after ${MAX_WAIT}s — release not found."
    echo "     Check: https://github.com/$REPO/actions"
    echo "     Once done, download manually:"
    echo "       GITHUB_TOKEN=... ./download-binaries.sh v$NEW_VER"
    exit 1
fi

# ─────────────────────────────────────────────────────────────
# Step 7 — Download binaries into wstp/prebuilt/
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Step 7 — Download binaries → wstp/prebuilt/"
echo "══════════════════════════════════════════════════"
echo "  Destination: $PREBUILT_DIR"
echo ""

mkdir -p "$PREBUILT_DIR"

# Fetch full release JSON to get asset list
RELEASE_JSON=$(gh_api "/repos/$REPO/releases/$RELEASE_ID")

echo "$RELEASE_JSON" | python3 - "$PREBUILT_DIR" "$GH_TOKEN" <<'PYEOF'
import sys, json, urllib.request, os

prebuilt_dir = sys.argv[1]
token = sys.argv[2]

data = json.load(sys.stdin)
assets = data.get('assets', [])
node_assets = [a for a in assets if a['name'].endswith('.node')]

if not node_assets:
    print("  ⚠️  No .node assets found in release!")
    sys.exit(1)

for asset in node_assets:
    name = asset['name']
    download_url = asset['url']   # API URL — needs Accept: application/octet-stream
    dest = os.path.join(prebuilt_dir, name)

    print(f"  ↓  {name} ({asset['size']//1024} KB) ...", end='', flush=True)

    req = urllib.request.Request(download_url, headers={
        'Authorization': f'token {token}',
        'Accept': 'application/octet-stream',
    })
    with urllib.request.urlopen(req) as resp, open(dest, 'wb') as f:
        f.write(resp.read())

    print(" ✓")

print(f"\n  ✓  {len(node_assets)} binary(-ies) downloaded to wstp/prebuilt/")
PYEOF

# Show what's now in prebuilt/
echo ""
echo "  Contents of wstp/prebuilt/:"
ls -lh "$PREBUILT_DIR"/*.node 2>/dev/null | awk '{print "    " $5 "  " $9}' || echo "    (none)"

echo ""
echo "══════════════════════════════════════════════════"
echo " ✅  Release v$NEW_VER complete!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  npm:    https://www.npmjs.com/package/wstp-node"
echo "  GitHub: https://github.com/$REPO/releases/tag/v$NEW_VER"
echo ""
echo "  Next: run deploy-extension.sh package new  to build the wolfbook VSIXes"
echo "        with the new cross-platform binaries."
