import { act, renderHook } from '@testing-library/react-native';

type Listener = (e: any) => void;
const mockListeners: Record<string, Set<Listener>> = {};
const mockNative = {
  addListener: jest.fn((name: string, fn: Listener) => {
    (mockListeners[name] ??= new Set()).add(fn);
    return { remove: () => mockListeners[name].delete(fn) };
  }),
  startOnDeviceStt: jest.fn(async () => undefined),
  stopOnDeviceStt: jest.fn(async () => undefined),
  cancelOnDeviceStt: jest.fn(async () => undefined),
  getOnDeviceSttStatus: jest.fn(async () => ({ available: true, languageStatus: 'installed' })),
};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  get default() { return mockNative; },
}));

const mockRecorderCtor = jest.fn();
const mockAudioModule = {
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
  setIsAudioActiveAsync: jest.fn(async () => undefined),
  AudioRecorder: function AudioRecorder(this: any, preset: unknown) {
    mockRecorderCtor(preset);
    this.isRecording = false;
    this.uri = 'file:///rec.m4a';
    this.prepareToRecordAsync = jest.fn(async () => undefined);
    this.record = jest.fn(async () => { this.isRecording = true; });
    this.stop = jest.fn(async () => { this.isRecording = false; });
    this.release = jest.fn();
  },
};
jest.mock('expo-audio', () => ({
  AudioModule: mockAudioModule,
  RecordingPresets: { HIGH_QUALITY: {} },
}));

let mockSettings: Record<string, unknown> = {};
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings }) },
}));
const mockT = (key: string) => key;
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: mockT }),
  useI18n: { getState: () => ({ locale: 'ja' }) },
}));
const mockGroqTranscribe = jest.fn(async () => ({ success: true, content: 'groq text' }));
jest.mock('@/lib/groq', () => ({
  groqTranscribe: (...args: unknown[]) => (mockGroqTranscribe as any)(...args),
}));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

import { useSpeechInput } from '@/hooks/use-speech-input';
import { __resetOnDeviceSttStatusCache } from '@/lib/ondevice-stt';

function emit(name: string, body: any) {
  for (const fn of Array.from(mockListeners[name] ?? [])) fn(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockListeners)) mockListeners[k].clear();
  __resetOnDeviceSttStatusCache();
  mockSettings = {};
});

describe('useSpeechInput STT route selection', () => {
  it('no Groq key + on-device available: drives the native recognizer, never starts expo-audio recording', async () => {
    const { result, unmount } = renderHook(() => useSpeechInput());
    await act(async () => { await result.current.startRecording(); });

    expect(mockNative.startOnDeviceStt).toHaveBeenCalledWith(expect.any(String), 'ja-JP');
    expect(mockRecorderCtor).not.toHaveBeenCalled();
    expect(mockAudioModule.setAudioModeAsync).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('recording');

    const sessionId = (mockNative.startOnDeviceStt.mock.calls[0] as unknown as [string])[0];
    act(() => { emit('onSttPartial', { sessionId, text: 'テスト' }); });
    expect(result.current.state.partialText).toBe('テスト');

    let stopP: Promise<void> | undefined;
    act(() => { stopP = result.current.stopRecording(); });
    expect(result.current.state.status).toBe('transcribing');
    await act(async () => {
      emit('onSttFinal', { sessionId, text: 'テストです' });
      await stopP;
    });
    expect(result.current.state).toMatchObject({
      status: 'idle',
      transcribedText: 'テストです',
      provider: 'ondevice',
      resultSeq: 1,
    });
    expect(mockGroqTranscribe).not.toHaveBeenCalled();
    unmount();
  });

  it('Groq key present (auto): records with expo-audio and transcribes with Groq, no native STT', async () => {
    mockSettings = { groqApiKey: 'gsk_0123456789abcdef' };
    const { result, unmount } = renderHook(() => useSpeechInput());
    await act(async () => { await result.current.startRecording(); });
    expect(mockRecorderCtor).toHaveBeenCalledTimes(1);
    expect(mockNative.getOnDeviceSttStatus).not.toHaveBeenCalled();
    expect(mockNative.startOnDeviceStt).not.toHaveBeenCalled();

    await act(async () => { await result.current.stopRecording(); });
    expect(mockGroqTranscribe).toHaveBeenCalledWith('gsk_0123456789abcdef', 'file:///rec.m4a');
    expect(result.current.state).toMatchObject({ status: 'idle', transcribedText: 'groq text', provider: 'groq' });
    unmount();
  });

  it('forced ondevice with a Groq key still uses the native recognizer', async () => {
    mockSettings = { groqApiKey: 'gsk_0123456789abcdef', sttProvider: 'ondevice' };
    const { result, unmount } = renderHook(() => useSpeechInput());
    await act(async () => { await result.current.startRecording(); });
    expect(mockNative.startOnDeviceStt).toHaveBeenCalled();
    expect(mockRecorderCtor).not.toHaveBeenCalled();
    unmount();
    expect(mockNative.cancelOnDeviceStt).toHaveBeenCalled();
  });

  it('nothing available: stays idle with the improved error, no mic use at all', async () => {
    mockNative.getOnDeviceSttStatus.mockResolvedValueOnce({ available: false, languageStatus: 'unknown' } as any);
    const { result, unmount } = renderHook(() => useSpeechInput());
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.state).toMatchObject({ status: 'idle', error: 'speech.api_key_required' });
    expect(mockRecorderCtor).not.toHaveBeenCalled();
    expect(mockNative.startOnDeviceStt).not.toHaveBeenCalled();
    unmount();
  });

  it('native error mid-recording clears state with an i18n error', async () => {
    const { result, unmount } = renderHook(() => useSpeechInput());
    await act(async () => { await result.current.startRecording(); });
    const sessionId = (mockNative.startOnDeviceStt.mock.calls[0] as unknown as [string])[0];
    act(() => { emit('onSttError', { sessionId, code: 'language_unavailable', message: 'x' }); });
    expect(result.current.state).toMatchObject({
      status: 'idle',
      transcribedText: '',
      error: 'speech.ondevice_language_unavailable',
    });
    unmount();
  });
});
