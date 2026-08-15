#!/usr/bin/env sh
# One-time per-machine dev setup for working inside Dropbox (macOS).
# Same purpose as dev-setup.ps1: mark machine-local folders Dropbox-ignored
# (the attribute is per-machine), clear Vite's dep cache, install deps.
# On Linux use: setfattr -n user.com.dropbox.ignored -v 1 <folder>
set -e
cd "$(dirname "$0")/.."

for f in node_modules dist dev-dist .netlify; do
  mkdir -p "$f"
  xattr -w com.dropbox.ignored 1 "$f"
  echo "Dropbox-ignored: $f"
done

rm -rf node_modules/.vite
npm install
