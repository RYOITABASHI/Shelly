/**
 * lib/closepaw-shell-preapproval.ts — "run ClosePaw without Shelly's approval"
 * (owner decision 2026-11-16).
 *
 * Purpose: Muse (or another AI interface) drives Shelly, and Shelly hands
 * phone operations to ClosePaw. A per-request approval defeats that, so while
 * this is ON every Shelly-side ClosePaw approval is skipped (native owner
 * ClosePawShellPreapproval.kt):
 *   - `shelly closepaw "<goal>"` launches at once (ClosePawHandoff.handleLine),
 *   - an agent's ClosePaw hand-off needs no per-run Review
 *     ({@link isClosePawShellPreapprovalOn}, used by app/_layout.tsx; the
 *     run-provenance and once-per-run claim still apply),
 *   - queued drafts go at the first unlock without a tap or daily cap.
 * The owner accepted the trade-off: anything that can reach `shelly closepaw`
 * can make ClosePaw operate any app as them without a prompt. STOP-ALL, the
 * trusted-variant check and ClosePaw's own policy still apply.
 *
 * ON: only {@link handleClosePawShellPreapprovalChat}, only for text typed in
 * the AI pane composer (`typedByUser`, no `source`), and only for the fixed
 * phrases below (the word ClosePaw is required, so a draft or agent request
 * never matches). OFF: the chat phrase or the Settings toggle.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { tFor, type Locale } from '@/lib/i18n';
import { logInfo, logWarn } from '@/lib/debug-logger';

export type ClosePawShellPreapprovalIntent = { kind: 'on' } | { kind: 'off' };

const CP = '(?:closepaw|クローズパウ)';
const NONE_JA = '(?:承認|確認)(?:なし|無し)';

const ON_JA_RE = new RegExp(
  `^${CP}\\s*(?:で操作するとき|の(?:操作|実行)|で(?:の)?操作|を使うとき|に頼むとき)?\\s*(?:は|を|も)?\\s*[、,]?\\s*(?:全部|すべて|全て)?\\s*(?:shelly\\s*の)?\\s*${NONE_JA}で` +
    '(?:実行|操作|動か)?(?:いい|ok|お願い(?:します)?|して(?:ください|下さい)?)?(?:よ|ね)?$',
);
const ON_EN_RE = new RegExp(
  `^(?:always\\s+)?(?:run|use)\\s+closepaw\\s+without\\s+(?:any\\s+)?(?:shelly\\s+)?approvals?(?:\\s*,?\\s*please)?$`,
);
const OFF_JA_RE = new RegExp(
  `^${CP}\\s*(?:の(?:操作|実行))?\\s*(?:の|は)?\\s*${NONE_JA}\\s*(?:を|は)?\\s*(?:やめて|やめる|止めて|オフ(?:にして)?|解除(?:して)?)(?:ください|下さい)?$`,
);
const OFF_EN_RE = new RegExp(
  `^stop\\s+(?:running|using)\\s+closepaw\\s+without\\s+(?:any\\s+)?(?:shelly\\s+)?approvals?(?:\\s*,?\\s*please)?$`,
);

/** NFKC, lower case, one space, no leading `@agent`, no closing punctuation. */
export function normalizeClosePawPreapprovalText(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^@(?:agent|shelly)\b\s*/, '')
    .replace(/[。．.！!]+$/, '')
    .trim();
}

/** The whole message must be one of the fixed phrases. */
export function parseClosePawShellPreapprovalIntent(text: string | null | undefined): ClosePawShellPreapprovalIntent | null {
  const s = normalizeClosePawPreapprovalText(String(text ?? ''));
  if (!s || s.length > 120 || s.includes('\n')) return null;
  if (OFF_JA_RE.test(s) || OFF_EN_RE.test(s)) return { kind: 'off' };
  if (ON_JA_RE.test(s) || ON_EN_RE.test(s)) return { kind: 'on' };
  return null;
}

export type ClosePawShellPreapprovalStatus = { on: boolean; enabledAt?: number };

export function parseClosePawShellPreapprovalStatus(raw: unknown): ClosePawShellPreapprovalStatus {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || (o as { on?: unknown }).on !== true) return { on: false };
    const at = Number((o as { enabledAt?: unknown }).enabledAt);
    return Number.isFinite(at) && at > 0 ? { on: true, enabledAt: at } : { on: true };
  } catch {
    return { on: false };
  }
}

export async function getClosePawShellPreapproval(): Promise<ClosePawShellPreapprovalStatus> {
  if (!TerminalEmulator.getClosePawShellPreapproval) return { on: false };
  return parseClosePawShellPreapprovalStatus(await TerminalEmulator.getClosePawShellPreapproval().catch(() => null));
}

/** For the agent hand-off path: false on any error (fail closed to the Review). */
export async function isClosePawShellPreapprovalOn(): Promise<boolean> {
  return (await getClosePawShellPreapproval().catch(() => ({ on: false }))).on === true;
}

/** OFF is safe from anywhere (Settings, chat). */
export async function disableClosePawShellPreapproval(): Promise<ClosePawShellPreapprovalStatus> {
  if (!TerminalEmulator.setClosePawShellPreapproval) throw new Error('setClosePawShellPreapproval is not available in this build');
  const raw = await TerminalEmulator.setClosePawShellPreapproval(false);
  logInfo('ClosePawPreapproval', 'off');
  return parseClosePawShellPreapprovalStatus(raw);
}

export type ClosePawShellPreapprovalChatSource = { typedByUser: boolean; source?: string };

/** Only the owner's own typing in the AI pane composer may turn this ON. */
export function canSetClosePawShellPreapprovalFrom(src: ClosePawShellPreapprovalChatSource): boolean {
  return src.typedByUser === true && !src.source;
}

/**
 * Handles a typed chat message. Returns the reply to post, or null when the
 * message is not this command (or comes from a source that may not set it).
 */
export async function handleClosePawShellPreapprovalChat(
  text: string,
  locale: Locale,
  src: ClosePawShellPreapprovalChatSource,
): Promise<string | null> {
  const intent = parseClosePawShellPreapprovalIntent(text);
  if (!intent) return null;
  if (!canSetClosePawShellPreapprovalFrom(src)) {
    logInfo('ClosePawPreapproval', `refused: source=${src.source ?? (src.typedByUser ? 'typed' : 'untyped')}`);
    return null;
  }
  if (!TerminalEmulator.setClosePawShellPreapproval) return tFor(locale, 'closepaw_preapproval.unavailable');
  if (intent.kind === 'off') {
    try {
      const st = await disableClosePawShellPreapproval();
      return tFor(locale, st.on ? 'closepaw_preapproval.failed' : 'closepaw_preapproval.off');
    } catch (e) {
      logWarn('ClosePawPreapproval', 'off failed', e);
      return tFor(locale, 'closepaw_preapproval.failed');
    }
  }
  try {
    const st = parseClosePawShellPreapprovalStatus(await TerminalEmulator.setClosePawShellPreapproval(true));
    logInfo('ClosePawPreapproval', `on: ${st.on}`);
    return tFor(locale, st.on ? 'closepaw_preapproval.on' : 'closepaw_preapproval.failed');
  } catch (e) {
    logWarn('ClosePawPreapproval', 'on failed', e);
    return tFor(locale, 'closepaw_preapproval.failed');
  }
}
