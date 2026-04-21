#!/usr/bin/env node
'use strict';

const net  = require('net');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const { Bonjour } = require('bonjour-service');
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
 * Mac : copies via pbcopy (handles all Unicode), pastes with Cmd+V via osascript.
 * Win : writes to a temp file, loads into clipboard via PowerShell, then Ctrl+V via SendKeys.
 */
function pasteText(text) {
  if (MAC) {
    cp.execFileSync('pbcopy', [], { input: text });
    exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);

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
 * Trigger a named action (enter / esc / run).
 * Mac : osascript key codes — no Accessibility permission needed for most key events.
 * Win : PowerShell SendKeys.
 */
function pressKey(action) {
  if (MAC) {
    const scripts = {
      enter : `osascript -e 'tell application "System Events" to key code 36'`,
      esc   : `osascript -e 'tell application "System Events" to key code 53'`,
      run   : `osascript -e 'tell application "System Events" to keystroke return using command down'`,
    };
    if (scripts[action]) exec(scripts[action]);

  } else if (WIN) {
    const keys = { enter: '{ENTER}', esc: '{ESC}', run: '^{ENTER}' };
    if (keys[action]) runPS(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${keys[action]}')
`);
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

// Last platform the phone told us it is targeting. Currently informational —
// future versions will use this to pick a per-platform keymap.
let currentPlatform = 'cursor';

// Track accessibility-permission warnings so we only surface them to the
// user once per service lifetime (avoid notification spam on every paste).
let notifiedAccessibility = false;

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

  } else if (type === 'enter' || type === 'esc' || type === 'run') {
    console.log(`[${type} · ${currentPlatform}]`);
    try { pressKey(type); }
    catch (e) { handleKeystrokeError(e, `key (${type})`); }

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
  const ip = getLocalIP();

  const server = net.createServer(socket => {
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

    socket.on('close', () => console.log('[conn] disconnected — waiting for phone…'));
    socket.on('error', e  => console.log('[warn] socket:', e.message));
  });

  // Advertise via Bonjour/mDNS so the iOS app can find us automatically
  // Delay publish by 5s to let any stale mDNS records from a previous run expire,
  // which prevents macOS from incrementing the LocalHostName on restart.
  const bonjour = new Bonjour();
  let svc;
  console.log('[mdns] waiting 5s before advertising to let stale records expire…');
  setTimeout(() => {
    svc = bonjour.publish({ name: 'vp-connect', type: 'vp-connect', port: PORT });
    svc.on('error', e => console.error('[mdns] advertise error:', e.message));
    console.log('[mdns] now advertising via Bonjour — QR code ready to scan');
  }, 5000);
  process.on('exit',    () => bonjour.destroy());
  process.on('SIGINT',  () => { bonjour.destroy(); process.exit(0); });
  process.on('SIGTERM', () => { bonjour.destroy(); process.exit(0); });

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
    console.log(`  IP       : ${ip}`);
    console.log(`  Port     : ${PORT}`);
    console.log(line);
    printPairingQR(ip, PORT);
    console.log(line);
  });
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
