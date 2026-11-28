#!/usr/bin/env node
'use strict';

/**
 * PC-side residency judge (shelly-hayato-bridge #6 item 2). Reads the JSON
 * that the MCP tool read_residency returned (a file path argument, or stdin)
 * and reports, for the window --from .. --to cut into --slot sized slots:
 *
 *   - samples in the window, slots covered / missing (missing runs merged)
 *   - pid / startTicks / bootId changes between consecutive samples
 *   - samples not alive, and /health failures
 *   - for each gap: whether the samples on both sides show the same live
 *     process (pid + startTicks + bootId identical): "process continuous
 *     across gap" — the device slept or the alarm was late, the service did
 *     not restart
 *   - the chain verification read_residency computed (seq / prev links)
 *
 * and ends with one line starting "VERDICT:". Always exits 0 (it reports;
 * it does not gate). Plain node, no dependencies.
 *
 * Usage:
 *   node scripts/residency-judge.js [result.json] [--from ISO] [--to ISO] [--slot 10m]
 */

const fs = require('fs');

function parseSlot(raw) {
  const m = /^(\d+)(s|m|h)$/.exec(String(raw || '10m'));
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return n * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

function parseArgs(argv) {
  const out = { file: null, from: null, to: null, slotMs: 600_000, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' || a === '--to') {
      const v = argv[++i];
      const t = Date.parse(v || '');
      if (!Number.isFinite(t)) out.errors.push(`${a} needs an ISO date (got ${v === undefined ? 'nothing' : JSON.stringify(v)})`);
      else out[a.slice(2)] = t;
    } else if (a === '--slot') {
      const v = argv[++i];
      const ms = parseSlot(v);
      if (ms === null) out.errors.push(`--slot needs <n>s|m|h (got ${JSON.stringify(v)})`);
      else out.slotMs = ms;
    } else if (!a.startsWith('--') && out.file === null) {
      out.file = a;
    } else {
      out.errors.push(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  return out;
}

/**
 * The read_residency payload from what a client saved: the tool's data
 * object, the { ok, data } result, or an MCP tools/call result whose first
 * text content is that JSON. Returns { entries, verification } or null.
 */
function extractPayload(input) {
  let v = input;
  for (let depth = 0; depth < 4 && v && typeof v === 'object'; depth++) {
    if (Array.isArray(v.entries)) return { entries: v.entries, verification: v.verification || null, serviceId: v.serviceId || null };
    if (v.result && typeof v.result === 'object') { v = v.result; continue; }
    if (v.data && typeof v.data === 'object') { v = v.data; continue; }
    if (Array.isArray(v.content) && v.content[0] && typeof v.content[0].text === 'string') {
      try { v = JSON.parse(v.content[0].text); } catch { return null; }
      continue;
    }
    if (v.structuredContent && typeof v.structuredContent === 'object') { v = v.structuredContent; continue; }
    break;
  }
  return null;
}

const iso = (ms) => new Date(ms).toISOString();

function sameProcess(a, b) {
  return !!a && !!b && a.alive === true && b.alive === true && a.pid !== null && a.pid === b.pid
    && a.startTicks !== null && a.startTicks === b.startTicks && a.bootId !== null && a.bootId === b.bootId;
}

/**
 * The judgement for [entries] (read_residency entries) in [from, to) with
 * [slotMs] slots. Pure; returns the report object (see formatReport).
 */
function judge(entries, { from, to, slotMs }) {
  const sorted = entries
    .filter((e) => e && typeof e.at === 'number' && Number.isFinite(e.at))
    .slice()
    .sort((a, b) => a.at - b.at || (a.seq || 0) - (b.seq || 0));
  const start = from ?? (sorted.length ? sorted[0].at : 0);
  const end = to ?? (sorted.length ? sorted[sorted.length - 1].at + 1 : start);
  const inWindow = sorted.filter((e) => e.at >= start && e.at < end);
  const slotCount = end > start ? Math.ceil((end - start) / slotMs) : 0;
  const covered = new Array(slotCount).fill(false);
  for (const e of inWindow) covered[Math.floor((e.at - start) / slotMs)] = true;

  const gaps = [];
  for (let i = 0; i < slotCount; i++) {
    if (covered[i]) continue;
    let j = i;
    while (j + 1 < slotCount && !covered[j + 1]) j++;
    const gapStart = start + i * slotMs;
    const gapEnd = Math.min(end, start + (j + 1) * slotMs);
    const before = [...sorted].reverse().find((e) => e.at < gapStart) || null;
    const after = sorted.find((e) => e.at >= gapEnd) || null;
    gaps.push({
      from: gapStart, to: gapEnd, slots: j - i + 1,
      before, after,
      continuous: sameProcess(before, after),
    });
    i = j;
  }

  const changes = [];
  for (let i = 1; i < inWindow.length; i++) {
    const a = inWindow[i - 1];
    const b = inWindow[i];
    const what = [];
    if (a.bootId !== b.bootId) what.push('bootId');
    if (a.pid !== b.pid) what.push('pid');
    if (a.startTicks !== b.startTicks) what.push('startTicks');
    if (what.length) changes.push({ at: b.at, seq: b.seq, what, reason: b.reason, from: { pid: a.pid, startTicks: a.startTicks }, to: { pid: b.pid, startTicks: b.startTicks } });
  }
  const notAlive = inWindow.filter((e) => e.alive !== true);
  const healthFailures = inWindow.filter((e) => e.health && e.health.ok === false);
  const coveredCount = covered.filter(Boolean).length;
  return { from: start, to: end, slotMs, samples: inWindow.length, slotCount, coveredCount, gaps, changes, notAlive, healthFailures };
}

function verdictOf(report, verification) {
  if (report.samples === 0) return 'VERDICT: NO DATA (no samples in the window)';
  const pct = report.slotCount ? ((100 * report.coveredCount) / report.slotCount).toFixed(1) : '0.0';
  const unexplained = report.gaps.filter((g) => !g.continuous).length;
  const restarts = report.changes.length;
  const chain = verification ? (verification.chainOk ? 'chain ok' : `chain BROKEN at seq ${verification.brokenAtSeq}`) : 'chain not reported';
  const resident = unexplained === 0 && restarts === 0 && report.notAlive.length === 0;
  const word = resident ? 'RESIDENT' : 'NOT PROVEN';
  return `VERDICT: ${word} — coverage ${report.coveredCount}/${report.slotCount} slots (${pct}%), `
    + `${report.gaps.length} gap(s) of which ${report.gaps.length - unexplained} process-continuous, `
    + `${restarts} process change(s), ${report.notAlive.length} not-alive sample(s), `
    + `${report.healthFailures.length} health failure(s), ${chain}`;
}

function formatReport(report, verification, serviceId) {
  const lines = [];
  const proc = (e) => (e ? `pid=${e.pid} startTicks=${e.startTicks} boot=${e.bootId ? e.bootId.slice(0, 8) : 'null'} alive=${e.alive} @${iso(e.at)}` : '(none)');
  lines.push(`service        ${serviceId || '?'}`);
  lines.push(`window         ${iso(report.from)} .. ${iso(report.to)}  slot ${report.slotMs / 60_000} min`);
  lines.push(`samples        ${report.samples}`);
  lines.push(`slots          ${report.coveredCount} covered / ${report.slotCount - report.coveredCount} missing / ${report.slotCount} total`);
  if (verification) {
    lines.push(`chain          ${verification.chainOk ? 'ok' : `broken at seq ${verification.brokenAtSeq}`} (lines ${verification.lines}, seq ${verification.firstSeq}..${verification.lastSeq}, unparsed ${verification.unparsed}); mac ${verification.mac || '?'}`);
  }
  lines.push('');
  lines.push(`gaps (${report.gaps.length})`);
  for (const g of report.gaps) {
    lines.push(`  ${iso(g.from)} .. ${iso(g.to)}  ${g.slots} slot(s)  ${g.continuous ? 'process continuous across gap' : 'NOT continuous'}`);
    lines.push(`    before ${proc(g.before)}`);
    lines.push(`    after  ${proc(g.after)}`);
  }
  lines.push('');
  lines.push(`pid / startTicks / bootId changes (${report.changes.length})`);
  for (const c of report.changes) {
    lines.push(`  ${iso(c.at)} seq ${c.seq} [${c.what.join(',')}] reason=${c.reason} pid ${c.from.pid}->${c.to.pid} startTicks ${c.from.startTicks}->${c.to.startTicks}`);
  }
  lines.push('');
  lines.push(`not alive (${report.notAlive.length})`);
  for (const e of report.notAlive.slice(0, 50)) lines.push(`  ${iso(e.at)} seq ${e.seq} reason=${e.reason} code=${e.code}`);
  lines.push('');
  lines.push(`health failures (${report.healthFailures.length})`);
  for (const e of report.healthFailures.slice(0, 50)) lines.push(`  ${iso(e.at)} seq ${e.seq} ms=${e.health.ms}`);
  lines.push('');
  lines.push(verdictOf(report, verification));
  return lines.join('\n');
}

function main(argv, readInput, write) {
  const args = parseArgs(argv);
  if (args.errors.length) {
    write(`${args.errors.join('\n')}\nVERDICT: ERROR (bad arguments)`);
    return 0;
  }
  let payload = null;
  try {
    payload = extractPayload(JSON.parse(readInput(args.file)));
  } catch (e) {
    write(`input not readable as JSON: ${e && e.message}\nVERDICT: ERROR (bad input)`);
    return 0;
  }
  if (!payload) {
    write('input is not a read_residency result (no entries array)\nVERDICT: ERROR (bad input)');
    return 0;
  }
  const report = judge(payload.entries, args);
  write(formatReport(report, payload.verification, payload.serviceId));
  return 0;
}

if (require.main === module) {
  const code = main(
    process.argv.slice(2),
    (file) => fs.readFileSync(file === null ? 0 : file, 'utf8'),
    (text) => process.stdout.write(`${text}\n`),
  );
  process.exitCode = code;
} else {
  module.exports = { parseArgs, parseSlot, extractPayload, judge, verdictOf, formatReport, main };
}
