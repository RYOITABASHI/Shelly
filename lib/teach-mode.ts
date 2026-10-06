/**
 * lib/teach-mode.ts — pure logic for `shelly teach` ("show it once, it saves
 * a reusable routine").
 *
 * Capture happens in the native PTY's bash prompt hook (HomeInitializer.kt,
 * `__shelly_teach_capture`): while `$HOME/.shelly-teach.jsonl` exists, every
 * prompt appends one JSON line `{n, cmd, ec, cwd, ts}` for the command that
 * just finished. Everything below is side-effect free so it can be unit
 * tested; the IO/zustand side lives in lib/teach-controller.ts.
 */

import { redactSecretsText } from '@/lib/redact-secrets';
import { scanForSecrets } from '@/lib/secret-guard';

export const TEACH_MAX_STEPS = 50;
export const TEACH_MAX_DURATION_MS = 30 * 60 * 1000;
/** Prefix the bash hook recognizes as "print this line once, then delete
 *  the log file" — used to surface auto-stop notices in the terminal. */
export const TEACH_NOTICE_PREFIX = '#NOTICE ';

export type TeachStep = {
  /** bash history number — used only for ordering/dedup. */
  n: number;
  cmd: string;
  /** null when the hook could not observe an exit status. */
  exitCode: number | null;
  /** Directory the command ran IN. The bash hook records $PWD at the next
   *  prompt (i.e. after the command), so sanitizeSteps() shifts it to the
   *  previous entry's value; parseTeachLog() returns the raw hook value. */
  cwd: string;
  ts: number;
  /** $$ of the shell that ran the command (the hook only records the shell
   *  that ran `shelly teach start`; this is a second, JS-side filter). */
  pid?: number;
};

export type TeachConverterSource = 'local' | 'cloud' | 'fallback';

export type TeachWorkflowDraft = {
  name: string;
  description: string;
  commands: string[];
  /** Which converter produced this draft (shown to the user on stop). */
  source: TeachConverterSource;
};

/** Parse the hook's JSONL log. Malformed lines (half-written append, odd
 *  escaping from an exotic command) are skipped, never fatal. */
export function parseTeachLog(content: string, onlyPid?: number): TeachStep[] {
  const steps: TeachStep[] = [];
  const seen = new Set<number>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj.cmd !== 'string') continue;
    const pid = Number(obj.pid);
    if (onlyPid !== undefined && Number.isFinite(pid) && pid !== onlyPid) continue;
    const n = Number(obj.n);
    if (Number.isFinite(n) && seen.has(n)) continue;
    if (Number.isFinite(n)) seen.add(n);
    const ec = obj.ec === '' || obj.ec === null || obj.ec === undefined ? NaN : Number(obj.ec);
    steps.push({
      n: Number.isFinite(n) ? n : steps.length,
      cmd: obj.cmd,
      exitCode: Number.isInteger(ec) && ec >= 0 && ec <= 255 ? ec : null,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
      ts: Number(obj.ts) || 0,
      ...(Number.isFinite(pid) ? { pid } : {}),
    });
  }
  return steps;
}

/** True for the teach control commands themselves (never part of a routine). */
export function isTeachControlCommand(cmd: string): boolean {
  return /^\s*shelly\s+teach(\s|$)/.test(cmd);
}

/** True when a command contains something that looks like a credential. */
export function looksLikeSecret(cmd: string): boolean {
  if (redactSecretsText(cmd) !== cmd) return true;
  if (scanForSecrets(cmd).hasSecret) return true;
  // CLI-shaped credentials the shared pattern lists don't cover.
  return TEACH_EXTRA_SECRET_PATTERNS.some((re) => re.test(cmd));
}

const TEACH_EXTRA_SECRET_PATTERNS: RegExp[] = [
  /--(?:password|passwd|pass|token|secret|api-key|apikey|auth)[= ]\S+/i,
  /\bsshpass\s+-p\s*\S+/,
  /\bcurl\b.*\s-u\s*\S+:\S+/,
  /\bAuthorization:\s*\S+/i,
  /\b(?:mysql|psql)\b.*\s-p\S+/,
  /:\/\/[^\s/:@]+:[^\s/@]+@/, // user:pass@host URLs
  // Short env-style assignments the shared lists' length floors miss
  // (`export GITHUB_TOKEN=ghp_abc`, `PASSWORD=abc ./run`).
  // The keyword must start the name or follow `_` (no `MONKEY=`), and the
  // generic KEY / PASS only count with a prefix segment (`SSH_KEY=`,
  // `DB_PASS=`) so prose like `-m "KEY=value docs"` is not flagged.
  /(?:^|[^A-Za-z0-9_])(?:(?:[A-Z0-9]+_)*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)|(?:[A-Z0-9]+_)+(?:KEY|PASS))=\S+/,
  /-H\s*['"]?[A-Za-z-]*(?:Key|Token|Authorization)\s*:/i,
  /\baws_secret_access_key\b/i,
  /\bsudo\s+(?:-\S+\s+)*-S\b/,
];

/**
 * Drop control commands and secret-bearing commands; cap at TEACH_MAX_STEPS.
 * Returns how many steps were dropped as secrets so the caller can tell the
 * user (silently losing a step would be surprising).
 */
export function sanitizeSteps(steps: TeachStep[]): { steps: TeachStep[]; secretsDropped: number } {
  let secretsDropped = 0;
  const kept: TeachStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const cmd = steps[i].cmd.trim();
    // Pre-command cwd = the previous entry's post-command $PWD (the first
    // entry is normally `shelly teach start`, which never changes dir).
    const s = { ...steps[i], cwd: i > 0 ? steps[i - 1].cwd : isCd(cmd) ? '' : steps[i].cwd };
    if (!cmd || isTeachControlCommand(cmd)) continue;
    if (looksLikeSecret(cmd)) {
      secretsDropped++;
      continue;
    }
    kept.push({ ...s, cmd });
  }
  return { steps: kept.slice(0, TEACH_MAX_STEPS), secretsDropped };
}

/** Pure navigation/noise commands — dropped by the deterministic fallback. */
const NOISE_RE = /^(ls|ll|la|l|clear|pwd|history|exit|true|reset|tree|cls)(\s|$)/;

export function isNoiseCommand(cmd: string): boolean {
  return NOISE_RE.test(cmd.trim());
}

function isCd(cmd: string): boolean {
  return /^cd(\s|$)/.test(cmd.trim());
}

function isAbsoluteCd(cmd: string): boolean {
  return /^cd(\s+['"]?[/~]|\s*$)/.test(cmd.trim());
}

/**
 * Deterministic conversion used when no LLM is available (or its answer is
 * rejected): keep successful (or unknown-status) commands verbatim, drop
 * failed ones and pure navigation noise, but preserve `cd` so later steps
 * still run in the right directory. A leading `cd <recording start cwd>` is
 * added unless the routine already starts with an absolute `cd`, so it is
 * reproducible from any shell. Expects sanitizeSteps() output (pre-cwd).
 */
export function fallbackConvert(steps: TeachStep[], requestedName?: string, now = Date.now()): TeachWorkflowDraft {
  const commands: string[] = [];
  for (const s of steps) {
    if (s.exitCode !== null && s.exitCode !== 0) continue;
    if (isNoiseCommand(s.cmd)) continue;
    // Collapse immediately repeated identical commands (retries).
    if (commands.length && commands[commands.length - 1] === s.cmd) continue;
    commands.push(s.cmd);
  }
  // Trailing cd's do nothing useful.
  while (commands.length && isCd(commands[commands.length - 1])) commands.pop();
  // Only an absolute first `cd` makes the start directory irrelevant.
  const startCwd = steps[0]?.cwd;
  if (commands.length && startCwd && !isAbsoluteCd(commands[0])) {
    commands.unshift(`cd ${shellQuote(startCwd)}`);
  }
  const name = sanitizeWorkflowName(requestedName) || defaultWorkflowName(commands, now);
  return {
    name,
    description: `Recorded with shelly teach (${commands.length} step${commands.length === 1 ? '' : 's'})`,
    commands,
    source: 'fallback',
  };
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./~@%+=:,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Workflow names become a file name inside a double-quoted shell path in
 *  lib/workflow-manager.ts, so only a strict safe charset survives. */
export function sanitizeWorkflowName(name: string | undefined | null): string {
  if (!name) return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

function defaultWorkflowName(commands: string[], now: number): string {
  const firstReal = commands.find((c) => !isCd(c));
  const word = sanitizeWorkflowName(firstReal?.split(/\s+/)[0] ?? '');
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `teach-${word ? `${word}-` : ''}${stamp}`;
}

/** Recording auto-stop rule. */
export function shouldAutoStop(
  startedAt: number,
  stepCount: number,
  now: number,
): 'steps' | 'time' | null {
  if (stepCount >= TEACH_MAX_STEPS) return 'steps';
  if (now - startedAt >= TEACH_MAX_DURATION_MS) return 'time';
  return null;
}

// ─── LLM pass ───────────────────────────────────────────────────────────────

export const TEACH_LLM_SYSTEM_PROMPT =
  'You turn a recorded terminal session into a reusable shell routine. ' +
  'Input: numbered steps with exit code and working directory. ' +
  'Rules: drop typos, failed attempts that were later retried, and pure navigation ' +
  '(ls, clear, pwd) unless the routine needs it. Keep `cd` when later steps depend on it. ' +
  'Copy kept commands EXACTLY as recorded, in the same order; never edit, merge or invent ' +
  'commands. The only allowed change: replace one whole word that is an obviously variable ' +
  'value (a file name, branch, message) with $1, $2, ... in order of first use. ' +
  'Reply with ONLY a JSON object: {"name": "short-kebab-name", "description": "one sentence", ' +
  '"commands": ["cmd", ...], "params": ["what $1 means", ...]}';

export function buildTeachLlmUserPrompt(steps: TeachStep[]): string {
  return steps
    .map((s, i) => `${i + 1}. [exit ${s.exitCode === null ? '?' : s.exitCode}] (${s.cwd || '?'}) ${s.cmd}`)
    .join('\n');
}

/**
 * Split a command into shell-ish words, keeping quotes and backslash
 * escapes inside the token (`-m "fix typo"` -> [`-m`, `"fix typo"`]). Only
 * used to compare an LLM answer against the recording token-by-token, so
 * it does not need full shell grammar — just stable, identical splitting
 * of both sides.
 */
export function tokenizeCommand(cmd: string): string[] {
  return tokenizeWithSpans(cmd).map((t) => t.text);
}

type Token = { text: string; start: number; end: number };

function tokenizeWithSpans(cmd: string): Token[] {
  const tokens: Token[] = [];
  let cur = '';
  let start = 0;
  let inTok = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inTok) tokens.push({ text: cur, start, end: i });
      cur = '';
      inTok = false;
      continue;
    }
    if (!inTok) start = i;
    inTok = true;
    cur += ch;
    if (ch === '\\' && i + 1 < cmd.length) cur += cmd[++i];
    else if (ch === '"' || ch === "'") quote = ch;
  }
  if (inTok) tokens.push({ text: cur, start, end: cmd.length });
  return tokens;
}

/** `$1`, `"$1"`, `${1}`, `"${1}"` — the only placeholder shapes accepted. */
const PLACEHOLDER_RE = /^("?)\$(?:([1-9])|\{([1-9])\})\1$/;
/** A recorded token may only be parameterized if it is a plain value. */
const SHELL_META_RE = /[;&|`$<>(){}\\*?![\]#]/;

function placeholderIndex(tok: string): number | null {
  const m = PLACEHOLDER_RE.exec(tok);
  return m ? Number(m[2] ?? m[3]) : null;
}

/**
 * Match one LLM-proposed command against one recorded command. Tokens must
 * be identical except where the LLM put a `$N` placeholder, which may only
 * replace a plain-value recorded token (never the program name, never a
 * token containing shell metacharacters). Because every other token must be
 * byte-identical, the LLM cannot introduce `;`, `&&`, `|`, `$(`, backticks,
 * redirections or globs that were not already in the recorded command.
 * Returns the placeholder -> recorded value bindings, or null.
 */
function matchAgainstRecorded(out: string[], rec: string[]): Map<number, string> | null {
  if (out.length !== rec.length || out.length === 0) return null;
  const bindings = new Map<number, string>();
  for (let i = 0; i < out.length; i++) {
    if (out[i] === rec[i]) continue;
    const idx = placeholderIndex(out[i]);
    if (idx === null || i === 0) return null;
    // Nothing after an unquoted comment token is real shell input.
    if (rec.slice(0, i).some((t) => t.startsWith('#'))) return null;
    const value = rec[i].replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!value || SHELL_META_RE.test(value) || /['"]/.test(value)) return null;
    if (bindings.has(idx) && bindings.get(idx) !== value) return null;
    bindings.set(idx, value);
  }
  return bindings;
}

/** `$1` -> `"${1:?missing arg 1}"` so a workflow run without its argument
 *  stops with a clear message instead of running with an empty value. */
export function guardPlaceholderToken(tok: string): string {
  const idx = placeholderIndex(tok);
  return idx === null ? tok : `"\${${idx}:?missing arg ${idx}}"`;
}

/**
 * Parse + validate an LLM answer. Returns null (-> deterministic fallback)
 * unless the commands are an in-order subsequence of the recording that
 * only omits droppable steps (failed / noise / immediate repeats), each
 * matching its recorded command exactly apart from whole-token `$N`
 * placeholders (see matchAgainstRecorded). Every `$N` must bind to the same
 * recorded value everywhere, and placeholders must be numbered 1..k with no
 * gaps. This keeps a small local model from smuggling new commands into a
 * routine the user will later run.
 */
export function parseTeachLlmResponse(
  raw: string,
  steps: TeachStep[],
  requestedName?: string,
  now = Date.now(),
  source: 'local' | 'cloud' = 'local',
): TeachWorkflowDraft | null {
  if (!raw) return null;
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.commands)) return null;
  const recordedSpans = steps.map((s) => tokenizeWithSpans(s.cmd));
  const recorded = recordedSpans.map((toks) => toks.map((t) => t.text));
  const bindings = new Map<number, string>();
  const commands: string[] = [];
  // The LLM may only drop what the deterministic filter would also drop:
  // failed steps, pure navigation noise, and immediate repeats. Dropping a
  // successful `cd` (or anything else) could make a later step run in the
  // wrong directory — e.g. `cd /p`, `cd build`, `rm -rf *` must never
  // become `cd /p`, `rm -rf *`.
  const droppable = (i: number): boolean =>
    (steps[i].exitCode !== null && steps[i].exitCode !== 0) ||
    isNoiseCommand(steps[i].cmd) ||
    (i > 0 && steps[i - 1].cmd === steps[i].cmd);
  let cursor = 0;
  for (const c of obj.commands) {
    if (typeof c !== 'string') return null;
    if (!c.trim()) continue;
    if (/<redacted/i.test(c) || looksLikeSecret(c)) return null;
    const outTokens = tokenizeCommand(c.trim());
    let matched: Map<number, string> | null = null;
    while (cursor < recorded.length && !(matched = matchAgainstRecorded(outTokens, recorded[cursor]))) {
      if (!droppable(cursor)) return null;
      cursor++;
    }
    if (!matched) return null;
    cursor++;
    for (const [k, v] of matched) {
      if (bindings.has(k) && bindings.get(k) !== v) return null;
      bindings.set(k, v);
    }
    // Rebuild from the RECORDED text so its exact whitespace (newlines in a
    // multi-line loop, alignment) survives; only placeholder spans change.
    const recCmd = steps[cursor - 1].cmd;
    const spans = recordedSpans[cursor - 1];
    let rebuilt = recCmd;
    for (let i = outTokens.length - 1; i >= 0; i--) {
      if (outTokens[i] === spans[i].text) continue;
      rebuilt = rebuilt.slice(0, spans[i].start) + guardPlaceholderToken(outTokens[i]) + rebuilt.slice(spans[i].end);
    }
    commands.push(rebuilt);
  }
  for (; cursor < steps.length; cursor++) if (!droppable(cursor)) return null;
  if (commands.length === 0) return null;
  // Same start-directory anchoring as fallbackConvert().
  const startCwd = steps[0]?.cwd;
  if (startCwd && !isAbsoluteCd(commands[0])) commands.unshift(`cd ${shellQuote(startCwd)}`);
  const used = [...bindings.keys()].sort((a, b) => a - b);
  if (used.some((k, i) => k !== i + 1)) return null;
  const params: string[] = Array.isArray(obj.params)
    ? obj.params.filter((p: unknown): p is string => typeof p === 'string').slice(0, used.length)
    : [];
  const baseDesc = typeof obj.description === 'string' ? obj.description.replace(/[\r\n]+/g, ' ').trim().slice(0, 160) : '';
  const paramDesc = used.length
    ? ` Params: ${used.map((k) => `$${k}=${(params[k - 1] ?? `e.g. ${bindings.get(k)}`).replace(/[\r\n]+/g, ' ')}`).join(', ')}`
    : '';
  const name =
    sanitizeWorkflowName(requestedName) ||
    sanitizeWorkflowName(typeof obj.name === 'string' ? obj.name : '') ||
    fallbackConvert(steps, undefined, now).name;
  return {
    name,
    description: (baseDesc || 'Recorded with shelly teach') + paramDesc,
    commands,
    source,
  };
}

export type TeachLlmSettings = {
  localLlmEnabled?: boolean;
  localLlmUrl?: string;
  localLlmModel?: string;
  cerebrasApiKey?: string;
  groqApiKey?: string;
  teachAllowCloudLlm?: boolean;
};

/**
 * Converters to try, in order. Recorded commands can reveal paths, hosts
 * and project names even after secret filtering, so they stay on-device by
 * default: cloud providers are only added when the user explicitly opted in
 * via settings.teachAllowCloudLlm. An empty list means rule-based only.
 */
export function teachConverterOrder(s: TeachLlmSettings): Array<'local' | 'cerebras' | 'groq'> {
  const order: Array<'local' | 'cerebras' | 'groq'> = [];
  if (s.localLlmEnabled && s.localLlmUrl && s.localLlmModel) order.push('local');
  if (s.teachAllowCloudLlm === true) {
    if (s.cerebrasApiKey) order.push('cerebras');
    if (s.groqApiKey) order.push('groq');
  }
  return order;
}

/** Plain-text preview printed in the terminal after stop. */
export function formatWorkflowPreview(
  draft: TeachWorkflowDraft,
  labels: { title: string; saved: string },
): string[] {
  return [
    labels.title,
    `  ${draft.description}`,
    '─────────────────────────────',
    ...draft.commands.map((c, i) => `  ${String(i + 1).padStart(2)}. ${c}`),
    '─────────────────────────────',
    labels.saved,
  ];
}
