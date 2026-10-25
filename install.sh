#!/usr/bin/env bash
# Installs system dependencies and the app. Safe to re-run.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR=20

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  warn "Run this as your normal user, not root. It will call sudo when needed."
  exit 1
fi

# apt-get does not wait for the dpkg lock, and on a first boot the daily apt
# jobs hold it within seconds (bot-box2, 2026-09-29): wait up to ten minutes
# rather than fail after every login in tools/bootstrap.sh has been done.
APT=(sudo apt-get -o DPkg::Lock::Timeout=600)

say "Installing ffmpeg and build tools"
"${APT[@]}" update -qq
"${APT[@]}" install -y ffmpeg curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt $NODE_MAJOR ]]; then
  say "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  "${APT[@]}" install -y nodejs
else
  say "Node $(node -v) already present"
fi

say "Installing npm packages"
cd "$APP_DIR"
npm install --omit=dev

say "Checking ffmpeg"
ffmpeg -version | head -1
ffprobe -version | head -1

mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"

# tools/bootstrap.sh runs this as one step of a rebuild, and says what to do
# next itself. Suggesting `npm start` there would be actively wrong: the old
# machine may still be holding the WhatsApp session.
if [[ ${BOOTSTRAP:-} == 1 ]]; then
  exit 0
fi

cat <<EOF

$(say "Done")

Start it now with:
    cd $APP_DIR && npm start

Or install it as a service that survives reboots, with this machine's
user, directory and node path filled in (installed only, never started):
    $APP_DIR/deploy/install-units.sh whatsapp-bot
and then, ONLY once no other machine runs this WhatsApp number (two on one
session is the fastest way to lose it - CLAUDE.md, rule 3):
    sudo systemctl enable --now whatsapp-bot

A new VM? One paste does all of this and restores the settings too:
docs/server-setup.md, "One paste: a new VM in one go".

Then open the control panel from any device on your network:
    http://$(hostname -I | awk '{print $1}'):8080

EOF
