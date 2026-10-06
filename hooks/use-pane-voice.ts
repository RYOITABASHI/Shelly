/**
 * hooks/use-pane-voice.ts
 *
 * Thin wrapper around useSpeechInput that exposes a simple
 * start/stop API and calls `onTranscript` when a transcription
 * is ready.
 *
 * Usage:
 *   const { startRecording, stopRecording, isRecording } =
 *     usePaneVoice((text) => dispatchMessage(text));
 */

import { useEffect, useRef, useCallback } from 'react';
import { Platform, ToastAndroid } from 'react-native';
import { useSpeechInput } from '@/hooks/use-speech-input';

export function usePaneVoice(onTranscript: (text: string) => void) {
  const { state, startRecording, stopRecording } = useSpeechInput();

  // Keep a stable ref to the latest callback so the effect below
  // never has stale closure issues.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // When a transcription result is delivered (resultSeq bumps, landing in
  // 'idle' with a non-empty result) fire the callback. resultSeq — rather
  // than watching for a 'transcribing' -> 'idle' edge — so a fast result
  // (e.g. the on-device route, where stop() can resolve immediately) is
  // never missed if React batches both transitions into one render.
  const lastSeqRef = useRef(state.resultSeq ?? 0);
  useEffect(() => {
    const seq = state.resultSeq ?? 0;
    if (seq === lastSeqRef.current) return;
    lastSeqRef.current = seq;
    if (state.status === 'idle' && state.transcribedText.trim().length > 0) {
      onTranscriptRef.current(state.transcribedText.trim());
    }
  }, [state.resultSeq, state.status, state.transcribedText]);

  // Neither pane caller renders `error`, so a failed tap (no STT route, mic
  // denied, on-device model missing…) used to be completely silent. Surface
  // each new error once as a toast.
  const lastErrorRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const err = state.error;
    if (err === lastErrorRef.current) return;
    lastErrorRef.current = err;
    if (err && Platform.OS === 'android') {
      try { ToastAndroid.show(err, ToastAndroid.LONG); } catch { /* ignore */ }
    }
  }, [state.error]);

  const isRecording = state.status === 'recording';
  const isTranscribing = state.status === 'transcribing';

  const handleStartRecording = useCallback(async () => {
    await startRecording();
  }, [startRecording]);

  const handleStopRecording = useCallback(async () => {
    await stopRecording();
  }, [stopRecording]);

  return {
    startRecording: handleStartRecording,
    stopRecording: handleStopRecording,
    isRecording,
    isTranscribing,
    error: state.error,
    /** Live on-device transcript while recording ('' / undefined otherwise). */
    partialText: state.status === 'recording' ? state.partialText : undefined,
  };
}
