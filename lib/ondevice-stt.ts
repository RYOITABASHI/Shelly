/**
 * lib/ondevice-stt.ts — JS side of the keyless on-device speech recognizer
 * (modules/terminal-emulator/.../SpeechRecognizerBridge.kt).
 *
 * startOnDeviceSttSession() wraps one push-to-talk session: native listening
 * starts immediately, partial text streams through onPartial, and stop()
 * resolves with the full accumulated transcript. Fail-closed by design:
 * every wait has a timeout, every error path removes the native listeners
 * and tears the native session down, and stop() can never hang.
 *
 * Debug logs: [Shelly][STT] (JS) / logcat tag ShellySTT (native).
 */

import TerminalEmulator, {
  type OnDeviceSttNativeStatus,
} from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logInfo, logWarn } from '@/lib/debug-logger';
import {
  needsOnDeviceAvailability,
  resolveSttProvider,
  sttLanguageForLocale,
  type SttProvider,
  type SttSettingsLike,
} from '@/lib/stt-provider';

const MODULE = 'STT';
const STATUS_TIMEOUT_MS = 6_000;
const STATUS_CACHE_MS = 60_000;
const START_TIMEOUT_MS = 5_000;
export const STOP_TIMEOUT_MS = 8_000;

export type OnDeviceLanguageStatus =
  | 'installed'
  | 'pending'
  | 'downloadable'
  | 'unsupported'
  | 'unknown';

export interface OnDeviceSttStatus {
  available: boolean;
  languageStatus: OnDeviceLanguageStatus;
  reason?: string;
  micPermission?: boolean;
}

const LANGUAGE_STATUSES: OnDeviceLanguageStatus[] = [
  'installed', 'pending', 'downloadable', 'unsupported', 'unknown',
];

function normalizeStatus(raw: OnDeviceSttNativeStatus | null | undefined): OnDeviceSttStatus {
  if (!raw || typeof raw !== 'object') {
    return { available: false, languageStatus: 'unknown', reason: 'no_response' };
  }
  const ls = LANGUAGE_STATUSES.includes(raw.languageStatus as OnDeviceLanguageStatus)
    ? (raw.languageStatus as OnDeviceLanguageStatus)
    : 'unknown';
  return {
    available: raw.available === true,
    languageStatus: ls,
    reason: raw.reason,
    micPermission: raw.micPermission,
  };
}

let statusCache: { language: string; at: number; status: OnDeviceSttStatus } | null = null;

/** Test hook. */
export function __resetOnDeviceSttStatusCache(): void {
  statusCache = null;
}

export async function getOnDeviceSttStatus(
  language: string,
  opts: { force?: boolean } = {},
): Promise<OnDeviceSttStatus> {
  const now = Date.now();
  if (
    !opts.force &&
    statusCache &&
    statusCache.language === language &&
    now - statusCache.at < STATUS_CACHE_MS
  ) {
    return statusCache.status;
  }
  const fn = (TerminalEmulator as any)?.getOnDeviceSttStatus;
  if (typeof fn !== 'function') {
    return { available: false, languageStatus: 'unknown', reason: 'native_missing' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      fn.call(TerminalEmulator, language) as Promise<OnDeviceSttNativeStatus>,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STATUS_TIMEOUT_MS);
      }),
    ]);
    const status = raw === null
      ? { available: false, languageStatus: 'unknown' as const, reason: 'timeout' }
      : normalizeStatus(raw);
    // Never cache a timeout — the next tap should get a fresh answer.
    if (raw !== null) statusCache = { language, at: Date.now(), status };
    logInfo(MODULE, 'status', { language, ...status });
    return status;
  } catch (e) {
    logWarn(MODULE, 'getOnDeviceSttStatus failed', e);
    return { available: false, languageStatus: 'unknown', reason: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function triggerOnDeviceSttModelDownload(language: string): Promise<boolean> {
  const fn = (TerminalEmulator as any)?.triggerOnDeviceSttModelDownload;
  if (typeof fn !== 'function') return false;
  try {
    statusCache = null;
    const ok = await fn.call(TerminalEmulator, language);
    logInfo(MODULE, 'model download requested', { language, ok });
    return ok === true;
  } catch (e) {
    logWarn(MODULE, 'triggerModelDownload failed', e);
    return false;
  }
}

export class OnDeviceSttError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'OnDeviceSttError';
    this.code = code;
  }
}

/** i18n key for a native / session error code. */
export function onDeviceSttErrorKey(code: string | undefined): string {
  switch (code) {
    case 'permission':
      return 'speech.mic_permission';
    case 'language_unavailable':
      return 'speech.ondevice_language_unavailable';
    case 'busy':
      return 'speech.ondevice_busy';
    case 'timeout':
      return 'speech.ondevice_timeout';
    case 'unsupported':
    case 'unavailable':
    case 'native_missing':
      return 'speech.ondevice_unavailable';
    default:
      return 'speech.ondevice_error';
  }
}

export interface OnDeviceSttSessionOptions {
  language: string;
  /** Accumulated transcript so far (finalized segments + live partial). */
  onPartial?: (text: string) => void;
  /** Native ended the session on its own (max duration) before stop(). The
   *  caller should run its normal stop path; stop() then resolves at once. */
  onAutoFinal?: (text: string) => void;
  /** Error before stop() was called. The session is already torn down. */
  onError?: (err: OnDeviceSttError) => void;
}

export interface OnDeviceSttSession {
  readonly id: string;
  stop(timeoutMs?: number): Promise<string>;
  cancel(): void;
}

let seq = 0;

export function startOnDeviceSttSession(opts: OnDeviceSttSessionOptions): OnDeviceSttSession {
  const id = `stt-${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const native = TerminalEmulator as any;
  let done = false;
  let stopping = false;
  let lastPartial = '';
  let finalText: string | null = null;
  let failure: OnDeviceSttError | null = null;
  let settle: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let receivedAny = false;
  const subs: Array<{ remove(): void }> = [];

  const cleanup = () => {
    if (startTimer) clearTimeout(startTimer);
    startTimer = undefined;
    while (subs.length) {
      try { subs.pop()!.remove(); } catch { /* ignore */ }
    }
  };

  const nativeCancel = () => {
    try {
      void Promise.resolve(native?.cancelOnDeviceStt?.(id)).catch(() => {});
    } catch { /* ignore */ }
  };

  const finishOk = (text: string) => {
    if (done) return;
    done = true;
    finalText = text;
    cleanup();
    logInfo(MODULE, 'final', { id, length: text.length });
    if (settle) {
      settle.resolve(text);
      settle = null;
    } else if (!stopping) {
      opts.onAutoFinal?.(text);
    }
  };

  const finishErr = (err: OnDeviceSttError) => {
    if (done) return;
    done = true;
    failure = err;
    cleanup();
    nativeCancel();
    logWarn(MODULE, 'session error', { id, code: err.code, message: err.message });
    if (settle) {
      settle.reject(err);
      settle = null;
    } else if (!stopping) {
      opts.onError?.(err);
    }
  };

  if (
    typeof native?.startOnDeviceStt !== 'function' ||
    typeof native?.addListener !== 'function'
  ) {
    // Report asynchronously so the caller always sees the same ordering.
    setTimeout(() => finishErr(new OnDeviceSttError('native_missing')), 0);
  } else {
    subs.push(
      native.addListener('onSttPartial', (e: any) => {
        if (done || e?.sessionId !== id) return;
        receivedAny = true;
        lastPartial = typeof e.text === 'string' ? e.text : '';
        opts.onPartial?.(lastPartial);
      }),
      native.addListener('onSttFinal', (e: any) => {
        if (e?.sessionId !== id) return;
        finishOk(typeof e.text === 'string' ? e.text.trim() : '');
      }),
      native.addListener('onSttError', (e: any) => {
        if (e?.sessionId !== id) return;
        finishErr(new OnDeviceSttError(String(e.code ?? 'error'), e.message));
      }),
    );
    logInfo(MODULE, 'start', { id, language: opts.language });
    let startSettled = false;
    startTimer = setTimeout(() => {
      if (!startSettled && !receivedAny) finishErr(new OnDeviceSttError('timeout', 'start timed out'));
    }, START_TIMEOUT_MS);
    Promise.resolve(native.startOnDeviceStt(id, opts.language)).then(
      () => {
        startSettled = true;
        if (startTimer) clearTimeout(startTimer);
        startTimer = undefined;
      },
      (err: unknown) => {
        startSettled = true;
        finishErr(new OnDeviceSttError('client', err instanceof Error ? err.message : String(err)));
      },
    );
  }

  return {
    id,
    stop(timeoutMs = STOP_TIMEOUT_MS): Promise<string> {
      if (finalText !== null) return Promise.resolve(finalText);
      if (failure) return Promise.reject(failure);
      if (stopping && settle) {
        return Promise.reject(new OnDeviceSttError('client', 'stop already in progress'));
      }
      stopping = true;
      return new Promise<string>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        settle = {
          resolve: (t) => { if (timer) clearTimeout(timer); resolve(t); },
          reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        };
        timer = setTimeout(() => {
          if (done) return;
          // Never hang: degrade to the last partial if we have one.
          const fallback = lastPartial.trim();
          done = true;
          cleanup();
          nativeCancel();
          settle = null;
          if (fallback) {
            logWarn(MODULE, 'stop timed out — using last partial', { id, length: fallback.length });
            finalText = fallback;
            resolve(fallback);
          } else {
            failure = new OnDeviceSttError('timeout', 'stop timed out');
            logWarn(MODULE, 'stop timed out', { id });
            reject(failure);
          }
        }, timeoutMs);
        try {
          void Promise.resolve(native?.stopOnDeviceStt?.(id)).catch((err: unknown) => {
            finishErr(new OnDeviceSttError('client', err instanceof Error ? err.message : String(err)));
          });
        } catch (err) {
          finishErr(new OnDeviceSttError('client', err instanceof Error ? err.message : String(err)));
        }
      });
    },
    cancel(): void {
      if (done) return;
      done = true;
      stopping = true;
      cleanup();
      nativeCancel();
      if (settle) {
        settle.reject(new OnDeviceSttError('cancelled'));
        settle = null;
      }
      logInfo(MODULE, 'cancel', { id });
    },
  };
}

/**
 * Resolve the STT route for a voice tap right now (settings + live native
 * availability). Skips the native round-trip on the Groq path.
 */
export async function resolveSttRouteNow(
  settings: SttSettingsLike,
  locale: string | undefined,
): Promise<{ provider: SttProvider; language: string; status: OnDeviceSttStatus | null }> {
  const language = sttLanguageForLocale(locale);
  const status = needsOnDeviceAvailability(settings)
    ? await getOnDeviceSttStatus(language)
    : null;
  const provider = resolveSttProvider(settings, status);
  logInfo(MODULE, 'route', {
    setting: settings.sttProvider ?? 'auto',
    provider,
    language,
    available: status?.available,
    languageStatus: status?.languageStatus,
  });
  return { provider, language, status };
}
