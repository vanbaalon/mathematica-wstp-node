# Building wstp.node on Windows (x64)

This document covers everything needed to compile `wstp.node` on Windows.
The branch `windows-x64` contains the three source-level portability fixes
and the prebuilt binary in `prebuilds/win32-x64/wstp.node`.

---

## Prerequisites

| Tool | Version tested | Notes |
|------|---------------|-------|
| Wolfram Mathematica / Engine | 12.3+ | Provides WSTP DeveloperKit (`wstp.h`, `wstp64i4s.lib`) |
| Node.js | 22.x (x64) | https://nodejs.org |
| Visual Studio Build Tools 2022 | MSVC 14.44+ | C++ workload required |
| CMake | 3.31+ | Needed by node-gyp |
| Git | 2.47+ | For cloning |

Install VS Build Tools via the VS installer; select:
- **Desktop development with C++**

---

## Build steps

```powershell
# 1. Clone
git clone https://github.com/vanbaalon/mathematica-wstp-node.git
cd mathematica-wstp-node
git checkout windows-x64      # Windows-patched branch

# 2. Point node-gyp at the WSTP DeveloperKit
#    (adjust path if Mathematica is installed elsewhere)
$env:WSTP_DIR = "C:\Program Files\Wolfram Research\Mathematica\12.3\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"

# 3. Install JS dependencies and compile the native addon
npm install

# The compiled binary is at:
#   build\Release\wstp.node
```

---

## Windows portability fixes applied to the source

Three files were patched to make the POSIX-oriented codebase compile and link
under MSVC on Windows.  All changes are guarded by `#ifdef _WIN32` so the
macOS / Linux build is completely unaffected.

### 1. `src/wstp_session.h` — `pid_t` not defined in MSVC

MSVC's `<sys/types.h>` does not define `pid_t`.  A conditional typedef is added:

```diff
-#include <sys/types.h>
+#ifdef _WIN32
+#  include <sys/types.h>
+#  ifndef pid_t
+     typedef int pid_t;
+#  endif
+#else
+#  include <sys/types.h>
+#endif
```

### 2. `src/wstp_session.cc` — `kill()`, `SIGTERM`, `SIGKILL` are POSIX-only

`kill()` does not exist on Windows.  A thin static shim is added that maps it
to `TerminateProcess()`.  `SIGTERM` / `SIGKILL` constants are defined if the
headers don't provide them:

```diff
+#ifdef _WIN32
+#  include <windows.h>
+#  ifndef SIGTERM
+#    define SIGTERM 15
+#  endif
+#  ifndef SIGKILL
+#    define SIGKILL 9
+#  endif
+static int kill(pid_t pid, int /*sig*/) {
+    HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
+    if (!h) return -1;
+    BOOL ok = TerminateProcess(h, 1);
+    CloseHandle(h);
+    return ok ? 0 : -1;
+}
+#endif
```

### 3. `binding.gyp` — missing Windows system libraries

`wstp64i4s.lib` depends on Winsock2, RPC, and the extended Winsock library.
Without them the linker fails with `unresolved external symbol` errors for
`WSACleanup`, `UuidCreate`, etc.:

```diff
-"libraries": ["<(wstp_dir)/wstp64i4s.lib"]
+"libraries": [
+  "<(wstp_dir)/wstp64i4s.lib",
+  "-lws2_32",
+  "-lrpcrt4",
+  "-lmswsock"
+]
```

---

## Test suite notes

The test suite (`tests/test.js`) requires two additional Windows adaptations:

- **`KERNEL_PATH`** — hardcoded to a macOS path; update to your local
  `WolframKernel.exe` location, e.g.:
  ```
  C:\Program Files\Wolfram Research\Mathematica\12.3\WolframKernel.exe
  ```
- **Watchdog** — the Unix `spawn('sh', ['-c', 'sleep 900; kill ...'])` timeout
  is replaced with a `spawn('powershell', [...])` equivalent on Windows.
- **Multi-kernel tests (29, 31)** — these tests require two simultaneous
  kernel processes.  A single-seat Mathematica license permits only one
  concurrent kernel; set `SKIP_MULTI_KERNEL=1` to skip them:
  ```powershell
  $env:SKIP_MULTI_KERNEL = "1"
  node tests/test.js
  ```

---

## Prebuilt binary

`prebuilds/win32-x64/wstp.node` — compiled on Windows 10/11 x64 against
Mathematica 12.3's WSTP DeveloperKit, Node.js 22 (x64), MSVC 14.44.

This binary is what the `wolfbook` VS Code extension uses at runtime on Windows.
