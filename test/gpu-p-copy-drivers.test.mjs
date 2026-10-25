/* deploy/gpu-p-copy-drivers.ps1: the bash it runs on the VM makes nvidia-smi
   executable, and says so loudly when nvidia-smi fails.
   Run: node test/gpu-p-copy-drivers.test.mjs

   2026-09-29, bot-box2: the driver files reached the VM, but nvidia-smi was
   left at mode 0644 ("Permission denied"). Windows' scp sends no execute
   bits, and the script's `chmod -R a+rX` adds one only to folders and to
   files that already have one. Its only check was then wrapped in
   `if [ -x nvidia-smi ]`, so it was skipped without a word, the remote
   exited 0, and PowerShell printed "Done." (GPU-P does not work on that
   laptop in any case - "GPU access blocked by the operating system" - which
   the script must report as a failure, not as success.)

   The PowerShell cannot run here, but the bash it sends can: it is taken out
   of the here-string, its /usr/lib/wsl and /etc paths are moved under a
   scratch folder, and sudo and ldconfig are stubs. The rewrite is checked to
   have left no real system path before anything runs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS1 = fs.readFileSync(path.join(REPO, 'deploy/gpu-p-copy-drivers.ps1'), 'utf8');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-p-'));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));

const remote = /\$remote = @'\r?\n([\s\S]*?)\r?\n'@/.exec(PS1)?.[1] ?? '';
const DRIVER = 'nv_dispi.inf_amd64_0123456789abcdef';

console.log('=== the bash sent to the VM ===');
{
  ok(remote.length > 100, 'the here-string is found');
  // The script's own comment: Windows PowerShell 5.1 mangles double quotes in
  // an argument to a native program such as ssh.
  ok(!remote.includes('"'), 'it has no double quotes, which PowerShell 5.1 would mangle on the way to ssh');
  const parse = spawnSync('bash', ['-n'], { input: remote.replaceAll('__DRIVER__', DRIVER), encoding: 'utf8' });
  ok(parse.status === 0, `it parses${parse.status ? `: ${parse.stderr}` : ''}`);
  ok(/chmod 0755 \/usr\/lib\/wsl\/lib\/nvidia-smi/.test(remote), 'nvidia-smi is made executable by name');
  ok(!/\[ -x \/usr\/lib\/wsl\/lib\/nvidia-smi \]/.test(remote), 'and its run is not skipped when it is not executable');
  ok(/if \(\$LASTEXITCODE -eq 3\)/.test(PS1) && /throw "the files are in place on \$Target, but nvidia-smi fails/.test(PS1),
    'PowerShell tells "the files are in place, but nvidia-smi fails" apart from a failed install');
  ok(!/encodes fall back to the CPU|NVENC, for the encodes/.test(PS1) && /does not work on that laptop/.test(PS1),
    'the header says GPU-P failed on bot-box2, and no longer promises faster encodes');
  ok(/-ExecutionPolicy Bypass -File/.test(PS1), 'and how to run it on a Windows host that refuses scripts by default');
}

/** Run the remote bash against a scratch root, with nvidia-smi as given (null: nothing staged). */
function runRemote(nvidiaSmi) {
  const box = fs.mkdtempSync(path.join(T, 'box-'));
  const root = path.join(box, 'root');
  const home = path.join(box, 'home');
  const bin = path.join(box, 'bin');
  for (const d of [bin, path.join(root, 'etc/ld.so.conf.d'), home]) fs.mkdirSync(d, { recursive: true });
  if (nvidiaSmi !== null) {
    for (const d of [path.join(home, 'gpu-drv/lib'), path.join(home, 'gpu-drv/drivers', DRIVER)]) fs.mkdirSync(d, { recursive: true });
    // As Windows' scp delivers them: no execute bit on anything.
    fs.writeFileSync(path.join(home, 'gpu-drv/lib/nvidia-smi'), nvidiaSmi, { mode: 0o644 });
    fs.writeFileSync(path.join(home, 'gpu-drv/lib/libcuda.so.1'), 'lib', { mode: 0o644 });
    fs.writeFileSync(path.join(home, 'gpu-drv/drivers', DRIVER, 'nvlddmkm.sys'), 'sys', { mode: 0o644 });
  }
  // sudo runs the rest as this user, bar chown to root; ldconfig does nothing.
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/usr/bin/env bash\n[ "$1" = chown ] && exit 0\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ldconfig'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const script = remote.replaceAll('__DRIVER__', DRIVER)
    .replaceAll('/usr/lib/wsl', `${root}/usr/lib/wsl`)
    .replaceAll('/etc/ld.so.conf.d', `${root}/etc/ld.so.conf.d`);
  // Nothing may point outside the scratch folder before this runs.
  const stray = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    .replaceAll(root, '<root>').match(/(^|[\s'=|])\/(usr|etc|lib|opt|var)\//m);
  if (stray) throw new Error(`refusing to run: a system path is left in the script (${stray[0]})`);
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
  });
  const smi = path.join(root, 'usr/lib/wsl/lib/nvidia-smi');
  return {
    ...r, out: `${r.stdout}${r.stderr}`, root, home,
    smiMode: fs.existsSync(smi) ? fs.statSync(smi).mode & 0o777 : null,
  };
}

console.log('=== nvidia-smi arrives at 0644, as it did on bot-box2 ===');
{
  const r = runRemote('#!/bin/sh\necho "NVIDIA-SMI 560.94   Driver Version: 560.94"\n');
  ok(r.status === 0, `the remote exits 0 when nvidia-smi works${r.status ? `: ${r.out}` : ''}`);
  ok(r.smiMode === 0o755, `nvidia-smi ends up executable (mode ${r.smiMode?.toString(8)})`);
  ok(/NVIDIA-SMI 560\.94/.test(r.out), 'and it was run, not skipped');
  ok(/^moving the files into place/m.test(r.out) && /^in place: /m.test(r.out), 'each stage says when it starts and ends');
  ok(fs.readFileSync(path.join(r.root, 'etc/ld.so.conf.d/ld.wsl.conf'), 'utf8').includes('/usr/lib/wsl/lib'),
    'the loader is pointed at the library folder');
  ok(fs.existsSync(path.join(r.root, 'usr/lib/wsl/drivers', DRIVER, 'nvlddmkm.sys')) && !fs.existsSync(path.join(r.home, 'gpu-drv')),
    'the driver folder is in place, and the staging copy is gone');
}

console.log('=== nvidia-smi fails, as GPU-P does on bot-box2 ===');
{
  const r = runRemote('#!/bin/sh\necho "GPU access blocked by the operating system" >&2\nexit 9\n');
  ok(r.status === 3, `the remote exits 3, so PowerShell says so instead of "Done." (exit ${r.status})`);
  ok(/the files are in place, but nvidia-smi failed/.test(r.out) && /GPU access blocked/.test(r.out), 'and says the files went in and the GPU did not answer');
}

console.log('=== the copy never arrived ===');
{
  const r = runRemote(null);
  ok(r.status === 1 && /nvidia-smi is not in the copied lib folder: nothing was moved/.test(r.stderr)
    && !fs.existsSync(path.join(r.root, 'usr/lib/wsl')), 'nothing staged: it stops before any sudo, and says why');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
