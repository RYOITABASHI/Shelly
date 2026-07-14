import { Alert, ToastAndroid } from 'react-native';
import { execCommand } from '@/hooks/use-native-exec';
import { logError, logWarn } from '@/lib/debug-logger';
import { rematerializeAutonomousAgents } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';

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
