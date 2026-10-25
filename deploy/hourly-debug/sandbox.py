#!/usr/bin/env python3
"""Run a command confined to the paths it is given, for the hourly check.

    sandbox.py [--ro PATH]... [--rw PATH]... [--hide PATH]... [--no-landlock]
               [--namespaces] -- COMMAND [ARGS...]
    sandbox.py --abi        print the kernel's Landlock ABI (0: none), exit 0
    sandbox.py --mode       print which sandbox this box gets: "listener" (the
                            seccomp supervisor) or "namespaces" (WSL, below)
    sandbox.py --probe PID  from inside the sandbox, try the doors it must keep
                            shut - a UNIX socket, a signal to PID (any process
                            outside it) - and print "closed", or what is open

--hide puts an empty mount over PATH, in the namespace sandbox only;
--namespaces asks for that sandbox where the listener would work too (the
tests use it to try both).

The hourly check (tools/hourly-debug.mjs) runs a Claude Code session with
--permission-mode bypassPermissions over text strangers wrote in public
WhatsApp groups, and then runs the test suites that session wrote. Both run
as the bot's own user, so without this they could do anything that user can:
write data/bot-cmd.json and have the bot post to a group, edit the live
checkout (the bot's code, and the check itself, which cron runs next hour),
read the GitHub login and push with it, or reach root through sudo. What the
prompt forbids, a message in a group can talk a model into; what the kernel
forbids, it cannot.

So, before starting the command, this sets two things that it and everything
it starts inherit and can never undo:

  - no_new_privs: sudo, su and every other setuid program refuse to run with
    more rights than the caller has. The bot's own unit sets the same
    (NoNewPrivileges=true).
  - a Landlock ruleset (Linux 5.13 and later; no root needed): files can be
    read and run only beneath the --ro and --rw paths, and written only
    beneath the --rw ones. Everything else - the rest of the home directory,
    with the GitHub login and the check's own settings in it - cannot be
    opened at all.

Landlock missing from the kernel is an error (exit 97), never a silent run
without it; --no-landlock asks for no_new_privs alone, and is the operator's
choice (HOURLY_DEBUG_FS_SANDBOX=0 in the check's settings file).

Neither of those stops two things a process of the same user can do, and a
review showed both from inside this sandbox on bot-box (kernel 6.8, Landlock
ABI 4, which controls neither):

  - connecting to a UNIX socket: `systemd-run --user` asked the user's
    systemd manager, over /run/user/<uid>/bus, to start a unit outside the
    sandbox - no no_new_privs, the GitHub login readable, the home directory
    writable, and with NOPASSWD sudo, root. The lxd socket is the same door.
  - signalling: `kill -TERM` or `-STOP` on any process of the user, the bot
    included, which forces crash restarts (the updater's rollback counts
    them) and WhatsApp reconnects.

So a seccomp filter goes on as well, always, and fails closed:

  - socket(AF_UNIX, ...) answers EACCES: no UNIX socket can be opened, so
    none can be connected to. socketpair() - how node gives a child its
    stdin and stdout - is left alone: such a pair is connected already, to
    nothing outside. io_uring, which can open and connect sockets without
    the socket() call, answers EPERM.
  - the calls that signal another process (kill, tkill, tgkill,
    rt_sigqueueinfo, rt_tgsigqueueinfo, pidfd_send_signal) are put to this
    script, which stays alive beside the command as its supervisor and
    lets one through only when its target is the command or one of its
    descendants (the supervisor is their subreaper, so an orphan stays
    one). Anything else - the bot, cron, the check itself - answers EPERM.
    If the supervisor is gone, every such call fails.

Unprivileged user namespaces (bubblewrap, unshare -U -p) would do the same
more simply, but Ubuntu 24.04 restricts them through AppArmor, and bot-box's
user cannot create one. WSL is the other way round: its init holds the one
seccomp listener a process may have, so the supervisor cannot be had, while
the user may make namespaces. There, and only where the listener answers
EBUSY, the command runs in user, PID and mount namespaces of its own instead
(run_confined_ns, "the namespace sandbox" below).

Python and ctypes rather than a node addon or a package: python3 is on every
Ubuntu box, and the check adds no dependency to the bot.
"""
import ctypes
import errno
import os
import platform
import signal
import socket
import struct
import sys
import threading

# The syscall numbers are the same on x86_64 and arm64 (the generic table).
SYS_CREATE_RULESET, SYS_ADD_RULE, SYS_RESTRICT_SELF = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
CREATE_RULESET_VERSION = 1
RULE_PATH_BENEATH = 1

EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR = 1 << 4, 1 << 5, 1 << 6, 1 << 7
MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = 1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12
REFER, TRUNCATE, IOCTL_DEV = 1 << 13, 1 << 14, 1 << 15

ABI1 = (1 << 13) - 1
BY_ABI = {1: ABI1, 2: ABI1 | REFER, 3: ABI1 | REFER | TRUNCATE, 4: ABI1 | REFER | TRUNCATE}
# What may be given on a path that is a file, not a directory.
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV
READ_ONLY = EXECUTE | READ_FILE | READ_DIR

libc = ctypes.CDLL(None, use_errno=True)


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


def die(msg, code=97):
    sys.stderr.write(f'sandbox: {msg}\n')
    sys.exit(code)


def abi():
    v = libc.syscall(SYS_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_RULESET_VERSION))
    return v if v > 0 else 0


def no_new_privs():
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die(f'could not set no_new_privs: {os.strerror(ctypes.get_errno())}')


def landlock(ro, rw):
    level = abi()
    if level < 1:
        die('this kernel has no Landlock (or it is not enabled) - the session is not run without it')
    handled = BY_ABI.get(level, BY_ABI[4])
    # Only the filesystem part of the attribute: the kernel takes a shorter
    # struct, and the network rules of ABI 4 are not wanted here.
    attr = ctypes.c_uint64(handled)
    ruleset = libc.syscall(SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(8), ctypes.c_uint32(0))
    if ruleset < 0:
        die(f'could not create a Landlock ruleset: {os.strerror(ctypes.get_errno())}')
    for paths, rights in ((ro, READ_ONLY), (rw, handled)):
        for p in paths:
            try:
                fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            try:
                allowed = rights & handled
                if not os.path.isdir(p):
                    allowed &= FILE_RIGHTS
                rule = PathBeneath(allowed, fd)
                if libc.syscall(SYS_ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(RULE_PATH_BENEATH), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
                    die(f'could not add {p}: {os.strerror(ctypes.get_errno())}')
            finally:
                os.close(fd)
    if libc.syscall(SYS_RESTRICT_SELF, ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
        die(f'could not apply the Landlock ruleset: {os.strerror(ctypes.get_errno())}')
    os.close(ruleset)


# ------------------------------------------------------------- seccomp

SECCOMP_SET_MODE_FILTER, SECCOMP_GET_NOTIF_SIZES = 1, 3
SECCOMP_FILTER_FLAG_NEW_LISTENER = 1 << 3
RET_ALLOW, RET_USER_NOTIF, RET_ERRNO = 0x7FFF0000, 0x7FC00000, 0x00050000
USER_NOTIF_FLAG_CONTINUE = 1
EPERM, EACCES, ENOSYS = 1, 13, 38
AF_UNIX, AF_VSOCK = 1, 40
LD_W_ABS, JEQ_K, JGE_K, RET_K = 0x20, 0x15, 0x35, 0x06

# Per architecture: the audit arch, the seccomp() syscall, and the calls the
# filter looks at. x86_64 and arm64 are what the bot runs on.
ARCHES = {
    'x86_64': {
        'audit': 0xC000003E, 'seccomp': 317, 'socket': 41, 'x32': 0x40000000,
        'signal': {'kill': 62, 'tkill': 200, 'tgkill': 234, 'rt_sigqueueinfo': 129,
                   'rt_tgsigqueueinfo': 297, 'pidfd_send_signal': 424},
        'uring': (425, 426, 427),
    },
    'aarch64': {
        'audit': 0xC00000B7, 'seccomp': 277, 'socket': 198, 'x32': None,
        'signal': {'kill': 129, 'tkill': 130, 'tgkill': 131, 'rt_sigqueueinfo': 138,
                   'rt_tgsigqueueinfo': 240, 'pidfd_send_signal': 424},
        'uring': (425, 426, 427),
    },
}


def arch():
    a = ARCHES.get(platform.machine())
    if not a:
        die(f'no seccomp filter for {platform.machine()} - the session is not run without one')
    return a


class SockFilter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_uint16), ('jt', ctypes.c_uint8), ('jf', ctypes.c_uint8), ('k', ctypes.c_uint32)]


class SockFprog(ctypes.Structure):
    _fields_ = [('len', ctypes.c_uint16), ('filter', ctypes.POINTER(SockFilter))]


def build_filter(a, supervise_signals=True):
    """The BPF program, as (code, jt, jf, k) with jumps resolved from labels.

    Without supervise_signals (the namespace sandbox, below) the signal calls
    are let through: the command is in a PID namespace of its own, where no
    process outside it has a number it could name. AF_VSOCK is refused there
    as well - on WSL it is the way to Windows beside the interop socket.
    """
    prog = []
    # Another ABI (i386 on x86_64) has another syscall table: nothing there.
    prog.append((LD_W_ABS, 0, 0, 4))                       # seccomp_data.arch
    prog.append((JEQ_K, 1, 0, a['audit']))
    prog.append((RET_K, 0, 0, RET_ERRNO | ENOSYS))
    prog.append((LD_W_ABS, 0, 0, 0))                       # seccomp_data.nr
    if a['x32'] is not None:
        prog.append((JGE_K, 0, 1, a['x32']))               # the x32 ABI, same arch
        prog.append((RET_K, 0, 0, RET_ERRNO | ENOSYS))
    for nr in a['uring']:
        prog.append((JEQ_K, 0, 1, nr))
        prog.append((RET_K, 0, 0, RET_ERRNO | EPERM))
    if supervise_signals:
        for nr in a['signal'].values():
            prog.append((JEQ_K, 0, 1, nr))
            prog.append((RET_K, 0, 0, RET_USER_NOTIF))
    prog.append((JEQ_K, 1, 0, a['socket']))
    prog.append((RET_K, 0, 0, RET_ALLOW))
    prog.append((LD_W_ABS, 0, 0, 16))                      # args[0], low half: the domain
    prog.append((JEQ_K, 0, 1, AF_UNIX))
    prog.append((RET_K, 0, 0, RET_ERRNO | EACCES))
    if not supervise_signals:
        prog.append((JEQ_K, 0, 1, AF_VSOCK))
        prog.append((RET_K, 0, 0, RET_ERRNO | EACCES))
    prog.append((RET_K, 0, 0, RET_ALLOW))
    return prog


def _seccomp(a, prog, flags):
    arr = (SockFilter * len(prog))(*[SockFilter(*i) for i in prog])
    fprog = SockFprog(len(prog), ctypes.cast(arr, ctypes.POINTER(SockFilter)))
    return libc.syscall(ctypes.c_long(a['seccomp']), ctypes.c_uint(SECCOMP_SET_MODE_FILTER),
                        ctypes.c_uint(flags), ctypes.byref(fprog))


def install_filter(a):
    """Install the filter; returns the listener fd for the signal calls."""
    fd = _seccomp(a, build_filter(a), SECCOMP_FILTER_FLAG_NEW_LISTENER)
    if fd < 0:
        err = ctypes.get_errno()
        # EBUSY: a filter this process inherited already has a listener, and
        # the kernel allows one per process. On WSL (the laptop, 2026-09-29)
        # WSL's own init holds one that every process inherits, so this can
        # never succeed there - said, so nobody retries or mints a new token.
        why = (' - a seccomp listener is already on this process (WSL\'s init holds one), and the kernel allows one'
               if err == errno.EBUSY else '')
        die(f'could not install the seccomp filter: {os.strerror(err)}{why}')
    return fd


def _stat(pid):
    """(ppid, pgrp) of a process, or None."""
    try:
        with open(f'/proc/{pid}/stat') as f:
            rest = f.read().rsplit(')', 1)[1].split()
        return int(rest[1]), int(rest[2])
    except (OSError, ValueError, IndexError):
        return None


def _tgid(tid):
    try:
        with open(f'/proc/{tid}/status') as f:
            for line in f:
                if line.startswith('Tgid:'):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def inside(pid, root, me):
    """Is `pid` the sandboxed command or a descendant of it?"""
    pid = _tgid(pid) or pid
    for _ in range(4096):
        if pid == root:
            return True
        st = _stat(pid)
        if not st or st[0] <= 1:
            return False
        pid = st[0]
        # Reparented to this supervisor, its subreaper: still the command's.
        if pid == me:
            return True
    return False


def group_inside(pgrp, root, me):
    """Is every member of process group `pgrp` inside?"""
    found = False
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        st = _stat(int(name))
        if st and st[1] == pgrp:
            found = True
            if int(name) != me and not inside(int(name), root, me):
                return False
    return found


def pidfd_target(caller, fd):
    try:
        with open(f'/proc/{caller}/fdinfo/{fd}') as f:
            for line in f:
                if line.startswith('Pid:'):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def allowed(nr, args, caller, root, me, sig_nrs):
    name = sig_nrs.get(nr)
    target = ctypes.c_int32(args[0] & 0xFFFFFFFF).value
    if name == 'kill':
        if target == 0:
            return True                          # the caller's own group
        if target == -1:
            return False                         # everything this user owns
        if target < 0:
            return group_inside(-target, root, me)
        return inside(target, root, me)
    if name == 'pidfd_send_signal':
        t = pidfd_target(caller, target)
        return t is not None and inside(t, root, me)
    # tkill(tid), tgkill(tgid, tid), rt_sigqueueinfo(tgid), rt_tgsigqueueinfo(tgid, tid)
    return target > 0 and inside(target, root, me)


def supervise(listener, root, a):
    """Answer the signal calls of the command's tree until this process ends."""
    sizes = (ctypes.c_uint16 * 3)()
    if libc.syscall(ctypes.c_long(a['seccomp']), ctypes.c_uint(SECCOMP_GET_NOTIF_SIZES), ctypes.c_uint(0), sizes) != 0:
        return
    notif_size, resp_size = sizes[0], sizes[1]
    recv = 0xC0000000 | (notif_size << 16) | (ord('!') << 8) | 0
    send = 0xC0000000 | (resp_size << 16) | (ord('!') << 8) | 1
    valid = 0x40000000 | (8 << 16) | (ord('!') << 8) | 2
    sig_nrs = {v: k for k, v in a['signal'].items()}
    me = os.getpid()
    buf = ctypes.create_string_buffer(notif_size)
    while True:
        ctypes.memset(buf, 0, notif_size)
        if libc.ioctl(listener, ctypes.c_ulong(recv), buf) != 0:
            if ctypes.get_errno() in (4, 2):             # EINTR, ENOENT: the caller went
                continue
            return
        nid, pid, _flags, nr, _arch = struct.unpack_from('<QIIiI', buf, 0)
        args = struct.unpack_from('<6Q', buf, 32)
        try:
            ok = allowed(nr, args, pid, root, me, sig_nrs)
        except Exception:                                # noqa: BLE001 - deny on anything odd
            ok = False
        # Still the same call? The caller may have died and its pid been reused.
        nid_c = ctypes.c_uint64(nid)
        if libc.ioctl(listener, ctypes.c_ulong(valid), ctypes.byref(nid_c)) != 0:
            continue
        resp = struct.pack('<QqiI', nid, 0, 0 if ok else -EPERM, USER_NOTIF_FLAG_CONTINUE if ok else 0)
        rbuf = ctypes.create_string_buffer(resp, resp_size)
        libc.ioctl(listener, ctypes.c_ulong(send), rbuf)


def run_confined(cmd, ro, rw, use_landlock):
    """Fork the command under every rule, and supervise it until it ends."""
    a = arch()
    parent_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    PR_SET_CHILD_SUBREAPER = 36
    libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    child = os.fork()
    if child == 0:
        parent_end.close()
        no_new_privs()
        if use_landlock:
            landlock(ro, rw)
        listener = install_filter(a)
        socket.send_fds(child_end, [b'L'], [listener])
        os.close(listener)
        child_end.close()
        try:
            os.execvp(cmd[0], cmd)
        except OSError as err:
            sys.stderr.write(f'sandbox: could not run {cmd[0]}: {err.strerror}\n')
            os._exit(127)
    child_end.close()
    try:
        _msg, fds, _f, _addr = socket.recv_fds(parent_end, 1, 1)
    except OSError:
        fds = []
    parent_end.close()
    if fds:
        threading.Thread(target=supervise, args=(fds[0], child, a), daemon=True).start()
    # Passed on to the command, whose tree the check stops by signalling it.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda n, _f: os.kill(child, n))
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            return 1
        except InterruptedError:
            continue
        if pid == child:
            return os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)


# ------------------------------------------------------ the namespace sandbox
#
# On WSL2 (the laptop, 2026-09-29) the filter above cannot go on: WSL's own
# init (PID 1) holds a seccomp listener that every process inherits, and the
# kernel allows one per process, so SECCOMP_FILTER_FLAG_NEW_LISTENER answers
# EBUSY and the check was report-only there. The same box lets the bot's user
# make user, PID and mount namespaces, so there the signal policing is
# replaced by a PID namespace - nothing outside it has a number the command
# could name, to signal, ptrace or reach through /proc/<pid>/root - and the
# filesystem is made read-only at the mount level as well, with the secrets
# and the Windows drives hidden under empty mounts. Everything else is as
# above: no_new_privs, the same Landlock rules, and a seccomp filter (without
# a listener: no UNIX sockets, no io_uring, and here no AF_VSOCK either).
#
#   supervisor (this process, outside)
#     -> middle: unshare(user, mount, pid), writes its uid and gid maps
#        -> init: PID 1 of the new namespace; makes the mounts, then forks
#           -> the command: no_new_privs, Landlock, seccomp, exec
#
# The uid is mapped to itself, not to root, so the command's execve drops
# every capability it had in the namespace: it cannot unmount what hides the
# secrets. init keeps its capabilities, but is made non-dumpable, so nothing
# without them may ptrace it. When init ends, the kernel kills everything left
# in the namespace, so no orphan of the session outlives it.

CLONE_NEWNS, CLONE_NEWUSER, CLONE_NEWPID = 0x00020000, 0x10000000, 0x20000000
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
SYS_OPEN_TREE, SYS_MOVE_MOUNT, SYS_MOUNT_SETATTR = 428, 429, 442   # generic: x86_64 and arm64 alike
OPEN_TREE_CLONE, AT_RECURSIVE, MOVE_MOUNT_F_EMPTY_PATH = 1, 0x8000, 4
MOUNT_ATTR_RDONLY, MOUNT_ATTR_NOSUID = 1, 2
PR_SET_PDEATHSIG, PR_SET_DUMPABLE, PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL = 1, 4, 47, 4
AT_FDCWD = -100

# Always hidden in the namespace sandbox, whatever --hide adds: the Windows
# drives and WSLg. /mnt/c is the operator's whole Windows profile, writable
# by this user, and holds every Windows program interop would run.
ALWAYS_HIDDEN = ('/mnt',)
# The files the system needs that may live under a hidden place: what these
# links point at is carried over, read-only.
KEPT = tuple(os.path.realpath(f) for f in ('/etc/resolv.conf', '/etc/hosts') if os.path.islink(f))


class MountAttr(ctypes.Structure):
    _fields_ = [('attr_set', ctypes.c_uint64), ('attr_clr', ctypes.c_uint64),
                ('propagation', ctypes.c_uint64), ('userns_fd', ctypes.c_uint64)]


def _fail(what):
    err = ctypes.get_errno()
    raise OSError(err, f'{what}: {os.strerror(err)}')


def _mount(src, target, fstype, flags, data=None):
    if libc.mount(src and src.encode(), target.encode(), fstype and fstype.encode(),
                  ctypes.c_ulong(flags), data and data.encode()) != 0:
        _fail(f'mount {target}')


def _write(path, text):
    with open(path, 'w') as f:
        f.write(text)


def enter_namespaces():
    """unshare(user, mount, pid) and map this uid and gid to themselves."""
    uid, gid = os.getuid(), os.getgid()
    if libc.unshare(ctypes.c_int(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID)) != 0:
        _fail('could not make user, mount and PID namespaces')
    _write('/proc/self/setgroups', 'deny')
    _write('/proc/self/uid_map', f'{uid} {uid} 1')
    _write('/proc/self/gid_map', f'{gid} {gid} 1')


def _within(p, d):
    return p == d or p.startswith(d.rstrip('/') + '/')


def make_mounts(rw, hide, ro=()):
    """In the new mount namespace: everything read-only but `rw`, `hide` and
    /mnt empty, and a /proc that shows this PID namespace alone. A `hide`
    path with a place given to the command beneath it is left to Landlock."""
    _mount(None, '/', None, MS_REC | MS_PRIVATE)
    # The writable places, cloned (with what is mounted under them) before
    # everything is made read-only, and put back on top afterwards.
    clones = []
    for p in rw:
        if not os.path.exists(p):
            continue
        fd = libc.syscall(ctypes.c_long(SYS_OPEN_TREE), ctypes.c_int(AT_FDCWD), p.encode(),
                          ctypes.c_uint(OPEN_TREE_CLONE | AT_RECURSIVE | os.O_CLOEXEC))
        if fd < 0:
            _fail(f'open_tree {p}')
        clones.append((fd, p))
    attr = MountAttr(MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID, 0, 0, 0)
    if libc.syscall(ctypes.c_long(SYS_MOUNT_SETATTR), ctypes.c_int(AT_FDCWD), b'/',
                    ctypes.c_uint(AT_RECURSIVE), ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr))) != 0:
        _fail('could not make the filesystem read-only')
    for fd, p in clones:
        if libc.syscall(ctypes.c_long(SYS_MOVE_MOUNT), ctypes.c_int(fd), b'', ctypes.c_int(AT_FDCWD), p.encode(),
                        ctypes.c_uint(MOVE_MOUNT_F_EMPTY_PATH)) != 0:
            _fail(f'move_mount {p}')
        os.close(fd)
    # This PID namespace's own /proc: the processes outside it are not in it,
    # so neither is /proc/<pid>/root, /mem or /environ of the bot. Its sysctls
    # stay read-only.
    _mount('proc', '/proc', 'proc', MS_NOSUID | MS_NODEV | MS_NOEXEC)
    _mount('/proc/sys', '/proc/sys', None, MS_BIND | MS_REC)
    _mount(None, '/proc/sys', None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
    for p in (*ALWAYS_HIDDEN, *hide):
        # Never over a place the command must write, or above one - nor,
        # for --hide, one it was given to read.
        given = rw if p in ALWAYS_HIDDEN else (*rw, *ro)
        if not os.path.lexists(p) or os.path.islink(p) or any(_within(r, p) for r in given):
            continue
        if os.path.isdir(p):
            # What the system needs from under it comes back, alone: on WSL
            # /etc/resolv.conf is a link to /mnt/wsl/resolv.conf, and without
            # it the session has no DNS.
            keep = [k for k in KEPT if _within(k, p) and os.path.isfile(k)]
            if not keep:
                _mount('tmpfs', p, 'tmpfs', MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, 'size=4k,mode=000')
                continue
            kept = []
            for k in keep:
                fd = libc.syscall(ctypes.c_long(SYS_OPEN_TREE), ctypes.c_int(AT_FDCWD), k.encode(),
                                  ctypes.c_uint(OPEN_TREE_CLONE | os.O_CLOEXEC))
                if fd < 0:
                    _fail(f'open_tree {k}')
                kept.append((fd, k))
            _mount('tmpfs', p, 'tmpfs', MS_NOSUID | MS_NODEV | MS_NOEXEC, 'size=16k,mode=755')
            for fd, k in kept:
                os.makedirs(os.path.dirname(k), mode=0o755, exist_ok=True)
                open(k, 'w').close()
                if libc.syscall(ctypes.c_long(SYS_MOVE_MOUNT), ctypes.c_int(fd), b'', ctypes.c_int(AT_FDCWD), k.encode(),
                                ctypes.c_uint(MOVE_MOUNT_F_EMPTY_PATH)) != 0:
                    _fail(f'move_mount {k}')
                os.close(fd)
                _mount(None, k, None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
            _mount(None, p, None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
        else:
            _mount('/dev/null', p, None, MS_BIND)
            _mount(None, p, None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)


def _code(status):
    return os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)


def _wait(pid):
    while True:
        try:
            return os.waitpid(pid, 0)[1]
        except InterruptedError:
            continue


def _forward(pid):
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda n, _f: os.kill(pid, n))


def _report(wfd, text):
    try:
        os.write(wfd, text.encode())
    except OSError:
        pass
    os._exit(97)


def run_confined_ns(cmd, ro, rw, hide, use_landlock, fallback=False):
    """run_confined, for a box where the seccomp listener cannot be had."""
    a = arch()
    # A pipe carries back why the sandbox could not be made, so it is said
    # rather than left as a bare exit code. It closes, empty, at the exec.
    rfd, wfd = os.pipe()
    os.set_inheritable(wfd, False)
    middle = os.fork()
    if middle == 0:
        os.close(rfd)
        _ns_middle(cmd, ro, rw, hide, use_landlock, a, wfd)
    os.close(wfd)
    _forward(middle)
    why = b''
    while True:
        try:
            chunk = os.read(rfd, 4096)
        except InterruptedError:
            continue
        if not chunk:
            break
        why += chunk
    os.close(rfd)
    status = _wait(middle)
    if why:
        # Said with why this sandbox was tried at all, so a box where neither
        # works (WSL with user namespaces refused) reads as that.
        pre = ('a seccomp listener is already on this process (WSL\'s init holds one), and '
               if fallback else '')
        die(pre + why.decode(errors='replace').strip())
    return _code(status)


def _ns_middle(cmd, ro, rw, hide, use_landlock, a, wfd):
    try:
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
        try:
            enter_namespaces()
        except OSError as err:
            _report(wfd, f'the namespace sandbox cannot start: {err.strerror}')
        init = os.fork()
        if init == 0:
            _ns_init(cmd, ro, rw, hide, use_landlock, a, wfd)
        os.close(wfd)
        _forward(init)
        os._exit(_code(_wait(init)))
    except BaseException:                                  # noqa: BLE001 - never back into the caller's code
        os._exit(97)


def _ns_init(cmd, ro, rw, hide, use_landlock, a, wfd):
    """PID 1 of the namespace: the mounts, then the command, then reaping."""
    try:
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
        cwd = os.getcwd()
        try:
            make_mounts(rw, hide, ro)
        except OSError as err:
            _report(wfd, f'the namespace sandbox cannot start: {err.strerror}')
        # The working directory was looked up before the writable places were
        # mounted back on top: look it up again, or it is the read-only one.
        try:
            os.chdir(cwd)
        except OSError:
            pass
        libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
        child = os.fork()
        if child == 0:
            libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)
            if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
                _report(wfd, f'could not set no_new_privs: {os.strerror(ctypes.get_errno())}')
            if use_landlock:
                landlock(ro, rw)
            if _seccomp(a, build_filter(a, supervise_signals=False), 0) < 0:
                _report(wfd, f'could not install the seccomp filter: {os.strerror(ctypes.get_errno())}')
            try:
                os.execvp(cmd[0], cmd)
            except OSError as err:
                sys.stderr.write(f'sandbox: could not run {cmd[0]}: {err.strerror}\n')
            os._exit(127)
        os.close(wfd)
        _forward(child)
        while True:
            try:
                pid, status = os.waitpid(-1, 0)
            except ChildProcessError:
                os._exit(1)
            except InterruptedError:
                continue
            if pid == child:
                # Leaving takes the rest of the namespace with it.
                os._exit(_code(status))
    except BaseException:                                  # noqa: BLE001
        os._exit(97)


def listener_error():
    """0 when this process could take a seccomp listener, else the errno.
    Tried in a throwaway child, which is all it touches."""
    a = arch()
    pid = os.fork()
    if pid == 0:
        try:
            libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
            fd = _seccomp(a, [(RET_K, 0, 0, RET_ALLOW)], SECCOMP_FILTER_FLAG_NEW_LISTENER)
            os._exit(0 if fd >= 0 else (min(ctypes.get_errno(), 254) or 254))
        except BaseException:                              # noqa: BLE001
            os._exit(254)
    return _code(_wait(pid))


def mode():
    """Which sandbox this box gets: 'listener' (the seccomp supervisor), or
    'namespaces' where the listener is taken already (WSL). Any other failure
    of the listener is left to run_confined, which says what it was."""
    return 'namespaces' if listener_error() == errno.EBUSY else 'listener'


# What --probe runs inside the sandbox. The check and its installer ask it
# before every research session, and refuse to start one when it prints
# anything but "closed" (tools/hourly-debug.mjs sandboxProblem).
PROBE = """
import os, socket, sys
bad = []
try:
    socket.socket(socket.AF_UNIX)
    bad.append('UNIX sockets (systemd-run --user, the lxd socket)')
except OSError:
    pass
try:
    os.kill(int(sys.argv[1]), 0)
    bad.append('signals to other processes (the bot)')
except OSError:
    pass
if sys.argv[2] == 'namespaces':
    # What the PID and mount namespaces stand for there: the check's own
    # process must not be in /proc, the Windows drives must not be there, and
    # nothing may be written (the probe is given no writable place).
    if os.path.exists('/proc/' + sys.argv[1]):
        bad.append('other processes in /proc (/proc/<pid>/root of the bot)')
    if os.path.exists('/mnt/c') or os.path.exists('/mnt/wslg'):
        bad.append('the Windows drives (/mnt)')
    try:
        socket.socket(40)
        bad.append('vsock (WSL interop)')
    except OSError:
        pass
    try:
        open(os.path.join(os.environ.get('HOME', '/'), '.sandbox-probe'), 'w').close()
        bad.append('writes outside its places')
    except OSError:
        pass
print('; '.join(bad) or 'closed')
"""


def confine(cmd, ro, rw, hide, use_landlock, forced):
    """The listener sandbox, or the namespace one where the listener is
    taken (or --namespaces asked for it)."""
    if forced:
        return run_confined_ns(cmd, ro, rw, hide, use_landlock)
    if mode() == 'namespaces':
        return run_confined_ns(cmd, ro, rw, hide, use_landlock, fallback=True)
    return run_confined(cmd, ro, rw, use_landlock)


def main(argv):
    if argv[:1] == ['--abi']:
        print(abi())
        return 0
    # --namespaces: the namespace sandbox even where the listener is free -
    # for the tests, which try both wherever both can be had.
    end = argv.index('--') if '--' in argv else len(argv)
    forced = '--namespaces' in argv[:end]
    argv = [x for x in argv[:end] if x != '--namespaces'] + argv[end:]
    if argv[:1] == ['--mode']:
        print('namespaces' if forced else mode())
        return 0
    if argv[:1] == ['--probe'] and len(argv) == 2:
        which = 'namespaces' if forced else mode()
        return confine([sys.executable, '-c', PROBE, argv[1], which], [], [], [], False, forced)
    ro, rw, hide, use_landlock = [], [], [], True
    i = 0
    while i < len(argv) and argv[i] != '--':
        a = argv[i]
        if a in ('--ro', '--rw', '--hide') and i + 1 < len(argv):
            {'--ro': ro, '--rw': rw, '--hide': hide}[a].append(os.path.abspath(argv[i + 1]))
            i += 2
        elif a == '--no-landlock':
            use_landlock = False
            i += 1
        else:
            die(f'unknown argument {a!r}', 2)
    cmd = argv[i + 1:]
    if not cmd:
        die('no command given (sandbox.py [--ro P]... [--rw P]... [--hide P]... -- COMMAND ...)', 2)
    if use_landlock and abi() < 1:
        die('this kernel has no Landlock (or it is not enabled) - the session is not run without it')
    return confine(cmd, ro, rw, hide, use_landlock, forced)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
