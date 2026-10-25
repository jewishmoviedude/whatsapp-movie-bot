#!/usr/bin/env bash
# Launcher. Exists so NODE_EXTRA_CA_CERTS can be set before Node starts -
# Node reads it once at process start, so it cannot be applied from inside
# the app.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# Prefer a system node; fall back to one unpacked in ~/.local/node, which is
# how this gets installed when there is no sudo access.
if ! command -v node >/dev/null 2>&1 && [[ -x "$HOME/.local/node/bin/node" ]]; then
  export PATH="$HOME/.local/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[start] node not found. Run ./install.sh" >&2
  exit 1
fi

# Bundle every certificate dropped into certs/ into one file Node can read.
CERT_DIR="$APP_DIR/certs"
BUNDLE="$APP_DIR/data/extra-ca.pem"
shopt -s nullglob
CERTS=("$CERT_DIR"/*.crt "$CERT_DIR"/*.pem)
shopt -u nullglob

if [[ ${#CERTS[@]} -gt 0 ]]; then
  mkdir -p "$APP_DIR/data"
  cat "${CERTS[@]}" > "$BUNDLE"
  export NODE_EXTRA_CA_CERTS="$BUNDLE"
  echo "[start] trusting ${#CERTS[@]} extra CA certificate(s) from certs/"
else
  echo "[start] no extra CA certs found in certs/ - if outbound HTTPS fails, see certs/README.txt"
fi

exec node src/index.js
