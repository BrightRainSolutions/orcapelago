# One-time per-machine dev setup for working inside Dropbox (Windows).
#
# The repo intentionally lives in Dropbox so development moves between
# machines seamlessly. Machine-local, regenerable folders must be excluded
# from sync or Dropbox locks files mid-write (Vite EBUSY errors). The
# com.dropbox.ignored NTFS stream is per-machine, so run this once on each
# new machine. Everything else — source, .git, .env — syncs normally.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

foreach ($f in 'node_modules', 'dist', 'dev-dist', '.netlify') {
  $path = Join-Path $root $f
  if (-not (Test-Path $path)) { New-Item -ItemType Directory $path | Out-Null }
  Set-Content -Path $path -Stream com.dropbox.ignored -Value 1
  Write-Host "Dropbox-ignored: $f"
}

# Clear any Vite dep cache left over from a previous machine/EBUSY failure.
Remove-Item -Recurse -Force (Join-Path $root 'node_modules\.vite') -ErrorAction SilentlyContinue

Set-Location $root
npm install
