#!/bin/sh
# MORA для iPhone: сборка на Mac и открытие в Xcode.
# Запуск из корня репозитория: sh apps/mobile/scripts/ios-mac.sh [--check | --ipa]
#   --check  дополнительно собрать для симулятора без подписи (проверка, что проект компилируется)
#   --ipa    собрать неподписанный MORA-unsigned.ipa без аккаунта Apple (для Sideloadly)
set -eu

cd "$(dirname "$0")/../../.."
command -v node >/dev/null || { echo "Нужен Node.js 22.13+ (https://nodejs.org)"; exit 1; }
command -v xcodebuild >/dev/null || { echo "Нужен Xcode 26+ из App Store (Capacitor 8)"; exit 1; }

# Electron (desktop app) is not needed for the iPhone build: skip its ~100 MB download.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build -w @automix/mobile
cd apps/mobile
npx cap sync ios

if [ "${1:-}" = "--check" ]; then
  xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
fi

if [ "${1:-}" = "--ipa" ]; then
  # Unsigned .ipa without any Apple account in Xcode: Sideloadly/AltStore sign it with an Apple ID on install.
  rm -rf build/ipa MORA-unsigned.ipa
  xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath build/ipa/dd \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
  mkdir -p build/ipa/Payload
  cp -R build/ipa/dd/Build/Products/Release-iphoneos/App.app build/ipa/Payload/
  (cd build/ipa && zip -qry ../../MORA-unsigned.ipa Payload)
  echo "Готово: apps/mobile/MORA-unsigned.ipa — установите через Sideloadly."
  exit 0
fi

npx cap open ios
echo "Xcode открыт: выберите свой Team в Signing & Capabilities, подключите iPhone и нажмите Run."
