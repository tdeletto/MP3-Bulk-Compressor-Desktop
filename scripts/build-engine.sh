#!/usr/bin/env bash
# Builds the native mp3bulk-engine helper for every target the installers ship.
#
#   scripts/build-engine.sh            # all targets this machine can build
#   scripts/build-engine.sh mac        # macOS arm64 + x64 (needs Xcode command line tools)
#   scripts/build-engine.sh win        # Windows x64 + arm64 (needs zig, works from macOS/Linux/Windows)
#
# Output: resources/engine/<platform>-<arch>/mp3bulk-engine[.exe]
# electron-builder copies the matching folder into the app (see "extraResources" in package.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/engine"
OUT="$ROOT/resources/engine"
TARGET="${1:-all}"

# LAME's encoder sources (the SSE "vector" folder is optional and left out, as in the Android build).
LAME_SOURCES=("$SRC"/third_party/lame/*.c)
INCLUDES=(-I"$SRC/third_party/lame" -I"$SRC/third_party/minimp3")
DEFINES=(-DHAVE_CONFIG_H)
# LAME's code predates modern warnings; silence them so real problems in our file stand out.
CFLAGS=(-O3 -ffast-math -w)

build_mac() {
  for arch in arm64 x86_64; do
    local node_arch="$arch"
    [[ "$arch" == "x86_64" ]] && node_arch="x64"
    local dir="$OUT/darwin-$node_arch"
    mkdir -p "$dir"
    echo "• macOS $node_arch"
    clang "${CFLAGS[@]}" -arch "$arch" -mmacosx-version-min=11.0 "${DEFINES[@]}" "${INCLUDES[@]}" \
      "$SRC/mp3bulk_engine.c" "${LAME_SOURCES[@]}" -lm -o "$dir/mp3bulk-engine"
    strip -x "$dir/mp3bulk-engine"
    # Ad-hoc signature: Apple Silicon refuses to run unsigned binaries.
    codesign --force --sign - "$dir/mp3bulk-engine" >/dev/null
  done
}

build_win() {
  command -v zig >/dev/null || { echo "zig is required for Windows builds (brew install zig / winget install zig.zig)"; exit 1; }
  for pair in "x86_64:x64" "aarch64:arm64"; do
    local zarch="${pair%%:*}" node_arch="${pair##*:}"
    local dir="$OUT/win32-$node_arch"
    mkdir -p "$dir"
    echo "• Windows $node_arch"
    zig cc -target "$zarch-windows-gnu" "${CFLAGS[@]}" -s "${DEFINES[@]}" "${INCLUDES[@]}" \
      "$SRC/mp3bulk_engine.c" "${LAME_SOURCES[@]}" -o "$dir/mp3bulk-engine.exe"
    rm -f "$dir"/*.pdb
  done
}

case "$TARGET" in
  mac) build_mac ;;
  win) build_win ;;
  all)
    [[ "$(uname)" == "Darwin" ]] && build_mac
    command -v zig >/dev/null && build_win || echo "(skipping Windows: zig not installed)"
    ;;
  *) echo "unknown target: $TARGET"; exit 1 ;;
esac
echo "Engine binaries are in $OUT"
