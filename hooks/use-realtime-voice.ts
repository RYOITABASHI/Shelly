/**
 * hooks/use-realtime-voice.ts — full-duplex Gemini Live voice mode.
 *
 * Thin wrapper around TerminalEmulatorModule's startVoiceSession /
 * stopVoiceSession / onVoice* events (native side: VoiceBridge.kt +
 * scripts/shelly-gemini-live-client.js). Deliberately a SEPARATE hook from
 * useVoiceChat (hooks/use-voice-chat.ts) rather than folding this into its
 * state machine — that hook's phases (listening -> transcribing -> thinking
 * -> executing -> speaking) describe a turn-based record/send/receive/speak
 * cycle that doesn't exist here; this is one continuous bidirectional
 * stream the server can interrupt at any point. VoiceChat.tsx picks between
 * the two hooks based on settings.realtimeVoiceEnabled, so the existing
 * turn-based path (Groq Whisper + expo-speech, no extra cost) stays the
 * default and this stays fully opt-in.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useSettingsStore } from '@/store/settings-store';

export type RealtimeVoiceStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

export type RealtimeVoiceState = {
  status: RealtimeVoiceStatus;
  inputTranscript: string;
  outputTranscript: string;
  error?: string;
};

export function useRealtimeVoice() {
  const [state, setState] = useState<RealtimeVoiceState>({
    status: 'idle',
    inputTranscript: '',
    outputTranscript: '',
  });
  // Guards the listener effect's setState calls after stop()/unmount so a
  // late-arriving native event (the control-reader thread's onVoiceExit can
  // fire after the JS side has already moved on) can't resurrect stale UI.
  const activeRef = useRef(false);

  const start = useCallback(async () => {
    const apiKey = useSettingsStore.getState().settings.geminiApiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      setState({ status: 'error', inputTranscript: '', outputTranscript: '', error: 'gemini_api_key_required' });
      return;
    }
    activeRef.current = true;
    setState({ status: 'connecting', inputTranscript: '', outputTranscript: '' });
    try {
      await TerminalEmulator.startVoiceSession(apiKey);
    } catch (err) {
      if (!activeRef.current) return;
      setState({
        status: 'error',
        inputTranscript: '',
        outputTranscript: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    try {
      await TerminalEmulator.stopVoiceSession();
    } catch {
      // best-effort — the native side tears its own threads down regardless
    }
    setState({ status: 'idle', inputTranscript: '', outputTranscript: '' });
  }, []);

  useEffect(() => {
    const subs = [
      TerminalEmulator.addListener('onVoiceReady', () => {
        if (!activeRef.current) return;
        setState((s) => ({ ...s, status: 'listening' }));
      }),
      TerminalEmulator.addListener('onVoiceTurnComplete', () => {
        if (!activeRef.current) return;
        setState((s) => ({ ...s, status: 'listening' }));
      }),
      TerminalEmulator.addListener('onVoiceInterrupted', () => {
        if (!activeRef.current) return;
        setState((s) => ({ ...s, status: 'listening', outputTranscript: '' }));
      }),
      TerminalEmulator.addListener('onVoiceInputTranscript', (event: { text: string }) => {
        if (!activeRef.current) return;
        setState((s) => ({ ...s, inputTranscript: event.text, status: 'listening' }));
      }),
      TerminalEmulator.addListener('onVoiceOutputTranscript', (event: { text: string }) => {
        if (!activeRef.current) return;
        setState((s) => ({ ...s, outputTranscript: event.text, status: 'speaking' }));
      }),
      TerminalEmulator.addListener('onVoiceError', (event: { message: string }) => {
        if (!activeRef.current) return;
        setState((s) => ({ ...s, status: 'error', error: event.message }));
      }),
      TerminalEmulator.addListener('onVoiceExit', () => {
        if (!activeRef.current) return;
        activeRef.current = false;
        setState((s) => (s.status === 'error' ? s : { status: 'idle', inputTranscript: '', outputTranscript: '' }));
      }),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      // Unmounting mid-session (pane closed, navigation) must not leave the
      // mic/speaker held open — same reasoning as use-speech-input.ts's own
      // unmount cleanup.
      if (activeRef.current) {
        activeRef.current = false;
        TerminalEmulator.stopVoiceSession().catch(() => {});
      }
    };
  }, []);

  return { state, start, stop };
}
