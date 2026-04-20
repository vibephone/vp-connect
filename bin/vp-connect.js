#!/usr/bin/env node
'use strict';

const net  = require('net');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const { Bonjour } = require('bonjour-service');

// ── Config ───────────────────────────────────────────────────────────────────

const PORT      = parseInt(process.env.VP_PORT || '38555', 10);
const MAC       = process.platform === 'darwin';
const WIN       = process.platform === 'win32';
const LABEL     = 'com.vibephone.vp-connect';
const TASK_NAME = 'vp-connect';

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

function exec(cmd) {
  return cp.execSync(cmd, { stdio: 'pipe' });
}

/** Run a PowerShell script encoded as Base64 to avoid all shell-escaping issues. */
function runPS(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  cp.execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { stdio: 'pipe' });
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

function handleMessage(msg) {
  const type = String(msg.type || '');

  // Every message may carry a `platform` stamp; keep it fresh for future
  // per-platform keymap routing.
  if (msg.platform) currentPlatform = String(msg.platform);

  if (type === 'text') {
    const text = String(msg.text || '').trim();
    if (!text) return;
    console.log(`[text:${msg.mode || 'plain'} · ${currentPlatform}] ${JSON.stringify(text)}`);
    try { pasteText(text); }
    catch (e) { console.error('[warn] paste failed:', e.message); }

  } else if (type === 'enter' || type === 'esc' || type === 'run') {
    console.log(`[${type} · ${currentPlatform}]`);
    try { pressKey(type); }
    catch (e) { console.error(`[warn] key (${type}) failed:`, e.message); }

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
  const bonjour = new Bonjour();
  const svc = bonjour.publish({ name: 'vp-connect', type: 'vp-connect', port: PORT });
  svc.on('error', e => console.error('[mdns] advertise error:', e.message));
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
    console.log(`  Enter in the Vibephone app:`);
    console.log(`    Host → ${ip}`);
    console.log(`    Port → ${PORT}`);
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

  console.log(`  Enter in the Vibephone app:`);
  console.log(`    Host → ${getLocalIP()}`);
  console.log(`    Port → ${PORT}\n`);
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

// ── Entry ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if      (arg === '--install')   install();
else if (arg === '--uninstall') uninstall();
else                            startServer();
