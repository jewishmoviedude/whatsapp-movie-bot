#!/usr/bin/env bash
# Print whatsapp-bot.service as it should be installed on THIS machine.
#
#   deploy/render-whatsapp-bot-unit.sh <user> <group> <app-dir> <node-binary>
#
# The repo's whatsapp-bot.service is written for the first machine, and its
# ExecStart=/usr/local/bin/node is wrong on every NodeSource install, where
# node is /usr/bin/node: the unit fails with status 203/EXEC. The repo copy is
# pinned by test/service-unit.test.mjs, so it is left alone and the INSTALLED
# copy is templated from it instead - the four machine-specific lines are
# replaced and everything else (restart policy, stop timeout, hardening) is
# kept exactly as reviewed.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <user> <group> <app-dir> <node-binary>" >&2
  exit 2
fi
USER_NAME=$1 GROUP_NAME=$2 APP_DIR=$3 NODE_BIN=$4
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/whatsapp-bot.service"

for v in "$USER_NAME" "$GROUP_NAME" "$APP_DIR" "$NODE_BIN"; do
  # '#' is the sed delimiter below, and a newline would inject a unit line.
  if [[ -z $v || $v == *'#'* || $v == *$'\n'* || $v == *'\'* || $v == *'&'* ]]; then
    echo "render-whatsapp-bot-unit: refusing unsafe value: $v" >&2
    exit 2
  fi
done
[[ $APP_DIR == /* ]] || { echo "render-whatsapp-bot-unit: app dir must be absolute: $APP_DIR" >&2; exit 2; }
[[ $NODE_BIN == /* ]] || { echo "render-whatsapp-bot-unit: node must be an absolute path (systemd does not use PATH): $NODE_BIN" >&2; exit 2; }

sed -e "s#^User=.*#User=$USER_NAME#" \
    -e "s#^Group=.*#Group=$GROUP_NAME#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
    -e "s#^ExecStart=.*#ExecStart=$NODE_BIN src/index.js#" \
    "$SRC"
