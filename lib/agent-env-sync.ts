import { Alert, ToastAndroid } from 'react-native';
import { execCommand } from '@/hooks/use-native-exec';
import { logError, logInfo, logWarn } from '@/lib/debug-logger';
import { rematerializeAutonomousAgents } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { useSettingsStore } from '@/store/settings-store';

export async function flushPendingAgentEnvSync(label: string): Promise<boolean> {
  const cmd = useAgentStore.getState().consumePendingEnvSync();
  if (!cmd) return true;
  try {
    const result = await execCommand(cmd, 30_000);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || `exit code ${result.exitCode}`).trim();
      Alert.alert(`${label} saved`, `Saved in secure storage, but background agent env sync failed:\n\n${detail}`);
      logError('AgentEnvSync', `${label} env sync failed`, detail);
      return false;
    }
    ToastAndroid.show(`${label} key synced for agents`, ToastAndroid.SHORT);
    return true;
  } catch (e: any) {
    Alert.alert(`${label} saved`, `Saved in secure storage, but background agent env sync failed:\n\n${String(e?.message || e)}`);
    logError('AgentEnvSync', `${label} env sync threw`, e);
    return false;
  }
}

/**
 * Boot-time reconciliation (2026-08-03, found via on-device Gemini-key
 * failure): ~/.shelly/agents/.env only receives a key when its Settings row
 * is EDITED AND SAVED — flushPendingAgentEnvSync is edit-triggered, not
 * boot-triggered. A key that was configured before this sync mechanism
 * existed (or restored from a backup, or simply never re-saved since) can
 * sit correctly in SecureStore — Settings shows it as configured — while the
 * capability broker's env file has no matching line at all, so every
 * autonomous run needing that backend fails with "no configured secret"
 * despite the UI insisting the key is set. Reproduced 2026-08-03: Settings
 * showed all 4 API keys + Gemini configured, but ~/.shelly/agents/.env had
 * zero *_API_KEY lines (LOCAL_LLM_* and social-connector secrets, which were
 * configured more recently, WERE present — confirming the sync mechanism
 * itself works, it just never fired for these older values).
 *
 * Re-queues the exact same fields updateSettings() already syncs on edit,
 * using their CURRENT stored values (a no-op for anyone whose .env is
 * already in sync — same idempotent grep-replace-rewrite the edit path
 * uses), then flushes once. Silent best-effort: called on every app boot,
 * so a transient failure here just retries next launch.
 */
export async function reconcileApiKeysToEnv(): Promise<void> {
  try {
    const s = useSettingsStore.getState().settings;
    useSettingsStore.getState().updateSettings({
      geminiApiKey: s.geminiApiKey ?? '',
      cerebrasApiKey: s.cerebrasApiKey ?? '',
      groqApiKey: s.groqApiKey ?? '',
      perplexityApiKey: s.perplexityApiKey ?? '',
      autonomousCloudConsent: s.autonomousCloudConsent ?? false,
    });
    const cmd = useAgentStore.getState().consumePendingEnvSync();
    if (!cmd) return;
    const result = await execCommand(cmd, 30_000);
    if (result.exitCode !== 0) {
      logWarn('AgentEnvSync', 'boot reconciliation failed', result.stderr || result.stdout);
      return;
    }
    logInfo('AgentEnvSync', 'boot reconciliation: re-synced stored API keys to .env');
  } catch (e) {
    logWarn('AgentEnvSync', 'boot reconciliation threw', e);
  }
}

/**
 * N1 follow-up: flush for the autonomous-cloud consent flags. The consent is
 * BAKED into each autonomous agent's on-disk run script, so after the .env
 * write lands, re-materialize those scripts immediately — otherwise a
 * scheduled (alarm-fired) run keeps the pre-toggle consent until the next
 * app-launch startup repair. Re-bake only on a successful flush: the .env is
 * the source materializeAgent reads consent from, so re-baking after a failed
 * write would just re-bake the stale value.
 */
export async function flushAutonomousCloudEnvSync(label: string): Promise<boolean> {
  const flushed = await flushPendingAgentEnvSync(label);
  if (!flushed) return false;
  try {
    await rematerializeAutonomousAgents((cmd) =>
      execCommand(cmd, 30_000).then((r) => {
        if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.exitCode}`).trim());
        return r.stdout;
      })
    );
  } catch (e) {
    // Best-effort: the startup repair / next foreground run re-bakes anyway.
    logWarn('AgentEnvSync', `${label} consent re-bake failed`, e);
  }
  return true;
}
