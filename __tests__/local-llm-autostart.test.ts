const mockExecCommand = jest.fn();
const mockCheckOllamaConnection = jest.fn();
let mockSettings: any;

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: mockExecCommand,
}));

jest.mock('@/lib/local-llm', () => ({
  checkOllamaConnection: mockCheckOllamaConnection,
}));

jest.mock('@/store/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({ settings: mockSettings }),
  },
}));

import {
  __resetLocalLlmAutoStartForTests,
  ensureLocalLlmServerRunning,
} from '@/lib/local-llm-autostart';

describe('local LLM auto-start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetLocalLlmAutoStartForTests();
    mockSettings = {
      localLlmUrl: 'http://127.0.0.1:8080',
      localLlmModel: 'custom-local',
      localLlmModelPath: '/sdcard/models/custom-local.gguf',
    };
    mockCheckOllamaConnection.mockResolvedValue({ available: false, models: [], error: 'down' });
    mockExecCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'llama-server ready\n', stderr: '' });
  });

  it('starts the selected GGUF path instead of hardcoding Qwen', async () => {
    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('started');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
    const startScript = mockExecCommand.mock.calls[1][0] as string;
    expect(startScript).toContain('/sdcard/models/custom-local.gguf');
    expect(startScript).not.toContain('Qwen3.5-4B-Q4_K_M.gguf');
  });

  it('ignores a stale selected path when the selected model string changed', async () => {
    mockSettings.localLlmModel = 'qwen2.5-3b-instruct-q4_k_m';
    mockSettings.localLlmModelPath = '/sdcard/models/custom-local.gguf';
    mockExecCommand.mockReset();
    mockExecCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: 'stopped\n', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/sdcard/models/qwen2.5-3b-instruct-q4_k_m.gguf\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'llama-server ready\n', stderr: '' });

    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('started');
    const startScript = mockExecCommand.mock.calls[2][0] as string;
    expect(startScript).toContain('/sdcard/models/qwen2.5-3b-instruct-q4_k_m.gguf');
    expect(startScript).not.toContain('/sdcard/models/custom-local.gguf');
  });

  it('does not auto-start Ollama or remote endpoints', async () => {
    mockSettings.localLlmUrl = 'http://127.0.0.1:11434';

    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result).toEqual({ ok: true, status: 'skipped_non_llama' });
    expect(mockCheckOllamaConnection).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('does nothing when the configured llama-server is already ready', async () => {
    mockCheckOllamaConnection.mockResolvedValueOnce({ available: true, models: ['custom-local'] });

    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('does not mark a running process ready when the model endpoint was not verified', async () => {
    mockExecCommand.mockReset();
    mockExecCommand.mockResolvedValueOnce({ exitCode: 0, stdout: 'running\n', stderr: '' });

    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('starting');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('restarts a ready llama-server when it is serving a different model', async () => {
    mockSettings.localLlmModel = 'Qwen3.5-0.8B-Q4_K_M';
    mockSettings.localLlmModelPath = '/sdcard/models/Qwen3.5-0.8B-Q4_K_M.gguf';
    mockCheckOllamaConnection
      .mockResolvedValueOnce({ available: true, models: ['Qwen3.5-2B-Q4_K_M'] });
    mockExecCommand.mockReset();
    mockExecCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'running\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'llama-server ready\n', stderr: '' });

    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('started');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
    const startScript = mockExecCommand.mock.calls[1][0] as string;
    expect(startScript).toContain('/sdcard/models/Qwen3.5-0.8B-Q4_K_M.gguf');
    expect(startScript).not.toContain('Qwen3.5-2B-Q4_K_M.gguf');
  });

  it('does not accept a short llama-server alias as the selected model', async () => {
    mockSettings.localLlmModel = 'Qwen3.5-0.8B-Q4_K_M';
    mockSettings.localLlmModelPath = '/sdcard/models/Qwen3.5-0.8B-Q4_K_M.gguf';
    mockCheckOllamaConnection
      .mockResolvedValueOnce({ available: true, models: ['qwen3'] });
    mockExecCommand.mockReset();
    mockExecCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'running\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'llama-server ready\n', stderr: '' });

    const result = await ensureLocalLlmServerRunning({ waitForReady: false, reason: 'test' });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('started');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });
});
