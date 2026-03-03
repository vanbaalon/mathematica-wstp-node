# diagnose-windows.ps1
# Run this in PowerShell to find the WSTP DeveloperKit on your Windows machine.
# It searches for the two files that wstp-node needs:
#   wstp.h         (C header)
#   wstp64i4s.lib  (static import library)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File diagnose-windows.ps1

Write-Host "`n=== Searching for WSTP DeveloperKit files ===`n" -ForegroundColor Cyan

$files = @("wstp.h", "wstp64i4s.lib")
$searchRoots = @(
    "C:\Program Files\Wolfram Research",
    "C:\Program Files (x86)\Wolfram Research",
    "$env:LOCALAPPDATA\Programs\Wolfram Research",
    "C:\Program Files\Wolfram Research\Mathematica",
    "C:\Program Files\Wolfram Research\Wolfram Engine"
) | Where-Object { (Test-Path $_) -and -not (Test-Path (Join-Path $_ "wsl.exe")) }

$found = @{}

foreach ($root in $searchRoots) {
    if (-not (Test-Path $root)) { continue }
    Write-Host "Searching under: $root" -ForegroundColor Gray
    foreach ($file in $files) {
        $results = Get-ChildItem -Path $root -Filter $file -Recurse -ErrorAction SilentlyContinue
        foreach ($r in $results) {
            Write-Host "  FOUND $file at: $($r.FullName)" -ForegroundColor Green
            $found[$file] = $r.DirectoryName
        }
    }
}

Write-Host ""

if ($found.Count -eq 0) {
    Write-Host "Neither wstp.h nor wstp64i4s.lib found." -ForegroundColor Red
    Write-Host "Make sure Wolfram Engine or Mathematica is installed."
    exit 1
}

# If both are in the same directory, suggest WSTP_DIR
$dirs = $found.Values | Sort-Object -Unique
if ($dirs.Count -eq 1) {
    $dir = $dirs[0]
    Write-Host "Both files are in:" -ForegroundColor Cyan
    Write-Host "  $dir" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Run this before npm install:" -ForegroundColor Cyan
    Write-Host "  `$env:WSTP_DIR = `"$dir`"" -ForegroundColor Yellow
    Write-Host "  npm install" -ForegroundColor Yellow
} else {
    Write-Host "Files found in different directories — use the directory containing both:" -ForegroundColor Yellow
    foreach ($kv in $found.GetEnumerator()) {
        Write-Host "  $($kv.Key) => $($kv.Value)"
    }
    Write-Host ""
    Write-Host "Set WSTP_DIR to the folder containing both files, then run npm install."
}
