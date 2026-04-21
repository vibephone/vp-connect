#!/usr/bin/env node
'use strict';

const net  = require('net');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const qrcode = require('qrcode-terminal');

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
  const url = `vpconnect://${ip}:${port}`;
  console.log('  Scan this QR from the Vibr app → Connect:\n');
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
 * Paste text into the focused application.
 *
 *   Mac : copies via pbcopy (handles all Unicode), pastes with ⌘V via
 *         osascript.
 *
 *         For Cursor specifically we *conditionally* prepend ⌘L (Cursor's
 *         "toggle chat panel" shortcut). The catch is that ⌘L really is a
 *         toggle — if chat is open AND focused, ⌘L closes it, the paste
 *         then lands in the code editor, and the autoSend Return adds a
 *         newline to the user's source file. Disastrous.
 *
 *         Heuristic to avoid that: only send ⌘L when Cursor is NOT the
 *         frontmost app. The reasoning:
 *           - Cursor in background → user is in browser/Slack/email and
 *             dictating to Cursor remotely. ⌘L brings Cursor forward and
 *             focuses chat. Original benefit preserved.
 *           - Cursor already frontmost → user just looked away from chat
 *             to grab the phone. ⌘L would be a coin flip (focuses chat
 *             if editor was active, closes chat if chat was active).
 *             Skipping ⌘L means the paste lands wherever they last
 *             clicked — almost always the chat input since that's what
 *             they were typing into a moment ago.
 *
 *         The frontmost-check + focus + paste happens in a single
 *         osascript invocation so we only pay for one process spawn.
 *
 *         Claude Code (terminal-based) and chat-web (no universal
 *         shortcut) don't get auto-focus at all; they rely on the user
 *         clicking the target themselves.
 *
 *   Win : writes to a temp file, loads into clipboard via PowerShell,
 *         then Ctrl+V via SendKeys.
 */
function pasteText(text) {
  if (MAC) {
    cp.execFileSync('pbcopy', [], { input: text });
    if (currentPlatform === 'cursor') {
      exec(
        `osascript ` +
        `-e 'tell application "System Events"' ` +
        `-e   'set frontApp to name of first process whose frontmost is true' ` +
        `-e   'if frontApp is not "Cursor" then' ` +
        `-e     'keystroke "l" using command down' ` +
        `-e     'delay 0.05' ` +
        `-e   'end if' ` +
        `-e   'keystroke "v" using command down' ` +
        `-e 'end tell'`
      );
    } else {
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    }

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
 * Mac : osascript key codes — no Accessibility permission needed for most key events.
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
 * `clearInput` = ⌘A then Delete (Mac) / Ctrl+A then Delete (Win). Select all
 *           text in the focused field and wipe it — the Mac equivalent of the
 *           phone's "start over" button.
 */
function pressKey(action) {
  if (MAC) {
    if (action === 'clearInput') {
      if (currentPlatform === 'claude-code') {
        // Ctrl+U = readline "kill to beginning of line" — clears the whole
        // terminal input without affecting anything else on screen.
        exec(`osascript -e 'tell application "System Events" to keystroke "u" using control down'`);
      } else {
        // ⌘A + Delete — select all text in the focused field then wipe it.
        exec(`osascript -e 'tell application "System Events" to keystroke "a" using command down'`);
        exec(`osascript -e 'tell application "System Events" to key code 51'`);
      }
      return;
    }
    const scripts = {
      enter     : `osascript -e 'tell application "System Events" to key code 36'`,
      run       : `osascript -e 'tell application "System Events" to keystroke return using command down'`,
      esc       : `osascript -e 'tell application "System Events" to key code 53'`,
      allow     : `osascript -e 'tell application "System Events" to keystroke return using control down'`,
      interrupt : `osascript -e 'tell application "System Events" to keystroke "c" using control down'`,
    };
    if (scripts[action]) exec(scripts[action]);

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
    // key codes: up=126, down=125, left=123, right=124
    const codes = { up: 126, down: 125, left: 123, right: 124 };
    const code = codes[direction];
    if (code === undefined) return;
    cp.exec(`osascript -e 'tell application "System Events" to key code ${code}'`, (err) => {
      if (err) handleKeystrokeError(err, `scroll ${direction}`);
    });

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

// Cached scroll target in global display coords (points, origin top-left).
// null → fall back to the current cursor location (pre-1.5 behaviour).
let target = null
let lastTickMs = 0
const BURST_GAP_MS = 300          // Refresh cache if a new scroll burst starts.
const MAX_TARGET_AGE_MS = 1500    // Force refresh during a long sustained scroll.
let targetFetchedMs = 0

function nowMs() {
  return $.NSDate.date.timeIntervalSince1970 * 1000
}

function refreshTarget() {
  try {
    const front = SE.processes.whose({ frontmost: true })[0]
    if (!front) { target = null; return }
    const wins = front.windows
    if (!wins || wins.length < 1) { target = null; return }
    const w = wins[0]
    const p = w.position()
    const s = w.size()
    if (!p || !s) { target = null; return }
    const x = p[0], y = p[1], W = s[0], H = s[1]
    if (W < 100 || H < 100) { target = null; return }
    // Aim at the upper-middle of the window — almost always inside the
    // transcript / editor pane, never inside the bottom-docked typebox.
    target = { x: x + W * 0.5, y: y + H * 0.30 }
    targetFetchedMs = nowMs()
  } catch (e) {
    target = null
  }
}

function handleLine(line) {
  const parts = line.split(',')
  if (parts.length < 2) return
  const dx = parseInt(parts[0], 10) | 0
  const dy = parseInt(parts[1], 10) | 0
  if (!dx && !dy) return

  const t = nowMs()
  // Refresh the target at the start of each scroll burst or whenever the
  // cache is too old, so app switches mid-session are picked up.
  if (target === null
      || (t - lastTickMs) > BURST_GAP_MS
      || (t - targetFetchedMs) > MAX_TARGET_AGE_MS) {
    refreshTarget()
  }
  lastTickMs = t

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

// Prime the target cache BEFORE the first line arrives so that the very
// first flick of a session doesn't pay the ~50-100 ms System Events lookup
// cost as visible scroll lag. Subsequent flicks within MAX_TARGET_AGE_MS
// reuse this cache for free.
refreshTarget()

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

const SCROLL_HELPER_PATH = path.join(INSTALL_DIR, 'scroll-helper.js');
let scrollHelper = null;          // spawned child_process or null
let scrollHelperFailed = false;   // true once we've given up on restarting

function ensureScrollHelperSource() {
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    if (!fs.existsSync(SCROLL_HELPER_PATH) ||
        fs.readFileSync(SCROLL_HELPER_PATH, 'utf8') !== SCROLL_HELPER_JS) {
      fs.writeFileSync(SCROLL_HELPER_PATH, SCROLL_HELPER_JS);
    }
  } catch (e) {
    console.log('[scroll-helper] cannot write helper script:', e.message);
    throw e;
  }
}

function startScrollHelper() {
  if (!MAC || scrollHelperFailed || scrollHelper) return;
  try {
    ensureScrollHelperSource();
    scrollHelper = cp.spawn('osascript', ['-l', 'JavaScript', SCROLL_HELPER_PATH], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    scrollHelper.on('exit', (code, signal) => {
      console.log(`[scroll-helper] exited code=${code} signal=${signal || ''}`);
      scrollHelper = null;
      // If it died abnormally, retry once after a short delay; give up if
      // it keeps dying (probably means JXA can't run on this box).
      if (!scrollHelperFailed) setTimeout(() => {
        if (!scrollHelper) startScrollHelper();
      }, 2000);
    });
    scrollHelper.on('error', (e) => {
      console.log('[scroll-helper] spawn error:', e.message);
      scrollHelperFailed = true;
      scrollHelper = null;
    });
    scrollHelper.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log('[scroll-helper stderr]', msg);
    });
    console.log('[scroll-helper] started (pixel-smooth scrolling active)');
  } catch (e) {
    scrollHelperFailed = true;
    scrollHelper = null;
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

function handleMessage(msg) {
  const type = String(msg.type || '');

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
    try { pasteText(text); }
    catch (e) { handleKeystrokeError(e, 'paste'); }

  } else if (type === 'enter' || type === 'esc' || type === 'run'
          || type === 'allow' || type === 'interrupt' || type === 'clearInput') {
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

  } else if (type === 'platform') {
    // Phone announced a platform switch (or its initial platform on connect).
    // No keymap routing yet, but acknowledge it so we don't spam warnings.
    currentPlatform = String(msg.value || currentPlatform);
    console.log(`[platform] ${currentPlatform}`);

  } else {
    console.log('[warn] unknown message type:', JSON.stringify(msg));
  }
}

// ── TCP server ───────────────────────────────────────────────────────────────

function startServer() {
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
    // Match the phone: disable Nagle so each scrollDelta / keystroke frame
    // is flushed immediately instead of waiting ~40 ms for coalescing.
    socket.setNoDelay(true);
    console.log(`\n[conn] connected: ${socket.remoteAddress}`);

    let buf = '';

    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop(); // hold incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { handleMessage(JSON.parse(trimmed)); }
        catch { console.log('[warn] invalid json:', JSON.stringify(trimmed)); }
      }
    });

    socket.on('close', () => {
      flushScrollBurst();
      flushPixelBurst();
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
    console.log('  vp-connect  |  Vibr server');
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

function install() {
  console.log('\nInstalling vp-connect as a background service…\n');

  // Copy this script to a stable location so the service can find it after npx cache clears
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(__filename, INSTALLED_BIN);
  console.log(`  ✓ Script saved to  ${INSTALLED_BIN}`);

  // Install runtime deps into INSTALL_DIR so the LaunchAgent can resolve them
  // independently of the npx cache (which may be cleaned between runs).
  const deps = (require('../package.json') || {}).dependencies || {};
  fs.writeFileSync(
    path.join(INSTALL_DIR, 'package.json'),
    JSON.stringify({ name: 'vp-connect-install', private: true, dependencies: deps }, null, 2)
  );
  try {
    cp.execSync('npm install --no-audit --no-fund --silent', {
      cwd: INSTALL_DIR,
      stdio: 'inherit',
    });
    console.log(`  ✓ Dependencies installed in ${INSTALL_DIR}`);
  } catch (e) {
    console.error('  ✗ Failed to install dependencies:', e.message);
    console.error('    The service will crash on launch. Install deps manually:');
    console.error(`      cd ${INSTALL_DIR} && npm install`);
    process.exit(1);
  }

  const nodeBin = process.execPath;

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
    const probe = testAccessibility();
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

  printPairingQR(getLocalIP(), PORT);
  console.log(`  (Reprint QR anytime with:  npx vp-connect --qr)\n`);
}

// ── QR (reprint on demand) ───────────────────────────────────────────────────

/** Print the pairing QR to stdout without starting a server. Handy for
 *  re-pairing a new phone without reinstalling the background service. */
function printQROnly() {
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

  const probe = testAccessibility();
  if (probe.ok) {
    console.log('  ✓ Accessibility permission granted — paste will work');
    console.log('');
    return;
  }

  if (probe.reason === 'accessibility') {
    console.log('  ✗ Accessibility permission NOT granted');
    console.log('');
    console.log('  Fix:');
    console.log('    1. System Settings → Privacy & Security → Accessibility');
    console.log(`    2. Toggle ON the "node" entry  (${process.execPath})`);
    console.log('    3. If "node" is missing, drag it from the Finder window\n');
    openAccessibilitySetup(process.execPath);
    return;
  }

  console.log('  ⚠  Could not probe Accessibility:', probe.msg || '(unknown)');
  console.log('');
}

// ── Entry ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if      (arg === '--install')   install();
else if (arg === '--uninstall') uninstall();
else if (arg === '--verify')    verify();
else if (arg === '--qr')        printQROnly();
else                            startServer();
