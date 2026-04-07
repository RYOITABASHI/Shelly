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
import { useSpeechInput } from '@/hooks/use-speech-input';

export function usePaneVoice(onTranscript: (text: string) => void) {
  const { state, startRecording, stopRecording } = useSpeechInput();

  // Keep a stable ref to the latest callback so the effect below
  // never has stale closure issues.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // When transcription completes (state changes from 'transcribing' to
  // 'idle' with a non-empty result) fire the callback.
  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;

    if (
      prev === 'transcribing' &&
      state.status === 'idle' &&
      state.transcribedText.trim().length > 0
    ) {
      onTranscriptRef.current(state.transcribedText.trim());
    }
  }, [state.status, state.transcribedText]);

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
  };
}
