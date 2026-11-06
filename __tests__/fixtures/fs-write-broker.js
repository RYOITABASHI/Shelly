#!/usr/bin/env node
// Test stand-in for the capability broker's fs.write, which is a known failure
// on a Windows host. fs.write copies the input file to --path, or fails when
// SHELLY_TEST_FAIL_FS_WRITE is set. Every other operation goes to the real
// broker, so the model calls still take the real path. POSIX runs of the suites
// use the real broker directly, unless a test needs the write to fail.
//
// SHELLY_TEST_FAKE_HTTP names a JSON file { "<url fragment>": [reply, ...] }, so
// a test can stand in for the cloud engines the loopback fixture cannot serve.
// Each call takes the next reply for its URL: { body } answers, { exit } fails
// with that broker exit code (23 is the transient one), and running out of
// replies fails too. Every call is appended to "<file>.calls".
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

if (arg('op') === 'http.request' && process.env.SHELLY_TEST_FAKE_HTTP) {
  const file = process.env.SHELLY_TEST_FAKE_HTTP;
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = Object.keys(script).find((fragment) => arg('url').includes(fragment));
  fs.appendFileSync(`${file}.calls`, `${key || arg('url')}\n`);
  const reply = key ? script[key].shift() : undefined;
  fs.writeFileSync(file, JSON.stringify(script));
  if (!reply || reply.exit) {
    if (arg('err')) fs.writeFileSync(arg('err'), 'refused by the test\n');
    process.exit(reply ? reply.exit : 3);
  }
  fs.writeFileSync(arg('out'), JSON.stringify(reply.body));
  process.exit(0);
}

const result = spawnSync(process.execPath, [realBroker, ...argv], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
