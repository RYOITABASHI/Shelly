/**
 * hooks/use-voice-chat.ts — Voice Conversation Mode
 *
 * 音声対話モード: 音声入力 → AI応答 → TTS読み上げ → 次の音声入力 のループ。
 * Walkie-talkie style: タップで録音開始、離すと送信 → AIが答えて読み上げ → 自動で次の録音開始
 */

import { useState, useRef, useCallback } from 'react';
import { useTerminalStore } from '@/store/terminal-store';
import { speakText, stopSpeaking } from '@/lib/tts';
import { GEMINI_API_BASE } from '@/lib/gemini';
import { groqTranscribe } from '@/lib/groq';

export type VoiceChatStatus =
  | 'idle'           // 待機中
  | 'listening'      // 録音中
  | 'transcribing'   // 文字起こし中
  | 'thinking'       // AI応答待ち
  | 'speaking';      // TTS読み上げ中

export type VoiceChatState = {
  status: VoiceChatStatus;
  isActive: boolean;       // 対話モードON/OFF
  transcript: string;      // 最後の音声入力テキスト
  response: string;        // 最後のAI応答テキスト
  error?: string;
  autoContinue: boolean;   // 読み上げ後に自動で次の録音を開始
};

type VoiceChatMessage = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};

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
        setState((s) => ({ ...s, error: 'マイクの権限が必要です' }));
        return;
      }

      await AudioModule.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      const recording = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recording.prepareToRecordAsync();
      await recording.record();
      recordingRef.current = recording;
      setState((s) => ({ ...s, status: 'listening', error: undefined }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'idle',
        error: `録音エラー: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }, []);

  const processRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;

    setState((s) => ({ ...s, status: 'transcribing' }));

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
      recordingRef.current = null;

      if (!uri) {
        setState((s) => ({ ...s, status: 'idle', error: '録音ファイルが見つかりません' }));
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

      // Step 1: Transcribe audio (Groq Whisper > Gemini fallback)
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
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiKey,
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { inline_data: { mime_type: 'audio/m4a', data: base64Audio } },
                { text: 'この音声を正確に書き起こしてください。テキストのみ出力してください。' },
              ],
            }],
            generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
          }),
        });

        if (!transcribeRes.ok) {
          setState((s) => ({ ...s, status: 'idle', error: `文字起こしエラー: HTTP ${transcribeRes.status}` }));
          return;
        }

        const transcribeJson = await transcribeRes.json();
        transcript = transcribeJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      } else {
        setState((s) => ({ ...s, status: 'idle', error: '音声文字起こしにはGroqまたはGemini APIキーが必要です' }));
        return;
      }

      if (!transcript) {
        setState((s) => ({ ...s, status: 'idle', error: '音声を認識できませんでした' }));
        return;
      }

      setState((s) => ({ ...s, transcript, status: 'thinking' }));

      // Step 2: Get AI response with conversation history
      conversationRef.current.push({
        role: 'user',
        parts: [{ text: transcript }],
      });

      // Keep last 10 exchanges
      if (conversationRef.current.length > 20) {
        conversationRef.current = conversationRef.current.slice(-20);
      }

      abortRef.current = new AbortController();
      let response = '';

      const cerebrasKey = settings.cerebrasApiKey ?? '';
      if (cerebrasKey && cerebrasKey.trim().length >= 10) {
        // Use Cerebras for voice chat response (fastest, Qwen3-235B)
        const { cerebrasChatStream } = await import('@/lib/cerebras');
        const chatHistory = conversationRef.current.slice(0, -1).map((m) => ({
          role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
          content: m.parts[0]?.text ?? '',
        }));
        const result = await cerebrasChatStream(
          cerebrasKey,
          transcript,
          () => {}, // no streaming UI for voice chat
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
        // Groq fallback for voice chat response
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
        // Fallback to Gemini
        const chatUrl = `${GEMINI_API_BASE}/models/${settings.geminiModel || 'gemini-2.0-flash'}:generateContent`;

        const chatRes = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiKey,
          },
          signal: abortRef.current.signal,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text: 'あなたは音声対話アシスタントです。簡潔に、自然な話し言葉で回答してください。コードブロックやマークダウンは使わないでください。長くても3-4文で答えてください。',
              }],
            },
            contents: conversationRef.current,
            generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
          }),
        });

        if (!chatRes.ok) {
          setState((s) => ({ ...s, status: 'idle', error: `応答エラー: HTTP ${chatRes.status}` }));
          return;
        }

        const chatJson = await chatRes.json();
        response = chatJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      } else {
        setState((s) => ({ ...s, status: 'idle', error: '応答にはGroqまたはGemini APIキーが必要です' }));
        return;
      }

      conversationRef.current.push({
        role: 'model',
        parts: [{ text: response }],
      });

      setState((s) => ({ ...s, response, status: 'speaking' }));

      // Step 3: Read aloud
      await speakText(response);

      // Step 4: Auto-continue if enabled
      setState((s) => {
        if (s.isActive && s.autoContinue) {
          // Will trigger startListening via effect
          return { ...s, status: 'idle' };
        }
        return { ...s, status: 'idle' };
      });

    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setState((s) => ({
          ...s,
          status: 'idle',
          error: `エラー: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
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
    if (recordingRef.current) {
      try {
        if (typeof recordingRef.current.stop === 'function') {
          recordingRef.current.stop();
        } else if (typeof recordingRef.current.stopAndUnloadAsync === 'function') {
          recordingRef.current.stopAndUnloadAsync();
        }
      } catch {}
      recordingRef.current = null;
    }
    setState({
      status: 'idle',
      isActive: false,
      transcript: '',
      response: '',
      autoContinue: true,
    });
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
