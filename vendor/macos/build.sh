#!/usr/bin/env bash
# Build vp-helper as a universal macOS binary (arm64 + x86_64) and ad-hoc
# sign it. Output: ./vp-helper, ready to ship inside the npm package.
#
# Why universal: vp-connect is distributed via npm and runs on whatever
# Node binary the user happens to have — Apple Silicon Macs typically run
# arm64 Node, but Intel/Rosetta and CI machines do not. A fat binary is
# 2× the size (~150 KB vs 80 KB) but works everywhere with no dispatch.
#
# Why ad-hoc signing: the helper is exec'd by `node`, which itself is
# usually unsigned (nvm-installed) or signed by a third party (Homebrew).
# An unsigned helper child of an unsigned parent passes Gatekeeper for
# in-place execution because nothing has the `com.apple.quarantine`
# attribute (npm extracts don't set it). But TCC (Accessibility) is
# stricter on Sonoma+ and sometimes rejects bare-unsigned binaries that
# call CGEventPost. `codesign -s -` adds a self-signed signature that
# satisfies it without any developer-account complexity.

set -euo pipefail

cd "$(dirname "$0")"
SRC=vp-helper.swift
OUT=vp-helper

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[build] swiftc not found. Install Xcode Command Line Tools:" >&2
  echo "         xcode-select --install" >&2
  exit 1
fi

# Build per-arch object files in a tmp dir so we can lipo them together.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ARCHES=(arm64 x86_64)
echo "[build] compiling $SRC for: ${ARCHES[*]}"

BUILT_BINS=()
for ARCH in "${ARCHES[@]}"; do
  swiftc -O \
    -target "${ARCH}-apple-macos11.0" \
    -framework CoreGraphics \
    -framework Foundation \
    -o "$TMP/vp-helper-${ARCH}" \
    "$SRC"
  BUILT_BINS+=("$TMP/vp-helper-${ARCH}")
  echo "[build]   $(file "$TMP/vp-helper-${ARCH}" | sed 's|.*: ||')"
done

# Stitch into a single fat binary. lipo is part of every Xcode install.
lipo -create "${BUILT_BINS[@]}" -output "$OUT"
chmod +x "$OUT"

# Ad-hoc sign so TCC accepts CGEventPost calls from us.
codesign --force --sign - --options=runtime "$OUT"

echo "[build] wrote $(pwd)/$OUT"
echo "[build] $(file "$OUT" | sed 's|.*: ||')"
echo "[build] size: $(du -h "$OUT" | awk '{print $1}')"
