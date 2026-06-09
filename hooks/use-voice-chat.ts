/**
 * hooks/use-voice-chat.ts — VoiceChain: Voice ↔ Terminal Integration
 *
 * Voice input → parseInput() routing → terminal command execution OR AI chat.
 * Terminal commands are executed via bridge, results summarized and spoken.
 * AI queries inject terminal context when referenced.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useTerminalStore } from '@/store/terminal-store';
import { speakText, stopSpeaking } from '@/lib/tts';
import { groqTranscribe } from '@/lib/groq';
import { parseInput } from '@/lib/input-router';
import { summarizeForSpeech } from '@/lib/voice-chain-helpers';
import { releaseRecorder } from '@/hooks/use-speech-input';

export type VoiceChatStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'executing'      // NEW: running terminal command
  | 'speaking';

export type VoiceChatState = {
  status: VoiceChatStatus;
  isActive: boolean;
  transcript: string;
  response: string;
  executedCommand?: string;   // NEW: command that was executed
  error?: string;
  autoContinue: boolean;
};

type VoiceChatMessage = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};

// Bridge command runner — imported lazily to avoid circular deps
let _runRawCommand: ((cmd: string) => Promise<{ stdout?: string; stderr?: string }>) | null = null;

export function setVoiceChainBridge(runner: (cmd: string) => Promise<{ stdout?: string; stderr?: string }>) {
  _runRawCommand = runner;
}

export function useVoiceChat() {
  const [state, setState] = useState<VoiceChatState>({
    status: 'idle',
    isActive: false,
    transcript: '',
    response: '',
    autoContinue: true,
  });

  const recordingRef = useRef<any>(null);
  const conversationRef = useRef<VoiceChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const startListening = useCallback(async () => {
    try {
      const { AudioModule, RecordingPresets } = await import('expo-audio');
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        setState((s) => ({ ...s, error: 'Microphone permission required' }));
        return;
      }

      // bug #45: YouTube などを一時停止させるため排他的 AudioFocus を要求
      await AudioModule.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
      });
      if (typeof AudioModule.setIsAudioActiveAsync === 'function') {
        await AudioModule.setIsAudioActiveAsync(true);
      }

      const recording = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recording.prepareToRecordAsync();
      await recording.record();
      recordingRef.current = recording;
      setState((s) => ({ ...s, status: 'listening', error: undefined }));
    } catch (err) {
      // bug #46: 失敗時も必ず release
      const leaked = recordingRef.current;
      recordingRef.current = null;
      if (leaked) {
        await releaseRecorder(leaked);
      } else {
        try {
          const { AudioModule } = await import('expo-audio');
          if (typeof AudioModule.setIsAudioActiveAsync === 'function') {
            await AudioModule.setIsAudioActiveAsync(false);
          }
        } catch { /* ignore */ }
      }
      setState((s) => ({
        ...s,
        status: 'idle',
        error: `Recording error: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }, []);

  const processRecording = useCallback(async () => {
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
      // Stop recording
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
        setState((s) => ({ ...s, status: 'idle', error: 'Recording file not found' }));
        return;
      }

      const settings = useTerminalStore.getState().settings;
      const groqKey = settings.groqApiKey;

      // ── Step 1: Transcribe ──────────────────────────────────────────────────
      let transcript = '';

      if (groqKey && groqKey.trim().length >= 10) {
        const result = await groqTranscribe(groqKey, uri);
        if (!result.success) {
          setState((s) => ({ ...s, status: 'idle', error: result.error }));
          return;
        }
        transcript = result.content ?? '';
      } else {
        setState((s) => ({ ...s, status: 'idle', error: 'Groq API key required for transcription' }));
        return;
      }

      if (!transcript) {
        setState((s) => ({ ...s, status: 'idle', error: 'Could not recognize speech' }));
        return;
      }

      setState((s) => ({ ...s, transcript }));

      // ── Step 2: Route through parseInput() ─────────────────────────────────
      const parsed = parseInput(transcript);

      if ((parsed.layer === 'command') && _runRawCommand) {
        // ── Terminal command → execute via bridge ──
        setState((s) => ({ ...s, status: 'executing', executedCommand: parsed.prompt }));

        try {
          const result = await _runRawCommand(parsed.prompt);
          const output = result.stdout?.trim() || result.stderr?.trim() || 'Done.';
          const spoken = await summarizeForSpeech(output);

          setState((s) => ({ ...s, response: spoken, status: 'speaking' }));
          await speakText(spoken);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          setState((s) => ({ ...s, response: `Error: ${errMsg}`, status: 'speaking' }));
          await speakText(`Error: ${errMsg}`);
        }
      } else {
        // ── AI query (with terminal context injection if referenced) ──
        setState((s) => ({ ...s, status: 'thinking' }));

        conversationRef.current.push({
          role: 'user',
          parts: [{ text: transcript }],
        });

        if (conversationRef.current.length > 20) {
          conversationRef.current = conversationRef.current.slice(-20);
        }

        abortRef.current = new AbortController();
        let response = '';

        const cerebrasKey = settings.cerebrasApiKey ?? '';
        if (cerebrasKey && cerebrasKey.trim().length >= 10) {
          const { cerebrasChatStream } = await import('@/lib/cerebras');
          const chatHistory = conversationRef.current.slice(0, -1).map((m) => ({
            role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
            content: m.parts[0]?.text ?? '',
          }));
          const result = await cerebrasChatStream(
            cerebrasKey,
            transcript,
            () => {},
            settings.cerebrasModel || 'qwen-3-235b-a22b-instruct-2507',
            chatHistory,
            abortRef.current.signal,
          );
          if (!result.success) {
            setState((s) => ({ ...s, status: 'idle', error: result.error }));
            return;
          }
          response = result.content ?? '';
        } else if (groqKey && groqKey.trim().length >= 10) {
          const { groqChatStream } = await import('@/lib/groq');
          const groqHistory = conversationRef.current.slice(0, -1).map((m) => ({
            role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
            content: m.parts[0]?.text ?? '',
          }));
          const result = await groqChatStream(
            groqKey,
            transcript,
            () => {},
            settings.groqModel || 'llama-3.3-70b-versatile',
            groqHistory,
            abortRef.current.signal,
          );
          if (!result.success) {
            setState((s) => ({ ...s, status: 'idle', error: result.error }));
            return;
          }
          response = result.content ?? '';
        } else {
          setState((s) => ({ ...s, status: 'idle', error: 'API key required for AI response' }));
          return;
        }

        conversationRef.current.push({
          role: 'model',
          parts: [{ text: response }],
        });

        setState((s) => ({ ...s, response, status: 'speaking' }));
        await speakText(response);
      }

      // ── Step 3: Return to idle (auto-continue triggers via effect) ──
      setState((s) => ({ ...s, status: 'idle' }));

    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setState((s) => ({
          ...s,
          status: 'idle',
          error: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
    } finally {
      // bug #46: 成功・失敗・Abort 問わず必ず release する
      await ensureReleased();
    }
  }, []);

  const activate = useCallback(() => {
    conversationRef.current = [];
    setState({
      status: 'idle',
      isActive: true,
      transcript: '',
      response: '',
      autoContinue: true,
    });
  }, []);

  const deactivate = useCallback(async () => {
    stopSpeaking();
    abortRef.current?.abort();
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) {
      // bug #67: release を await して他アプリのマイク占有を解放
      await releaseRecorder(recording);
    }
    setState({
      status: 'idle',
      isActive: false,
      transcript: '',
      response: '',
      autoContinue: true,
    });
  }, []);

  // bug #46: unmount 時の強制 release
  useEffect(() => {
    return () => {
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (recording) {
        void releaseRecorder(recording);
      }
    };
  }, []);

  // bug #46: アプリがバックグラウンドに行った時に録音を強制停止 + release
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        const recording = recordingRef.current;
        if (recording) {
          recordingRef.current = null;
          void releaseRecorder(recording);
          setState((s) =>
            s.status === 'listening' || s.status === 'transcribing'
              ? { ...s, status: 'idle' }
              : s,
          );
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, []);

  const toggleAutoContinue = useCallback(() => {
    setState((s) => ({ ...s, autoContinue: !s.autoContinue }));
  }, []);

  return {
    state,
    startListening,
    stopAndProcess: processRecording,
    activate,
    deactivate,
    toggleAutoContinue,
  };
}
