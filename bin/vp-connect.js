#!/usr/bin/env node
'use strict';

const net  = require('net');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const runtime = require('./runtime');

// ── Config ───────────────────────────────────────────────────────────────────

const PORT      = parseInt(process.env.VP_PORT || '38555', 10);
const MAC       = process.platform === 'darwin';
const WIN       = process.platform === 'win32';
const LABEL     = 'com.vibephone.vp-connect';
const TASK_NAME = 'vp-connect';

// Privacy: dictated text can contain passwords, secrets, or private code.
// By default we only log a summary (char + word count). Set VP_LOG_TEXT=1
// to log the actual text (useful for debugging, risky for shared machines).
const LOG_TEXT = process.env.VP_LOG_TEXT === '1';

const INSTALL_DIR = MAC
  ? path.join(os.homedir(), '.vp-connect')
  : path.join(process.env.APPDATA || os.homedir(), 'vp-connect');

const INSTALLED_BIN = path.join(INSTALL_DIR, 'vp-connect.js');
const PLIST_PATH    = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const TOKEN_PATH    = path.join(INSTALL_DIR, '.auth-token');

/** Persistent auth token shared between server and phone via QR code.
 *  Set at startup by loadOrCreateToken(). */
let AUTH_TOKEN = null;

/** Load an existing token from disk, or generate and persist a new one.
 *  The token is a 48-hex-char (24-byte) random string stored mode 0600. */
function loadOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

/** npm package version (for `helloAck` to the iPhone). */
let VP_CONNECT_VERSION = 'unknown';
(function readPackageVersion() {
  const tries = [
    path.join(__dirname, '..', 'package.json'), // npx / node_modules/vp-connect/bin → pkg root
    path.join(__dirname, 'package.json'),       // LaunchAgent: ~/.vp-connect/vp-connect.js + local mini package.json
  ];
  for (const p of tries) {
    try {
      VP_CONNECT_VERSION = require(p).version;
      return;
    } catch (_) { /* try next */ }
  }
})();

/**
 * Wire-protocol level negotiated with Vibephone over TCP (`hello` / `helloAck`).
 * Bump only when older vp-connect builds cannot safely serve newer phones.
 */
const WIRE_PROTOCOL = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Prints an ASCII QR code to stdout encoding a `vpconnect://HOST:PORT` URL.
 * The iOS app scans this to pair without relying on Bonjour — bypasses flaky
 * mDNS, AP isolation, and every other router-induced discovery failure.
 *
 * In-terminal only: no file saved to disk, no Preview auto-opened. If the
 * user closes the terminal, they can re-print by running `npx vp-connect`
 * (foreground) or `npx vp-connect --qr`.
 */
function printPairingQR(ip, port) {
  const url = AUTH_TOKEN
    ? `vpconnect://${ip}:${port}?token=${AUTH_TOKEN}`
    : `vpconnect://${ip}:${port}`;
  console.log('  Scan this QR from the Vibephone app → Connect:\n');
  qrcode.generate(url, { small: true }, (qr) => {
    // Indent each line so the QR sits under the host/port banner
    console.log(qr.split('\n').map(l => '    ' + l).join('\n'));
  });
  console.log(`  (QR encodes: ${url})\n`);
}

function exec(cmd) {
  return cp.execSync(cmd, { stdio: 'pipe' });
}

/** Run a PowerShell script encoded as Base64 to avoid all shell-escaping issues. */
function runPS(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  cp.execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { stdio: 'pipe' });
}

// ── macOS Accessibility permission ───────────────────────────────────────────

/**
 * On macOS, sending keystrokes via `osascript` requires the calling binary
 * (the `node` executable running vp-connect) to be granted Accessibility
 * permission in System Settings → Privacy & Security → Accessibility.
 *
 * The LaunchAgent runs headless, so macOS never prompts the user on its
 * own — the first paste silently fails with error 1002 and the user has
 * no idea why. We probe permission proactively during install, and guide
 * the user to fix it with a dialog + auto-opened settings pane.
 *
 * Returns { ok: true }                           → permission granted
 *         { ok: false, reason: 'accessibility' } → blocked by TCC (error 1002)
 *         { ok: false, reason: 'unknown', msg }  → some other failure
 */
function testAccessibility() {
  if (!MAC) return { ok: true };
  try {
    // Harmless probe — sends an empty keystroke that doesn't affect any app,
    // but still triggers the Accessibility TCC check and registers `node` in
    // the permission list if it's not there yet.
    cp.execFileSync('osascript', [
      '-e', 'tell application "System Events" to keystroke ""'
    ], { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (msg.includes('1002') || msg.toLowerCase().includes('not allowed')) {
      return { ok: false, reason: 'accessibility' };
    }
    return { ok: false, reason: 'unknown', msg };
  }
}

/**
 * Probe Accessibility against a *specific* node binary (typically the
 * vendored runtime). TCC binds permission to the process that calls
 * osascript, so a probe via the installer's node tells you nothing
 * about whether the LaunchAgent's node will succeed. By spawning the
 * vendored binary and having it run the same harmless keystroke probe,
 * we get an authoritative answer for the exact binary that will run
 * the service.
 *
 * Also useful when bumping NODE_VERSION: the new binary may have a
 * different cdhash / signature and TCC will treat it as a fresh
 * identity, requiring re-grant. This probe surfaces that immediately.
 */
function probeAccessibilityViaNode(nodeBin) {
  if (!MAC) return { ok: true };
  if (!nodeBin || !fs.existsSync(nodeBin)) {
    return { ok: false, reason: 'unknown', msg: 'node binary missing' };
  }
  // Runs in the spawned node: try osascript, exit codes encode the result.
  // 0 = ok, 2 = TCC block, 3 = other error.
  const probe =
    'try {' +
    '  require("child_process").execFileSync("osascript", ["-e", \'tell application "System Events" to keystroke ""\'], { stdio: "pipe", timeout: 5000 });' +
    '  process.exit(0);' +
    '} catch (e) {' +
    '  const m = String(e.stderr || e.message || "");' +
    '  if (m.includes("1002") || m.toLowerCase().includes("not allowed")) process.exit(2);' +
    '  process.exit(3);' +
    '}';
  try {
    cp.execFileSync(nodeBin, ['-e', probe], { stdio: 'pipe', timeout: 10_000 });
    return { ok: true };
  } catch (e) {
    if (e.status === 2) return { ok: false, reason: 'accessibility' };
    return { ok: false, reason: 'unknown', msg: String(e.stderr || e.message || '') };
  }
}

/** macOS-only. Opens the Accessibility settings pane and reveals the given binary in Finder. */
function openAccessibilitySetup(binary) {
  if (!MAC) return;
  try {
    cp.exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
    if (binary) cp.exec(`open -R "${binary}"`);
  } catch {}
}

/** macOS-only. Shows a native notification. Fire-and-forget. */
function macNotify(title, message) {
  if (!MAC) return;
  const t = String(title).replace(/["\\]/g, '\\$&');
  const m = String(message).replace(/["\\]/g, '\\$&');
  try { cp.exec(`osascript -e 'display notification "${m}" with title "${t}"'`); } catch {}
}

/** macOS-only. Shows a blocking modal dialog so the user can't miss the message. */
function macDialog(title, message) {
  if (!MAC) return;
  const t = String(title).replace(/["\\]/g, '\\$&');
  const m = String(message).replace(/["\\]/g, '\\$&');
  try {
    cp.execSync(
      `osascript -e 'display dialog "${m}" with title "${t}" buttons {"OK"} default button "OK" with icon caution'`,
      { stdio: 'pipe', timeout: 60_000 }
    );
  } catch {}
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

/**
 * macOS virtual key codes (CGKeyCode) and CGEventFlagMask_* values. These
 * are what we feed to the scroll-helper's "K:code,flags" protocol, which
 * posts the resulting keystroke via CGEventPost.
 *
 * Going through CGEventPost (rather than `tell application "System Events"
 * to keystroke …`) is the whole reason dictated text actually lands on
 * the Mac: the Apple Events path requires a second TCC permission
 * (Automation → System Events) that LaunchAgents cannot surface a prompt
 * for, so it silently 503's forever. CGEventPost piggybacks on the same
 * Accessibility permission we already grant for the scroll pad.
 */
const MAC_KEY = {
  v: 9, l: 37, a: 0, c: 8, u: 32,
  period: 47,
  return: 36, escape: 53, backspace: 51,
  up: 126, down: 125, left: 123, right: 124,
};
const MAC_FLAG = {
  SHIFT: 0x00020000,
  CTRL:  0x00040000,
  ALT:   0x00080000,
  CMD:   0x00100000,
};

/**
 * Fire a single key-down/key-up pair through the scroll helper.
 * Fire-and-forget; returns false if the helper isn't running so the
 * caller can skip / warn. Safe to call repeatedly for modifier
 * combinations (e.g. ⌘A then Delete for clearInput).
 */
function sendKey(keyCode, flags = 0) {
  if (!MAC) return false;
  if (!scrollHelper) {
    console.log(`[key→helper] DROPPED K:${keyCode|0},${flags|0} — helper not spawned`);
    return false;
  }
  if (!scrollHelper.stdin.writable) {
    console.log(`[key→helper] DROPPED K:${keyCode|0},${flags|0} — stdin not writable (helper exited?)`);
    return false;
  }
  try {
    const ok = scrollHelper.stdin.write(`K:${keyCode | 0},${flags | 0}\n`);
    // `write` returns false if the internal buffer is full (back-pressure),
    // but the data is still queued — so true=fully flushed, false=queued.
    // Both are "delivered to helper" from our perspective.
    console.log(`[key→helper] wrote K:${keyCode|0},${flags|0} (flushed=${ok})`);
    return true;
  } catch (e) {
    console.log(`[key→helper] THREW K:${keyCode|0},${flags|0} — ${e && e.message}`);
    return false;
  }
}

/** Pipe a relative mouse move into the scroll helper. dx/dy are point
 *  deltas straight from the phone — the helper applies sensitivity
 *  scaling. Fire-and-forget; returns false if the helper isn't running. */
function sendMouseMove(dx, dy) {
  if (!MAC) return false;
  if (!scrollHelper || !scrollHelper.stdin.writable) return false;
  try {
    scrollHelper.stdin.write(`M:${dx | 0},${dy | 0}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Click (left or right) at the current cursor position via the scroll
 *  helper. Mirrors a Mac-trackpad tap. */
function sendMouseClick(button) {
  if (!MAC) return false;
  if (!scrollHelper || !scrollHelper.stdin.writable) return false;
  const b = (button === 'right') ? 'right' : 'left';
  try {
    scrollHelper.stdin.write(`C:${b}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Paste text into the focused application.
 *
 *   Mac : copies via pbcopy (handles all Unicode), pastes with ⌘V
 *         synthesised through CGEventPost (via the scroll helper).
 *         The phone now drives the Mac mouse directly via the
 *         trackpad → tap-to-click flow, so the user is responsible
 *         for parking focus in their target text field before
 *         dictating. We never auto-toggle the chat panel any more
 *         (no speculative ⌘L) — it caused too many "panel closed
 *         on me" surprises in IDEs whose chat input we can't see.
 *
 *   Win : writes to a temp file, loads into clipboard via PowerShell,
 *         then Ctrl+V via SendKeys.
 */
function pasteText(text, platform) {
  if (MAC) {
    cp.execFileSync('pbcopy', [], { input: text, encoding: 'utf8', env: { ...process.env, LANG: 'en_US.UTF-8' } });
    sendKey(MAC_KEY.v, MAC_FLAG.CMD);

  } else if (WIN) {
    // Write to temp file to avoid any quoting issues
    const tmp = path.join(os.tmpdir(), `vp_clip_${process.pid}.txt`);
    fs.writeFileSync(tmp, text, 'utf8');
    const tmpEsc = tmp.replace(/\\/g, '\\\\');
    runPS(`
$t = [System.IO.File]::ReadAllText('${tmpEsc}', [System.Text.Encoding]::UTF8)
Set-Clipboard -Value $t
Remove-Item '${tmpEsc}' -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
`);
  }
}

/**
 * Trigger a named action (enter / run / esc / allow / interrupt / clearInput).
 * Mac : CGEventPost-synthesised key events via the scroll helper. No Apple
 *       Events, no Automation permission — piggybacks on the Accessibility
 *       permission already granted for scroll injection.
 * Win : PowerShell SendKeys.
 *
 * `enter` = plain ↵. Submits in most chat apps and terminals.
 * `run`   = ⌘↵ (Mac) / Ctrl+↵ (Win). Submits in multi-line text fields where
 *           plain ↵ inserts a newline (Slack, ChatGPT web, Google Docs
 *           comments, etc.). Warning: in terminal-based UIs (Terminal.app,
 *           iTerm, Warp running Claude Code), ⌘↵ toggles full-screen — so
 *           use `enter` there, not `run`.
 * `allow` = Ctrl+↵. Cursor "allow action" / Claude Code tool-use approval.
 * `interrupt` = Ctrl+C. Stops the agent or sends SIGINT in a shell.
 * `toggleAgentMode` = ⌘. (Mac) / Ctrl+. (Win). Cursor/Windsurf "switch mode"
 *           shortcut — cycles Agent ↔ Ask ↔ Manual in the chat composer.
 *           IDE-only on the phone side; other platforms don't send this.
 * `clearInput` = ⌘A then Delete (Mac) / Ctrl+A then Delete (Win). Select all
 *           text in the focused field and wipe it — the Mac equivalent of the
 *           phone's "start over" button. For Claude Code in a terminal we
 *           use Ctrl+U instead, since readline "kill to beginning of line"
 *           clears the prompt cleanly without affecting scrollback.
 */
function pressKey(action) {
  if (MAC) {
    if (action === 'clearInput') {
      if (currentPlatform === 'claude-code') {
        sendKey(MAC_KEY.u, MAC_FLAG.CTRL);
      } else {
        sendKey(MAC_KEY.a, MAC_FLAG.CMD);
        sendKey(MAC_KEY.backspace, 0);
      }
      return;
    }
    switch (action) {
      case 'enter':     sendKey(MAC_KEY.return, 0);              break;
      case 'run':       sendKey(MAC_KEY.return, MAC_FLAG.CMD);   break;
      case 'esc':       sendKey(MAC_KEY.escape, 0);              break;
      case 'allow':     sendKey(MAC_KEY.return, MAC_FLAG.CTRL);  break;
      case 'interrupt': sendKey(MAC_KEY.c,      MAC_FLAG.CTRL);  break;
      case 'toggleAgentMode':
        sendKey(MAC_KEY.period, MAC_FLAG.CMD);                   break;
    }

  } else if (WIN) {
    if (action === 'clearInput') {
      runPS(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 20
[System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
`);
      return;
    }
    const keys = {
      enter: '{ENTER}', run: '^{ENTER}', esc: '{ESC}',
      allow: '^{ENTER}', interrupt: '^c',
      // SendKeys treats '.' literally, so Ctrl+. is just '^.'.
      toggleAgentMode: '^.',
    };
    if (keys[action]) runPS(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${keys[action]}')
`);
  }
}

/**
 * Fire a single arrow-key press for scroll. Used by the phone's scroll pad,
 * which can send up to ~18 ticks/second — so we deliberately dispatch
 * asynchronously (fire-and-forget) to avoid blocking the socket reader
 * while osascript / PowerShell spins up.
 *
 * Arrow keys are the universally-safe choice here: they work in terminals,
 * browsers, Cursor, and Claude Code's TUI, and they never steal keyboard
 * focus from whatever the user is currently typing into.
 */
function scrollTick(direction) {
  if (MAC) {
    const codes = {
      up:    MAC_KEY.up,    down:  MAC_KEY.down,
      left:  MAC_KEY.left,  right: MAC_KEY.right,
    };
    const code = codes[direction];
    if (code === undefined) return;
    sendKey(code, 0);

  } else if (WIN) {
    const keys = { up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}' };
    const k = keys[direction];
    if (!k) return;
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${k}')
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    cp.exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, (err) => {
      if (err) handleKeystrokeError(err, `scroll ${direction}`);
    });
  }
}

// ── Pixel-smooth scroll helper (macOS) ───────────────────────────────────────

// Tiny JXA (JavaScript-for-Automation) program run via `osascript -l JavaScript`
// that reads lines of "dx,dy\n" from stdin and posts real CGScrollWheel events.
// This is how we get Mac-trackpad-quality smooth scrolling: arrow keys jump a
// whole line at a time, but CGScrollWheel accepts sub-pixel precision and the
// target apps interpret it as a real trackpad gesture (including natural-scroll
// direction and smooth inertia rendering on their side).
const SCROLL_HELPER_JS = `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')

// System Events lets us ask the OS for the frontmost app's main window frame,
// which we use to route scroll events at the transcript area rather than at
// wherever the user's mouse cursor happens to sit. This keeps the Mac's
// pointer exactly where it is (including inside the chat typebox) while the
// scroll still lands on the scrollable content above — resolving the
// "pointer in typebox blocks trackpad" usability issue.
const SE = Application('System Events')

const stdin = $.NSFileHandle.fileHandleWithStandardInput
let buffer = ''

// ── Keyboard events via CGEventPost ──────────────────────────────────────────
// We synthesise keyboard events through CoreGraphics directly rather than
// via 'tell application "System Events" to keystroke …'. Two reasons:
//
//   1. The Apple Events route requires Automation permission on System
//      Events in addition to the Accessibility permission we already need
//      for CGScrollWheelEvent. LaunchAgents run headless, so the user is
//      never prompted — paste silently fails with error -1743. CGEventPost
//      only needs Accessibility, which is already granted for the scroll
//      path above.
//
//   2. One IPC channel for both scrolls and keys (via stdin protocol) means
//      fewer moving parts and no per-keystroke osascript spawn overhead.
//
// Protocol (line-oriented, newline-terminated):
//   "dx,dy"           → scroll pixels (back-compat, unprefixed).
//   "K:code,flags"    → keyboard event. code = CGKeyCode (virtual key),
//                       flags = bitmask of CGEventFlagMask_* values.
//   "M:dx,dy"         → relative mouse move in points. We sample the
//                       cursor's current location (cheap CGEvent call),
//                       add the scaled delta, and post a kCGEventMouseMoved
//                       event at the new spot.
//   "C:left|right"    → mouse click at the current cursor location. left
//                       = primary (1-finger tap on phone), right =
//                       secondary (2-finger tap).
const FLAG_SHIFT = 0x00020000  // kCGEventFlagMaskShift
const FLAG_CTRL  = 0x00040000  // kCGEventFlagMaskControl
const FLAG_ALT   = 0x00080000  // kCGEventFlagMaskAlternate
const FLAG_CMD   = 0x00100000  // kCGEventFlagMaskCommand

// CGEvent type constants (subset we use)
const EV_MOUSE_MOVED      = 5    // kCGEventMouseMoved
const EV_LEFT_MOUSE_DOWN  = 1    // kCGEventLeftMouseDown
const EV_LEFT_MOUSE_UP    = 2    // kCGEventLeftMouseUp
const EV_RIGHT_MOUSE_DOWN = 3    // kCGEventRightMouseDown
const EV_RIGHT_MOUSE_UP   = 4    // kCGEventRightMouseUp
const BTN_LEFT  = 0              // kCGMouseButtonLeft
const BTN_RIGHT = 1              // kCGMouseButtonRight

// Cursor-acceleration multiplier. The phone sends raw point deltas from a
// finger drag; we scale them into Mac screen points so a slow swipe still
// feels precise but a fast flick covers usable distance. 1.0 = 1:1 (sluggish
// on a 6.9" phone). Tunable via VP_POINTER_SENSITIVITY env var.
const POINTER_SENS = (() => {
  const raw = $.NSProcessInfo.processInfo.environment.objectForKey('VP_POINTER_SENSITIVITY')
  const s = ObjC.unwrap(raw)
  const n = s ? parseFloat(s) : NaN
  return (isFinite(n) && n > 0) ? n : 1.7
})()

function postKey(keyCode, flags) {
  // Down + up paired as a single keystroke. Modifier flags are applied
  // to both events so target apps see a consistent modifier state for
  // the full duration of the press.
  const down = $.CGEventCreateKeyboardEvent($(), keyCode, true)
  const up   = $.CGEventCreateKeyboardEvent($(), keyCode, false)
  if (!down || !up) return
  if (flags) {
    $.CGEventSetFlags(down, flags)
    $.CGEventSetFlags(up, flags)
  }
  // kCGHIDEventTap = 0 — post at the HID-level tap so the event re-enters
  // the normal event pipeline and is delivered to whatever app is
  // frontmost, exactly like a real keyboard press.
  $.CGEventPost(0, down)
  $.CGEventPost(0, up)
}

// ── Mouse events (synthetic pointer + clicks) ────────────────────────────────
// Both mouse move and click need the cursor's current location: clicks
// are dispatched at wherever the pointer currently sits, mouse-move is a
// relative delta. CGEventCreate(NULL) returns a fresh event whose
// timestamped location is the live cursor position — much cheaper than
// querying System Events.
function currentCursor() {
  try {
    const evt = $.CGEventCreate($())
    if (!evt) return null
    const loc = $.CGEventGetLocation(evt)
    return { x: loc.x, y: loc.y }
  } catch (e) {
    return null
  }
}

function postMouseMove(dx, dy) {
  const cur = currentCursor()
  if (!cur) return
  const nx = cur.x + dx * POINTER_SENS
  const ny = cur.y + dy * POINTER_SENS
  // CGEventCreateMouseEvent(source, mouseType, mouseCursorPosition, mouseButton)
  // mouseButton is ignored for kCGEventMouseMoved but the API still
  // requires the slot — pass left as a harmless default.
  const evt = $.CGEventCreateMouseEvent($(), EV_MOUSE_MOVED, { x: nx, y: ny }, BTN_LEFT)
  if (!evt) return
  $.CGEventPost(0, evt)
}

function postMouseClick(button) {
  const cur = currentCursor()
  if (!cur) return
  const isRight = (button === 'right')
  const downType = isRight ? EV_RIGHT_MOUSE_DOWN : EV_LEFT_MOUSE_DOWN
  const upType   = isRight ? EV_RIGHT_MOUSE_UP   : EV_LEFT_MOUSE_UP
  const btn      = isRight ? BTN_RIGHT           : BTN_LEFT
  const down = $.CGEventCreateMouseEvent($(), downType, cur, btn)
  const up   = $.CGEventCreateMouseEvent($(), upType,   cur, btn)
  if (!down || !up) return
  $.CGEventPost(0, down)
  $.CGEventPost(0, up)
}

// Cached scroll target in global display coords (points, origin top-left).
// null → fall back to the current cursor location (pre-1.5 behaviour).
let target = null
let lastTickMs = 0
const BURST_GAP_MS = 300          // Refresh cache if a new scroll burst starts.
const MAX_TARGET_AGE_MS = 1500    // Force refresh during a long sustained scroll.
let targetFetchedMs = 0

// Cached frontmost-window frame + app name. Querying System Events costs
// ~30-100 ms per call which would tank scroll responsiveness if we did it
// per-tick, so we refresh only at burst boundaries. Mouse position, by
// contrast, is cheap (~microseconds via CGEventCreate) so we sample it
// fresh on every tick inside handleLine — this lets the scroll target
// follow the mouse in real time as the user hovers over different panes.
let cachedFrame = null   // { app, wx, wy, wW, wH }

function nowMs() {
  return $.NSDate.date.timeIntervalSince1970 * 1000
}

// Read the current mouse position in global display coordinates. Returns
// null on failure. We use this as the preferred Cursor scroll target: macOS
// natively routes scroll events to whatever scroll view the mouse is over,
// so if the user hovers over the agent chat (as the phone's in-app hint
// suggests), scrolls hit the agent without any heuristics on our side.
function currentMouseLocation() {
  try {
    const evt = $.CGEventCreate($())
    if (!evt) return null
    const loc = $.CGEventGetLocation(evt)
    return { x: loc.x, y: loc.y }
  } catch (e) {
    return null
  }
}

// Compute the per-tick scroll target. Cheap — runs on every tick — so
// it tracks live mouse movement in real time.
//
// We route scrolls to wherever the user is hovering: the mouse position
// IS the target. Two reasons this is the right behaviour for every
// platform Vibephone drives:
//
//   1. It respects user intent. Hovering over the agent chat scrolls the
//      chat; hovering over the file editor (or a web page, or a terminal
//      split) scrolls that. No heuristics that can mis-route.
//   2. It works for apps whose internals we can't introspect (Electron
//      hides its web content from AX, browsers expose only the outer
//      chrome, terminals often lie about scroll areas). Mouse hover is
//      universally unambiguous.
//
// We return null whenever the mouse isn't over a meaningful target
// (no frontmost window, or mouse is outside that window). null means
// we skip CGEventSetLocation, so the scroll event falls through to
// the OS default — the actual mouse location. If the user stashed the
// mouse somewhere unscrollable, nothing happens, which is a clear
// signal to move the mouse back over the thing they want to scroll.
function computeTarget() {
  const m = currentMouseLocation()
  if (!m) return null
  const f = cachedFrame
  if (!f) return null
  const MARGIN = 4
  const inside =
    m.x >= f.wx + MARGIN && m.x <= f.wx + f.wW - MARGIN &&
    m.y >= f.wy + MARGIN && m.y <= f.wy + f.wH - MARGIN
  return inside ? { x: m.x, y: m.y } : null
}

// Refresh the cached frontmost-window frame. Called at burst boundaries
// only, since System Events queries are expensive. Per-tick logic reads
// cachedFrame + fresh mouse position to compute the final target.
function refreshFrame() {
  try {
    const front = SE.processes.whose({ frontmost: true })[0]
    if (!front) { cachedFrame = null; return }
    const wins = front.windows
    if (!wins || wins.length < 1) { cachedFrame = null; return }
    const w = wins[0]
    const p = w.position()
    const s = w.size()
    if (!p || !s) { cachedFrame = null; return }
    const wx = p[0], wy = p[1], wW = s[0], wH = s[1]
    if (wW < 100 || wH < 100) { cachedFrame = null; return }
    cachedFrame = { app: front.name(), wx, wy, wW, wH }
    targetFetchedMs = nowMs()
  } catch (e) {
    cachedFrame = null
  }
}

function handleLine(line) {
  // Keyboard event: "K:code,flags" — see protocol notes at top of file.
  if (line.length > 2 && line.charAt(0) === 'K' && line.charAt(1) === ':') {
    const kparts = line.slice(2).split(',')
    const kcode = parseInt(kparts[0], 10) | 0
    const kflags = kparts.length > 1 ? (parseInt(kparts[1], 10) | 0) : 0
    if (kcode > 0) postKey(kcode, kflags)
    return
  }

  // Mouse move: "M:dx,dy" — relative to the cursor's current position.
  if (line.length > 2 && line.charAt(0) === 'M' && line.charAt(1) === ':') {
    const mparts = line.slice(2).split(',')
    const mdx = parseInt(mparts[0], 10) | 0
    const mdy = parseInt(mparts[1], 10) | 0
    if (mdx || mdy) postMouseMove(mdx, mdy)
    return
  }

  // Mouse click: "C:left" or "C:right" — at the current cursor location.
  if (line.length > 2 && line.charAt(0) === 'C' && line.charAt(1) === ':') {
    postMouseClick(line.slice(2).trim())
    return
  }

  // Scroll event: "dx,dy" (legacy, no prefix).
  const parts = line.split(',')
  if (parts.length < 2) return
  const dx = parseInt(parts[0], 10) | 0
  const dy = parseInt(parts[1], 10) | 0
  if (!dx && !dy) return

  const t = nowMs()
  // Refresh the cached window frame at burst boundaries only (expensive
  // System Events query). The mouse-position component of the target is
  // re-read in computeTarget() on every tick.
  if (cachedFrame === null
      || (t - lastTickMs) > BURST_GAP_MS
      || (t - targetFetchedMs) > MAX_TARGET_AGE_MS) {
    refreshFrame()
  }
  lastTickMs = t

  target = computeTarget()

  // CGEventCreateScrollWheelEvent(source, units, wheelCount, wheel1, wheel2)
  //   units: 0 = pixel, 1 = line
  //   wheel1 = vertical   (positive scrolls content down / reveals earlier content)
  //   wheel2 = horizontal (positive scrolls content right / reveals earlier content)
  // The Mac applies the user's natural-scroll setting on top for us.
  const evt = $.CGEventCreateScrollWheelEvent($(), 0, 2, dy, dx)
  if (!evt) return
  // Stamp the event with an explicit target point when we have one. This
  // routes the scroll to that coordinate without moving the real mouse
  // cursor. kCGHIDEventTap = 0.
  if (target) {
    $.CGEventSetLocation(evt, { x: target.x, y: target.y })
  }
  $.CGEventPost(0, evt)
}

// Prime the frame cache BEFORE the first line arrives so the very first
// flick of a session doesn't pay the ~50-100 ms System Events lookup as
// visible scroll lag. Mouse position is always fresh (cheap to query).
refreshFrame()

while (true) {
  const data = stdin.availableData
  if (!data || data.length === 0) break
  const s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  const chunk = ObjC.unwrap(s)
  if (!chunk) continue
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) {
      try { handleLine(line) } catch (e) { /* ignore malformed lines */ }
    }
  }
}
`;

// ── Helper process management ────────────────────────────────────────────────
//
// We have two implementations of the same line-protocol:
//
//   1. NATIVE  — `vendor/macos/vp-helper`, a tiny Swift CLI compiled to a
//      universal Mach-O. ~50–200 µs per event, no GC, no JS interpreter.
//      This is the default when the prebuilt binary is bundled with the
//      npm package (which it always is for published versions).
//
//   2. JXA     — the embedded JavaScript-for-Automation `SCROLL_HELPER_JS`
//      string above, run via `osascript -l JavaScript`. Slower (1–3 ms/
//      event with occasional 10–30 ms tail spikes) but works without any
//      native binary, so we keep it as a fallback for cases where the
//      shipped binary is missing or unrunnable.
//
// `scrollHelper` is the spawned child either way. The send* functions all
// just `write()` to its stdin so they don't care which implementation is
// running underneath.

const NATIVE_HELPER_INSTALLED = path.join(INSTALL_DIR, 'vp-helper');
const SCROLL_HELPER_PATH      = path.join(INSTALL_DIR, 'scroll-helper.js');

let scrollHelper = null;          // spawned child_process or null
let scrollHelperFailed = false;   // true once we've given up on restarting
let activeHelperKind = null;      // 'native' | 'jxa'

/** Resolve the path to the prebuilt native helper.
 *
 *  Resolution order:
 *    1. `~/.vp-connect/vp-helper`   — the path the installer copies it to.
 *       This is what runs after `npx vp-connect --install` completes.
 *    2. `<package>/vendor/macos/vp-helper` — the binary bundled inside the
 *       npm tarball / a local checkout. Used during foreground `npx
 *       vp-connect` runs and during development before --install. */
function findNativeHelper() {
  if (!MAC) return null;
  for (const p of [
    NATIVE_HELPER_INSTALLED,
    path.join(__dirname, '..', 'vendor', 'macos', 'vp-helper'),
  ]) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
    } catch {}
  }
  return null;
}

function ensureScrollHelperSource() {
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    if (!fs.existsSync(SCROLL_HELPER_PATH) ||
        fs.readFileSync(SCROLL_HELPER_PATH, 'utf8') !== SCROLL_HELPER_JS) {
      fs.writeFileSync(SCROLL_HELPER_PATH, SCROLL_HELPER_JS);
    }
  } catch (e) {
    console.log('[helper] cannot write JXA fallback script:', e.message);
    throw e;
  }
}

/** Spawn the native binary. Returns the child_process if it stayed up
 *  long enough to be considered healthy, or null if it failed to start. */
function spawnNativeHelper(binPath) {
  try {
    const child = cp.spawn(binPath, [], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (!child.pid) return null;
    return child;
  } catch (e) {
    console.log('[helper] native spawn failed:', e.message);
    return null;
  }
}

function spawnJxaHelper() {
  try {
    ensureScrollHelperSource();
    return cp.spawn('osascript', ['-l', 'JavaScript', SCROLL_HELPER_PATH], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (e) {
    console.log('[helper] JXA spawn failed:', e.message);
    return null;
  }
}

function startScrollHelper() {
  if (!MAC || scrollHelperFailed || scrollHelper) return;

  // Prefer the native binary when present. Fall back to JXA otherwise so
  // an unbuilt source checkout still works.
  let kind = null;
  let child = null;
  const nativePath = findNativeHelper();
  if (nativePath) {
    child = spawnNativeHelper(nativePath);
    if (child) kind = 'native';
  }
  if (!child) {
    child = spawnJxaHelper();
    if (child) kind = 'jxa';
  }
  if (!child) {
    console.log('[helper] could not start any backend — events will no-op');
    scrollHelperFailed = true;
    return;
  }

  scrollHelper = child;
  activeHelperKind = kind;

  scrollHelper.on('exit', (code, signal) => {
    console.log(`[helper:${activeHelperKind}] exited code=${code} signal=${signal || ''}`);
    scrollHelper = null;
    activeHelperKind = null;
    // If it died abnormally, retry once after a short delay. We try the
    // same backend first; if it keeps dying we'll naturally try the
    // fallback on the next attempt.
    if (!scrollHelperFailed) setTimeout(() => {
      if (!scrollHelper) startScrollHelper();
    }, 2000);
  });
  scrollHelper.on('error', (e) => {
    console.log(`[helper:${activeHelperKind}] spawn error:`, e.message);
    scrollHelperFailed = true;
    scrollHelper = null;
  });
  scrollHelper.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.log(`[helper:${activeHelperKind} stderr]`, msg);
  });
  if (kind === 'native') {
    console.log(`[helper] started (native vp-helper, low-latency event injection)`);
  } else {
    console.log('[helper] started (JXA fallback — install vp-helper for lower latency)');
  }
}

function stopScrollHelper() {
  if (!scrollHelper) return;
  try { scrollHelper.stdin.end(); } catch {}
  try { scrollHelper.kill(); } catch {}
  scrollHelper = null;
}

/** Fire-and-forget pixel-scroll. Returns false if the helper isn't running
 *  so the caller can fall back to arrow keys. */
function sendScrollPixel(dx, dy) {
  if (!MAC) return false;
  if (!scrollHelper || !scrollHelper.stdin.writable) return false;
  try {
    scrollHelper.stdin.write(`${dx},${dy}\n`);
    return true;
  } catch {
    return false;
  }
}

// Aggregate pixel scroll logs into bursts the same way we do for arrow keys.
const pixelBurst = { sumX: 0, sumY: 0, count: 0, timer: null };
function logScrollPixel(dx, dy) {
  pixelBurst.sumX += dx;
  pixelBurst.sumY += dy;
  pixelBurst.count += 1;
  if (pixelBurst.timer) clearTimeout(pixelBurst.timer);
  pixelBurst.timer = setTimeout(flushPixelBurst, 400);
}
function flushPixelBurst() {
  if (pixelBurst.count > 0) {
    console.log(
      `[scroll px · ${currentPlatform}] Δx=${pixelBurst.sumX} Δy=${pixelBurst.sumY} (${pixelBurst.count} ticks)`
    );
  }
  pixelBurst.sumX = 0;
  pixelBurst.sumY = 0;
  pixelBurst.count = 0;
  if (pixelBurst.timer) { clearTimeout(pixelBurst.timer); pixelBurst.timer = null; }
}

// ── Message handler ──────────────────────────────────────────────────────────

// Last platform the phone told us it is targeting. Currently informational —
// future versions will use this to pick a per-platform keymap.
let currentPlatform = 'cursor';

// Track accessibility-permission warnings so we only surface them to the
// user once per service lifetime (avoid notification spam on every paste).
let notifiedAccessibility = false;

// Coalesce consecutive scroll ticks so we log one line per "burst" instead
// of a line per tick (the phone's scroll pad fires up to ~18 ticks/sec).
const scrollBurst = { dir: null, count: 0, timer: null };
function logScrollTick(direction) {
  if (scrollBurst.dir !== direction) {
    flushScrollBurst();
    scrollBurst.dir = direction;
    scrollBurst.count = 0;
  }
  scrollBurst.count += 1;
  if (scrollBurst.timer) clearTimeout(scrollBurst.timer);
  scrollBurst.timer = setTimeout(flushScrollBurst, 400);
}
function flushScrollBurst() {
  if (scrollBurst.dir && scrollBurst.count > 0) {
    console.log(`[scroll ${scrollBurst.dir} · ${currentPlatform}] x${scrollBurst.count}`);
  }
  scrollBurst.dir = null;
  scrollBurst.count = 0;
  if (scrollBurst.timer) { clearTimeout(scrollBurst.timer); scrollBurst.timer = null; }
}

function handleKeystrokeError(e, context) {
  const msg = String(e.stderr || e.message || '');
  console.error(`[warn] ${context} failed:`, msg);
  if (!MAC) return;
  const isAccessibilityBlock = msg.includes('1002') || msg.toLowerCase().includes('not allowed');
  if (!isAccessibilityBlock || notifiedAccessibility) return;
  notifiedAccessibility = true;
  openAccessibilitySetup(process.execPath);
  macNotify(
    'vp-connect needs Accessibility permission',
    'Toggle ON "node" in System Settings → Accessibility, then try again.'
  );
}

function replyHelloAck(socket, msg, tokenOk = true) {
  const clientProto = Number(msg.protocol) || 0;
  const protoOk = clientProto >= 1 && clientProto <= WIRE_PROTOCOL;
  const ok = protoOk && tokenOk;
  const payload = {
    type: 'helloAck',
    ok,
    protocol: WIRE_PROTOCOL,
    negotiatedProtocol: ok ? clientProto : WIRE_PROTOCOL,
    vpConnect: VP_CONNECT_VERSION,
  };
  if (!ok) {
    if (!tokenOk) {
      payload.error = 'auth_failed';
      payload.upgradeHint = 'Re-scan the QR code from vp-connect to update your pairing token.';
    } else {
      payload.upgradeHint = 'Install a newer vp-connect: npx vp-connect@latest';
    }
  }
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch (_) { /* ignore */ }
  console.log(
    `[hello] protocol=${clientProto} app=${String(msg.app || '?')} → ok=${ok} vp-connect=${VP_CONNECT_VERSION}`,
  );
}

function handleMessage(msg, socket) {
  const type = String(msg.type || '');

  if (type === 'hello') {
    if (AUTH_TOKEN) {
      const tokenOk = String(msg.token || '') === AUTH_TOKEN;
      if (tokenOk) socket._vpAuth = true;
      replyHelloAck(socket, msg, tokenOk);
      if (!tokenOk) {
        console.log(`[auth] bad token from ${socket.remoteAddress}, closing`);
        socket.destroy();
      }
    } else {
      socket._vpAuth = true;
      replyHelloAck(socket, msg);
    }
    return;
  }

  if (AUTH_TOKEN && !socket._vpAuth) {
    console.log(`[auth] dropping ${type} from unauthenticated ${socket.remoteAddress}`);
    return;
  }

  // Every message may carry a `platform` stamp; keep it fresh for future
  // per-platform keymap routing.
  if (msg.platform) currentPlatform = String(msg.platform);

  if (type === 'text') {
    const text = String(msg.text || '').trim();
    if (!text) return;
    const summary = LOG_TEXT
      ? JSON.stringify(text)
      : `${text.length} chars, ${text.split(/\s+/).filter(Boolean).length} words`;
    console.log(`[text:${msg.mode || 'plain'} · ${currentPlatform}] ${summary}`);
    try { pasteText(text, currentPlatform); }
    catch (e) { handleKeystrokeError(e, 'paste'); }

  } else if (type === 'enter' || type === 'esc' || type === 'run'
          || type === 'allow' || type === 'interrupt' || type === 'clearInput'
          || type === 'toggleAgentMode') {
    console.log(`[${type} · ${currentPlatform}]`);
    try { pressKey(type); }
    catch (e) { handleKeystrokeError(e, `key (${type})`); }

  } else if (type === 'scroll') {
    const dir = String(msg.direction || '');
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
      console.log('[warn] invalid scroll direction:', JSON.stringify(msg));
      return;
    }
    logScrollTick(dir);
    try { scrollTick(dir); }
    catch (e) { handleKeystrokeError(e, `scroll (${dir})`); }

  } else if (type === 'scrollDelta') {
    // Pixel-smooth scroll from the iPhone trackpad. dx/dy are already signed
    // per Apple's CGScrollWheel convention so we pass them straight through.
    const dx = (parseInt(msg.dx, 10) || 0) | 0;
    const dy = (parseInt(msg.dy, 10) || 0) | 0;
    if (!dx && !dy) return;
    logScrollPixel(dx, dy);
    if (!sendScrollPixel(dx, dy)) {
      // Helper not running — fall back to a single arrow-key tick in the
      // dominant direction so scrolling still happens, just choppily.
      const absX = Math.abs(dx), absY = Math.abs(dy);
      if (absY >= absX) {
        scrollTick(dy > 0 ? 'up' : 'down');
      } else {
        scrollTick(dx > 0 ? 'left' : 'right');
      }
    }

  } else if (type === 'mouseMove') {
    // 1-finger drag on the phone trackpad → relative cursor move on the
    // Mac. Fire-and-forget at high rates (~60 Hz during a drag); we
    // aggregate logs into bursts so they don't spam the console.
    const dx = (parseInt(msg.dx, 10) || 0) | 0;
    const dy = (parseInt(msg.dy, 10) || 0) | 0;
    if (!dx && !dy) return;
    logMouseMove(dx, dy);
    sendMouseMove(dx, dy);

  } else if (type === 'mouseClick') {
    // 1-finger tap → primary click; 2-finger tap → secondary click.
    // Fired at the cursor's current screen location (whatever the user
    // just moved the pointer onto with mouseMove).
    const button = String(msg.button || 'left') === 'right' ? 'right' : 'left';
    console.log(`[click ${button} · ${currentPlatform}]`);
    sendMouseClick(button);

  } else if (type === 'platform') {
    // Phone announced a platform switch (or its initial platform on connect).
    // No keymap routing yet, but acknowledge it so we don't spam warnings.
    currentPlatform = String(msg.value || currentPlatform);
    console.log(`[platform] ${currentPlatform}`);

  } else {
    console.log('[warn] unknown message type:', JSON.stringify(msg));
  }
}

// Coalesce mouseMove ticks into bursts so dragging across the screen
// produces one log line per "gesture" instead of dozens per second.
const moveBurst = { sumX: 0, sumY: 0, count: 0, timer: null };
function logMouseMove(dx, dy) {
  moveBurst.sumX += dx;
  moveBurst.sumY += dy;
  moveBurst.count += 1;
  if (moveBurst.timer) clearTimeout(moveBurst.timer);
  moveBurst.timer = setTimeout(flushMoveBurst, 400);
}
function flushMoveBurst() {
  if (moveBurst.count > 0) {
    console.log(
      `[move px · ${currentPlatform}] Δx=${moveBurst.sumX} Δy=${moveBurst.sumY} (${moveBurst.count} ticks)`
    );
  }
  moveBurst.sumX = 0;
  moveBurst.sumY = 0;
  moveBurst.count = 0;
  if (moveBurst.timer) { clearTimeout(moveBurst.timer); moveBurst.timer = null; }
}

// ── TCP server ───────────────────────────────────────────────────────────────

function startServer() {
  AUTH_TOKEN = loadOrCreateToken();
  let currentIP = getLocalIP();

  // ── Network monitor ────────────────────────────────────────────────────────
  // Polls every 5s to detect IP changes (WiFi switch) or loss (airplane mode).
  function startNetworkMonitor() {
    return setInterval(() => {
      const newIP = getLocalIP();
      if (newIP === currentIP) return;

      if (newIP === '127.0.0.1') {
        console.log('[net] network lost — QR code unavailable until reconnected');
      } else {
        const wasOffline = currentIP === '127.0.0.1';
        console.log(wasOffline
          ? `[net] network restored — new IP: ${newIP}`
          : `[net] IP changed: ${currentIP} → ${newIP}`
        );
        printPairingQR(newIP, PORT);
      }
      currentIP = newIP;
    }, 5000);
  }

  // ── TCP server ─────────────────────────────────────────────────────────────
  const server = net.createServer(socket => {
    socket.setNoDelay(true);
    socket._vpAuth = !AUTH_TOKEN;
    console.log(`\n[conn] connected: ${socket.remoteAddress}`);

    const authTimer = AUTH_TOKEN ? setTimeout(() => {
      if (!socket._vpAuth) {
        console.log(`[auth] closing unauthenticated connection from ${socket.remoteAddress} (timeout)`);
        socket.destroy();
      }
    }, 5000) : null;

    let buf = '';

    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (buf.length > 1024 * 1024) {
        console.log(`[warn] buffer overflow from ${socket.remoteAddress}, closing`);
        socket.destroy();
        return;
      }
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { handleMessage(JSON.parse(trimmed), socket); }
        catch { console.log('[warn] invalid json:', JSON.stringify(trimmed)); }
      }
    });

    socket.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      flushScrollBurst();
      flushPixelBurst();
      flushMoveBurst();
      console.log('[conn] disconnected — waiting for phone…');
    });
    socket.on('error', e  => console.log('[warn] socket:', e.message));
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[error] Port ${PORT} is already in use.`);
      console.error(`  Is vp-connect already running?`);
      console.error(`  To uninstall the background service: npx vp-connect --uninstall\n`);
    } else {
      console.error('[error]', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    const line = '─'.repeat(50);
    console.log(line);
    console.log('  vp-connect  |  Vibephone server');
    console.log(line);
    console.log(`  Platform : ${process.platform}`);
    console.log(`  IP       : ${currentIP}`);
    console.log(`  Port     : ${PORT}`);
    console.log(line);

    if (currentIP === '127.0.0.1') {
      console.log('  [net] no network detected — QR code will appear once connected');
      console.log(line);
    } else {
      printPairingQR(currentIP, PORT);
      console.log(line);
    }

    startNetworkMonitor();
    startScrollHelper();
  });

  const cleanup = () => { stopScrollHelper(); process.exit(0); };
  process.on('exit',    () => { stopScrollHelper(); });
  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);
}

// ── Install as background service ────────────────────────────────────────────

async function install() {
  console.log('\nInstalling vp-connect as a background service…\n');

  // Copy this script + its sibling runtime module to a stable location so
  // the service can find them after npx cache clears.
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(__filename, INSTALLED_BIN);
  const runtimeSrc  = path.join(__dirname, 'runtime.js');
  const runtimeDest = path.join(INSTALL_DIR, 'runtime.js');
  fs.copyFileSync(runtimeSrc, runtimeDest);
  console.log(`  ✓ Scripts saved to ${INSTALL_DIR}`);

  // Copy the bundled native event-injection helper (Swift CLI) alongside,
  // preserving its executable bit + ad-hoc code signature. The runtime
  // resolver checks `INSTALL_DIR/vp-helper` first and only falls back to
  // the embedded JXA helper if the binary is missing or unrunnable.
  if (MAC) {
    const bundledHelper = path.join(__dirname, '..', 'vendor', 'macos', 'vp-helper');
    try {
      const st = fs.statSync(bundledHelper);
      if (st.isFile()) {
        fs.copyFileSync(bundledHelper, NATIVE_HELPER_INSTALLED);
        fs.chmodSync(NATIVE_HELPER_INSTALLED, 0o755);
        console.log(`  ✓ Native helper installed at ${NATIVE_HELPER_INSTALLED}`);
      } else {
        console.log('  i  Bundled vp-helper not found — JXA fallback will be used (slower)');
      }
    } catch {
      console.log('  i  Bundled vp-helper not found — JXA fallback will be used (slower)');
    }
  }

  // Vendor a private Node runtime under ~/.vp-connect/runtime/ so the
  // LaunchAgent / Scheduled Task is fully independent of the user's PATH.
  // Without this, `process.execPath` (whichever node ran the installer
  // — Hermes, OpenClaw, nvm, brew, system) gets baked into the service's
  // launch arguments. When that node later moves or disappears, the
  // service silently breaks. Vendoring pins the binary at a path we
  // control. See runtime.js for the full rationale.
  const { nodeBin, npmCli, vendored } = await runtime.ensureRuntime({ logger: console });

  // Install runtime deps into INSTALL_DIR using the *vendored* node + npm
  // so dep resolution is ABI-matched to the binary that will actually run
  // the service. Falls back to system npm only when VP_CONNECT_NODE was
  // set (i.e. the user opted out of vendoring).
  //
  // We wipe node_modules/ + package-lock.json first so a previous failed
  // install can't leave stale or partially-resolved trees behind. Cheap
  // hygiene; the working set is only ~3 MB.
  const pkg = require('../package.json') || {};
  const deps = pkg.dependencies || {};
  try { fs.rmSync(path.join(INSTALL_DIR, 'node_modules'),       { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(INSTALL_DIR, 'package-lock.json'),  { force: true }); } catch {}
  fs.writeFileSync(
    path.join(INSTALL_DIR, 'package.json'),
    JSON.stringify({
      name: 'vp-connect-install',
      version: pkg.version || '0.0.0',
      private: true,
      dependencies: deps,
    }, null, 2)
  );
  try {
    if (npmCli) {
      cp.execFileSync(nodeBin, [npmCli, 'install', '--no-audit', '--no-fund', '--silent'], {
        cwd: INSTALL_DIR,
        stdio: 'inherit',
      });
    } else {
      cp.execSync('npm install --no-audit --no-fund --silent', {
        cwd: INSTALL_DIR,
        stdio: 'inherit',
      });
    }
    console.log(`  ✓ Dependencies installed in ${INSTALL_DIR}`);
  } catch (e) {
    console.error('  ✗ Failed to install dependencies:', e.message);
    console.error('    The service will crash on launch. Install deps manually:');
    console.error(`      cd ${INSTALL_DIR} && ${nodeBin} ${npmCli || 'npm'} install`);
    process.exit(1);
  }

  if (MAC) {
    // LaunchAgent — starts on login, restarts on crash
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${INSTALLED_BIN}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/vp-connect.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/vp-connect-err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>`;

    try { exec(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);
    exec(`launchctl load "${PLIST_PATH}"`);
    console.log(`  ✓ LaunchAgent installed and started`);

    // Probe Accessibility permission. The LaunchAgent runs headless, so if
    // we don't surface this now the user's first dictation will silently
    // fail with no hint about why. We guide them with a dialog + auto-
    // opened Accessibility pane + Finder reveal of the node binary.
    //
    // Critical: probe via the *vendored* node (the binary that will
    // actually run the LaunchAgent), not the installer's process node.
    // TCC binds permission to the calling binary's signature; a probe
    // via the wrong node tells us nothing about the service's eventual
    // permission state. This also surfaces re-grant requirements after
    // a NODE_VERSION bump where the new binary has a fresh cdhash.
    const probe = probeAccessibilityViaNode(nodeBin);
    if (!probe.ok && probe.reason === 'accessibility') {
      console.log('\n  ⚠  macOS needs one more permission: Accessibility.\n');
      console.log('  vp-connect sends keystrokes (Cmd+V to paste what you dictate)');
      console.log('  which macOS treats as a sensitive operation. Please grant it now:\n');
      console.log('    1. System Settings → Privacy & Security → Accessibility');
      console.log(`    2. Toggle ON the "node" entry  (${nodeBin})`);
      console.log('    3. If "node" isn\'t listed, drag it from the Finder window\n');

      openAccessibilitySetup(nodeBin);
      macNotify(
        'vp-connect needs Accessibility permission',
        'Toggle ON "node" in System Settings → Accessibility.'
      );
      macDialog(
        'vp-connect needs Accessibility permission',
        'macOS needs permission for vp-connect to paste what you dictate.\\n\\n'
        + 'System Settings is now open. Please toggle ON the "node" entry under Accessibility.\\n\\n'
        + 'If "node" is not in the list, drag it from the Finder window that just opened '
        + '(or click + and pick it from: ' + nodeBin + ').'
      );
      console.log('  → Re-run  npx vp-connect --verify  to confirm once you\'ve toggled it on.\n');
    } else {
      console.log('  ✓ Accessibility permission looks good');
    }

    console.log(`\n  Runs automatically on every login.`);
    console.log(`  Logs  →  tail -f /tmp/vp-connect.log`);
    console.log(`  Stop  →  npx vp-connect --uninstall\n`);

  } else if (WIN) {
    // Scheduled Task — runs at logon, hidden, restarts on failure
    runPS(`
$action   = New-ScheduledTaskAction -Execute '${nodeBin.replace(/\\/g, '\\\\')}' \`
                                    -Argument '"${INSTALLED_BIN.replace(/\\/g, '\\\\')}"'
$trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet \`
              -ExecutionTimeLimit (New-TimeSpan) \`
              -MultipleInstances  IgnoreNew \`
              -RestartCount       3 \`
              -RestartInterval    (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask   -TaskName '${TASK_NAME}' \`
                         -Action $action -Trigger $trigger -Settings $settings \`
                         -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName '${TASK_NAME}'
`);
    console.log(`  ✓ Scheduled Task installed and started`);
    console.log(`\n  Runs automatically on every login.`);
    console.log(`  Stop  →  npx vp-connect --uninstall\n`);
  }

  AUTH_TOKEN = loadOrCreateToken();
  printPairingQR(getLocalIP(), PORT);
  console.log(`  (Reprint QR anytime with:  npx vp-connect --qr)\n`);
}

// ── QR (reprint on demand) ───────────────────────────────────────────────────

/** Print the pairing QR to stdout without starting a server. Handy for
 *  re-pairing a new phone without reinstalling the background service. */
function printQROnly() {
  AUTH_TOKEN = loadOrCreateToken();
  const ip = getLocalIP();
  const line = '─'.repeat(50);
  console.log('');
  console.log(line);
  console.log('  vp-connect  |  Pair a phone');
  console.log(line);
  console.log(`  IP    : ${ip}`);
  console.log(`  Port  : ${PORT}`);
  console.log(line);
  printPairingQR(ip, PORT);
}

// ── Uninstall ────────────────────────────────────────────────────────────────

function uninstall() {
  if (MAC) {
    try { exec(`launchctl unload "${PLIST_PATH}"`); } catch {}
    try { fs.unlinkSync(PLIST_PATH); } catch {}
    try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
    console.log('✓ vp-connect removed.');

  } else if (WIN) {
    try {
      runPS(`
Stop-ScheduledTask      -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
`);
    } catch {}
    try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
    console.log('✓ vp-connect removed.');
  }
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * Checks whether everything vp-connect needs is actually set up. Currently
 * reports Accessibility permission status on macOS (the most common footgun).
 * Safe to run repeatedly.
 */
function verify() {
  console.log('\nChecking vp-connect setup…\n');

  if (!MAC) {
    console.log('  ✓ Not on macOS — Accessibility check skipped');
    return;
  }

  // The LaunchAgent runs under the *vendored* node (~/.vp-connect/runtime/…),
  // not whichever node is on the user's PATH right now. Probe through that
  // binary so the answer is authoritative for the actual service. Granting
  // Accessibility to any other node won't help.
  const vendoredNode = runtime.runtimeNodePath();
  const haveVendored = fs.existsSync(vendoredNode);
  const targetNode   = haveVendored ? vendoredNode : process.execPath;

  const probe = haveVendored
    ? probeAccessibilityViaNode(vendoredNode)
    : testAccessibility();
  if (probe.ok) {
    console.log('  ✓ Accessibility permission granted — paste will work');
    console.log(`    (probed via ${haveVendored ? 'vendored node' : 'installer node'}: ${targetNode})`);
    console.log('');
    return;
  }

  if (probe.reason === 'accessibility') {
    console.log('  ✗ Accessibility permission NOT granted');
    console.log('');
    console.log('  Fix:');
    console.log('    1. System Settings → Privacy & Security → Accessibility');
    console.log(`    2. Toggle ON the "node" entry  (${targetNode})`);
    console.log('    3. If "node" is missing, drag it from the Finder window\n');
    openAccessibilitySetup(targetNode);
    return;
  }

  console.log('  ⚠  Could not probe Accessibility:', probe.msg || '(unknown)');
  console.log('');
}

// ── Entry ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg === '--install') {
  install().catch((e) => {
    console.error('\n  ✗ Install failed:', e && e.message ? e.message : e);
    console.error('    If this was a network issue, retry:  npx vp-connect --install');
    console.error('    To skip the runtime download, point at an existing node:');
    console.error('      VP_CONNECT_NODE=/path/to/node npx vp-connect --install\n');
    process.exit(1);
  });
}
else if (arg === '--uninstall') uninstall();
else if (arg === '--verify')    verify();
else if (arg === '--qr')        printQROnly();
else if (arg === '--version' || arg === '-v') {
  console.log(VP_CONNECT_VERSION);
  process.exit(0);
}
else                            startServer();
