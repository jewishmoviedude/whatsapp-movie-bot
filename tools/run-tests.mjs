#!/usr/bin/env node
/**
 * Run every test/*.test.mjs.
 *
 * This used to be a hand-maintained list in package.json. A new suite that
 * nobody remembered to add to that list simply never ran, and reported nothing
 * - the worst kind of green. Discovering the files removes that failure mode.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');
const suites = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort();

if (!suites.length) {
  console.error('no test suites found in test/ - that is a problem, not a pass');
  process.exit(1);
}

const failed = [];
let assertions = 0;

for (const file of suites) {
  const res = spawnSync(process.execPath, [path.join(testDir, file)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  process.stdout.write(out);
  assertions += (out.match(/^ {2}ok {3}/gm) ?? []).length;
  if (res.status !== 0) failed.push(file);
}

const line = '='.repeat(60);
console.log(`\n${line}`);
console.log(`${suites.length} suites, ${assertions} assertions`);
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('all green');
