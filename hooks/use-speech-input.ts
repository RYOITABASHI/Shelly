/**
 * use-speech-input.ts — 音声入力フック (Groq Whisper / on-device)
 *
 * Route is picked per tap by lib/stt-provider.ts (settings.sttProvider):
 * - 'groq':     expo-audio で m4a 録音 → Groq Whisper に送信
 * - 'ondevice': キー不要・無料の端末内 SpeechRecognizer
 *               (SpeechRecognizerBridge.kt)。expo-audio 録音は開始しない
 *               (マイク/AudioFocus の取り合いを避けるため)。
 * Public API / state machine (idle → recording → transcribing → idle) is the
 * same for both routes.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useSettingsStore } from '@/store/settings-store';
import { groqTranscribe } from '@/lib/groq';
import { useI18n, useTranslation } from '@/lib/i18n';
import { sttUnavailableMessageKey } from '@/lib/stt-provider';
import {
  OnDeviceSttError,
  onDeviceSttErrorKey,
  resolveSttRouteNow,
  startOnDeviceSttSession,
  type OnDeviceSttSession,
} from '@/lib/ondevice-stt';
import { logInfo } from '@/lib/debug-logger';

/**
 * Lazy expo-audio load (first mic use only, same as the previous inline
 * `await import()`), via require so Jest's CommonJS runtime can load it too.
 */
async function loadExpoAudio(): Promise<typeof import('expo-audio')> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-audio');
}

/**
 * Tear down an expo-audio AudioRecorder completely.
 *
 * bug #46 (mic stuck) の根本原因対応:
 *   - recording.stop() だけでは native の MediaRecorder ハンドルも
 *     Android AudioFocus も解放されず、次に他アプリがマイクを使おうと
 *     すると「他のアプリで使用中」になる。
 *   - SharedObject.release() でネイティブインスタンスを解放し、
 *     setIsAudioActiveAsync(false) で AudioFocus を明示的に手放す。
 *
 * どの経路から呼ばれても throw しない (best-effort teardown)。
 */
export async function releaseRecorder(recording: any): Promise<void> {
  if (!recording) return;
  try {
    if (recording.isRecording && typeof recording.stop === 'function') {
      await recording.stop();
    } else if (typeof recording.stop === 'function') {
      // stop() は idempotent。既に止まっていても安全
      try { await recording.stop(); } catch { /* already stopped */ }
    } else if (typeof recording.stopAndUnloadAsync === 'function') {
      try { await recording.stopAndUnloadAsync(); } catch { /* ignore */ }
    }
  } catch (e) {
    console.warn('[SpeechInput] recorder.stop failed:', e);
  }
  try {
    // SharedObject.release() — ネイティブハンドルを解放
    if (typeof recording.release === 'function') {
      recording.release();
    } else if (typeof recording.remove === 'function') {
      recording.remove();
    }
  } catch (e) {
    console.warn('[SpeechInput] recorder.release failed:', e);
  }
  try {
    const { AudioModule } = await loadExpoAudio();
    // AudioFocus を明示的に abandon (bug #45)
    if (typeof AudioModule.setIsAudioActiveAsync === 'function') {
      await AudioModule.setIsAudioActiveAsync(false);
    }
    // allowsRecording を切って AudioSession / AudioManager を通常状態に戻す
    if (typeof AudioModule.setAudioModeAsync === 'function') {
      await AudioModule.setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: 'mixWithOthers',
      });
    }
  } catch (e) {
    console.warn('[SpeechInput] AudioFocus abandon failed:', e);
  }
}

export type SpeechState = {
  status: 'idle' | 'recording' | 'transcribing';
  transcribedText: string;
  error?: string;
  /** Live transcript while recording (on-device route only). */
  partialText?: string;
  /** Increments on every delivered transcription result, so consumers can
   *  detect a new result even if React batches the transcribing -> idle
   *  transition into a single render. */
  resultSeq?: number;
  /** Which route produced / is producing the current result. */
  provider?: 'groq' | 'ondevice';
};

export function useSpeechInput() {
  const { t } = useTranslation();
  const [state, setState] = useState<SpeechState>({
    status: 'idle',
    transcribedText: '',
  });
  const recordingRef = useRef<any>(null);
  const sttSessionRef = useRef<OnDeviceSttSession | null>(null);
  const resultSeqRef = useRef(0);
  const startingRef = useRef(false);
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {});

  const startOnDevice = useCallback(async (language: string) => {
    const { AudioModule } = await loadExpoAudio();
    // Permission prompt only — no AudioRecorder is created on this route.
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setState((s) => ({ ...s, status: 'idle', error: t('speech.mic_permission') }));
      return;
    }
    sttSessionRef.current?.cancel();
    const session = startOnDeviceSttSession({
      language,
      onPartial: (text) => {
        if (sttSessionRef.current !== session) return;
        setState((s) => (s.status === 'recording' ? { ...s, partialText: text } : s));
      },
      onAutoFinal: () => {
        // Native hit its max duration — run the normal stop path, whose
        // session.stop() resolves immediately with the delivered text.
        if (sttSessionRef.current === session) void stopRecordingRef.current();
      },
      onError: (err) => {
        if (sttSessionRef.current !== session) return;
        sttSessionRef.current = null;
        setState({
          status: 'idle',
          transcribedText: '',
          error: t(onDeviceSttErrorKey(err.code), { error: err.code }),
        });
      },
    });
    sttSessionRef.current = session;
    setState({ status: 'recording', transcribedText: '', partialText: '', provider: 'ondevice' });
  }, [t]);

  const startRecording = useCallback(async () => {
    if (startingRef.current || recordingRef.current || sttSessionRef.current) return;
    startingRef.current = true;
    try {
      const settings = useSettingsStore.getState().settings;
      const route = await resolveSttRouteNow(settings, useI18n.getState().locale);
      if (route.provider === 'none') {
        setState((s) => ({ ...s, status: 'idle', error: t(sttUnavailableMessageKey(settings)) }));
        return;
      }
      if (route.provider === 'ondevice') {
        await startOnDevice(route.language);
        return;
      }
      await startGroqRecording();
    } catch (err) {
      sttSessionRef.current?.cancel();
      sttSessionRef.current = null;
      setState({
        status: 'idle',
        transcribedText: '',
        error: t('speech.recording_error', { error: String(err instanceof Error ? err.message : err) }),
      });
    } finally {
      startingRef.current = false;
    }
  }, [startOnDevice, t]);

  const startGroqRecording = async () => {
    try {
      const { AudioModule, RecordingPresets } = await loadExpoAudio();
      // We can't use hooks dynamically, so use AudioModule directly
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        setState((s) => ({ ...s, error: t('speech.mic_permission') }));
        return;
      }

      // bug #45: YouTube などのバックグラウンド再生を一時停止させるため
      // interruptionMode: 'doNotMix' (= Android の AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
      // 相当) で排他的 AudioFocus を要求する。
      await AudioModule.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
      });
      if (typeof AudioModule.setIsAudioActiveAsync === 'function') {
        await AudioModule.setIsAudioActiveAsync(true);
      }

      const recording = new AudioModule.AudioRecorder(
        RecordingPresets.HIGH_QUALITY,
      );
      await recording.prepareToRecordAsync();
      await recording.record();
      recordingRef.current = recording;
      setState({ status: 'recording', transcribedText: '', provider: 'groq' });
    } catch (err) {
      console.warn('[SpeechInput] Recording failed:', err);
      // 失敗時も必ず release してマイクを解放
      const leaked = recordingRef.current;
      recordingRef.current = null;
      if (leaked) {
        await releaseRecorder(leaked);
      } else {
        // recorder 生成前に失敗した場合でも AudioFocus を戻す
        try {
          const { AudioModule } = await loadExpoAudio();
          if (typeof AudioModule.setIsAudioActiveAsync === 'function') {
            await AudioModule.setIsAudioActiveAsync(false);
          }
        } catch { /* ignore */ }
      }
      setState({
        status: 'idle',
        transcribedText: '',
        error: t('speech.recording_error', { error: String(err instanceof Error ? err.message : err) }),
      });
    }
  };

  const stopOnDevice = useCallback(async (session: OnDeviceSttSession) => {
    setState((s) => ({ ...s, status: 'transcribing' }));
    try {
      const text = await session.stop();
      if (sttSessionRef.current !== session) return; // cancelled meanwhile
      sttSessionRef.current = null;
      resultSeqRef.current += 1;
      logInfo('STT', 'ondevice result', { length: text.length });
      setState({
        status: 'idle',
        transcribedText: text,
        resultSeq: resultSeqRef.current,
        provider: 'ondevice',
      });
    } catch (err) {
      if (sttSessionRef.current !== session) return;
      sttSessionRef.current = null;
      const code = err instanceof OnDeviceSttError ? err.code : 'error';
      if (code === 'cancelled') {
        setState({ status: 'idle', transcribedText: '' });
        return;
      }
      setState({
        status: 'idle',
        transcribedText: '',
        error: t(onDeviceSttErrorKey(code), { error: code }),
      });
    }
  }, [t]);

  const stopRecording = useCallback(async () => {
    const session = sttSessionRef.current;
    if (session) {
      await stopOnDevice(session);
      return;
    }
    const recording = recordingRef.current;
    if (!recording) return;

    setState((s) => ({ ...s, status: 'transcribing' }));

    let released = false;
    const ensureReleased = async () => {
      if (released) return;
      released = true;
      recordingRef.current = null;
      await releaseRecorder(recording);
    };

    try {
      // Stop recording and get URI
      let uri: string;
      if (typeof recording.stop === 'function') {
        await recording.stop();
        uri = recording.uri || recording.getURI?.() || '';
      } else if (typeof recording.stopAndUnloadAsync === 'function') {
        await recording.stopAndUnloadAsync();
        uri = recording.getURI?.() || '';
      } else {
        throw new Error('Unknown recording API');
      }

      if (!uri) {
        setState({ status: 'idle', transcribedText: '', error: t('speech.file_not_found') });
        return;
      }

      // Transcription: Groq Whisper.
      const settings = useSettingsStore.getState().settings;
      const groqKey = settings.groqApiKey;

      let text = '';

      if (groqKey && groqKey.trim().length >= 10) {
        const result = await groqTranscribe(groqKey, uri);
        if (!result.success) {
          setState({ status: 'idle', transcribedText: '', error: result.error });
          return;
        }
        text = result.content ?? '';
      } else {
        // Groq route was chosen at start but the key vanished meanwhile.
        setState({
          status: 'idle',
          transcribedText: '',
          error: t(sttUnavailableMessageKey(settings)),
        });
        return;
      }

      resultSeqRef.current += 1;
      setState({
        status: 'idle',
        transcribedText: text,
        resultSeq: resultSeqRef.current,
        provider: 'groq',
      });
    } catch (err) {
      setState({
        status: 'idle',
        transcribedText: '',
        error: t('speech.transcription_error', { error: String(err instanceof Error ? err.message : err) }),
      });
    } finally {
      // bug #46: 成功・失敗問わず必ず release する
      await ensureReleased();
    }
  }, [stopOnDevice, t]);
  stopRecordingRef.current = stopRecording;

  // Cleanup: stop recording on unmount to prevent background audio leak
  useEffect(() => {
    return () => {
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (recording) {
        // unmount 時に await はできないので fire-and-forget
        void releaseRecorder(recording);
      }
      const session = sttSessionRef.current;
      sttSessionRef.current = null;
      session?.cancel();
    };
  }, []);

  // bug #46: アプリがバックグラウンドに回った時に録音を強制停止 + release。
  // 画面遷移や別アプリ切替で録音したままアプリを離れても、次回の音声入力で
  // 「他のアプリで使用中」にならないようにする。
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        const session = sttSessionRef.current;
        if (session) {
          sttSessionRef.current = null;
          session.cancel();
          setState((s) =>
            s.status === 'recording' || s.status === 'transcribing'
              ? { status: 'idle', transcribedText: '' }
              : s,
          );
        }
        const recording = recordingRef.current;
        if (recording) {
          recordingRef.current = null;
          void releaseRecorder(recording);
          setState((s) =>
            s.status === 'recording' ? { ...s, status: 'idle' } : s,
          );
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, []);

  return { state, startRecording, stopRecording };
}
