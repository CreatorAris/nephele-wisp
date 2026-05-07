# Renders store/poster.html into a 1280x800 PNG suitable for Chrome Web
# Store / Edge Add-ons screenshot upload.
#
# Usage:
#   powershell -File store/render_poster.ps1
#   powershell -File store/render_poster.ps1 -Output store/screenshot1.png
#
# Output is content-deterministic: same HTML => same bytes (modulo Edge
# build version differences). Re-run after editing poster.html to refresh.

param(
    [string]$Output = "store/poster.png",
    [string]$Source = "store/poster.html",
    [int]$Width = 1280,
    [int]$Height = 800
)

$ErrorActionPreference = "Stop"

# Resolve absolute paths from the repo root (the script lives in store/).
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$srcAbs = Resolve-Path (Join-Path $repoRoot $Source)
$outAbs = Join-Path $repoRoot $Output

# file:// URI for Edge — backslashes are escaped to forward slashes.
$srcUri = "file:///" + ($srcAbs.Path -replace '\\', '/')

# Detect Windows display scaling. Edge headless on Windows ignores
# --force-device-scale-factor=1 and renders at the system DPR, so a
# window-size of 1400 only paints 1400/dpr physical pixels. Pre-scale
# the window-size to compensate; Edge then writes a PNG at the desired
# pixel size instead of leaking the white fallback.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DPI {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
}
"@
[DPI]::SetProcessDPIAware() | Out-Null
$logical = [DPI]::GetSystemMetrics(0)        # CM_CXSCREEN with DPI awareness OFF
# After SetProcessDPIAware, GetSystemMetrics returns physical px. Read
# again to compute DPR. (This is a one-shot probe; the actual DPI varies
# only if the user changes display scaling between renders, in which
# case re-running the script gets the new value.)
$physical = [DPI]::GetSystemMetrics(0)
# We need un-aware logical too, hop into a child PowerShell to get it.
$logicalRaw = & powershell -NoProfile -Command "[System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Width" 2>$null
if (-not $logicalRaw) {
    Add-Type -AssemblyName System.Windows.Forms
    $logicalRaw = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Width
}
$dpr = [Math]::Round($physical / [int]$logicalRaw, 2)
if ($dpr -lt 1.0) { $dpr = 1.0 }   # safety: never shrink

$wScaled = [int]($Width * $dpr)
$hScaled = [int]($Height * $dpr)
Write-Host "Detected display DPR: $dpr (logical=$logicalRaw, physical=$physical)"
Write-Host "Compensated window-size: ${wScaled}x${hScaled} (target PNG ${Width}x${Height})"

# Chromium 137+ disables --load-extension on Chrome but Edge keeps headless
# screenshot support. We only need headless rendering, so Edge is enough.
$candidates = @(
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)
$edge = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
    Write-Error "Microsoft Edge not found at standard install paths."
    exit 1
}

# --headless=new: modern headless (matches the rendering of headed Edge).
# --hide-scrollbars: keep the rendered output clean of any vertical bar.
# --disable-gpu: deterministic font rendering, no GPU artifact differences.
# --no-sandbox: not needed here, but speeds up cold start on this machine.
# --window-size: viewport, not output size — combined with html/body
#                hard-pinned to 1280x800 in CSS, the screenshot is exact.
$args = @(
    "--headless=new",
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--default-background-color=FFFFFFFF",
    "--force-device-scale-factor=1",
    "--window-size=$wScaled,$hScaled",
    "--screenshot=$outAbs",
    $srcUri
)

Write-Host "Rendering: $srcUri"
Write-Host "  -> $outAbs ($Width x $Height)"

$proc = Start-Process -FilePath $edge -ArgumentList $args -PassThru -Wait -WindowStyle Hidden
if ($proc.ExitCode -ne 0) {
    Write-Error "Edge headless exited with code $($proc.ExitCode)"
    exit $proc.ExitCode
}

if (-not (Test-Path $outAbs)) {
    Write-Error "Edge reported success but no output file at $outAbs"
    exit 2
}

# If we pre-scaled the window-size to compensate for system DPI, the PNG
# Edge wrote is at the scaled size. Resize back down to the requested
# Width x Height so downstream consumers (store uploads) get the exact
# pixel dimensions they expect.
if ($wScaled -ne $Width -or $hScaled -ne $Height) {
    $py = "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe"
    if (-not (Test-Path $py)) { $py = "python" }
    & $py -c @"
from PIL import Image
img = Image.open(r'$outAbs')
print(f'pre-resize: {img.size}')
img = img.resize(($Width, $Height), Image.LANCZOS)
img.save(r'$outAbs', optimize=True)
print(f'post-resize: {img.size}')
"@
}

$size = (Get-Item $outAbs).Length
Write-Host ("Done: {0} ({1:N1} KB)" -f $outAbs, ($size / 1KB))
