#!/bin/sh
# Package the extension for the Chrome Web Store: dist/scrollback-<version>.zip
set -eu
cd "$(dirname "$0")/.."
node --test test/format.test.js >/dev/null
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/scrollback-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr -X "$OUT" manifest.json src popup library ui icons -x '*.DS_Store'
echo "$OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -n +4 | sed '$d' | sed '$d' | awk '{print "  " $4}'

# everything the store dashboard asks for, in one folder
S=dist/submit
rm -rf "$S" && mkdir -p "$S/screenshots"
cp "$OUT" store/icon-128.png store/promo-440x280.png store/marquee-1400x560.png store/listing.md "$S/"
cp store/screenshots/*.png "$S/screenshots/"
echo "upload kit: $S"
