#!/usr/bin/env bash
# Builds QLMix.app (release) into ./build and ad-hoc signs it.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CONFIG="${CONFIG:-release}"
APP="$ROOT/build/QLMix.app"

swift build -c "$CONFIG" --product QLMix
BIN="$(swift build -c "$CONFIG" --show-bin-path)/QLMix"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/QLMix"
if [[ -f "$ROOT/Resources/AppIcon.icns" ]]; then
  cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

VERSION="$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo 1.0)"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>QLMix</string>
  <key>CFBundleDisplayName</key><string>QLMix</string>
  <key>CFBundleIdentifier</key><string>de.klassen.qlmix</string>
  <key>CFBundleExecutable</key><string>QLMix</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>QLMix verbindet sich über das lokale Netzwerk mit deinem Yamaha CL/QL-Mischpult.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null
echo "✔ $APP"
