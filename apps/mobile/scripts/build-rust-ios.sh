#!/bin/sh
# Rust MIR for iPhone: packages/audio-rust → target/ios/<platform>/libmora_audio.a, linked by the Xcode App target.
# Запуск из корня репозитория: sh apps/mobile/scripts/build-rust-ios.sh [iphoneos] [iphonesimulator] [macosx]
set -eu

cd "$(dirname "$0")/../../.."
[ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "Нужен Rust: установите rustup с https://rust-lang.org/tools/install/"; exit 1; }
export IPHONEOS_DEPLOYMENT_TARGET=17.4 MACOSX_DEPLOYMENT_TARGET=13.0
crate=packages/audio-rust
out=$crate/target/ios

build() { # platform targets...
  platform=$1; shift
  for target in "$@"; do
    rustup target add "$target" >/dev/null
    cargo build --release --locked --lib --no-default-features --target "$target" --manifest-path "$crate/Cargo.toml"
  done
  mkdir -p "$out/$platform"
  lipo -create $(for target in "$@"; do echo "$crate/target/$target/release/libmora_audio.a"; done) -output "$out/$platform/libmora_audio.a"
}

[ $# -eq 0 ] && set -- iphoneos
for platform in "$@"; do
  case $platform in
    iphoneos) build iphoneos aarch64-apple-ios ;;
    iphonesimulator) build iphonesimulator aarch64-apple-ios-sim x86_64-apple-ios ;;
    macosx) build macosx "$(uname -m | sed 's/arm64/aarch64/')-apple-darwin" ;;
    *) echo "Неизвестная платформа: $platform"; exit 1 ;;
  esac
done
