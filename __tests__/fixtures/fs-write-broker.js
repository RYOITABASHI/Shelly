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
// replies fails too. Every call is appended to "<file>.calls", and its request
// body to "<file>.bodies", one JSON string per line.
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
  fs.appendFileSync(`${file}.bodies`, `${JSON.stringify(arg('body-file') ? fs.readFileSync(arg('body-file'), 'utf8') : '')}\n`);
  const reply = key ? script[key].shift() : undefined;
  fs.writeFileSync(file, JSON.stringify(script));
  if (!reply || reply.exit) {
    if (arg('err')) fs.writeFileSync(arg('err'), 'refused by the test\n');
    process.exit(reply ? reply.exit : 3);
  }
  fs.writeFileSync(arg('out'), JSON.stringify(reply.body));
  process.exit(0);
}

// http.resolve-redirect never reaches the network from a test. With
// SHELLY_TEST_FAKE_REDIRECTS naming a JSON file { "<redirect url>": "<target>" }
// it answers from that file through the real broker's own op (an injected
// probe, so the broker's URL and target checks still run); without it the op
// fails as a broker outage would. The asked URLs go to "<file>.calls".
if (arg('op') === 'http.resolve-redirect') {
  const file = process.env.SHELLY_TEST_FAKE_REDIRECTS;
  if (!file) {
    if (arg('err')) fs.writeFileSync(arg('err'), 'no network in tests\n');
    process.exit(23);
  }
  const answers = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { runResolveRedirects } = require(realBroker);
  const args = {};
  for (let k = 0; k < argv.length; k += 2) args[argv[k].replace(/^--/, '')] = argv[k + 1];
  const probe = (url) => {
    fs.appendFileSync(`${file}.calls`, `${url}\n`);
    return Promise.resolve(Object.prototype.hasOwnProperty.call(answers, url) ? { status: 302, target: answers[url] } : { status: 404, target: null });
  };
  runResolveRedirects(args, new Date().toISOString(), Date.now(), probe).then((code) => process.exit(code), () => process.exit(127));
  return;
}

// http.fetch-text never reaches the network from a test either. With
// SHELLY_TEST_FAKE_PAGES naming a JSON file { "<url>": "<page text>" } it
// answers through the real broker's own op (an injected fetcher, so the op's
// tainted refusal, URL checks, caps and audit still run); a URL not in the file
// fails like an unreadable page. Without the variable the op fails as a broker
// outage would. The asked URLs go to "<file>.calls".
if (arg('op') === 'http.fetch-text') {
  const file = process.env.SHELLY_TEST_FAKE_PAGES;
  if (!file) {
    if (arg('err')) fs.writeFileSync(arg('err'), 'no network in tests\n');
    process.exit(23);
  }
  const pages = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { runFetchText } = require(realBroker);
  const args = {};
  for (let k = 0; k < argv.length; k += 2) args[argv[k].replace(/^--/, '')] = argv[k + 1];
  const fetcher = (url) => {
    fs.appendFileSync(`${file}.calls`, `${url}\n`);
    if (!Object.prototype.hasOwnProperty.call(pages, url)) return Promise.resolve({ ok: false, reason: 'status 404', status: 404, finalHost: null, redirects: 0 });
    return Promise.resolve({ ok: true, status: 200, finalUrl: url, finalHost: new URL(url).hostname, bytes: pages[url].length, sha: '0'.repeat(64), text: pages[url], truncated: false, redirects: 0 });
  };
  runFetchText(args, new Date().toISOString(), Date.now(), fetcher).then((code) => process.exit(code), () => process.exit(127));
  return;
}

const result = spawnSync(process.execPath, [realBroker, ...argv], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
