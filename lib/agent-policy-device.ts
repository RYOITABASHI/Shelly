/**
 * lib/agent-policy-device.ts — POLICY-001 device wiring for the policy-file
 * seal (lib/agent-user-policy-store.ts, security review M1).
 *
 * Side-effect module: importing it configures the seal port. The seal is kept
 * in TWO places, written together:
 *   - expo-secure-store (Android-Keystore-backed) — what RN verifies against;
 *   - native SharedPreferences via TerminalEmulator.setAgentPolicySeal —
 *     AgentRuntime exports it to every run as the readonly
 *     SHELLY_AGENT_POLICY_SEAL, which the codex driver, the PlanSpec executor
 *     and the generated .sh verify policy.json against on their own.
 * If the native bridge is missing (older build) the executors see no seal and
 * fail closed on any non-empty policy.json, and RN assumes "ever sealed".
 * Native HMACs its copy with an AndroidKeyStore key whose existence is the
 * shell-undeletable "ever sealed" marker (AgentPolicySeal.kt).
 */
import * as SecureStore from 'expo-secure-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { configureUserPolicySealPort, parseSealValue } from '@/lib/agent-user-policy-store';
import { logWarn } from '@/lib/debug-logger';

const SEAL_KEY = 'shelly_policy_file_seal';

configureUserPolicySealPort({
  read: async () => {
    try {
      const seal = parseSealValue(await SecureStore.getItemAsync(SEAL_KEY));
      // Re-review M1: once the native seal exists it is HMAC'd with a
      // Keystore key; a forged / wiped native seal fails verification and the
      // executors would refuse it — mirror that here (fail closed).
      const native = await TerminalEmulator.getAgentPolicySealState?.();
      if (native && native.everSealed && !native.valid) return null;
      return seal;
    } catch (e) {
      logWarn('Policy', 'policy seal unreadable', e);
      return null;
    }
  },
  everSealed: async () => {
    try {
      const native = await TerminalEmulator.getAgentPolicySealState?.();
      // No bridge (older native) ⇒ cannot prove "never sealed" ⇒ assume sealed.
      return native ? native.everSealed : true;
    } catch {
      return true;
    }
  },
  write: async (hashes: string[]) => {
    const value = hashes.join(',');
    await SecureStore.setItemAsync(SEAL_KEY, value);
    await TerminalEmulator.setAgentPolicySeal?.(value);
  },
});
