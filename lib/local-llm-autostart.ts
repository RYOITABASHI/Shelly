import { execCommand } from '@/hooks/use-native-exec';
import { checkOllamaConnection } from '@/lib/local-llm';
import {
  buildDaemonStartScript,
  buildStatusCommand,
  getRecommendedModel,
  MODEL_CATALOG,
  type LlamaCppModel,
} from '@/lib/llamacpp-setup';
import { useSettingsStore } from '@/store/settings-store';

type AutoStartStatus =
  | 'ready'
  | 'started'
  | 'starting'
  | 'skipped_non_llama'
  | 'model_missing'
  | 'start_failed'
  | 'recent_failure';

export type LocalLlmAutoStartResult = {
  ok: boolean;
  status: AutoStartStatus;
  message?: string;
  model?: string;
  modelPath?: string;
};

type AutoStartOptions = {
  waitForReady?: boolean;
  reason?: string;
};

const MODEL_SEARCH_PATHS = [
  '"$HOME/models"',
  '"$HOME"',
  '/sdcard/Download',
  '/sdcard/models',
  '/sdcard/llama',
];

const LIST_GGUF_CMD = MODEL_SEARCH_PATHS
  .map((p) => `find ${p} -maxdepth 2 -type f -name '*.gguf' -printf '%p\\n' 2>/dev/null`)
  .join('; ');

const FAILURE_THROTTLE_MS = 30_000;
let inFlight: Promise<LocalLlmAutoStartResult> | null = null;
let lastFailureAt = 0;

export function kickLocalLlmAutoStart(reason = 'kick'): void {
  void ensureLocalLlmServerRunning({ waitForReady: false, reason });
}

export async function ensureLocalLlmServerRunning(
  options: AutoStartOptions = {},
): Promise<LocalLlmAutoStartResult> {
  if (inFlight) {
    return options.waitForReady
      ? inFlight
      : { ok: true, status: 'starting', message: 'llama-server start already in progress' };
  }

  const now = Date.now();
  if (lastFailureAt > 0 && now - lastFailureAt < FAILURE_THROTTLE_MS) {
    return { ok: false, status: 'recent_failure', message: 'llama-server start failed recently' };
  }

  inFlight = ensureLocalLlmServerRunningOnce(options).finally(() => {
    inFlight = null;
  });

  const result = await inFlight;
  if (!result.ok && result.status !== 'skipped_non_llama') {
    lastFailureAt = Date.now();
  } else if (result.ok) {
    lastFailureAt = 0;
  }
  return result;
}

async function ensureLocalLlmServerRunningOnce(
  options: AutoStartOptions,
): Promise<LocalLlmAutoStartResult> {
  const settings = useSettingsStore.getState().settings;
  const baseUrl = settings.localLlmUrl?.trim();
  if (!isLocalLlamaServerEndpoint(baseUrl)) {
    return { ok: true, status: 'skipped_non_llama' };
  }

  const current = await checkOllamaConnection(baseUrl, 750);
  const currentMatches = current.available
    ? localLlmModelsMatch(current.models, settings.localLlmModel, settings.localLlmModelPath)
    : false;
  const shouldRestartForModelMismatch = current.available && !currentMatches;
  if (currentMatches) {
    return { ok: true, status: 'ready', model: settings.localLlmModel };
  }

  const status = await readLlamaServerStatus();
  if (status === 'running' && !current.available) {
    if (!options.waitForReady) {
      return { ok: true, status: 'starting', model: settings.localLlmModel };
    }
    const ready = await waitForConnection(
      baseUrl,
      60_000,
      settings.localLlmModel,
      settings.localLlmModelPath,
    );
    if (ready) {
      return { ok: true, status: 'ready', model: settings.localLlmModel };
    }
  }
  if (status === 'starting_or_unreachable' && !shouldRestartForModelMismatch) {
    if (!options.waitForReady) {
      return { ok: true, status: 'starting', model: settings.localLlmModel };
    }
    const ready = await waitForConnection(
      baseUrl,
      60_000,
      settings.localLlmModel,
      settings.localLlmModelPath,
    );
    if (ready) {
      return { ok: true, status: 'ready', model: settings.localLlmModel };
    }
  }

  const resolution = await resolveSelectedModel();
  if (!resolution) {
    return {
      ok: false,
      status: 'model_missing',
      message: 'No installed GGUF model matched the Local LLM setting.',
      model: settings.localLlmModel,
    };
  }

  const result = await execCommand(
    buildDaemonStartScript(resolution.model, resolution.modelPath),
    240_000,
  ).catch((error) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (result.exitCode !== 0) {
    return {
      ok: false,
      status: 'start_failed',
      message: ((result.stderr || result.stdout) ?? '').trim() || `exit code ${result.exitCode}`,
      model: resolution.model.name,
      modelPath: resolution.modelPath,
    };
  }

  if (options.waitForReady) {
    const ready = await waitForConnection(
      baseUrl,
      30_000,
      resolution.model.name,
      resolution.modelPath,
    );
    if (!ready) {
      return {
        ok: false,
        status: 'start_failed',
        message: 'llama-server did not become ready after start.',
        model: resolution.model.name,
        modelPath: resolution.modelPath,
      };
    }
  }

  return {
    ok: true,
    status: 'started',
    model: resolution.model.name,
    modelPath: resolution.modelPath,
  };
}

function isLocalLlamaServerEndpoint(baseUrl?: string): baseUrl is string {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') return false;
    return parsed.port === '8080';
  } catch {
    return baseUrl.includes('127.0.0.1:8080') || baseUrl.includes('localhost:8080');
  }
}

async function readLlamaServerStatus(): Promise<'running' | 'starting_or_unreachable' | 'stopped'> {
  try {
    const result = await execCommand(buildStatusCommand(), 5_000);
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (text.includes('running')) return 'running';
    if (text.includes('starting_or_unreachable')) return 'starting_or_unreachable';
    return 'stopped';
  } catch {
    return 'stopped';
  }
}

async function resolveSelectedModel(): Promise<{ model: LlamaCppModel; modelPath: string } | null> {
  const settings = useSettingsStore.getState().settings;
  const explicitPath = cleanModelPath(settings.localLlmModelPath);
  const selected = settings.localLlmModel?.trim() || '';
  if (explicitPath && pathMatchesSelectedModel(explicitPath, selected)) {
    return {
      model: matchCatalog(explicitPath) ?? createCustomModel(explicitPath, selected),
      modelPath: explicitPath,
    };
  }

  const selectedAsPath = looksLikeModelPath(selected) ? selected : '';
  if (selectedAsPath) {
    return {
      model: matchCatalog(selectedAsPath) ?? createCustomModel(selectedAsPath, selected),
      modelPath: selectedAsPath,
    };
  }

  const installedPaths = await listInstalledGgufPaths();
  const catalogMatch = matchCatalog(selected);
  if (catalogMatch) {
    const installedPath = installedPaths.find((path) => modelPathMatches(path, catalogMatch));
    return {
      model: catalogMatch,
      modelPath: installedPath ?? `$HOME/models/${catalogMatch.filename}`,
    };
  }

  const installedCustomPath = selected
    ? installedPaths.find((path) => normalizedToken(basename(path)) === normalizedToken(selected))
    : null;
  if (installedCustomPath) {
    return {
      model: createCustomModel(installedCustomPath, selected),
      modelPath: installedCustomPath,
    };
  }

  if (!selected) {
    const recommended = getRecommendedModel();
    const installedPath = installedPaths.find((path) => modelPathMatches(path, recommended));
    return {
      model: recommended,
      modelPath: installedPath ?? `$HOME/models/${recommended.filename}`,
    };
  }

  return null;
}

async function listInstalledGgufPaths(): Promise<string[]> {
  try {
    const result = await execCommand(LIST_GGUF_CMD, 10_000);
    if (result.exitCode !== 0 && !result.stdout) return [];
    const seen = new Set<string>();
    for (const raw of result.stdout.split('\n')) {
      const path = raw.trim();
      if (!path) continue;
      seen.add(path);
    }
    return Array.from(seen);
  } catch {
    return [];
  }
}

function matchCatalog(value: string): LlamaCppModel | undefined {
  const normalized = normalizedToken(value);
  if (!normalized) return undefined;
  return MODEL_CATALOG.find((model) => {
    const candidates = [
      model.id,
      model.name,
      model.filename,
      model.filename.replace(/\.gguf$/i, ''),
    ];
    return candidates.some((candidate) => normalizedToken(candidate) === normalized);
  }) ?? MODEL_CATALOG.find((model) => {
    const filenameToken = normalizedToken(model.filename.replace(/\.gguf$/i, ''));
    return filenameToken.includes(normalized) || normalized.includes(filenameToken);
  });
}

function modelPathMatches(path: string, model: LlamaCppModel): boolean {
  const pathToken = normalizedToken(basename(path).replace(/\.gguf$/i, ''));
  const modelToken = normalizedToken(model.filename.replace(/\.gguf$/i, ''));
  return pathToken === modelToken || pathToken.includes(modelToken) || modelToken.includes(pathToken);
}

function pathMatchesSelectedModel(path: string, selected: string): boolean {
  if (!selected) return true;
  const selectedPath = looksLikeModelPath(selected) ? selected : '';
  if (selectedPath) {
    return normalizedToken(path) === normalizedToken(selectedPath);
  }
  const catalogMatch = matchCatalog(selected);
  if (catalogMatch) return modelPathMatches(path, catalogMatch);
  const pathToken = normalizedToken(path);
  const selectedToken = normalizedToken(selected);
  return pathToken === selectedToken || pathToken.includes(selectedToken) || selectedToken.includes(pathToken);
}

function localLlmModelsMatch(models: string[], selected: string, explicitPath?: string): boolean {
  const explicitPathToken = explicitPath && pathMatchesSelectedModel(explicitPath, selected)
    ? explicitPath
    : '';
  const expectedTokens = [
    selected,
    explicitPathToken,
    looksLikeModelPath(selected) ? selected : '',
    matchCatalog(selected)?.filename ?? '',
  ].map(normalizedToken).filter(Boolean);
  if (expectedTokens.length === 0) return true;
  if (models.length === 0) return false;

  return models
    .map(normalizedToken)
    .filter(Boolean)
    .some((actual) => expectedTokens.some((expected) => actual === expected));
}

function createCustomModel(modelPath: string, selected: string): LlamaCppModel {
  const filename = basename(modelPath) || basename(selected) || 'local-model.gguf';
  const name = filename.replace(/\.gguf$/i, '') || selected || 'Local GGUF';
  return {
    id: `custom-${normalizedToken(name) || 'local'}`,
    name,
    description: 'User-selected local GGUF model.',
    sizeGb: 0,
    ramRequiredGb: 0,
    language: 'multilingual',
    useCase: 'balanced',
    quantization: 'custom',
    huggingFaceRepo: '',
    filename,
    downloadUrl: '',
  };
}

function cleanModelPath(path?: string): string {
  const value = path?.trim() ?? '';
  return looksLikeModelPath(value) ? value : '';
}

function looksLikeModelPath(value: string): boolean {
  if (!value) return false;
  return value.includes('/') || value.startsWith('$HOME') || value.startsWith('~') || /\.gguf$/i.test(value);
}

function basename(path: string): string {
  const value = path.trim();
  const i = value.lastIndexOf('/');
  return i >= 0 ? value.slice(i + 1) : value;
}

function normalizedToken(value: string): string {
  return basename(value)
    .replace(/\.gguf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

async function waitForConnection(
  baseUrl: string,
  timeoutMs: number,
  selected?: string,
  explicitPath?: string,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await checkOllamaConnection(baseUrl, 1_000);
    if (current.available && localLlmModelsMatch(current.models, selected ?? '', explicitPath)) return true;
    await sleep(1_000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function __resetLocalLlmAutoStartForTests(): void {
  inFlight = null;
  lastFailureAt = 0;
}
