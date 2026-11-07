#!/usr/bin/env node
// CI only (Bump Codex Runtime). The bump job looks at the fork's tags, so when
// the fork stops releasing it reports "no change" and stays green forever while
// upstream Codex moves on. This fails the job when upstream has had a stable
// release newer than what we ship for more than --max-lag-days.
//
// The clock starts at the OLDEST upstream release newer than the shipped
// version: that is how long we have really been behind, whatever came later.
//
//   node scripts/check-codex-freeze.js --shipped 0.163.0 \
//     --releases upstream.json --max-lag-days 3
//
// upstream.json = `gh release list --repo openai/codex --json tagName,publishedAt`.
// Exit 0 = within the limit, 1 = frozen, 2 = could not tell (also a failure:
// a check that cannot run must not look green).

const fs = require('fs');

const DAY_MS = 24 * 60 * 60 * 1000;

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Stable upstream tags only (rust-v0.167.0); alpha tags never count.
function stableReleases(releases) {
  const out = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.isPrerelease === true) continue;
    const m = /^rust-v(\d+\.\d+\.\d+)$/.exec(String(release.tagName));
    const publishedAt = Date.parse(release.publishedAt);
    if (m && Number.isFinite(publishedAt)) {
      out.push({ version: m[1], parsed: parseVersion(m[1]), publishedAt });
    }
  }
  return out;
}

function checkFreeze({ shipped, releases, maxLagDays, now }) {
  const shippedVersion = parseVersion(shipped);
  if (!shippedVersion) return { status: 'unknown', message: `cannot parse shipped version "${shipped}"` };
  if (!Number.isFinite(maxLagDays) || maxLagDays <= 0) {
    return { status: 'unknown', message: `bad max lag "${maxLagDays}"` };
  }
  const stable = stableReleases(releases);
  if (stable.length === 0) return { status: 'unknown', message: 'no stable upstream release found' };

  const newer = stable
    .filter((release) => compareVersions(release.parsed, shippedVersion) > 0)
    .sort((a, b) => compareVersions(a.parsed, b.parsed));
  if (newer.length === 0) return { status: 'ok', message: `shipped ${shipped} is the latest upstream` };

  const latest = newer[newer.length - 1].version;
  const lagDays = (now - newer[0].publishedAt) / DAY_MS;
  const summary = `shipped ${shipped}, upstream ${latest}; ${newer[0].version} came out ${lagDays.toFixed(1)} days ago (limit ${maxLagDays})`;
  if (lagDays > maxLagDays) return { status: 'frozen', message: `Codex runtime is frozen: ${summary}` };
  return { status: 'ok', message: `within the limit: ${summary}` };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = checkFreeze({
      shipped: args.shipped,
      releases: JSON.parse(fs.readFileSync(args.releases, 'utf8')),
      maxLagDays: Number(args['max-lag-days']),
      now: Date.now(),
    });
  } catch (error) {
    result = { status: 'unknown', message: `cannot read upstream releases: ${error.message}` };
  }
  if (result.status === 'ok') {
    console.log(result.message);
    process.exit(0);
  }
  console.log(`::error title=Codex freeze check::${result.message}`);
  process.exit(result.status === 'frozen' ? 1 : 2);
}

if (require.main === module) main();

module.exports = { checkFreeze, stableReleases };
