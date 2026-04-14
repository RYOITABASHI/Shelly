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
import { GEMINI_API_BASE } from '@/lib/gemini';
import { groqTranscribe } from '@/lib/groq';
import { parseInput, hasTerminalReference } from '@/lib/input-router';
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

      // Read file as base64
      const FileSystem = await import('expo-file-system/legacy');
      const base64Audio = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const settings = useTerminalStore.getState().settings;
      const groqKey = settings.groqApiKey;
      const geminiKey = settings.geminiApiKey;

      // ── Step 1: Transcribe ──────────────────────────────────────────────────
      let transcript = '';

      if (groqKey && groqKey.trim().length >= 10) {
        const result = await groqTranscribe(groqKey, uri);
        if (!result.success) {
          setState((s) => ({ ...s, status: 'idle', error: result.error }));
          return;
        }
        transcript = result.content ?? '';
      } else if (geminiKey && geminiKey.trim().length >= 10) {
        const transcribeUrl = `${GEMINI_API_BASE}/models/gemini-2.0-flash:generateContent`;
        const transcribeRes = await fetch(transcribeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { inline_data: { mime_type: 'audio/m4a', data: base64Audio } },
                { text: 'Transcribe this audio exactly. The audio is likely Japanese or English — detect the language from the audio. Output only the transcribed text, nothing else.' },
              ],
            }],
            generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
          }),
        });
        if (!transcribeRes.ok) {
          setState((s) => ({ ...s, status: 'idle', error: `Transcription error: HTTP ${transcribeRes.status}` }));
          return;
        }
        const transcribeJson = await transcribeRes.json();
        transcript = transcribeJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      } else {
        setState((s) => ({ ...s, status: 'idle', error: 'Groq or Gemini API key required for transcription' }));
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
        } else if (geminiKey && geminiKey.trim().length >= 10) {
          const chatUrl = `${GEMINI_API_BASE}/models/${settings.geminiModel || 'gemini-2.0-flash'}:generateContent`;
          const chatRes = await fetch(chatUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            signal: abortRef.current.signal,
            body: JSON.stringify({
              systemInstruction: {
                parts: [{
                  text: 'You are a voice assistant integrated with a terminal. Respond concisely in natural spoken language. No code blocks or markdown. Keep responses to 3-4 sentences max. Match the user\'s language (Japanese or English).',
                }],
              },
              contents: conversationRef.current,
              generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
            }),
          });
          if (!chatRes.ok) {
            setState((s) => ({ ...s, status: 'idle', error: `Response error: HTTP ${chatRes.status}` }));
            return;
          }
          const chatJson = await chatRes.json();
          response = chatJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
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

  const deactivate = useCallback(() => {
    stopSpeaking();
    abortRef.current?.abort();
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) {
      // bug #46: release まで確実に走らせる (fire-and-forget)
      void releaseRecorder(recording);
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
