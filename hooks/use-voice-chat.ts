/**
 * hooks/use-voice-chat.ts — VoiceChain: Voice ↔ Terminal Integration
 *
 * Voice input → parseInput() routing → terminal command execution OR AI chat.
 * Terminal commands are executed via bridge, results summarized and spoken.
 * AI queries inject terminal context when referenced.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useSettingsStore } from '@/store/settings-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { speakText, stopSpeaking } from '@/lib/tts';
import { groqTranscribe } from '@/lib/groq';
import { parseInput } from '@/lib/input-router';
import { summarizeForSpeech } from '@/lib/voice-chain-helpers';
import { releaseRecorder } from '@/hooks/use-speech-input';
import { useI18n, useTranslation } from '@/lib/i18n';
import { sttUnavailableMessageKey } from '@/lib/stt-provider';
import {
  OnDeviceSttError,
  onDeviceSttErrorKey,
  resolveSttRouteNow,
  startOnDeviceSttSession,
  type OnDeviceSttSession,
} from '@/lib/ondevice-stt';

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

export type UseVoiceChatOptions = {
  /** When provided together with `paneId`, voice input is routed through the
   *  AI Pane's own `dispatch()` (the `@agent <NL>` conversational
   *  agent-creation flow) instead of the legacy `parseInput()`-based
   *  command/chat split. Optional — omitting both keeps existing behavior
   *  (ShellLayout / TerminalPane call sites) unchanged. */
  dispatch?: (text: string) => Promise<void>;
  paneId?: string;
};

export function useVoiceChat(options?: UseVoiceChatOptions) {
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceChatState>({
    status: 'idle',
    isActive: false,
    transcript: '',
    response: '',
    autoContinue: true,
  });

  const recordingRef = useRef<any>(null);
  // On-device STT route (lib/stt-provider.ts): when set, no expo-audio
  // recorder exists — the platform recognizer owns the mic.
  const sttSessionRef = useRef<OnDeviceSttSession | null>(null);
  const startingRef = useRef(false);
  const processRecordingRef = useRef<() => Promise<void>>(async () => {});
  const conversationRef = useRef<VoiceChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // Safety invariant (shared across the codebase): voice must never
  // auto-confirm/register an agent. When dispatch() resolves into an
  // agent-creation confirm card (agentCardState==='pending'), this flag is
  // set so VoiceChat.tsx's auto-continue effect skips resuming the mic —
  // the user must manually tap Confirm in the pane. Reset on activate().
  const awaitingManualConfirmRef = useRef(false);

  const startListening = useCallback(async () => {
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
        const { AudioModule } = await import('expo-audio');
        // Permission prompt only — no AudioRecorder on this route.
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setState((s) => ({ ...s, status: 'idle', error: t('speech.mic_permission') }));
          return;
        }
        const session = startOnDeviceSttSession({
          language: route.language,
          onPartial: (text) => {
            if (sttSessionRef.current !== session) return;
            setState((s) => (s.status === 'listening' ? { ...s, transcript: text } : s));
          },
          onAutoFinal: () => {
            if (sttSessionRef.current === session) void processRecordingRef.current();
          },
          onError: (err) => {
            if (sttSessionRef.current !== session) return;
            sttSessionRef.current = null;
            setState((s) => ({
              ...s,
              status: 'idle',
              error: t(onDeviceSttErrorKey(err.code), { error: err.code }),
            }));
          },
        });
        sttSessionRef.current = session;
        setState((s) => ({ ...s, status: 'listening', transcript: '', error: undefined }));
        return;
      }
      await startGroqListening();
    } catch (err) {
      sttSessionRef.current?.cancel();
      sttSessionRef.current = null;
      setState((s) => ({
        ...s,
        status: 'idle',
        error: `Recording error: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      startingRef.current = false;
    }
  }, [t]);

  const startGroqListening = async () => {
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
  };

  const processRecording = useCallback(async () => {
    const session = sttSessionRef.current;
    const recording = recordingRef.current;
    if (!session && !recording) return;

    setState((s) => ({ ...s, status: 'transcribing' }));

    let released = false;
    const ensureReleased = async () => {
      if (released) return;
      released = true;
      if (!recording) return;
      recordingRef.current = null;
      await releaseRecorder(recording);
    };

    try {
      const settings = useSettingsStore.getState().settings;
      const groqKey = settings.groqApiKey;

      // ── Step 1: Transcribe ──────────────────────────────────────────────────
      let transcript = '';

      if (session) {
        // On-device route: the recognizer already has the text.
        try {
          transcript = await session.stop();
        } catch (err) {
          if (sttSessionRef.current === session) sttSessionRef.current = null;
          const code = err instanceof OnDeviceSttError ? err.code : 'error';
          setState((s) => ({
            ...s,
            status: 'idle',
            error: code === 'cancelled' ? undefined : t(onDeviceSttErrorKey(code), { error: code }),
          }));
          return;
        }
        if (sttSessionRef.current !== session) return; // deactivated meanwhile
        sttSessionRef.current = null;
      } else {
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

        if (groqKey && groqKey.trim().length >= 10) {
          const result = await groqTranscribe(groqKey, uri);
          if (!result.success) {
            setState((s) => ({ ...s, status: 'idle', error: result.error }));
            return;
          }
          transcript = result.content ?? '';
        } else {
          setState((s) => ({ ...s, status: 'idle', error: t(sttUnavailableMessageKey(settings)) }));
          return;
        }
      }

      if (!transcript) {
        setState((s) => ({ ...s, status: 'idle', error: 'Could not recognize speech' }));
        return;
      }

      setState((s) => ({ ...s, transcript }));

      // ── Step 2a: AI-Pane conversational agent-creation bridge ──────────────
      // When invoked from an AI Pane (options.dispatch + options.paneId both
      // present), route the transcript through the SAME dispatch() the typed
      // input bar uses, so `@agent <NL>` parsing, slot-fill follow-up
      // questions, and the final confirm card all work identically whether
      // the user typed or spoke. This branch does not touch parseInput() at
      // all — errors propagate to the existing outer catch/finally below.
      if (options?.dispatch && options?.paneId) {
        const { dispatch, paneId } = options;

        setState((s) => ({ ...s, status: 'thinking' }));
        await dispatch(transcript);

        const conv = useAIPaneStore.getState().getOrCreate(paneId);
        const lastMsg = conv.messages[conv.messages.length - 1];

        if (lastMsg) {
          const isAgentCardPending =
            lastMsg.agentCardState === 'pending' && !!lastMsg.agentDraft;

          // agentDraft/pending messages are written with content:'' (the
          // confirm card renders instead of text) — synthesize a spoken
          // announcement in that case so the hands-free loop isn't silent.
          let spoken = lastMsg.content;
          if (isAgentCardPending && !spoken) {
            spoken = t('voice.agent_ready_to_confirm', { name: lastMsg.agentDraft?.name ?? '' });
          }

          if (spoken) {
            setState((s) => ({ ...s, response: spoken, status: 'speaking' }));
            await speakText(spoken);
          }

          if (isAgentCardPending) {
            // Terminal state for this voice turn: do NOT let the
            // auto-continue effect resume listening, regardless of the
            // toggle — registering the agent requires a manual tap.
            awaitingManualConfirmRef.current = true;
          }
          // Otherwise (pendingSlotFill follow-up question, or a plain chat
          // reply) — no special-casing needed. autoContinue's existing
          // effect resumes listening on its own once status is back to
          // 'idle' and state.response is set, exactly like the legacy path.
        }

        setState((s) => ({ ...s, status: 'idle' }));
        return;
      }

      // ── Step 2b: Route through parseInput() (legacy / non-pane callers) ────
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
            settings.cerebrasModel || 'gpt-oss-120b',
            chatHistory,
            abortRef.current.signal,
          );
          if (!result.success) {
            setState((s) => ({ ...s, status: 'idle', error: result.error }));
            return;
          }
          response = result.content ?? '';
        } else if (groqKey && groqKey.trim().length >= 10) {
          const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('@/lib/groq');
          const groqHistory = conversationRef.current.slice(0, -1).map((m) => ({
            role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
            content: m.parts[0]?.text ?? '',
          }));
          const result = await groqChatStream(
            groqKey,
            transcript,
            () => {},
            settings.groqModel || GROQ_DEFAULT_MODEL,
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
  }, [t]);
  processRecordingRef.current = processRecording;

  const activate = useCallback(() => {
    conversationRef.current = [];
    awaitingManualConfirmRef.current = false;
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
    const session = sttSessionRef.current;
    sttSessionRef.current = null;
    session?.cancel();
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
      const session = sttSessionRef.current;
      sttSessionRef.current = null;
      session?.cancel();
    };
  }, []);

  // bug #46: アプリがバックグラウンドに行った時に録音を強制停止 + release
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        const session = sttSessionRef.current;
        if (session) {
          sttSessionRef.current = null;
          session.cancel();
          setState((s) =>
            s.status === 'listening' || s.status === 'transcribing'
              ? { ...s, status: 'idle' }
              : s,
          );
        }
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
    // Stable ref (not reactive state) — VoiceChat.tsx's auto-continue effect
    // reads awaitingManualConfirmRef.current to skip resuming the mic after
    // an agent-creation confirm card appears. See the branch above.
    awaitingManualConfirmRef,
  };
}
