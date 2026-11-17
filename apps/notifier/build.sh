#!/usr/bin/env bash
# Builds jin's notifier into an app bundle (macOS notifications need one) and signs it ad hoc:
#   apps/notifier/build.sh <dest dir>   → <dest>/jin.app
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:?usage: build.sh <dest dir>}
APP=$DEST/jin.app
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/jin-notifier" "$HERE/main.swift"
cp -R "$HERE/../desktop/icon.iconset" "$TMP/jin.iconset"
iconutil -c icns "$TMP/jin.iconset" -o "$APP/Contents/Resources/jin.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.jin.notifier</string>
  <key>CFBundleName</key><string>jin</string>
  <key>CFBundleDisplayName</key><string>jin</string>
  <key>CFBundleExecutable</key><string>jin-notifier</string>
  <key>CFBundleIconFile</key><string>jin</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSUserNotificationAlertStyle</key><string>banner</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "$APP"
