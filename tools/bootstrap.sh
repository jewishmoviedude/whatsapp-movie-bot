#!/usr/bin/env bash
# Rebuild this bot's machine from the sealed backup, in one command.
#
#   # on a fresh Ubuntu 24.04 box, as the user that will run the bot - or
#   # paste the one block in docs/server-setup.md, "One paste: a new VM in
#   # one go", which does these four and the rest in one go:
#   sudo apt-get install -y gh        # or see docs/server-setup.md, step 2
#   gh auth login
#   gh repo clone your-github-user/whatsapp-bot ~/whatsapp-bot
#   cd ~/whatsapp-bot && tools/bootstrap.sh --dry-run     # see what it will do
#   tools/bootstrap.sh                                    # do it
#
# Everything that needs a person comes in the first six steps: the sudo
# password, the questions (passwordless sudo, the backup passphrase, whether
# to remove the Ubuntu installer's extra snaps, "is the bot stopped on the
# old machine?", the LAN address), then the Claude Code login and its token
# for the hourly check, then Tailscale's sign-in. After that it asks only by
# exception (a mistyped passphrase; a backup taken while the old bot still
# ran). The operator asked for one paste with every step done at once
# (2026-09-29), not prompts scattered over twenty minutes of apt and npm.
#
# On WSL (the bot in WSL2 on the Windows laptop, for its GPU; the operator's
# move of 2026-09-29) it does the Linux side of docs/server-setup.md,
# "Running on WSL (for the GPU)" as well - systemd, the VM's leftover units
# off, sshd on 2222 - and puts the Windows side, which only a person can do
# there, on the checklist with the exact PowerShell.
#
# Every rebuild so far meant redoing the same things by hand from memory: the
# packages, the systemd unit with the right node path, growing the root disk,
# the Hyper-V NIC fix that took uploads from 1.5 to 86 Mbit/s, passwordless
# sudo and Tailscale SSH so Claude Code can reach the box, then retyping every
# API key and re-linking the number from a phone. This does all of it, and
# restores the settings, logins and keys from the sealed-backup branch
# (src/core/sealed-backup.js) after asking for the backup passphrase once.
#
# Every routine a bot box runs is in src/core/routines.js, and each has a step
# here marked "# routine: <id>" (test/routines.test.mjs fails on one without).
# The last step runs the same check a new Claude session runs
# (node tools/routines.mjs), so what is still missing ends up in the checklist.
#
# Safe to re-run: every step checks before it acts. --dry-run prints every
# action and changes nothing.
#
# It will NOT start the bot, or enable it at boot, unless you type "yes" to "is
# the bot stopped on the old machine?". Two processes on one WhatsApp session is
# connectionReplaced, the most account-flagging thing this project can do
# (CLAUDE.md, rule 3) - and a unit enabled at boot starts the bot at the next
# reboot whether or not anybody asked.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$APP_DIR/deploy"
USER="${USER:-$(id -un)}"
DRY_RUN=0
NEW_NUMBER=0

usage() {
  cat <<EOF
usage: tools/bootstrap.sh [--dry-run] [--new-number]

Sets this machine up to run the bot and restores it from the sealed backup.
  --dry-run      print every action, change nothing
  --new-number   this box will run a bot on a DIFFERENT WhatsApp number: set
                 up the machine and restore the home bundle, but never the
                 app bundle (the other bot's session and MASTER_KEY), and
                 never claim the sealed-backup branch

Environment (all optional; each answers a question instead of asking it):
  BACKUP_PASSPHRASE       the backup passphrase
  TS_AUTHKEY              a Tailscale auth key, instead of signing in with a link
  PASSWORDLESS_SUDO       yes|no: passwordless sudo for this user. A box whose
                          sudo was narrowed to the hourly check's restart rule
                          (deploy/install-hourly-debug.sh, step 3) is left
                          that way even with "yes"; only "force" widens it
  REMOVE_INSTALLER_SNAPS  yes|no: remove the Ubuntu installer's extra snaps
                          (tools/remove-installer-snaps.sh), if any are here
  OLD_BOT_STOPPED         yes: the bot is stopped on the old machine (or there
                          is none), so start it here and at every boot.
                          Anything else: leave it stopped and disabled
  LAN_ADDRESS             an IPv4 address to make this box's static address,
                          "dhcp" to only ask the router for it, or "skip"
EOF
}

for arg in "$@"; do
  case $arg in
    -n|--dry-run) DRY_RUN=1 ;;
    --new-number) NEW_NUMBER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then GREEN=$'\033[1;32m' YELLOW=$'\033[1;33m' OFF=$'\033[0m'; else GREEN='' YELLOW='' OFF=''; fi
STEP=0
TOTAL=23
step() { STEP=$((STEP + 1)); printf '\n%s== %d/%d  %s%s\n' "$GREEN" "$STEP" "$TOTAL" "$*" "$OFF"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '%s[!]%s %s\n' "$YELLOW" "$OFF" "$*" >&2; }
die() { printf '%s[x]%s %s\n' "$YELLOW" "$OFF" "$*" >&2; exit 1; }

CHECKLIST=()
did() {
  if (( DRY_RUN )); then CHECKLIST+=("[ ] would: $*"); else CHECKLIST+=("[x] $*"); fi
}
skipped() { CHECKLIST+=("[-] $*"); }
todo() { CHECKLIST+=("[ ] $*"); }

# Temp files this script makes, removed however it ends. One of them can hold
# a Tailscale auth key, and interrupting `tailscale up` used to leave it behind.
TMP_FILES=()
cleanup() {
  if (( ${#TMP_FILES[@]} )); then rm -f -- "${TMP_FILES[@]}"; fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Not `f=$(new_tmp)`: a command substitution runs in a subshell, and the
# file would never reach TMP_FILES. Sets NEW_TMP instead.
new_tmp() {
  NEW_TMP=$(mktemp)
  TMP_FILES+=("$NEW_TMP")
}

# Print a command, then run it - or, in a dry run, only print it.
run() {
  printf '   + %s\n' "$(printf '%q ' "$@")"
  (( DRY_RUN )) && return 0
  "$@"
}

# The same for a pipeline, which has to go through a shell.
run_sh() {
  printf '   + %s\n' "$1"
  (( DRY_RUN )) && return 0
  bash -c "set -euo pipefail; $1"
}

# Run a command with the backup passphrase in ITS environment only - never on
# a command line, never exported to everything else this script starts, and
# never printed.
PASS=${BACKUP_PASSPHRASE:-}
export -n BACKUP_PASSPHRASE 2>/dev/null || true
unset BACKUP_PASSPHRASE
# Same for a Tailscale auth key: kept for the one command that needs it.
TS_KEY=${TS_AUTHKEY:-}
export -n TS_AUTHKEY 2>/dev/null || true
unset TS_AUTHKEY
run_with_pass() {
  if [[ -n $PASS ]] || (( DRY_RUN )); then
    printf '   + BACKUP_PASSPHRASE=<hidden> %s\n' "$(printf '%q ' "$@")"
    (( DRY_RUN )) && return 0
    BACKUP_PASSPHRASE="$PASS" "$@"
  else
    run "$@"
  fi
}

# The systemd pieces - whatsapp-bot.service, grow-root-disk, the Hyper-V NIC
# fix - are installed by deploy/install-units.sh, the same installer
# `node tools/routines.mjs --fix` uses, so a rebuilt box and a box brought up
# to date by a new session get the same files. It prints its actions the way
# run() does, and with --dry-run changes nothing.
UNITS=(bash "$DEPLOY/install-units.sh")
(( DRY_RUN )) && UNITS+=(--dry-run)

# Routines this box does without, by somebody's decision here - recorded at
# the end with `tools/routines.mjs --skip`, so the check a later session runs
# reports them as decided instead of asking again.
SKIPS=()

# apt-get does not wait for the dpkg lock (only apt(8) does), and a first boot
# takes it within seconds: on bot-box2, apt-daily and apt-daily-upgrade started
# five seconds after the first boot (2026-09-29). An apt-get then fails at
# once - and install.sh's comes after every login has been done, so the whole
# paste would have to be run again. So every apt-get here waits up to ten
# minutes for the lock, and install.sh, whose NodeSource script runs apt-get
# of its own, waits for the boot-time jobs to finish first.
APT=(sudo apt-get -o DPkg::Lock::Timeout=600)
wait_for_apt() {
  (( DRY_RUN )) && return 0
  command -v fuser >/dev/null || return 0
  local waited=0
  while sudo -n fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do
    (( waited )) || info "apt is busy (the boot-time updates, most likely): waiting for it, up to 10 minutes"
    if (( waited >= 600 )); then
      warn "apt is still busy after 10 minutes; going on, and each apt-get waits for its lock by itself"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# WSL: the kernel's release names Microsoft (src/core/wsl.js, detectWsl).
# Read under INSTALL_UNITS_ROOT, the root the tests' dry runs give every
# installer, so a dry run on a WSL box can still be one of a VM, and the other
# way round; deploy/wsl-setup.sh reads the same root as WSL_SETUP_ROOT.
IS_WSL=0
if grep -qi microsoft "${INSTALL_UNITS_ROOT:-}/proc/sys/kernel/osrelease" 2>/dev/null; then IS_WSL=1; fi
[[ -n ${INSTALL_UNITS_ROOT:-} ]] && export WSL_SETUP_ROOT=$INSTALL_UNITS_ROOT
WSL_SETUP=(bash "$DEPLOY/wsl-setup.sh")
(( DRY_RUN )) && WSL_SETUP+=(--dry-run)

unit_enabled() { [[ $(systemctl is-enabled "$1" 2>/dev/null || true) == enabled ]]; }
enable_unit() {
  if unit_enabled "$1"; then info "= $1 is already enabled"; else run sudo systemctl enable "$1"; fi
}

has_env_passphrase() {
  [[ -f $APP_DIR/.env ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?BACKUP_PASSPHRASE[[:space:]]*=' "$APP_DIR/.env"
}

# A terminal to ask questions on. Without one (cron, a pipe, a CI runner)
# nothing is asked, which means nothing that needs a human's yes is done.
HAVE_TTY=0
if (( ! DRY_RUN )) && { exec 3</dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi
ask() {
  REPLY=''
  (( HAVE_TTY )) || return 1
  read -r -p "$1" REPLY <&3 || return 1
}

# The panel's port: web.port in data/config.json once it is restored, 8080
# (the default in src/config/schema.js) before then, or with no node yet.
web_port() {
  local p=''
  if [[ -f $APP_DIR/data/config.json ]] && command -v node >/dev/null; then
    p=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(c.web?.port ?? "")) } catch {}' \
      "$APP_DIR/data/config.json" 2>/dev/null || true)
  fi
  [[ $p =~ ^[0-9]+$ ]] && echo "$p" || echo 8080
}

# Whether the panel's port is free for the bot. Something else on it - on the
# box built 2026-09-29 it was SABnzbd, one of the installer's "featured snaps"
# - makes the bot die at every start with EADDRINUSE, and a crash loop makes
# deploy/auto-update.sh take the newest commit back out. tools/port-holder.sh
# names the holder and the command that would free it; stopping it is the
# operator's call, never this script's.
PORT_REPORT=''
port_free() {
  local rc=0
  PORT_REPORT=$(PORT_HOLDER_SUDO=$(( ! DRY_RUN )) bash "$APP_DIR/tools/port-holder.sh" "$1" 2>&1) || rc=$?
  (( rc != 1 ))
}

# The address the box has on its default-route interface, or nothing.
current_lan_address() {
  local dev
  dev=$(ip route show default 2>/dev/null | awk '!f { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); f = 1; break } }')
  [[ -n $dev ]] || return 0
  ip -4 -o addr show dev "$dev" scope global 2>/dev/null | awk '!f { split($4, a, "/"); print a[1]; f = 1 }'
}

# ---------------------------------------------------------------------------
step "Preflight"
if [[ $EUID -eq 0 ]]; then
  die "Run this as the user that will own the bot, not root. It calls sudo itself where it has to."
fi
[[ -e $APP_DIR/.git ]] || die "$APP_DIR is not a git checkout. Clone it with gh first (see the top of this file)."
command -v sudo >/dev/null || die "sudo is required."
info "machine $(hostname), user $USER, app $APP_DIR"
if (( DRY_RUN )); then
  info "DRY RUN: every action is printed below, and nothing is changed."
fi
# Ask for the sudo password once, up front, rather than halfway through.
run sudo -v
# Said now, before twenty minutes of installing, so it can be dealt with while
# the rest runs; checked again before the bot is started.
PORT=$(web_port)
if port_free "$PORT"; then
  info "= the panel's $PORT_REPORT"
else
  warn "the panel's port is taken, so the bot could not start:"
  while IFS= read -r line; do warn "  $line"; done <<<"$PORT_REPORT"
  warn "An Ubuntu install with its \"featured snaps\" ticked brings SABnzbd, which takes $PORT. The questions below offer to remove the installer's extras; nothing else is stopped for you."
fi

# ---------------------------------------------------------------------------
step "Passwordless sudo for $USER"
# routine: sudo
# Claude Code manages this box over Tailscale SSH and cannot type a password;
# the user chose passwordless sudo for exactly that. Offered, never assumed.
#
# Narrowed is also a choice: deploy/install-hourly-debug.sh (step 3) offers to
# keep only the one rule the hourly check needs and remove the full one, and
# the sudo routine accepts that. The one paste answers this question with
# PASSWORDLESS_SUDO=yes, and a re-paste on a narrowed box put NOPASSWD:ALL
# back without a word (review, 2026-09-29), the way the routines check once
# undid it by asking for it back. So a narrowed box is left narrowed; only
# PASSWORDLESS_SUDO=force widens it again. The rules are read from `sudo -l`,
# not tried with `sudo -n -l <command>`: after the `sudo -v` above, that
# succeeds for any command sudo would allow with a password.
SUDOERS=/etc/sudoers.d/90-claude-nopasswd
SUDO_LIST=''
(( DRY_RUN )) || SUDO_LIST=$(sudo -n -l 2>/dev/null || true)
if (( DRY_RUN )); then
  info "would check 'sudo -n -l' for NOPASSWD, and if it is missing (and sudo is not narrowed to the hourly check's restart rule) ask [Y/n] before:"
  info "  + sudo visudo -cf <temp file holding '$USER ALL=(ALL) NOPASSWD:ALL'>"
  info "  + sudo install -m 0440 -o root -g root <temp file> $SUDOERS"
  todo "passwordless sudo (dry run)"
elif grep -Eq 'NOPASSWD: *ALL' <<<"$SUDO_LIST"; then
  info "= $USER already has passwordless sudo"
  did "passwordless sudo"
elif [[ ${PASSWORDLESS_SUDO:-} != force ]] && grep -Eq 'NOPASSWD:.*systemctl restart whatsapp-bot' <<<"$SUDO_LIST"; then
  info "= sudo is narrowed to the hourly check's restart rule, an accepted choice: left as it is (PASSWORDLESS_SUDO=force widens it)"
  did "sudo narrowed to the hourly check's restart rule (an accepted choice, left as it is)"
elif [[ -z ${PASSWORDLESS_SUDO:-} ]] && (( ! HAVE_TTY )); then
  info "no terminal to ask on; leaving sudo as it is"
  skipped "passwordless sudo (not asked: no terminal)"
else
  if [[ -n ${PASSWORDLESS_SUDO:-} ]]; then
    REPLY=$PASSWORDLESS_SUDO
    info "answered by PASSWORDLESS_SUDO=$REPLY"
  else
    ask "Let $USER use sudo without a password, so Claude Code can manage this box? [Y/n] " || true
  fi
  case ${REPLY,,} in
    ''|y|yes|force)
      new_tmp
      tmp=$NEW_TMP
      printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$USER" > "$tmp"
      # A syntax error in a sudoers.d file locks everyone out of sudo, so it
      # is checked before it goes anywhere near /etc.
      if run sudo visudo -cf "$tmp" && run sudo install -m 0440 -o root -g root "$tmp" "$SUDOERS"; then
        did "passwordless sudo ($SUDOERS)"
      else
        warn "visudo rejected the rule; nothing was installed"
        todo "passwordless sudo (visudo check failed)"
      fi
      rm -f "$tmp"
      ;;
    *)
      skipped "passwordless sudo (declined)"
      SKIPS+=("sudo=declined when tools/bootstrap.sh asked")
      ;;
  esac
fi

# ---------------------------------------------------------------------------
step "WSL: systemd, the VM's leftover units, and starting with Windows"
# routine: wsl-systemd
# routine: wsl-vm-units
# routine: wsl-config
# routine: wsl-autostart
# Only on WSL. Early, because everything after it needs systemd - on the
# laptop (2026-09-29) `systemctl restart whatsapp-bot` failed with "System
# has not been booted with systemd as init system" - and a distro cloned from
# the Hyper-V VM would otherwise apply the VM's static address and run a
# second tailscaled beside the Windows one. The Windows side (the scheduled
# task that starts WSL with Windows) needs a person at an administrator
# PowerShell, so it goes on the checklist, exactly.
if (( ! IS_WSL )); then
  skipped "WSL setup (not WSL)"
else
  info "WSL distro ${WSL_DISTRO_NAME:-<unknown: wsl.exe -l -v lists it>}"
  run "${WSL_SETUP[@]}" systemd || die "writing /etc/wsl.conf failed (see above)"
  if (( ! DRY_RUN )) && ! systemctl is-system-running >/dev/null 2>&1 \
      && [[ $(systemctl is-system-running 2>/dev/null || true) =~ ^(offline|)$ ]]; then
    warn "systemd is not running in this distro yet, and everything below needs it."
    warn "From Windows, at a quiet moment: wsl.exe --shutdown   then open the distro again, and run tools/bootstrap.sh again."
    die "WSL has to restart before the rest (it reads /etc/wsl.conf only when it starts)"
  fi
  run "${WSL_SETUP[@]}" vm-units || die "turning the VM's units off failed (see above)"
  did "WSL: systemd, and the Hyper-V VM's units off"
  if run "${WSL_SETUP[@]}" wslconfig; then
    did "WSL: .wslconfig asks for mirrored networking and never idles (read at WSL's next start: wsl.exe --shutdown from Windows)"
  else
    todo "WSL: in Windows, notepad %UserProfile%\\.wslconfig - [wsl2] then networkingMode=mirrored and vmIdleTimeout=-1, each on its own line; then wsl.exe --shutdown"
  fi
  AUTOSTART_PS=$(node "$APP_DIR/tools/wsl-config.mjs" --autostart "${WSL_DISTRO_NAME:-}" 2>/dev/null || true)
  todo "WSL: start it with Windows - in PowerShell as administrator, once: ${AUTOSTART_PS:-node tools/wsl-config.mjs --autostart prints the command}"
  todo "WSL: if the distro came from a Hyper-V VM, keep that VM from ever starting a second bot - in PowerShell as administrator: Stop-VM -Name <the VM>; Set-VM -Name <the VM> -AutomaticStartAction Nothing"
fi

# ---------------------------------------------------------------------------
step "GitHub CLI: gh auth setup-git"
# routine: gh-auth
if ! command -v gh >/dev/null; then
  info "gh is not installed; adding the cli.github.com apt repository"
  run_sh "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none"
  run sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  run_sh "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null"
  wait_for_apt
  run "${APT[@]}" update -qq
  run "${APT[@]}" install -y gh
fi
# The repository is private and the backup lives in it, so this has to work
# before anything can be restored. The token itself is never in the backup.
if command -v gh >/dev/null && ! gh auth status >/dev/null 2>&1; then
  (( DRY_RUN )) && info "gh is not logged in; the real run stops here until 'gh auth login' is done"
  (( DRY_RUN )) || die "gh is not logged in. Run 'gh auth login' (GitHub.com, HTTPS, authenticate git: yes, web browser), then run this again."
fi
run gh auth setup-git
did "git uses gh's login (gh auth setup-git)"

# ---------------------------------------------------------------------------
step "Questions: everything that needs an answer, asked now"
# Every answer the rest needs, asked here, so that nobody has to watch twenty
# minutes of apt and npm for the next prompt. Each can come from the
# environment instead (see --help).
BRANCH_STATE=unknown
if (( DRY_RUN )); then
  info "would check origin for a sealed-backup branch (git ls-remote), then ask ONCE for the passphrase, hidden"
  BRANCH_STATE=present
elif git -C "$APP_DIR" ls-remote --exit-code origin refs/heads/sealed-backup >/dev/null 2>&1; then
  BRANCH_STATE=present
else
  rc=$?
  (( rc == 2 )) || die "could not reach origin to look for the sealed backup (git ls-remote exit $rc). Check 'gh auth status' and the network."
  BRANCH_STATE=absent
fi

# The app bundle - the bot's settings, session and MASTER_KEY - goes only onto
# a checkout that has none, and never onto a box that will run another number.
APP_RESTORE=1
if (( NEW_NUMBER )); then
  APP_RESTORE=0
elif [[ -e $APP_DIR/.env || -e $APP_DIR/data/config.json || -e $APP_DIR/data/session ]]; then
  APP_RESTORE=0
fi

if [[ $BRANCH_STATE == absent ]]; then
  info "origin has no sealed-backup branch: this is a brand-new install, with nothing to restore"
elif [[ -n $PASS ]]; then
  info "using BACKUP_PASSPHRASE from the environment"
elif has_env_passphrase && (( ! DRY_RUN )); then
  info "using the passphrase already in .env"
elif (( HAVE_TTY )); then
  # IFS= keeps the passphrase exactly as typed. Without it bash trims leading
  # and trailing spaces while backup-secrets.mjs keeps them, so a passphrase
  # set with a trailing space (easy when pasting from a password manager)
  # would never open the backup from here.
  IFS= read -rs -p "Backup passphrase (the one chosen with backup-secrets.mjs --set-passphrase): " PASS <&3
  echo >&2
  [[ -n $PASS ]] || die "no passphrase entered"
elif (( ! DRY_RUN )); then
  # Never suggest "BACKUP_PASSPHRASE=... tools/bootstrap.sh": typed like that,
  # the passphrase lands in ~/.bash_history.
  warn "no terminal to ask for the backup passphrase on. Run tools/bootstrap.sh again from a terminal (ssh -t, or the console) and it will ask."
  warn "Scripted, without the passphrase reaching shell history: IFS= read -rs BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE && tools/bootstrap.sh"
fi

# The Ubuntu Server installer's "featured server snaps". bot-box2 was installed
# with most of them ticked (2026-09-29): SABnzbd took the panel's port, so the
# bot died at every start, and together they held about 3 GB of RAM and the
# CPU ffmpeg needs. tools/remove-installer-snaps.sh removes exactly those,
# with --purge. Asked here; done after the logins and before install.sh, so
# the port is free by the time the start checks it. With no terminal and no
# REMOVE_INSTALLER_SNAPS, nothing is removed: their data goes with them.
SNAPS_TOOL="$APP_DIR/tools/remove-installer-snaps.sh"
SNAPS_FOUND=''
SNAPS_ANSWER=''
SNAPS_REMOVE=0
snaps_out=$(bash "$SNAPS_TOOL" --dry-run 2>&1) || warn "could not tell which snaps are installed: ${snaps_out##*$'\n'}"
SNAPS_FOUND=$(sed -n 's/^installer snaps to remove: //p' <<<"$snaps_out")
if [[ -n $SNAPS_FOUND ]]; then
  info "the Ubuntu installer's extra snaps are installed here: $SNAPS_FOUND"
  if [[ -n ${REMOVE_INSTALLER_SNAPS:-} ]]; then
    SNAPS_ANSWER=${REMOVE_INSTALLER_SNAPS,,}
    info "answered by REMOVE_INSTALLER_SNAPS=$REMOVE_INSTALLER_SNAPS"
  elif (( DRY_RUN )); then
    info "would ask [Y/n] whether to remove them (or take REMOVE_INSTALLER_SNAPS)"
  elif (( HAVE_TTY )); then
    echo "   They hold RAM and CPU the encodes need, and SABnzbd takes the panel's port."
    ask "   Remove them, with their data (tools/remove-installer-snaps.sh)? [Y/n] " || true
    SNAPS_ANSWER=${REPLY,,}
    [[ -n $SNAPS_ANSWER ]] || SNAPS_ANSWER=yes
  fi
  case $SNAPS_ANSWER in y|yes) SNAPS_REMOVE=1 ;; esac
fi

# Whether to start the bot here, asked now and acted on only after the restore
# and the unit are in place. Only a typed "yes" (or OLD_BOT_STOPPED=yes)
# starts it: two machines on one WhatsApp session is connectionReplaced
# (CLAUDE.md, rule 3).
START_ANSWER=''
# A bot with no settings yet: a brand-new install, or a box for another
# number. Starting it mints a new MASTER_KEY and its number is linked from the
# panel, so there is no old machine for it to collide with.
FRESH_BOT=0
if [[ ! -f $APP_DIR/.env ]] && { [[ $BRANCH_STATE == absent ]] || (( NEW_NUMBER )); }; then FRESH_BOT=1; fi
ACTIVE=$(systemctl show -p ActiveState --value whatsapp-bot.service 2>/dev/null || true)
case $ACTIVE in
  active|activating|reloading) info "= the bot already runs here: nothing to ask about starting it" ;;
  *)
    if [[ -n ${OLD_BOT_STOPPED+x} ]]; then
      START_ANSWER=$OLD_BOT_STOPPED
      if [[ $START_ANSWER == yes ]]; then info "OLD_BOT_STOPPED=yes: the bot will be started here, and at every boot"
      else info "OLD_BOT_STOPPED is not \"yes\": the bot will be left stopped and disabled here"; fi
    elif (( DRY_RUN )); then
      info "would ask: Is the bot stopped on the old machine? (or take OLD_BOT_STOPPED); only a typed 'yes' starts it later"
    elif (( HAVE_TTY )); then
      echo
      if (( FRESH_BOT )); then
        echo "   This will start a bot with no settings yet: it makes a new MASTER_KEY, and you"
        echo "   link its number from the panel. Never a number that another machine is running."
        ask '   Start it once everything is installed, and at every boot? Type "yes": ' || true
      else
        echo "   Two machines on one WhatsApp session is connectionReplaced, the fastest"
        echo "   way to lose the number. On the OLD machine:  sudo systemctl disable --now whatsapp-bot"
        ask '   Is the bot stopped on the old machine? Type "yes" to start it here, and at every boot: ' || true
      fi
      START_ANSWER=$REPLY
    fi
    ;;
esac

# The LAN address: static, the operator's choice (2026-09-29), at the address
# the box has now unless told otherwise. Applied at the end, behind a
# 3-minute undo (deploy/pin-lan-address.sh --static --apply).
LAN_NOW=$(current_lan_address)
LAN_CHOICE=''
if (( IS_WSL )); then
  # Mirrored networking: WSL has the laptop's addresses, and the one to keep
  # is reserved for the laptop on the router. No netplan here.
  info "WSL: the LAN address is the laptop's own (mirrored networking), so nothing is asked"
  LAN_CHOICE=wsl
elif [[ -n ${LAN_ADDRESS+x} ]]; then
  LAN_CHOICE=${LAN_ADDRESS:-skip}
  info "LAN address from LAN_ADDRESS: $LAN_CHOICE"
elif [[ -z $LAN_NOW ]]; then
  info "no default route with an IPv4 address, so no LAN address to keep"
elif (( DRY_RUN )); then
  info "would ask for the static LAN address to keep (Enter: $LAN_NOW, the one it has now), or take LAN_ADDRESS"
  LAN_CHOICE=$LAN_NOW
elif (( HAVE_TTY )); then
  ask "   Static LAN address for this box [Enter: $LAN_NOW; 'dhcp' to stay on DHCP; 'skip']: " || true
  LAN_CHOICE=${REPLY:-$LAN_NOW}
fi
case $LAN_CHOICE in
  ''|skip|dhcp|wsl) ;;
  *.*.*.*) info "static LAN address: $LAN_CHOICE (reserve it for this box's MAC on the router too)" ;;
  *) warn "not an address, 'dhcp' or 'skip': $LAN_CHOICE - the LAN address is left as it is"; LAN_CHOICE='' ;;
esac

# ---------------------------------------------------------------------------
step "Claude Code"
# routine: claude-code
# So a session can work on the box directly, and because the hourly check
# runs headless Claude Code from ~/.local/bin/claude. The official installer
# (docs/server-setup.md, section 8) puts it there for this user, no root.
#
# Both of its logins are browser logins, so they are done here, among the
# questions, and not after twenty minutes of installing: the user's own
# (`claude auth login`, for sessions on this box), and - on the box that will
# run the bot - the long-lived token the hourly check uses from cron (`claude
# setup-token`). The token is read hidden and handed to the hourly check's
# installer on stdin at once, which saves it mode 600 in a folder made 700.
# It used to wait in this shell until the hourly check's own step, twenty
# minutes on, so anything that stopped the run in between - a tailscale up
# that failed, three wrong passphrases - threw away a freshly minted
# one-year token, and the re-run minted another (review, 2026-09-29). It is
# tested once the check is installed.
CLAUDE_BIN="$HOME/.local/bin/claude"
if [[ -x $CLAUDE_BIN ]]; then
  info "= Claude Code is installed ($CLAUDE_BIN)"
  did "Claude Code"
elif run_sh "curl -fsSL https://claude.ai/install.sh | bash"; then
  did "Claude Code installed ($CLAUDE_BIN)"
else
  warn "installing Claude Code failed (see above)"
  todo "Claude Code: curl -fsSL https://claude.ai/install.sh | bash"
fi

claude_logged_in() {
  local out
  out=$("$CLAUDE_BIN" auth status --json 2>/dev/null || true)
  [[ $out =~ \"loggedIn\":[[:space:]]*true ]]
}
if (( DRY_RUN )); then
  info "would log Claude Code in if it is not (claude auth status, then: $CLAUDE_BIN auth login)"
elif [[ ! -x $CLAUDE_BIN ]]; then
  todo "Claude Code login: $CLAUDE_BIN auth login (once it is installed)"
elif claude_logged_in; then
  info "= Claude Code is logged in"
elif (( HAVE_TTY )); then
  echo
  echo "   Log Claude Code in, for sessions on this box. It prints a link: open it on"
  echo "   any device, sign in, and paste the code it gives back here."
  run "$CLAUDE_BIN" auth login <&3 || true
  if claude_logged_in; then did "Claude Code logged in"; else todo "Claude Code login: $CLAUDE_BIN auth login"; fi
else
  todo "Claude Code login: $CLAUDE_BIN auth login"
fi

# The hourly check's token, collected now for the box that will run the bot.
HOURLY="$DEPLOY/install-hourly-debug.sh"
HOURLY_ENV="${HOURLY_DEBUG_ENV_FILE:-$HOME/.config/whatsapp-bot/hourly-debug.env}"
hourly_token() {
  [[ -r $HOURLY_ENV ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$HOURLY_ENV"
}
TOKEN_TODO="the hourly check's Claude token: $CLAUDE_BIN setup-token (a browser login), then $HOURLY --set-token and paste it (read hidden, saved to $HOURLY_ENV mode 600)"
HTOKEN=''
# Whether the token was asked for here. If it was and none came (Enter, or a
# setup-token that failed), the hourly check's step does not ask again: that
# prompt came twenty minutes into the part that runs unattended, and held
# the LAN step and the checklist behind it until somebody pressed Enter.
TOKEN_OFFERED=0
WILL_RUN=0
if [[ $ACTIVE == active || $ACTIVE == activating || $ACTIVE == reloading || $START_ANSWER == yes ]]; then WILL_RUN=1; fi
if (( DRY_RUN )); then
  info "on the box that will run the bot, with no token for the hourly check yet, would run $CLAUDE_BIN setup-token, read the token it prints, hidden, and save it at once:"
  info "  + $HOURLY --set-token --no-verify   (the token on stdin; tested once the check is installed)"
elif (( WILL_RUN )) && [[ -x $CLAUDE_BIN ]] && ! hourly_token && (( HAVE_TTY )); then
  TOKEN_OFFERED=1
  echo
  echo "   The hourly check needs a Claude login it can use from cron. setup-token opens a"
  echo "   browser login and prints a long-lived token (sk-ant-...): copy it for the next prompt."
  run "$CLAUDE_BIN" setup-token <&3 || true
  IFS= read -rs -p "   Paste the token it printed (it is not shown; Enter alone skips this): " HTOKEN <&3 || HTOKEN=''
  echo >&2
  if [[ -z $HTOKEN ]]; then
    todo "$TOKEN_TODO"
  elif printf '%s\n' "$HTOKEN" | bash "$HOURLY" --set-token --no-verify; then
    did "the hourly check's Claude token, saved (tested once the check is installed)"
  else
    todo "$TOKEN_TODO (the token given at the start did not save; see above)"
  fi
  HTOKEN=''
fi

# ---------------------------------------------------------------------------
step "Tailscale: SSH on, operator $USER, auto-update on"
# routine: tailscale-ssh
# Tailscale SSH is how the Claude desktop app reaches this box. The node's own
# state (its keys and identity) is deliberately NOT in the backup: two
# machines with one Tailscale identity fight over it, so a new box logs in as
# a new node.
if (( IS_WSL )); then
  # On WSL the Windows Tailscale client is the tailnet node for the laptop,
  # and a Linux tailscaled beside it in mirrored networking fights it over
  # the 100.x routes (the WSL step turned it off). What this box needs is an
  # sshd those addresses reach, on 2222, since Windows holds 22.
  if run "${WSL_SETUP[@]}" ssh; then
    did "WSL: sshd on port 2222 (ssh -p 2222 $USER@<the laptop's Tailscale name>); the Windows Tailscale client is the tailnet node"
  else
    todo "WSL: sshd on 2222 - deploy/wsl-setup.sh ssh (it failed here; see above)"
  fi
  todo "WSL: if SSH on 2222 is refused from another machine, in PowerShell as administrator: New-NetFirewallHyperVRule -Name wsl-ssh -DisplayName 'WSL SSH' -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 2222"
elif ! command -v tailscale >/dev/null; then
  codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")
  run_sh "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/$codename.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null"
  run_sh "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/$codename.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null"
  wait_for_apt
  run "${APT[@]}" update -qq
  run "${APT[@]}" install -y tailscale
fi
if (( IS_WSL )); then
  :
elif command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  info "= already logged in to Tailscale"
else
  up=(sudo tailscale up --ssh "--operator=$USER")
  keyfile=''
  if [[ -n $TS_KEY ]]; then
    # file: keeps the key off the command line, where `ps` would show it.
    if (( DRY_RUN )); then
      up+=("--auth-key=file:<temp file holding \$TS_AUTHKEY>")
    else
      new_tmp
      keyfile=$NEW_TMP
      printf '%s' "$TS_KEY" > "$keyfile"
      up+=("--auth-key=file:$keyfile")
    fi
  else
    info "tailscale up prints a login URL; open it on any device"
  fi
  run "${up[@]}" || { [[ -n $keyfile ]] && rm -f "$keyfile"; die "tailscale up failed"; }
  [[ -n $keyfile ]] && rm -f "$keyfile"
fi
if (( ! IS_WSL )); then
  run sudo tailscale set --ssh "--operator=$USER" --auto-update
  did "Tailscale (SSH, operator $USER, auto-update)"
fi

# ---------------------------------------------------------------------------
step "The Ubuntu installer's extra snaps"
# Asked with the questions (see there for why); removed here, the first step
# that needs nobody, so the RAM and the panel's port are free before
# install.sh and the start.
if (( DRY_RUN )); then
  info "would remove them, if any are installed and the answer was yes (or REMOVE_INSTALLER_SNAPS=yes):"
  info "  + bash $SNAPS_TOOL"
  todo "the installer's extra snaps (dry run)"
elif [[ -z $SNAPS_FOUND ]]; then
  info "= none of the installer's extra snaps is installed"
elif (( SNAPS_REMOVE )); then
  if run bash "$SNAPS_TOOL"; then
    did "removed the Ubuntu installer's extra snaps: $SNAPS_FOUND"
  else
    warn "some of the installer's snaps could not be removed (see above)"
    todo "$SNAPS_TOOL   (it could not remove them all; see above)"
  fi
elif [[ -n $SNAPS_ANSWER ]]; then
  skipped "the installer's extra snaps (kept, as answered: $SNAPS_FOUND)"
else
  todo "the installer's extra snaps are still here ($SNAPS_FOUND): $SNAPS_TOOL --dry-run, then without it (not asked: no terminal; REMOVE_INSTALLER_SNAPS=yes answers it)"
fi

# ---------------------------------------------------------------------------
step "System packages and the app: ./install.sh"
# routine: packages
# install.sh: ffmpeg, curl, ca-certificates, Node 20 from NodeSource, npm
# install --omit=dev, data/ at 0700. BOOTSTRAP=1 keeps it from suggesting
# `npm start`, which is the wrong thing to do before the old machine is off.
wait_for_apt
run env BOOTSTRAP=1 "$APP_DIR/install.sh"
missing=()
for pkg in git gnupg ethtool cloud-guest-utils; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if (( ${#missing[@]} )); then
  run "${APT[@]}" install -y "${missing[@]}"
else
  info "= git, gnupg, ethtool and cloud-guest-utils are installed"
fi
did "packages, Node 20 and npm dependencies (install.sh)"
# The dev dependencies as well. A Claude session on this box runs npm test
# before and after every change (CLAUDE.md), and without linkedom, a
# devDependency, twelve suites fail: bot-box2's did, until they were added by
# hand (2026-09-29). deploy/auto-update.sh keeps them once they are there.
if run npm --prefix "$APP_DIR" install --include=dev --no-audit --no-fund --loglevel=error; then
  did "the dev dependencies too, so the whole test suite runs here (npm install --include=dev)"
else
  warn "installing the dev dependencies failed (see above); the bot does not need them"
  todo "cd $APP_DIR && npm install --include=dev   (so npm test can run every suite here)"
fi

# ---------------------------------------------------------------------------
step "yt-dlp and deno, for YouTube links on Queue a public link"
# routine: yt-dlp
# "Queue a public link" reads the video out of a YouTube page with yt-dlp
# (src/media/yt-dlp.js): on 2026-10-11 a YouTube link was refused as "a web
# page", and the operator asked for yt-dlp "and whatever else needed". No
# root: the official zipapp into ~/.local/bin/yt-dlp and deno, its JavaScript
# runtime for YouTube (it wants node 22, and the bot runs on 20), into
# ~/.deno/bin, each checked against the SHA-256 its release publishes. The bot
# keeps yt-dlp updated daily itself (the yt-dlp-update routine). After
# install.sh, which brings Node and python3.
if run "$(command -v node || echo node)" "$APP_DIR/tools/install-yt-dlp.mjs"; then
  did "yt-dlp in ~/.local/bin and deno in ~/.deno/bin (node tools/install-yt-dlp.mjs); the bot updates yt-dlp daily"
else
  warn "installing yt-dlp failed (see above): YouTube links on Queue a public link are refused until it is there"
  todo "node tools/install-yt-dlp.mjs   (yt-dlp and deno, for YouTube links on Queue a public link)"
fi

# ---------------------------------------------------------------------------
step "grow-root-disk: grow / into free disk space at every boot"
# routine: grow-root-disk
if (( IS_WSL )); then
  skipped "grow-root-disk (WSL: / is a VHDX Windows manages)"
else
"${UNITS[@]}" grow-root-disk || die "installing grow-root-disk failed (see above)"
# Not worth stopping the rebuild over: a layout it does not understand only
# means / stays the size it is.
if run sudo /usr/local/sbin/grow-root-disk; then
  did "grow-root-disk (enabled at boot, and run once now)"
else
  warn "grow-root-disk failed (see above); / was left as it is"
  todo "grow-root-disk failed once: run sudo /usr/local/sbin/grow-root-disk and read what it says"
fi
fi

# ---------------------------------------------------------------------------
step "Hyper-V NIC: TCP segmentation offload off"
# routine: nic-offload
# Offload on gave 29% TCP retransmits and 1.5 Mbit/s uploads on a Hyper-V
# NIC; off gave 86 Mbit/s. WSL too: its mirrored NIC is hv_netvsc with the same
# fault (162 KB/s -> 5,176 KB/s uploads, 2026-09-30). Anywhere else the installer
# does nothing (exit 4).
rc=0
"${UNITS[@]}" nic-offload || rc=$?
case $rc in
  0) did "Hyper-V NIC offload off, and turned off again at every boot" ;;
  4) skipped "Hyper-V NIC offload fix (not a Hyper-V NIC)" ;;
  *) die "the Hyper-V NIC fix failed (see above)" ;;
esac

# ---------------------------------------------------------------------------
step "Restore the sealed backup: app bundle and home bundle"
# What the branch holds, from its plaintext manifest, with no passphrase:
# when it was written, by which host, whether that host's bot was running at
# the time, whether it was this machine, and which other machines' backups
# are kept in its archive/ folder. Read here rather than with the questions
# because it takes node, which install.sh has only just put on a fresh box.
B_CREATED='' B_AGE='' B_HOST='' B_RUNNING=unknown B_MINE=no B_ARCHIVED=0 B_ARCHIVED_LIST=''
if [[ $BRANCH_STATE == present ]] && (( ! DRY_RUN )); then
  info_out=$(node "$APP_DIR/tools/restore-secrets.mjs" --from-branch --info) \
    || die "could not read the sealed backup's manifest (see above)"
  while IFS='=' read -r key value; do
    case $key in
      createdAt) B_CREATED=$value ;;
      ageMinutes) B_AGE=$value ;;
      host) B_HOST=$value ;;
      botRunning) B_RUNNING=$value ;;
      thisMachine) B_MINE=$value ;;
      archived) B_ARCHIVED=$value ;;
      archivedList) B_ARCHIVED_LIST=$value ;;
    esac
  done <<<"$info_out"
  info "sealed backup: written $B_CREATED ($B_AGE min ago) by $B_HOST"
  # The top of the branch is the backup this restores. The archive holds the
  # machines it replaced; one is the right one only to bring that machine's
  # bot back, so it is named here and never picked for you.
  if [[ $B_ARCHIVED =~ ^[1-9][0-9]*$ ]]; then
    info "the branch also keeps $B_ARCHIVED archived backup(s) of other machines: $B_ARCHIVED_LIST"
    info "this restores the current one; for an archived one instead: node tools/restore-secrets.mjs --list-archive, then --from-archive <folder>"
  fi
fi

RESTORED_APP=0
if [[ $BRANCH_STATE == absent ]]; then
  skipped "restore (no sealed backup yet: set the bot up in the panel, then run node tools/backup-secrets.mjs --set-passphrase --install-cron)"
elif [[ -z $PASS ]] && ! has_env_passphrase && (( ! DRY_RUN )); then
  todo "restore: run tools/bootstrap.sh again from a terminal, which asks for the passphrase (none was available)"
else
  if (( DRY_RUN )); then
    info "would show the backup's age and host, and any archived backups of other machines (node tools/restore-secrets.mjs --list-archive),"
    info "and if its bot was still running when it was taken, ask before restoring the app bundle"
  elif (( NEW_NUMBER )); then
    info "--new-number: restoring the home bundle only; this box gets its own settings, MASTER_KEY and number"
  elif (( ! APP_RESTORE )); then
    # Never over a live install: that would swap the session under a running
    # bot. The home bundle is still worth having.
    info "this checkout already has its own .env / data: restoring the home bundle only"
  elif [[ $B_RUNNING != false ]]; then
    # A copy taken while the old bot ran is missing whatever it did after:
    # the state flushed at shutdown, the outbound budget, session and pre-key
    # updates. Jobs it finished afterwards are re-queued here and posted
    # twice. The hand-over is: stop the old bot, back up, THEN restore.
    if [[ $B_RUNNING == true ]]; then
      warn "this backup was taken while the bot on $B_HOST was still RUNNING ($B_CREATED, $B_AGE min ago)."
    else
      warn "this backup does not record whether the bot on $B_HOST was running when it was taken ($B_CREATED, $B_AGE min ago)."
    fi
    warn "Anything that bot did after that is not in it. For a hand-over, on $B_HOST: sudo systemctl disable --now whatsapp-bot, then node tools/backup-secrets.mjs, then run this again here."
    REPLY=''
    if (( HAVE_TTY )); then
      ask '   Restore this copy anyway (the old machine is gone, or you accept the gap)? Type "yes": ' || true
    fi
    if [[ $REPLY != yes ]]; then
      APP_RESTORE=0
      info "not restoring the app bundle; restoring the home bundle only"
      todo "restore the app bundle: on $B_HOST stop the bot (sudo systemctl disable --now whatsapp-bot) and run node tools/backup-secrets.mjs, then tools/bootstrap.sh again here"
    fi
  else
    info "it was taken with the bot on $B_HOST stopped: restoring it"
  fi
  only=()
  (( APP_RESTORE )) || only=(--only home)
  # Up to three tries at the passphrase: restore-secrets.mjs opens every
  # bundle before it unpacks anything and exits 3 on a wrong passphrase, so a
  # typo costs a retype, not a re-run of everything above.
  for attempt in 1 2 3; do
    rc=0
    run_with_pass node "$APP_DIR/tools/restore-secrets.mjs" --from-branch "${only[@]}" || rc=$?
    (( rc == 0 )) && break
    if (( rc == 3 && attempt < 3 && HAVE_TTY )); then
      IFS= read -rs -p "That passphrase did not open the backup. Try again: " PASS <&3
      echo >&2
      continue
    fi
    die "restoring the sealed backup failed (see above); nothing after this step was done"
  done
  if (( APP_RESTORE && ! DRY_RUN )); then RESTORED_APP=1; fi
  did "restored from origin/sealed-backup${only:+ (home bundle only)}"
fi

# ---------------------------------------------------------------------------
step "Git: gh's login again, and who commits here"
# routine: gh-auth
# After the restore, because the home bundle can replace ~/.gitconfig with
# the old box's copy: so git is pointed at gh's login once more, and given an
# identity if it has none. bot-box's was in the app checkout's own
# .git/config, which no bundle carries, and bot-box2's first commit failed
# with "Author identity unknown" (2026-09-29) - while CLAUDE.md has every fix
# a session makes land as a commit. The identity is the repository owner's,
# the author of the last commit on main, as tools/hourly-debug.mjs sets for
# its own clone. One already set, globally or in the checkout, is kept.
run gh auth setup-git || warn "gh auth setup-git failed (see above)"
if (( DRY_RUN )); then
  info "would give git an identity, if this checkout has none: the author of the last commit on origin/main"
  info "  + git config --global user.name <that author>; git config --global user.email <that address>"
  todo "a git identity (dry run)"
elif [[ -n $(git -C "$APP_DIR" config --get user.name || true) && -n $(git -C "$APP_DIR" config --get user.email || true) ]]; then
  info "= git commits here as $(git -C "$APP_DIR" config --get user.name) <$(git -C "$APP_DIR" config --get user.email)>"
  did "a git identity to commit with"
else
  who_name=$(git -C "$APP_DIR" log -1 --format=%an origin/main 2>/dev/null || true)
  who_mail=$(git -C "$APP_DIR" log -1 --format=%ae origin/main 2>/dev/null || true)
  if [[ -n $who_name && -n $who_mail ]] && run git config --global user.name "$who_name" && run git config --global user.email "$who_mail"; then
    did "git commits here as $who_name <$who_mail>, the repository's owner (git config --global)"
  else
    todo "a git identity: git config --global user.name \"<name>\" && git config --global user.email \"<address>\" (commits here fail with \"Author identity unknown\" until then)"
  fi
fi

# ---------------------------------------------------------------------------
step "BACKUP_PASSPHRASE in .env, for the nightly job"
if { [[ -n $PASS ]] && [[ -f $APP_DIR/.env ]]; } || (( DRY_RUN )); then
  run_with_pass node "$APP_DIR/tools/backup-secrets.mjs" --save-passphrase-from-env
  did "BACKUP_PASSPHRASE kept in .env (mode 0600)"
elif has_env_passphrase; then
  info "= .env already has BACKUP_PASSPHRASE"
  did "BACKUP_PASSPHRASE in .env"
elif [[ -f $APP_DIR/.env ]]; then
  todo "node tools/backup-secrets.mjs --set-passphrase (no passphrase in .env yet)"
else
  info "no .env here yet, so nothing to keep the passphrase in"
fi

# ---------------------------------------------------------------------------
step "whatsapp-bot.service (templated for this machine)"
# routine: service-unit
# routine: start-at-boot
NODE_BIN=$(command -v node || true)
if [[ -z $NODE_BIN ]]; then
  (( DRY_RUN )) || die "node is not on PATH even after install.sh"
  NODE_BIN=/usr/bin/node
fi
"${UNITS[@]}" whatsapp-bot --node "$NODE_BIN" || die "rendering whatsapp-bot.service failed"
did "whatsapp-bot.service installed (ExecStart=$NODE_BIN)"

# Enabled at boot ONLY together with being started, on a typed yes. An enabled
# unit starts the bot at the next reboot - a kernel update, a Hyper-V host
# restart, powering off to enlarge the disk for grow-root-disk - whether or not
# the old machine is still running: connectionReplaced, one reboot after
# somebody answered "no".
START_CMD="sudo systemctl enable --now whatsapp-bot"
STARTED=0
# FRESH_BOT and ACTIVE are from the questions step, where START_ANSWER was
# asked. ACTIVE is read again: nothing here starts the bot before this point,
# but somebody else may have.
ACTIVE=$(systemctl show -p ActiveState --value whatsapp-bot.service 2>/dev/null || true)
case $ACTIVE in
  active|activating|reloading)
    # Already running here, so this is the live machine: keep it coming back
    # after a reboot.
    info "= whatsapp-bot is already running here"
    enable_unit whatsapp-bot.service
    STARTED=1
    did "whatsapp-bot running here, and enabled at boot"
    ;;
  *)
    if (( ! DRY_RUN )) && unit_enabled whatsapp-bot.service; then
      warn "whatsapp-bot.service is enabled at boot but not running, so the next reboot starts it. If another machine runs this number: sudo systemctl disable whatsapp-bot"
    fi
    if (( DRY_RUN )); then
      info "would, only if 'Is the bot stopped on the old machine?' was answered 'yes' and port $(web_port) is free, enable it at boot and start it:"
      info "  + $START_CMD.service"
      todo "enable and start the bot (dry run)"
    elif [[ ! -f $APP_DIR/.env ]] && (( ! FRESH_BOT )); then
      # Starting now would mint a NEW MASTER_KEY, and the restore would then
      # refuse to clobber it.
      todo "restore the app bundle first, then: $START_CMD (only once the old machine is stopped)"
    else
      # Starting needs a human's word that the old machine is off, given at
      # the questions. No word (no terminal, no OLD_BOT_STOPPED): not started,
      # and not enabled at boot either.
      REPLY=$START_ANSWER
      PORT=$(web_port)
      PORT_BLOCKED=0
      if [[ $REPLY == yes ]] && ! port_free "$PORT"; then
        # Started onto a taken port the bot crash-loops, and the updater takes
        # the newest commit back out for it.
        warn "not starting the bot: port $PORT is taken"
        while IFS= read -r line; do warn "  $line"; done <<<"$PORT_REPORT"
        PORT_BLOCKED=1; REPLY=''
      fi
      if [[ $REPLY == yes ]]; then
        run sudo systemctl enable --now whatsapp-bot.service
        STARTED=1
        did "whatsapp-bot enabled at boot and started here"
      elif (( PORT_BLOCKED )); then
        how="the command is above"
        if [[ $PORT_REPORT == *remove-installer-snaps.sh* ]]; then
          how="$SNAPS_TOOL removes it with the installer's other extra snaps"
        fi
        todo "free port $PORT (${PORT_REPORT%%$'\n'*}; $how), then: $START_CMD"
      else
        todo "$START_CMD (only once the old machine is stopped; left disabled until then)"
      fi
    fi
    ;;
esac

# ---------------------------------------------------------------------------
step "Nightly sealed backup (cron, 05:17 UTC)"
# routine: sealed-backup
if (( NEW_NUMBER )); then
  # One branch, one machine: the branch holds the other number's backup, and a
  # nightly job here would only ever be refused. Recorded as skipped, so the
  # check a later session runs does not suggest --take-over, which would
  # replace the other bot's only backup.
  skipped "nightly sealed backup (--new-number: the sealed-backup branch belongs to the machine running the other number)"
  SKIPS+=("sealed-backup=this box runs another number: the sealed-backup branch belongs to the machine running the first (tools/bootstrap.sh --new-number)")
elif has_env_passphrase || (( DRY_RUN )); then
  run node "$APP_DIR/tools/backup-secrets.mjs" --install-cron
  did "nightly backup to the sealed-backup branch"
  if (( DRY_RUN )); then
    info "and, if this run restored the app bundle and started the bot, claim the branch for this machine:"
    info "  + node $APP_DIR/tools/backup-secrets.mjs --take-over"
  elif (( STARTED && RESTORED_APP )); then
    # This machine restored the branch's copy and now runs it, so the branch
    # should say so now rather than at 05:17 (the nightly job would do the
    # same, having the same MASTER_KEY; the old machine's copy goes to
    # archive/ either way). ONLY then. A box that kept its own .env and data
    # is a different bot, and taking over from one replaced the live bot's
    # only backup and broke its nightly job for good (review, 2026-09-22).
    if run node "$APP_DIR/tools/backup-secrets.mjs" --take-over; then
      did "sealed-backup branch now holds this machine's backup (the previous one is kept under archive/)"
    else
      todo "node tools/backup-secrets.mjs --take-over (the first backup from here failed; see above)"
    fi
  elif (( RESTORED_APP )); then
    todo "after starting the bot here (enabled at boot): the nightly backup puts this machine's at the top of the branch and archives $B_HOST's by itself; or now: node tools/backup-secrets.mjs --take-over"
  elif [[ $BRANCH_STATE == present && $B_MINE != yes ]]; then
    info "the sealed-backup branch holds the backup of $B_HOST ($B_CREATED), not this machine's; it is left alone"
    todo "only if THIS machine now runs the bot that $B_HOST ran, and $B_HOST is retired: node tools/backup-secrets.mjs --take-over (it moves $B_HOST's backup to archive/ on the branch)"
  fi
elif [[ $BRANCH_STATE == present && ! -f $APP_DIR/.env ]]; then
  # The app bundle is still to come (see above); the next run of this script
  # installs the nightly job once it has.
  info "not yet: the app bundle is not restored here"
else
  todo "node tools/backup-secrets.mjs --set-passphrase --install-cron"
fi

# ---------------------------------------------------------------------------
step "The hourly check (cron, on the hour, and at once for a library keeper's #issue)"
# routine: hourly-check
# Every hour it looks for requests that failed or went unanswered, has
# headless Claude Code fix what is a bug, ships what passes the suite,
# restarts the bot into it and emails a report (docs/operations.md, "The
# hourly check"). It belongs to the box that runs the bot: anywhere else it
# would research a bot that is not there, and push fixes for it.
#
# The installer's cron line is a tick every minute: the hourly run on the
# hour, and the check at once when the bot asks for it, for a library
# keeper's #issue (the operator, 2026-10-12: "Needless to say #issue tickets
# submitted by head admin 5558100180 get top priority"). Nothing else here
# changes for it: the installer writes the line, and the bot the request.
#
# Its one step that needs a person is a Claude login cron can use: `claude
# setup-token` opens a browser login and prints a long-lived token. It was
# asked for with the Claude Code step, near the start, and saved then; the
# installer tests a token that is already in its file. It is asked for here
# only when that step could not ask (Claude Code was not installed then, say):
# never twice, and never when nobody is at a terminal. It is always handed
# over on stdin - never on a command line, where `ps` and the shell history
# would keep it - and saved mode 600 in a folder made 700.
if (( DRY_RUN )); then
  info "would install it once the bot runs here:"
  info "  + $HOURLY"
  info "and, only if the Claude Code step could not ask for the token, explain claude setup-token and ask for it here, with no echo:"
  info "  + $HOURLY --set-token   (the token on stdin; mode 600 in a 700 folder; then one tiny test call)"
  todo "the hourly check (dry run)"
elif (( ! STARTED )); then
  # A token given at the start for a bot that then was not started (its port
  # was taken, say) is already saved, so the login is not asked for twice.
  skipped "the hourly check (the bot does not run here; once it does, node tools/routines.mjs --fix installs it)"
else
  if run bash "$HOURLY"; then
    did "the hourly check, in cron: on the hour, and at once for a library keeper's #issue"
  else
    warn "installing the hourly check failed (see above)"
    todo "$HOURLY (it failed here; see above)"
  fi
  if hourly_token; then
    info "= a Claude token is in $HOURLY_ENV"
  elif (( TOKEN_OFFERED )); then
    info "no token was given at the start, so it is on the checklist rather than asked for again"
  elif (( HAVE_TTY )); then
    echo
    echo "   The hourly check needs a Claude login it can use from cron, made once:"
    echo "     $CLAUDE_BIN setup-token"
    echo "   It opens a browser login and prints a long-lived token. Run it in another"
    echo "   terminal on this box, or on any computer where you use Claude Code."
    IFS= read -rs -p "   Paste the token here (it is not shown; Enter alone skips this): " HTOKEN <&3 || HTOKEN=''
    echo >&2
    if [[ -z $HTOKEN ]]; then
      todo "$TOKEN_TODO"
    elif printf '%s\n' "$HTOKEN" | bash "$HOURLY" --set-token; then
      did "the hourly check's Claude token, saved and tested"
    else
      todo "$TOKEN_TODO (the token given here did not save or did not pass its test; see above)"
    fi
    HTOKEN=''
  else
    todo "$TOKEN_TODO"
  fi
fi

# ---------------------------------------------------------------------------
step "The Cloudflare tunnel to the panel"
# routine: cloudflare-tunnel
# The tunnel was "the one piece set up by hand", and by hand is how it went
# wrong: on 2026-09-30 bot-box2's was started with the Docker command the
# Cloudflare dashboard offers, and every visit failed with "connection
# refused", because on Docker's bridge network the ingress rule's localhost
# is the container, not the box. deploy/install-cloudflared.sh runs it as
# cloudflared.service instead, and keeps its token in .env as
# CLOUDFLARE_TUNNEL_TOKEN, which the restore above brought back. So it comes
# back here by itself - on the box that now runs the bot, and only there: two
# connectors on one token are replicas, and Cloudflare sends each visit to
# either. Nothing is asked here (every question came first); the old box's
# cloudflared is on the checklist to stop.
CLOUDFLARED="$DEPLOY/install-cloudflared.sh"
has_env_tunnel_token() {
  [[ -f $APP_DIR/.env ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?CLOUDFLARE_TUNNEL_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]' "$APP_DIR/.env"
}
CF_ACTIVE=$(systemctl is-active cloudflared.service 2>/dev/null || true)
CF_ENABLED=$(systemctl is-enabled cloudflared.service 2>/dev/null || true)
# Whether the bot runs here is asked first. The first version ticked a
# running cloudflared off as done before it looked, so on a clone of the
# bot's VM, or a box standing by, a second connector - half the panel's
# visits - went on the checklist as "[x]" (review, 2026-09-30).
if (( DRY_RUN )); then
  info "would, once the bot runs here and if the restored .env holds CLOUDFLARE_TUNNEL_TOKEN, run cloudflared as a service with it:"
  info "  + bash $CLOUDFLARED --from-env"
  todo "the Cloudflare tunnel (dry run)"
elif (( ! STARTED )); then
  if [[ $CF_ACTIVE == active || $CF_ENABLED == enabled ]]; then
    warn "cloudflared.service is ${CF_ACTIVE:-inactive} here, and ${CF_ENABLED:-not enabled} at boot, but the bot does not run here: a second connector of its tunnel takes half the panel's visits"
    todo "sudo systemctl disable --now cloudflared   (the bot does not run here, so its tunnel must not either - unless this box is taking the bot over: then leave it, and start the bot)"
  elif has_env_tunnel_token; then
    skipped "the Cloudflare tunnel (the bot does not run here; once it does, and cloudflared is stopped on the old machine, node tools/routines.mjs --fix installs it from .env)"
  else
    skipped "the Cloudflare tunnel (no CLOUDFLARE_TUNNEL_TOKEN in .env, and the bot does not run here)"
  fi
elif [[ $CF_ACTIVE == active ]]; then
  # Running already - but whether it runs the way the script sets it up (a
  # --token-file unit, its token in .env for the backup) is the routines
  # check's to say, below; only a copy missing from .env is put right here.
  if [[ $(systemctl show -p ExecStart --value cloudflared.service 2>/dev/null || true) != *--token-file* ]]; then
    info "= cloudflared.service runs here, but not as deploy/install-cloudflared.sh sets it up: the routines check below says what to change"
  elif has_env_tunnel_token; then
    did "the Cloudflare tunnel runs here, its token kept in .env for the sealed backup"
  elif run bash "$CLOUDFLARED" --record-env; then
    did "the Cloudflare tunnel runs here; its token is now kept in .env for the sealed backup"
  else
    todo "$CLOUDFLARED --record-env   (the tunnel runs, but the sealed backup does not carry it)"
  fi
elif ! has_env_tunnel_token; then
  skipped "the Cloudflare tunnel (no CLOUDFLARE_TUNNEL_TOKEN in .env; to set one up: $CLOUDFLARED, never the dashboard's docker run command - docs/server-setup.md, section 7)"
elif run bash "$CLOUDFLARED" --from-env; then
  did "the Cloudflare tunnel, as cloudflared.service, from CLOUDFLARE_TUNNEL_TOKEN in .env (stop cloudflared on the old machine: see below)"
else
  warn "the Cloudflare tunnel did not come up (see above)"
  todo "$CLOUDFLARED --from-env   (it failed here; journalctl -u cloudflared -n 50)"
fi

# ---------------------------------------------------------------------------
step "The Claude session, back after every reboot"
# routine: claude-session
# The operator, 2026-09-30: "How do I set in the vm that this session ...
# should automatically resume after a reboot?" deploy/install-claude-session.sh
# turns linger on (sudo), writes a user unit that runs `claude --continue` in
# this checkout inside a detached tmux session "claude" at boot, enables it,
# and adds a ~/.bashrc hook that attaches an interactive SSH login to it. It
# belongs with the bot, as the session that looks after it does. It is enabled
# here and never started: a claude may be running on this checkout right now
# (this very run may be one's), and two processes on one conversation
# interleave it. It starts at the next boot. Nothing is asked here.
CLAUDE_SESSION="$DEPLOY/install-claude-session.sh"
if (( DRY_RUN )); then
  info "would, once the bot runs here, enable the Claude session at boot (never start it now):"
  info "  + bash $CLAUDE_SESSION"
  todo "the Claude session after a reboot (dry run)"
elif (( ! STARTED )); then
  skipped "the Claude session after a reboot (the bot does not run here; once it does, node tools/routines.mjs --fix sets it up)"
elif run bash "$CLAUDE_SESSION"; then
  did "the Claude session: enabled at boot in tmux session \"claude\", and an SSH login attaches to it (from the next boot; before then: $CLAUDE_SESSION --start-now, once no other claude runs on this checkout)"
else
  warn "setting up the Claude session after a reboot failed (see above)"
  todo "$CLAUDE_SESSION   (it failed here; see above)"
fi

# ---------------------------------------------------------------------------
step "LAN address"
# routine: lan-address
# The panel is reached at http://<address>:8080, so the address must not move.
# The operator chose a static one (2026-09-29, "assign ubuntu static
# 192.168.20.45"): deploy/pin-lan-address.sh --static writes the netplan file,
# checks it with netplan generate, and --apply puts it live behind an undo
# that brings the old config back after 3 minutes unless the gateway answers
# from the new one. The same address should be reserved for this MAC on the
# router, or the router can hand it to another device.
#
# At the address the box has now, it is applied here: nothing moves. At a new
# one, it is written and checked here, and applied only after the checklist
# is printed, because an SSH session to the old address drops the moment it
# goes live.
PIN="$DEPLOY/pin-lan-address.sh"
LAN_APPLY_LATER=0
case $LAN_CHOICE in
  '')
    skipped "LAN address (not asked: no terminal, or no LAN address; LAN_ADDRESS=<address> sets one)" ;;
  wsl)
    skipped "LAN address (WSL: mirrored networking gives it the laptop's own address; reserve that one for the laptop on the router)" ;;
  skip)
    skipped "LAN address (left as it is, as asked)" ;;
  dhcp)
    # The older way: stay on DHCP and ask the router for the same address, as
    # this MAC. It takes effect at the next boot.
    if run bash "$PIN"; then did "LAN address: the router is asked to keep it (DHCP, from the next boot)"
    else todo "$PIN   (it failed here; see above)"; fi ;;
  *)
    if [[ $LAN_CHOICE == "$LAN_NOW" ]]; then
      if run bash "$PIN" --static "$LAN_CHOICE" --apply; then
        did "static LAN address $LAN_CHOICE, applied and confirmed (reserve it for this MAC on the router too)"
      else
        todo "static LAN address: $PIN --static $LAN_CHOICE --apply   (it failed here and was undone; see above)"
      fi
    elif run bash "$PIN" --static "$LAN_CHOICE"; then
      LAN_APPLY_LATER=1
      did "static LAN address $LAN_CHOICE written and checked; applied after this list (reserve it for this MAC on the router too)"
    else
      todo "static LAN address: $PIN --static $LAN_CHOICE --apply   (it was refused; see above)"
    fi ;;
esac

# ---------------------------------------------------------------------------
step "Routines: everything this box should run, checked"
# The same check a new Claude session runs first (CLAUDE.md, "Routines every
# box runs"): every routine in src/core/routines.js, on this box. It changes
# nothing; what it finds missing goes on the checklist below, with the
# command that activates it.
if (( DRY_RUN )); then
  if (( ${#SKIPS[@]} )); then info "would record: ${SKIPS[*]}"; fi
  info "would check every routine on this box and list what is still missing:"
  info "  + node $APP_DIR/tools/routines.mjs"
  todo "node tools/routines.mjs (dry run)"
else
  if (( ${#SKIPS[@]} )); then
    for entry in "${SKIPS[@]}"; do
      run "$NODE_BIN" "$APP_DIR/tools/routines.mjs" --skip "${entry%%=*}" --reason "${entry#*=}" || true
    done
  fi
  if run "$NODE_BIN" "$APP_DIR/tools/routines.mjs"; then
    did "every routine that applies to this box is in place (node tools/routines.mjs)"
  else
    todo "node tools/routines.mjs lists what is still missing above: --fix activates what needs no person, and prints the command for the rest"
  fi
fi

# ---------------------------------------------------------------------------
step "Checklist"
(( DRY_RUN )) && info "(dry run: nothing above was changed)"
for line in "${CHECKLIST[@]}"; do info "$line"; done
cat <<EOF

   Then, in the panel (http://<this machine's Tailscale name>:8080):
     - Dashboard shows Connected, on the right number, with no re-link
     - your existing admin password is accepted (MASTER_KEY came across)
     - Settings -> Library -> Test connection passes
EOF
if (( ! NEW_NUMBER )); then
  cat <<EOF
   On the OLD machine, once this one is live:
     sudo systemctl disable --now whatsapp-bot
     node tools/backup-secrets.mjs --remove-cron
     sudo systemctl disable --now cloudflared    (if it ran the tunnel: two connectors on one token split the visits)
EOF
fi

# The new static LAN address, last of all: the checklist is on the screen
# before an SSH session to the old address drops. The apply and its undo run
# as their own transient units, so they finish even if this session does not.
if (( LAN_APPLY_LATER )); then
  echo
  info "Applying the static LAN address $LAN_CHOICE now. An SSH session to $LAN_NOW drops:"
  info "reconnect to $LAN_CHOICE (or over Tailscale). If the box cannot reach its gateway"
  info "from the new address, the old config comes back by itself within 3 minutes."
  run bash "$PIN" --static "$LAN_CHOICE" --apply || warn "the static address did not take, and was undone (see above)"
fi
