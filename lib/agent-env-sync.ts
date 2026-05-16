import { Alert, ToastAndroid } from 'react-native';
import { execCommand } from '@/hooks/use-native-exec';
import { logError } from '@/lib/debug-logger';
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
