# vp-connect

Mac & Windows server for the [Vibephone](https://github.com/vibephone/vibephone) iOS app.  
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

## How it works

`vp-connect` opens a TCP socket on port `38555`. The Vibephone iOS app connects over your local Wi-Fi and sends JSON commands:

| Command | What happens |
|---|---|
| Hold + speak | Text is pasted into your focused app |
| ENTER | Sends the Enter key |
| ESC | Sends the Escape key |
| ALLOW | Sends Ctrl+↵ — accepts Cursor's "allow action" prompt and Claude Code tool-use confirmations |
| STOP | Sends Ctrl+C — interrupts a running agent or terminal command |
| Trackpad   | macOS: pixel-smooth Core Graphics scroll-wheel events (honours your natural-scroll setting, supports momentum/flicks). Windows / fallback: arrow-key ticks (↑ ↓ ← →). Either way it never steals typing focus. |

No Python, no dependencies — just Node.js built-ins.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VP_PORT` | `38555` | TCP port to listen on |
| `VP_LOG_TEXT` | _unset_ | Set to `1` to log dictated text verbatim. Default logs only a `N chars, M words` summary so passwords or private code don't land in `/tmp/vp-connect.log`. |
