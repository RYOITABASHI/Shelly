import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { detectApiType } from '@/lib/local-llm';
import { logError } from '@/lib/debug-logger';

type LocalScouterPhase = 'start' | 'snapshot' | 'error';

type LocalScouterEvent = {
  phase: LocalScouterPhase;
  endpoint: string;
  model: string;
  message: string;
  cwd?: string;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  latencyMs?: number;
  firstTokenLatencyMs?: number;
};

type HookTemplate = {
  baseUrl?: string;
  token?: string;
  tokenHeader?: string;
};

let cachedHook: { template: HookTemplate; expiresAt: number } | null = null;
let postQueue: Promise<void> = Promise.resolve();

export function postLocalLlmScouterEvent(event: LocalScouterEvent): Promise<void> {
  const nextPost = postQueue.then(() => postLocalLlmScouterEventAsync(event));
  postQueue = nextPost.catch((error) => {
    logError('ScouterTelemetry', `Local LLM telemetry failed: ${String(error?.message ?? error)}`);
  });
  return postQueue;
}

async function postLocalLlmScouterEventAsync(event: LocalScouterEvent): Promise<void> {
  const hook = await getLocalHook();
  const baseUrl = hook.baseUrl?.replace(/\/+$/, '');
  const token = hook.token;
  if (!baseUrl || !token || !isLiveHookUrl(baseUrl)) return;

  const apiType = detectApiType(event.endpoint);
  const path = event.phase === 'start'
    ? 'pre-tool-use'
    : event.phase === 'error'
      ? 'post-tool-use-failure'
      : 'snapshot';
  const payload = {
    sourceVersion: 'ai-pane',
    sessionId: 'local-llm',
    projectName: 'Local LLM',
    cwd: event.cwd ?? '',
    model: event.model,
    message: event.message,
    localBackend: apiType === 'ollama' ? 'ollama' : 'llama.cpp',
    localEndpoint: event.endpoint,
    tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    tokensPerSecond: event.tokensPerSecond,
    latencyMs: event.latencyMs,
    firstTokenLatencyMs: event.firstTokenLatencyMs,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [hook.tokenHeader || 'X-Scouter-Token']: token,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Scouter hook ${path} returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function getLocalHook(): Promise<HookTemplate> {
  const now = Date.now();
  if (cachedHook && cachedHook.expiresAt > now) return cachedHook.template;

  const raw = await TerminalEmulator.getScouterHookTemplate('local');
  const parsed = JSON.parse(raw) as HookTemplate;
  cachedHook = { template: parsed, expiresAt: now + 30_000 };
  return parsed;
}

function isLiveHookUrl(url: string): boolean {
  const port = Number(url.match(/:(-?\d+)\/hook\//)?.[1] ?? '-1');
  return Number.isFinite(port) && port > 0;
}
