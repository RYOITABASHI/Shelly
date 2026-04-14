/**
 * use-speech-input.ts — 録音 + Gemini API 文字起こしフック
 *
 * - expo-audio で音声録音
 * - Gemini 2.0 Flash API に inline_data (audio/m4a) として送信
 * - 書き起こしテキストを返す
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useTerminalStore } from '@/store/terminal-store';
import { GEMINI_API_BASE } from '@/lib/gemini';
import { groqTranscribe } from '@/lib/groq';
import { t } from '@/lib/i18n';

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
    const { AudioModule } = await import('expo-audio');
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

type SpeechState = {
  status: 'idle' | 'recording' | 'transcribing';
  transcribedText: string;
  error?: string;
};

export function useSpeechInput() {
  const [state, setState] = useState<SpeechState>({
    status: 'idle',
    transcribedText: '',
  });
  const recordingRef = useRef<any>(null);

  const startRecording = useCallback(async () => {
    try {
      const { useAudioRecorder, AudioModule, RecordingPresets } = await import('expo-audio');
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
      setState({ status: 'recording', transcribedText: '' });
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
          const { AudioModule } = await import('expo-audio');
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
  }, []);

  const stopRecording = useCallback(async () => {
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

      // Read file as base64
      const FileSystem = await import('expo-file-system/legacy');
      const base64Audio = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Transcription priority: Groq Whisper > Gemini API
      const settings = useTerminalStore.getState().settings;
      const groqKey = settings.groqApiKey;
      const geminiKey = settings.geminiApiKey;

      let text = '';

      if (groqKey && groqKey.trim().length >= 10) {
        // Use Groq Whisper (faster, dedicated STT)
        const result = await groqTranscribe(groqKey, uri);
        if (!result.success) {
          setState({ status: 'idle', transcribedText: '', error: result.error });
          return;
        }
        text = result.content ?? '';
      } else if (geminiKey && geminiKey.trim().length >= 10) {
        // Fallback to Gemini multimodal transcription
        const url = `${GEMINI_API_BASE}/models/gemini-2.0-flash:generateContent`;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inline_data: {
                      mime_type: 'audio/m4a',
                      data: base64Audio,
                    },
                  },
                  {
                    text: t('speech.transcription_prompt'),
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 1024,
              temperature: 0.1,
            },
          }),
        });

        if (!res.ok) {
          setState({
            status: 'idle',
            transcribedText: '',
            error: t('speech.transcription_http_error', { status: String(res.status) }),
          });
          return;
        }

        const json = await res.json();
        text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      } else {
        setState({
          status: 'idle',
          transcribedText: '',
          error: t('speech.api_key_required'),
        });
        return;
      }

      setState({
        status: 'idle',
        transcribedText: text,
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
  }, []);

  // Cleanup: stop recording on unmount to prevent background audio leak
  useEffect(() => {
    return () => {
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (recording) {
        // unmount 時に await はできないので fire-and-forget
        void releaseRecorder(recording);
      }
    };
  }, []);

  // bug #46: アプリがバックグラウンドに回った時に録音を強制停止 + release。
  // 画面遷移や別アプリ切替で録音したままアプリを離れても、次回の音声入力で
  // 「他のアプリで使用中」にならないようにする。
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
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
