/**
 * lib/agent-role-device.ts — device wiring for the agent-roles seal
 * (lib/agent-role-store.ts).
 *
 * Side-effect module: importing it configures the seal port. The seal and
 * the per-role approval levels live together in ONE expo-secure-store
 * (Android-Keystore-backed) value, `shelly_roles_v1`:
 *   { fileHashes: [sha256 of roles.json], levels: [{ roleId, level, roleHash, setAt, via }] }
 * Unlike the policy seal there is no native copy: no executor or driver ever
 * reads roles.json (roles are snapshotted onto steps), so only RN verifies it.
 * An unreadable / undecryptable value reads as null → roles unavailable.
 */
import * as SecureStore from 'expo-secure-store';
import { configureRoleSealPort, parseRoleSealValue, serializeRoleSealValue } from '@/lib/agent-role-store';
import { logWarn } from '@/lib/debug-logger';

export const ROLE_SEAL_KEY = 'shelly_roles_v1';

configureRoleSealPort({
  read: async () => {
    try {
      return parseRoleSealValue(await SecureStore.getItemAsync(ROLE_SEAL_KEY));
    } catch (e) {
      logWarn('AgentRoles', 'role seal unreadable', e);
      return null;
    }
  },
  write: async (state) => {
    await SecureStore.setItemAsync(ROLE_SEAL_KEY, serializeRoleSealValue(state));
  },
});
