# Setting up a new Ubuntu server

Everything needed to take a bare Ubuntu box to a running bot with a control
panel reachable from outside. Written to be followed top to bottom by someone
— or some Claude session — who has never seen this machine before.

Read **[operations.md](operations.md)** first if the bot is already running
somewhere else. Two machines holding the same WhatsApp session at once is the
single most account-flagging thing this project can do, and the hand-off
procedure is there, not here.

---

## One paste: a new VM in one go

On a fresh **Ubuntu Server 24.04** VM, logged in over SSH as the user that
will run the bot (not root), paste this whole block once. It installs `gh`
and logs it in, clones the repository to `~/whatsapp-bot`, and runs
`tools/bootstrap.sh`, which asks its questions and does its logins first and
then does everything else by itself: the installer's extra snaps, the
packages and Node, yt-dlp and deno (for YouTube links on "Queue a public
link"), Tailscale, Claude Code and its login, the restore from the
sealed backup, a git identity, the service, the nightly backup, the hourly
check with its Claude token, the Cloudflare tunnel (from the token the
backup's `.env` holds), the static LAN address, and a last
`node tools/routines.mjs`.

**When installing Ubuntu, leave every "Featured server snap" unticked.**
bot-box2 was built with most of them (sabnzbd, microk8s, nextcloud,
rocketchat-server, wekan, prometheus, mosquitto and more): SABnzbd took port
8080, so the bot died at every start with `EADDRINUSE`, and together they held
about 3 GB of RAM. If they are there, bootstrap lists them and asks once,
with the other questions, whether to remove them
(`tools/remove-installer-snaps.sh`; `REMOVE_INSTALLER_SNAPS=yes` answers in
advance), and does so before it installs anything. It never starts the bot
onto a taken port; whatever else holds it is named, with the command that
would stop it. On a box set up some other way:
`tools/remove-installer-snaps.sh --dry-run`, then the same without it.

If the bot is still running on an old machine, do the hand-over steps in
[the fast path below](#fast-path-rebuild-from-the-sealed-backup) there
first, so the backup this restores is the final one.

```bash
(
  set -eo pipefail
  # 0. The sudo password, once. On a first boot apt's daily jobs hold its lock
  #    for a few minutes, and apt-get fails at once rather than wait for it.
  sudo -v
  if command -v fuser >/dev/null; then
    while sudo fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1; do
      echo "waiting for the boot-time apt updates to finish..."; sleep 10
    done
  fi
  # 1. GitHub CLI. The repository is private, so it comes first.
  sudo apt-get -o DPkg::Lock::Timeout=600 update -qq
  sudo apt-get -o DPkg::Lock::Timeout=600 install -y -qq curl git
  if ! command -v gh >/dev/null; then
    K=$(mktemp)
    curl -fsSL -o "$K" https://cli.github.com/packages/githubcli-archive-keyring.gpg
    [ -s "$K" ] || { echo "could not download GitHub's apt key"; exit 1; }
    sudo install -m 0644 "$K" /usr/share/keyrings/githubcli-archive-keyring.gpg
    rm -f "$K"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get -o DPkg::Lock::Timeout=600 update -qq
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y -qq gh
  fi
  # 2. GitHub login: it prints a one-time code and a link to open on any device.
  gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web
  gh auth setup-git
  # 3. The code, at the path the service expects.
  [ -d ~/whatsapp-bot/.git ] || gh repo clone jewishmoviedude/whatsapp-movie-bot ~/whatsapp-bot
  cd ~/whatsapp-bot
  git pull --ff-only -q
  # 4. Everything else. Its questions and logins come first; after them it runs by itself.
  PASSWORDLESS_SUDO=yes tools/bootstrap.sh
  # 5. Every routine this box should run, checked once more.
  node tools/routines.mjs
)
```

The parentheses make it one command, so the shell reads the whole paste
before anything runs; without them, the lines after `gh auth login` would be
typed into its prompts. `set -eo pipefail` stops it at the first failure,
including one inside a pipe. `PASSWORDLESS_SUDO=yes` answers bootstrap's
first question in advance, since passwordless sudo is the standing choice
for a bot box ([§8](#give-claude-code-sudo)); a box whose sudo was narrowed
to the hourly check's one rule stays narrowed all the same (only
`PASSWORDLESS_SUDO=force` widens it). Leave it out to be asked.

**What it asks, all within its first six steps, in this order:**

| Prompt | Why it cannot be avoided |
|---|---|
| your sudo password, once | Ubuntu's installer gives your user sudo *with* a password; nothing can be installed until you type it. Bootstrap then makes sudo passwordless, so it is the last time. |
| **GitHub login** (`gh auth login`: `Y` to "Authenticate Git with your GitHub credentials?", Enter, then a one-time code and a link) | The repository, and the sealed backup inside it, are private, so nothing can be fetched before it. Its token is never in the backup, on purpose. |
| the backup passphrase (hidden) | It decrypts the sealed backup; it is never stored anywhere a new box could read it. Skipped when the repository has no backup yet. |
| "Remove them?" (`[Y/n]`), only if the installer's extra snaps are there | Removing them deletes their data, so it is asked, not assumed. |
| "Is the bot stopped on the old machine?" | Only a typed `yes` starts the bot here and enables it at boot. Two machines on one WhatsApp session is `connectionReplaced`, the fastest way to lose the number (CLAUDE.md, rule 3), so this is never assumed. Anything else leaves it installed but stopped. |
| the static LAN address (Enter keeps the one it has) | Which address the box owns is your decision; see [Keeping the same LAN address](#keeping-the-same-lan-address). |
| **Claude login** (`claude auth login`: a link and a code) | For Claude Code sessions on the box. |
| **Claude token** (`claude setup-token`, then paste it, hidden) | The hourly check runs headless Claude Code from cron, where nobody can log in, so it needs its own long-lived token. It is a second browser round-trip on the same account, only on the box that will run the bot, and it is saved the moment it is pasted. Enter skips it; it is then on the checklist, and not asked for again later in the run. |
| **Tailscale sign-in** (a link) | Tailscale SSH is how the Claude desktop app reaches the box. The node's identity is deliberately not in the backup (two machines with one identity fight over it), so a new box always signs in as a new node. No prompt if you set `TS_AUTHKEY` (below). |

So the separate logins are GitHub's and Claude's, as expected, plus
Tailscale's. The questions in between are answered in a second each, and
any of them can be answered in advance instead: bootstrap reads
`BACKUP_PASSPHRASE`, `REMOVE_INSTALLER_SNAPS=yes|no`, `OLD_BOT_STOPPED=yes`,
`LAN_ADDRESS=<address>|dhcp|skip`, `PASSWORDLESS_SUDO=yes|no|force` and
`TS_AUTHKEY` from the environment (`tools/bootstrap.sh --help`). For the two
secrets, read them hidden rather than typing them on a command line, where
they would land in the shell history - for example, put these lines before
step 4 inside the block:

```bash
  IFS= read -rsp 'Backup passphrase: ' BACKUP_PASSPHRASE; echo; export BACKUP_PASSPHRASE
  IFS= read -rsp 'Tailscale auth key (Enter to sign in with a link): ' TS_AUTHKEY; echo; export TS_AUTHKEY
```

(A Tailscale auth key is made at login.tailscale.com → Settings → Keys.)

**After the sixth step it asks only by exception:** a mistyped passphrase
(the restore asks again, up to three times), and a backup that was taken
while the old bot was still running (it asks before restoring that copy - do
the hand-over in the right order and it never does). Both wait for an
answer, so stay until the restore step has passed.

**At the end,** if you chose a static address different from the one the box
has, it is applied last of all, after the checklist is printed: the SSH
session to the old address drops, and you reconnect to the new one (or over
Tailscale). If the box cannot reach its gateway from the new address, the old
network config comes back by itself within three minutes. Then reserve the
same address for the box's MAC on the router, so the router never hands it to
another device, and make the VM's MAC static in Hyper-V (see
[Keeping the same LAN address](#keeping-the-same-lan-address), step 2): those
two are on the router and the host, where nothing on the box can reach.

---

## Fast path: rebuild from the sealed backup

If the old machine ran `node tools/backup-secrets.mjs --set-passphrase
--install-cron` (see [operations.md → Backups](operations.md#backups)), every
setting, login and key it had is on the repository's `sealed-backup` branch,
encrypted under a passphrase you chose. A new Ubuntu 24.04 box is then four
commands and that passphrase.

**Handing over from a machine that is still running?** Take the final backup
there first, in this order, or the new box restores last night's copy and
loses whatever the old bot did since (and re-posts jobs it finished):

```bash
# on the OLD machine
cd ~/whatsapp-bot
echo '{"op":"queue-status"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
# wait for "safeToRestart": true, or accept losing what is in flight
sudo systemctl disable --now whatsapp-bot
deploy/install-cloudflared.sh --record-env   # if it runs the tunnel: its token into .env, so the backup carries it
sudo systemctl disable --now cloudflared     # if it ran the tunnel: the new box runs it from here on
node tools/backup-secrets.mjs          # records that the bot was stopped
```

A box that set its tunnel up before the script kept the token in `.env`
(bot-box2 did, on 2026-09-30) has no `CLOUDFLARE_TUNNEL_TOKEN` there, and its
backup would bring no tunnel to the new box; `--record-env` copies it in
from `/etc/cloudflared/tunnel-token`, and says so when it is there already.

Then, on the new one, paste [the one block above](#one-paste-a-new-vm-in-one-go).
Or, by hand, the same four things it does:

```bash
# 1. gh (the repository is private, so this comes first)
sudo apt-get update && sudo apt-get install -y curl
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update && sudo apt-get install -y gh

# 2. log in: GitHub.com -> HTTPS -> authenticate git: Yes -> web browser
gh auth login

# 3. clone to ~/whatsapp-bot (the path the service expects)
gh repo clone jewishmoviedude/whatsapp-movie-bot ~/whatsapp-bot

# 4. rebuild. --dry-run first prints every action and changes nothing.
cd ~/whatsapp-bot && tools/bootstrap.sh --dry-run
tools/bootstrap.sh
```

`tools/bootstrap.sh` runs as your normal user and calls `sudo` itself. It is
safe to re-run: every step checks before it acts. Everything that needs you
comes in its first six steps, the last of them Tailscale's sign-in; after
that it asks only by exception (see above). In order, it:

1. asks for your sudo password once, and checks that the panel's port (8080)
   is free - if a snap or a service holds it, it names it and the command that
   would stop it;
2. offers passwordless sudo for your user (`[Y/n]`, or `PASSWORDLESS_SUDO`;
   the rule is checked with `visudo -cf` before it goes into
   `/etc/sudoers.d/`; the one command that does the same by hand is in
   [§8](#give-claude-code-sudo)), so Claude Code can manage the box without a
   password it cannot type. A box whose sudo was narrowed to the hourly
   check's one rule is left that way, even with `PASSWORDLESS_SUDO=yes`;
3. runs `gh auth setup-git`;
4. asks its questions, all at once: the backup passphrase, **once** (or
   `BACKUP_PASSPHRASE`), if origin has a `sealed-backup` branch; whether to
   remove the Ubuntu installer's extra snaps, if any are there (or
   `REMOVE_INSTALLER_SNAPS`); "Is the bot stopped on the old machine?" (or
   `OLD_BOT_STOPPED`), unless the bot already runs here; and the static LAN
   address to keep (Enter keeps the one it has now; or `LAN_ADDRESS`);
5. installs Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`, into
   `~/.local/bin`, no root) if it is missing, logs it in (`claude auth
   login`) if it is not, and - on the box that will run the bot, with no token
   for [the hourly check](operations.md#the-hourly-check) yet - runs `claude
   setup-token`, reads the token it prints, hidden, and saves it at once
   (see [§8, "The hourly check's token"](#the-hourly-checks-token)), so a run
   that stops later never throws it away;
6. installs Tailscale from its apt repository if it is missing, logs in with
   `tailscale up --ssh --operator=$USER` (a browser link, or `TS_AUTHKEY` if
   you set one) and turns on auto-update. Tailscale SSH is how the Claude
   desktop app reaches the box. The Tailscale node itself is **not** restored -
   the new box joins as a new node;
7. removes the installer's extra snaps, if the answer in step 4 was yes
   (`tools/remove-installer-snaps.sh`: exactly the installer's list, with
   `--purge`; Ubuntu's own base snaps stay);
8. runs `./install.sh` (ffmpeg, Node 20 from NodeSource, `npm install
   --omit=dev`), plus `git gnupg ethtool cloud-guest-utils`, then
   `npm install --include=dev`, so a Claude session on the box can run the
   whole test suite. Every `apt-get` waits for the lock the boot-time updates
   hold, rather than failing;
9. installs [grow-root-disk](#growing-the-root-disk) and runs it once;
10. on a Hyper-V NIC, applies the [offload fix](#hyper-v-slow-lossy-uploads)
    and installs the unit that re-applies it at boot;
11. restores both bundles from `origin/sealed-backup` with the passphrase
    from step 4: the app bundle into `~/whatsapp-bot` and the home bundle into
    `~`. It shows when and where the backup was taken first, and if the old
    bot was still running at the time, it restores the app bundle only when
    you type `yes` (with no terminal, it does not). It restores the current
    backup, the one at the top of the branch; if the branch also keeps
    archived backups of other machines (`archive/`, see
    [operations.md → Backups](operations.md#backups)) it names them, and how to
    restore one of those instead;
12. points git at gh's login again (the restored `~/.gitconfig` may be the old
    box's) and, if git has no identity here, gives it the repository owner's,
    the author of the last commit on `main` (`git config --global`), so a
    commit made on the box works;
13. keeps `BACKUP_PASSPHRASE` in `.env` for the nightly job;
14. installs `whatsapp-bot.service` templated for this machine (your user, this
    directory, `ExecStart=$(command -v node)`). The unit pulls updates from
    `main` before every start (`deploy/auto-update.sh`, using the gh login
    from step 3), so the box never needs pulling by hand - see
    [operations.md](operations.md#upgrading). It enables it at boot and starts
    it, in one step, **only** if the answer in step 4 was a typed `yes` (or
    `OLD_BOT_STOPPED=yes`) and the panel's port is free. An enabled unit starts
    the bot at the next reboot whether anyone asked or not, so with any other
    answer, or no terminal, it stays disabled and the checklist says
    `sudo systemctl enable --now whatsapp-bot` for when the old one is off;
15. installs the nightly backup, and - only if it restored the app bundle and
    started the bot - claims the branch for this machine with
    `backup-secrets.mjs --take-over`; the old machine's backup moves to
    `archive/` on the branch, unchanged. (Left for later, the nightly job
    does the same by itself once the bot runs here, enabled at boot.) A box
    that kept its own `.env` is a different bot and never claims it;
16. if the bot now runs here, installs the hourly check
    (`deploy/install-hourly-debug.sh`), which tests the token saved in step 5.
    It asks for a token here only if step 5 could not (Claude Code was not
    installed then, say); a token skipped in step 5 goes on the checklist;
17. if the bot now runs here and the restored `.env` holds
    `CLOUDFLARE_TUNNEL_TOKEN`, brings the Cloudflare tunnel back as
    `cloudflared.service` (`deploy/install-cloudflared.sh --from-env`, see
    [§7](#the-permanent-one-cloudflare-tunnel)). It asks nothing; the checklist
    reminds you to stop `cloudflared` on the old machine, since two
    connectors on one token split the visits between them;
18. makes the LAN address from step 4 static
    (`deploy/pin-lan-address.sh --static`, see
    [Keeping the same LAN address](#keeping-the-same-lan-address)): at the
    address the box has now, applied at once; at a new one, written and
    checked here and applied after the checklist (below);
19. runs `node tools/routines.mjs`, the check every new Claude session runs
    first ([below](#check-the-routines)), and puts what it still finds missing
    on the checklist;
20. prints a checklist of what it did and what is left - and then, if the
    static address is a new one, applies it, with a 3-minute undo if the box
    cannot reach its gateway from it.

The systemd pieces (steps 9, 10 and 14) are installed by
`deploy/install-units.sh`, the same installer `node tools/routines.mjs --fix`
uses.


`tools/bootstrap.sh --new-number` is for a box that will run a bot on a
**different** number: it does all of the machine setup and restores the home
bundle, but never the app bundle (the other bot's session and `MASTER_KEY`),
and never touches the branch.

What comes back, with nothing retyped:

| Bundle | Restores into | Contents |
|---|---|---|
| app | `~/whatsapp-bot` | `.env` (MASTER_KEY, BACKUP_PASSPHRASE, and CLOUDFLARE_TUNNEL_TOKEN if the box ran the tunnel), `data/config.json` (every setting and API key), `data/session/` and `data/sessions/` (the linked numbers — **no re-link**), `data/state.json`, `data/outbound-budget.json`, `data/backups/`, `data/yt-dlp-cookies.txt` (the YouTube cookies yt-dlp signs in with, restored 0600), `certs/*.crt`/`*.pem` |
| home | `~` | `~/.claude/settings.json`, `CLAUDE.md`, `keybindings.json`, `agents/`, `commands/`, `skills/`, every project's `memory/`; `~/.gitconfig`; `~/.ssh` |

What deliberately does not: the gh token (`~/.config/gh/hosts.yml` — you log
in as step 2 anyway, and a token in a backup outlives every rotation),
`~/.claude.json` (machine identity and caches), Claude Code transcripts,
Tailscale node state, web panel logins (`data/sessions.json`), logs and media.
Anything the home bundle would replace is kept beside it as `name.~1~`,
except `~/.ssh/authorized_keys` and `~/.ssh/known_hosts`: those gain the old
machine's lines and lose none of their own, so a key the installer imported
still logs in.

If the restore refuses because `.env` or `data/` already exist, this checkout
has been set up before; bootstrap then restores the home bundle only.

**Restoring an archived backup instead.** The top of the branch is the
current backup. Another machine's last one, kept under `archive/` when this
bot moved house, restores into a fresh clone with
`node tools/restore-secrets.mjs --list-archive`, then
`node tools/restore-secrets.mjs --from-archive <folder>` - with that machine's
passphrase, which may not be the current one. The Cloudflare tunnel comes
back from the `CLOUDFLARE_TUNNEL_TOKEN` the restored `.env` holds, once the
bot runs on the new box (bootstrap, or `node tools/routines.mjs --fix`); stop
`cloudflared` on the old one ([section 7](#7-reaching-the-panel-from-outside)).

Once the bot is running, the **Fresh install checklist** at the top of the
panel's Settings tab should show every required step done. Anything still red
there did not come across, and its link goes straight to the setting.

Everything below is the long way round - what the script does, step by step,
for a box with no backup or when something needs doing by hand.

---

## What you are building

| Piece | Why |
|---|---|
| Node 20+, ffmpeg | the bot itself, and the re-encode that keeps files under WhatsApp's 2 GB cap |
| the repo + `npm install` | the app |
| `.env` with `MASTER_KEY` | decrypts `data/config.json`. **Lose it and every saved secret is gone** |
| a systemd unit | so a reboot brings the bot back without a human |
| `cloudflared` | reaches the panel from outside without port-forwarding |
| `gh` + Claude Code | so the next session can work on the box directly |

Budget 20–30 minutes, most of it `apt` and `npm`.

---

## 0. Before you start

Have these to hand:

- **The backup passphrase**, if the old machine kept a sealed backup. Then
  you want the [fast path](#fast-path-rebuild-from-the-sealed-backup), not
  this section.
- **The `.env` from the existing machine**, if this box is replacing or joining
  an existing install. Without it the new box cannot read the old
  `data/config.json` — see [Moving an existing install](#5-moving-an-existing-install).
- The GitHub account that owns `jewishmoviedude/whatsapp-movie-bot` (it is private).
- The Cloudflare account that owns the hostname you want to serve the panel on.
- A phone with the bot's WhatsApp number on it, for linking.

Check what you are on:

```bash
lsb_release -a
nproc && free -h && df -h /
```

Encoding is CPU-bound and single-job-at-a-time. Two cores works; it is just
slower. Disk matters more — a movie mid-encode needs room for the source *and*
the output, so keep several tens of GB free.

---

## 1. System packages

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg curl ca-certificates git
```

### Node 20+

`package.json` sets `"engines": { "node": ">=20.0.0" }`. Two ways in, and the
one you pick changes a line in the systemd unit later, so note which you used.

**With sudo — NodeSource (what `install.sh` does):**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
command -v node        # -> /usr/bin/node
```

**Without sudo — unpack into `$HOME/.local/node`:**

```bash
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
mkdir -p "$HOME/.local/node"
tar -xJf /tmp/node.tar.xz -C "$HOME/.local/node" --strip-components=1
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/node/bin:$PATH"
command -v node        # -> /home/<user>/.local/node/bin/node
```

`start.sh` already knows about the second location and adds it to `PATH`
itself, so the launcher works either way. **systemd does not** — it needs the
absolute path, which is why you noted it.

Verify:

```bash
node -v && npm -v && ffmpeg -version | head -1 && ffprobe -version | head -1
```

### Growing the root disk

The Ubuntu 24.04 installer, on LVM, gave `/` only 14.5 GB of a 28.9 GB
partition on this bot's first VM - and a film mid-encode needs room for the
source *and* the output. `deploy/grow-root-disk` grows `/` into whatever free
space its disk has (`growpart`, `pvresize`, `lvextend -r`), and
`deploy/grow-root-disk.service` runs it at every boot, before the bot. After
that, enlarging the VM's virtual disk while it is off needs nothing typed at
all. It only grows, is a no-op when there is nothing to grow, and leaves alone
a root that is not on LVM, a volume group spanning more than one disk, or a
physical volume that is not a partition (LVM on LUKS, or a whole-disk PV).

Run from the checkout — the `deploy/` paths are relative to it, and from `~`
every line fails with "cannot stat". Safe with the bot running: `lvextend -r`
grows the mounted filesystem in place.

```bash
cd ~/whatsapp-bot
sudo install -m 755 deploy/grow-root-disk /usr/local/sbin/grow-root-disk
sudo install -m 644 deploy/grow-root-disk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable grow-root-disk.service
sudo /usr/local/sbin/grow-root-disk      # and once now
```

`df -h /` shows the difference. If `/` is still about half the disk after
this, the installer's layout was something else — `lsblk` shows it.

### Hyper-V: slow, lossy uploads

On a Hyper-V guest (`readlink /sys/class/net/eth0/device/driver` ends in
`hv_netvsc`), TCP segmentation offload made this VM hand 64 KB
"super-segments" to the virtual switch, and some were dropped on the way out:
29% of TCP segments retransmitted, uploads at 1.5 Mbit/s, a 1.7 GB film taking
hours to post - while downloads ran at 20 MB/s and every other device on the
network tested fine. Turning offload off gave 86 Mbit/s:

```bash
cd ~/whatsapp-bot
sudo ethtool -K eth0 tso off gso off            # immediate, even mid-upload
sudo install -m 644 deploy/eth0-no-offload.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable eth0-no-offload.service   # and at every boot
```

If uploads are still slow with offload off, the limit is outside the VM: in
Hyper-V Manager, check the adapter's bandwidth management ("Maximum
bandwidth" should be 0), and whether the external switch is bridged over
Wi-Fi rather than a wired adapter.

### Keeping the same LAN address

The panel is reached at `http://<the box's address>:8080`, so an address that
changes breaks every bookmark and port forward pointing at it. bot-box is on
DHCP and went from `.25` to `.36` overnight.

**The bot box has a static address** - the operator's choice (2026-09-29:
"assign ubuntu static 192.168.20.45"), made by
`deploy/pin-lan-address.sh --static` ([step 4](#lan-static)), which
`tools/bootstrap.sh` runs with the address it asks for. The router should
reserve the same address for the box's MAC as well (step 2), or it can hand
that address to a phone. Steps 1-3 are how it stood before, and still what
to do on a box that stays on DHCP.

**1. See where it stands.**

```bash
ip -4 -br addr                  # the address:   eth0  UP  192.168.20.36/24
ip route show default           # the router:    default via 192.168.20.1 dev eth0
networkctl status eth0 | grep -E 'Address|Gateway|Client ID|Network File' -A1
cat /sys/class/net/eth0/address # the MAC the router knows this box by
```

`(DHCP4 via 192.168.20.1)` after the address means the router handed it out.
A file listed under `Network File:` below the netplan one is a request made
here earlier (step 3) — check it asks for an address on *this* network: the
one on bot-box still asked for `192.168.1.30` after the box moved to
`192.168.20.x`, and a router silently ignores an address from another subnet.

**2. Best: reserve it on the router.** Every router's DHCP settings have some
form of "DHCP reservation", "static lease" or "address reservation": pick this
box's MAC from step 1 and give it the address it has now. Nothing on the box
changes, and the router will never hand that address to anything else. It is
the only real guarantee — step 3 is not one on every router.

How, on most routers: open the router's admin page in a browser (the
address `ip route show default` prints after `via`, e.g. `http://192.168.1.1/`)
or the router maker's phone app, and sign in. Find the LAN or DHCP settings and
look for *DHCP reservation*, *static lease*, *address reservation* or *fixed
IP*. Add one: pick the box by name or by the MAC from step 1, and give it the
address it has now. If the router lets you, choose an address outside its DHCP
pool (the range it hands out), so nothing else is ever offered it. Save, then
reboot the box once and check with `ip -4 -br addr` that it came back on the
same address.

On Hyper-V, first make the MAC itself stable: with the VM off, *Settings →
Network Adapter → Advanced Features → MAC address → Static* (keep the current
value). A dynamic MAC can change when the VM is moved, restored or
re-imported, and to the router that is a new device with no reservation.

**3. When the router cannot reserve: make Ubuntu hold on to its address.**
The box stays on DHCP, with three settings:

- `SendRelease=no` — the one that matters most. By default networkd tells the
  router "I'm done with this address" every time the link is reset or the box
  shuts down, and a router may then give the address away and hand the box
  the next free one. bot-box's router did exactly that: three resets in
  two minutes took it from `.36` to `.37` to `.38`. Not releasing keeps the
  router's binding alive, and a router hands a device back the address it
  already holds for it.
- `ClientIdentifier=mac` — the router knows the box by its MAC rather than an
  ID generated on the box, so it is the same device after a rebuild or a
  restore. (Switching to it makes the box look new to the router *once*.)
- `RequestAddress=` — asks for the current address by name (DHCP option 50).
  Many routers honour it; some ignore it. Harmless either way.

Staying on DHCP has one advantage: the router still knows the address is in
use, so it cannot also hand it to a phone. A static address (step 4) gives
that up unless the router reserves it too, which is why step 4 says to.

Run this on the box **once**. It reads the address and MAC the box has now,
writes those three settings as a networkd drop-in, and changes nothing until
the next boot:

```bash
cd ~/whatsapp-bot
deploy/pin-lan-address.sh                  # the address it has now
deploy/pin-lan-address.sh 192.168.20.38    # or a given one on the same network
deploy/pin-lan-address.sh --print          # just show what it would write
```

It refuses an address on another network (a router ignores that silently),
says so when the box already is pinned, leaves a NetworkManager box alone, and
reminds you to make a Hyper-V MAC static. The file it writes is
`/etc/systemd/network/10-netplan-eth0.network.d/10-request-address.conf`.

A drop-in in `/etc/systemd/network/` is used because netplan has no keys for
these, and `netplan apply` (or cloud-init regenerating
`/etc/netplan/50-cloud-init.yaml`) never touches it.

**Do not `networkctl reload` or `networkctl reconfigure` to apply it now.**
Either one resets the link *with the old settings still in force*, so the
lease is released on the way out — and on a router like bot-box's that is a new
address, which is the very thing this is for. (An earlier version of these
instructions ended in `networkctl reload`, and every run moved bot-box one
address along.) The script never resets anything, so running it again is
harmless — use that to pin a different address, such as the one a reservation
names, or after moving the box to another network. The next reboot picks it
up; that reboot may still land on a new address one last time, as the old
setting releases on shutdown, and after it the box keeps whatever it has.

Check it with `networkctl status eth0` (the drop-in is listed under
`Network File:`) and, after the next reboot, `ip -4 -br addr`. A box that is
off for longer than the router's lease time can still come back somewhere
else — only a reservation (step 2) survives that.

On a desktop install (NetworkManager, where `networkctl` shows the link as
unmanaged), the same two settings are:

```bash
nmcli -g NAME connection show --active    # the connection name
sudo nmcli connection modify "<name>" ipv4.dhcp-client-id mac ipv4.addresses "" ipv4.method auto
```


NetworkManager has no requested-address setting of its own, so there, use a
reservation (step 2).

<a id="lan-static"></a>
**4. A static address: what the bot box uses.** One command, run on the box:

```bash
cd ~/whatsapp-bot
deploy/pin-lan-address.sh --static --print                   # see what it would write
deploy/pin-lan-address.sh --static 192.168.20.45 --apply     # write it, and apply it now
```

Without an address it keeps the one the box has now. It writes
`/etc/netplan/99-static-lan.yaml` (mode 600) for the default-route interface:
DHCP off, the address, the gateway the box uses now as its default route,
and the DNS servers and search domain DHCP gave it (from `resolvectl`). For
the bot box that is:

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: false
      addresses:
        - 192.168.20.45/24
      routes:
        - to: default
          via: 192.168.20.1
      nameservers:
        addresses:
          - 192.168.20.1
        search:
          - lan
```

`99-` sorts after cloud-init's `50-cloud-init.yaml`, so its `dhcp4: false`
wins, and it uses the same netplan id (`eth0`), so the two merge into one
definition. It also writes `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`
(`network: {config: disabled}`), or cloud-init would regenerate the network
config at a later boot and put DHCP back. `netplan generate` checks both
before anything is applied; files it refuses are taken back out at once.

It refuses an address on another network, the router's own, the broadcast
address, and an address something already answers a ping at.

Without `--apply` nothing goes live until the next boot. With it, a wrong
static address would cut the box off from the SSH session that could fix it,
so first a transient timer is armed (`systemd-run --on-active=180`) that puts
the previous files back and applies them again; then the new config is
applied, and it counts only once the address is on the interface and the
gateway answers a ping - that cancels the timer. If it does not, the old
config goes back at once. The apply and the check run as their own transient
units, so an SSH session that drops when the address changes cannot stop
them halfway; reconnect to the new address, or over Tailscale.
`journalctl -u pin-lan-apply -u pin-lan-revert` shows what happened.

Then **reserve the same address for the box's MAC on the router** (step 2).
With DHCP off the box holds no lease, so without a reservation the router
believes the address is free and can give it to another device: two devices
on one address, and the panel unreachable half the time. If the router's
DHCP pool does not reach that high, better still - pick an address outside it.

A step-3 drop-in does nothing with DHCP off; the script says so, and the
command to delete it, so nobody later reads it as the address in force.

To go back to DHCP: `sudo rm /etc/netplan/99-static-lan.yaml
/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`, then `sudo netplan try`
(it reverts by itself after 120 s unless you press Enter).

### GPU partitioning (GPU-P)

**Tried on bot-box2 on 2026-09-29, and it does not work on that laptop**
(a laptop with an NVIDIA GPU). The partition
attached, `dxgkrnl` built and the driver files went in, but `nvidia-smi` says
"GPU access blocked by the operating system" and ffmpeg's `h264_nvenc` fails
at `cuInit`. **Do not add a GPU partition to the bot's VM on that host.**
The operator moved the bot to WSL2 on that laptop instead (2026-09-29),
where `h264_nvenc` works through the Windows driver with nothing to copy:
see "Running on WSL (for the GPU)" below.

The encoder is `media.videoEncoder` (Settings → Library & files → Encoder):
`auto`, the default, encodes one second of a test pattern with `h264_nvenc`
at the first re-encode and uses the GPU if that works, else `libx264`;
`nvenc` and `cpu` force one. The GPU gets the same size, bitrate budget,
audio and faststart as the CPU (`buildEncodeArgs` in `src/media/ffmpeg.js`).
A film cut into pieces (`src/media/segmented.js`) has every NVENC piece made
at one bitrate, since NVENC writes the bitrate into the SPS and pieces with
different SPS cannot be joined. A GPU encode that fails for any reason is
done again on the CPU in the same job - a segmented one from its first
piece - so a request never fails for the GPU; three failures in a row leave the
GPU alone until the bot restarts, with an error in the log (and the alert
email). The diagnostics card shows which encoder is in use. After a Windows
NVIDIA driver update, a WSL2 box may need `wsl --shutdown` before NVENC works
again; until then films go on the CPU.

What was done, for anyone trying it on other hardware:

1. On the Windows host, in an elevated PowerShell, with the VM off, attach
   the NVIDIA card and only it. Without `-InstancePath`,
   `Add-VMGpuPartitionAdapter` attached the laptop's Intel iGPU as well:

   ```powershell
   $gpu = Get-VMHostPartitionableGpu | Where-Object Name -like '*VEN_10DE*'   # Windows 10: Get-VMPartitionableGpu
   Add-VMGpuPartitionAdapter -VMName <vm> -InstancePath $gpu.Name
   ```

2. Give the VM static memory. With the partition added, dynamic memory
   brought bot-box2 up with 2.5 GB:

   ```powershell
   Set-VM -VMName <vm> -StaticMemory -MemoryStartupBytes 8GB
   ```

3. On the VM, build the `dxgkrnl` kernel module, which Ubuntu's kernel does
   not have, from the community
   [staralt/dxgkrnl-dkms](https://github.com/staralt/dxgkrnl-dkms) package.
   DKMS rebuilds it at every kernel update.
4. Copy the user-mode half of the NVIDIA driver - libcuda, NVENC,
   `nvidia-smi`, which are in no Ubuntu package - from the host, from the same
   places WSL2 uses, with `deploy/gpu-p-copy-drivers.ps1`.

The repository is private and the host has no clone, so fetch the script
from the VM (the script needs an SSH login to it anyway), and run it with
`-ExecutionPolicy Bypass`, since Windows 10 and 11 refuse to run scripts by
default:

```powershell
scp mommy@192.168.20.45:whatsapp-bot/deploy/gpu-p-copy-drivers.ps1 $env:TEMP\
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\gpu-p-copy-drivers.ps1                               # to mommy@192.168.20.45
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\gpu-p-copy-drivers.ps1 -Target someone@192.168.20.50  # another VM
```

It copies `C:\Windows\System32\lxss\lib` to `/usr/lib/wsl/lib`, and the newest
`DriverStore\FileRepository\nv*` folder that holds `nvlddmkm.sys` (the driver
installed now) to `/usr/lib/wsl/drivers/<that folder>`, over scp. The files
are staged in `~/gpu-drv` on the VM, then moved into place with sudo (it
opens `ssh -t`, so sudo can ask for the password), made readable by everyone
(`chmod -R a+rX`), and `/etc/ld.so.conf.d/ld.wsl.conf` points the loader at
`/usr/lib/wsl/lib` before `ldconfig`. Windows' scp delivers every file
without an execute bit, and `a+rX` adds one only to folders and to files that
already have one, so `nvidia-smi` is made executable by name: on bot-box2 it
was left at 0644, and running it said "Permission denied". The script says
when it starts moving the files into place and when that is done, so a run
that stops between the copy and the move shows where it stopped (bot-box2's
did, with the files left in `~/gpu-drv`); running it again starts over. It
ends by running `nvidia-smi`, and fails loudly if that does not work, saying
that the files are in place and it is the GPU that is not reachable.

**Run it again after every NVIDIA driver update on Windows** - Windows Update
or the NVIDIA app can install one at any time. The VM's files must be the same
version as the host's kernel driver; with old ones `nvidia-smi` fails until
this is rerun. A new driver lands in a new `FileRepository` folder, so the old
one in `/usr/lib/wsl/drivers` is left behind unused; the script lists it, to
delete by hand.

**To undo it** - on bot-box2, where it does not work, the module and the files
are only a rebuild at every kernel update for nothing:

- on the host, with the VM off: `Remove-VMGpuPartitionAdapter -VMName <vm>`
  (and `Set-VM -VMName <vm> -DynamicMemory` to have dynamic memory back);
- on the VM: `sudo rm -rf /usr/lib/wsl /etc/ld.so.conf.d/ld.wsl.conf && sudo ldconfig`,
  then `sudo dkms remove dxgkrnl/<version> --all` (`dkms status` names the
  version).

---

## 2. GitHub access

The repo is private, so the box needs a credential before it can clone.

```bash
type -p curl >/dev/null || sudo apt-get install -y curl
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update && sudo apt-get install -y gh
```

Then log in. On a headless box choose **HTTPS** and **"Login with a web
browser"** — it prints an 8-character code you type on any other device:

```bash
gh auth login
```

Answer: `GitHub.com` → `HTTPS` → `Yes` (authenticate git with your GitHub
credentials) → `Login with a web browser`.

Confirm, then clone:

```bash
gh auth status
gh repo clone jewishmoviedude/whatsapp-movie-bot ~/whatsapp-bot
cd ~/whatsapp-bot
```

> **Clone it to `~/whatsapp-bot`, not to the repo's own name.** The systemd
> unit hardcodes `WorkingDirectory=/home/mommy/whatsapp-bot`, and
> `test/service-unit.test.mjs` pins that exact string. Using a different path
> means editing both.

`gh auth login` writes a token to `~/.config/gh/hosts.yml` and, with the git
credential helper enabled, `git push` from the box works with no further setup.

---

## 3. Install and first run

```bash
cd ~/whatsapp-bot
./install.sh
```

`install.sh` installs ffmpeg and Node, runs `npm install --omit=dev`, and
creates `data/` at mode 700. It does **not** create `.env`, install the
service, or configure anything — those are the next steps.

Start it once in the foreground so you can watch the first boot:

```bash
npm start          # this is ./start.sh, which is `node src/index.js` plus CA bundling
```

You are looking for:

```
[config] wrote MASTER_KEY to /home/<user>/whatsapp-bot/.env - back this file up, it decrypts your saved settings
[web] control panel listening on http://0.0.0.0:8080
```

Stop it with Ctrl-C once you have seen that.

### The `.env` / MASTER_KEY rule

`src/index.js` mints a random `MASTER_KEY` on first boot and appends it to
`.env` at mode 0600. Every secret in `data/config.json` — OMDb key, TMDB key,
Jellyfin token, SMTP app password, admin password hashes — is AES-256-GCM
encrypted with a key derived from it.

Three things worth knowing, because each one has a sharp edge:

- **The file wins over the environment.** If `.env` has a `MASTER_KEY` and the
  environment has a different one, `.env` is used and a warning is logged. That
  is deliberate: the file is what actually encrypted the data.
- **A wrong key fails silently.** `decrypt()` returns `''` rather than
  throwing, so the wrong `MASTER_KEY` does not crash the bot — it just makes
  every saved secret read as empty. A panel that suddenly has no OMDb key and
  will not accept your password is what that looks like.
- **`.env` is gitignored.** It is never in a clone. Back it up somewhere that
  is not this machine.

```bash
cp ~/whatsapp-bot/.env ~/whatsapp-bot-env-backup-$(date +%F).txt   # then get it off the box
```

---

## 4. What lives under `data/`

All gitignored. This is the entire runtime state of the bot:

| Path | What it is | Survives a rebuild? |
|---|---|---|
| `data/config.json` | every setting; secrets encrypted with `MASTER_KEY` | copy it **with `.env`** or not at all |
| `data/session/` | the default account's WhatsApp link (`creds.json` + keys) | copy to avoid re-linking |
| `data/sessions/<id>/` | additional WhatsApp accounts | same |
| `data/state.json` | request history, wanted list, **portal audit log**, plugin state | copy to keep history |
| `data/sessions.json` | web panel login sessions | disposable |
| `data/logs/debug-YYYY-MM-DD.log` | full debug trace, always at debug level | disposable |
| `data/media/` | download/encode scratch | disposable, can be large |
| `data/outbound-budget.json` | the rolling WhatsApp volume counter | copy it — see below |
| `data/backups/`, `data/descriptions-plan.json` | group-description tooling | only needed for that tooling |
| `data/bot-cmd.json`, `data/bot-cmd.result.json` | the file-based command channel (`queue-status`) | disposable |
| `data/extra-ca.pem` | generated by `start.sh` from `certs/` | regenerated |

> `data/outbound-budget.json` is the rolling counter that stops the bot
> hammering WhatsApp. Starting a fresh box with an empty one hands it a full
> budget on an account that may already be close to a penalty. If you are
> moving an install, bring it across.

Some suites are **expected** to fail on a new box, and knowing which saves
chasing a phantom regression:

| Install | Expected failures |
|---|---|
| `npm install` (dev) | `content-export`, `rules-freshness` — both read gitignored files under `data/` |
| `npm install --omit=dev` (production, what `install.sh` runs) | those two, **plus** `ai-key-test-panel`, `api-keys-section`, `beta-panel`, `connection-select`, `csv-export`, `fresh-install-checklist`, `hourly-checks-panel`, `login-autofill`, `portal-search`, `queue-panel-requests`, `settings-group-pickers`, `settings-reach`, `wanted-panel` — all thirteen stub a DOM with `linkedom`, a devDependency that `--omit=dev` removes |

The same list is in CLAUDE.md ("Running it"); keep the two in step.
`tools/bootstrap.sh` installs the dev dependencies after `install.sh`, so a
box it built is the first row; bot-box2, set up before it did, met all
fourteen there were on 2026-09-29.

```bash
npm test                     # production install: expect 15 failures, all of them the above
npm install --include=dev    # ...or pull in the dev deps and expect only the first 2
```

---

## 5. Moving an existing install

If the old machine kept a sealed backup, `node tools/restore-secrets.mjs
--from-branch` does all of this from the `sealed-backup` branch (and the
[fast path](#fast-path-rebuild-from-the-sealed-backup) does that and the rest).
By hand:

If this box is replacing another one, copy the state across **after**
`install.sh` and **before** starting the service. Stop the old bot first — see
[operations.md](operations.md#handing-the-bot-over-to-another-machine).

```bash
# on the OLD machine
cd ~/whatsapp-bot
sudo systemctl stop whatsapp-bot
sudo systemctl disable --now cloudflared    # if it ran the tunnel (section 7)
tar czf /tmp/bot-state.tgz .env data/config.json data/state.json \
        data/session data/sessions data/outbound-budget.json 2>/dev/null

# get /tmp/bot-state.tgz to the new machine, then, on the NEW machine:
cd ~/whatsapp-bot
tar xzf /tmp/bot-state.tgz
chmod 600 .env
chmod 700 data
```

Then check the key actually matches before you trust the panel:

```bash
npm start
# The panel should accept your existing admin password, and
# Settings -> Library should still show the Jellyfin link.
# If the password is rejected and the API keys look empty, the .env did not come across.
```

Do **not** copy `data/logs/` or `data/media/`. The logs belong to the old box
and the media directory is scratch.

---

## 6. Run it as a service

```bash
sudo cp ~/whatsapp-bot/whatsapp-bot.service /etc/systemd/system/
sudoedit /etc/systemd/system/whatsapp-bot.service
```

**Three lines are machine-specific and must be checked every time:**

| Line | Change it to |
|---|---|
| `User=` / `Group=` | the account that owns `~/whatsapp-bot` |
| `WorkingDirectory=` | the absolute path of the clone. `dotenv` reads `.env` from here, so a wrong value silently means no `MASTER_KEY` |
| `ExecStart=` | the absolute node path from step 1 — `which node` |

The shipped unit is written for the first machine: `mommy`,
`/home/mommy/whatsapp-bot`, `/usr/local/bin/node`. On a NodeSource install
node is at `/usr/bin/node`, and the unit will fail with status 203/EXEC until
you fix it.

Or let the installer `tools/bootstrap.sh` uses fill all four in, instead of
editing by hand. It installs the unit and reloads systemd, and never enables
or starts it:

```bash
cd ~/whatsapp-bot && deploy/install-units.sh whatsapp-bot
```

Not `render-whatsapp-bot-unit.sh ... | sudo tee` the unit file: if the
renderer fails (run from `~`, where `deploy/` is not; an empty
`$(command -v node)`), tee still empties the file, and systemd reads an empty
unit as masked. bot-box2 ended up with exactly that (2026-09-29).

> **Known gap:** the unit runs `node src/index.js` directly, not `./start.sh`.
> That means `NODE_EXTRA_CA_CERTS` is *not* set under systemd. It only matters
> if a TLS-intercepting filter sits in front of the box — see
> `certs/README.txt`. If yours does, either point `ExecStart` at
> `/home/<user>/whatsapp-bot/start.sh` or add
> `Environment=NODE_EXTRA_CA_CERTS=/home/<user>/whatsapp-bot/data/extra-ca.pem`.

Then, **only once no other machine runs this number** (CLAUDE.md, rule 3):

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-bot
systemctl status whatsapp-bot
journalctl -u whatsapp-bot -f
```

The unit's `ExecStartPre=` line runs `deploy/auto-update.sh` before every
start: it fast-forwards the checkout to `origin/main`, with the gh login from
step 2, and exits 0 whatever happens, so the bot starts either way. Keep that
line; it is how this box gets every later fix. What it will and will not do is
in [operations.md](operations.md#upgrading).

Never put `MASTER_KEY` in the unit file. `/etc/systemd/system` is
world-readable; `.env` is 0600. The unit's `WorkingDirectory` is how the key
gets picked up, which is the whole reason that line matters.

---

## 7. Reaching the panel from outside

The panel binds `0.0.0.0:8080` and holds a live WhatsApp session that can read
and send as your number. **Do not port-forward it.** Use one of these.

### The quick one: SSH tunnel

Nothing to install, nothing to expose. Good for a one-off.

```bash
ssh -L 8080:localhost:8080 <user>@<server-ip>
# then browse to http://localhost:8080
```

### The permanent one: Cloudflare Tunnel

`cloudflared` makes an outbound-only connection to Cloudflare, so nothing is
listening on the public internet and no firewall rule is needed. It runs on
**the box that runs the bot, and only there**, as `cloudflared.service`,
installed by `deploy/install-cloudflared.sh`.

> **Do not use the Docker command the Cloudflare dashboard offers**
> (`docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ...`).
> bot-box2's tunnel was started with it on 2026-09-30. It registered four
> connections and every check passed, and every visit to the panel failed
> with `Unable to reach the origin service ... dial tcp [::1]:8080: connect:
> connection refused`. On Docker's default bridge network the ingress rule's
> `http://localhost:8080` is the container's own loopback, where nothing
> listens, not the box where the panel does. The container also had no
> restart policy and no unit, so a reboot would have ended it, and its token
> sat on its command line, where every user of the box can read it in `ps`.
> Cloudflare's other offer, `sudo cloudflared service install <token>`, runs
> on the box but writes the token into the unit file, which is
> world-readable. The token *is* the tunnel: whoever holds it can serve your
> hostname.

**Create the tunnel** (once, in the Cloudflare dashboard, which is where its
hostnames and ingress rules live):

1. Zero Trust → **Networks → Tunnels → Create a tunnel** → *Cloudflared*.
2. Name it after the bot, not the machine: the same tunnel moves from box to
   box with the bot (a second bot on another number gets a tunnel of its
   own, see [operations.md](operations.md#two-machines-two-numbers)).
3. Of the install commands it shows, copy any one - only the long `eyJ...`
   token at its end matters. Do not run it.
4. In the tunnel's **Public Hostname** tab, add the hostname, with service
   type `HTTP` and URL `localhost:8080`.

**Run it**, on the box that runs the bot, as the bot's user:

```bash
cd ~/whatsapp-bot
deploy/install-cloudflared.sh           # paste the token (or the whole command); it is not shown
deploy/install-cloudflared.sh --status  # what runs now; changes nothing
```

It installs `cloudflared` from Cloudflare's apt repository, puts the token in
`/etc/cloudflared/tunnel-token` (root, mode 600), writes
`cloudflared.service` to read it with `--token-file`, raises the UDP buffers
QUIC wants, enables and starts the service, and waits until Cloudflare has
registered a connection from it. Then it records the token in `.env` as
`CLOUDFLARE_TUNNEL_TOKEN`. `.env` is in the sealed backup's app bundle,
encrypted, so a rebuilt box gets the token back and
[`tools/bootstrap.sh`](#one-paste-a-new-vm-in-one-go) runs
`deploy/install-cloudflared.sh --from-env` once the bot runs there; the
tunnel is no longer the one thing set up again by hand. The token never
appears on a command line or in the script's output.

Already running it another way? It adopts that instead of asking:

| Running now | Run |
|---|---|
| a `cloudflared` container (the dashboard's `docker run`) | `deploy/install-cloudflared.sh --from-docker`: takes the token from the running container, starts the service, and only once the service has registered removes the containers that carry that token |
| `cloudflared service install <token>` (the token on the unit's `ExecStart`) | `deploy/install-cloudflared.sh --from-unit` |
| the service from this script, but `.env` has no `CLOUDFLARE_TUNNEL_TOKEN` | `deploy/install-cloudflared.sh --record-env` |

A token it finds on the box never replaces a *different* one already in
`/etc/cloudflared/tunnel-token` or `.env`: two tokens are two tunnels, and a
container of some other tunnel must not take the panel's place in the token
file, `.env` and the backup. It refuses and says so; `--replace` is for when
you have looked and the one it found is the panel's. It retires only the
containers that carry the token it adopted, and leaves any other (a DNS
proxy, another tunnel) as it is.

`node tools/routines.mjs` checks all of it (the `cloudflare-tunnel` routine),
and `--fix` runs the right one of these by itself on the box that runs the
bot, where there is nothing to decide.

**Rotate a token that was on a command line.** The dashboard's `docker run
... --token <token>` and `sudo cloudflared service install <token>` put the
token on a command line, and sudo writes every command it runs to its log:
the journal and `/var/log/auth.log`, which the `adm` group reads (the bot's
own user is in it). Moving the token into a root-only file does not take it
back out of there, so `--from-docker` and `--from-unit` say to rotate it, and
the routines check repeats it until you have:

1. In the Cloudflare dashboard: Networking → Tunnels → the tunnel →
   **Rotate token** (older dashboards: **Refresh token**). The connector that
   runs keeps its connections until it restarts.
2. Copy the new token from **Add a replica** (do not run the command), then on
   the box that runs the bot:

   ```bash
   deploy/install-cloudflared.sh --new-token   # paste it; it replaces the old one in the token file and .env
   ```

`--new-token` is also how a token revoked in the dashboard, or a move to
another tunnel, gets onto the box: with no option the script keeps using the
token it already has.

**One box at a time.** Two boxes running the same token are two connectors of
one tunnel, and Cloudflare sends each visit to either. When the bot moves,
stop the old box's connector as well as its bot:

```bash
sudo systemctl disable --now cloudflared    # on the OLD machine
```

`node tools/routines.mjs` on a box that does not run the bot flags a running
connector, and prints that command; it never stops one itself.

#### The other way: a locally-managed tunnel

A tunnel created with `cloudflared tunnel create` keeps its config and a
credentials file on the box instead of in the dashboard. It still works, and
the routine accepts it, but nothing backs it up: a rebuilt box sets it up
again by hand, with these steps. Prefer the dashboard tunnel above.

```bash
cloudflared tunnel login                       # opens a URL; authorise the zone
cloudflared tunnel create whatsapp-bot-<bot>   # one per bot (operations.md, "Two machines, two numbers"); prints a UUID and writes ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns whatsapp-bot-<bot> bot.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: whatsapp-bot-<bot>
credentials-file: /home/<user>/.cloudflared/<uuid>.json

ingress:
  - hostname: bot.example.com
    service: http://localhost:8080
  - service: http_status:404
```

```bash
cloudflared tunnel ingress validate
sudo cloudflared service install     # no token: it copies the config to /etc/cloudflared
sudo systemctl enable --now cloudflared
journalctl -u cloudflared -f
```

#### Whichever way: lock it down

A Cloudflare Tunnel makes the panel reachable from *anywhere*, and the panel's
own login is the only thing in front of a live WhatsApp session. Put Cloudflare
Access in front of it too — Zero Trust → **Access → Applications** → add the
hostname → policy `Emails` = your address. That is a second factor the bot
itself cannot provide.

The panel's own protections stay on regardless: scrypt-hashed passwords,
8 attempts per 15 minutes, and a 15-minute idle sign-out. Only the super-admin
can change that timeout - the default in Settings → System → Control panel,
or a different number per admin in the Admins tab, where 0 means that account
is never signed out.

> **A note on the wording:** "Cloudflare Tunnel" and "OpenVPN" are different
> things that solve the same problem — reaching a box you have not exposed. If
> the existing machine is actually running an OpenVPN client rather than
> `cloudflared`, `deploy/install-cloudflared.sh --status` will show nothing there, and the equivalent step
> here is to install that same VPN client and drop in its `.ovpn` profile:
>
> ```bash
> sudo apt-get install -y openvpn
> sudo cp <profile>.ovpn /etc/openvpn/client/bot.conf
> sudo systemctl enable --now openvpn-client@bot
> ip -brief addr    # the tunnel interface should appear
> ```
>
> Then reach the panel on the machine's VPN address, port 8080.

---

## 8. Claude Code on the box

So the next session can work here directly rather than over your shoulder.

```bash
curl -fsSL https://claude.ai/install.sh | bash
# or, if you already have Node on PATH:
npm install -g @anthropic-ai/claude-code
```

```bash
cd ~/whatsapp-bot
claude
```

The first run walks through signing in with your Anthropic account in a
browser. On a headless box it prints a URL to open elsewhere.

Two things make a new session immediately useful here:

- `gh auth login` is already done (step 2), so it can read issues, push
  branches and open PRs without being handed a token.
- `CLAUDE.md` at the repo root tells it what this machine is, what is running,
  and which rules it must not break. Read it before changing anything.

### Give Claude Code sudo

Claude Code runs commands as your user and cannot type a password, so without
this every package install, `systemctl restart` or unit change stops and waits
for you to do it by hand. `tools/bootstrap.sh` offers it before anything else. On
a box set up any other way, or where that step was answered "no", run this
**once**, logged in as the user Claude Code runs as (the one that owns
`~/whatsapp-bot`). It asks for your password one last time:

```bash
T=$(mktemp) && echo "$USER ALL=(ALL) NOPASSWD:ALL" > "$T" && sudo visudo -cf "$T" && sudo install -m 0440 -o root -g root "$T" /etc/sudoers.d/90-claude-nopasswd && rm -f "$T" && sudo -k && sudo -n true && echo "OK: Claude Code has passwordless sudo"
```

Or from another computer, over SSH — `-t` so that sudo can ask for the
password; use the box's Tailscale name or its address:

```bash
ssh -t mommy@<box> 'T=$(mktemp) && echo "$USER ALL=(ALL) NOPASSWD:ALL" > "$T" && sudo visudo -cf "$T" && sudo install -m 0440 -o root -g root "$T" /etc/sudoers.d/90-claude-nopasswd && rm -f "$T" && sudo -k && sudo -n true && echo "OK: Claude Code has passwordless sudo"'
```

It prints `OK: Claude Code has passwordless sudo` when it worked. What it does:
writes the one-line rule `<you> ALL=(ALL) NOPASSWD:ALL` to a temporary file,
has `visudo` check it first — a syntax error in `/etc/sudoers.d/` locks
*everyone* out of sudo, including you — installs it as
`/etc/sudoers.d/90-claude-nopasswd` (root-owned, mode 0440, the same file
bootstrap writes, so running either again is harmless), then forgets the cached
password (`sudo -k`) and proves no password is needed (`sudo -n true`).

- **Check it:** `sudo -n true && echo yes || echo no`
- **Undo it:** `sudo rm /etc/sudoers.d/90-claude-nopasswd`

This makes that user root in all but name: anyone who can log in as it, and
anything running as it, can do anything on the box. The bot runs as the same
user, but its unit sets `NoNewPrivileges=true`, so nothing the bot itself runs
can use sudo. Do this on a box that exists to run the bot, not on a shared
machine.

**Narrowed instead.** `deploy/install-hourly-debug.sh --status` (step 3)
offers to keep only the rule the hourly check needs -
`<you> ALL=(root) NOPASSWD: /usr/bin/systemctl restart whatsapp-bot` - and
remove the full one. That is an accepted state: `node tools/routines.mjs`
reports the `sudo` routine as ok ("narrowed to the one rule the hourly check
needs") and does not ask for the full rule back, and neither does
`tools/bootstrap.sh`, even with the one paste's `PASSWORDLESS_SUDO=yes`; only
`PASSWORDLESS_SUDO=force` widens it again. Package installs, unit changes and
the other routines' fixes that take sudo then wait for you.

### The hourly check's token

[The hourly check](operations.md#the-hourly-check) researches failed requests
with headless Claude Code from cron, where nobody can log in with a browser.
It needs a long-lived token, made **once**, on the box that runs the bot:

```bash
~/.local/bin/claude setup-token                  # a browser login; prints the token
cd ~/whatsapp-bot && deploy/install-hourly-debug.sh --set-token   # paste it
```

`setup-token` can run on any computer where you use Claude Code; the token
is your account's, not the machine's. `--set-token` reads it without showing
it, saves it as `CLAUDE_CODE_OAUTH_TOKEN` in
`~/.config/whatsapp-bot/hourly-debug.env` (mode 600, in a folder made 700),
replacing any token already there, and proves it with one tiny test call in
the check's sandbox. Never `echo` a token into the file: the command line
stays in your shell history. `tools/bootstrap.sh` asks for it the same way,
with its first questions, and saves it at once.

### Check the routines

Everything above that a box keeps running - the unit and its updater, the
disk and NIC fixes, sudo, gh, Tailscale, Claude Code, the hourly check, the
nightly backup, the Cloudflare tunnel - is a routine in `src/core/routines.js`,
and one command checks them all, on any box:

```bash
cd ~/whatsapp-bot
node tools/routines.mjs          # in place / missing / needs you, with the next command for each
node tools/routines.mjs --fix    # activate what needs no password, login or passphrase
node tools/routines.mjs --list   # what each routine is, and why
```

It exits 0 only when every routine that applies here is in place. It knows
whether this box runs the bot: on one that does not (a standby, or a new box
before the hand-over), the hourly check, the nightly backup, the tunnel and
starting at boot are reported as belonging elsewhere (a tunnel connector
running there is flagged, since it would take half the panel's visits), and
it never starts, stops or enables the bot anywhere. `--fix` runs only from the checkout the service
runs. A routine this box does without on purpose - say, the sealed backup on
a box for a second number - is recorded with
`node tools/routines.mjs --skip <id> --reason "<why>"` and reported as such.
A new Claude session runs this first (CLAUDE.md, "Routines every box runs").

---

## 9. Configure the bot

All of this is in the panel — `http://<host>:8080`, or your tunnel hostname.
The **Fresh install checklist** at the top of the Settings tab tracks every
step below, and the optional features after them, with a link to each
setting; it ticks from the saved settings and the live WhatsApp connection.

1. **First load** asks you to set the super-admin password.
2. **Settings → WhatsApp account** — the number with `+` and its country code,
   `+15551234567` (the way the bot writes every number; it keeps the digits).
3. **Dashboard → Link / Connect** — a pairing code (default) or a QR. See
   [operations.md](operations.md#linking-and-relinking-a-number), which covers
   what to do when the QR is slow to appear.
4. **Settings → Library** — the Jellyfin URL and how to sign in.
   > Give the bot's Jellyfin account access to **every** library you want it to
   > serve, including TV Shows, and check its Max Parental Rating. The bot
   > searches as that account, so a library it cannot see does not exist as far
   > as the bot is concerned — the requester just gets "not in the library".
5. **Settings → API keys** — OMDb (required) and TMDB (optional but makes the
   theatrical check definitive).
6. **Settings → Groups** — which group is requests, which is posts, which is
   notifications.
7. **Test tab** — type a title. It runs the real checks against the real APIs
   and touches WhatsApp not at all. Use it after every settings change.

---

## 10. Check it over

```bash
systemctl is-active whatsapp-bot          # active
systemctl is-enabled whatsapp-bot         # enabled
systemctl is-active cloudflared           # active, if you set it up
curl -sI http://localhost:8080 | head -1  # HTTP/1.1 302 or 200
ls -l ~/whatsapp-bot/.env                 # -rw------- 
ls -ld ~/whatsapp-bot/data                # drwx------
node ~/whatsapp-bot/tools/routines.mjs    # every routine in place (exit 0)
```

In the panel: **Dashboard → Outbound connectivity → Run check** tests OMDb,
TMDB and WhatsApp live, and **Settings → Library → Test connection** confirms
search actually works.

Then reboot once and confirm it comes back on its own. That is the only real
test of the service unit.

```bash
sudo reboot
# ... then, back on:
systemctl status whatsapp-bot cloudflared
```

---

## Running on WSL (for the GPU)

On 2026-09-29 the operator moved the bot from the Hyper-V VM bot-box2 to WSL2
on the same Windows laptop (host `Mommy-Laptop`, an NVIDIA GPU), "so we can
utilize the GPU": Hyper-V GPU partitioning refused CUDA and NVENC to the VM
(see "GPU partitioning" above), and WSL runs NVENC. The distro was cloned
from the VM. Then: "Why don't you teach the repo?" - so this section is what
a new session needs to set up, or recognise, a WSL bot box.

A WSL box is told apart by its kernel: `uname -r` ends in
`microsoft-standard-WSL2`. `node tools/routines.mjs` knows it, and there it
checks four routines of its own (`wsl-systemd`, `wsl-config`, `wsl-vm-units`,
`wsl-autostart`), checks sshd on 2222 in place of Tailscale SSH, and says
`grow-root-disk` does not apply. `nic-offload` does: WSL's mirrored NIC is
`hv_netvsc` with the VM's upload fault. On 2026-09-30 La La Land uploaded at
162 KB/s until tso and gso were turned off on `eth1` (the mirrored Wi-Fi), then
at 5,176 KB/s; `eth1-no-offload.service` turns it off at every boot. `tools/bootstrap.sh` does the
Linux side by itself (`deploy/wsl-setup.sh`) and puts the Windows side on its
checklist.

What differs from a VM, and why:

| | On WSL | Why |
|---|---|---|
| systemd | `[boot]` `systemd=true` in `/etc/wsl.conf` (`deploy/wsl-setup.sh systemd`) | WSL does not start systemd otherwise: `systemctl restart whatsapp-bot` failed with "System has not been booted with systemd as init system", and nothing started the bot or cron |
| networking | `networkingMode=mirrored` in `%UserProfile%\.wslconfig` on Windows | the panel is then on the laptop's own LAN address (192.168.20.21) and its Tailscale address; no netplan, no static address in Linux - reserve the laptop's address on the router |
| staying up | `vmIdleTimeout=-1` in the same file | WSL otherwise shuts down when no window is open |
| after a Windows reboot | a scheduled task starts the distro | WSL does not start by itself; systemd then starts `whatsapp-bot.service` if it is enabled |
| SSH | sshd on port **2222** | Windows holds 22 in mirrored networking. Reach it with `ssh -p 2222 <user>@<the laptop's Tailscale name>` |
| Tailscale | the **Windows** client is the tailnet node; no `tailscaled` in Linux | a second one in mirrored networking fights the Windows one over the 100.x routes |
| units from the VM | off: systemd-networkd (and its socket and wait-online), networkd-dispatcher, grow-root-disk, eth0-no-offload, open-vm-tools, tailscaled | networkd would apply the VM's static netplan address (`99-static-lan.yaml`) and fight WSL's networking; the rest are for the VM's disk and NIC |
| `wsl.exe --shutdown` | stops the bot | it stops every distro. It is also how WSL rereads `/etc/wsl.conf` and `.wslconfig` - so only at a quiet moment |
| the hourly check | scans and reports, but **never researches or fixes** | see below |

### Set it up

On the Linux side, as the bot's user (or let `tools/bootstrap.sh` do it):

```bash
deploy/wsl-setup.sh --dry-run systemd vm-units ssh wslconfig   # see what it would do
deploy/wsl-setup.sh systemd vm-units ssh wslconfig
```

`wslconfig` edits the Windows file from here (`/mnt/c/Users/<you>/.wslconfig`),
keeping every other line and the file's CRLF line endings, and leaves a copy
of what was there as `.wslconfig.before-wsl-setup`. Edit it by hand only with
care: on the laptop the file had no line ending after its last line, and a
line appended to it was glued onto that one (`ipv6=falsevmIdleTimeout=-1`),
which WSL reads as neither. It should read:

```ini
[wsl2]
networkingMode=mirrored
vmIdleTimeout=-1
```

Then, on Windows, in PowerShell **as administrator**, once:

1. Start the distro with Windows. The command, with this distro's name filled
   in, is what `node tools/wsl-config.mjs --autostart` prints; for a distro
   called `bot-box2`:

   ```powershell
   $a = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wsl.exe" -Argument "-d bot-box2 --exec /bin/sleep infinity"; $t = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)); $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest; $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName 'whatsapp-bot WSL' -Action $a -Trigger $t -Principal $p -Settings $s -Force
   ```

   The task holds `sleep infinity` rather than running `/bin/true` and
   ending, so a Windows process stays attached to the distro and WSL has no
   reason to stop it; its time limit is none, where the default would end it
   after three days. `wsl.exe -l -v` lists the distro names. Check it with
   `Get-ScheduledTask -TaskName 'whatsapp-bot WSL'`; after the next Windows
   reboot, `node tools/routines.mjs` should show the bot running without
   anybody having opened a window.

2. If SSH on 2222 is refused from another machine, let it through the
   Hyper-V firewall that fronts WSL:

   ```powershell
   New-NetFirewallHyperVRule -Name wsl-ssh -DisplayName 'WSL SSH' -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 2222
   ```

3. `wsl.exe --shutdown` at a quiet moment - it stops the bot - so WSL rereads
   both files and starts with systemd; the scheduled task, or opening the
   distro, starts it again.

### Moving from a Hyper-V VM

The distro on the laptop was a clone of bot-box2, and the clone had missed
`data/session` - the WhatsApp login - so the data directory was copied
straight out of the VM's disk. With the VM **off** (two copies of one
session is `connectionReplaced`, CLAUDE.md rule 3):

1. In PowerShell as administrator, attach the VM's disk to WSL, bare:

   ```powershell
   wsl --mount 'C:\path\to\the-vm.vhdx' --vhd --bare
   ```

2. In WSL, find the VM's LVM volume, mount it read-only, and copy `data/`:

   ```bash
   sudo vgchange -ay
   sudo mkdir -p /mnt/x
   sudo mount -o ro,noload /dev/mapper/ubuntu--vg-ubuntu--lv /mnt/x
   sudo rsync -a /mnt/x/home/<user>/whatsapp-bot/data/ ~/whatsapp-bot/data/
   sudo chown -R "$USER": ~/whatsapp-bot/data && chmod 700 ~/whatsapp-bot/data
   ls ~/whatsapp-bot/data/session/creds.json    # the WhatsApp login came across
   sudo umount /mnt/x
   sudo vgchange -an ubuntu-vg
   ```

   `noload` keeps the journal of a disk that was not shut down cleanly from
   being replayed, which a read-only mount cannot do. `.env` (the
   `MASTER_KEY`) comes across the same way if the clone lacks it.

3. Back in PowerShell: `wsl --unmount 'C:\path\to\the-vm.vhdx'`.

4. Make sure the VM can never start a second bot on the number, now or at
   the next Windows boot:

   ```powershell
   Stop-VM -Name bot-box2
   Set-VM -Name bot-box2 -AutomaticStartAction Nothing
   ```

   On the VM itself, if it is ever started again: `sudo systemctl disable --now whatsapp-bot cloudflared`
   (a second tunnel connector would take half the panel's visits).

5. Then the setup above, `node tools/routines.mjs`, and
   `sudo systemctl enable --now whatsapp-bot` only once the VM is off.

### The hourly check's sandbox on WSL

The hourly check runs its Claude Code session inside
`deploy/hourly-debug/sandbox.py`, which normally puts on a seccomp filter with
a listener, to decide which signals the session may send. On WSL that cannot
work: WSL's own init (PID 1) already holds a seccomp listener that every
process in the distro inherits, systemd and cron included, and the kernel
allows a process only one ("could not install the seccomp filter: Device or
resource busy"). Until 2026-09-29 the check therefore only scanned and
reported on WSL.

Where the listener is taken, and only there, `sandbox.py` now runs the session
in user, PID and mount namespaces of its own instead - WSL, unlike Ubuntu 24.04
on the VM, lets the bot's user make them. The PID namespace does what the
listener did: no process outside it has a number the session could signal,
ptrace or reach through `/proc/<pid>/root`. The mount namespace makes
everything read-only but its clone and scratch space, puts empty mounts over
the WhatsApp session and the logins, and hides `/mnt` - the Windows drives, and
with them every Windows program interop would run; vsock, interop's other way
out, is refused too. Landlock, `no_new_privs` and the UNIX-socket filter are as
everywhere else. `python3 deploy/hourly-debug/sandbox.py --mode` says which
sandbox a box gets, and `node tools/routines.mjs --only hourly-check` shows the
probe from inside it. If WSL ever refuses the namespaces too (an AppArmor or
sysctl rule against unprivileged user namespaces), the check goes back to
failing closed - scanning and reporting only - and the routines check says so,
with `unshare -Ur -p -m --fork true` to see it fail.

---

## Troubleshooting a new box

| Symptom | Cause |
|---|---|
| `status=203/EXEC` | `ExecStart` node path is wrong. `which node` |
| Service runs but every setting is blank | wrong or missing `MASTER_KEY` — check `WorkingDirectory` and that `.env` is there |
| `MASTER_KEY in the environment differs from .env` | harmless warning; `.env` is used, which is correct |
| Panel unreachable over the tunnel | `deploy/install-cloudflared.sh --status`, `journalctl -u cloudflared -f`; check the ingress hostname and that the service is `http://localhost:8080` |
| Tunnel connected, every visit "Unable to reach the origin service ... dial tcp [::1]:8080: connect: connection refused" | `cloudflared` runs in a Docker container (the dashboard's `docker run`), where `localhost` is the container: `deploy/install-cloudflared.sh --from-docker` moves it into the service, then rotate the token, which sudo logged ([§7](#the-permanent-one-cloudflare-tunnel)) |
| `cloudflared.service` fails after the token was rotated or revoked in the dashboard | `deploy/install-cloudflared.sh --new-token`, and paste the new one ([§7](#the-permanent-one-cloudflare-tunnel)) |
| The panel over the tunnel works only some of the time, or shows another box's panel | two boxes run the tunnel's connector: `sudo systemctl disable --now cloudflared` on the one that does not run the bot |
| `unable to get local issuer certificate` | a TLS filter is in front of the box. Drop its root CA in `certs/` and use `start.sh` — see `certs/README.txt` |
| `npm test` fails on `content-export` / `rules-freshness` | expected on a fresh clone; both read gitignored files under `data/` |
| ...and also on `ai-key-test-panel` / `api-keys-section` / `beta-panel` / `connection-select` / `csv-export` / `fresh-install-checklist` / `hourly-checks-panel` / `login-autofill` / `portal-search` / `queue-panel-requests` / `settings-group-pickers` / `settings-reach` / `wanted-panel` | expected after `npm install --omit=dev`; all thirteen need `linkedom`, a devDependency. `npm install --include=dev` to run them |
| `systemctl start whatsapp-bot` says the unit is masked, or `node tools/routines.mjs` says so | `/etc/systemd/system/whatsapp-bot.service` is empty (bot-box2's was, 2026-09-29), which systemd reads as masked: `deploy/install-units.sh whatsapp-bot` writes it. A link to `/dev/null` is `systemctl mask`, somebody's decision: `sudo systemctl unmask whatsapp-bot` first, if it was not deliberate |
| `git commit` says "Author identity unknown" | this box has no git identity: `node tools/routines.mjs --fix` gives it the repository owner's (tools/bootstrap.sh does too) |
| Bot connects, then "Session taken over" | another machine is holding the same WhatsApp session. Stop one — see [operations.md](operations.md) |
| Out of memory during encode | raise `MemoryMax` in the unit, or lower `maxHeight` in Settings |
| Uploads crawl at 1–2 Mbit/s with heavy retransmits, downloads are fine (Hyper-V) | TCP segmentation offload on `hv_netvsc` — see [Hyper-V: slow, lossy uploads](#hyper-v-slow-lossy-uploads) |
| `df -h /` shows far less than the virtual disk | the installer left space unallocated — see [Growing the root disk](#growing-the-root-disk) |
| `restore-secrets.mjs` says "wrong passphrase, or the bundle is corrupt" | the passphrase is not the one on the old machine's `.env`; nothing was restored, so just run it again |
| `restore-secrets.mjs` says "this checkout already has .env…" | the checkout was set up before. Restore into a fresh clone, or `--from-branch --only home` |
| `backup-secrets.mjs` says the branch "holds the backup of another machine" | expected on a box that does not run the bot, and it changes nothing. Once the bot runs here (active and enabled at boot, the same `.env`), the next backup moves the other machine's to `archive/` by itself; or now: `node tools/backup-secrets.mjs --take-over`. "a different bot" means this box has its own `MASTER_KEY`: a second number, which skips the routine; "this machine wrote for a different bot" is another checkout here, or a reinstall with a new `MASTER_KEY` (`--take-over` if this checkout is now the bot); "manifest.json is missing or is not valid JSON" means nobody can tell whose the top is, and only `--take-over` moves it. "could not read the current backup" is git failing to read `data/sealed-backup`: nothing was changed; run it again, and if it persists, `rm -rf data/sealed-backup` - only that folder: it is this box's copy of the branch, fetched again on the next run |
