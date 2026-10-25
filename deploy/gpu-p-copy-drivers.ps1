<#
.SYNOPSIS
  Copy the NVIDIA GPU-P driver files from this Windows Hyper-V host into the
  bot's Ubuntu VM, over scp.

.DESCRIPTION
  STATUS: tried on bot-box2 on 2026-09-29 (NVIDIA laptop GPU), and it
  does not work on that laptop: the partition attaches, dxgkrnl builds and
  these files go in, but nvidia-smi says "GPU access blocked by the operating
  system" and h264_nvenc fails at cuInit. WSL2 is not an option there, and the
  bot has no NVENC path anyway (src/media/ffmpeg.js encodes with libx264), so
  nothing would use a working one. Kept as a record of what was tried, for a
  host where GPU-P might work; docs/server-setup.md, "GPU partitioning
  (GPU-P)", has the steps around it and how to undo it all.

  Run this on the Windows HOST, not in the VM. The repository is private and
  the host has no clone, so fetch the script from the VM first, and bypass
  the execution policy, which on Windows 10 and 11 refuses scripts by default:

    scp mommy@192.168.20.45:whatsapp-bot/deploy/gpu-p-copy-drivers.ps1 $env:TEMP\
    powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\gpu-p-copy-drivers.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\gpu-p-copy-drivers.ps1 -Target someone@192.168.20.50

  With GPU partitioning (Add-VMGpuPartitionAdapter -InstancePath <the
  VEN_10DE device>) the VM borrows a slice of the host's NVIDIA card through
  Hyper-V's paravirtual GPU, and the user-mode half of the driver - libcuda,
  libnvidia-encode, nvidia-smi and the rest - is not in any Linux package. It
  has to be copied from the host, from the same places WSL2 uses:

    C:\Windows\System32\lxss\lib                          -> /usr/lib/wsl/lib
    C:\Windows\System32\DriverStore\FileRepository\nv*    -> /usr/lib/wsl/drivers/<folder>
      (the newest nv* folder holding nvlddmkm.sys: the driver installed now)

  The files go to ~/gpu-drv on the VM first, since scp cannot write to
  /usr/lib as a normal user; then, in one SSH session (-t, so sudo can ask
  for a password), they are moved into place with sudo, made readable by
  everyone (chmod -R a+rX: the bot does not run as root), nvidia-smi is made
  executable by name (scp from Windows sends no execute bits, and a+rX adds
  none to a file that had none: bot-box2's was left at 0644, "Permission
  denied"), and /etc/ld.so.conf.d/ld.wsl.conf points the loader at
  /usr/lib/wsl/lib before ldconfig runs. Each stage says when it starts, so
  a run that stops between the copy and the move shows where (bot-box2's did);
  a rerun starts over. It ends by running nvidia-smi, and fails if that fails.

  RERUN THIS AFTER EVERY NVIDIA DRIVER UPDATE ON WINDOWS. The files in the VM
  must be the same version as the host's kernel driver, and Windows Update or
  the NVIDIA app can update that at any time; with the old files nvidia-smi
  fails until this is run again. A new driver lands in a new FileRepository folder, so
  the old folder in /usr/lib/wsl/drivers is left behind, unused; it is listed
  at the end, to delete by hand if the disk is short.

  It needs the OpenSSH client (ssh, scp), built into Windows 10 and 11, and an
  SSH login to the VM. See docs/server-setup.md, "GPU partitioning (GPU-P)".

.PARAMETER Target
  user@host of the VM. Defaults to mommy@192.168.20.45, the bot box's
  static address (deploy/pin-lan-address.sh --static).
#>
[CmdletBinding()]
param(
  [string]$Target = 'mommy@192.168.20.45'
)
$ErrorActionPreference = 'Stop'

foreach ($tool in 'ssh', 'scp') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is missing: Settings -> System -> Optional features -> OpenSSH Client"
  }
}

$lib = Join-Path $env:SystemRoot 'System32\lxss\lib'
if (-not (Test-Path (Join-Path $lib 'libcuda.so*'))) {
  throw "$lib has no libcuda: is the NVIDIA driver installed on this host?"
}

# Every driver version Windows has kept is a folder here; the one in use now
# is the newest that holds the kernel driver, nvlddmkm.sys.
$repo = Join-Path $env:SystemRoot 'System32\DriverStore\FileRepository'
$driver = Get-ChildItem -Path $repo -Directory -Filter 'nv*' |
  Where-Object { Test-Path (Join-Path $_.FullName 'nvlddmkm.sys') } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $driver) { throw "no nv* folder with nvlddmkm.sys under $repo" }
$name = $driver.Name

Write-Host "host driver folder: $name ($($driver.LastWriteTime))"
Write-Host "copying to $Target, staged in ~/gpu-drv"

# A clean staging folder: a leftover from an interrupted run would be merged
# into this one by scp.
ssh $Target 'rm -rf ~/gpu-drv && mkdir -p ~/gpu-drv/drivers'
if ($LASTEXITCODE -ne 0) { throw "ssh $Target failed: can this host log in to the VM?" }

scp -r $lib "${Target}:gpu-drv/lib"
if ($LASTEXITCODE -ne 0) { throw "copying $lib failed" }
scp -r $driver.FullName "${Target}:gpu-drv/drivers/"
if ($LASTEXITCODE -ne 0) { throw "copying $($driver.FullName) failed" }
Write-Host "copied; now moving them into place on $Target (ssh -t: sudo may ask for the password there)"

# Single-quoted here-string: PowerShell expands nothing in it, so $HOME and
# the rest reach bash as written; only the folder name is put in. It has no
# double quotes on purpose: Windows PowerShell 5.1 mangles them in an
# argument to a native program such as ssh. No path here has a space.
# Exit 3 is kept for "the files are in place, but nvidia-smi fails": on
# bot-box2 that was the GPU itself ("GPU access blocked by the operating
# system"), not the copy, and the two need different next steps.
$remote = @'
set -eu
d='__DRIVER__'
[ -f $HOME/gpu-drv/lib/nvidia-smi ] || { echo 'nvidia-smi is not in the copied lib folder: nothing was moved' >&2; exit 1; }
echo 'moving the files into place (sudo)'
sudo mkdir -p /usr/lib/wsl/drivers
sudo rm -rf /usr/lib/wsl/lib /usr/lib/wsl/drivers/$d
sudo mv $HOME/gpu-drv/lib /usr/lib/wsl/lib
sudo mv $HOME/gpu-drv/drivers/$d /usr/lib/wsl/drivers/$d
sudo chown -R root:root /usr/lib/wsl
sudo chmod -R a+rX /usr/lib/wsl
# scp from Windows sends no execute bits, and a+rX adds none to a file that
# had none: bot-box2's nvidia-smi was left at 0644 ('Permission denied').
sudo chmod 0755 /usr/lib/wsl/lib/nvidia-smi
echo /usr/lib/wsl/lib | sudo tee /etc/ld.so.conf.d/ld.wsl.conf >/dev/null
# lxss\lib holds copies where Linux would have symlinks (libcuda.so.1 and so
# on), and ldconfig says so for each; that is expected, not a failure.
sudo ldconfig 2>&1 | grep -v 'is not a symbolic link' || true
rm -rf $HOME/gpu-drv
echo 'in place: /usr/lib/wsl/lib and' /usr/lib/wsl/drivers/$d
ls -1 /usr/lib/wsl/drivers | grep -vx $d | sed 's|^|older driver folder, unused now: /usr/lib/wsl/drivers/|' || true
/usr/lib/wsl/lib/nvidia-smi || { echo 'the files are in place, but nvidia-smi failed: is the GPU partition adapter on this VM, and the dxgkrnl module loaded? On bot-box2 it said GPU access blocked by the operating system, and GPU-P does not work there.' >&2; exit 3; }
'@
$remote = $remote.Replace('__DRIVER__', $name).Replace("`r`n", "`n")

ssh -t $Target $remote
if ($LASTEXITCODE -eq 3) { throw "the files are in place on $Target, but nvidia-smi fails there (see above)" }
if ($LASTEXITCODE -ne 0) { throw "installing the files on $Target failed (see above); the copy is in ~/gpu-drv there, and running this again starts over" }
Write-Host 'Done. Run this again after every NVIDIA driver update on this host.'
