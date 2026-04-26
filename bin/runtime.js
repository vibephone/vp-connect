'use strict';

// ── Vendored Node runtime ────────────────────────────────────────────────────
//
// vp-connect ships its own pinned copy of Node into
// ~/.vp-connect/runtime/ at install time, then writes the LaunchAgent /
// Scheduled Task to use *that* binary. This protects the background
// service from the user's PATH:
//
//   • Agent toolchains (Hermes, OpenClaw, Cursor's bundled node) often
//     drop their own `node` ahead of brew / nvm in PATH. If `npx
//     vp-connect --install` runs while one of those is active,
//     `process.execPath` resolves to the agent's node — and that exact
//     path gets baked into the plist. When the agent later updates,
//     uninstalls, or swaps versions, the LaunchAgent silently 5xx's.
//
//   • Version managers (nvm, asdf, fnm) similarly rebind `node` between
//     sessions, with the same failure mode.
//
// Vendoring makes the service node-version-stable: the binary lives at
// a path we control, with a version we pin, and survives every upstream
// shuffle. Disk cost is ~70-100 MB, paid once per major bump.
//
// Escape hatch: set VP_CONNECT_NODE=/path/to/node to skip the download
// and use a node binary you already trust. Useful for CI, sandboxed
// builds, or air-gapped hosts.

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const cp    = require('child_process');
const https = require('https');

// Pinned LTS. Bumping this schedules a one-time ~46 MB re-download for
// every existing install (next time they run --install). Pick a Node
// release that's been LTS for >=3 months to avoid trailing platform
// support gaps (Apple Silicon binaries arrived in v16, Linux arm64
// in v14, Windows arm64 in v20).
const NODE_VERSION = 'v22.11.0';

const MAC   = process.platform === 'darwin';
const WIN   = process.platform === 'win32';
const LINUX = process.platform === 'linux';

const INSTALL_DIR = MAC
  ? path.join(os.homedir(), '.vp-connect')
  : path.join(process.env.APPDATA || os.homedir(), 'vp-connect');

const RUNTIME_DIR = path.join(INSTALL_DIR, 'runtime');

// ── Platform asset map ───────────────────────────────────────────────────────

/** Returns the per-platform download asset descriptor.
 *
 *  Node's official dist server uses these conventions:
 *    macOS  : node-vXX.Y.Z-darwin-{arm64,x64}.tar.gz   → bin/node
 *    Linux  : node-vXX.Y.Z-linux-{arm64,x64}.tar.xz    → bin/node
 *    Windows: node-vXX.Y.Z-win-{arm64,x64}.zip         → node.exe
 */
function platformAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (MAC) return {
    folder: `node-${NODE_VERSION}-darwin-${arch}`,
    file:   `node-${NODE_VERSION}-darwin-${arch}.tar.gz`,
  };
  if (LINUX) return {
    folder: `node-${NODE_VERSION}-linux-${arch}`,
    file:   `node-${NODE_VERSION}-linux-${arch}.tar.xz`,
  };
  if (WIN) return {
    folder: `node-${NODE_VERSION}-win-${arch}`,
    file:   `node-${NODE_VERSION}-win-${arch}.zip`,
  };
  throw new Error(`vp-connect runtime: unsupported platform ${process.platform}/${process.arch}`);
}

function paths() {
  const a = platformAsset();
  const root = path.join(RUNTIME_DIR, a.folder);
  return {
    asset:         a,
    folder:        a.folder,
    archive:       path.join(RUNTIME_DIR, a.file),
    root,
    nodeBin:       WIN
      ? path.join(root, 'node.exe')
      : path.join(root, 'bin', 'node'),
    npmCli:        WIN
      ? path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    versionMarker: path.join(RUNTIME_DIR, '.installed-version'),
  };
}

function isReady(p) {
  try {
    if (!fs.statSync(p.nodeBin).isFile()) return false;
    if (!fs.statSync(p.npmCli).isFile()) return false;
    const marker = fs.readFileSync(p.versionMarker, 'utf8').trim();
    return marker === NODE_VERSION;
  } catch {
    return false;
  }
}

/** Remove any sibling `node-vX.Y.Z-<plat>-<arch>` directories under
 *  RUNTIME_DIR that aren't the current target. Run after we've confirmed
 *  the current target is good, so a botched upgrade can never leave the
 *  user with no runtime at all.
 *
 *  Without this, every `NODE_VERSION` bump would leave the previous
 *  ~100 MB extracted tree behind forever — disk usage grows monotonically
 *  with each vp-connect Node-pin upgrade.
 *
 *  We match strictly on the `node-v<digits>` prefix so user-created
 *  scratch dirs (or future non-runtime artefacts under runtime/) are
 *  never touched. */
function cleanStaleRuntimes(currentFolder, logger) {
  let entries;
  try {
    entries = fs.readdirSync(RUNTIME_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === currentFolder) continue;
    if (!/^node-v\d+\.\d+\.\d+-/.test(entry)) continue;
    const stale = path.join(RUNTIME_DIR, entry);
    try {
      fs.rmSync(stale, { recursive: true, force: true });
      logger.log(`  ⌫ Removed older Node runtime: ${entry}`);
    } catch (e) {
      logger.log(`  i  Could not remove ${entry}: ${e.message}`);
    }
  }
}

// ── HTTPS download with progress + redirect follow ───────────────────────────

function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error(`Too many redirects fetching ${url}`));

    const f = fs.createWriteStream(dest);
    f.on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });

    const req = https.get(url, { timeout: 120_000 }, (res) => {
      // Redirect handling — Cloudflare in front of nodejs.org can issue 30x
      // even on the canonical /dist/ paths, so follow them transparently.
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const next = res.headers.location;
        f.close();
        try { fs.unlinkSync(dest); } catch {}
        if (!next) return reject(new Error(`Redirect with no Location from ${url}`));
        return download(next, dest, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        f.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let bytes = 0;
      let lastReport = 0;
      const tty = process.stdout.isTTY;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (tty && total && Date.now() - lastReport > 250) {
          const pct = Math.min(100, Math.round((bytes / total) * 100));
          const mb  = (bytes / 1e6).toFixed(1).padStart(5, ' ');
          const tmb = (total / 1e6).toFixed(1);
          process.stdout.write(`\r    ↓ Node ${NODE_VERSION}  ${pct.toString().padStart(3, ' ')}%  (${mb} / ${tmb} MB)`);
          lastReport = Date.now();
        }
      });
      res.pipe(f);
      f.on('finish', () => {
        if (tty) process.stdout.write('\r' + ' '.repeat(60) + '\r');
        f.close(() => resolve());
      });
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out (120s)')));
    req.on('error', reject);
  });
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** Extract a Node tarball/zip into RUNTIME_DIR. Uses system `tar`, which:
 *    • macOS: BSD tar — handles .tar.gz and .tar.xz natively.
 *    • Linux: GNU tar — same.
 *    • Windows 10+ (1803): bsdtar via libarchive — handles .zip too.
 *  Node engines >=18 implies all three OSes are recent enough. */
function extract(archivePath) {
  cp.execFileSync('tar', ['-xf', archivePath, '-C', RUNTIME_DIR], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Ensure a vendored Node runtime is present at the canonical path.
 *  Idempotent: skips download if the pinned version is already installed.
 *
 *  Returns:
 *    { nodeBin, npmCli, vendored: true }   – using vendored runtime
 *    { nodeBin, npmCli: null, vendored: false } – VP_CONNECT_NODE override
 */
async function ensureRuntime({ logger = console } = {}) {
  const override = process.env.VP_CONNECT_NODE;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`VP_CONNECT_NODE points at a non-existent path: ${override}`);
    }
    logger.log(`  i  Using VP_CONNECT_NODE override: ${override}`);
    return { nodeBin: override, npmCli: null, vendored: false };
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const p = paths();

  if (isReady(p)) {
    logger.log(`  ✓ Vendored Node ${NODE_VERSION} already present (${p.nodeBin})`);
    // Sweep stale siblings on idempotent runs too, so anyone who upgraded
    // from a pre-cleanup release gets their disk reclaimed automatically.
    cleanStaleRuntimes(p.folder, logger);
    return { nodeBin: p.nodeBin, npmCli: p.npmCli, vendored: true };
  }

  // Clear out any partial state from a previous failed install of THIS
  // version. We deliberately leave older versions in place here — if the
  // download below fails, the old runtime is the only thing keeping the
  // user's service working, and we'd rather degrade gracefully than nuke
  // it preemptively.
  try { fs.rmSync(p.root,    { recursive: true, force: true }); } catch {}
  try { fs.rmSync(p.archive, { force: true }); } catch {}
  try { fs.rmSync(p.versionMarker, { force: true }); } catch {}

  const url = `https://nodejs.org/dist/${NODE_VERSION}/${p.asset.file}`;
  logger.log(`  ↓ Fetching Node ${NODE_VERSION}  (one-time, ~45 MB)`);
  logger.log(`    ${url}`);
  await download(url, p.archive);

  logger.log(`  ⇡ Extracting…`);
  extract(p.archive);
  try { fs.unlinkSync(p.archive); } catch {}

  if (!fs.existsSync(p.nodeBin)) {
    throw new Error(`Extraction completed but node binary not found at ${p.nodeBin}`);
  }
  fs.writeFileSync(p.versionMarker, NODE_VERSION);

  logger.log(`  ✓ Vendored Node ${NODE_VERSION} ready  (${p.nodeBin})`);

  // New runtime is verified working — now safe to evict the old one(s).
  cleanStaleRuntimes(p.folder, logger);

  return { nodeBin: p.nodeBin, npmCli: p.npmCli, vendored: true };
}

/** Path the runtime *would* be installed at — useful for cleanup paths
 *  without actually downloading. */
function runtimeNodePath() {
  return paths().nodeBin;
}

/** Remove the entire vendored runtime tree. Safe to call when not present. */
function removeRuntime() {
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch {}
}

module.exports = {
  NODE_VERSION,
  RUNTIME_DIR,
  ensureRuntime,
  runtimeNodePath,
  removeRuntime,
};
