import { create } from 'zustand';
import { AccessibilityInfo, Platform } from 'react-native';

// ─── Sound IDs ──────────────────────────────────────────────────────────────

export type SoundId =
  | 'send'
  | 'success'
  | 'error'
  | 'tab_switch'
  | 'key_press'
  | 'ctrl_c'
  | 'copy'
  | 'ai_start'
  | 'ai_complete'
  | 'connect'
  | 'disconnect'
  | 'mode_switch'
  | 'quick_open'
  | 'quick_close';

// ─── Sound metadata ─────────────────────────────────────────────────────────

const SOUND_META: Record<SoundId, { frequency: number; duration: number }> = {
  send:         { frequency: 880,  duration: 80  },
  success:      { frequency: 1047, duration: 120 },
  error:        { frequency: 220,  duration: 150 },
  tab_switch:   { frequency: 660,  duration: 60  },
  key_press:    { frequency: 1200, duration: 40  },
  ctrl_c:       { frequency: 440,  duration: 100 },
  copy:         { frequency: 1320, duration: 70  },
  ai_start:     { frequency: 523,  duration: 150 },
  ai_complete:  { frequency: 784,  duration: 200 },
  connect:      { frequency: 587,  duration: 180 },
  disconnect:   { frequency: 330,  duration: 150 },
  mode_switch:  { frequency: 698,  duration: 90  },
  quick_open:   { frequency: 740,  duration: 120 },
  quick_close:  { frequency: 494,  duration: 100 },
};

// ─── Sound Store (Zustand) ──────────────────────────────────────────────────

type SoundStore = {
  enabled: boolean;
  volume: number;
  reduceMotion: boolean;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  initReduceMotion: () => void;
};

export const useSoundStore = create<SoundStore>((set) => ({
  enabled: true,
  volume: 0.6,
  reduceMotion: false,
  setEnabled: (enabled) => set({ enabled }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  initReduceMotion: () => {
    AccessibilityInfo.isReduceMotionEnabled().then((isEnabled) => {
      set({ reduceMotion: isEnabled });
    });
    AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (isEnabled) => set({ reduceMotion: isEnabled }),
    );
  },
}));

// ─── Web Audio API tone generator ──────────────────────────────────────────

let _audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (Platform.OS !== 'web') return null;
  if (_audioCtx) return _audioCtx;
  try {
    const Ctx =
      (globalThis as any).AudioContext ||
      (globalThis as any).webkitAudioContext;
    if (Ctx) {
      _audioCtx = new Ctx();
    }
  } catch {
    // AudioContext not available
  }
  return _audioCtx;
}

function playToneWeb(frequency: number, durationMs: number, volume: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume context if it was suspended (browser autoplay policy)
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

  // Apply volume with a short fade-out to avoid click artifacts
  const durationSec = durationMs / 1000;
  gainNode.gain.setValueAtTime(volume, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(
    0.001,
    ctx.currentTime + durationSec,
  );

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + durationSec);
}

// ─── Native tone generator (generates WAV in memory) ────────────────────────

// Cache generated WAV data URIs to avoid regenerating for the same params
const _wavCache = new Map<string, string>();

function generateWavDataUri(
  frequency: number,
  durationMs: number,
  volume: number,
): string {
  const cacheKey = `${frequency}-${durationMs}-${volume.toFixed(2)}`;
  const cached = _wavCache.get(cacheKey);
  if (cached) return cached;

  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * (durationMs / 1000));
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const bufferSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1 size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Generate sine wave samples with fade-out envelope
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = 1 - i / numSamples; // linear fade-out
    const sample = Math.sin(2 * Math.PI * frequency * t) * volume * envelope;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(headerSize + i * 2, clamped * 0x7fff, true);
  }

  // Convert to base64 data URI
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const dataUri = `data:audio/wav;base64,${base64}`;

  _wavCache.set(cacheKey, dataUri);
  return dataUri;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

let _nativePlayerModule: typeof import('expo-audio') | null = null;

async function ensureNativeAudioModule(): Promise<typeof import('expo-audio') | null> {
  if (_nativePlayerModule) return _nativePlayerModule;
  try {
    _nativePlayerModule = await import('expo-audio');
    return _nativePlayerModule;
  } catch {
    return null;
  }
}

async function playToneNative(
  frequency: number,
  durationMs: number,
  volume: number,
): Promise<void> {
  const audioModule = await ensureNativeAudioModule();
  if (!audioModule) return;

  const dataUri = generateWavDataUri(frequency, durationMs, volume);

  try {
    const player = audioModule.createAudioPlayer(dataUri);
    player.volume = volume;
    player.play();

    // Clean up after playback finishes
    setTimeout(() => {
      try {
        player.remove();
      } catch {
        // Player may already be released
      }
    }, durationMs + 200);
  } catch {
    // Silently fail — sound effects are non-critical
  }
}

// ─── Imperative playSound ───────────────────────────────────────────────────

/**
 * Play a sound effect by ID.
 * Respects enabled state, volume, and reduceMotion settings.
 * Can be called from anywhere (not just React components).
 *
 * Uses Web Audio API (OscillatorNode) on web and generates in-memory
 * WAV data played via expo-audio on native platforms. Each sound is a
 * sine wave tone matching the frequency/duration in SOUND_META.
 */
export function playSound(id: SoundId): void {
  const { enabled, reduceMotion, volume } = useSoundStore.getState();
  if (!enabled || reduceMotion) return;

  const meta = SOUND_META[id];
  if (!meta) return;

  if (Platform.OS === 'web') {
    playToneWeb(meta.frequency, meta.duration, volume);
  } else {
    // Fire-and-forget on native
    playToneNative(meta.frequency, meta.duration, volume).catch(() => {});
  }
}

/**
 * Clean up audio resources (call on app background/unmount).
 */
export function unloadSounds(): void {
  // Close the Web AudioContext if it was created
  if (_audioCtx) {
    _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }
  // Clear WAV cache
  _wavCache.clear();
}
