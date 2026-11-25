#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Executor run recovery (S5, DEFERRED.md「executor の無記録死」).
//
// The PlanSpec executor (shelly-plan-executor.js) records every run in
// logs/<agentId>/plan-executor-audit.jsonl: `plan_start`, then `plan_finish`
// on every exit it can see (success, error, skipped, SIGTERM / STOP-ALL). A
// run killed outright (SIGKILL, Android LMK, a process-tree teardown, the host
// app dying, the native 30-minute timeout) can record nothing: it is left with
// `plan_start` and no end. A run whose worker died while the executor waits
// on nothing can also stay "running" with no end. This file is the outside
// observer that closes those runs. It never touches the executor's own lines:
// every line it writes is appended after them (append-only), with
// kind 'plan.recovery'.
//
// Native (RunRecovery.kt) calls it in three ways:
//   --op finalize   after every runPlanAgent executor process returned (exit
//                   0 included): closes this launch's run when it has no end
//                   with `plan_exit` (exit code / signal) + `plan_orphaned`,
//                   and adds `plan_exit` to a run another op already closed.
//   --op sweep      on every schedule reconcile (app start, boot, package
//                   replaced, hourly watchdog): first resumes (SIGCONT) any
//                   tier-1 freeze a dead watchdog left behind (a stale
//                   locks/freeze-<id>.<ms>.json, `plan_freeze_released`;
//                   kept for the next sweep when a SIGCONT fails or a pid's
//                   identity cannot be settled), records a kept exit
//                   (`plan_exit_observed`) of a run closed since as its
//                   `plan_exit`, then closes every agent's open runs whose
//                   executor is no longer alive with `plan_orphaned`.
//   --op hang-check while a run is live: tier 1 (no worker + no progress for
//                   10 min) answers `hung` and writes nothing; native then
//                   freezes the executor tree, re-checks the worker and the
//                   progress stream, and either kills the tree and closes the
//                   run (--op hang-abort: `plan_hung`) or resumes it and
//                   records why (--op hang-cancel: `plan_hung_cancelled`).
//                   Tier 2 (worker alive + no progress for 30 min) records
//                   `plan_hung_suspect` in the audit log only (no feedback
//                   line: the run is not closed).
// Each closed run gets one line in ~/.shelly/agents/recovery-feedback.jsonl
// (the bridge reads it for detection and reporting); its content is first
// recorded as a `recovery_feedback` audit line, and `recovery_feedback_shared`
// marks it once it is in the shared file. A closed run that was a scheduled
// occurrence, inside REFIRE_WINDOW_MS of its scheduled time, never itself a
// re-fire, of a registered article pipeline whose draft for that slot is
// verifiably absent, is re-fired at most once, in three recorded steps:
//   1. the close appends `plan_refire_pending` (the intent, with the feedback
//      line to be written) and hands the re-fire to native (stdout `refire`);
//   2. native dispatches it and reports the outcome (--op refire-result):
//      `plan_refire_failed` + refired=false when the dispatch failed,
//      `plan_refire_dispatched` (not yet "re-fired") when the service took it;
//   3. the re-fire's own launch record (written only when the re-fired run
//      passed every gate and starts) settles it: `plan_refire` + refired=true,
//      at that run's finalize or a sweep. An intent with no launch record
//      after REFIRE_PENDING_SETTLE_MS is settled refired=false by a sweep.
//      A settled run whose feedback line is missing (a death in between) gets
//      it from the next sweep.
// The feedback line of such a run is written at 2 or 3, so it never says
// "re-fired" for a dispatch that did not happen. The executor's own
// draft_exists guard checks the slot again when the re-fire runs.
//
// Everything here is best-effort: a missing or malformed file is "nothing to
// do", never an exception out of main(). Reads are bounded tails, except what
// has to be completed however late, which reads the agent's own audit whole
// (feedback contents and markers, kept exits to promote, settled re-fires
// missing their content) and the shared feedback file whole (a pending line
// must never be lost or doubled; a shared line is marked only once it reads
// back as JSON).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RECOVERY_SCRIPT_VERSION = 2;

const AUDIT_FILE_NAME = 'plan-executor-audit.jsonl';
const LAUNCH_FILE_NAME = 'run-launches.jsonl';
const LAUNCH_PREV_FILE_NAME = 'run-launches.prev.jsonl';
const PROGRESS_FILE_NAME = 'progress.jsonl';
const PROGRESS_PREV_FILE_NAME = 'progress.prev.jsonl';
const FEEDBACK_FILE_REL = '.shelly/agents/recovery-feedback.jsonl';
const ARTICLE_PIPELINES_REL = '.shelly/agents/article-pipelines.json';
const RECOVERY_LOCK_REL = '.shelly/agents/locks/run-recovery.lock';

const AUDIT_TAIL_BYTES = 512 * 1024;
const LAUNCH_TAIL_BYTES = 128 * 1024;
const PROGRESS_MAX_READ_BYTES = 640 * 1024;
const FEEDBACK_TAIL_BYTES = 512 * 1024;
const PLAN_MAX_BYTES = 1024 * 1024;
const PIPELINES_MAX_BYTES = 256 * 1024;

/**
 * A re-fire intent whose re-fired run has no launch record is settled
 * refired=false by a sweep only after this. Native writes that record only
 * once every gate and preparation step is behind the run, and the slowest of
 * those, the local-LLM preflight (AgentRuntime ensureLocalLlmServerBeforePlanExecutor),
 * may take its full 30-minute timeout: 40 minutes leaves 10 for the service
 * and the other gates. A launch record is the final fact either way: one seen
 * later still uses up the slot (alreadyRefired) and is recorded.
 */
const REFIRE_PENDING_SETTLE_MS = 40 * 60 * 1000;
/** Only runs started this recently are closed (older history is left alone). */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A sweep never closes a run younger than this (plan_start is written just before the executor takes its lock). */
const SWEEP_YOUNG_RUN_GRACE_MS = 2 * 60 * 1000;
/** S5-0 §1: a re-fire only within 2 hours of the scheduled start. */
const REFIRE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** S5-0 §2 tier 1: no worker process + no progress for 10 minutes -> hung (abort). */
const HANG_ABORT_NO_PROGRESS_MS = 10 * 60 * 1000;
/** S5-0 §2 tier 2: worker alive + no progress for 30 minutes -> hung-suspect (record only). */
const HANG_SUSPECT_NO_PROGRESS_MS = 30 * 60 * 1000;
/** The executor's PROGRESS_MAX_BYTES: past it the stream drops events, so silence proves nothing. */
const PROGRESS_STREAM_CAP_BYTES = 256 * 1024;
/** Events stop being written just under the cap (bytes + the next line): within this, count as capped. */
const PROGRESS_CAP_MARGIN_BYTES = 8 * 1024;
/** A launch record belongs to the plan_start that follows it within this. */
const LAUNCH_MATCH_MS = 5 * 60 * 1000;
/**
 * A tier-1 freeze marker (native RunRecovery writeFreezeMarker) older than
 * this was left by a watchdog that died mid-freeze: a sweep thaws it. A live
 * freeze lasts the re-check only (well under a second).
 */
const FREEZE_STALE_MS = 2 * 60 * 1000;
// One marker per freeze: `freeze-<agentId>.<freezeStartMs>.json` (a marker a
// failed thaw left must not be overwritten by the next freeze of the agent).
// The unstamped `freeze-<agentId>.json` of earlier builds is still read.
const FREEZE_MARKER_RE = /^freeze-([A-Za-z0-9_-]{1,128})(?:\.\d{1,16})?\.json$/;
const FREEZE_MARKER_MAX_BYTES = 64 * 1024;
const RECOVERY_LOCK_STALE_MS = 2 * 60 * 1000;
const RECOVERY_LOCK_WAIT_MS = 10 * 1000;

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID_RE = /^[A-Za-z0-9_.:#-]{1,200}$/;
const PIPELINE_ID_RE = /^[a-z0-9-]{1,32}$/;
const HEARTBEAT_KIND = 'heartbeat';
const WAITING_TAIL_RE = /^Waiting for\b/;

const REASON_ORPHANED = 'orphaned';
const REASON_HUNG = 'hung';
const REASON_HUNG_SUSPECT = 'hung-suspect';

const SIGNAL_NAMES = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
};

// ── small I/O helpers ───────────────────────────────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The last `maxBytes` of a regular file (not a link), from a whole line; '' on any error. */
function readTail(file, maxBytes) {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch (_) {
    return '';
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function fileSize(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st.size : -1;
  } catch (_) {
    return -1;
  }
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isPlainObject(v)) out.push(v);
    } catch (_) {}
  }
  return out;
}

function readJsonFile(file, maxBytes) {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return { value: null, text: '' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString('utf8');
    return { value: JSON.parse(text), text };
  } catch (_) {
    return { value: null, text: '' };
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * True unless the file behind `fd` is non-empty and its last byte is known
 * to be a newline: a fragment left by an earlier short write (whose closing
 * newline may have failed too) must not have the next line glued onto it.
 * Unknown (a read error) counts as "needs one": an extra newline is only an
 * empty line, which every reader skips.
 */
function needsLeadingNewline(fd) {
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return false;
    const last = Buffer.alloc(1);
    if (fs.readSync(fd, last, 0, 1, size - 1) !== 1) return true;
    return last[0] !== 10;
  } catch (_) {
    return true;
  }
}

/**
 * Append one JSON line (O_APPEND, never through a link) in one write. Throws
 * on failure: callers decide. When the file does not end with a newline (a
 * fragment of an earlier short write whose closing newline failed too), that
 * newline goes in the same single write, before the line, so the line is
 * never glued onto the fragment. A short write (fewer bytes than asked, e.g.
 * a full disk) is a failure too: the fragment is ended with a newline (best
 * effort; the next append adds it otherwise), and the caller records nothing
 * that depends on the line.
 */
function appendLine(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(
    file,
    fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    const buf = Buffer.from(`${needsLeadingNewline(fd) ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8');
    const n = fs.writeSync(fd, buf, 0, buf.length);
    if (n !== buf.length) {
      if (n > 0) {
        try { fs.writeSync(fd, '\n'); } catch (_) {}
      }
      const err = new Error(`short write: ${n} of ${buf.length} bytes`);
      err.code = 'ESHORTWRITE';
      throw err;
    }
  } finally {
    fs.closeSync(fd);
  }
}

const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * Calls fn(line) for every line of a regular file (not a link), from its
 * first byte to its end, in chunks (lines are split on the newline byte, so a
 * multi-byte character never straddles a chunk). fn returning true stops the
 * scan. Returns 'stopped' (fn returned true), 'done' (the whole file was
 * read), 'missing' (ENOENT), or null (any other error: unknown).
 */
function scanLines(file, fn) {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'missing' : null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = st.size;
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) return null;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        if (fn(data.toString('utf8', start, nl))) return 'stopped';
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    if (carry.length && fn(carry.toString('utf8'))) return 'stopped';
    return 'done';
  } catch (_) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function tsMs(entry) {
  if (!entry || typeof entry.ts !== 'string') return NaN;
  return Date.parse(entry.ts);
}

function isoOrNull(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function agentPaths(home, agentId) {
  const agentsDir = path.join(home, '.shelly', 'agents');
  const logDir = path.join(agentsDir, 'logs', agentId);
  return {
    home,
    agentsDir,
    logDir,
    auditFile: path.join(logDir, AUDIT_FILE_NAME),
    launchFile: path.join(logDir, LAUNCH_FILE_NAME),
    launchPrevFile: path.join(logDir, LAUNCH_PREV_FILE_NAME),
    progressFile: path.join(logDir, PROGRESS_FILE_NAME),
    progressPrevFile: path.join(logDir, PROGRESS_PREV_FILE_NAME),
    planFile: path.join(agentsDir, 'plans', `plan-agent-${agentId}.json`),
    lockFile: path.join(agentsDir, 'locks', `${agentId}.pid`),
    haltSentinel: path.join(agentsDir, '.halted'),
    feedbackFile: path.join(home, ...FEEDBACK_FILE_REL.split('/')),
  };
}

// ── runs in the audit stream ────────────────────────────────────────────────

const RECOVERY_CLOSE_EVENTS = new Set(['plan_orphaned', 'plan_hung']);

/**
 * Pairs the audit lines into runs. A `plan_finish` ends the most recent run
 * without one (a run refused at the lock writes its start and finish back to
 * back, inside a live run). A recovery close names its run by `runStartTs`.
 * Other lines belong to the most recent run still open. Pure.
 */
function pairRuns(events) {
  const runs = [];
  for (const e of events) {
    const ms = tsMs(e);
    if (e.event === 'plan_start' && e.kind === 'plan.executor') {
      if (!Number.isFinite(ms)) continue;
      runs.push({ start: e, startTs: e.ts, startMs: ms, finish: null, recoveryClose: null, suspect: null, exit: null, refirePending: null, refireResult: null, events: [] });
      continue;
    }
    if (e.event === 'plan_finish' && e.kind === 'plan.executor') {
      for (let i = runs.length - 1; i >= 0; i -= 1) {
        if (!runs[i].finish) {
          runs[i].finish = e;
          break;
        }
      }
      continue;
    }
    if (e.kind === 'plan.recovery') {
      const run = typeof e.runStartTs === 'string' ? runs.find((r) => r.startTs === e.runStartTs) : null;
      if (!run) continue;
      if (RECOVERY_CLOSE_EVENTS.has(e.event)) run.recoveryClose = e;
      else if (e.event === 'plan_hung_suspect') run.suspect = e;
      else if (e.event === 'plan_exit') run.exit = e;
      else if (e.event === 'plan_exit_observed' && !run.exitObserved) run.exitObserved = e;
      else if (e.event === 'plan_exit_attribution_conflict') {
        run.attributionConflict = e;
        run.disputed = true;
        const inferred = typeof e.inferredRunStartTs === 'string' ? runs.find((r) => r.startTs === e.inferredRunStartTs) : null;
        if (inferred) inferred.disputed = true;
      }
      else if (e.event === 'plan_refire_pending' && !run.refirePending) run.refirePending = e;
      else if ((e.event === 'plan_refire' || e.event === 'plan_refire_failed') && !run.refireResult) run.refireResult = e;
      else if (e.event === 'plan_refire_dispatched' && !run.refireDispatched) run.refireDispatched = e;
      else if (e.event === 'plan_refire_late_start' && !run.refireLate) run.refireLate = e;
      else if (e.event === 'plan_refire_requested' && !run.refireRequested) run.refireRequested = e;
      else if (e.event === 'plan_refire_request_expired' && !run.refireRequestClosed) run.refireRequestClosed = e;
      continue;
    }
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (!runs[i].finish && !runs[i].recoveryClose) {
        runs[i].events.push(e);
        break;
      }
    }
  }
  for (let i = 0; i < runs.length; i += 1) runs[i].nextStartMs = i + 1 < runs.length ? runs[i + 1].startMs : Infinity;
  return runs;
}

function isOpenRun(run) {
  return !run.finish && !run.recoveryClose;
}

function readAuditRuns(paths) {
  return pairRuns(parseJsonl(readTail(paths.auditFile, AUDIT_TAIL_BYTES)));
}

/** The executor lines a close reads from its run: the last step (lastStepFromAudit), the saved draft (deliveryFor). */
// article_held: the v68 held landing, read by an MCP re-fire request (refireRequestDecision).
const CLOSE_RUN_EVENTS = ['cli_branch_start', 'cli_slot_wait', 'draft_saved', 'draft_exists', 'article_held'];
const CLOSE_RUN_EVENT_MARKS = CLOSE_RUN_EVENTS.map((name) => `"${name}"`);

/**
 * The runs of this agent's WHOLE audit, from its first byte (no tail window):
 * for what has to be completed however much the executor wrote since — a
 * retained exit to promote, a settled re-fire whose feedback content is
 * missing, the runs a reconcile closes. Only the lines that make runs and
 * their recovery records are parsed (plan_start, plan_finish, plan.recovery),
 * so by default `events` of a run is left empty. The cost
 * is acceptable: the file is this one agent's audit, the scan is one
 * streaming pass, and it runs on a reconcile (a finalize after a launch, or
 * the hourly sweep). Returns {ok, runs}; ok is false when the audit could not
 * be read (runs then empty: unknown, nothing is completed from it).
 *
 * withEvents: also keep, in each run's `events`, the executor lines a close
 * reads from its run (CLOSE_RUN_EVENTS: the last step, the saved draft). A
 * reconcile takes its ONE snapshot this way, so the promotion of a retained
 * exit and the choice of runs to close see the same run objects: a plan_finish
 * the executor appends during the reconcile is either in the snapshot (the run
 * is closed for both) or not (open for both), never closed for one and open
 * for the other (a second plan_exit and a false plan_orphaned).
 */
function readAllAuditRuns(paths, opts) {
  const withEvents = !!(opts && opts.withEvents);
  const events = [];
  const res = scanLines(paths.auditFile, (line) => {
    if (!line.includes('"plan_start"') && !line.includes('"plan_finish"') && !line.includes('"plan.recovery"') &&
        !(withEvents && CLOSE_RUN_EVENT_MARKS.some((m) => line.includes(m)))) return false;
    try {
      const v = JSON.parse(line);
      if (!isPlainObject(v)) return false;
      if (v.kind === 'plan.recovery' || (v.kind === 'plan.executor' &&
          (!withEvents || v.event === 'plan_start' || v.event === 'plan_finish' || CLOSE_RUN_EVENTS.includes(v.event)))) {
        events.push(v);
      }
    } catch (_) {}
    return false;
  });
  if (res !== 'done' && res !== 'missing') return { ok: false, runs: [] };
  const runs = pairRuns(events);
  return { ok: true, runs: withEvents ? runs : runs.map((r) => Object.assign(r, { events: [] })) };
}

// ── launch records (written by native right before the executor starts) ────

/** A launch record line, validated, or null. */
function cleanLaunch(raw, agentId) {
  if (!isPlainObject(raw) || raw.v !== 1 || raw.agentId !== agentId || raw.event !== undefined) return null;
  if (typeof raw.launchId !== 'string' || !RUN_ID_RE.test(raw.launchId)) return null;
  if (!Number.isSafeInteger(raw.startedAt) || raw.startedAt <= 0) return null;
  const scheduledAt = Number.isSafeInteger(raw.scheduledAt) && raw.scheduledAt > 0 ? raw.scheduledAt : null;
  const refireOf = typeof raw.refireOf === 'string' && RUN_ID_RE.test(raw.refireOf) ? raw.refireOf : null;
  const origin = typeof raw.origin === 'string' ? raw.origin.slice(0, 32) : '';
  return { launchId: raw.launchId, startedAt: raw.startedAt, scheduledAt, refireOf, origin, unattended: raw.unattended === true };
}

/** A launch end record (native, after the executor process returned): {launchId, endedAt}, or null. */
function cleanLaunchEnd(raw, agentId) {
  if (!isPlainObject(raw) || raw.v !== 1 || raw.agentId !== agentId || raw.event !== 'end') return null;
  if (typeof raw.launchId !== 'string' || !RUN_ID_RE.test(raw.launchId)) return null;
  if (!Number.isSafeInteger(raw.endedAt) || raw.endedAt <= 0) return null;
  return { launchId: raw.launchId, endedAt: raw.endedAt };
}

/**
 * The launches of this agent, each with `endedAt` (ms) when native recorded
 * the end of its executor process, else null (still running, or native died
 * with it). A launch id seen twice is dropped entirely (it cannot be told apart).
 */
function readLaunches(paths, agentId) {
  const lines = [
    ...parseJsonl(readTail(paths.launchPrevFile, LAUNCH_TAIL_BYTES)),
    ...parseJsonl(readTail(paths.launchFile, LAUNCH_TAIL_BYTES)),
  ];
  const starts = [];
  const seen = new Map();
  const ends = new Map();
  for (const line of lines) {
    const start = cleanLaunch(line, agentId);
    if (start) {
      seen.set(start.launchId, (seen.get(start.launchId) || 0) + 1);
      starts.push(start);
      continue;
    }
    const end = cleanLaunchEnd(line, agentId);
    if (end && !ends.has(end.launchId)) ends.set(end.launchId, end.endedAt);
  }
  return starts
    .filter((l) => seen.get(l.launchId) === 1)
    .map((l) => Object.assign({}, l, { endedAt: ends.has(l.launchId) ? ends.get(l.launchId) : null }));
}

/**
 * Every launch start record of this agent, duplicates included (for counting
 * re-fires: a duplicated id is no reason to forget that a re-fire started).
 */
function readLaunchStarts(paths, agentId) {
  return parseJsonl(readTail(paths.launchPrevFile, LAUNCH_TAIL_BYTES))
    .concat(parseJsonl(readTail(paths.launchFile, LAUNCH_TAIL_BYTES)))
    .map((l) => cleanLaunch(l, agentId))
    .filter(Boolean);
}

/** The launch record of the re-fire an intent decided (its id, or naming the intent's run as refireOf), or null. Pure. */
function refireLaunchOf(launchStarts, pending) {
  if (!pending) return null;
  return (launchStarts || []).find((l) => l.launchId === pending.refireRunId ||
    (l.refireOf !== null && l.refireOf === pending.runId)) || null;
}

/**
 * Ties runs (plan_start lines) to the launches they came from, one to one,
 * or not at all. Returns a Map run -> launch. Pure.
 *
 * The facts this rests on: native writes a launch's record before it starts
 * the executor process (startedAt <= that process's plan_start, same clock)
 * and its end record after the process returned (endedAt >= plan_start); one
 * executor process writes at most one plan_start. So a launch L is a candidate
 * for run R only when L.startedAt <= R.start <= L.endedAt (an open end when
 * native recorded none) and L started at most LAUNCH_MATCH_MS before, AND
 * the run agrees with the launch on the one launch fact the executor itself
 * records: `unattended` (native passes --unattended exactly when the launch
 * record says unattended; plan_start writes it back). So an attended Run now
 * is never tied to a scheduled (unattended) launch, nor a scheduled run to a
 * Run now. The run side records no scheduledAt or launch id (the executor is
 * unchanged), so two unattended launches overlapping in time can still only
 * be told apart by the rules below. Time
 * alone is never enough: candidates are resolved by elimination — a run with
 * exactly one candidate takes it, and that launch stops being a candidate for
 * every other run (a lock refusal nested in a live run resolves this way) —
 * and a launch that is the only candidate of two runs goes to neither. A run
 * left with zero or several candidates has no launch: it gets no slot, no
 * re-fire lineage, and is never re-fired.
 *
 * Only a schedule-type launch can lend its identity (isScheduleLaunch: its
 * record has scheduledAt or refireOf). The executor serializes the runs of
 * one agent (its run lock), so two schedule-type launches of one agent never
 * overlap in time; a widget tap, a Run now or any other ad-hoc launch can.
 * Such a launch is tied to no run, ever, and a run any ad-hoc launch could
 * have started is tied to nothing either: a run is tied only when its
 * candidates are schedule-type launches and the elimination among those
 * leaves it exactly one. An ad-hoc launch is never eliminated (it explains
 * no run), so an unattended widget run whose other candidate is a dead
 * scheduled launch stays unmatched however many other runs the widget launch
 * could also have started; it is identified by its progress runId and never
 * re-fired.
 */
function launchCouldStartRun(l, r) {
  return l.startedAt <= r.startMs && r.startMs - l.startedAt <= LAUNCH_MATCH_MS &&
    (l.endedAt === null || l.endedAt >= r.startMs) &&
    (l.unattended === true) === (!!r.start && r.start.unattended === true);
}

/** A launch that may lend its identity to a run: a scheduled occurrence or a re-fire. Pure. */
function isScheduleLaunch(l) {
  return (Number.isSafeInteger(l.scheduledAt) && l.scheduledAt > 0) ||
    (typeof l.refireOf === 'string' && l.refireOf !== '');
}

function matchLaunches(runs, launches) {
  const cands = new Map();
  for (const r of runs) {
    const list = launches.filter((l) => launchCouldStartRun(l, r));
    // A run an ad-hoc launch could have started is never tied (it may be that
    // launch's run), and it takes no part in the elimination: an ad-hoc launch
    // explains nothing, so it is never eliminated and never makes another
    // candidate "the only one left".
    if (list.some((l) => !isScheduleLaunch(l))) continue;
    cands.set(r, list);
  }
  const out = new Map();
  const settled = new Set();
  const dead = new Set();
  for (let changed = true; changed;) {
    changed = false;
    const soleOf = new Map();
    for (const [r, list] of cands) {
      if (settled.has(r)) continue;
      const live = list.filter((l) => !dead.has(l));
      if (live.length === 1) soleOf.set(live[0], [...(soleOf.get(live[0]) || []), r]);
    }
    for (const [l, rs] of soleOf) {
      dead.add(l);
      changed = true;
      if (rs.length === 1) {
        settled.add(rs[0]);
        out.set(rs[0], l);
      }
    }
  }
  // A run whose tie native's declaration contradicted (ownRunOf,
  // plan_exit_attribution_conflict) lends no launch identity.
  for (const r of runs) if (r.disputed) out.delete(r);
  return out;
}

/** The launch run `run` came from (see matchLaunches), or null. */
function launchForRun(launchMatch, run) {
  return (launchMatch && launchMatch.get(run)) || null;
}

// ── progress stream (the executor's logs/<id>/progress.jsonl) ───────────────

/**
 * The progress events of the run that started at `run.startMs` (from
 * progress.jsonl or the rotated progress.prev.jsonl), or null. `capped` is
 * true when the file is at the executor's byte cap (events may be dropped).
 */
function progressForRun(paths, run) {
  for (const file of [paths.progressFile, paths.progressPrevFile]) {
    const size = fileSize(file);
    if (size <= 0) continue;
    const events = parseJsonl(readTail(file, PROGRESS_MAX_READ_BYTES));
    const startIdx = events.findIndex((e) => e.kind === 'run_start');
    if (startIdx === -1) continue;
    const startEv = events[startIdx];
    const ms = tsMs(startEv);
    if (!Number.isFinite(ms)) continue;
    // run_start is written after plan_start by the same process: never before it.
    if (ms < run.startMs || ms >= run.nextStartMs) continue;
    const runId = typeof startEv.runId === 'string' && RUN_ID_RE.test(startEv.runId) ? startEv.runId : null;
    const own = events.slice(startIdx).filter((e) => !runId || e.runId === runId);
    return { runId, events: own, capped: size >= PROGRESS_STREAM_CAP_BYTES - PROGRESS_CAP_MARGIN_BYTES, file };
  }
  return null;
}

/** {index, startedAtMs} of the last step the run reached, from progress events, or null. Pure. */
function lastStepFromProgress(events) {
  let last = null;
  const firstRunning = new Map();
  for (const e of events || []) {
    if (e.kind !== 'branch_state') continue;
    if (!Number.isInteger(e.stepIndex) || e.stepIndex < 0) continue;
    if (e.state === 'STANDBY') continue;
    const ms = tsMs(e);
    if ((e.state === 'RUNNING' || e.state === 'WAITING_APPROVAL') && !firstRunning.has(e.stepIndex) && Number.isFinite(ms)) {
      firstRunning.set(e.stepIndex, ms);
    }
    if (e.state === 'RUNNING' || e.state === 'WAITING_APPROVAL') last = e.stepIndex;
  }
  if (last === null) {
    // Only settled states (a step that went straight to DONE/FAILED): the highest settled index.
    for (const e of events || []) {
      if (e.kind === 'branch_state' && Number.isInteger(e.stepIndex) && e.state !== 'STANDBY' && (last === null || e.stepIndex > last)) last = e.stepIndex;
    }
    if (last === null) return null;
  }
  return { index: last, startedAtMs: firstRunning.has(last) ? firstRunning.get(last) : NaN };
}

/** Fallback: the last step a CLI branch started in, from the run's own audit lines. Pure. */
function lastStepFromAudit(events) {
  let found = null;
  for (const e of events || []) {
    if ((e.event === 'cli_branch_start' || e.event === 'cli_slot_wait') && Number.isInteger(e.stepIndex) && e.stepIndex >= 0) {
      const ms = tsMs(e);
      if (!found || found.index !== e.stepIndex) found = { index: e.stepIndex, startedAtMs: ms };
    }
  }
  return found;
}

/** Time (ms) of the last progress event that is real progress (not a heartbeat), or NaN. Pure. */
function lastProgressMs(events) {
  let best = NaN;
  for (const e of events || []) {
    if (e.kind === HEARTBEAT_KIND) continue;
    const ms = tsMs(e);
    if (Number.isFinite(ms) && !(ms <= best)) best = ms;
  }
  return best;
}

const SETTLED_STATES = new Set(['DONE', 'FAILED', 'SKIPPED']);
const CLI_SLOT_EVENTS = new Set(['cli_slot_wait', 'cli_slot_acquired', 'cli_branch_start']);

/**
 * True when ANY unsettled step of the run is deliberately waiting (parallel
 * branches: one branch may wait while another settles):
 *   - its latest state is WAITING_APPROVAL (an action approval), or
 *   - its latest CLI slot audit line (cli_slot_wait / cli_slot_acquired /
 *     cli_branch_start) is cli_slot_wait (a CLI slot or text-only engine lock
 *     held by another agent), or, when the run's audit has no slot lines for
 *     the step, its latest real progress event is a "Waiting for ..." tail.
 * Those waits have no worker child and no progress; the executor bounds them
 * itself. Pure.
 */
function isDeliberateWait(events, auditEvents) {
  const state = new Map();
  const lastIsWaitTail = new Map();
  for (const e of events || []) {
    if (e.kind === HEARTBEAT_KIND || !Number.isInteger(e.stepIndex)) continue;
    if (e.kind === 'branch_state') {
      state.set(e.stepIndex, e.state);
      lastIsWaitTail.set(e.stepIndex, false);
    } else if (e.kind === 'tail') {
      lastIsWaitTail.set(e.stepIndex, typeof e.tail === 'string' && WAITING_TAIL_RE.test(e.tail));
    } else {
      lastIsWaitTail.set(e.stepIndex, false);
    }
  }
  const slot = new Map();
  for (const e of auditEvents || []) {
    if (CLI_SLOT_EVENTS.has(e.event) && Number.isInteger(e.stepIndex)) slot.set(e.stepIndex, e.event);
  }
  const steps = new Set([...state.keys(), ...lastIsWaitTail.keys(), ...slot.keys()]);
  for (const i of steps) {
    if (SETTLED_STATES.has(state.get(i))) continue;
    if (state.get(i) === 'WAITING_APPROVAL') return true;
    if (slot.has(i)) {
      if (slot.get(i) === 'cli_slot_wait') return true;
    } else if (lastIsWaitTail.get(i)) {
      return true;
    }
  }
  return false;
}

// ── the plan (for the step kind, the pipeline and the draft slot) ───────────

function readPlan(paths) {
  const { value, text } = readJsonFile(paths.planFile, PLAN_MAX_BYTES);
  if (!isPlainObject(value)) return { plan: null, planId: null };
  const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const agentId = isPlainObject(value.agent) && typeof value.agent.id === 'string' ? value.agent.id : '';
  return { plan: value, planId: `plan-agent-${agentId}@${sha}` };
}

function planSteps(plan) {
  return plan && isPlainObject(plan.steps) && Array.isArray(plan.steps.list) ? plan.steps.list : null;
}

function isLongformPlan(plan) {
  return !!plan && isPlainObject(plan.steps) && plan.steps.longform === true && Array.isArray(plan.steps.list);
}

/** shelly-plan-executor.js isDigestPlan. */
function isDigestPlan(plan) {
  return isLongformPlan(plan) && plan.steps.list.some((s) => isPlainObject(s) && isPlainObject(s.local) && s.local.kind === 'list-drafts');
}

/** A short name for step `index` of the plan ('research', 'write', 'review', 'assemble', 'cli', …). Pure. */
function stepKind(plan, index) {
  const list = planSteps(plan);
  if (!list) return plan ? 'model' : 'unknown';
  const step = list[index];
  if (!isPlainObject(step)) return 'unknown';
  if (isPlainObject(step.handoff) && typeof step.handoff.kind === 'string') return step.handoff.kind.slice(0, 40);
  if (isPlainObject(step.local) && typeof step.local.kind === 'string') return step.local.kind.slice(0, 40);
  if (step.apiCall) return 'api-call';
  if (isLongformPlan(plan)) {
    const plain = [];
    list.forEach((s, i) => {
      if (isPlainObject(s) && s.local === undefined && !s.apiCall && s.handoff === undefined) plain.push(i);
    });
    if (plain[0] === index) return 'research';
    if (plain[1] === index) return 'write';
  }
  if (isPlainObject(step.tool) && step.tool.type === 'cli') return `cli:${String(step.tool.cli || '').slice(0, 20)}`;
  return 'model';
}

/** shelly-plan-executor.js articleFolderKey. */
function articleFolderKey(folder) {
  const raw = typeof folder === 'string' ? folder : '';
  if (!raw.startsWith('/')) return '';
  return path.posix.resolve(raw).replace(/^\/storage\/(?:emulated\/0|self\/primary)(?=\/|$)/, '/sdcard');
}

/**
 * The article pipeline id of a long-form (non-digest) plan: the one entry of
 * article-pipelines.json on the plan's output folder (the executor's
 * articlePipelineEntryFor), or null.
 */
function pipelineIdFor(home, plan) {
  if (!isLongformPlan(plan) || isDigestPlan(plan)) return null;
  const want = articleFolderKey(plan.output && plan.output.outputDir);
  if (!want || want === '/') return null;
  const { value } = readJsonFile(path.join(home, ...ARTICLE_PIPELINES_REL.split('/')), PIPELINES_MAX_BYTES);
  if (!isPlainObject(value) || !Array.isArray(value.pipelines)) return null;
  const matches = value.pipelines.filter((p) => isPlainObject(p) && articleFolderKey(p.outputFolder) === want);
  if (matches.length !== 1) return null;
  return typeof matches[0].id === 'string' && PIPELINE_ID_RE.test(matches[0].id) ? matches[0].id : null;
}

// ── delivery (the executor's draft_exists guard, for the run's slot) ────────

/**
 * The local dates (one Date per calendar day) the run could have written its
 * draft on: every day from its plan_start to now. Pure.
 */
function writeDays(startMs, nowMs) {
  const out = [];
  const seen = new Set();
  const end = Math.max(startMs, nowMs);
  for (let t = startMs; ; t = Math.min(end, t + 60 * 60 * 1000)) {
    const key = localDate(t);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(new Date(t));
    }
    if (t >= end) break;
  }
  return out;
}

/**
 * What the run left and whether its slot is delivered.
 *   artifacts: {draft, paths}
 *   delivery:  {delivered, channel}
 *   verified:  true only when the slot could be checked the way the executor
 *              checks it, and every check gave a definite answer. A re-fire
 *              needs verified && !delivered.
 *
 * The executor names the draft with resolveDraftDestination at WRITE time
 * (writeDraftOutputs, new Date()), and its own draft_exists guard resolves it
 * at the re-fire's start. So the destination is resolved here with the same
 * function for every local day the write could have happened on (plan_start
 * .. now), never with the scheduled time. A name that depends on the clock
 * time (`{time}` in the template AFTER the executor's sanitizing, found by
 * resolving it at two times of one day) cannot be found again: unverified.
 * Only ENOENT proves absence; any other error is unverified (fail closed).
 */
function deliveryFor(paths, plan, run, nowMs, executorSource, inputsAsOfMs) {
  // draft_saved: written by this run. draft_exists: the executor found the slot's draft already there.
  const savedEvents = run.events.filter((e) => e.event === 'draft_saved' || e.event === 'draft_exists');
  const savedPaths = savedEvents
    .map((e) => (typeof e.folder === 'string' && typeof e.file === 'string' ? `${e.folder}/${e.file}` : null))
    .filter(Boolean);
  const actionType = plan && isPlainObject(plan.action) && typeof plan.action.type === 'string' ? plan.action.type.slice(0, 40) : 'unknown';
  const out = {
    artifacts: { draft: savedEvents.length > 0, paths: savedPaths.slice(0, 5) },
    delivery: { delivered: savedEvents.length > 0, channel: actionType },
    verified: false,
  };
  if (!isLongformPlan(plan) || isDigestPlan(plan) || actionType !== 'draft') return out;
  // Loaded only here (a long-form draft run to check): the executor is large.
  const executorModule = typeof executorSource === 'function' ? executorSource() : executorSource;
  if (!executorModule || typeof executorModule.resolveDraftDestination !== 'function' ||
      typeof executorModule.runtimePaths !== 'function' || typeof executorModule.parseConfigEnv !== 'function') return out;
  out.delivery.channel = 'draft';
  try {
    const agentId = plan.agent.id;
    const execPaths = executorModule.runtimePaths(paths.home, agentId);
    // The run named its draft from the plan and .env as they were when its
    // process read them, which is before plan_start: `inputsAsOfMs` is the
    // launch's start (taken before the executor process existed). A plan or
    // .env changed since then may name a different path; parseConfigEnv
    // reads a missing or unreadable .env as empty (the default path). Each
    // leaves the slot unverified. The .env matters only for a plan that uses
    // the global output (resolveDraftDestination reads config only there).
    const inputsWhy = draftInputsChangedOrUnreadable(paths.planFile, execPaths.envFile, inputsAsOfMs,
      !!(plan.output && plan.output.useGlobalOutput));
    if (inputsWhy) {
      out.unverifiedWhy = inputsWhy;
      return out;
    }
    const config = executorModule.parseConfigEnv(execPaths.envFile);
    // A name that depends on the clock time cannot be found again. Decided on
    // the name the executor itself resolves (its own sanitizing included: a
    // raw template like `{ti!me}` sanitizes to `{time}`), never on the raw
    // template: two times of one local day must name the same file.
    if (nameDependsOnTime(executorModule, execPaths, plan, config, run.startMs)) {
      out.unverifiedWhy = 'time-template';
      return out;
    }
    let definite = true;
    for (const day of writeDays(run.startMs, nowMs)) {
      const dest = executorModule.resolveDraftDestination(execPaths, plan, config, day).dest;
      let st = null;
      try {
        st = fs.lstatSync(dest);
      } catch (e) {
        if (!e || e.code !== 'ENOENT') definite = false;
        continue;
      }
      // The executor's rule: an empty file is a crashed write, not a draft.
      if (st.size > 0) {
        out.artifacts.draft = true;
        if (!out.artifacts.paths.includes(dest)) out.artifacts.paths.unshift(dest);
        out.delivery.delivered = true;
      }
    }
    out.verified = definite;
    if (!definite) out.unverifiedWhy = 'stat-error';
  } catch (_) {
    out.verified = false;
    out.unverifiedWhy = 'resolve-error';
  }
  return out;
}

/**
 * True when the executor's own resolveDraftDestination names a different file
 * at two clock times of the same local day (the template, as the executor
 * sanitizes it, holds `{time}`). The executor's function is the only judge:
 * no template is parsed here. Throws when it throws (the caller: unverified).
 */
function nameDependsOnTime(executorModule, execPaths, plan, config, dayMs) {
  const d = new Date(dayMs);
  const at = (h, m, s) => executorModule.resolveDraftDestination(execPaths, plan, config,
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s)).dest;
  const first = at(0, 0, 0);
  return at(12, 34, 56) !== first || at(23, 59, 59) !== first;
}

/**
 * 'plan-changed' | 'config-missing' | 'config-changed' | 'config-unreadable'
 * | '' (plan, and .env when it is used, unchanged since asOfMs and readable).
 * A missing .env is not proof of the run's config (it may have been deleted
 * after the run read it), so a run that used it is unverified. Pure but for stat.
 */
function draftInputsChangedOrUnreadable(planFile, envFile, asOfMs, usesConfig) {
  if (!Number.isFinite(asOfMs)) return 'plan-changed';
  let planSt;
  try {
    planSt = fs.statSync(planFile);
  } catch (_) {
    return 'plan-changed';
  }
  if (!(planSt.mtimeMs < asOfMs)) return 'plan-changed';
  if (!usesConfig) return '';
  let envSt;
  try {
    envSt = fs.statSync(envFile);
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'config-missing' : 'config-unreadable';
  }
  if (!(envSt.mtimeMs < asOfMs)) return 'config-changed';
  try {
    fs.readFileSync(envFile, 'utf8');
  } catch (_) {
    return 'config-unreadable';
  }
  return '';
}

function loadExecutorModule(file) {
  if (!file) return null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(file);
  } catch (_) {
    return null;
  }
}

// ── feedback ────────────────────────────────────────────────────────────────

function readFeedback(paths) {
  return parseJsonl(readTail(paths.feedbackFile, FEEDBACK_TAIL_BYTES));
}

/**
 * True when this run or this agent's slot already used its re-fire. A launch
 * record of a re-fire is the final fact: one naming this run (refireOf) or
 * this slot (a re-fire launch carries the slot's scheduledAt) counts, whatever
 * the audit says about it (a dispatch settled as failed may still start
 * later). Besides that: a feedback line with refired=true, or an intent in
 * the audit that is still pending or was confirmed (a failed one does not
 * count, unless its re-fire's launch record appeared). Pure.
 */
function alreadyRefired(feedbackLines, agentId, runId, scheduledAtIso, auditRuns, launchStarts) {
  const slotMs = scheduledAtIso ? Date.parse(scheduledAtIso) : NaN;
  const launched = (launchStarts || []).some((l) => l.refireOf !== null &&
    (l.refireOf === runId || (Number.isFinite(slotMs) && l.scheduledAt === slotMs)));
  if (launched) return true;
  const inFeedback = feedbackLines.some((f) => isPlainObject(f) && isPlainObject(f.refire) && f.refire.refired === true &&
    (f.runId === runId || (f.agentId === agentId && scheduledAtIso && f.scheduledAt === scheduledAtIso)));
  if (inFeedback) return true;
  return (auditRuns || []).some((r) => r.refirePending &&
    (!r.refireResult || r.refireResult.event === 'plan_refire' || !!refireLaunchOf(launchStarts, r.refirePending)) &&
    (r.refirePending.runId === runId || (scheduledAtIso && r.refirePending.scheduledAt === scheduledAtIso)));
}

/** True when a feedback line for this run and reason is already there (idempotent close). Pure. */
function feedbackExists(feedbackLines, runId, reason) {
  return feedbackLines.some((f) => isPlainObject(f) && f.runId === runId && f.reason === reason);
}

/**
 * The re-fire decision for a closed run (S5-0 §1). Pure.
 * Returns {eligible, why} — `why` names the first condition that failed.
 */
function refireDecision(input) {
  const { reason, launch, nowMs, plan, delivery, halted, feedbackLines, runId, agentId } = input;
  if (reason !== REASON_ORPHANED && reason !== REASON_HUNG) return { eligible: false, why: 'reason' };
  if (!launch || !launch.scheduledAt) return { eligible: false, why: 'adhoc' };
  // Defense in depth: the launch record is a same-uid file; a scheduled run is
  // also an unattended 'schedule' launch whose plan_start says unattended.
  if (launch.origin !== 'schedule' || launch.unattended !== true || input.startUnattended !== true) return { eligible: false, why: 'adhoc' };
  if (launch.refireOf) return { eligible: false, why: 'already-a-refire' };
  const age = nowMs - launch.scheduledAt;
  if (!(age >= 0 && age <= REFIRE_WINDOW_MS)) return { eligible: false, why: 'window' };
  // The re-fire names its draft with the current local date: past midnight it
  // would take the next day's slot.
  if (localDate(nowMs) !== localDate(launch.scheduledAt)) return { eligible: false, why: 'window' };
  if (!isLongformPlan(plan) || isDigestPlan(plan)) return { eligible: false, why: 'not-a-draft-pipeline' };
  // Only a registered article pipeline (one entry of article-pipelines.json on
  // this plan's folder): anything else cannot be checked the way the bridge reads it.
  if (!input.pipelineId) return { eligible: false, why: 'no-pipeline' };
  if (!delivery.verified) return { eligible: false, why: 'delivery-unverified' };
  if (delivery.delivery.delivered || delivery.artifacts.draft) return { eligible: false, why: 'delivered' };
  if (halted) return { eligible: false, why: 'halted' };
  if (alreadyRefired(feedbackLines, agentId, runId, isoOrNull(launch.scheduledAt), input.auditRuns, input.launchStarts)) return { eligible: false, why: 'already-refired' };
  return { eligible: true, why: '' };
}

function localDate(ms) {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
}

function newRefireRunId(agentId, nowMs) {
  return `${agentId}-${nowMs}-r${crypto.randomBytes(3).toString('hex')}`;
}

function signalOf(exitCode) {
  if (!Number.isInteger(exitCode) || exitCode <= 128 || exitCode > 128 + 64) return null;
  const n = exitCode - 128;
  return SIGNAL_NAMES[n] || `SIG${n}`;
}

// ── closing a run ───────────────────────────────────────────────────────────

/**
 * Closes one open run: the terminal audit lines, the feedback line, and the
 * re-fire decision. Returns {closed, refire|null}.
 *   ctx: {paths, agentId, nowMs, reason, detectedBy, exitCode, timedOut,
 *         noProgressMs, executorModule, feedbackLines}
 */
function closeRun(ctx, run, launchMatch, planInfo) {
  const { paths, agentId, nowMs, reason, detectedBy } = ctx;
  const plan = planInfo.plan;
  const launch = launchForRun(launchMatch, run);
  const progress = progressForRun(paths, run);
  // The run's id, in a fixed order:
  //  1. the native launch id, only when matchLaunches tied this run to exactly
  //     one launch. It is the id the re-fire chain uses (a re-fire's launch id
  //     is the refireRunId decided here, and its record names this id in
  //     refireOf), so the bridge can follow a slot across a re-fire.
  //  2. otherwise the executor's own progress runId (unique per executor
  //     process: agent, ms, pid, random), when progress.jsonl holds this run.
  //  3. otherwise a synthetic id from the plan_start time.
  // Never another launch's id: an unmatched run borrows nothing (no id, no
  // slot, no refireOf). When both exist and differ, the executor's id is kept
  // as executorRunId in the audit lines.
  const runId = launch ? launch.launchId : (progress && progress.runId) || `${agentId}-${run.startMs}-unrecorded`;
  const step = (progress && lastStepFromProgress(progress.events)) || lastStepFromAudit(run.events);
  const lastStep = step
    ? { index: step.index, kind: stepKind(plan, step.index), startedAt: isoOrNull(step.startedAtMs) }
    : null;
  // The plan and .env the run used are those of its launch's start (no
  // matched launch: LAUNCH_MATCH_MS before plan_start, the widest a launch can be).
  const inputsAsOfMs = launch ? launch.startedAt : run.startMs - LAUNCH_MATCH_MS;
  const delivery = deliveryFor(paths, plan, run, nowMs, ctx.executorModule, inputsAsOfMs);
  const halted = fs.existsSync(paths.haltSentinel);
  const pipelineId = pipelineIdFor(paths.home, plan);
  const decision = refireDecision({
    reason, launch, nowMs, plan, delivery, halted, feedbackLines: ctx.feedbackLines, runId, agentId,
    startUnattended: run.start.unattended === true, pipelineId, auditRuns: ctx.auditRuns,
    launchStarts: readLaunchStarts(paths, agentId),
  });
  const refireRunId = decision.eligible ? newRefireRunId(agentId, nowMs) : null;
  const terminatedAt = new Date(nowMs).toISOString();
  const common = {
    agentId,
    runId,
    runStartTs: run.startTs,
    ...(progress && progress.runId && progress.runId !== runId ? { executorRunId: progress.runId } : {}),
  };

  const audit = (entry) => {
    try {
      appendLine(paths.auditFile, Object.assign({ ts: new Date().toISOString(), kind: 'plan.recovery' }, entry));
    } catch (_) {}
  };

  // (1) the driver's terminal record: how the executor process ended — the
  // exit this finalize observed, or one an earlier finalize observed for this
  // (declared) run and kept as plan_exit_observed when it could not close it.
  const retained = run.exitObserved && Number.isInteger(run.exitObserved.exitCode) ? run.exitObserved : null;
  const observed = detectedBy === 'driver' && Number.isInteger(ctx.exitCode)
    ? { exitCode: ctx.exitCode, timedOut: ctx.timedOut === true }
    : retained ? { exitCode: retained.exitCode, timedOut: retained.timedOut === true, retainedFrom: retained.ts } : null;
  if (observed && !run.exit && reason !== REASON_HUNG_SUSPECT) {
    audit(Object.assign({ event: 'plan_exit' }, common, {
      exitCode: observed.exitCode,
      signal: signalOf(observed.exitCode),
      timedOut: observed.timedOut,
      detectedBy: 'driver',
      ...(observed.retainedFrom ? { retainedFrom: observed.retainedFrom } : {}),
    }));
  }
  // (2) the explicit close.
  if (reason === REASON_HUNG_SUSPECT) {
    audit(Object.assign({ event: 'plan_hung_suspect' }, common, { tier: 2, noProgressMs: ctx.noProgressMs, lastStep, detectedBy }));
    // Tier 2 never ends the run, so it writes no feedback line: the §3 line is
    // one per closed run, with a closed `reason` set and a real terminatedAt.
    // The audit line above is the §2 record; the run stays open for a later close.
    return { closed: { agentId, runId, reason, lastStep }, refire: null };
  } else {
    audit(Object.assign({ event: reason === REASON_HUNG ? 'plan_hung' : 'plan_orphaned' }, common, {
      reason,
      detectedBy,
      ...(reason === REASON_HUNG ? { tier: 1, noProgressMs: ctx.noProgressMs } : {}),
      ...(observed ? { exitCode: observed.exitCode, signal: signalOf(observed.exitCode) } : {}),
      lastStep,
    }));
  }
  // (3) the feedback line (S5-0 §3), once per run and reason.
  // Exactly the S5-0 §3 fields (no version or extra keys).
  const feedback = {
    runId,
    agentId,
    pipelineId,
    planId: planInfo.planId,
    scheduledAt: launch ? isoOrNull(launch.scheduledAt) : null,
    startedAt: isoOrNull(run.startMs),
    terminatedAt,
    reason,
    lastStep,
    artifacts: delivery.artifacts,
    delivery: delivery.delivery,
    refire: { eligible: decision.eligible, refired: false, refireRunId: null },
  };
  const extra = Object.assign({}, decision.eligible ? {} : { refireSkipped: decision.why },
    delivery.unverifiedWhy ? { deliveryUnverified: delivery.unverifiedWhy } : {});
  // (4) the re-fire. Only the intent is recorded here; the feedback line
  // waits for the dispatch outcome (refire-result / a sweep settles it). The
  // intent is the shared counter the next close reads: no intent on disk, no
  // re-fire (never twice), and the feedback line is written now instead.
  if (decision.eligible) {
    const intent = {
      ts: new Date().toISOString(),
      kind: 'plan.recovery',
      event: 'plan_refire_pending',
      agentId,
      runId,
      runStartTs: run.startTs,
      refireRunId,
      scheduledAt: feedback.scheduledAt,
      feedback,
    };
    try {
      appendLine(paths.auditFile, intent);
      // Seen by the next close in this same op (alreadyRefired).
      run.refirePending = intent;
      return {
        closed: { agentId, runId, reason, lastStep },
        refire: { agentId, origRunId: runId, refireRunId, scheduledAt: launch.scheduledAt },
      };
    } catch (_) {
      extra.refireSkipped = 'intent-not-recorded';
    }
  }
  writeFeedback(paths, ctx.feedbackLines, feedback, extra);
  return { closed: { agentId, runId, reason, lastStep }, refire: null };
}

function feedbackKey(runId, reason) {
  return `${runId}\u0000${reason}`;
}

/**
 * This agent's own record of its feedback lines, from its audit (never the
 * shared file's tail: every agent appends there, so an old line can be
 * pushed out of any tail read). Two events, two meanings:
 *   - `recovery_feedback` (content): the line's content, the source of truth
 *     for what the line says. Written first.
 *   - `recovery_feedback_shared` (marker): the line is in the shared file.
 *     Written only after the shared append succeeded (or the line was found
 *     there).
 * Returns {ok, content: Map key -> {feedback, ts}, shared: Set key}, keyed by
 * run and reason. The whole audit of this agent is read (never a tail and
 * never cut by age): a content still waiting for its shared line must be
 * found however old it is and however much the executor wrote after it. One
 * agent's audit is a bounded per-agent file and the scan is a single
 * streaming pass that parses only the feedback lines. `ok` is false when the
 * audit could not be read (content and shared are then empty: unknown).
 */
function auditFeedbackState(paths) {
  const content = new Map();
  const shared = new Set();
  const res = scanLines(paths.auditFile, (line) => {
    if (!line.includes('"recovery_feedback')) return false;
    let e = null;
    try {
      e = JSON.parse(line);
    } catch (_) {
      return false;
    }
    if (!isPlainObject(e) || e.kind !== 'plan.recovery') return false;
    if (e.event === 'recovery_feedback' && isPlainObject(e.feedback) &&
        typeof e.feedback.runId === 'string' && typeof e.feedback.reason === 'string') {
      const key = feedbackKey(e.feedback.runId, e.feedback.reason);
      if (!content.has(key)) content.set(key, { feedback: e.feedback, ts: tsMs(e) });
    } else if (e.event === 'recovery_feedback_shared' && typeof e.runId === 'string' && typeof e.reason === 'string') {
      shared.add(feedbackKey(e.runId, e.reason));
    }
    return false;
  });
  return { ok: res === 'done' || res === 'missing', content, shared };
}

/**
 * True when the shared feedback file holds a line for (runId, reason), false
 * when it does not, null when it could not be read (unknown: write nothing).
 * Reads the WHOLE file, from its first byte (no tail window): every agent
 * appends there, so a line can sit anywhere, and a line missed here would be
 * written twice. The cost is acceptable: the file grows by one line per
 * closed run (rare: a run the executor could not close itself), this check
 * runs at most twice per line to be shared (before the append, and the
 * read-back after it; a close, or the backfill of a content with no shared
 * marker, itself rare), and it is one streaming pass that parses only lines
 * naming the run id. A line that does not parse (a fragment of a short
 * write, or a line glued onto one) is skipped silently: it never stops the
 * scan, and never counts as the line being there.
 */
function sharedFeedbackHas(file, runId, reason) {
  let found = false;
  const res = scanLines(file, (line) => {
    if (!line || !line.includes(runId)) return false;
    try {
      const v = JSON.parse(line);
      found = isPlainObject(v) && v.runId === runId && v.reason === reason;
    } catch (_) {
      found = false;
    }
    return found;
  });
  if (res === 'stopped') return true;
  if (res === 'done' || res === 'missing') return false;
  return null;
}

/**
 * Puts the line for `feedback` (the content of record) into the shared file
 * unless it is already there, then marks it shared in the audit. The marker
 * is written only after the line is known to be in the file, so a death
 * anywhere leaves either no marker (the next sweep's backfill looks again:
 * finds the line, or adds it) or a line that is there (never a duplicate,
 * never a loss). A byte count is not proof: after the append, the line must
 * be read back from the file — a line that parses as JSON and names this
 * (runId, reason) — before the marker is written; when it cannot be (the
 * bytes landed glued to a fragment, or the file could not be read), no
 * marker, and the next backfill looks again. Returns true when shared.
 */
function shareFeedback(paths, feedbackLines, feedback, markerExtra) {
  const has = sharedFeedbackHas(paths.feedbackFile, feedback.runId, feedback.reason);
  if (has === null) return false;
  if (!has) {
    try {
      appendLine(paths.feedbackFile, feedback);
    } catch (_) {
      return false;
    }
    // Read back: the line was not there before, so a parseable line with this
    // (runId, reason) now is the one just written.
    if (sharedFeedbackHas(paths.feedbackFile, feedback.runId, feedback.reason) !== true) return false;
    if (!feedbackExists(feedbackLines, feedback.runId, feedback.reason)) feedbackLines.push(feedback);
  }
  try {
    appendLine(paths.auditFile, Object.assign({
      ts: new Date().toISOString(),
      kind: 'plan.recovery',
      event: 'recovery_feedback_shared',
      agentId: feedback.agentId,
      runId: feedback.runId,
      reason: feedback.reason,
      ...(has ? { foundInFile: true } : {}),
    }, markerExtra || {}));
  } catch (_) {}
  return true;
}

/**
 * The feedback line (once per run and reason). (1) its content goes to the
 * audit as `recovery_feedback` — the source of truth, written first; a
 * content already there is kept (it is what the line says, even when this
 * call brings other values). (2) the shared line, then (3) the
 * `recovery_feedback_shared` marker (shareFeedback). A line already marked
 * shared is never written again.
 */
function writeFeedback(paths, feedbackLines, feedback, extra) {
  const key = feedbackKey(feedback.runId, feedback.reason);
  const state = auditFeedbackState(paths);
  if (state.shared.has(key)) return;
  let content = state.content.has(key) ? state.content.get(key).feedback : null;
  if (!content) {
    try {
      appendLine(paths.auditFile, Object.assign({ ts: new Date().toISOString(), kind: 'plan.recovery', event: 'recovery_feedback', feedback }, extra || {}));
    } catch (_) {
      // Not recorded: no shared line either (it could not be told apart from a
      // later attempt). A re-fire's line is retried by the backfill; for a close
      // the audit could not take, its plan_orphaned / plan_hung most likely
      // failed too, leaving the run open for the next close.
      return;
    }
    content = feedback;
  }
  shareFeedback(paths, feedbackLines, content);
}

/**
 * A content event with no shared marker (a death, or a failed shared append,
 * between the two): the line is added from the audit content unless the
 * shared file already holds it (a full scan of that file), then marked.
 * Found by a full scan of this agent's audit and never dropped for its age:
 * what has to be completed is completed, however late. Each entry stands
 * alone: one that cannot be shared now (or a broken line in either file)
 * does not stop the others.
 */
function backfillSharedFeedback(paths, feedbackLines) {
  const state = auditFeedbackState(paths);
  if (!state.ok) return 0;
  let n = 0;
  for (const [key, c] of state.content) {
    if (state.shared.has(key)) continue;
    if (shareFeedback(paths, feedbackLines, c.feedback, { backfilled: true })) n += 1;
  }
  return n;
}

/**
 * Settles a re-fire intent: `plan_refire` (dispatched) or `plan_refire_failed`,
 * then the run's feedback line with the real outcome. Idempotent (a run with
 * an outcome is left alone).
 */
function settleRefire(paths, run, refired, how, feedbackLines) {
  const p = run.refirePending;
  if (!p || run.refireResult) return false;
  const entry = {
    ts: new Date().toISOString(),
    kind: 'plan.recovery',
    event: refired ? 'plan_refire' : 'plan_refire_failed',
    agentId: p.agentId,
    runId: p.runId,
    runStartTs: run.startTs,
    refireRunId: p.refireRunId,
    scheduledAt: p.scheduledAt,
    ...(refired ? { confirmedBy: how } : { why: how }),
  };
  try {
    appendLine(paths.auditFile, entry);
  } catch (_) {
    return false;
  }
  run.refireResult = entry;
  if (isPlainObject(p.feedback)) {
    const feedback = Object.assign({}, p.feedback, {
      refire: { eligible: true, refired, refireRunId: refired ? p.refireRunId : null },
    });
    writeFeedback(paths, feedbackLines, feedback, refired ? {} : { refireSkipped: how });
  }
  return true;
}

// ── liveness of the executor ────────────────────────────────────────────────

function defaultProcDeps() {
  return {
    pidAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return !!(e && e.code === 'EPERM');
      }
    },
    cmdline(pid) {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
      } catch (_) {
        return null;
      }
    },
    listPids() {
      try {
        return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
      } catch (_) {
        return [];
      }
    },
    /** /proc/<pid>/stat field 22 (start time), or null. */
    startTime(pid) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) return null;
        const v = stat.slice(close + 2).split(' ')[19];
        return /^\d+$/.test(v || '') ? Number(v) : null;
      } catch (_) {
        return null;
      }
    },
    /** True only when the pid is confirmed gone (kill(pid, 0) -> ESRCH); false when alive or unknown. */
    pidGone(pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return !!(e && e.code === 'ESRCH');
      }
    },
    cont(pid) {
      try {
        process.kill(pid, 'SIGCONT');
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}

function isExecutorCmdline(argv, agentId) {
  if (!Array.isArray(argv)) return false;
  if (!argv.some((a) => typeof a === 'string' && /shelly-plan-executor\.js$/.test(a))) return false;
  const i = argv.indexOf('--agent-id');
  return i !== -1 && argv[i + 1] === agentId;
}

/**
 * True when an executor process of this agent is alive: the pid in its run
 * lock is alive (and, when /proc can tell, runs the executor), or any process
 * runs the executor for this agent. Unknown counts as alive (never close a run
 * that may still be running).
 */
function executorAlive(paths, agentId, deps) {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(paths.lockFile, 'utf8').trim());
  } catch (_) {
    pid = 0;
  }
  if (Number.isSafeInteger(pid) && pid > 0 && deps.pidAlive(pid)) {
    const argv = deps.cmdline(pid);
    if (argv === null || isExecutorCmdline(argv, agentId)) return true;
  }
  for (const p of deps.listPids()) {
    if (p === process.pid) continue;
    if (isExecutorCmdline(deps.cmdline(p), agentId)) return true;
  }
  return false;
}

// ── the recovery lock (finalize, sweep and hang-check never interleave) ────

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockHolderAlive(lock) {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(lock, 'utf8').trim());
  } catch (_) {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function withRecoveryLock(home, fn) {
  const lock = path.join(home, ...RECOVERY_LOCK_REL.split('/'));
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch (_) {}
  const deadline = Date.now() + RECOVERY_LOCK_WAIT_MS;
  let fd = -1;
  for (;;) {
    try {
      fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, error: 'lock' };
      try {
        const st = fs.lstatSync(lock);
        if (Date.now() - st.mtimeMs > RECOVERY_LOCK_STALE_MS && !lockHolderAlive(lock)) {
          // Rename first: of two waiters that both saw it stale, only one moves it.
          const aside = `${lock}.stale.${process.pid}`;
          fs.renameSync(lock, aside);
          try { fs.unlinkSync(aside); } catch (_) {}
          continue;
        }
      } catch (_) {
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, error: 'busy' };
      sleepMs(200);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lock); } catch (_) {}
  }
}

// ── the three operations ────────────────────────────────────────────────────

function baseCtx(opts, agentId, extra) {
  return Object.assign({
    paths: agentPaths(opts.home, agentId),
    agentId,
    nowMs: opts.nowMs,
    executorModule: opts.executorModule,
  }, extra);
}

/**
 * Closes this agent's open runs. `exited` names a run the caller knows is
 * dead (finalize: started at or after launchStartedAtMs); the rest are closed
 * only when no executor of the agent is alive, and never when younger than
 * SWEEP_YOUNG_RUN_GRACE_MS. Returns {closed, refire}.
 */
/**
 * The run (at most one) whose executor process was the one finalize's launch
 * started, so the exit native observed is that run's. Only two facts
 * attribute an exit, in this order of precedence:
 *   1. the run native declared (`runStartTs`: the run its own watchdog
 *      judged hung and aborted, seen live in this launch);
 *   2. the run matchLaunches tied to this launch (an inference).
 * When both exist and disagree (the tied run is another one, or the
 * declared run is tied to another launch), the declaration wins and the
 * disagreement is returned as `conflict` (recorded in the audit as
 * `plan_exit_attribution_conflict`; neither run lends a launch identity
 * from then on: matchLaunches drops disputed runs).
 * Nothing is inferred from time windows: a run with neither (no launch
 * record tied to it, no declaration) gets no exit record. It is closed as
 * `plan_orphaned` by the liveness check (this finalize's, or a sweep's) with
 * detectedBy 'sweep' and no exit code. 1 attributes the exit only: the run
 * gets no launch id, slot or refireOf from it (closeRun reads those from
 * launchMatch alone). Returns {run|null, conflict|null}. Pure.
 */
function ownRunOf(runs, launchMatch, launches, mode) {
  const none = { run: null, conflict: null };
  if (mode.kind !== 'finalize' || !mode.launchId) return none;
  const matchedTo = (r) => launchForRun(launchMatch, r);
  const tiedAll = runs.filter((r) => {
    const l = matchedTo(r);
    return !!l && l.launchId === mode.launchId;
  });
  const tied = tiedAll.length === 1 ? tiedAll[0] : null;
  if (typeof mode.runStartTs === 'string') {
    // Native's declaration: its watchdog saw this run live in its own launch.
    const mine = launches.find((l) => l.launchId === mode.launchId) || null;
    const from = Number.isSafeInteger(mode.launchStartedAtMs) ? mode.launchStartedAtMs : mine ? mine.startedAt : NaN;
    const r = runs.find((x) => x.startTs === mode.runStartTs);
    // (the same 1 s the hang check allows before the launch start)
    if (r && Number.isFinite(from) && r.startMs >= from - 1000) {
      const other = matchedTo(r);
      const conflict = (tied && tied !== r) || (other && other.launchId !== mode.launchId)
        ? {
          declaredRunStartTs: r.startTs,
          inferredRunStartTs: tied && tied !== r ? tied.startTs : null,
          declaredRunLaunchId: other && other.launchId !== mode.launchId ? other.launchId : null,
        }
        : null;
      return { run: r, conflict };
    }
  }
  return { run: tied, conflict: null };
}

/**
 * The disagreement ownRunOf found between native's declaration and the
 * launch matching, once per run (`plan_exit_attribution_conflict`).
 */
function recordAttributionConflict(paths, agentId, runs, mode, conflict) {
  const declared = runs.find((r) => r.startTs === conflict.declaredRunStartTs);
  if (!declared || declared.attributionConflict) return;
  const entry = {
    ts: new Date().toISOString(),
    kind: 'plan.recovery',
    event: 'plan_exit_attribution_conflict',
    agentId,
    runStartTs: conflict.declaredRunStartTs,
    launchId: mode.launchId,
    inferredRunStartTs: conflict.inferredRunStartTs,
    declaredRunLaunchId: conflict.declaredRunLaunchId,
    resolution: 'declared',
  };
  // The declaration wins in this op whether or not the line could be written.
  declared.attributionConflict = entry;
  declared.disputed = true;
  const inferred = conflict.inferredRunStartTs ? runs.find((r) => r.startTs === conflict.inferredRunStartTs) : null;
  if (inferred) inferred.disputed = true;
  try {
    appendLine(paths.auditFile, entry);
  } catch (_) {}
}

/**
 * The exit native observed for its declared run, kept in the audit when the
 * run cannot be closed now (an executor of the agent is alive and the run
 * may be its): `plan_exit_observed`, keyed by runStartTs. Whatever later
 * ends the run writes it as that run's `plan_exit`, once: a recovery close
 * (closeRun), or — when the executor itself wrote plan_finish — the next
 * reconcile (finalize or sweep: promoteRetainedExits).
 */
function retainObservedExit(paths, agentId, run, mode) {
  if (!Number.isInteger(mode.exitCode) || run.exit || run.exitObserved) return;
  const entry = {
    ts: new Date().toISOString(),
    kind: 'plan.recovery',
    event: 'plan_exit_observed',
    agentId,
    runStartTs: run.startTs,
    launchId: mode.launchId,
    exitCode: mode.exitCode,
    signal: signalOf(mode.exitCode),
    timedOut: mode.timedOut === true,
    detectedBy: 'driver',
  };
  try {
    appendLine(paths.auditFile, entry);
    run.exitObserved = entry;
  } catch (_) {}
}

/**
 * A retained exit (plan_exit_observed) whose run is closed by now, by any
 * path — the executor's own plan_finish included, not only a recovery close
 * (closeRun writes it itself there) — and that has no plan_exit yet: written
 * now as the run's `plan_exit`, once (retainedFrom names the observation).
 * The run id is the recovery close's, else the executor's progress runId,
 * else null (nothing borrowed). `runs` are the whole audit's
 * (readAllAuditRuns), so no observation is missed for its position in the
 * file. Returns the number written.
 */
function promoteRetainedExits(paths, agentId, runs) {
  let n = 0;
  for (const run of runs) {
    if (isOpenRun(run) || run.exit || !run.exitObserved || !Number.isInteger(run.exitObserved.exitCode)) continue;
    const obs = run.exitObserved;
    let runId = null;
    if (run.recoveryClose && typeof run.recoveryClose.runId === 'string' && RUN_ID_RE.test(run.recoveryClose.runId)) {
      runId = run.recoveryClose.runId;
    } else {
      const progress = progressForRun(paths, run);
      runId = (progress && progress.runId) || null;
    }
    const entry = {
      ts: new Date().toISOString(),
      kind: 'plan.recovery',
      event: 'plan_exit',
      agentId,
      runId,
      runStartTs: run.startTs,
      exitCode: obs.exitCode,
      signal: signalOf(obs.exitCode),
      timedOut: obs.timedOut === true,
      detectedBy: 'driver',
      retainedFrom: typeof obs.ts === 'string' ? obs.ts : null,
      closedBy: run.recoveryClose ? run.recoveryClose.event : 'plan_finish',
    };
    try {
      appendLine(paths.auditFile, entry);
      run.exit = entry;
      n += 1;
    } catch (_) {}
  }
  return n;
}

function reconcileAgent(opts, agentId, mode) {
  const paths = agentPaths(opts.home, agentId);
  // ONE snapshot of the whole audit (readAllAuditRuns, no tail window) for
  // everything below: the promotion of retained exits and the choice of runs
  // to close use the same run objects, so a run the executor finishes during
  // this reconcile cannot be promoted as closed and then closed again as open
  // (a second plan_exit and a false plan_orphaned). Whatever closed a run since
  // its exit was retained, the exit is recorded, wherever the observation sits
  // in the file. An unreadable audit gives no runs: nothing is promoted or
  // closed from it.
  const all = readAllAuditRuns(paths, { withEvents: true });
  const runs = all.ok ? all.runs : [];
  promoteRetainedExits(paths, agentId, runs);
  const open = runs.filter((r) => isOpenRun(r) && opts.nowMs - r.startMs <= LOOKBACK_MS);
  const result = { closed: [], refire: [] };
  // (finalize goes on with no open run: a declaration that contradicts the
  // matching is recorded even when the declared run is already closed.)
  if (!open.length && mode.kind !== 'finalize') return result;
  const launches = readLaunches(paths, agentId);
  let launchMatch = matchLaunches(runs, launches);
  // Only this launch's run is known dead: another launch's run (a re-fire, a
  // Run now) can start while this finalize waits for the recovery lock, and a
  // run that cannot be shown to be this launch's (ownRunOf) is left to the
  // liveness check below.
  const { run: own, conflict } = ownRunOf(runs, launchMatch, launches, mode);
  if (conflict) {
    recordAttributionConflict(paths, agentId, runs, mode, conflict);
    // The declaration won: the disputed runs lend no launch identity.
    launchMatch = matchLaunches(runs, launches);
  }
  if (!open.length) return result;
  let known = own && isOpenRun(own) && open.includes(own) ? [own] : [];
  // A declared run with no tied launch that is the newest open run while an
  // executor of this agent is alive may be that executor's: leave it to the
  // liveness check below, and keep the exit native observed for it in the
  // audit (plan_exit_observed) so the close that ends it later records it.
  if (known.length && !launchForRun(launchMatch, known[0]) && known[0] === open[open.length - 1] &&
      executorAlive(paths, agentId, opts.procDeps)) {
    retainObservedExit(paths, agentId, known[0], mode);
    known = [];
  }
  const rest = open.filter((r) => !known.includes(r));
  let toClose = known.slice();
  if (rest.length) {
    const alive = executorAlive(paths, agentId, opts.procDeps);
    // A live executor owns the most recent of the remaining open runs.
    const candidates = alive ? rest.slice(0, -1) : rest;
    for (const r of candidates) {
      if (opts.nowMs - r.startMs < SWEEP_YOUNG_RUN_GRACE_MS) continue;
      toClose.push(r);
    }
  }
  if (!toClose.length) return result;
  toClose = toClose.sort((a, b) => a.startMs - b.startMs);
  const planInfo = readPlan(paths);
  const feedbackLines = opts.feedbackLines || readFeedback(paths);
  for (const run of toClose) {
    const isKnown = known.includes(run);
    const ctx = baseCtx(opts, agentId, {
      reason: REASON_ORPHANED,
      detectedBy: isKnown ? 'driver' : 'sweep',
      exitCode: isKnown ? mode.exitCode : undefined,
      timedOut: isKnown ? mode.timedOut : false,
      feedbackLines,
      auditRuns: runs,
    });
    const out = closeRun(ctx, run, launchMatch, planInfo);
    result.closed.push(out.closed);
    if (out.refire) result.refire.push(out.refire);
  }
  return result;
}

function listAgentIds(home) {
  const logs = path.join(home, '.shelly', 'agents', 'logs');
  try {
    return fs.readdirSync(logs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && AGENT_ID_RE.test(d.name))
      .map((d) => d.name);
  } catch (_) {
    return [];
  }
}

function opFinalize(opts) {
  if (!AGENT_ID_RE.test(opts.agentId || '')) return { ok: false, error: 'agent-id' };
  if (!Number.isSafeInteger(opts.launchStartedAtMs) || opts.launchStartedAtMs <= 0) return { ok: false, error: 'launch-started-at-ms' };
  const launchId = typeof opts.launchId === 'string' && RUN_ID_RE.test(opts.launchId) ? opts.launchId : '';
  // The launch id is how finalize knows which run is its own (matchLaunches).
  if (!launchId) return { ok: false, error: 'launch-id' };
  const exitCode = Number.isInteger(opts.exitCode) ? opts.exitCode : undefined;
  // Native's own declaration of its run, when it has one (the run its watchdog aborted).
  const runStartTs = typeof opts.runStartTs === 'string' && opts.runStartTs.length <= 64 ? opts.runStartTs : undefined;
  const mode = { kind: 'finalize', launchStartedAtMs: opts.launchStartedAtMs, launchId, runStartTs };
  const out = reconcileAgent(opts, opts.agentId, Object.assign({ exitCode, timedOut: opts.timedOut === true }, mode));
  if (exitCode !== undefined) recordExitAfterClose(opts, opts.agentId, mode, exitCode, opts.timedOut === true);
  // A re-fire's own launch has run: settle its original run's intent as re-fired.
  try {
    settlePendingRefires(opts, opts.agentId, readFeedback(agentPaths(opts.home, opts.agentId)), true);
  } catch (_) {}
  return Object.assign({ ok: true, op: 'finalize' }, out);
}

/**
 * A sweep (another reconcile) or the hang watchdog (tier 1) may have closed
 * this launch's run before finalize ran: the driver's terminal record (the
 * exit code / signal it observed) is still appended once, to that run. The
 * run is found by the same rule as a close (ownRunOf: the tied run, else the
 * one native declared; never a time-window guess), and the line carries the
 * run id the close used (nothing is re-derived or borrowed).
 */
function recordExitAfterClose(opts, agentId, mode, exitCode, timedOut) {
  const paths = agentPaths(opts.home, agentId);
  const runs = readAuditRuns(paths);
  const launches = readLaunches(paths, agentId);
  const { run } = ownRunOf(runs, matchLaunches(runs, launches), launches, mode);
  if (!run || run.exit || !run.recoveryClose) return;
  const runId = typeof run.recoveryClose.runId === 'string' && RUN_ID_RE.test(run.recoveryClose.runId)
    ? run.recoveryClose.runId : null;
  try {
    appendLine(paths.auditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.recovery',
      event: 'plan_exit',
      agentId,
      runId,
      runStartTs: run.startTs,
      exitCode,
      signal: signalOf(exitCode),
      timedOut,
      detectedBy: 'driver',
    });
  } catch (_) {}
}

/**
 * Re-fire intents with no reported outcome, older than REFIRE_PENDING_SETTLE_MS
 * (native died between the close and the dispatch report, or the outcome was
 * unknown): dispatched when the re-fire's own launch record exists (native
 * writes it only when the re-fired run actually starts), else failed.
 */
function settlePendingRefires(opts, agentId, feedbackLines, confirmOnly) {
  const paths = agentPaths(opts.home, agentId);
  const runs = readAuditRuns(paths);
  let launchStarts = readLaunchStarts(paths, agentId);
  let n = 0;
  for (const r of runs) {
    if (!r.refirePending) continue;
    if (r.refireResult) {
      // Settled refired=false, and the re-fire started after all: the slot is
      // used (alreadyRefired reads the launch record), and the audit says so
      // once. The feedback line stays the one already written (one per run).
      if (r.refireResult.event === 'plan_refire_failed' && !r.refireLate) {
        const late = refireLaunchOf(launchStarts, r.refirePending);
        if (late) {
          try {
            appendLine(paths.auditFile, {
              ts: new Date().toISOString(),
              kind: 'plan.recovery',
              event: 'plan_refire_late_start',
              agentId,
              runId: r.refirePending.runId,
              runStartTs: r.startTs,
              refireRunId: r.refirePending.refireRunId,
              launchId: late.launchId,
            });
            r.refireLate = true;
          } catch (_) {}
        }
      }
      continue;
    }
    // Only the re-fire's own launch record (native writes it when the
    // re-fired run passed every service and runtime gate and starts) proves
    // it happened. A dispatch the service took but then refused never gets one.
    if (refireLaunchOf(launchStarts, r.refirePending)) {
      if (settleRefire(paths, r, true, 'launch-record', feedbackLines)) n += 1;
    } else if (!confirmOnly && opts.nowMs - tsMs(r.refirePending) >= REFIRE_PENDING_SETTLE_MS) {
      // Read the launch records again right before settling as not re-fired:
      // native writes them outside the recovery lock.
      launchStarts = readLaunchStarts(paths, agentId);
      if (refireLaunchOf(launchStarts, r.refirePending)) {
        if (settleRefire(paths, r, true, 'launch-record', feedbackLines)) n += 1;
      } else if (settleRefire(paths, r, false, r.refireDispatched ? 'not-started' : 'unconfirmed', feedbackLines)) {
        n += 1;
      }
    }
  }
  // A close settled but its feedback content not written (a death in
  // between): write it now from the recorded outcome, once. Then every
  // content with no shared marker gets its shared line (backfillSharedFeedback).
  // "Written" is this agent's own audit, never the shared file's tail. The
  // settled re-fires are found in the whole audit (readAllAuditRuns, read
  // after the settling above), never the tail window: an intent or result
  // the executor pushed out of the tail is still completed.
  if (!confirmOnly) {
    const { ok, content } = auditFeedbackState(paths);
    const all = readAllAuditRuns(paths);
    for (const r of all.ok ? all.runs : []) {
      const p = r.refirePending;
      // No age cut: a settled re-fire still missing its content is completed however late.
      if (!ok || !p || !r.refireResult || !isPlainObject(p.feedback)) continue;
      if (content.has(feedbackKey(p.runId, p.feedback.reason))) continue;
      const refired = r.refireResult.event === 'plan_refire';
      writeFeedback(paths, feedbackLines, Object.assign({}, p.feedback, {
        refire: { eligible: true, refired, refireRunId: refired ? p.refireRunId : null },
      }), refired ? { backfilled: true } : { refireSkipped: r.refireResult.why || 'unconfirmed', backfilled: true });
    }
    backfillSharedFeedback(paths, feedbackLines);
  }
  return n;
}

/** The open run that started at `runStartTs` (since the launch), or null. */
function openRunAt(runs, runStartTs) {
  if (typeof runStartTs !== 'string') return null;
  return runs.find((r) => r.startTs === runStartTs && isOpenRun(r)) || null;
}

/**
 * Tier 1, after native killed the executor tree: closes the run the `hung`
 * verdict named with `plan_hung` (feedback line, re-fire decision). A run
 * that ended in between is left alone.
 */
function opHangAbort(opts) {
  if (!AGENT_ID_RE.test(opts.agentId || '')) return { ok: false, error: 'agent-id' };
  const paths = agentPaths(opts.home, opts.agentId);
  const runs = readAuditRuns(paths);
  const run = openRunAt(runs, opts.runStartTs);
  const base = { ok: true, op: 'hang-abort', closed: [], refire: [] };
  if (!run) return base;
  const noProgressMs = Number.isSafeInteger(opts.noProgressMs) && opts.noProgressMs >= 0 ? opts.noProgressMs : null;
  const ctx = baseCtx(opts, opts.agentId, {
    reason: REASON_HUNG, detectedBy: 'watchdog', noProgressMs, feedbackLines: readFeedback(paths), auditRuns: runs,
  });
  const launches = readLaunches(paths, opts.agentId);
  let launchMatch = matchLaunches(runs, launches);
  // The watchdog's verdict is native's declaration of its own launch's run:
  // when the matching ties that run elsewhere, the declaration wins (as in
  // finalize) and the run closes with no borrowed identity.
  const launchId = typeof opts.launchId === 'string' && RUN_ID_RE.test(opts.launchId) ? opts.launchId : '';
  if (launchId) {
    const { conflict } = ownRunOf(runs, launchMatch, launches, {
      kind: 'finalize', launchId, launchStartedAtMs: opts.launchStartedAtMs, runStartTs: run.startTs,
    });
    if (conflict) {
      recordAttributionConflict(paths, opts.agentId, runs, { launchId }, conflict);
      launchMatch = matchLaunches(runs, launches);
    }
  }
  const out = closeRun(ctx, run, launchMatch, readPlan(paths));
  base.closed.push(out.closed);
  if (out.refire) base.refire.push(out.refire);
  return base;
}

const HANG_CANCEL_REASONS = new Set(['worker', 'progress', 'executor-gone', 'freeze-failed']);

/** Tier 1, when native's re-check found the run alive: `plan_hung_cancelled` (the run stays open). */
function opHangCancel(opts) {
  if (!AGENT_ID_RE.test(opts.agentId || '')) return { ok: false, error: 'agent-id' };
  if (!HANG_CANCEL_REASONS.has(opts.why)) return { ok: false, error: 'why' };
  const paths = agentPaths(opts.home, opts.agentId);
  const run = openRunAt(readAuditRuns(paths), opts.runStartTs);
  if (!run) return { ok: true, op: 'hang-cancel', recorded: false };
  try {
    appendLine(paths.auditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.recovery',
      event: 'plan_hung_cancelled',
      agentId: opts.agentId,
      runStartTs: run.startTs,
      tier: 1,
      why: opts.why,
      detectedBy: 'watchdog',
    });
  } catch (_) {
    return { ok: true, op: 'hang-cancel', recorded: false };
  }
  return { ok: true, op: 'hang-cancel', recorded: true };
}

// ── an MCP-requested re-fire (search parity item 4) ─────────────────────────
//
// request_pipeline_refire(pipelineId) asks for one re-run of an opted-in
// article pipeline whose run today ended held, failed, or dead. The caller
// picks only which pipeline and when; the re-run is the S5 re-fire (the same
// intent, dispatch, refire-result and launch-record settling), never a new
// execution path. The request is a line in the agent's own audit
// (plan_refire_requested, append-only like every recovery record), so it
// outlives an app kill, an update or a reboot: a sweep (the one native starts
// right after accepting, a boot / update / watchdog reconcile) turns it into
// a plan_refire_pending intent carrying its requestId, and the existing S5
// dispatch takes it from there. A request still unconsumed past its local day,
// or found while STOP-ALL is on, is closed as plan_refire_request_expired.
// The web-search opt-in check is native's (WebSearchOptInStore); this script
// checks the run, the day and the counts.

/** Held reasons (the executor's ARTICLE_HELD_REASONS) a re-run can recover from. */
const REFIRE_REQUEST_HELD_REASONS = new Set(['web-search-refused', 'web-search-stopped', 'no-web-sources', 'text-lint', 'approval-timeout']);
/** Accepted requests per pipeline (one agent) per local day. */
const REFIRE_REQUEST_DAILY_MAX = 2;
const PRINCIPAL_RE = /^[0-9a-f]{32}$/;

/**
 * The run id the S5 records use for this run (closeRun's rule): the tied
 * launch's id, else the executor's progress runId, else a synthetic one.
 */
function recoveryRunIdFor(paths, agentId, run, launchMatch) {
  const launch = launchForRun(launchMatch, run);
  if (launch) return launch.launchId;
  const progress = progressForRun(paths, run);
  return (progress && RUN_ID_RE.test(progress.runId || '') && progress.runId) || `${agentId}-${run.startMs}-unrecorded`;
}

/**
 * Why the newest run of today may (or may not) be re-run on request. Pure.
 * Returns {code, reason?, run?}: code 'ok' or a refusal code.
 *   no_run_today      no run of this agent started today (local day)
 *   run_active        today's newest run has not ended
 *   delivered         today's newest run saved its draft (or found it saved)
 *   not_recoverable   it ended any other way (success, a skip that is not held)
 *   duplicate         it already has a re-run requested or decided (S5 or MCP)
 *   daily_limit       REFIRE_REQUEST_DAILY_MAX requests were accepted today
 */
function refireRequestDecision(runs, nowMs) {
  const today = localDate(nowMs);
  const todays = runs.filter((r) => localDate(r.startMs) === today && r.startMs <= nowMs);
  if (!todays.length) return { code: 'no_run_today' };
  const run = todays[todays.length - 1];
  if (isOpenRun(run)) return { code: 'run_active', run };
  if (run.events.some((e) => e.event === 'draft_saved' || e.event === 'draft_exists')) return { code: 'delivered', run };
  if (run.refireRequested || run.refirePending) return { code: 'duplicate', run };
  const held = run.events.filter((e) => e.event === 'article_held').slice(-1)[0];
  let reason = null;
  if (held && REFIRE_REQUEST_HELD_REASONS.has(held.reason)) reason = `held:${held.reason}`;
  else if (run.recoveryClose) reason = run.recoveryClose.event === 'plan_hung' ? REASON_HUNG : REASON_ORPHANED;
  else if (run.finish && run.finish.status === 'error') reason = 'failed';
  if (!reason) return { code: 'not_recoverable', run };
  const accepted = runs.filter((r) => r.refireRequested && r.refireRequested.date === today).length;
  if (accepted >= REFIRE_REQUEST_DAILY_MAX) return { code: 'daily_limit', run };
  return { code: 'ok', reason, run };
}

/**
 * --op refire-request --agent-id A --pipeline-id P [--principal H]: records
 * an accepted request, or answers why not. Native has already checked the
 * opt-in and resolved P to A. Returns {ok, op, code, accepted, duplicate,
 * requestId?}; code is 'accepted' / 'duplicate' or a refusal code
 * (refireRequestDecision, plus halted / unknown_pipeline / audit_unreadable /
 * not_recorded).
 */
function opRefireRequest(opts) {
  if (!AGENT_ID_RE.test(opts.agentId || '')) return { ok: false, error: 'agent-id' };
  if (typeof opts.pipelineId !== 'string' || !PIPELINE_ID_RE.test(opts.pipelineId)) return { ok: false, error: 'pipeline-id' };
  const principal = typeof opts.principal === 'string' && PRINCIPAL_RE.test(opts.principal) ? opts.principal : null;
  const paths = agentPaths(opts.home, opts.agentId);
  const answer = (code, extra) => Object.assign({ ok: true, op: 'refire-request', code, accepted: code === 'accepted' || code === 'duplicate', duplicate: code === 'duplicate' }, extra || {});
  // STOP-ALL first: nothing else is read while it is on.
  if (fs.existsSync(paths.haltSentinel)) return answer('halted');
  const planInfo = readPlan(paths);
  if (!planInfo.plan || pipelineIdFor(opts.home, planInfo.plan) !== opts.pipelineId) return answer('unknown_pipeline');
  const all = readAllAuditRuns(paths, { withEvents: true });
  if (!all.ok) return answer('audit_unreadable');
  const decision = refireRequestDecision(all.runs, opts.nowMs);
  if (decision.code === 'duplicate') {
    const prior = decision.run.refireRequested;
    return answer('duplicate', prior && typeof prior.requestId === 'string' ? { requestId: prior.requestId } : {});
  }
  if (decision.code !== 'ok') return answer(decision.code);
  const run = decision.run;
  const runId = recoveryRunIdFor(paths, opts.agentId, run, matchLaunches(all.runs, readLaunches(paths, opts.agentId)));
  const requestId = `rq-${opts.nowMs}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    appendLine(paths.auditFile, {
      ts: new Date(opts.nowMs).toISOString(),
      kind: 'plan.recovery',
      event: 'plan_refire_requested',
      agentId: opts.agentId,
      pipelineId: opts.pipelineId,
      requestId,
      date: localDate(opts.nowMs),
      runId,
      runStartTs: run.startTs,
      reason: decision.reason,
      principal,
      via: 'mcp',
    });
  } catch (_) {
    return answer('not_recorded');
  }
  return answer('accepted', { requestId });
}

/**
 * A sweep's turn for this agent's accepted, unconsumed requests: each becomes
 * a plan_refire_pending intent (with its requestId and no feedback line: the
 * held landing wrote its own) that the S5 dispatch takes, or is closed as
 * expired (halted, day-ended, superseded: a newer run started since).
 * A request whose agent has a live executor waits for a later sweep.
 * Returns {refire: [...], pending: n}.
 */
function consumeRefireRequests(opts, agentId) {
  const paths = agentPaths(opts.home, agentId);
  const out = { refire: [], pending: 0 };
  const all = readAllAuditRuns(paths);
  if (!all.ok) return out;
  const runs = all.runs;
  const waiting = runs.filter((r) => r.refireRequested && !r.refirePending && !r.refireRequestClosed);
  if (!waiting.length) return out;
  const halted = fs.existsSync(paths.haltSentinel);
  const today = localDate(opts.nowMs);
  const alive = !halted && executorAlive(paths, agentId, opts.procDeps);
  let launchMatch = null;
  for (const run of waiting) {
    const rq = run.refireRequested;
    const newer = runs.some((r) => r.startMs > run.startMs);
    const why = halted ? 'halted' : rq.date !== today ? 'day-ended' : newer ? 'superseded' : '';
    if (why) {
      try {
        appendLine(paths.auditFile, {
          ts: new Date(opts.nowMs).toISOString(),
          kind: 'plan.recovery',
          event: 'plan_refire_request_expired',
          agentId,
          requestId: rq.requestId,
          runId: rq.runId,
          runStartTs: run.startTs,
          why,
        });
        run.refireRequestClosed = true;
      } catch (_) {}
      continue;
    }
    if (alive) {
      out.pending += 1;
      continue;
    }
    if (!launchMatch) launchMatch = matchLaunches(runs, readLaunches(paths, agentId));
    const launch = launchForRun(launchMatch, run);
    // The slot the re-fire's launch record carries: the scheduled occurrence
    // when the run was tied to one, else the run's own start (an ad-hoc run,
    // e.g. notification-triggered, has no occurrence; the service needs > 0).
    const slotMs = launch && launch.scheduledAt ? launch.scheduledAt : run.startMs;
    const refireRunId = newRefireRunId(agentId, opts.nowMs);
    const intent = {
      ts: new Date(opts.nowMs).toISOString(),
      kind: 'plan.recovery',
      event: 'plan_refire_pending',
      agentId,
      runId: rq.runId,
      runStartTs: run.startTs,
      refireRunId,
      scheduledAt: isoOrNull(slotMs),
      requestId: rq.requestId,
      requested: 'mcp',
    };
    try {
      appendLine(paths.auditFile, intent);
      run.refirePending = intent;
      out.refire.push({ agentId, origRunId: rq.runId, refireRunId, scheduledAt: slotMs });
    } catch (_) {
      out.pending += 1;
    }
  }
  return out;
}

/** native's report of a dispatch (--dispatched 1 | 0 | unknown). Unknown is left to a sweep. */
function opRefireResult(opts) {
  if (!AGENT_ID_RE.test(opts.agentId || '')) return { ok: false, error: 'agent-id' };
  if (typeof opts.runId !== 'string' || !RUN_ID_RE.test(opts.runId)) return { ok: false, error: 'run-id' };
  if (typeof opts.refireRunId !== 'string' || !RUN_ID_RE.test(opts.refireRunId)) return { ok: false, error: 'refire-run-id' };
  if (!['1', '0', 'unknown'].includes(opts.dispatched)) return { ok: false, error: 'dispatched' };
  const paths = agentPaths(opts.home, opts.agentId);
  const run = readAuditRuns(paths).find((r) => r.refirePending && r.refirePending.runId === opts.runId &&
    r.refirePending.refireRunId === opts.refireRunId);
  if (!run || run.refireResult || opts.dispatched === 'unknown') return { ok: true, op: 'refire-result', settled: false };
  if (opts.dispatched === '0') {
    return { ok: true, op: 'refire-result', settled: settleRefire(paths, run, false, 'dispatch-failed', readFeedback(paths)) };
  }
  // Handed to the service is not re-fired: the service may still refuse it.
  // Only the re-fire's launch record settles it (its finalize, or a sweep).
  if (!run.refireDispatched) {
    try {
      appendLine(paths.auditFile, {
        ts: new Date().toISOString(),
        kind: 'plan.recovery',
        event: 'plan_refire_dispatched',
        agentId: opts.agentId,
        runId: opts.runId,
        runStartTs: run.startTs,
        refireRunId: opts.refireRunId,
      });
    } catch (_) {}
  }
  return { ok: true, op: 'refire-result', settled: false };
}

/**
 * Thaws every tier-1 freeze a watchdog left behind (it died between SIGSTOP
 * and its finally, e.g. the app process was killed): a freeze marker older
 * than FREEZE_STALE_MS. SIGCONT goes only to a listed pid whose start time
 * still matches the marker (never to a reused pid; a pid that is gone or was
 * reused needs nothing). The marker is removed only when every SIGCONT it
 * needed was sent: a failed one leaves it for the next sweep to try again
 * (removed on success, never "tried, then removed"). Then the agent's audit
 * gets `plan_freeze_released`. The marker is removed only when every listed
 * pid is settled for sure (freezePidVerdict): resumed, gone, or alive with
 * another start time. A pid whose /proc start time cannot be read while it
 * may still exist is UNKNOWN, never "another process": the marker stays and
 * the next sweep looks again. A pid listed without a start time (only an
 * older build writes one: native stops no pid whose start time it could not
 * read) cannot be told from a reuse, so it is never signalled, and its marker
 * is removed only once that pid is confirmed gone (ESRCH). The run stays
 * open (no kill was decided): its executor resumes, or a later close handles it.
 * Returns the number of markers released.
 */
function releaseStaleFreezes(opts) {
  const locksDir = path.join(opts.home, '.shelly', 'agents', 'locks');
  let names = [];
  try {
    names = fs.readdirSync(locksDir);
  } catch (_) {
    return 0;
  }
  const deps = opts.procDeps || {};
  if (typeof deps.startTime !== 'function' || typeof deps.cont !== 'function') return 0;
  let released = 0;
  for (const name of names) {
    const m = FREEZE_MARKER_RE.exec(name);
    if (!m) continue;
    const file = path.join(locksDir, name);
    const { value } = readJsonFile(file, FREEZE_MARKER_MAX_BYTES);
    const at = isPlainObject(value) && Number.isSafeInteger(value.at) ? value.at : NaN;
    // An unreadable marker is judged by its file time.
    let mtime = NaN;
    try {
      mtime = fs.lstatSync(file).mtimeMs;
    } catch (_) {
      continue;
    }
    const since = Number.isFinite(at) ? at : mtime;
    if (!(opts.nowMs - since >= FREEZE_STALE_MS)) continue;
    let resumed = 0;
    let failed = 0;
    let unknown = 0;
    const pids = isPlainObject(value) && Array.isArray(value.pids) ? value.pids : [];
    for (const p of pids) {
      if (!isPlainObject(p) || !Number.isSafeInteger(p.pid) || p.pid <= 1) continue;
      const v = freezePidVerdict(deps, p);
      if (v === 'same') {
        if (deps.cont(p.pid)) resumed += 1;
        else failed += 1;
      } else if (v === 'unknown') {
        unknown += 1;
      }
    }
    // A SIGCONT that did not go out, or a pid whose identity could not be
    // settled: the marker stays, the next sweep retries.
    if (failed > 0 || unknown > 0) continue;
    try {
      fs.unlinkSync(file);
    } catch (_) {
      continue;
    }
    released += 1;
    const agentId = m[1];
    try {
      appendLine(agentPaths(opts.home, agentId).auditFile, {
        ts: new Date().toISOString(),
        kind: 'plan.recovery',
        event: 'plan_freeze_released',
        agentId,
        runStartTs: isPlainObject(value) && typeof value.runStartTs === 'string' ? value.runStartTs.slice(0, 64) : null,
        pids: pids.length,
        resumed,
        frozenAt: isoOrNull(since),
        detectedBy: 'sweep',
      });
    } catch (_) {}
  }
  return released;
}

/**
 * What a sweep knows about one pid a freeze marker lists ({pid, startTime}):
 *   'same'    — alive with the marker's start time (the stopped process: SIGCONT it);
 *   'other'   — alive with another start time (the pid was reused: nothing to do);
 *   'gone'    — confirmed gone (kill(pid, 0) said ESRCH: nothing to do);
 *   'unknown' — anything else (/proc unreadable while the pid may exist, no
 *               start time in the marker for a pid that is not confirmed gone).
 * Only 'unknown' keeps the marker for the next sweep.
 */
function freezePidVerdict(deps, p) {
  const gone = () => typeof deps.pidGone === 'function' && deps.pidGone(p.pid) === true;
  if (!Number.isSafeInteger(p.startTime)) return gone() ? 'gone' : 'unknown';
  const now = deps.startTime(p.pid);
  if (Number.isSafeInteger(now)) return now === p.startTime ? 'same' : 'other';
  return gone() ? 'gone' : 'unknown';
}

function opSweep(opts) {
  const ids = opts.agentId ? (AGENT_ID_RE.test(opts.agentId) ? [opts.agentId] : []) : listAgentIds(opts.home);
  const result = { ok: true, op: 'sweep', closed: [], refire: [], pendingRequests: 0 };
  // First: a tree a dead watchdog left stopped runs again (and is then live for the checks below).
  try {
    releaseStaleFreezes(opts);
  } catch (_) {}
  const feedbackLines = readFeedback(agentPaths(opts.home, ids[0] || '_'));
  for (const id of ids) {
    try {
      settlePendingRefires(opts, id, feedbackLines, false);
    } catch (_) {}
    try {
      const out = reconcileAgent(Object.assign({}, opts, { feedbackLines }), id, { kind: 'sweep' });
      result.closed.push(...out.closed);
      result.refire.push(...out.refire);
    } catch (_) {}
    // After the close: a run S5 just re-fired is not re-fired again on request.
    try {
      const rq = consumeRefireRequests(opts, id);
      result.refire.push(...rq.refire);
      result.pendingRequests += rq.pending;
    } catch (_) {}
  }
  return result;
}

/**
 * The hang check (S5-0 §2) for this agent's live run. `workerAlive` is
 * native's /proc answer: a descendant of the executor other than the agent
 * driver is alive. Verdicts: 'none' (no open run), 'ok', 'waiting',
 * 'unknown' (progress capped or unreadable), 'suspect' (tier 2, recorded),
 * 'hung' (tier 1: closed; native aborts the executor).
 */
function opHangCheck(opts) {
  if (!AGENT_ID_RE.test(opts.agentId || '')) return { ok: false, error: 'agent-id' };
  const paths = agentPaths(opts.home, opts.agentId);
  const runs = readAuditRuns(paths);
  const launchStart = Number.isSafeInteger(opts.launchStartedAtMs) ? opts.launchStartedAtMs : 0;
  const open = runs.filter((r) => isOpenRun(r) && r.startMs >= launchStart - 1000);
  const run = open.length ? open[open.length - 1] : null;
  const base = { ok: true, op: 'hang-check', closed: [], refire: [] };
  if (!run) return Object.assign(base, { verdict: 'none' });
  // Taken before the stream is read: a line written in between is past this
  // size, so native's re-check sees it (never missed).
  const progressBytesBefore = fileSize(paths.progressFile);
  const progress = progressForRun(paths, run);
  // No stream for this run (write failed, rotated away), a capped one, or one
  // already rotated to .prev (a later run owns progress.jsonl): silence proves nothing.
  if (!progress || progress.capped || progress.file !== paths.progressFile) return Object.assign(base, { verdict: 'unknown' });
  const events = progress.events;
  const lastMs = lastProgressMs(events);
  const since = Math.max(run.startMs, Number.isFinite(lastMs) ? lastMs : 0);
  const noProgressMs = Math.max(0, opts.nowMs - since);
  if (!opts.workerAlive) {
    if (isDeliberateWait(events, run.events)) return Object.assign(base, { verdict: 'waiting', noProgressMs });
    if (noProgressMs < HANG_ABORT_NO_PROGRESS_MS) return Object.assign(base, { verdict: 'ok', noProgressMs });
    // Tier 1 decides only: nothing is written until native has frozen the
    // executor tree and re-checked (a worker or progress may have appeared
    // since its sample). progressBytes is the stream size this verdict read:
    // any non-heartbeat line past it is progress.
    return Object.assign(base, {
      verdict: 'hung',
      noProgressMs,
      runStartTs: run.startTs,
      progressBytes: progressBytesBefore,
    });
  }
  if (noProgressMs < HANG_SUSPECT_NO_PROGRESS_MS || run.suspect) return Object.assign(base, { verdict: 'ok', noProgressMs });
  const ctx = baseCtx(opts, opts.agentId, {
    reason: REASON_HUNG_SUSPECT, detectedBy: 'watchdog', noProgressMs, feedbackLines: readFeedback(paths),
  });
  const out = closeRun(ctx, run, matchLaunches(runs, readLaunches(paths, opts.agentId)), readPlan(paths));
  base.closed.push(out.closed);
  return Object.assign(base, { verdict: 'suspect', noProgressMs });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : '1';
    out[key] = val;
  }
  return out;
}

function intArg(v) {
  if (typeof v !== 'string' || !/^-?\d{1,16}$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

function runOp(rawOpts) {
  const home = rawOpts.home;
  if (typeof home !== 'string' || !path.isAbsolute(home)) return { ok: false, error: 'home' };
  const opts = Object.assign({
    procDeps: defaultProcDeps(),
    nowMs: Date.now(),
  }, rawOpts);
  if (opts.executorModule === undefined) {
    let loaded;
    opts.executorModule = () => {
      if (loaded === undefined) loaded = loadExecutorModule(opts.executorPath || path.join(home, '.shelly-plan-executor.js'));
      return loaded;
    };
  }
  const fn = opts.op === 'finalize' ? opFinalize : opts.op === 'sweep' ? opSweep : opts.op === 'hang-check' ? opHangCheck
    : opts.op === 'refire-result' ? opRefireResult : opts.op === 'refire-request' ? opRefireRequest : opts.op === 'hang-abort' ? opHangAbort
      : opts.op === 'hang-cancel' ? opHangCancel : null;
  if (!fn) return { ok: false, error: 'op' };
  return withRecoveryLock(home, () => fn(opts));
}

function main(argv) {
  const a = parseCliArgs(argv);
  let result;
  try {
    result = runOp({
      op: a.op,
      home: a.home,
      agentId: a['agent-id'],
      exitCode: intArg(a['exit-code']),
      launchStartedAtMs: intArg(a['launch-started-at-ms']),
      launchId: a['launch-id'],
      timedOut: a['timed-out'] === '1',
      workerAlive: a['worker-alive'] === '1',
      runId: a['run-id'],
      refireRunId: a['refire-run-id'],
      dispatched: a.dispatched,
      runStartTs: a['run-start-ts'],
      noProgressMs: intArg(a['no-progress-ms']),
      why: a.why,
      pipelineId: a['pipeline-id'],
      principal: a.principal,
      executorPath: a.executor,
    });
  } catch (e) {
    result = { ok: false, error: 'internal' };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result && result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  RECOVERY_SCRIPT_VERSION,
  REFIRE_WINDOW_MS,
  REFIRE_PENDING_SETTLE_MS,
  FREEZE_STALE_MS,
  HANG_ABORT_NO_PROGRESS_MS,
  HANG_SUSPECT_NO_PROGRESS_MS,
  SWEEP_YOUNG_RUN_GRACE_MS,
  LOOKBACK_MS,
  FEEDBACK_FILE_REL,
  pairRuns,
  matchLaunches,
  isScheduleLaunch,
  lastStepFromProgress,
  lastStepFromAudit,
  lastProgressMs,
  isDeliberateWait,
  stepKind,
  articleFolderKey,
  refireDecision,
  refireRequestDecision,
  REFIRE_REQUEST_DAILY_MAX,
  writeDays,
  signalOf,
  isExecutorCmdline,
  defaultProcDeps,
  freezePidVerdict,
  appendLine,
  readAllAuditRuns,
  runOp,
  main,
};
