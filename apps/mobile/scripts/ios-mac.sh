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
case "${1:-}" in
  --check) sh apps/mobile/scripts/build-rust-ios.sh iphonesimulator ;;
  --ipa) sh apps/mobile/scripts/build-rust-ios.sh iphoneos ;;
  *) sh apps/mobile/scripts/build-rust-ios.sh iphoneos iphonesimulator ;;
esac
cd apps/mobile
# The app version lives only in package.json; the build number follows the patch (1.0.38 → 39).
# shortcut: patch+1 restarts at a minor bump; switch to a running counter if TestFlight ever needs it.
node -e "const fs=require('fs'),v=require('./package.json').version,f='ios/App/App.xcodeproj/project.pbxproj';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/MARKETING_VERSION = [^;]+;/g,'MARKETING_VERSION = '+v+';').replace(/CURRENT_PROJECT_VERSION = [^;]+;/g,'CURRENT_PROJECT_VERSION = '+(+v.split('.')[2]+1)+';'))"
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
  # Sideloadly/AltStore read the requested entitlements from the bundle and re-sign with them:
  # an ad-hoc signature carries the App Group the widgets share data through.
  # MORA_CARPLAY=1 also asks for CarPlay audio — only for an Apple account that Apple granted it to.
  APP=build/ipa/Payload/App.app
  ENTITLEMENTS=ios/App/App/App.entitlements
  [ "${MORA_CARPLAY:-}" = 1 ] && ENTITLEMENTS=ios/App/App/CarPlay.entitlements
  find "$APP/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) -exec codesign --force --sign - {} \; 2>/dev/null || true
  codesign --force --sign - --entitlements ios/App/MORAWidgets/MORAWidgets.entitlements "$APP/PlugIns/MORAWidgets.appex"
  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP"
  (cd build/ipa && zip -qry ../../MORA-unsigned.ipa Payload)
  echo "Готово: apps/mobile/MORA-unsigned.ipa — установите через Sideloadly."
  exit 0
fi

npx cap open ios
echo "Xcode открыт: выберите свой Team в Signing & Capabilities, подключите iPhone и нажмите Run."
