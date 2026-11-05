# Copy the built web bundle into the iOS app's Web/ folder (replacing it).
# Run from the repository root after `npm run build`, before building in Xcode.
$ErrorActionPreference = 'Stop'
$root = Split-Path (Resolve-Path "$PSScriptRoot\..") -Parent
Set-Location $root
npm.cmd run build
$dest = Join-Path $root 'ios\Spotitube\Web'
if (Test-Path $dest) { Get-ChildItem $dest -Force | Remove-Item -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse (Join-Path $root 'dist\*') $dest
$size = (Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
"Synced {0:N1} MB of web assets to $dest" -f $size
