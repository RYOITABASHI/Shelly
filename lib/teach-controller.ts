/**
 * lib/teach-controller.ts — side-effecting half of `shelly teach`.
 *
 * Control path (native PTY terminal): `shelly teach <action>` runs the
 * `$HOME/bin/shelly` helper (HomeInitializer.kt, SHELLY_HELPER_SHIM), which
 * appends `teach:<reqId>:<action>:<name>` to `$HOME/.shelly-command-queue`
 * and blocks on `$HOME/.shelly-teach-result-<reqId>.json`. app/_layout.tsx's
 * drainCommandQueue hands the line to handleTeachQueueLine() below — the
 * exact round-trip shape `shelly install` already uses.
 *
 * Capture path: while recording, `$HOME/.shelly-teach.jsonl` exists and the
 * bash prompt hook appends one JSON line per finished command. start()
 * creates it, stop()/cancel() delete it. No other files or directories.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { logInfo, logError } from '@/lib/debug-logger';
import { t } from '@/lib/i18n';
import { saveWorkflow, loadWorkflow } from '@/lib/workflow-manager';
import { useTeachStore } from '@/store/teach-store';
import { useSettingsStore } from '@/store/settings-store';
import {
  TEACH_LLM_SYSTEM_PROMPT,
  TEACH_MAX_DURATION_MS,
  TEACH_MAX_STEPS,
  TEACH_NOTICE_PREFIX,
  buildTeachLlmUserPrompt,
  fallbackConvert,
  formatWorkflowPreview,
  parseTeachLlmResponse,
  parseTeachLog,
  sanitizeSteps,
  sanitizeWorkflowName,
  shouldAutoStop,
  type TeachStep,
  type TeachWorkflowDraft,
} from '@/lib/teach-mode';

const LOG = 'Teach';
const POLL_MS = 3000;
const LLM_TIMEOUT_MS = 45_000;

export type TeachAction = 'start' | 'stop' | 'cancel' | 'status';
export type TeachResult = { ok: boolean; lines: string[]; error?: string };

/** File access, injectable for tests. Paths are file:// URIs. */
export type TeachIO = {
  homeUri: () => string;
  read: (uri: string) => Promise<string | null>;
  write: (uri: string, content: string) => Promise<void>;
  remove: (uri: string) => Promise<void>;
};

export const defaultTeachIO: TeachIO = {
  homeUri: () => `${FileSystem.documentDirectory}home`,
  read: async (uri) => {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) return null;
      return await FileSystem.readAsStringAsync(uri);
    } catch {
      return null;
    }
  },
  write: (uri, content) => FileSystem.writeAsStringAsync(uri, content),
  remove: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
};

export type TeachConverter = (steps: TeachStep[], requestedName?: string) => Promise<TeachWorkflowDraft>;

export type TeachDeps = {
  io: TeachIO;
  convert: TeachConverter;
  save: (draft: TeachWorkflowDraft) => Promise<void>;
  exists: (name: string) => Promise<boolean>;
  now: () => number;
};

const logUri = (io: TeachIO) => `${io.homeUri()}/.shelly-teach.jsonl`;

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Remembered so a `shelly teach stop` typed after an auto-stop explains
 *  what happened instead of a bare "not recording". */
let lastAutoSaved: string | null = null;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function readSteps(io: TeachIO): Promise<TeachStep[]> {
  const content = await io.read(logUri(io));
  if (!content || content.startsWith(TEACH_NOTICE_PREFIX)) return [];
  return parseTeachLog(content);
}

async function uniqueName(base: string, exists: (n: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Stop capture, convert, save. Shared by stop() and auto-stop. */
async function finishRecording(deps: TeachDeps): Promise<TeachResult> {
  const store = useTeachStore.getState();
  const rec = store.recording;
  if (!rec) return { ok: false, lines: [], error: t('teach.not_recording') };
  if (store.finishing) return { ok: false, lines: [], error: t('teach.busy') };
  store.setFinishing(true);
  stopPolling();
  try {
    const raw = await readSteps(deps.io);
    // Delete the log first so bash stops capturing even if conversion fails.
    await deps.io.remove(logUri(deps.io)).catch(() => {});
    store.setRecording(null);
    const { steps, secretsDropped } = sanitizeSteps(raw);
    logInfo(LOG, `stop: ${raw.length} raw step(s), ${steps.length} kept, ${secretsDropped} secret-like dropped`);
    const lines: string[] = [];
    if (secretsDropped > 0) lines.push(t('teach.secrets_dropped', { count: secretsDropped }));
    if (steps.length === 0) {
      lines.push(t('teach.nothing_recorded'));
      return { ok: true, lines };
    }
    let draft = await deps.convert(steps, rec.name);
    if (draft.commands.length === 0) {
      lines.push(t('teach.nothing_recorded'));
      return { ok: true, lines };
    }
    draft = { ...draft, name: await uniqueName(draft.name, deps.exists) };
    await deps.save(draft);
    logInfo(LOG, `saved workflow '${draft.name}' (${draft.commands.length} cmds, via ${draft.source})`);
    const path = `~/.shelly/workflows/${draft.name}.sh`;
    lines.push(
      ...formatWorkflowPreview(draft, {
        title: t('teach.preview_title', { name: draft.name }),
        saved: t('teach.saved_to', { path }),
      }),
      t(draft.source === 'llm' ? 'teach.source_llm' : 'teach.source_fallback'),
      t('teach.run_hint', { path }),
      t('teach.nothing_ran'),
    );
    return { ok: true, lines };
  } catch (e: any) {
    logError(LOG, 'stop failed', e);
    return { ok: false, lines: [], error: t('teach.save_failed', { error: e?.message || String(e) }) };
  } finally {
    useTeachStore.getState().setFinishing(false);
  }
}

async function autoStopTick(deps: TeachDeps): Promise<void> {
  const rec = useTeachStore.getState().recording;
  if (!rec || useTeachStore.getState().finishing) return;
  const steps = (await readSteps(deps.io)).filter((s) => !/^\s*shelly\s+teach(\s|$)/.test(s.cmd));
  const reason = shouldAutoStop(rec.startedAt, steps.length, deps.now());
  if (!reason) return;
  logInfo(LOG, `auto-stop (${reason}) after ${steps.length} step(s)`);
  const result = await finishRecording(deps);
  const reasonText =
    reason === 'steps'
      ? t('teach.autostop_steps', { max: TEACH_MAX_STEPS })
      : t('teach.autostop_time', { minutes: Math.round(TEACH_MAX_DURATION_MS / 60000) });
  const savedLine = result.ok ? result.lines.find((l) => l.includes('.shelly/workflows/')) : undefined;
  lastAutoSaved = savedLine ?? null;
  // The bash hook prints a TEACH_NOTICE_PREFIX line once on the next prompt
  // and deletes the file — the only way to surface this in the PTY.
  const notice = `${reasonText} ${result.ok ? (savedLine ?? t('teach.nothing_recorded')).trim() : result.error ?? ''}`;
  await deps.io.write(logUri(deps.io), `${TEACH_NOTICE_PREFIX}${notice.replace(/[\r\n]+/g, ' ')}\n`).catch(() => {});
}

export async function runTeachCommand(
  action: string,
  name: string | undefined,
  deps: TeachDeps = defaultTeachDeps,
): Promise<TeachResult> {
  const store = useTeachStore.getState();
  switch (action) {
    case 'start': {
      if (store.recording) {
        return { ok: false, lines: [], error: t('teach.already_recording') };
      }
      const clean = sanitizeWorkflowName(name);
      // Empty log = recording on; the bash hook keys off its existence.
      await deps.io.write(logUri(deps.io), '');
      store.setRecording({ name: clean || undefined, startedAt: deps.now() });
      lastAutoSaved = null;
      stopPolling();
      pollTimer = setInterval(() => {
        void autoStopTick(deps).catch((e) => logError(LOG, 'auto-stop tick failed', e));
      }, POLL_MS);
      logInfo(LOG, `start${clean ? ` '${clean}'` : ''}`);
      return {
        ok: true,
        lines: [
          t('teach.started', { name: clean || t('teach.unnamed') }),
          t('teach.started_hint', { max: TEACH_MAX_STEPS, minutes: Math.round(TEACH_MAX_DURATION_MS / 60000) }),
        ],
      };
    }
    case 'stop': {
      if (!store.recording && lastAutoSaved) {
        return { ok: true, lines: [t('teach.already_autosaved'), lastAutoSaved.trim()] };
      }
      return finishRecording(deps);
    }
    case 'cancel': {
      if (!store.recording) return { ok: false, lines: [], error: t('teach.not_recording') };
      stopPolling();
      await deps.io.remove(logUri(deps.io)).catch(() => {});
      store.setRecording(null);
      logInfo(LOG, 'cancel');
      return { ok: true, lines: [t('teach.cancelled')] };
    }
    case 'status': {
      const rec = store.recording;
      if (!rec) return { ok: true, lines: [t('teach.status_idle')] };
      const { steps } = sanitizeSteps(await readSteps(deps.io));
      const minutes = Math.floor((deps.now() - rec.startedAt) / 60000);
      return {
        ok: true,
        lines: [
          t('teach.status_recording', {
            name: rec.name || t('teach.unnamed'),
            minutes,
            count: steps.length,
            max: TEACH_MAX_STEPS,
          }),
          ...steps.slice(-5).map((s) => `  ${s.exitCode === null ? '?' : s.exitCode === 0 ? '✓' : '✗'} ${s.cmd}`),
        ],
      };
    }
    default:
      return { ok: true, lines: usageLines() };
  }
}

export function usageLines(): string[] {
  return [
    'Usage: shelly teach <start [name]|stop|cancel|status>',
    '',
    t('teach.usage_start'),
    t('teach.usage_stop'),
    t('teach.usage_cancel'),
    t('teach.usage_status'),
  ];
}

// ─── Conversion (LLM with deterministic fallback) ───────────────────────────

type ChatTurn = { role: 'system' | 'user'; content: string };

/** Ask the available models in on-device-first order: local LLM, then
 *  Cerebras/Groq if keys exist. Steps are already secret-filtered. Any
 *  failure or ungrounded answer falls back to fallbackConvert(). */
export const convertWithLlm: TeachConverter = async (steps, requestedName) => {
  const userPrompt = buildTeachLlmUserPrompt(steps);
  const s = useSettingsStore.getState().settings;
  const attempts: Array<{ label: string; run: () => Promise<string | null> }> = [];
  if (s.localLlmEnabled && s.localLlmUrl && s.localLlmModel) {
    attempts.push({
      label: 'local',
      run: async () => {
        const { ollamaChat } = await import('./local-llm');
        const messages: ChatTurn[] = [
          { role: 'system', content: TEACH_LLM_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ];
        const r = await ollamaChat(
          { baseUrl: s.localLlmUrl, model: s.localLlmModel, enabled: true },
          messages,
          LLM_TIMEOUT_MS,
          undefined,
          1024,
        );
        return r.success ? r.content : null;
      },
    });
  }
  if (s.cerebrasApiKey) {
    attempts.push({
      label: 'cerebras',
      run: async () => {
        const { cerebrasChatStream, CEREBRAS_DEFAULT_MODEL } = await import('./cerebras');
        let acc = '';
        const r = await cerebrasChatStream(
          s.cerebrasApiKey,
          userPrompt,
          (text) => { if (text) acc += text; },
          s.cerebrasModel ?? CEREBRAS_DEFAULT_MODEL,
          [],
          undefined,
          TEACH_LLM_SYSTEM_PROMPT,
        );
        return r.success ? acc : null;
      },
    });
  }
  if (s.groqApiKey) {
    attempts.push({
      label: 'groq',
      run: async () => {
        const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('./groq');
        let acc = '';
        const r = await groqChatStream(
          s.groqApiKey,
          userPrompt,
          (text) => { if (text) acc += text; },
          s.groqModel ?? GROQ_DEFAULT_MODEL,
          [],
          undefined,
          TEACH_LLM_SYSTEM_PROMPT,
        );
        return r.success ? acc : null;
      },
    });
  }
  for (const attempt of attempts) {
    try {
      const raw = await attempt.run();
      const draft = raw ? parseTeachLlmResponse(raw, steps, requestedName) : null;
      if (draft) {
        logInfo(LOG, `converted via ${attempt.label}`);
        return draft;
      }
      logInfo(LOG, `${attempt.label} answer unusable, trying next`);
    } catch (e: any) {
      logInfo(LOG, `${attempt.label} failed (${e?.message || String(e)}), trying next`);
    }
  }
  return fallbackConvert(steps, requestedName);
};

export const defaultTeachDeps: TeachDeps = {
  io: defaultTeachIO,
  convert: convertWithLlm,
  save: (d) => saveWorkflow(d.name, d.commands, d.description),
  exists: async (name) => (await loadWorkflow(name)) !== null,
  now: () => Date.now(),
};

// ─── Command-queue bridge ───────────────────────────────────────────────────

const REQ_ID_RE = /^[0-9]+-[0-9a-f]{1,16}$/;

/**
 * Handle one `teach:<reqId>:<action>[:<name>]` queue line and write the
 * result file the helper shim is blocking on. Fire-and-forget from the
 * queue loop (stop may wait on an LLM).
 */
export async function handleTeachQueueLine(line: string, io: TeachIO = defaultTeachIO): Promise<void> {
  const parts = line.split(':');
  const reqId = parts[1] ?? '';
  const action = parts[2] ?? '';
  const name = parts.slice(3).join(':') || undefined;
  if (!REQ_ID_RE.test(reqId)) {
    logError(LOG, `malformed teach queue line: ${line.slice(0, 64)}`);
    return;
  }
  let result: TeachResult;
  try {
    result = await runTeachCommand(action, name);
  } catch (e: any) {
    result = { ok: false, lines: [], error: e?.message || String(e) };
  }
  try {
    await io.write(`${io.homeUri()}/.shelly-teach-result-${reqId}.json`, JSON.stringify(result));
  } catch (e) {
    logError(LOG, `failed to write result for ${reqId}`, e);
  }
}

/** App-start sweep: a log left behind by a killed app process would make
 *  bash append forever with no recorder listening. */
export async function sweepOrphanedTeachLog(io: TeachIO = defaultTeachIO): Promise<void> {
  if (useTeachStore.getState().recording) return;
  const content = await io.read(logUri(io));
  if (content === null || content.startsWith(TEACH_NOTICE_PREFIX)) return;
  await io.remove(logUri(io)).catch(() => {});
  logInfo(LOG, 'removed orphaned teach log from a previous app session');
}

/** Test-only reset of module-level timers/state. */
export function __resetTeachControllerForTests(): void {
  stopPolling();
  lastAutoSaved = null;
}

export const __autoStopTickForTests = autoStopTick;
