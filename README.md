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

The command prints your IP address and port. Enter those in the Vibephone app to connect.

## Run manually (foreground)

If you just want to try it without installing:

```bash
npx vp-connect
```

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
| RUN | Sends ⌘↵ (Mac) or Ctrl+↵ (Windows) |

No Python, no dependencies — just Node.js built-ins.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VP_PORT` | `38555` | TCP port to listen on |
| `VP_LOG_TEXT` | _unset_ | Set to `1` to log dictated text verbatim. Default logs only a `N chars, M words` summary so passwords or private code don't land in `/tmp/vp-connect.log`. |
