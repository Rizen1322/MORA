#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then
  echo "Native validation needs macOS + Xcode."
  exit 1
fi
swift test --package-path .
plutil -lint MORA/Info.plist MORA.xcodeproj/project.pbxproj
xcodebuild -project MORA.xcodeproj -scheme MORA -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
swift scripts/check-javascriptcore.swift MORA/Resources/mora-core.js
