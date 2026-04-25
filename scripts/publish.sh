#!/usr/bin/env bash
# Publish vp-connect to the npm registry.
#
# Prerequisites:
#   • npm account with publish rights on the `vp-connect` package
#   • Logged in: npm login
#   • One-time 2FA: npm may prompt during publish
#
# Usage:
#   ./scripts/publish.sh              # dry-run then prompt, then publish
#   ./scripts/publish.sh --yes        # skip confirmation (CI / you know)
#   ./scripts/publish.sh --dry-run    # only npm pack dry run, no publish
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_ONLY=false
SKIP_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_ONLY=true ;;
    --yes|-y)    SKIP_CONFIRM=true ;;
  esac
done

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found" >&2
  exit 1
fi

npm whoami >/dev/null 2>&1 || {
  echo "Not logged in to npm. Run: npm login" >&2
  exit 1
}

echo "==> Rebuild native helper (also runs automatically via prepublishOnly)"
npm run build:helper

echo "==> Dry run (shows tarball contents)"
npm publish --dry-run

if [[ "$DRY_ONLY" == true ]]; then
  echo "Dry run only (--dry-run); not publishing."
  exit 0
fi

if [[ "$SKIP_CONFIRM" != true ]]; then
  read -r -p "Publish $(node -p "require('./package.json').name + '@' + require('./package.json').version") to npm? [y/N] " ans
  case "${ans:-}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
fi

echo "==> npm publish"
npm publish

echo "Done. Verify: npm view vp-connect version"
