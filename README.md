# vp-connect

Mac & Windows server for the Vibr iOS app.  
Lets you dictate voice commands from your iPhone directly into Claude Code (or any IDE).

## Requirements

- Node.js 18+ — [nodejs.org](https://nodejs.org)
- Mac or Windows PC on the same Wi-Fi as your iPhone

## Install as a background service

Paste this into your terminal — it installs and starts the server automatically on every login:

```bash
npx vp-connect --install
```

The command prints a **QR code** at the end. In the Vibr app tap **Connect** and scan the QR — no typing required.

> **macOS note:** The installer will prompt you to grant **Accessibility** permission the first time. This is required so `vp-connect` can paste what you dictate (Cmd+V). System Settings will open automatically — toggle ON the `node` entry. After granting it, run `npx vp-connect --verify` to confirm.

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

If the `Status` column shows `78` (or any non-zero number) instead of `0`, the background service is crash-looping. The most common cause is a **stale `node` path** inside the LaunchAgent plist — the node binary that was present when you ran `--install` has since moved or been removed (nvm upgrade, homebrew cleanup, Cursor helper reshuffled, etc.). The plist still points at the old absolute path, so macOS can't launch the service.

Fix in one line — re-run the installer from a shell that has a working `node`:

```bash
npx vp-connect --install
```

This rewrites the plist with the node path from the shell you ran it in, bootstraps the service, and prints a fresh QR. Your phone pairing survives.

## How it works

`vp-connect` opens a TCP socket on port `38555`. The Vibr iOS app connects over your local Wi-Fi and sends JSON commands:

| Command | What happens |
|---|---|
| Hold + speak | Text is pasted into your focused app |
| ENTER | Sends plain ↵. Submits in terminals, Cursor chat, Claude Code TUI, and single-line fields. |
| RUN | Sends ⌘↵ (Mac) / Ctrl+↵ (Windows). Submits in multi-line fields where plain ↵ inserts a newline — Slack, ChatGPT web, Google Docs comments, etc. Avoid in terminal-based Claude Code (⌘↵ toggles Terminal/iTerm fullscreen). |
| CLEAR | Clears the phone draft AND wipes the focused text field on your Mac/PC (⌘A ⌫ / Ctrl+A Del) — quickest way to "start over" when the dictation went sideways. |
| ESC | Sends the Escape key |
| ALLOW | Sends Ctrl+↵ — accepts Cursor's "allow action" prompt and Claude Code tool-use confirmations |
| STOP | Sends Ctrl+C — interrupts a running agent or terminal command |
| Trackpad   | macOS: pixel-smooth Core Graphics scroll-wheel events (honours your natural-scroll setting, supports momentum/flicks). Scrolls are routed to **wherever your Mac's mouse cursor is parked** via `CGEventSetLocation`, so hover over the pane you want to scroll and the phone trackpad just drives it — no focus stealing, no cursor jump. Windows / fallback: arrow-key ticks (↑ ↓ ← →). |

No Python, no dependencies — just Node.js built-ins.
