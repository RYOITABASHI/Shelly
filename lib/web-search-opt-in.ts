/**
 * lib/web-search-opt-in.ts — "Web search on notification-triggered runs", per
 * article pipeline (search parity, executor v68).
 *
 * A notification-triggered article run is tainted, and the executor refuses
 * its research step's hosted web search unless native exports
 * SHELLY_WEB_SEARCH_OPT_IN_SHA256 equal to the plan's current definition hash.
 * The owner turns that on per pipeline in Settings only; native
 * (WebSearchOptInStore.kt: Keystore-MAC'd prefs, re-keyed on every write)
 * computes and stores the hash itself, so any later edit of the pipeline
 * definition makes the consent lapse (shown as "lapsed", treated as off).
 *
 * Who can turn it on: only {@link setWebSearchOptIn} with enabled=true, called
 * only from the Settings toggle. Never from chat, MCP, a terminal request,
 * agent output or a file. OFF is safe from anywhere.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logInfo, logWarn } from '@/lib/debug-logger';

export type WebSearchOptInState = 'on' | 'off' | 'lapsed';

export type WebSearchOptInPipeline = {
  agentId: string;
  name: string | null;
  pipelineId: string | null;
  /** Null for a stored entry whose agent is no longer an article plan. */
  definitionSha256: string | null;
  webSearchStep: boolean;
  state: WebSearchOptInState;
  enabledAt: number | null;
  /** The stored entry's agent is no longer listed by the executor (OFF only). */
  missing: boolean;
};

export type WebSearchOptInList = {
  ok: boolean;
  /** 'ok' or why the list could not be read (executor-missing, stale-executor, ...). */
  code: string;
  pipelines: WebSearchOptInPipeline[];
};

export type WebSearchOptInResult = { ok: boolean; code: string };

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PIPELINE_ID_RE = /^[a-z0-9-]{1,32}$/;
const CODE_RE = /^[a-z-]{1,32}$/;
const STATES: ReadonlySet<string> = new Set(['on', 'off', 'lapsed']);

function parseObject(raw: unknown): Record<string, unknown> | null {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parsePipeline(e: unknown): WebSearchOptInPipeline | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (typeof o.agentId !== 'string' || !AGENT_ID_RE.test(o.agentId)) return null;
  if (typeof o.state !== 'string' || !STATES.has(o.state)) return null;
  if (typeof o.webSearchStep !== 'boolean') return null;
  const missing = o.missing === true;
  const sha = typeof o.definitionSha256 === 'string' && SHA256_RE.test(o.definitionSha256) ? o.definitionSha256 : null;
  // A listed pipeline must carry its hash; only a missing one may lack it.
  if (!missing && sha === null) return null;
  const state = o.state as WebSearchOptInState;
  return {
    agentId: o.agentId,
    name: typeof o.name === 'string' && o.name.trim() ? o.name : null,
    pipelineId: typeof o.pipelineId === 'string' && PIPELINE_ID_RE.test(o.pipelineId) ? o.pipelineId : null,
    definitionSha256: sha,
    // A missing pipeline can never be on.
    webSearchStep: missing ? false : o.webSearchStep,
    state: missing && state === 'on' ? 'lapsed' : state,
    enabledAt: typeof o.enabledAt === 'number' && Number.isFinite(o.enabledAt) ? o.enabledAt : null,
    missing,
  };
}

/** Native list JSON -> typed list. Anything malformed is dropped; a bad envelope is not ok. */
export function parseWebSearchOptInList(raw: unknown): WebSearchOptInList {
  const o = parseObject(raw);
  if (!o) return { ok: false, code: 'invalid-output', pipelines: [] };
  const code = typeof o.code === 'string' && CODE_RE.test(o.code) ? o.code : o.ok === true ? 'ok' : 'failed';
  if (o.ok !== true || !Array.isArray(o.pipelines)) return { ok: false, code: code === 'ok' ? 'failed' : code, pipelines: [] };
  const seen = new Set<string>();
  const pipelines: WebSearchOptInPipeline[] = [];
  for (const e of o.pipelines) {
    const p = parsePipeline(e);
    if (!p || seen.has(p.agentId)) continue;
    seen.add(p.agentId);
    pipelines.push(p);
  }
  return { ok: true, code, pipelines };
}

export function parseWebSearchOptInResult(raw: unknown): WebSearchOptInResult {
  const o = parseObject(raw);
  if (!o) return { ok: false, code: 'failed' };
  const code = typeof o.code === 'string' && CODE_RE.test(o.code) ? o.code : 'failed';
  return { ok: o.ok === true, code };
}

/** Display label: agent name, else pipeline id, else agent id. */
export function webSearchOptInLabel(p: Pick<WebSearchOptInPipeline, 'agentId' | 'name' | 'pipelineId'>): string {
  return p.name ?? p.pipelineId ?? p.agentId;
}

/** Only a listed pipeline with a web-search research step can be turned ON; ON/lapsed entries can always go OFF. */
export function canToggleWebSearchOptIn(p: WebSearchOptInPipeline): boolean {
  if (p.state === 'on' || p.state === 'lapsed') return true;
  return !p.missing && p.webSearchStep && p.definitionSha256 !== null;
}

export function isWebSearchOptInAvailable(): boolean {
  return !!TerminalEmulator.getWebSearchOptIns && !!TerminalEmulator.setWebSearchOptIn;
}

export async function getWebSearchOptIns(): Promise<WebSearchOptInList> {
  if (!TerminalEmulator.getWebSearchOptIns) return { ok: false, code: 'unavailable', pipelines: [] };
  try {
    return parseWebSearchOptInList(await TerminalEmulator.getWebSearchOptIns());
  } catch (e) {
    logWarn('WebSearchOptIn', 'list failed', e);
    return { ok: false, code: 'failed', pipelines: [] };
  }
}

/**
 * Settings toggle only. ON passes the hash the list showed; native recomputes
 * it and refuses ('changed') when the plan changed in between. A lapsed entry
 * turned ON again stores the current hash.
 */
export async function setWebSearchOptIn(p: WebSearchOptInPipeline, enabled: boolean): Promise<WebSearchOptInResult> {
  if (!TerminalEmulator.setWebSearchOptIn) return { ok: false, code: 'unavailable' };
  if (!AGENT_ID_RE.test(p.agentId)) return { ok: false, code: 'invalid' };
  if (enabled && (p.missing || !p.webSearchStep || p.definitionSha256 === null)) return { ok: false, code: 'no-web-search' };
  try {
    const res = parseWebSearchOptInResult(
      await TerminalEmulator.setWebSearchOptIn(p.agentId, enabled, enabled ? p.definitionSha256 : null),
    );
    logInfo('WebSearchOptIn', `${enabled ? 'on' : 'off'} ${p.agentId}: ${res.code}`);
    return res;
  } catch (e) {
    logWarn('WebSearchOptIn', 'set failed', e);
    return { ok: false, code: 'failed' };
  }
}
