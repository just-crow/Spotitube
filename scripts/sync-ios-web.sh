#!/bin/sh
# Copy the built web bundle into the iOS app's Web/ folder (replacing it).
# Run from the repository root after `npm run build`, before building in Xcode.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
npm run build
DEST="$ROOT/ios/Spotitube/Web"
if [ -d "$DEST" ]; then
  find "$DEST" -mindepth 1 -delete
fi
mkdir -p "$DEST"
cp -R "$ROOT/dist/." "$DEST/"
echo "Synced $(du -sh "$DEST" | cut -f1) of web assets to $DEST"
