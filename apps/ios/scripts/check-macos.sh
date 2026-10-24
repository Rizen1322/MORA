#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
if [ "$(uname -s)" != Darwin ]; then
  echo "This check needs macOS + Xcode. Windows can run npm run ios:check."
  exit 1
fi
npm run ios:prepare
npm run ios:check
sh apps/ios/scripts/check-native-macos.sh
