/**
 * lib/launcher-ingress.ts — RN side of the launcher ingress
 * (LauncherIngressProvider.kt; fact sheet §1–§5, D1, D6).
 *
 * The ingress itself is native (a ContentProvider answered on a Binder
 * thread, no RN involved). RN only manages the trusted caller registry
 * (TrustedCallerStore.kt) from Settings: the owner enters the launcher's
 * package name and certificate pin(s) on the device — Shelly ships none — and
 * may grant the D1 taint exemption, bound to the exact pin set shown.
 *
 * Wrappers degrade to "no callers" / not ok on builds without the native
 * functions; the status parser is strict and fails to empty.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { INGRESS_ORIGIN_LAUNCHER } from '@/lib/ingress-origin';
import { logWarn } from '@/lib/debug-logger';

/** LauncherIngressLimits.kt (keep in step; __tests__/launcher-ingress-core.test.ts). */
export const LAUNCHER_INGRESS_LIMITS = {
  MAX_TEXT_CODE_POINTS: 4000,
  MAX_CORRELATION_CODE_POINTS: 256,
  MAX_PENDING: 8,
  APPROVAL_WINDOW_MS: 10 * 60 * 1000,
  NONCE_WINDOW_MS: 10 * 60 * 1000,
  MAX_FEED_BYTES: 48 * 1024,
  RATE_MIN_INTERVAL_MS: 3000,
  RATE_MAX_IN_WINDOW: 6,
  RATE_WINDOW_MS: 60000,
  RATE_MAX_CODE_POINTS_PER_SECOND: 20,
  UNVERIFIED_AUDIT_MAX_IN_WINDOW: 30,
  UNVERIFIED_AUDIT_WINDOW_MS: 60000,
} as const;

/** The reason values shared with the launcher (fact sheet §1.3; the supplementary ones are D7). */
export const LAUNCHER_INGRESS_REASONS = [
  'VERIFY_FAILED',
  'PAYLOAD_TOO_LARGE',
  'INVALID_PAYLOAD',
  'STOP_ALL_ACTIVE',
  'GATE_DENIED',
  'DISABLED',
  'BUSY',
  'INTERNAL_ERROR',
] as const;

export const MAX_TRUSTED_CALLER_PINS = 4;

const PIN_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PRINCIPAL_RE = /^launcher:[0-9a-f]{32}$/;

/** TrustedCallerStore.normalizePin: 64 hex, optionally colon-separated pairs, any case → lower-case plain hex. */
export function normalizePin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  let plain = t;
  if (t.includes(':')) {
    const parts = t.split(':');
    if (parts.length !== 32 || parts.some((p) => p.length !== 2)) return null;
    plain = parts.join('');
  }
  const lower = plain.toLowerCase();
  return PIN_RE.test(lower) ? lower : null;
}

/** Splits what the owner typed (one pin per line, or comma / whitespace separated). Null if any is malformed. */
export function parsePinList(text: string): string[] | null {
  const raw = text.split(/[\s,]+/).filter((s) => s.length > 0);
  if (raw.length === 0 || raw.length > MAX_TRUSTED_CALLER_PINS) return null;
  const out: string[] = [];
  for (const r of raw) {
    const p = normalizePin(r);
    if (!p) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out.sort();
}

export function isValidPackageName(p: unknown): p is string {
  return typeof p === 'string' && p.length <= 255 && PACKAGE_RE.test(p);
}

export type TrustedCaller = {
  origin: string;
  packageName: string;
  pins: string[];
  enabled: boolean;
  updatedAt: number;
  /** The digest the exemption is bound to and the principal is derived from. */
  pinsDigest: string;
  principal: string;
  /** The D1 exemption holds for the current pin set. */
  exemptionBound: boolean;
  exemption?: { pinsDigest: string; op: string; schemaVersion: number; grantedAt: number };
};

export type TrustedCallerStatus = { status: 'empty' | 'ok' | 'unreadable'; callers: TrustedCaller[] };

const EMPTY: TrustedCallerStatus = { status: 'empty', callers: [] };
const UNREADABLE: TrustedCallerStatus = { status: 'unreadable', callers: [] };

/** Strict: anything malformed → unreadable, no callers. Never throws. */
export function parseTrustedCallerStatus(raw: unknown): TrustedCallerStatus & { ok?: boolean; code?: string } {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return UNREADABLE;
    const { version, status, callers, ok, code } = o as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(callers)) return UNREADABLE;
    if (status !== 'empty' && status !== 'ok' && status !== 'unreadable') return UNREADABLE;
    const extra: { ok?: boolean; code?: string } = {};
    if (typeof ok === 'boolean') extra.ok = ok;
    if (typeof code === 'string' && /^[a-z_]{1,32}$/.test(code)) extra.code = code;
    if (status === 'unreadable') return { ...UNREADABLE, ...extra };
    const out: TrustedCaller[] = [];
    for (const c of callers) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return UNREADABLE;
      const r = c as Record<string, unknown>;
      if (typeof r.origin !== 'string' || !isValidPackageName(r.packageName)) return UNREADABLE;
      if (!Array.isArray(r.pins) || r.pins.length < 1 || r.pins.length > MAX_TRUSTED_CALLER_PINS) return UNREADABLE;
      if (!r.pins.every((p) => typeof p === 'string' && PIN_RE.test(p))) return UNREADABLE;
      if (typeof r.enabled !== 'boolean' || typeof r.updatedAt !== 'number') return UNREADABLE;
      if (typeof r.pinsDigest !== 'string' || !DIGEST_RE.test(r.pinsDigest)) return UNREADABLE;
      if (typeof r.principal !== 'string' || !PRINCIPAL_RE.test(r.principal)) return UNREADABLE;
      if (typeof r.exemptionBound !== 'boolean') return UNREADABLE;
      const caller: TrustedCaller = {
        origin: r.origin,
        packageName: r.packageName,
        pins: r.pins as string[],
        enabled: r.enabled,
        updatedAt: r.updatedAt,
        pinsDigest: r.pinsDigest,
        principal: r.principal,
        exemptionBound: r.exemptionBound,
      };
      if (r.exemption !== undefined) {
        const x = r.exemption as Record<string, unknown> | null;
        if (!x || typeof x !== 'object' || typeof x.pinsDigest !== 'string' || typeof x.op !== 'string'
          || typeof x.schemaVersion !== 'number' || typeof x.grantedAt !== 'number') return UNREADABLE;
        caller.exemption = { pinsDigest: x.pinsDigest, op: x.op, schemaVersion: x.schemaVersion, grantedAt: x.grantedAt };
      }
      out.push(caller);
    }
    return { status: out.length ? 'ok' : 'empty', callers: out, ...extra };
  } catch {
    return UNREADABLE;
  }
}

/**
 * The certificate pins as the owner can check them against the launcher's
 * signing certificate (apksigner / keytool print the same SHA-256): one pin
 * per line, in groups of 8 hex digits.
 */
export function pinsLabel(pins: string[]): string {
  return pins.map((p) => (p.match(/.{1,8}/g) ?? []).join(' ')).join('\n');
}

/** First 16 hex of the pin digest, grouped for reading aloud in Settings ("confirm this matches"). */
export function digestLabel(digest: string): string {
  return (digest.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ');
}

async function callNative(fn: string, ...args: unknown[]): Promise<TrustedCallerStatus & { ok?: boolean; code?: string }> {
  const native = TerminalEmulator as unknown as Record<string, ((...a: unknown[]) => Promise<string>) | undefined>;
  const f = native?.[fn];
  if (typeof f !== 'function') return { ...EMPTY, ok: false, code: 'unavailable' };
  try {
    return parseTrustedCallerStatus(await f(...args));
  } catch (e) {
    logWarn('LauncherIngress', `${fn} failed: ${e instanceof Error ? e.name : 'error'}`);
    return { ...UNREADABLE, ok: false, code: 'failed' };
  }
}

export function listTrustedCallers(): Promise<TrustedCallerStatus> {
  return callNative('trustedCallerList');
}

/** Register / update the launcher. Invalid input never reaches native. */
export function setLauncherCaller(packageName: string, pins: string[], enabled: boolean) {
  if (!isValidPackageName(packageName) || pins.length === 0 || pins.length > MAX_TRUSTED_CALLER_PINS || pins.some((p) => !normalizePin(p))) {
    return Promise.resolve({ ...EMPTY, ok: false, code: 'invalid' });
  }
  return callNative('trustedCallerSet', INGRESS_ORIGIN_LAUNCHER, packageName, pins, enabled);
}

/** D1: grant (bound to [confirmedDigest], the digest Settings showed) or withdraw the exemption. */
export function setLauncherExemption(grant: boolean, confirmedDigest: string | null) {
  if (grant && (!confirmedDigest || !DIGEST_RE.test(confirmedDigest))) return Promise.resolve({ ...EMPTY, ok: false, code: 'invalid' });
  return callNative('trustedCallerSetExemption', INGRESS_ORIGIN_LAUNCHER, 'submit_instruction', grant, grant ? confirmedDigest : null);
}

export function removeLauncherCaller() {
  return callNative('trustedCallerRemove', INGRESS_ORIGIN_LAUNCHER);
}
