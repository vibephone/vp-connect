# vp-helper (native macOS event-injection helper)

A tiny Swift CLI that reads line-protocol events from stdin and posts them
through CoreGraphics (`CGEventPost`). vp-connect spawns it as a child
process and feeds it pointer / keyboard / scroll events received from the
phone.

The wire protocol is identical to the JXA fallback embedded in
`bin/vp-connect.js` (`SCROLL_HELPER_JS`), so the rest of the codebase
doesn't care which backend is running. The native binary is preferred
when present because it shaves 5–10 ms off the median latency and
eliminates the 10–30 ms tail-latency spikes JXA gets under GC pressure.

## When does this run?

Resolution order at startup:

1. `~/.vp-connect/vp-helper` — copied here by `npx vp-connect --install`.
2. `<package>/vendor/macos/vp-helper` — bundled inside the npm tarball /
   present in a local checkout. Picked up automatically when running
   `npx vp-connect` foreground without installing.
3. JXA fallback (no native binary) — `osascript -l JavaScript` running the
   embedded helper script. Slower but always available.

If the binary is missing or fails to start, vp-connect logs
`[helper] started (JXA fallback — install vp-helper for lower latency)`
and behavior is unchanged from 1.6.x.

## Building

The published npm package ships a prebuilt universal binary
(arm64 + x86_64). To rebuild from source:

```bash
./build.sh
```

That produces `./vp-helper`, ad-hoc signed (`codesign -s -`) so macOS
TCC accepts CGEventPost calls from it. Requires Xcode Command Line
Tools (`swiftc` + `lipo`); no SwiftPM scaffolding involved.

This script is also wired up as `npm run build:helper` and runs
automatically via `prepublishOnly` before `npm publish`, so a published
tarball always contains a fresh universal binary.

## Files

- `vp-helper.swift` — single-file source.
- `build.sh`        — universal-build + ad-hoc-sign script.
- `vp-helper`       — compiled universal binary (gitignored locally,
  rebuilt by CI / `prepublishOnly`).

## Why ad-hoc signing instead of a Developer ID

`vp-helper` is exec'd as a child of `node`, which is itself usually
unsigned (nvm) or signed by Homebrew. Apple's TCC tracks the
"responsible process" up the tree, so the helper inherits whatever
Accessibility permission the user granted to the parent `node` binary.
We don't need our own Developer ID — but TCC on macOS Sonoma+ is
stricter about *truly* unsigned binaries posting CGEvents, and ad-hoc
signing is enough to make it happy without needing any developer-account
credentials in the npm publish pipeline.

If a future macOS release tightens this further (e.g. requires
notarisation for any binary calling CGEventPost), we'd need to either
sign + notarise this binary with a real cert, or fall back permanently
to JXA. For now ad-hoc is the path of least friction.
