/**
 * lib/closepaw-draft-preapproval.ts — "save drafts without approval", per
 * destination (owner decision 2026-11-08, option 2 of DEFERRED.md
 * "ClosePaw save-draft").
 *
 * The owner turns a destination on once by typing in the chat, e.g.
 * 「note と Substack の下書き保存は承認なしで」 / "save drafts to note and
 * Substack without approval". From then on ClosePawDrafts.kt sends queued
 * drafts for that destination at the first unlock without the notification
 * tap, up to a daily cap (default 5), and posts a notice afterwards with what
 * was saved and links. 「承認なしをやめて」 / "stop saving drafts without
 * approval" or the Settings toggle turns it off.
 *
 * Who can turn it on: only {@link handleDraftPreapprovalChat}, and only for
 * text typed in the AI pane composer (`typedByUser`, no `source`): never a
 * voice transcript, a `shelly agent add` terminal request, an inbound message,
 * a widget ASK, a MONITOR team draft, agent output or a file. The state is
 * native (ClosePawDraftPreapproval.kt: Keystore-MAC'd prefs, re-keyed on every
 * write) because ClosePawDrafts reads it without RN. Nothing here can publish:
 * it only skips the tap in front of the save-draft routine.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { tFor, type Locale } from '@/lib/i18n';
import { logInfo, logWarn } from '@/lib/debug-logger';

export const DEFAULT_DAILY_CAP = 5;
export const MAX_DAILY_CAP = 20;

/** 'note' | 'substack' (the one listed subdomain) | 'substack:<subdomain>'. */
export type DraftDestinationRequest = string;

export type DraftPreapprovalIntent =
  | { kind: 'on'; destinations: DraftDestinationRequest[]; dailyCap: number }
  | { kind: 'off'; destinations: DraftDestinationRequest[] | null; explicit: boolean };

export type DraftPreapprovalEntry = {
  dest: string;
  cap: number;
  enabledAt: number;
  usedToday: number;
  remainingToday: number;
};

const SUB = '[a-z0-9-]{1,63}';
const DEST_SRC = `(?:${SUB}\\.substack\\.com|substack\\s*[:：]\\s*${SUB}|substack|サブスタック|note|ノート)`;
const SEP_SRC = '(?:と|、|,|&|＆|・|/|および|及び|and)';
const LIST_SRC = `${DEST_SRC}(?:\\s*${SEP_SRC}\\s*${DEST_SRC})*`;
const DEST_GLOBAL_RE = new RegExp(`(?:(${SUB})\\.substack\\.com|substack\\s*[:：]\\s*(${SUB})|(substack|サブスタック)|(note|ノート))`, 'g');

const CAP_JA_SRC = '(?:1日|一日|毎日)\\s*(\\d{1,2})\\s*件(?:まで)?';
const CAP_EN_SRC = '(?:up\\s+to\\s+)?(\\d{1,2})\\s+(?:drafts?\\s+)?(?:a|per)\\s+day';
const NONE_JA_SRC = '(?:承認|確認)(?:なし|無し)';

const ON_JA_RE = new RegExp(
  `^(${LIST_SRC})\\s*(?:への|に|の)?\\s*下書き(?:の)?保存\\s*(?:は|を|も)?\\s*[、,]?\\s*(?:${CAP_JA_SRC}\\s*[、,]?\\s*)?${NONE_JA_SRC}で` +
    '(?:いい|ok|お願い(?:します)?|保存して|して(?:ください|下さい)?)?(?:よ|ね)?$',
);
const ON_EN_RE = new RegExp(
  `^save\\s+drafts?\\s+(?:to|on|for)\\s+(${LIST_SRC})\\s+(?:${CAP_EN_SRC}\\s+)?without\\s+(?:any\\s+)?approvals?` +
    `(?:\\s*,?\\s*${CAP_EN_SRC})?(?:\\s*,?\\s*please)?$`,
);
const OFF_JA_RE = new RegExp(
  `^(?:(${LIST_SRC})\\s*(?:への|に|の)?\\s*)?(下書き(?:の)?保存\\s*(?:の|は)?\\s*)?${NONE_JA_SRC}(?:で(?:の)?保存)?\\s*(?:を|は)?\\s*` +
    '(?:やめて|やめる|止めて|オフ(?:にして)?|解除(?:して)?)(?:ください|下さい)?$',
);
const OFF_EN_RE = new RegExp(
  `^stop\\s+saving\\s+drafts?(?:\\s+(?:to|on|for)\\s+(${LIST_SRC}))?\\s+without\\s+(?:any\\s+)?approvals?(?:\\s*,?\\s*please)?$`,
);

/** NFKC, lower case, one space, no leading `@agent`, no closing punctuation. */
export function normalizeDraftPreapprovalText(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^@(?:agent|shelly)\b\s*/, '')
    .replace(/[。．.！!]+$/, '')
    .trim();
}

function destinationsOf(list: string | undefined): DraftDestinationRequest[] {
  const out: string[] = [];
  if (!list) return out;
  DEST_GLOBAL_RE.lastIndex = 0;
  for (let m = DEST_GLOBAL_RE.exec(list); m; m = DEST_GLOBAL_RE.exec(list)) {
    const dest = m[1] ? `substack:${m[1]}` : m[2] ? `substack:${m[2]}` : m[3] ? 'substack' : 'note';
    if (!out.includes(dest)) out.push(dest);
  }
  return out;
}

function capOf(...raw: Array<string | undefined>): number | null {
  const found = raw.find((r) => r !== undefined);
  if (found === undefined) return DEFAULT_DAILY_CAP;
  const n = Number(found);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAILY_CAP ? n : null;
}

/**
 * The whole message must be one of the fixed phrases: a sentence that merely
 * mentions drafts and approval (an agent request such as "毎朝 note に下書き
 * 保存、承認なしで実行") does not match. A cap outside 1..20 matches nothing.
 */
export function parseDraftPreapprovalIntent(text: string | null | undefined): DraftPreapprovalIntent | null {
  const s = normalizeDraftPreapprovalText(String(text ?? ''));
  if (!s || s.length > 160 || s.includes('\n')) return null;
  let m = ON_JA_RE.exec(s);
  if (m) {
    const cap = capOf(m[2]);
    return cap === null ? null : { kind: 'on', destinations: destinationsOf(m[1]), dailyCap: cap };
  }
  m = ON_EN_RE.exec(s);
  if (m) {
    const cap = capOf(m[2], m[3]);
    return cap === null ? null : { kind: 'on', destinations: destinationsOf(m[1]), dailyCap: cap };
  }
  m = OFF_JA_RE.exec(s);
  if (m) {
    const dests = destinationsOf(m[1]);
    return { kind: 'off', destinations: dests.length ? dests : null, explicit: !!(m[1] || m[2]) };
  }
  m = OFF_EN_RE.exec(s);
  if (m) {
    const dests = destinationsOf(m[1]);
    return { kind: 'off', destinations: dests.length ? dests : null, explicit: true };
  }
  return null;
}

export function parseDraftPreapprovalStatus(raw: unknown): DraftPreapprovalEntry[] {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const entries = o && typeof o === 'object' ? (o as { entries?: unknown }).entries : null;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e): e is DraftPreapprovalEntry =>
        !!e && typeof e === 'object' && typeof (e as DraftPreapprovalEntry).dest === 'string'
        && typeof (e as DraftPreapprovalEntry).cap === 'number')
      .map((e) => ({
        dest: e.dest,
        cap: e.cap,
        enabledAt: Number(e.enabledAt) || 0,
        usedToday: Number(e.usedToday) || 0,
        remainingToday: Number(e.remainingToday) || 0,
      }));
  } catch {
    return [];
  }
}

/** Display form: "note", "Substack (name)". */
export function draftDestinationLabel(dest: string): string {
  if (dest === 'note' || dest === 'substack') return dest === 'note' ? 'note' : 'Substack';
  return dest.startsWith('substack:') ? `Substack (${dest.slice('substack:'.length)})` : dest;
}

/** OFF requests name entries: a bare "substack" means every Substack entry. */
export function entriesToTurnOff(requests: DraftDestinationRequest[] | null, entries: DraftPreapprovalEntry[]): string[] {
  if (requests === null) return entries.map((e) => e.dest);
  return entries
    .map((e) => e.dest)
    .filter((dest) => requests.some((r) => r === dest || (r === 'substack' && dest.startsWith('substack:'))));
}

export async function getDraftPreapprovalEntries(): Promise<DraftPreapprovalEntry[]> {
  if (!TerminalEmulator.getDraftPreapproval) return [];
  return parseDraftPreapprovalStatus(await TerminalEmulator.getDraftPreapproval().catch(() => null));
}

/** OFF is safe from anywhere (Settings, chat). [] = everything. */
export async function disableDraftPreapproval(dests: string[]): Promise<DraftPreapprovalEntry[]> {
  if (!TerminalEmulator.disableDraftPreapproval) throw new Error('disableDraftPreapproval is not available in this build');
  const raw = await TerminalEmulator.disableDraftPreapproval(dests);
  logInfo('DraftPreapproval', `off: ${dests.length ? dests.join(',') : 'all'}`);
  return parseDraftPreapprovalStatus(raw);
}

export type DraftPreapprovalChatSource = { typedByUser: boolean; source?: string };

/** Only the owner's own typing in the AI pane composer may turn this ON. */
export function canSetDraftPreapprovalFrom(src: DraftPreapprovalChatSource): boolean {
  return src.typedByUser === true && !src.source;
}

/**
 * Handles a typed chat message. Returns the reply to post, or null when the
 * message is not this command (or comes from a source that may not set it),
 * so the caller routes it as usual.
 */
export async function handleDraftPreapprovalChat(
  text: string,
  locale: Locale,
  src: DraftPreapprovalChatSource,
): Promise<string | null> {
  const intent = parseDraftPreapprovalIntent(text);
  if (!intent) return null;
  if (!canSetDraftPreapprovalFrom(src)) {
    logInfo('DraftPreapproval', `refused: source=${src.source ?? (src.typedByUser ? 'typed' : 'untyped')}`);
    return null;
  }
  if (intent.kind === 'off') {
    const entries = await getDraftPreapprovalEntries();
    const targets = entriesToTurnOff(intent.destinations, entries);
    // A bare 「承認なしをやめて」 with nothing on is not ours: let it route.
    if (!intent.explicit && entries.length === 0) return null;
    if (targets.length === 0) return tFor(locale, 'draft_preapproval.off_none');
    try {
      const left = await disableDraftPreapproval(intent.destinations === null ? [] : targets);
      const still = left.filter((e) => targets.includes(e.dest));
      if (still.length) return tFor(locale, 'draft_preapproval.failed');
      return tFor(locale, 'draft_preapproval.off', { dests: targets.map(draftDestinationLabel).join(', ') });
    } catch (e) {
      logWarn('DraftPreapproval', 'off failed', e);
      return tFor(locale, 'draft_preapproval.failed');
    }
  }
  if (!TerminalEmulator.setDraftPreapproval) return tFor(locale, 'draft_preapproval.unavailable');
  let res: { ok?: unknown; code?: unknown; enabled?: unknown; subdomains?: unknown } | null = null;
  try {
    res = JSON.parse(await TerminalEmulator.setDraftPreapproval(intent.destinations, intent.dailyCap));
  } catch (e) {
    logWarn('DraftPreapproval', 'on failed', e);
  }
  const subs = Array.isArray(res?.subdomains) ? (res!.subdomains as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (!res || res.ok !== true) {
    const code = typeof res?.code === 'string' ? res.code : 'failed';
    logInfo('DraftPreapproval', `on refused: ${code}`);
    switch (code) {
      case 'no-substack':
        return tFor(locale, 'draft_preapproval.no_substack');
      case 'ambiguous-substack':
        return tFor(locale, 'draft_preapproval.ambiguous_substack', { subs: subs.join(', '), first: subs[0] ?? 'name' });
      case 'substack-not-allowed':
        return tFor(locale, 'draft_preapproval.substack_not_allowed', { subs: subs.length ? subs.join(', ') : '-' });
      default:
        return tFor(locale, 'draft_preapproval.failed');
    }
  }
  const enabled = Array.isArray(res.enabled) ? (res.enabled as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  logInfo('DraftPreapproval', `on: ${enabled.join(',')} cap=${intent.dailyCap}`);
  return tFor(locale, 'draft_preapproval.on', {
    dests: enabled.map(draftDestinationLabel).join(', '),
    cap: intent.dailyCap,
  });
}
