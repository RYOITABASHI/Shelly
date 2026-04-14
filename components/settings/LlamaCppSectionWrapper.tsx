// components/settings/LlamaCppSectionWrapper.tsx
//
// Adapter that lets the existing LlamaCppSection (designed for the
// Termux bridge era with isConnected + onRunCommand props) run on
// Plan B's in-process JNI execCommand. Keeps LlamaCppSection.tsx
// untouched so the rich setup/download/start/stop UI can ship today.
//
// Responsibilities:
// - resolve isConnected = true (JNI exec is always available on Plan B)
// - route onRunCommand through execCommand
// - resolve installedModelIds by listing $HOME/models/*.gguf
// - resolve activeModelId from settings-store.localLlmUrl mapping
// - persist onSelectModel as settings-store.localLlmUrl + active id
// - persist onUpdateLocalLlmUrl as settings-store update

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { colors as C, fonts as F } from '@/theme.config';
import { LlamaCppSection } from './LlamaCppSection';
import { ModalHeader } from './ModalHeader';
import {
  getLlamaCppLocalLlmConfig,
  MODEL_CATALOG,
  type LlamaCppModel,
} from '@/lib/llamacpp-setup';

import { execCommand } from '@/hooks/use-native-exec';
import { useSettingsStore } from '@/store/settings-store';

// Scan every location where a user might reasonably keep .gguf files.
// The old implementation only looked at $HOME/models which missed manual
// downloads into ~/Downloads, /sdcard/Download, ~/llama, etc.
//
// We run one `find` per path (ignoring missing paths) and emit the full
// path per line. The caller compares basenames against MODEL_CATALOG.
const SEARCH_PATHS = [
  '"$HOME/models"',
  '"$HOME"',
  '/sdcard/Download',
  '/sdcard/models',
  '/sdcard/llama',
];
// Emit "<size> <path>" per line via `find -printf` so the caller can dedup
// identical files reachable through multiple search roots (e.g. $HOME and
// $HOME/models) by (basename, size) without an extra stat round-trip.
const LIST_MODELS_CMD =
  SEARCH_PATHS
    .map((p) => `find ${p} -maxdepth 2 -type f -name '*.gguf' -printf '%s %p\\n' 2>/dev/null`)
    .join('; ');

// Ask the running llama-server (if any) which model it has loaded. Uses
// the standard OpenAI-compatible /v1/models endpoint. Returns the first
// model id on success, null if the server is down or unreachable.
async function fetchActiveServerModelId(endpoint: string): Promise<string | null> {
  try {
    const url = endpoint.replace(/\/$/, '') + '/v1/models';
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json() as { data?: Array<{ id?: string }> };
    const first = json.data?.[0]?.id;
    return typeof first === 'string' && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

// Fallback: parse the live llama-server process's -m argument to learn
// which file it was loaded with. Used when /v1/models is unreachable
// (server not running, port blocked, etc.).
async function fetchServerModelPathFromPs(): Promise<string | null> {
  const r = await execCommand(
    "ps -Af 2>/dev/null | grep -F llama-server | grep -v grep | head -n1",
    3000,
  );
  const line = (r.stdout ?? '').trim();
  if (!line) return null;
  // The -m argument is somewhere in the line; match it directly.
  const m = line.match(/-m\s+(\S+\.gguf)/);
  return m?.[1] ?? null;
}

// Loose match: lowercased substring in either direction. Example:
//   catalog.filename = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
//   disk basename    = "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
// -> match
function basenameMatchesCatalog(basename: string, catalogFilename: string): boolean {
  const a = basename.toLowerCase();
  const b = catalogFilename.toLowerCase();
  if (a === b) return true;
  // Strip the trailing .gguf and compare stem prefixes so a quantization
  // variant ("-q5" vs "-q4") with an otherwise-identical stem still counts
  // as the same model family.
  const stemA = a.replace(/\.gguf$/, '');
  const stemB = b.replace(/\.gguf$/, '');
  return stemA.includes(stemB) || stemB.includes(stemA);
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

type Props = {
  onClose: () => void;
};

export function LlamaCppSectionWrapper({ onClose }: Props) {
  const localLlmUrl = useSettingsStore((s) => s.settings.localLlmUrl);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [installedModelIds, setInstalledModelIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [activeServerLabel, setActiveServerLabel] = useState<string | null>(null);

  // Refresh installed model list by scanning every likely path on disk,
  // then loose-matching basenames against the catalog. Also ask the
  // running llama-server (if any) what model it currently has loaded,
  // so the UI can show an "Active: ..." hint even when the on-disk file
  // is not in a canonical location.
  const refreshInstalled = useCallback(async () => {
    const r = await execCommand(LIST_MODELS_CMD, 10_000);
    // Parse "<size> <path>" lines and dedup by (basename, size) — the same
    // file can show up multiple times when search roots overlap.
    const seen = new Set<string>();
    const fullPaths: string[] = [];
    for (const raw of (r.stdout ?? '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const size = line.slice(0, sp);
      const path = line.slice(sp + 1);
      const key = `${basenameOf(path)}|${size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fullPaths.push(path);
    }
    const basenames = fullPaths.map(basenameOf);

    const found = new Set<string>();
    for (const model of MODEL_CATALOG) {
      for (const base of basenames) {
        if (basenameMatchesCatalog(base, model.filename)) {
          found.add(model.id);
          break;
        }
      }
    }

    // Consult the running server for its active model. Try the HTTP
    // endpoint first (fast, authoritative); fall back to parsing `ps`
    // output if the endpoint is unreachable. Whichever model the server
    // is actively serving MUST count as installed — otherwise the UI
    // would show a Download button for a file that demonstrably exists
    // on disk (the bug spotted on the first device test).
    let resolvedActiveId: string | null = null;
    const serverModel = await fetchActiveServerModelId(localLlmUrl);
    if (serverModel) {
      setActiveServerLabel(serverModel);
      for (const model of MODEL_CATALOG) {
        if (basenameMatchesCatalog(serverModel, model.filename)) {
          resolvedActiveId = model.id;
          break;
        }
      }
    } else {
      const psPath = await fetchServerModelPathFromPs();
      if (psPath) {
        const base = basenameOf(psPath);
        setActiveServerLabel(base);
        for (const model of MODEL_CATALOG) {
          if (basenameMatchesCatalog(base, model.filename)) {
            resolvedActiveId = model.id;
            break;
          }
        }
      } else {
        setActiveServerLabel(null);
      }
    }

    if (resolvedActiveId) {
      found.add(resolvedActiveId);
    }
    setInstalledModelIds(found);

    if (resolvedActiveId) {
      setActiveModelId(resolvedActiveId);
      return;
    }

    // No server hint — fall back to the previous heuristic of picking
    // whichever installed model happens to be first in catalog order.
    setActiveModelId((prev) => {
      if (prev && found.has(prev)) return prev;
      return found.values().next().value ?? null;
    });
  }, [localLlmUrl]);

  useEffect(() => {
    refreshInstalled();
  }, [refreshInstalled]);

  const handleRun = useCallback(
    async (command: string, _label: string) => {
      // llama.cpp setup commands can be long — bump timeout to 10 min.
      const r = await execCommand(command, 600_000);
      const ok = r.exitCode === 0;
      if (ok) {
        // Any successful command may have mutated $HOME/models, refresh.
        refreshInstalled();
      }
      return { success: ok, output: (r.stdout ?? '') + (r.stderr ?? '') };
    },
    [refreshInstalled],
  );

  const handleSelectModel = useCallback(
    (model: LlamaCppModel) => {
      setActiveModelId(model.id);
      const cfg = getLlamaCppLocalLlmConfig(model);
      updateSettings({ localLlmUrl: cfg.baseUrl });
    },
    [updateSettings],
  );

  const handleUpdateLocalLlmUrl = useCallback(
    (url: string) => {
      updateSettings({ localLlmUrl: url });
    },
    [updateSettings],
  );

  return (
    <View style={styles.root}>
      <ModalHeader
        title="LOCAL LLM · llama.cpp"
        onClose={onClose}
        subtitle={
          <View>
            <Text style={styles.endpoint} numberOfLines={1}>
              {localLlmUrl}
            </Text>
            {activeServerLabel && (
              <Text style={styles.active} numberOfLines={1}>
                ACTIVE: {activeServerLabel}
              </Text>
            )}
          </View>
        }
      />
      <ScrollView style={styles.body}>
        <LlamaCppSection
          isConnected={true}
          activeModelId={activeModelId}
          installedModelIds={installedModelIds}
          onSelectModel={handleSelectModel}
          onRunCommand={handleRun}
          onUpdateLocalLlmUrl={handleUpdateLocalLlmUrl}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  endpoint: {
    fontFamily: F.family,
    fontSize: 9,
    color: C.text3,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 4,
  },
  active: {
    fontFamily: F.family,
    fontSize: 9,
    fontWeight: '700',
    color: C.accentGreen,
    paddingHorizontal: 14,
    paddingBottom: 6,
    letterSpacing: 0.5,
  },
  body: {
    flex: 1,
  },
});
