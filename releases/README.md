# Wolfbook Releases

Latest platform-specific `.vsix` packages for the [wolfbook](https://github.com/vanbaalon/wolfbook) VS Code extension.

## Files

| File | Platform | Architecture |
|------|----------|--------------|
| `wolfbook-*-darwin-arm64.vsix` | macOS | Apple Silicon (M1/M2/M3) |
| `wolfbook-*-darwin-x64.vsix`   | macOS | Intel x86-64 |
| `wolfbook-*-win32-x64.vsix`    | Windows | x86-64 (from v2.3.0) |

Only the **latest version** of each platform target is kept here. Older releases are archived in the `Extension Production VSIX/` folder (not tracked in git).

## Installation

In VS Code: **Extensions** → **⋯** → **Install from VSIX…** → select the file for your platform.

Or via the CLI:
```bash
code --install-extension wolfbook-<version>-<target>.vsix
```

## Release Notes

Each release corresponds to the version in [`package.json`](../package.json). See the wolfbook repo [CHANGELOG](https://github.com/vanbaalon/wolfbook/blob/main/CHANGELOG.md) for details.

## Updating

The deploy script (`deploy-extension.sh`) automatically copies newly built VSIXes here after running `./deploy-extension.sh package`.
