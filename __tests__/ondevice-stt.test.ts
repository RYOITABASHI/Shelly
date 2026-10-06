type Listener = (e: any) => void;

const mockListeners: Record<string, Set<Listener>> = {};
const mockNative: Record<string, jest.Mock> = {
  addListener: jest.fn((name: string, fn: Listener) => {
    (mockListeners[name] ??= new Set()).add(fn);
    return { remove: () => mockListeners[name].delete(fn) };
  }),
  startOnDeviceStt: jest.fn(async () => undefined),
  stopOnDeviceStt: jest.fn(async () => undefined),
  cancelOnDeviceStt: jest.fn(async () => undefined),
  getOnDeviceSttStatus: jest.fn(),
  triggerOnDeviceSttModelDownload: jest.fn(async () => true),
};

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  get default() { return mockNative; },
}));
jest.mock('@/lib/debug-logger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

import {
  __resetOnDeviceSttStatusCache,
  getOnDeviceSttStatus,
  onDeviceSttErrorKey,
  startOnDeviceSttSession,
} from '@/lib/ondevice-stt';

function emit(name: string, body: any) {
  for (const fn of Array.from(mockListeners[name] ?? [])) fn(body);
}
function listenerCount() {
  return Object.values(mockListeners).reduce((n, s) => n + s.size, 0);
}
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockListeners)) mockListeners[k].clear();
  __resetOnDeviceSttStatusCache();
});

describe('startOnDeviceSttSession', () => {
  it('streams partials for its own session only and resolves stop() with the final text', async () => {
    const onPartial = jest.fn();
    const session = startOnDeviceSttSession({ language: 'ja-JP', onPartial });
    expect(mockNative.startOnDeviceStt).toHaveBeenCalledWith(session.id, 'ja-JP');

    emit('onSttPartial', { sessionId: 'other', text: 'nope' });
    emit('onSttPartial', { sessionId: session.id, text: 'こんにちは' });
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith('こんにちは');

    const p = session.stop();
    expect(mockNative.stopOnDeviceStt).toHaveBeenCalledWith(session.id);
    emit('onSttFinal', { sessionId: session.id, text: ' こんにちは世界 ' });
    await expect(p).resolves.toBe('こんにちは世界');
    expect(listenerCount()).toBe(0);
  });

  it('reports a native error before stop() via onError and tears down', async () => {
    const onError = jest.fn();
    const session = startOnDeviceSttSession({ language: 'ja-JP', onError });
    emit('onSttError', { sessionId: session.id, code: 'language_unavailable', message: 'x' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'language_unavailable' }));
    expect(mockNative.cancelOnDeviceStt).toHaveBeenCalledWith(session.id);
    expect(listenerCount()).toBe(0);
    await expect(session.stop()).rejects.toMatchObject({ code: 'language_unavailable' });
  });

  it('never hangs: stop() timeout falls back to the last partial', async () => {
    jest.useFakeTimers();
    try {
      const session = startOnDeviceSttSession({ language: 'en-US' });
      emit('onSttPartial', { sessionId: session.id, text: 'hello there' });
      const p = session.stop(1000);
      jest.advanceTimersByTime(1001);
      await expect(p).resolves.toBe('hello there');
      expect(mockNative.cancelOnDeviceStt).toHaveBeenCalledWith(session.id);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never hangs: stop() timeout without any text rejects with timeout', async () => {
    jest.useFakeTimers();
    try {
      const session = startOnDeviceSttSession({ language: 'en-US' });
      const p = session.stop(1000);
      jest.advanceTimersByTime(1001);
      await expect(p).rejects.toMatchObject({ code: 'timeout' });
      expect(listenerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an unsolicited final (native max duration) is handed to onAutoFinal and stop() resolves immediately', async () => {
    const onAutoFinal = jest.fn();
    const session = startOnDeviceSttSession({ language: 'ja-JP', onAutoFinal });
    emit('onSttFinal', { sessionId: session.id, text: '長い話' });
    expect(onAutoFinal).toHaveBeenCalledWith('長い話');
    await expect(session.stop()).resolves.toBe('長い話');
    expect(mockNative.stopOnDeviceStt).not.toHaveBeenCalled();
  });

  it('a rejected native start surfaces as an error', async () => {
    mockNative.startOnDeviceStt.mockRejectedValueOnce(new Error('no react context'));
    const onError = jest.fn();
    startOnDeviceSttSession({ language: 'ja-JP', onError });
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'client' }));
  });

  it('cancel() rejects a pending stop and ignores late events', async () => {
    const onPartial = jest.fn();
    const session = startOnDeviceSttSession({ language: 'ja-JP', onPartial });
    const p = session.stop();
    session.cancel();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    emit('onSttPartial', { sessionId: session.id, text: 'late' });
    expect(onPartial).not.toHaveBeenCalled();
  });
});

describe('getOnDeviceSttStatus', () => {
  it('normalizes and caches the native answer', async () => {
    mockNative.getOnDeviceSttStatus.mockResolvedValue({ available: true, languageStatus: 'downloadable' });
    await expect(getOnDeviceSttStatus('ja-JP')).resolves.toMatchObject({
      available: true,
      languageStatus: 'downloadable',
    });
    await getOnDeviceSttStatus('ja-JP');
    expect(mockNative.getOnDeviceSttStatus).toHaveBeenCalledTimes(1);
    await getOnDeviceSttStatus('ja-JP', { force: true });
    expect(mockNative.getOnDeviceSttStatus).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a native throw or garbage', async () => {
    mockNative.getOnDeviceSttStatus.mockRejectedValueOnce(new Error('boom'));
    await expect(getOnDeviceSttStatus('ja-JP')).resolves.toMatchObject({ available: false });
    mockNative.getOnDeviceSttStatus.mockResolvedValueOnce({ available: 'yes', languageStatus: 'weird' });
    await expect(getOnDeviceSttStatus('en-US', { force: true })).resolves.toEqual(
      expect.objectContaining({ available: false, languageStatus: 'unknown' }),
    );
  });
});

describe('onDeviceSttErrorKey', () => {
  it('maps codes to i18n keys', () => {
    expect(onDeviceSttErrorKey('permission')).toBe('speech.mic_permission');
    expect(onDeviceSttErrorKey('language_unavailable')).toBe('speech.ondevice_language_unavailable');
    expect(onDeviceSttErrorKey('timeout')).toBe('speech.ondevice_timeout');
    expect(onDeviceSttErrorKey('native_missing')).toBe('speech.ondevice_unavailable');
    expect(onDeviceSttErrorKey('error_42')).toBe('speech.ondevice_error');
  });
});
