#!/usr/bin/env node
/**
 * The two WSL settings files, for deploy/wsl-setup.sh. It prints; it never
 * writes (the script compares, and writes with sudo where it has to).
 *
 *   node tools/wsl-config.mjs --windows-home
 *        the Windows profile folder, as a path in here (/mnt/c/Users/<name>)
 *   node tools/wsl-config.mjs --edit <file> <section.key=value>...
 *        <file> with those set and everything else kept, on stdout; a file
 *        that does not exist yet is taken as empty
 *   node tools/wsl-config.mjs --autostart [<distro>]
 *        the PowerShell that starts the distro with Windows (wsl-autostart)
 *
 * Exit: 0 done, 1 not found, 2 usage.
 */
import fs from 'node:fs';
import { realSys } from './routines.mjs';
import { iniSet, windowsHome, autostartPowerShell, detectWsl } from '../src/core/wsl.js';

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--windows-home') {
  const sys = realSys();
  const found = await windowsHome(sys, sys.user);
  if (!found) { console.error('wsl-config: could not tell which Windows profile this is (set WSL_WINDOWS_HOME=/mnt/c/Users/<name>)'); process.exit(1); }
  console.log(found.dir);
} else if (mode === '--edit' && rest.length >= 2) {
  const [file, ...pairs] = rest;
  const values = {};
  for (const p of pairs) {
    const m = /^([\w-]+\.[\w-]+)=(.*)$/.exec(p);
    if (!m) { console.error(`wsl-config: not section.key=value: ${p}`); process.exit(2); }
    values[m[1]] = m[2];
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') { console.error(`wsl-config: ${file}: ${err.message}`); process.exit(1); } }
  process.stdout.write(iniSet(text, values));
} else if (mode === '--autostart') {
  console.log(autostartPowerShell(rest[0] || detectWsl(realSys())?.distro));
} else {
  console.error('usage: node tools/wsl-config.mjs --windows-home | --edit <file> <section.key=value>... | --autostart [<distro>]');
  process.exit(2);
}
