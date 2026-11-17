/**
 * lib/connectivity-guardian-mirror.ts — keeps the native connectivity
 * guardian toggle mirror (ConnectivityGuardianStore.kt, Keystore AES-GCM,
 * unreadable = OFF) in step with settings.connectivityGuardianEnabled.
 *
 * The guardian (ConnectivityGuardian.kt) runs from boot / network / alarm
 * broadcasts before RN, so it reads a native copy of the toggle. The RN
 * setting stays the single source of truth the owner edits; this module only
 * copies it: once the persisted settings blob is hydrated (never the
 * pre-hydration default, which would bounce the guardian OFF -> ON at every
 * app start), and then with every change of the flag. Only `=== true` counts
 * as on. A failed ON write is followed by an explicit clear, so the native
 * side can only ever be OFF or exactly what Settings say (the
 * lib/mcp-autostart-mirror.ts rule).
 */

export interface GuardianMirrorNative {
  setConnectivityGuardianMirror?(enabled: boolean): Promise<boolean>;
}

export type GuardianMirrorSettings = { connectivityGuardianEnabled?: boolean };

export function guardianEnabledFromSettings(settings: GuardianMirrorSettings): boolean {
  return settings.connectivityGuardianEnabled === true;
}

/** Writes the mirror. Resolves whether the native side now matches. */
export async function writeConnectivityGuardianMirror(native: GuardianMirrorNative, enabled: boolean): Promise<boolean> {
  const set = native.setConnectivityGuardianMirror;
  if (typeof set !== 'function') return false;
  try {
    const ok = await set.call(native, enabled);
    if (ok !== true && enabled) {
      // Fail closed: never leave a half-written ON behind.
      await set.call(native, false).catch(() => false);
      return false;
    }
    return ok === true;
  } catch {
    if (enabled) await Promise.resolve(set.call(native, false)).catch(() => false);
    return false;
  }
}

export interface GuardianSettingsSource {
  getState(): { settings: GuardianMirrorSettings; isBaseSettingsLoaded: boolean };
  subscribe(listener: () => void): () => void;
}

/**
 * Starts syncing; returns the unsubscribe. Writes are serialized so an OFF
 * that follows an ON can never land before it.
 */
export function startConnectivityGuardianMirror(
  native: GuardianMirrorNative,
  source: GuardianSettingsSource,
  onError?: (e: unknown) => void,
): () => void {
  let last: boolean | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const sync = () => {
    const st = source.getState();
    if (!st.isBaseSettingsLoaded) return;
    const want = guardianEnabledFromSettings(st.settings);
    if (want === last) return;
    last = want;
    chain = chain
      .then(() => writeConnectivityGuardianMirror(native, want))
      .catch((e) => onError?.(e));
  };
  const unsubscribe = source.subscribe(sync);
  sync();
  return unsubscribe;
}
