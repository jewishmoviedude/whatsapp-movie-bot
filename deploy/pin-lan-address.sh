#!/usr/bin/env bash
# Keep this box's LAN address: a static address (--static), or ask the router
# for the same one on every boot, as this MAC (the default, DHCP).
#
#   deploy/pin-lan-address.sh --static 192.168.20.45 --apply
#                                             # static, applied now, with a 3-minute undo
#   deploy/pin-lan-address.sh --static [addr] # static: write and validate, apply at next boot
#   deploy/pin-lan-address.sh                 # DHCP: the address it has right now
#   deploy/pin-lan-address.sh 192.168.20.38   # DHCP: or a given one on the same network
#   deploy/pin-lan-address.sh [--static] --print   # show what it would write, write nothing
#
# Run as your normal user; it calls sudo for the files it writes. Without
# --apply it never touches the live network: the settings take effect at the
# next boot.
#
# Why this exists: bot-box is on DHCP behind a home router, and its address kept
# moving (.25, then .36, .37, .38) - which breaks http://<address>:8080 and
# anything pointing at it.
#
# --static is the operator's choice (2026-09-29: "assign ubuntu static
# 192.168.20.45"). Until then this script argued against a static address,
# because one inside the router's pool can be handed to a phone as well. The
# operator decided the box should own its address outright rather than rely
# on the router, so --static writes /etc/netplan/99-static-lan.yaml (mode 600,
# as netplan wants): the default-route interface with dhcp4 off, the address,
# the gateway it has now as the default route, and the DNS servers and search
# domain it has now (from resolvectl). It also writes
# /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg, or cloud-init would
# regenerate the network config on a later boot and put DHCP back. The files
# are checked with `netplan generate` before anything is applied, and taken
# back out at once if it refuses them.
#
# Reserve the same address for this MAC on the router as well (in the router's
# admin page or app, under LAN or DHCP settings: "DHCP reservation", "static
# lease" or "address reservation"). With DHCP off the box holds no lease, so without a
# reservation the router believes the address is free and will hand it to the
# next phone that asks: two devices on one address, and the panel unreachable
# half the time.
#
# --apply: a wrong static config cuts the box off from the network, and from
# the SSH session that would fix it. So before the new files go live a
# transient systemd timer is armed (systemd-run --on-active=180) that puts the
# previous files back and applies them again. The apply itself, and the check
# that the new address is up and the gateway answers a ping, run as a
# transient unit too, so an SSH session that drops when the address changes
# cannot stop them halfway. Only a confirmed new config cancels the timer; a
# failed check reverts at once.
#
# The DHCP mode writes a networkd drop-in that sets:
#
#   ClientIdentifier=mac   the router sees the MAC, the thing a reservation
#                          and "Devices" lists are keyed on, and sees the same
#                          device after a rebuild or restore
#   SendRelease=no         the lease is never handed back on a reset or a
#                          shutdown. Some routers give a released address away
#                          and hand the box the next free one; a lease that
#                          is kept, it hands back
#   RequestAddress=<addr>  names the address it wants (DHCP option 50).
#                          Many routers honour it; some ignore it
#
# A reservation made on the router did not hold bot-box's address at
# first, because the box identified itself to the router by an ID generated on
# the box (DUID), not by its MAC. See docs/server-setup.md, "Keeping the same
# LAN address".
#
# Neither mode runs `networkctl reload` or `reconfigure`. Either resets the
# link with the old settings still in force, releasing the lease on the way
# out - the earlier version of these instructions did, and each run moved
# bot-box one address along.
set -euo pipefail

SYSFS=${PIN_LAN_SYSFS:-/sys/class/net}
ETC=${PIN_LAN_ETC:-/etc/systemd/network}
# --static's files and its undo. Overridable so the tests never touch the
# real /etc, /var/lib or the real network.
NETPLAN=${PIN_LAN_NETPLAN:-/etc/netplan}
CLOUD=${PIN_LAN_CLOUD:-/etc/cloud/cloud.cfg.d}
STATE=${PIN_LAN_STATE:-/var/lib/pin-lan-address}
REVERT_AFTER=${PIN_LAN_REVERT_AFTER:-180}
CONFIRM_TRIES=${PIN_LAN_CONFIRM_TRIES:-30}
CONFIRM_SLEEP=${PIN_LAN_CONFIRM_SLEEP:-2}
YAML="$NETPLAN/99-static-lan.yaml"
CLOUDF="$CLOUD/99-disable-network-config.cfg"

die() { echo "pin-lan-address: $*" >&2; exit 1; }

PRINT=0 WANT='' STATIC=0 APPLY=0
for arg in "$@"; do
  case $arg in
    --print) PRINT=1 ;;
    --static) STATIC=1 ;;
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *.*.*.*) WANT=$arg ;;
    *) die "unknown argument: $arg (an IPv4 address, --static, --apply, --print or --help)" ;;
  esac
done
if (( APPLY && ! STATIC )); then
  die "--apply goes with --static: the DHCP settings take effect at the next boot, on purpose"
fi

# awk reads to the end rather than `exit`ing on the first match: under
# pipefail, a reader that stops early SIGPIPEs the writer and fails the script.
ROUTE=$(ip route show default)
IFACE=$(awk '!f { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); f = 1; break } }' <<<"$ROUTE")
GATEWAY=$(awk '!f { for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); f = 1; break } }' <<<"$ROUTE")
[[ -n $IFACE ]] || die "no default route, so no LAN interface to pin"

CIDR=$(ip -4 -o addr show dev "$IFACE" scope global | awk '!f { print $4; f = 1 }')
[[ -n $CIDR ]] || die "$IFACE has no IPv4 address"
NOW=${CIDR%/*}
PREFIX=${CIDR#*/}
MAC=$(cat "$SYSFS/$IFACE/address" 2>/dev/null) || die "cannot read the MAC of $IFACE"
ADDR=${WANT:-$NOW}

valid_ip() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  for o in "$a" "$b" "$c" "$d"; do [[ $o =~ ^[0-9]+$ ]] && (( o <= 255 )) || return 1; done
}
valid_ip "$ADDR" || die "not an IPv4 address: $ADDR"

# A router ignores a request for an address outside its own network, silently:
# bot-box's first pin asked for 192.168.1.30 for a month after the box had moved
# to 192.168.20.x. A static address there is worse: the gateway would be out
# of reach and the box cut off. Only the /24 (and wider) case is checked; that
# is every home router this has met.
if [[ -n $WANT && $PREFIX -ge 24 && ${WANT%.*} != "${NOW%.*}" ]]; then
  (( STATIC )) && die "$WANT is not on $IFACE's network ($CIDR) - the gateway would be out of its reach"
  die "$WANT is not on $IFACE's network ($CIDR) - the router would ignore it"
fi

# networkd applies drop-ins from <network file name>.d/ in /etc. On netplan
# boxes the file is generated (/run/systemd/network/10-netplan-eth0.network),
# so a drop-in is the only way to add to it that netplan and cloud-init leave
# alone. The name also carries the netplan id, which --static must reuse so
# that its file merges into cloud-init's definition instead of adding a
# second one for the same interface.
NETFILE=$(networkctl status "$IFACE" 2>/dev/null | awk '/Network File:/ && !f { print $3; f = 1 }')
if [[ -z $NETFILE || $NETFILE == n/a ]]; then
  die "$IFACE is not managed by systemd-networkd (a desktop install uses NetworkManager) - see docs/server-setup.md, \"Keeping the same LAN address\""
fi

if (( STATIC )); then
  if [[ $EUID -eq 0 ]] || { [[ -w $NETPLAN && -w $CLOUD ]] && { [[ -w $STATE ]] || [[ -w $(dirname "$STATE") ]]; }; }; then SUDO=(); else SUDO=(sudo); fi
else
  if [[ -w $ETC || $EUID -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
fi

reservation_advice() {
  echo
  echo "For the router to honour it for certain, reserve $ADDR for MAC $MAC in"
  echo "its DHCP settings (the router's admin page or app, under LAN or DHCP:"
  echo "DHCP reservation, static lease or address reservation), and make the reservation's"
  echo "MAC exactly this one."
  if (( STATIC )); then
    echo "With a static address the box holds no lease, so without a reservation the"
    echo "router believes $ADDR is free and can hand it to another device."
  fi
  case ${MAC,,} in
    00:15:5d:*)
      echo
      echo "This MAC is one Hyper-V hands out. Make it Static (VM off: Settings ->"
      echo "Network Adapter -> Advanced Features -> MAC address -> Static, keeping"
      echo "$MAC), or a move or restore can give the VM a new one - and to the"
      echo "router, and this file's comment, that is a different device." ;;
  esac
}

# ------------------------------------------------------------------ --static

write_file() {
  local dest=$1 content=$2 tmp
  tmp=$(mktemp)
  printf '%s\n' "$content" > "$tmp"
  "${SUDO[@]}" mkdir -p "$(dirname "$dest")"
  "${SUDO[@]}" install -m 600 "$tmp" "$dest"
  rm -f "$tmp"
}

# The files as they were before --static first wrote them, from $STATE/before.
restore_before() {
  local f n
  for f in "$YAML" "$CLOUDF"; do
    n=$(basename "$f")
    if "${SUDO[@]}" test -e "$STATE/before/$n.absent"; then "${SUDO[@]}" rm -f "$f"
    elif "${SUDO[@]}" test -e "$STATE/before/$n"; then "${SUDO[@]}" cp -p "$STATE/before/$n" "$f"; fi
  done
  "${SUDO[@]}" rm -rf "$STATE/before"
}

apply_with_undo() {
  local revert="$STATE/revert.sh" confirm="$STATE/confirm.sh" result="$STATE/result" tmp r
  "${SUDO[@]}" mkdir -p "$STATE"
  tmp=$(mktemp)
  # The undo: the files as they were before --static, applied. Run as root by
  # the timer, or by confirm.sh when the check fails.
  cat > "$tmp" <<EOF
#!/bin/bash
# Written by deploy/pin-lan-address.sh --static --apply: puts the network back
# as it was before --static, and applies it.
set -u
for f in '$YAML' '$CLOUDF'; do
  n=\$(basename "\$f")
  if [[ -e '$STATE/before/'"\$n.absent" ]]; then rm -f "\$f"
  elif [[ -e '$STATE/before/'"\$n" ]]; then cp -p '$STATE/before/'"\$n" "\$f"; fi
done
rm -rf '$STATE/before'
netplan apply
echo "reverted \$(date -u +%FT%TZ): the previous network config is back" > '$result'
EOF
  "${SUDO[@]}" install -m 700 "$tmp" "$revert"
  # The apply and its proof: the address is on the interface and the gateway
  # answers. Only that cancels the undo; anything else reverts at once.
  cat > "$tmp" <<EOF
#!/bin/bash
# Written by deploy/pin-lan-address.sh --static --apply. It runs as a
# transient unit, so an SSH session that drops when the address changes does
# not stop it halfway.
set -u
fail() {
  systemctl stop pin-lan-revert.timer 2>/dev/null
  bash '$revert'
  echo "failed: \$1 - the previous config is back" > '$result'
  exit 1
}
netplan apply || fail "netplan apply"
for ((i = 0; i < $CONFIRM_TRIES; i++)); do
  if ip -4 -o addr show dev '$IFACE' | grep -qF 'inet $ADDR/' && ping -c 1 -W 2 '$GATEWAY' >/dev/null 2>&1; then
    systemctl stop pin-lan-revert.timer 2>/dev/null
    rm -rf '$STATE/before'
    echo "confirmed \$(date -u +%FT%TZ): $IFACE is $ADDR/$PREFIX and $GATEWAY answers" > '$result'
    exit 0
  fi
  sleep $CONFIRM_SLEEP
done
fail "$ADDR did not come up on $IFACE, or $GATEWAY did not answer"
EOF
  "${SUDO[@]}" install -m 700 "$tmp" "$confirm"
  rm -f "$tmp"
  "${SUDO[@]}" rm -f "$result"

  # A leftover from an earlier run would make systemd-run refuse the names.
  "${SUDO[@]}" systemctl stop pin-lan-revert.timer pin-lan-revert.service >/dev/null 2>&1 || true
  "${SUDO[@]}" systemctl reset-failed pin-lan-revert.timer pin-lan-revert.service pin-lan-apply.service >/dev/null 2>&1 || true
  # Armed BEFORE anything goes live: if everything after this dies, the old
  # config comes back by itself.
  if ! "${SUDO[@]}" systemd-run --quiet --unit=pin-lan-revert --on-active="$REVERT_AFTER" \
      --timer-property=AccuracySec=1s /bin/bash "$revert"; then
    die "could not arm the undo timer, so nothing was applied (the files are written: they take effect at the next boot)"
  fi
  echo "undo armed: the previous config comes back in ${REVERT_AFTER}s unless the new one is confirmed"
  if [[ $ADDR != "$NOW" ]]; then
    echo "applying: an SSH session to $NOW drops now - reconnect to $ADDR (or over Tailscale)"
  else
    echo "applying"
  fi
  "${SUDO[@]}" systemd-run --quiet --wait --collect --unit=pin-lan-apply /bin/bash "$confirm" || true
  r=$("${SUDO[@]}" cat "$result" 2>/dev/null || true)
  case $r in
    confirmed*) echo "$r"; echo "static $ADDR is in force, and the undo is cancelled" ;;
    *) die "${r:-no result from the apply} (journalctl -u pin-lan-apply -u pin-lan-revert)" ;;
  esac
}

static_mode() {
  local id d same=0 f
  local -a dns=() search=()
  id=$(basename "$NETFILE" .network)
  if [[ $id == *-netplan-* ]]; then id=${id#*-netplan-}; else id=$IFACE; fi
  [[ -n $GATEWAY ]] || die "the default route has no gateway, so there is nothing to route through"
  valid_ip "$GATEWAY" || die "the gateway is not an IPv4 address: $GATEWAY"
  [[ $ADDR != "$GATEWAY" ]] || die "$ADDR is the router's own address"
  if (( PREFIX == 24 )) && [[ ${ADDR##*.} == 0 || ${ADDR##*.} == 255 ]]; then
    die "$ADDR is the network's own address or its broadcast address"
  fi

  # The DNS servers and search domains the box has now, as DHCP gave them:
  # with DHCP off, nothing else will. A "~" domain is routing-only, not a
  # search domain, and an IPv6 server with a %zone cannot go into netplan.
  for d in $(resolvectl dns "$IFACE" 2>/dev/null | sed 's/^[^:]*://'); do
    [[ $d == *%* ]] || dns+=("$d")
  done
  for d in $(resolvectl domain "$IFACE" 2>/dev/null | sed 's/^[^:]*://'); do
    [[ $d == \~* ]] || search+=("$d")
  done
  (( ${#dns[@]} )) || dns=("$GATEWAY")

  YAML_CONTENT=$(
    cat <<EOF
# Written by deploy/pin-lan-address.sh --static on $(date -u +%Y-%m-%d) for $IFACE, MAC $MAC.
# A static address, the operator's choice: this box is always $ADDR. Reserve
# it for this MAC on the router too, so it is never handed to another device.
# 99- sorts after cloud-init's 50-cloud-init.yaml, so dhcp4: false wins. See
# docs/server-setup.md, "Keeping the same LAN address".
network:
  version: 2
  ethernets:
    $id:
      dhcp4: false
      addresses:
        - $ADDR/$PREFIX
      routes:
        - to: default
          via: $GATEWAY
      nameservers:
        addresses:
EOF
    for d in "${dns[@]}"; do echo "          - $d"; done
    if (( ${#search[@]} )); then
      echo "        search:"
      for d in "${search[@]}"; do echo "          - $d"; done
    fi
  )
  CLOUD_CONTENT=$(
    cat <<EOF
# Written by deploy/pin-lan-address.sh --static: cloud-init must not rewrite
# the network config, or a later boot puts DHCP back over $YAML.
network: {config: disabled}
EOF
  )

  echo "interface  $IFACE (netplan id $id)"
  echo "address    $NOW now, static $ADDR/$PREFIX"
  echo "gateway    $GATEWAY"
  echo "dns        ${dns[*]}${search[*]:+, search ${search[*]}}"
  echo "MAC        $MAC"
  echo "files      $YAML"
  echo "           $CLOUDF"
  echo

  if (( PRINT )); then
    echo "$YAML_CONTENT"
    echo
    echo "$CLOUD_CONTENT"
    exit 0
  fi

  # Another device already answering there: taking its address would cut one
  # of the two off. Only asked when the address changes - the box's own
  # address answers, of course.
  if [[ $ADDR != "$NOW" ]] && ping -c 1 -W 1 "$ADDR" >/dev/null 2>&1; then
    die "something on the network already answers at $ADDR - pick a free address, or reserve one on the router first"
  fi

  # Same settings already there (the comment lines aside)?
  if "${SUDO[@]}" test -r "$YAML" && "${SUDO[@]}" test -r "$CLOUDF" \
    && diff -q <("${SUDO[@]}" cat "$YAML" | grep -v '^#') <(grep -v '^#' <<<"$YAML_CONTENT") >/dev/null 2>&1 \
    && diff -q <("${SUDO[@]}" cat "$CLOUDF" | grep -v '^#') <(grep -v '^#' <<<"$CLOUD_CONTENT") >/dev/null 2>&1; then
    same=1
  fi
  if (( same )) && [[ $NOW == "$ADDR" && $ROUTE != *"proto dhcp"* ]]; then
    echo "already static at $ADDR, and in force - nothing to change"
    reservation_advice
    exit 0
  fi

  if (( same )); then
    echo "$YAML already sets $ADDR"
  else
    # What was there before, kept until a new config is confirmed working: the
    # undo puts exactly this back. Taken once, so writing now and applying
    # later still undoes to the state before the first write.
    if ! "${SUDO[@]}" test -d "$STATE/before"; then
      "${SUDO[@]}" mkdir -p "$STATE/before"
      for f in "$YAML" "$CLOUDF"; do
        if "${SUDO[@]}" test -e "$f"; then "${SUDO[@]}" cp -p "$f" "$STATE/before/"
        else "${SUDO[@]}" touch "$STATE/before/$(basename "$f").absent"; fi
      done
    fi
    write_file "$YAML" "$YAML_CONTENT"
    write_file "$CLOUDF" "$CLOUD_CONTENT"
    # netplan's own check of everything it will read. A file it refuses is
    # taken back out at once, never left for the next boot to trip over.
    if ! "${SUDO[@]}" netplan generate; then
      restore_before
      "${SUDO[@]}" netplan generate || true
      die "netplan generate refused the static config; the previous files are back and nothing was applied"
    fi
    echo "written, and netplan generate accepts it"
  fi

  if (( ! APPLY )); then
    echo "Not applied now: it takes effect at the next boot. To apply it now, undone"
    echo "by itself after ${REVERT_AFTER}s if the box loses the network:"
    echo "  deploy/pin-lan-address.sh --static $ADDR --apply"
  else
    apply_with_undo
  fi
  if "${SUDO[@]}" test -e "$ETC/$(basename "$NETFILE").d/10-request-address.conf"; then
    echo
    echo "The DHCP drop-in from an earlier run does nothing with DHCP off; delete it so"
    echo "nobody reads it as the address in force:"
    echo "  sudo rm $ETC/$(basename "$NETFILE").d/10-request-address.conf"
  fi
  reservation_advice
}

if (( STATIC )); then
  static_mode
  exit 0
fi

# ---------------------------------------------------------------- DHCP pin
DIR="$ETC/$(basename "$NETFILE").d"
FILE="$DIR/10-request-address.conf"

CONTENT=$(cat <<EOF
# Written by deploy/pin-lan-address.sh on $(date -u +%Y-%m-%d) for $IFACE, MAC $MAC.
# Keep $ADDR across reboots: never release the lease, and ask for it as this
# MAC. Takes effect at the next boot. See docs/server-setup.md, "Keeping the
# same LAN address". Do not networkctl reload/reconfigure to apply it: that
# releases the lease with the old settings and can move the address.
[DHCPv4]
ClientIdentifier=mac
SendRelease=no
RequestAddress=$ADDR
EOF
)

echo "interface  $IFACE"
echo "address    $NOW now$([[ $ADDR != "$NOW" ]] && echo ", pinning $ADDR")"
echo "MAC        $MAC"
echo "file       $FILE"
echo

if (( PRINT )); then
  echo "$CONTENT"
  exit 0
fi

# Same settings already there (the date line aside): say so and stop, rather
# than rewrite it for nothing.
if [[ -r $FILE ]] && diff -q <(grep -v '^#' "$FILE") <(grep -v '^#' <<<"$CONTENT") >/dev/null 2>&1; then
  echo "already pinned to $ADDR as $MAC - nothing to change"
else
  "${SUDO[@]}" mkdir -p "$DIR"
  printf '%s\n' "$CONTENT" | "${SUDO[@]}" tee "$FILE" >/dev/null
  echo "written. It takes effect at the next boot - nothing on the network changed now."
fi

reservation_advice
