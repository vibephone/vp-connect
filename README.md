# vp-connect

Mac & Windows server for the Vibephone iOS app.  
Lets you dictate voice commands from your iPhone directly into Claude Code (or any IDE).

## Requirements

- Node.js 18+ — [nodejs.org](https://nodejs.org)
- Mac or Windows PC on the same Wi-Fi as your iPhone

## Install as a background service

Paste this into your terminal — it installs and starts the server automatically on every login:

```bash
npx vp-connect --install
```

The command prints a **QR code** at the end. In the Vibephone app tap **Connect** and scan the QR — no typing required.

> **First-install note:** vp-connect downloads its own pinned Node runtime (~45 MB) into `~/.vp-connect/runtime/` so the background service doesn't depend on whichever `node` is on your PATH. This protects against PATH shuffles from agent toolchains (Hermes, OpenClaw, Cursor's bundled node), version managers (nvm, asdf, brew), and uninstalls. One-time download per major Node bump; reinstalls reuse the cached runtime.

> **macOS note:** The installer will prompt you to grant **Accessibility** permission the first time. This is required so `vp-connect` can paste what you dictate, drive your Mac cursor from the phone trackpad, and synthesise clicks. System Settings will open automatically — toggle ON the `node` entry that points at `~/.vp-connect/runtime/.../bin/node`. After granting it, run `npx vp-connect --verify` to confirm.

## Check the installed version

```bash
npx vp-connect --version
# or: npx vp-connect -v
```

Prints the npm package version of the `vp-connect` that Node resolves (same value the iPhone sees in `helloAck`). Latest on the registry: `npm view vp-connect version`.

## Run manually (foreground)

If you just want to try it without installing:

```bash
npx vp-connect
```

## Verify setup (macOS Accessibility check)

```bash
npx vp-connect --verify
```

Reports whether macOS Accessibility permission is granted. If not, auto-opens the settings pane so you can fix it.

## Re-show the pairing QR

```bash
npx vp-connect --qr
```

Prints the pairing QR without starting a server — useful when connecting a new phone while the background service is already running.

## Uninstall

```bash
npx vp-connect --uninstall
```

## Troubleshooting

### Paste suddenly stops working after it was fine before (macOS)

Symptoms: the phone shows its normal "connected" state, dictation seems to work, but nothing lands in your editor. Check with:

```bash
launchctl list | grep vp-connect
```

If the `Status` column shows `78` (or any non-zero number) instead of `0`, the background service is crash-looping.

vp-connect ≥ 1.9 ships with a vendored Node runtime under `~/.vp-connect/runtime/`, so a stale `node` path is rare. If you upgraded from an older version and still see the issue, re-run:

```bash
npx vp-connect --uninstall && npx vp-connect@latest --install
```

This wipes the old install, downloads the vendored runtime, rewrites the LaunchAgent plist to point at it, and prints a fresh QR. Your phone pairing survives.

### Install fails behind a corporate proxy (TLS / cert errors)

If `npx vp-connect --install` errors with `CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or `SELF_SIGNED_CERT_IN_CHAIN`, you're likely behind a corporate proxy that rewrites HTTPS with its own root CA. vp-connect's runtime download doesn't speak the HTTP CONNECT proxy protocol. Fastest fix: skip the download and reuse a node you already trust:

```bash
VP_CONNECT_NODE="$(command -v node)" npx vp-connect --install
```

The LaunchAgent / Scheduled Task will be wired to that node instead of a vendored copy. Caveat: if that node later moves, you'll need to re-run `--install`.

### Windows: install fails or `node.exe` disappears after extraction

Some antivirus products (Defender heuristics, Avast, AVG) briefly quarantine freshly-downloaded executables. If the install reports successful extraction but then can't find `node.exe`, check your AV's quarantine. The downloaded tarball is verified against the official nodejs.org SHA256 before extraction, so anything you see in quarantine is a false positive.

## How it works

`vp-connect` opens a TCP socket on port `38555`. The Vibephone iOS app connects over your local Wi-Fi and sends newline-delimited JSON. On connect the app sends a `hello` (wire protocol + app version); the server replies with `helloAck` including the running **vp-connect** semver so the phone can prompt you to upgrade if the Mac is behind.

| Command | What happens |
|---|---|
| Hold + speak | Text is pasted into your focused app |
| ENTER | Sends plain ↵. Submits in terminals, Cursor chat, Claude Code TUI, and single-line fields. |
| RUN | Sends ⌘↵ (Mac) / Ctrl+↵ (Windows). Submits in multi-line fields where plain ↵ inserts a newline — Slack, ChatGPT web, Google Docs comments, etc. Avoid in terminal-based Claude Code (⌘↵ toggles Terminal/iTerm fullscreen). |
| CLEAR | Clears the phone draft AND wipes the focused text field on your Mac/PC (⌘A ⌫ / Ctrl+A Del) — quickest way to "start over" when the dictation went sideways. |
| ESC | Sends the Escape key |
| ALLOW | Sends Ctrl+↵ — accepts Cursor's "allow action" prompt and Claude Code tool-use confirmations |
| STOP | Sends Ctrl+C — interrupts a running agent or terminal command |
| Trackpad   | macOS: full MacBook-trackpad gestures. **1 finger drag** moves the Mac cursor (CGEventMouseMoved). **1 finger tap** = primary click. **2 finger drag** = pixel-smooth scroll (Core Graphics scroll-wheel events with momentum, honours natural-scroll). **2 finger tap** = secondary (right) click. Windows / fallback: arrow-key ticks (↑ ↓ ← →). |

## Architecture

`vp-connect` is a small Node TCP server (`bin/vp-connect.js`) plus a
**native Swift helper** (`vendor/macos/vp-helper`) that does the actual
CoreGraphics event injection. The helper is a tiny universal binary
(~200 KB) that ships prebuilt inside the npm tarball, so installation is
unchanged: `npx vp-connect --install` copies both files to
`~/.vp-connect/`.

If the native helper is missing or unrunnable on your Mac (very rare —
unsupported architecture, restrictive enterprise MDM, etc.), vp-connect
falls back to a JXA helper script automatically. Same behavior, slightly
higher latency on pointer drags. See `vendor/macos/README.md` for build
details.

## Security notes

- **Vendored Node runtime is verified.** The Node binary downloaded into `~/.vp-connect/runtime/` is checked against a hardcoded SHA256 from nodejs.org's official `SHASUMS256.txt` before extraction. A mismatch aborts the install — vp-connect will never run an unverified binary.
- **Accessibility permission is binary-bound, not script-bound.** Once you grant Accessibility to `~/.vp-connect/runtime/.../bin/node`, anything that exec's that exact binary inherits the permission. This is inherent to macOS TCC and applies equally to granting Accessibility to system `node` (e.g. `/usr/local/bin/node`). Don't run untrusted scripts through the vendored binary.
- **Bumping the Node pin may require a re-grant.** When vp-connect bumps `NODE_VERSION`, the new binary has a fresh code-signing identity from TCC's perspective. The installer re-probes Accessibility automatically and shows the System Settings pane if a re-grant is needed.

## Tuning

| Env var | Default | Effect |
|---|---|---|
| `VP_POINTER_SENSITIVITY` | `1.7` | Cursor-acceleration multiplier for the phone trackpad. `1.0` = 1pt-finger maps to 1pt-on-Mac. Higher = faster. macOS only. |
| `VP_PORT` | `38555` | TCP port the server listens on. Change both ends if a firewall blocks the default. |
| `VP_LOG_TEXT` | unset | Set to `1` to log dictated text verbatim. **Off by default** — dictated text can contain passwords or private code. |
| `VP_CONNECT_NODE` | unset | Path to a `node` binary to use instead of the vendored runtime. Set this on `npx vp-connect --install` to skip the ~45 MB download (e.g. air-gapped hosts, CI, or when you're sure your system node won't move). |

To override on the LaunchAgent, edit `~/Library/LaunchAgents/com.vibephone.vp-connect.plist`, add the env var inside the existing `EnvironmentVariables` dict, then `launchctl unload && launchctl load` it.

Pure JavaScript runtime (no Python, no native compile step). The vendored Node binary is verified against the official nodejs.org SHA256 before extraction.
