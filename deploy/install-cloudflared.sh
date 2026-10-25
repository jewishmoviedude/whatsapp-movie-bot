#!/usr/bin/env bash
# Run the Cloudflare tunnel that serves the panel as a systemd service on this
# box, reading its token from a root-only file, and keep a copy of the token
# in .env so the sealed backup carries it to the next box.
#
#   deploy/install-cloudflared.sh                 the first time: asks for the token, hidden (the dashboard's
#                                                 Networking -> Tunnels -> the tunnel -> Add a replica; pasting
#                                                 its whole install command is fine)
#   deploy/install-cloudflared.sh --new-token     a new token for the tunnel here (rotated in the dashboard, or
#                                                 another tunnel): asked for hidden, or piped in on stdin; it
#                                                 replaces the old one in the token file and in .env
#   deploy/install-cloudflared.sh --from-env      the token in .env (CLOUDFLARE_TUNNEL_TOKEN): a rebuilt box
#   deploy/install-cloudflared.sh --from-docker   adopt the token of a running cloudflared container, then retire
#                                                 the containers that carry that token (and no others)
#   deploy/install-cloudflared.sh --from-unit     adopt the token of a unit that carries it on its command line
#                                                 (what `cloudflared service install <token>` writes)
#   deploy/install-cloudflared.sh --record-env    only copy the token the service uses into .env
#   deploy/install-cloudflared.sh --status        what is running now; changes nothing
#
#   --replace           let a token taken from the box (--from-*, --record-env) replace a
#                       DIFFERENT one already in /etc/cloudflared/tunnel-token or .env;
#                       without it that is refused, since two tokens are two tunnels
#   --non-interactive   sudo -n and no prompt: fail rather than wait for a person
#                       (tools/routines.mjs --fix)
#
# With no source named it uses the token already in
# /etc/cloudflared/tunnel-token, then the one in .env, and only then asks (or
# reads stdin, when something is piped in). TUNNEL_TOKEN_FILE=/path reads it
# from a file instead. Run it as the bot's user: it calls sudo for what it
# writes, and .env stays that user's.
#
# Why this exists: on 2026-09-30 the tunnel on bot-box2 was started with the
# Docker command the Cloudflare dashboard offers, `docker run
# cloudflare/cloudflared tunnel run --token ...`. The tunnel connected and
# every check passed, but every visit to the panel failed with "dial tcp
# [::1]:8080: connect: connection refused": in Docker's default bridge
# network, the ingress rule's http://localhost:8080 is the container's own
# loopback, where nothing listens, not the box where the panel does. The
# container also had no restart policy and no unit, so a reboot would have
# ended it. cloudflared belongs on the box itself, as a service.
#
# Cloudflare's own `cloudflared service install <token>` puts the token on
# the ExecStart line of a world-readable unit file, and in `ps` for every
# user. The token is the tunnel: whoever holds it can serve that hostname.
# So it goes in /etc/cloudflared/tunnel-token (root, 0600) and the unit reads
# it with --token-file. This script never prints or logs it, and never puts
# it on a command line, where every user can read it in /proc: it travels
# through pipes and shell variables only. A token that WAS on a command line
# (a container's, a unit's) is also in sudo's log of the command that put it
# there, so adopting one says to rotate it, and leaves a note
# (/etc/cloudflared/token-exposed) the routines check repeats until
# --new-token brings a different one.
#
# The copy in .env (mode 600, the bot's user) is what makes the tunnel
# survive a rebuild. .env is in the sealed backup's app bundle, encrypted
# (src/core/sealed-backup.js), so tools/bootstrap.sh gets it back and runs
# this with --from-env; before, the tunnel was "the one piece set up by
# hand", and by hand is how it went wrong. It is not called TUNNEL_TOKEN
# because cloudflared reads that name from its environment.
#
# A token found on the box never silently replaces a different one already
# recorded here: tools/routines.mjs --fix runs this with nobody watching, and
# a second cloudflared container for another tunnel must not take the
# panel's place in the token file, .env and the backup (review, 2026-09-30).
# Only a token a person hands over (--new-token, the prompt,
# TUNNEL_TOKEN_FILE) or --replace does that.
#
# The tunnel's hostnames and ingress rules live in the Cloudflare dashboard,
# not here: this script only runs the connector. Two boxes running the same
# token are two replicas of one tunnel, and Cloudflare sends each visit to
# either - so a box that does not run the bot must not run it
# (docs/server-setup.md, section 7; the cloudflare-tunnel routine).
#
# Exit: 0 done, 1 failed, 2 usage.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Where the files really go: / on a box. CLOUDFLARED_ROOT is for the tests,
# which run this against stub commands under a temporary directory. The
# paths the unit and the apt source name are the real ones either way.
ROOT=${CLOUDFLARED_ROOT:-}
TOKEN_PATH=/etc/cloudflared/tunnel-token
TOKEN_FILE=$ROOT$TOKEN_PATH
EXPOSED_PATH=/etc/cloudflared/token-exposed
EXPOSED=$ROOT$EXPOSED_PATH
ETC_DIR=$ROOT/etc/cloudflared
UNIT_DIR=$ROOT/etc/systemd/system
UNIT=$UNIT_DIR/cloudflared.service
SYSCTL=$ROOT/etc/sysctl.d/60-cloudflared-quic.conf
KEYRING_PATH=/usr/share/keyrings/cloudflare-main.gpg
LIST=$ROOT/etc/apt/sources.list.d/cloudflared.list
BIN=/usr/bin/cloudflared
ENV_FILE=${CLOUDFLARED_ENV_FILE:-$APP_DIR/.env}
ENV_KEY=CLOUDFLARE_TUNNEL_TOKEN
PANEL_PORT=${PANEL_PORT:-8080}
DOCKER=${DOCKER_BIN:-docker}
WAIT_SECONDS=${CLOUDFLARED_WAIT_SECONDS:-30}

usage() { sed -n '2,/^# Why this exists/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

MODE=install
SOURCE=''
SUDO=(sudo)
INTERACTIVE=1
REPLACE=0
while (( $# )); do
  case $1 in
    --from-docker) SOURCE=docker ;;
    --from-unit) SOURCE=unit ;;
    --from-env) SOURCE=env ;;
    --new-token) SOURCE=new ;;
    --replace) REPLACE=1 ;;
    --record-env) MODE=record ;;
    --status) MODE=status ;;
    --non-interactive) SUDO=(sudo -n); INTERACTIVE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-cloudflared: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if [[ $EUID -eq 0 ]]; then
  echo "install-cloudflared: run this as the bot's user, not root: it calls sudo itself, and .env must stay that user's" >&2
  exit 2
fi

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'install-cloudflared: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- helpers ---
# Each takes the token on stdin or hands it back on stdout, and says what
# went wrong without it: python3 -c "<program>" shows the program in ps, and
# never the token.

# A tunnel token, from what somebody pasted or a file held. The dashboard
# shows it inside a command (`cloudflared service install <token>`, `docker
# run ... --token <token>`), so a pasted command is taken apart rather than
# refused. A token is base64 of JSON with the account ("a"), the tunnel
# ("t") and its secret ("s"): anything else would only fail later, inside
# cloudflared, with the service restarted onto it.
PY_TOKEN=$(cat <<'PY'
import base64, binascii, json, re, sys
words = sys.stdin.read().split()
if not words:
    sys.exit("install-cloudflared: no token given")
if len(words) == 1:
    tok = words[0]
else:
    after = [words[i + 1] for i, w in enumerate(words[:-1]) if w in ("--token", "-token")]
    tok = (after or [w for w in words if w.startswith("eyJ")] or [""])[-1]
def valid(t):
    if not re.fullmatch(r"[A-Za-z0-9+/_=-]{40,}", t):
        return False
    try:
        d = json.loads(base64.b64decode(t.replace("-", "+").replace("_", "/") + "=" * (-len(t) % 4)))
    except (ValueError, binascii.Error):
        return False
    return isinstance(d, dict) and all(d.get(k) for k in ("a", "t", "s"))
if not valid(tok):
    sys.exit("install-cloudflared: that is not a Cloudflare tunnel token (the long eyJ... string the dashboard's install command ends with)")
print(tok)
PY
)

# The cloudflared containers, from `docker inspect` of every container (one
# JSON line each: id, image, entrypoint, state, network, restart policy,
# arguments, environment), after a first line holding the token the box
# already knows (or nothing). A container is cloudflared's when its image is
# .../cloudflared, whatever the tag or digest, or its entrypoint is
# cloudflared. The image is read from its configuration, not `docker ps`,
# which shows an image id instead once the tag has moved on to a newer
# image; and a DNS proxy (`cloudflared proxy-dns`), an exporter or another
# tunnel's container is never mistaken for this tunnel's (review,
# 2026-09-30: all of them were removed by the first version).
#   CF_DOCKER_MODE=adopt   the token of the running containers, then the ids
#                          of every container, running or stopped, that
#                          carries it; the others are named on stderr and left
#   CF_DOCKER_MODE=same    the short ids of running containers that carry the
#                          known token: second connectors of this tunnel
#   CF_DOCKER_MODE=status  a line for each
PY_DOCKER=$(cat <<'PY'
import json, os, sys
mode = os.environ.get("CF_DOCKER_MODE", "adopt")
dec = json.JSONDecoder()
known = sys.stdin.readline().strip()
def fields(line):
    out, i = [], 0
    while i < len(line):
        while i < len(line) and line[i] == " ":
            i += 1
        if i < len(line):
            v, i = dec.raw_decode(line, i)
            out.append(v)
    return out
def is_cloudflared(image, entry):
    last = (image or "").split("@", 1)[0].rsplit("/", 1)[-1].split(":", 1)[0]
    return last == "cloudflared" or os.path.basename(entry or "") == "cloudflared"
def token_of(args, env):
    t, args = None, args or []
    for j, a in enumerate(args):
        if a in ("--token", "-token") and j + 1 < len(args):
            t = args[j + 1]
        elif a.startswith(("--token=", "-token=")):
            t = a.split("=", 1)[1]
    for e in env or []:
        if t is None and e.startswith("TUNNEL_TOKEN="):
            t = e.split("=", 1)[1]
    return t or None
cs = []
for line in sys.stdin:
    try:
        cid, image, entry, state, net, restart, args, env = fields(line.strip())
    except ValueError:
        continue
    if is_cloudflared(image, entry):
        cs.append({"id": cid, "short": cid[:12], "state": state, "net": net, "restart": restart or "no", "token": token_of(args, env)})
if mode == "status":
    for c in cs:
        what = ("no tunnel token (a DNS proxy, or a tunnel run from a config file)" if not c["token"]
                else "this box's tunnel (the token file's token)" if known and c["token"] == known
                else "another tunnel's token" if known else "a tunnel token")
        print(f"container {c['short']}: {c['state']}, {c['net']} network, restart={c['restart']}, {what}")
elif mode == "same":
    print(" ".join(c["short"] for c in cs if c["state"] == "running" and known and c["token"] == known))
else:
    toks = {c["token"] for c in cs if c["token"] and c["state"] == "running"}
    if not toks:
        sys.exit("install-cloudflared: no running cloudflared container was started with a token (--token, or TUNNEL_TOKEN)")
    if len(toks) > 1:
        sys.exit("install-cloudflared: the running cloudflared containers carry different tokens, so they are different tunnels: "
                 "retire the one that is not the panel's by hand first (sudo docker ps; sudo docker rm -f <id>)")
    tok = toks.pop()
    print(tok)
    for c in cs:
        if c["token"] == tok:
            print(c["id"])
        else:
            why = "it carries another tunnel's token" if c["token"] else "it carries no tunnel token"
            print(f"install-cloudflared: container {c['short']} ({c['state']}) is left as it is: {why}", file=sys.stderr)
PY
)

# The token a unit carries on its ExecStart line, or as TUNNEL_TOKEN in an
# Environment= line, from the unit and its drop-ins on stdin.
PY_UNIT=$(cat <<'PY'
import shlex, sys
t = None
for line in sys.stdin.read().splitlines():
    line = line.strip()
    for key in ("ExecStart=", "Environment="):
        if not line.startswith(key):
            continue
        try:
            argv = shlex.split(line[len(key):])
        except ValueError:
            continue
        for j, a in enumerate(argv):
            if key == "ExecStart=" and a == "--token" and j + 1 < len(argv):
                t = argv[j + 1]
            elif key == "ExecStart=" and a.startswith("--token="):
                t = a.split("=", 1)[1]
            elif key == "Environment=" and a.startswith("TUNNEL_TOKEN="):
                t = a.split("=", 1)[1]
if not t:
    sys.exit("install-cloudflared: the installed cloudflared.service does not carry a token on its command line")
print(t)
PY
)

# A drop-in of cloudflared.service, on stdin, without what puts a token where
# every user can read it: every ExecStart= (the unit's own reads
# --token-file, and a drop-in's would replace it, --token and all) and every
# TUNNEL_TOKEN= assignment. The first version read the token out of a
# drop-in and left the drop-in as it was, world-readable, and still in
# charge of ExecStart (review, 2026-09-30). Prints the drop-in as it should
# be. Exit 0: nothing to take out; 10: changed; 11: nothing left in it.
PY_DROPIN=$(cat <<'PY'
import shlex, sys
out, changed = [], False
for line in sys.stdin.read().splitlines():
    s = line.strip()
    if s.startswith("ExecStart="):
        changed = True
        continue
    if s.startswith("Environment=") and "TUNNEL_TOKEN=" in s:
        try:
            words = shlex.split(s[len("Environment="):])
        except ValueError:
            changed = True
            continue
        kept = [w for w in words if not w.startswith("TUNNEL_TOKEN=")]
        if len(kept) != len(words):
            changed = True
            if kept:
                out.append("Environment=" + " ".join(shlex.quote(w) for w in kept))
            continue
    out.append(line)
if not changed:
    sys.exit(0)
print("\n".join(out))
left = [l for l in out if l.strip() and not l.strip().startswith(("#", ";", "["))]
sys.exit(10 if left else 11)
PY
)

# .env's CLOUDFLARE_TUNNEL_TOKEN, read the way dotenv reads it (the last
# line wins, and one pair of quotes comes off).
PY_ENV_READ=$(cat <<'PY'
import os, re, sys
key, path = os.environ["CF_ENV_KEY"], os.environ["CF_ENV_FILE"]
try:
    text = open(path, encoding="utf-8").read()
except OSError:
    sys.exit(3)
val = None
for line in text.splitlines():
    m = re.match(r"\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*?)\s*$", line)
    if m:
        v = m.group(1)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"`":
            v = v[1:-1]
        val = v
if not val:
    sys.exit(4)
print(val)
PY
)

# Put the token on stdin into .env as CLOUDFLARE_TUNNEL_TOKEN: replacing the
# line that is there rather than adding a second, leaving every other line as
# it was, and keeping the file 600 and its owner's (it is renamed into place,
# so it is written by that owner or not at all). A DIFFERENT token already
# there is replaced only with CF_ENV_REPLACE=1. Never creates .env: a .env
# made here would stop bootstrap restoring the real one, and the bot minting
# its MASTER_KEY. Says "unchanged", "recorded", "replaced" or "different"
# (left as it was); exit 3: no .env.
PY_ENV_WRITE=$(cat <<'PY'
import os, re, sys, tempfile
key, path = os.environ["CF_ENV_KEY"], os.environ["CF_ENV_FILE"]
replace = os.environ.get("CF_ENV_REPLACE") == "1"
tok = sys.stdin.read().strip()
if not re.fullmatch(r"[A-Za-z0-9+/_=-]+", tok):
    sys.exit("install-cloudflared: refusing to write a token with unexpected characters into .env")
try:
    st = os.stat(path)
    text = open(path, encoding="utf-8").read()
except FileNotFoundError:
    sys.exit(3)
if st.st_uid != os.getuid():
    sys.exit(f"install-cloudflared: {path} belongs to another user: run this as that user, so it stays theirs")
pat = re.compile(r"\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*?)\s*$")
def unquote(v):
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"`" else v
lines = text.splitlines()
vals = [unquote(m.group(1)) for m in map(pat.match, lines) if m]
if vals and all(v == tok for v in vals):
    print("unchanged")
    sys.exit(0)
if vals and not replace:
    print("different")
    sys.exit(0)
line = f"{key}={tok}"
at = next((i for i, l in enumerate(lines) if pat.match(l)), None)
kept = [l for l in lines if not pat.match(l)]
if at is None:
    kept.append(line)
else:
    kept.insert(min(at, len(kept)), line)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".env.tmp-")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(kept) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
os.chmod(path, 0o600)
print("replaced" if vals else "recorded")
PY
)

env_py() { CF_ENV_KEY=$ENV_KEY CF_ENV_FILE=$ENV_FILE python3 -c "$1"; }
env_token() { env_py "$PY_ENV_READ" 2>/dev/null || true; }

# A file as this user when it may read it, through sudo only when not. The
# unit and its drop-ins are world-readable as systemd writes them, and
# --status must say what they are even where sudo will not run (review,
# 2026-09-30: with sudo refused it called a --token-file unit "a config file").
read_file() { if [[ -r $1 ]]; then cat -- "$1"; else "${SUDO[@]}" cat -- "$1"; fi; }

# Whether the token file is there: 0 yes, 1 no, 2 cannot tell. The directory
# is 0755, so this user can see the file without reading it.
token_file_state() {
  if [[ ! -e $ETC_DIR || -x $ETC_DIR ]]; then [[ -s $TOKEN_FILE ]] && return 0; return 1; fi
  "${SUDO[@]}" test -s "$TOKEN_FILE" 2>/dev/null && return 0
  "${SUDO[@]}" true 2>/dev/null && return 1
  return 2
}

# The unit and its drop-ins, as systemd reads them; exit 1 when one of them
# could not be read.
unit_text() {
  local f
  for f in "$UNIT" "$UNIT".d/*.conf; do
    [[ -e $f ]] || continue
    read_file "$f" 2>/dev/null || return 1
  done
  return 0
}

# How the installed unit gets its token: file (ours), inline (on its command
# line: Cloudflare's service install), config (a locally-managed tunnel,
# with a config.yml and a credentials file) or unknown (unreadable). Never
# the token itself.
unit_style() {
  local text
  text=$(unit_text) || { echo unknown; return 0; }
  if grep -Eq -- '(^|[[:space:]])--token([[:space:]]+|=)[^[:space:]-]|(^|[^_A-Z])TUNNEL_TOKEN=' <<<"$text"; then echo inline
  elif grep -q -- '--token-file' <<<"$text"; then echo file
  else echo config; fi
}

unit_masked() {
  local en
  en=$(systemctl is-enabled cloudflared.service 2>/dev/null || true)
  [[ $en == masked* ]] || [[ -L $UNIT && $(readlink "$UNIT") == /dev/null ]]
}

# docker as root, or as this user where it is in the docker group; `docker
# ps` needs one or the other, and docker.io installs with neither.
docker_q() { "${SUDO[@]}" "$DOCKER" "$@" 2>/dev/null || "$DOCKER" "$@" 2>/dev/null; }
DOCKER_FMT='{{json .Id}} {{json .Config.Image}} {{json .Path}} {{json .State.Status}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.RestartPolicy.Name}} {{json .Args}} {{json .Config.Env}}'
# One line per container, for PY_DOCKER. Exit 1: docker is here and would
# not answer.
container_lines() {
  command -v "$DOCKER" >/dev/null 2>&1 || return 0
  local ids
  ids=$(docker_q ps -a -q --no-trunc) || return 1
  [[ -n $ids ]] || return 0
  # shellcheck disable=SC2086  # the ids are hex, one argument each
  docker_q inspect -f "$DOCKER_FMT" $ids || return 1
}

service_line() {
  # `systemctl is-enabled` prints "not-found" for a unit that is not there
  # AND exits non-zero, so an `|| echo` after it printed both, on two lines.
  local act en
  act=$(systemctl is-active cloudflared.service 2>/dev/null || true)
  en=$(systemctl is-enabled cloudflared.service 2>/dev/null || true)
  if [[ $en == masked* ]]; then echo "service: masked, so it cannot start (sudo systemctl unmask cloudflared, if it should run here)"
  elif [[ -z $en || $en == not-found ]]; then echo "service: no unit"
  else echo "service: ${act:-unknown}, $en"; fi
}

status() {
  if [[ -x $ROOT$BIN ]]; then
    echo "cloudflared: $("$ROOT$BIN" --version 2>/dev/null | head -1 || echo "$BIN, which does not run")"
  else
    echo "cloudflared: not installed"
  fi
  service_line
  if [[ -e $UNIT ]] && ! unit_masked; then
    case $(unit_style) in
      file) echo "unit: reads the token from $TOKEN_PATH" ;;
      inline) echo "unit: carries the token on its command line, where every user can read it (--from-unit moves it to $TOKEN_PATH)" ;;
      config) echo "unit: runs from a config file (a locally-managed tunnel)" ;;
      *) echo "unit: could not be read (it needs sudo, which would not run)" ;;
    esac
  fi
  local fs=0 known='' mode line
  token_file_state || fs=$?
  case $fs in
    0)
      line="token file: $TOKEN_PATH"
      mode=$(stat -c %a "$TOKEN_FILE" 2>/dev/null || "${SUDO[@]}" stat -c %a "$TOKEN_FILE" 2>/dev/null || true)
      if [[ $mode =~ ^[0-7]+$ ]] && (( 8#$mode & 8#077 )); then
        line+=", mode $mode: readable beyond root (sudo chmod 600 $TOKEN_PATH; the script sets it)"
      fi
      echo "$line"
      known=$(read_file "$TOKEN_FILE" 2>/dev/null) || known='' ;;
    1) echo "token file: none" ;;
    *) echo "token file: unknown ($ETC_DIR is closed to $(id -un), and sudo would not run)" ;;
  esac
  [[ -e $EXPOSED ]] && echo "token: $(head -1 "$EXPOSED" 2>/dev/null || echo 'taken from a command line'): rotate it in the dashboard, then --new-token"
  local envtok
  envtok=$(env_token)
  if [[ ! -e $ENV_FILE ]]; then
    echo ".env: none at $ENV_FILE"
  elif [[ -z $envtok ]]; then
    echo ".env: no $ENV_KEY, so the sealed backup does not carry the tunnel (--record-env)"
  elif [[ -n $known && $known == "$envtok" ]]; then
    echo ".env: $ENV_KEY, the same token as the token file"
  elif [[ -n $known ]]; then
    echo ".env: $ENV_KEY holds a DIFFERENT token from the token file (--record-env --replace copies the service's into .env)"
  elif (( fs == 0 )); then
    echo ".env: $ENV_KEY (not compared with the token file: reading it needs sudo, which would not run)"
  else
    echo ".env: $ENV_KEY (--from-env installs the service with it)"
  fi
  envtok=''
  if command -v "$DOCKER" >/dev/null 2>&1; then
    local lines seen
    if lines=$(container_lines); then
      # Said even when there are none: on bot-box2, after the move, silence
      # here read as "did not look" rather than "the containers are gone".
      if seen=$({ printf '%s\n' "$known"; printf '%s\n' "$lines"; } | CF_DOCKER_MODE=status python3 -c "$PY_DOCKER"); then
        echo "${seen:-containers: no cloudflared container}"
      else
        echo "containers: could not be read"
      fi
      seen=''
    else
      echo "containers: unknown (docker ps needs sudo, which would not run)"
    fi
    lines=''
  fi
  known=''
  return 0
}

# Copy $TOKEN into .env; replacing a different token there only when a
# person handed this one over, or said --replace. Returns 3 when there is no
# .env, 4 when .env holds a different token and was left as it was.
record_env() {
  local said rc=0
  said=$(printf '%s\n' "$TOKEN" | CF_ENV_REPLACE=$1 env_py "$PY_ENV_WRITE") || rc=$?
  case $rc in
    0) ;;
    3) return 3 ;;
    *) return 1 ;;
  esac
  case $said in
    unchanged) say ".env already holds this token as $ENV_KEY" ;;
    replaced) say "replaced the different token .env held with this one ($ENV_KEY)" ;;
    different)
      warn ".env holds a DIFFERENT $ENV_KEY from the token the service now runs, and was left as it is: two tokens are two tunnels. If the service's is the panel's: deploy/install-cloudflared.sh --record-env --replace"
      return 4 ;;
    *) say "recorded the token in .env as $ENV_KEY" ;;
  esac
  say "  .env is in the sealed backup (encrypted), so a rebuilt box brings the tunnel back with --from-env"
}

if [[ $MODE == status ]]; then status; exit 0; fi

if [[ $MODE == record ]]; then
  fs=0
  token_file_state || fs=$?
  (( fs != 2 )) || die "cannot tell whether $TOKEN_PATH is there: it needs sudo, which would not run"
  (( fs == 0 )) || die "no $TOKEN_PATH, so no token to record (deploy/install-cloudflared.sh installs the tunnel)"
  TOKEN=$(read_file "$TOKEN_FILE" | python3 -c "$PY_TOKEN") || die "could not read $TOKEN_PATH (it needs sudo)"
  rc=0
  record_env "$REPLACE" || rc=$?
  TOKEN=''
  (( rc == 3 )) && die "no .env at $ENV_FILE: this checkout is not a live install, so there is nowhere to record it"
  (( rc == 0 )) || exit 1
  exit 0
fi

# ------------------------------------------------------------- install ---

# A masked unit is somebody's decision that cloudflared must not run here.
# Writing through the mask writes /dev/null, and enabling it fails halfway,
# with the token file already rewritten (review, 2026-09-30).
unit_masked && die "cloudflared.service is masked here: somebody decided it must not run on this box. If it should: sudo systemctl unmask cloudflared, then run this again"

# 1. The token, into a shell variable - never an argument list - from where
#    it was asked for; then into the root-only file. What the box already
#    has is read first, to compare with.
fs=0
token_file_state || fs=$?
(( fs != 2 )) || die "cannot tell whether $TOKEN_PATH is there: it needs sudo, which would not run"
FILE_TOKEN=''
if (( fs == 0 )); then FILE_TOKEN=$(read_file "$TOKEN_FILE") || die "could not read $TOKEN_PATH (it needs sudo)"; fi
ENV_TOKEN=$(env_token)

read_new_token() {
  if [[ ! -t 0 ]]; then
    # Piped in: `printf '%s\n' "$T" | deploy/install-cloudflared.sh --new-token`.
    TOKEN=$(python3 -c "$PY_TOKEN") || die "no token on stdin ($1)"
  elif (( INTERACTIVE )); then
    local tok
    read -rsp "Tunnel token (Networking -> Tunnels -> the tunnel -> Add a replica; the whole install command will do): " tok; echo
    TOKEN=$(printf '%s\n' "$tok" | python3 -c "$PY_TOKEN") || { tok=''; die "no token"; }
    tok=''
  else
    die "no token: $1, and --non-interactive asks for none. Run deploy/install-cloudflared.sh at a terminal"
  fi
}

FROM_FILE=0
# A token a person hands over now replaces whatever the box had; one found
# on the box does not, unless --replace says so.
EXPLICIT=0
ADOPT_IDS=''
case $SOURCE in
  docker)
    lines=$(container_lines) || die "docker would not list its containers (it needs sudo)"
    out=$({ printf '\n'; printf '%s\n' "$lines"; } | CF_DOCKER_MODE=adopt python3 -c "$PY_DOCKER")
    lines=''
    TOKEN=$(head -n 1 <<<"$out" | python3 -c "$PY_TOKEN")
    ADOPT_IDS=$(tail -n +2 <<<"$out")
    out=''
    say "took the token from the running cloudflared container (the containers that carry it: $(for id in $ADOPT_IDS; do printf '%s ' "${id:0:12}"; done| sed 's/ $//'))" ;;
  unit)
    [[ -e $UNIT ]] || die "no cloudflared.service to take the token from"
    TOKEN=$(unit_text | python3 -c "$PY_UNIT" | python3 -c "$PY_TOKEN") || die "took no token from cloudflared.service or its drop-ins (see above; one that cannot be read needs sudo)"
    say "took the token from the installed cloudflared.service" ;;
  env)
    [[ -e $ENV_FILE ]] || die "no .env at $ENV_FILE"
    [[ -n $ENV_TOKEN ]] || die "$ENV_FILE has no $ENV_KEY"
    TOKEN=$(printf '%s\n' "$ENV_TOKEN" | python3 -c "$PY_TOKEN")
    say "took the token from .env ($ENV_KEY)" ;;
  new)
    EXPLICIT=1
    read_new_token "--new-token reads it from stdin or asks for it" ;;
  *)
    if [[ -n ${TUNNEL_TOKEN_FILE:-} ]]; then
      EXPLICIT=1
      TOKEN=$(read_file "$TUNNEL_TOKEN_FILE" | python3 -c "$PY_TOKEN")
      say "took the token from $TUNNEL_TOKEN_FILE"
    elif [[ -n $FILE_TOKEN ]]; then
      TOKEN=$(printf '%s\n' "$FILE_TOKEN" | python3 -c "$PY_TOKEN") || die "$TOKEN_PATH does not hold a tunnel token: deploy/install-cloudflared.sh --new-token"
      FROM_FILE=1
      say "using the token already in $TOKEN_PATH (a new one: --new-token)"
    elif [[ -n $ENV_TOKEN ]]; then
      TOKEN=$(printf '%s\n' "$ENV_TOKEN" | python3 -c "$PY_TOKEN")
      SOURCE=env
      say "using the token in .env ($ENV_KEY)"
    else
      EXPLICIT=1
      read_new_token "none in $TOKEN_PATH and none in .env"
    fi ;;
esac
[[ -n $TOKEN ]] || die "the token is empty"

# A token found on the box against a different one recorded here: two
# tunnels, and which is the panel's is a person's call. Nothing is written,
# restarted or removed.
REPLACE_ENV=0
(( EXPLICIT || REPLACE )) && REPLACE_ENV=1
if (( ! FROM_FILE && ! REPLACE_ENV )); then
  clash=()
  [[ -n $FILE_TOKEN && $FILE_TOKEN != "$TOKEN" ]] && clash+=("$TOKEN_PATH")
  [[ $SOURCE != env && -n $ENV_TOKEN && $ENV_TOKEN != "$TOKEN" ]] && clash+=(".env's $ENV_KEY")
  if (( ${#clash[@]} )); then
    TOKEN='' FILE_TOKEN='' ENV_TOKEN=''
    what=${SOURCE:-the token found}
    [[ $SOURCE == docker ]] && what="the container's token"
    [[ $SOURCE == unit ]] && what="the unit's token"
    [[ $SOURCE == env ]] && what=".env's token"
    printf -v where '%s and ' "${clash[@]}"
    die "$what is not the one in ${where% and }: they are two different tunnels, and nothing was changed. If $what is the panel's tunnel, run this again with --replace; if not, leave it (a container of another tunnel: sudo docker ps)"
  fi
fi
# Whether the token file will hold a different token from before: a
# rotation, when a person handed it over.
NEW_TOKEN=0
[[ $FILE_TOKEN != "$TOKEN" ]] && NEW_TOKEN=1
FILE_TOKEN='' ENV_TOKEN=''

# Only where it is missing: an existing, tighter /etc/cloudflared stays as
# it is (install -d re-modes one that is there, review 2026-09-30).
"${SUDO[@]}" test -d "$ETC_DIR" || "${SUDO[@]}" install -d -m 0755 "$ETC_DIR"
if (( ! FROM_FILE )); then
  printf '%s\n' "$TOKEN" | "${SUDO[@]}" install -m 0600 -o root -g root /dev/stdin "$TOKEN_FILE"
fi
# Root's and 0600 whichever way it got there: one written by hand with
# `echo ... | sudo tee` is 0644, and was reused as it was.
"${SUDO[@]}" chown root:root "$TOKEN_FILE"
"${SUDO[@]}" chmod 0600 "$TOKEN_FILE"
"${SUDO[@]}" test -s "$TOKEN_FILE" || die "the token file is empty"

# 2. The package, from Cloudflare's own repository (Ubuntu does not carry
#    it), updated by apt from then on.
if [[ ! -x $ROOT$BIN ]]; then
  say "installing cloudflared from pkg.cloudflare.com"
  "${SUDO[@]}" mkdir -p "$(dirname "$ROOT$KEYRING_PATH")" "$(dirname "$LIST")"
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | "${SUDO[@]}" tee "$ROOT$KEYRING_PATH" >/dev/null
  echo "deb [signed-by=$KEYRING_PATH] https://pkg.cloudflare.com/cloudflared any main" | "${SUDO[@]}" tee "$LIST" >/dev/null
  "${SUDO[@]}" apt-get -o DPkg::Lock::Timeout=600 update -qq
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq cloudflared
  [[ -x $ROOT$BIN ]] || die "the cloudflared package did not put $BIN in place"
fi

# 3. Bigger UDP buffers. cloudflared speaks QUIC and warns at every start that
#    Ubuntu's 208 KiB default is too small for it ("failed to sufficiently
#    increase receive buffer size"); quic-go asks for 7 MiB.
"${SUDO[@]}" mkdir -p "$(dirname "$SYSCTL")" "$UNIT_DIR"
printf 'net.core.rmem_max = 7500000\nnet.core.wmem_max = 7500000\n' | "${SUDO[@]}" tee "$SYSCTL" >/dev/null
"${SUDO[@]}" sysctl -q -p "$SYSCTL" || warn "could not apply $SYSCTL now; it applies at the next boot"

# 4. The unit. --no-autoupdate: the package is updated by apt, and a binary
#    replacing itself under systemd is how a tunnel goes missing.
"${SUDO[@]}" tee "$UNIT" >/dev/null <<EOF
# Written by deploy/install-cloudflared.sh - the tunnel that serves the panel.
# The token is in $TOKEN_PATH (root, 0600), never on this line: this file is
# world-readable.
[Unit]
Description=Cloudflare tunnel for the WhatsApp bot panel
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=$BIN --no-autoupdate tunnel run --token-file $TOKEN_PATH
Restart=on-failure
RestartSec=5s
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
# And its drop-ins, before the restart: one that sets ExecStart= would run
# cloudflared with its own line, token and all, instead of the one above.
for f in "$UNIT".d/*.conf; do
  [[ -e $f ]] || continue
  rc=0
  cleaned=$(read_file "$f" | python3 -c "$PY_DROPIN") || rc=$?
  case $rc in
    0) ;;
    10) printf '%s\n' "$cleaned" | "${SUDO[@]}" tee "$f" >/dev/null
        say "took the token and ExecStart= out of the drop-in $f" ;;
    11) "${SUDO[@]}" rm -f "$f"
        say "removed the drop-in $f: all it did was carry the token" ;;
    *) die "could not read the drop-in $f" ;;
  esac
  cleaned=''
done
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable cloudflared.service
since=$(date '+%Y-%m-%d %H:%M:%S')
"${SUDO[@]}" systemctl restart cloudflared.service

# 5. Up only once Cloudflare has registered a connection from it. Read whole,
#    not piped into `grep -q`: under pipefail, grep leaving early can fail
#    journalctl with SIGPIPE and make a registered tunnel look down.
up=0
for (( i = 0; i < WAIT_SECONDS; i++ )); do
  log=$("${SUDO[@]}" journalctl -u cloudflared.service --since "$since" --no-pager 2>/dev/null || true)
  if [[ $log == *'Registered tunnel connection'* ]]; then up=1; break; fi
  [[ $(systemctl is-active cloudflared.service 2>/dev/null || true) == failed ]] && break
  sleep 1
done
if (( ! up )); then
  TOKEN=''
  kept=''
  [[ $SOURCE == docker ]] && kept='; the containers were left as they were'
  die "cloudflared started but registered no tunnel connection in ${WAIT_SECONDS} s - see: journalctl -u cloudflared -n 50$kept"
fi
say "cloudflared is running as a service and connected"

# 6. The copy in .env, only now: a token that registers nothing does not go
#    into the backup.
rc=0
record_env "$REPLACE_ENV" || rc=$?
case $rc in
  0|4) ;;
  3) warn "no .env at $ENV_FILE, so the token is not recorded for the sealed backup; once the bot is installed: deploy/install-cloudflared.sh --record-env" ;;
  *) warn "the token could not be recorded in .env (see above); the tunnel runs regardless: deploy/install-cloudflared.sh --record-env" ;;
esac
SAME=''
if [[ $SOURCE != docker ]]; then
  if lines=$(container_lines 2>/dev/null); then
    SAME=$({ printf '%s\n' "$TOKEN"; printf '%s\n' "$lines"; } | CF_DOCKER_MODE=same python3 -c "$PY_DOCKER" || true)
  fi
  lines=''
fi
TOKEN=''

# 7. Only now retire what ran before: until the service was up, it was the
#    tunnel's only connector, however little it could reach. Only the
#    containers that carry this token; stopped ones too, since a restart
#    policy would bring them back.
if [[ $SOURCE == docker ]]; then
  for id in $ADOPT_IDS; do
    if "${SUDO[@]}" "$DOCKER" rm -f "$id" >/dev/null; then say "retired container ${id:0:12}"
    else warn "could not remove container ${id:0:12}: sudo docker rm -f ${id:0:12}"; fi
  done
elif [[ -n ${SAME// /} ]]; then
  warn "a cloudflared container with this tunnel's token still runs here ($SAME): a second connector. deploy/install-cloudflared.sh --from-docker retires it"
fi
if [[ $SOURCE == unit && -e $UNIT_DIR/cloudflared-update.timer ]]; then
  # Cloudflare's service install adds a timer that updates the binary in
  # place; apt does that here.
  "${SUDO[@]}" systemctl disable --now --quiet cloudflared-update.timer && say "turned off cloudflared-update.timer (apt updates cloudflared)"
fi

# 8. A token taken off a command line is in sudo's log of the command that
#    put it there: `sudo docker run ... --token <token>`, `sudo cloudflared
#    service install <token>`. On bot-box2 that is the journal and
#    /var/log/auth.log, which the adm group reads - the bot's user among it
#    (review, 2026-09-30). Moving it into a root-only file does not take it
#    back out of those; rotating it does.
if [[ $SOURCE == docker || $SOURCE == unit ]]; then
  where="a container's command line"
  [[ $SOURCE == unit ]] && where="the unit's command line (cloudflared service install)"
  printf 'taken from %s on %s\n' "$where" "$(date -u '+%Y-%m-%d %H:%M UTC')" | "${SUDO[@]}" tee "$EXPOSED" >/dev/null
  warn "this token was on $where, so sudo's log of the command that started it (the journal, /var/log/auth.log: the adm group reads both) still holds it. Rotate it: in the Cloudflare dashboard, Networking -> Tunnels -> the tunnel -> Rotate token; then deploy/install-cloudflared.sh --new-token, with the new one"
elif (( EXPLICIT && NEW_TOKEN )) && [[ -e $EXPOSED ]]; then
  "${SUDO[@]}" rm -f "$EXPOSED" && say "a new token: the note that the old one was on a command line is gone"
fi

# 9. The ingress rule's origin, from here: what the tunnel will reach.
if curl -fsS -o /dev/null --max-time 5 "http://localhost:$PANEL_PORT/"; then
  say "the panel answers on localhost:$PANEL_PORT, which is where the tunnel sends visitors"
else
  warn "nothing answers on localhost:$PANEL_PORT - is the bot running?"
fi
say "Only one box may run this tunnel. On any other that ran it: sudo systemctl disable --now cloudflared"
say "  (two connectors on one token are replicas, and Cloudflare sends each visit to either)"
