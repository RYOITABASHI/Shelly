#!/usr/bin/env node
// Test stand-in for the capability broker's fs.write, which is a known failure
// on a Windows host. fs.write copies the input file to --path, or fails when
// SHELLY_TEST_FAIL_FS_WRITE is set. Every other operation goes to the real
// broker, so the model calls still take the real path. POSIX runs of the suites
// use the real broker directly, unless a test needs the write to fail.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const realBroker = path.resolve(__dirname, '..', '..', 'scripts', 'shelly-capability-broker.js');
const argv = process.argv.slice(2);
const arg = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? '' : argv[at + 1];
};

if (arg('op') === 'fs.write') {
  if (process.env.SHELLY_TEST_FAIL_FS_WRITE) {
    if (arg('err')) fs.writeFileSync(arg('err'), 'scoped.fs: refused by the test\n');
    process.exit(3);
  }
  fs.mkdirSync(path.dirname(arg('path')), { recursive: true });
  fs.copyFileSync(arg('input-file'), arg('path'));
  if (arg('out')) fs.writeFileSync(arg('out'), `${arg('path')}\n`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [realBroker, ...argv], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
