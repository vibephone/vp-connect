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
//     path gets baked into the plist / scheduled task. When the agent
//     later updates, uninstalls, or swaps versions, the service silently
//     5xx's.
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
// builds, air-gapped hosts, or corporate proxies that intercept HTTPS
// (we don't speak the HTTP CONNECT proxy protocol — Node's stdlib
// doesn't include a proxy agent).

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const cp     = require('child_process');
const https  = require('https');
const crypto = require('crypto');

// ── Pinned Node version + verified hashes ────────────────────────────────────
//
// Bumping NODE_VERSION is a small ritual (4 steps):
//   1. Update NODE_VERSION below to the next LTS tag.
//   2. Replace ASSET_SHA256 from the new release's SHASUMS256.txt:
//        https://nodejs.org/dist/<version>/SHASUMS256.txt
//      Keep only the rows matching the assets we actually download
//      (darwin-arm64.tar.gz, darwin-x64.tar.gz, linux-arm64.tar.xz,
//      linux-x64.tar.xz, win-arm64.zip, win-x64.zip).
//   3. Run a real --install on macOS + Windows to confirm extraction
//      works and the post-install Accessibility re-probe surfaces.
//   4. Existing users auto-upgrade on next `npx vp-connect --install`,
//      and the prior runtime is swept by cleanStaleRuntimes.
//
// Keep this on a current LTS release. Node v22 is LTS through April
// 2027; schedule a bump to the next LTS (likely v24) by early 2027 to
// stay inside the upstream security-update window. After that date,
// vendored binaries get no security backports — strictly worse than
// using the user's `node`.

const NODE_VERSION = 'v22.11.0';

// SHA256 of each tarball/zip we may download. Verified after download
// and before extraction. Defends against:
//   • CDN compromise (CloudFront cache poisoning, etc.)
//   • MitM proxies with a corporate root CA in the trust store
//   • Corrupted partial downloads (mismatched sizes wouldn't be caught
//     by HTTP alone if the server omits Content-Length)
// Sourced from https://nodejs.org/dist/<version>/SHASUMS256.txt — that
// file is also PGP-signed by a Node release captain, but we don't
// currently chain to that signature (would require shipping GPG +
// Node-foundation public keys).
const ASSET_SHA256 = {
  'node-v22.11.0-darwin-arm64.tar.gz': '2e89afe6f4e3aa6c7e21c560d8a0453d84807e97850bbb819b998531a22bdfde',
  'node-v22.11.0-darwin-x64.tar.gz':   '668d30b9512137b5f5baeef6c1bb4c46efff9a761ba990a034fb6b28b9da2465',
  'node-v22.11.0-linux-arm64.tar.xz':  '6031d04b98f59ff0f7cb98566f65b115ecd893d3b7870821171708cdbaf7ae6e',
  'node-v22.11.0-linux-x64.tar.xz':    '83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72',
  'node-v22.11.0-win-arm64.zip':       'b9ff5a6b6ffb68a0ffec82cc5664ed48247dabbd25ee6d129facd2f65a8ca80d',
  'node-v22.11.0-win-x64.zip':         '905373a059aecaf7f48c1ce10ffbd5334457ca00f678747f19db5ea7d256c236',
};

const MAC   = process.platform === 'darwin';
const WIN   = process.platform === 'win32';
const LINUX = process.platform === 'linux';

const INSTALL_DIR = MAC
  ? path.join(os.homedir(), '.vp-connect')
  : path.join(process.env.APPDATA || os.homedir(), 'vp-connect');

const RUNTIME_DIR = path.join(INSTALL_DIR, 'runtime');

// Headroom for the download (compressed tarball + extracted tree +
// scratch). Empirically a v22.x macOS extracted runtime is ~110 MB and
// the .tar.gz another ~46 MB; rounded up to 200 MB for slack. We do a
// best-effort statfs check before downloading so users on a near-full
// disk get a clear error up front rather than a half-extracted tree.
const REQUIRED_BYTES = 200 * 1024 * 1024;

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
 *  never touched. The path-containment guarantee is doubled by using
 *  `path.join(RUNTIME_DIR, entry)` — `fs.rmSync` cannot escape
 *  RUNTIME_DIR no matter what `entry` contains. */
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

// ── Pre-flight checks ────────────────────────────────────────────────────────

/** Best-effort disk-space check before downloading. Throws if we can
 *  prove there's not enough room; silently passes if we can't query
 *  (older Node, unsupported FS, permission errors, …). */
function checkDiskSpace(dir, logger) {
  if (typeof fs.statfsSync !== 'function') {
    return; // Node <18.15 — skip silently.
  }
  let free;
  try {
    const s = fs.statfsSync(dir);
    free = Number(s.bsize) * Number(s.bavail);
  } catch {
    return; // Filesystem doesn't support statfs — skip.
  }
  if (free < REQUIRED_BYTES) {
    throw new Error(
      `Not enough disk space at ${dir}: ` +
      `have ${(free / 1e6).toFixed(0)} MB, need ~${(REQUIRED_BYTES / 1e6).toFixed(0)} MB.\n` +
      `Free up some space and re-run npx vp-connect --install.`
    );
  }
}

/** Mark RUNTIME_DIR as backup-excluded on macOS so 100 MB of vendored
 *  Node binaries don't bloat every Time Machine snapshot or sit
 *  permanently in the Spotlight index. Both calls are best-effort:
 *    • `.metadata_never_index` is honoured by Spotlight per-folder.
 *    • `tmutil addexclusion` excludes from Time Machine backups.
 *  Failures are non-fatal — the install still succeeds, the user just
 *  ends up with backups they didn't strictly need.
 *
 *  Windows File History / Search Indexer have no clean per-folder
 *  programmatic equivalents worth wiring up; this is a Mac-only
 *  optimization. */
function excludeFromBackups(logger) {
  if (!MAC) return;

  // Idempotency sentinel — once we've successfully tagged the dir
  // there's no value in re-running tmutil on every install (a single
  // call on an unusual FS can take a couple of seconds).
  const marker = path.join(RUNTIME_DIR, '.vp-backup-excluded');
  if (fs.existsSync(marker)) return;

  try {
    fs.writeFileSync(path.join(RUNTIME_DIR, '.metadata_never_index'), '');
  } catch {}
  try {
    cp.execFileSync('tmutil', ['addexclusion', RUNTIME_DIR], {
      stdio: 'pipe',
      timeout: 2_000,
    });
  } catch {}
  try {
    fs.writeFileSync(marker, '');
  } catch {}
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
    req.on('error', (err) => {
      f.close();
      try { fs.unlinkSync(dest); } catch {}
      // Surface the most common networking gotcha clearly.
      if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
          || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
        reject(new Error(
          `TLS error fetching Node runtime: ${err.code}.\n` +
          `If you're behind a corporate proxy that rewrites HTTPS, set\n` +
          `  VP_CONNECT_NODE=/path/to/your/node\n` +
          `to skip the download and reuse a node you already trust.`
        ));
      } else {
        reject(err);
      }
    });
  });
}

// ── Verification ─────────────────────────────────────────────────────────────

/** Compute SHA256 of `file` as lowercase hex. */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** Throws if the downloaded file's hash doesn't match the pinned one. */
async function verifyChecksum(p, logger) {
  const expected = ASSET_SHA256[p.asset.file];
  if (!expected) {
    throw new Error(
      `No SHA256 hash recorded for ${p.asset.file}. This is a packaging bug — ` +
      `please file an issue with your platform (${process.platform}/${process.arch}).`
    );
  }
  logger.log(`  ⊙ Verifying SHA256…`);
  const actual = await sha256(p.archive);
  if (actual !== expected) {
    try { fs.unlinkSync(p.archive); } catch {}
    throw new Error(
      `Checksum mismatch on downloaded Node runtime!\n` +
      `  asset    : ${p.asset.file}\n` +
      `  expected : ${expected}\n` +
      `  actual   : ${actual}\n` +
      `Refusing to extract a tampered binary. Possible causes:\n` +
      `  • Network corruption — retry the install.\n` +
      `  • Corporate proxy rewriting HTTPS payloads.\n` +
      `  • CDN compromise (rare but real).\n` +
      `If you trust your environment, override with:\n` +
      `  VP_CONNECT_NODE=/path/to/node npx vp-connect --install`
    );
  }
  logger.log(`  ✓ SHA256 matches  (${expected.slice(0, 12)}…)`);
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** Extract a Node tarball/zip into RUNTIME_DIR. Uses system `tar`, which:
 *    • macOS: BSD tar — handles .tar.gz and .tar.xz natively.
 *    • Linux: GNU tar — same.
 *    • Windows 10+ (1803): bsdtar via libarchive — handles .zip too.
 *  Node engines >=18 implies all three OSes are recent enough.
 *
 *  Path-traversal / symlink attacks in the tarball are subsumed by the
 *  SHA256 check above — we only ever extract bytes that match a hash
 *  we hardcoded against an upstream SHASUMS256.txt. */
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
  excludeFromBackups(logger); // Idempotent — safe to redo on every install.

  const p = paths();

  if (isReady(p)) {
    logger.log(`  ✓ Vendored Node ${NODE_VERSION} already present (${p.nodeBin})`);
    // Sweep stale siblings on idempotent runs too, so anyone who upgraded
    // from a pre-cleanup release gets their disk reclaimed automatically.
    cleanStaleRuntimes(p.folder, logger);
    return { nodeBin: p.nodeBin, npmCli: p.npmCli, vendored: true };
  }

  // Surface disk-space problems before we start a 45 MB download.
  checkDiskSpace(RUNTIME_DIR, logger);

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

  await verifyChecksum(p, logger);

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
