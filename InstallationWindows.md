# Building wstp-node on Windows

This guide walks through compiling the native WSTP addon (`wstp.node`) on a
Windows 10 / 11 x64 machine so that the
[Wolfbook VS Code extension](https://github.com/vanbaalon/wolfbook) can use it
without any build step on the end-user's machine.

---

## Prerequisites

### 1. Wolfram Engine (or Mathematica)

Download the free **Wolfram Engine** from:  
https://wolfram.com/engine/

Default installation path after setup:
```
C:\Program Files\Wolfram Research\Wolfram Engine\14.x\
```

Verify the WSTP DeveloperKit is present:
```
C:\Program Files\Wolfram Research\Wolfram Engine\14.x\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions\
```
The key files needed are `wstp64i4s.lib` and `wstp.h` inside that folder.

> If your Wolfram version or install path differs, set the `WSTP_DIR` environment
> variable to the `CompilerAdditions` folder before building:
> ```powershell
> $env:WSTP_DIR = "C:\Program Files\Wolfram Research\Wolfram Engine\14.x\SystemFiles\Links\WSTP\DeveloperKit\Windows-x86-64\CompilerAdditions"
> ```

---

### 2. Visual Studio Build Tools (C++ compiler)

Run the following in **PowerShell as Administrator**:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

Then open **Visual Studio Installer** → **Modify** → select the
**"Desktop development with C++"** workload.  Make sure these components
are checked:

- ✅ MSVC v143 – VS 2022 C++ x64/x86 build tools
- ✅ Windows 11 SDK (or Windows 10 SDK)
- ✅ C++ CMake tools (optional but useful)

---

### 3. Node.js ≥ 18 (LTS)

```powershell
winget install OpenJS.NodeJS.LTS
```

Restart your shell after installation, then verify:

```powershell
node --version   # 20.x or 22.x
npm  --version
```

---

### 4. Git

```powershell
winget install Git.Git
```

---

## Build

Open a **Developer PowerShell for VS 2022** (or a regular PowerShell — `node-gyp`
finds MSVC automatically if the Build Tools are installed correctly).

```powershell
git clone https://github.com/vanbaalon/mathematica-wstp-node.git
cd mathematica-wstp-node

npm install
npm run build
```

A successful build prints:
```
Build succeeded: build\Release\wstp.node
```

### Verify the build

```powershell
node -e "const {WstpSession}=require('./build/Release/wstp.node'); const s=new WstpSession(); s.evaluate('1+1').then(r=>{console.log(r.result.value); s.close()})"
```
Expected output: `2`

---

## Contributing the binary to the Wolfbook extension

After building, copy the binary to the extension's `wstp/prebuilt/` folder and
commit it so CI can package the Windows VSIX:

```powershell
# from inside the mathematica-wstp-node directory:
copy build\Release\wstp.node ..\wolfbook\wstp\prebuilt\wstp-win32-x64.node
```

Then on macOS / Linux, run the deploy script to build both platform VSIXs:

```bash
bash deploy-extension.sh package
```

---

## Setting up a self-hosted GitHub Actions runner (optional)

If you want CI to build the Windows binary automatically on every release tag:

**In your browser:** go to  
`https://github.com/vanbaalon/mathematica-wstp-node` →  
Settings → Actions → Runners → **New self-hosted runner** → Windows x64

GitHub shows you a unique token and the exact download URL. Run those commands
in **PowerShell as Administrator**:

```powershell
mkdir C:\actions-runner; cd C:\actions-runner

# Replace the URL and token with what GitHub shows you:
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.x.x/actions-runner-win-x64-2.x.x.zip -OutFile runner.zip
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$PWD\runner.zip", "$PWD")

.\config.cmd --url https://github.com/vanbaalon/mathematica-wstp-node --token YOUR_TOKEN_HERE

# Install as a Windows service so it runs even when you are logged out:
.\svc.cmd install
.\svc.cmd start
```

Verify the runner is online: GitHub → Settings → Actions → Runners → green dot.

Once both the macOS and Windows runners are registered, push a version tag from
your Mac to trigger a full build:

```bash
git tag v0.5.0 && git push origin v0.5.0
```

The workflow builds both binaries and publishes them as assets on the
`mathematica-wstp-node` GitHub Release. The `wolfbook` workflow then downloads
those assets and packages the platform-specific VSIXs automatically.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `gyp ERR! find VS` | Open Developer PowerShell for VS 2022, or run `npm config set msvs_version 2022` |
| `LINK : fatal error LNK1181: cannot open input file 'wstp64i4s.lib'` | WSTP DeveloperKit not found — set `WSTP_DIR` (see Prerequisites) |
| `node.exe` crashes on `require('./build/Release/wstp.node')` | Node.js architecture mismatch — ensure you installed 64-bit Node |
| Runner shows offline | `cd C:\actions-runner && .\svc.cmd status`, then `.\svc.cmd start` |
| `error MSB8036: The Windows SDK version X was not found` | Install the matching Windows SDK via Visual Studio Installer |
