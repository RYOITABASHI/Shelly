import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { useAgentStore } from '@/store/agent-store';
import { logInfo } from '@/lib/debug-logger';

export interface DmPairing {
  id: string;
  label: string;
  packageName: string;
  packageLabel?: string;
  notificationId: number;
  notificationTag: string | null;
  shortcutId: string | null;
  titleAtPairing: string;
  pairedAt: number;
  lastConfirmedAt: number | null;
  revoked: boolean;
}

export function pairingConfidence(pairing: DmPairing): 'strong' | 'weak' {
  return pairing.shortcutId ? 'strong' : 'weak';
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function queueDiskMirror(pairings: DmPairing[]): void {
  const json = JSON.stringify(pairings);
  // Pairing changes are rare and security-sensitive. Flush the temporary file
  // before atomic publish, then flush the renamed directory entry so a crash
  // cannot resurrect an old/revoked pairing from an OS write buffer.
  const command =
    `# dm-pairing mirror write; sensitive payload intentionally begins after native log preview boundary\n` +
    `mkdir -p ~/.shelly/agents && ` +
    `printf '%s' ${shQuote(json)} > ~/.shelly/agents/dm-pairings.json.tmp && ` +
    `chmod 600 ~/.shelly/agents/dm-pairings.json.tmp && sync && ` +
    `mv ~/.shelly/agents/dm-pairings.json.tmp ~/.shelly/agents/dm-pairings.json && sync`;
  useAgentStore.getState().setPendingEnvSync(command);
}

function validPairing(value: unknown): value is DmPairing {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<DmPairing>;
  return typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.label === 'string' &&
    typeof p.packageName === 'string' && p.packageName.length > 0 &&
    Number.isInteger(p.notificationId) &&
    (p.notificationTag === null || typeof p.notificationTag === 'string') &&
    (p.shortcutId === null || typeof p.shortcutId === 'string') &&
    typeof p.titleAtPairing === 'string' &&
    typeof p.pairedAt === 'number' &&
    typeof p.revoked === 'boolean';
}

interface DmPairingState {
  pairings: DmPairing[];
  isLoaded: boolean;
  loadPairings: () => Promise<void>;
  addPairing: (pairing: Omit<DmPairing, 'id' | 'pairedAt' | 'lastConfirmedAt' | 'revoked'>) => DmPairing;
  renamePairing: (id: string, label: string) => void;
  revokePairing: (id: string) => void;
  removePairing: (id: string) => void;
}

const STORAGE_KEY = 'shelly_dm_pairings';

function persist(pairings: DmPairing[]): void {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pairings)).catch((error) => {
    logInfo('DmPairing', `AsyncStorage persist failed: ${String(error)}`);
  });
  queueDiskMirror(pairings);
}

export const useDmPairingStore = create<DmPairingState>((set, get) => ({
  pairings: [],
  isLoaded: false,
  loadPairings: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      set({ pairings: Array.isArray(parsed) ? parsed.filter(validPairing) : [], isLoaded: true });
    } catch {
      set({ pairings: [], isLoaded: true });
    }
  },
  addPairing: (input) => {
    const pairing: DmPairing = {
      ...input,
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pairedAt: Date.now(),
      lastConfirmedAt: null,
      revoked: false,
    };
    const pairings = [...get().pairings, pairing];
    set({ pairings });
    persist(pairings);
    return pairing;
  },
  renamePairing: (id, label) => {
    const pairings = get().pairings.map((p) => p.id === id ? { ...p, label } : p);
    set({ pairings });
    persist(pairings);
  },
  revokePairing: (id) => {
    const pairings = get().pairings.map((p) => p.id === id ? { ...p, revoked: true } : p);
    set({ pairings });
    persist(pairings);
  },
  removePairing: (id) => {
    const pairings = get().pairings.filter((p) => p.id !== id);
    set({ pairings });
    persist(pairings);
  },
}));
