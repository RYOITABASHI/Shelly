# Voice + Discovery + Cosmetics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add voice input to AI and Terminal panes, full-screen and hands-free voice modes, sound profiles (Modern/Retro), font selection with CRT-aware defaults, CRT shader effect, AI-powered feature discovery, and haptic toggle — completing the Shelly Superset UI cosmetic and discovery layer.

**Architecture:** Voice integration reuses the existing VoiceChain (`use-voice-chat.ts`) and speech input (`use-speech-input.ts`) hooks, adding thin adapter layers for AI Pane inline mode and Terminal Pane mic routing. Sound profiles extend `lib/sounds.ts` with a `SoundProfile` enum and per-profile frequency/waveform tables. Font selection stores the active font family in terminal-store settings and applies it via a `useFontFamily()` hook. The CRT effect is a pure React Native overlay using `react-native-reanimated` for flicker and a semi-transparent `View` stack for scanlines/vignette/phosphor tint — no GL dependency (keeps it simple, GPU rendering already exists for future upgrade). Feature discovery injects `feature-catalog.ts` into the AI pane system prompt and adds behavior-triggered context hints via a `ContextHintManager`. The smart command palette extends the existing pseudo-shell command palette with recent actions and AI-suggested sections.

**Tech Stack:** Expo 54, React Native 0.81, TypeScript, Zustand, react-native-reanimated, expo-haptics, expo-speech, expo-audio

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `hooks/use-pane-voice.ts` | Adapter hook: voice input for AI Pane (inline waveform mode, transcript dispatch) |
| `components/panes/VoiceWaveform.tsx` | Compact animated waveform bar for inline voice mode in AI/Terminal panes |
| `lib/sound-profiles.ts` | Sound profile definitions: Modern (sine tones) + Retro (square/sawtooth 8-bit) |
| `lib/font-manager.ts` | Font catalog, `loadFont()`, CRT-aware auto-switch, `useFontFamily()` hook |
| `components/CrtOverlay.tsx` | Scanlines + phosphor tint + vignette + flicker overlay (reanimated) |
| `lib/feature-catalog.ts` | All 91 features: id, name, description, triggerContext, category |
| `lib/context-hint-manager.ts` | Behavior-triggered hints: tracking, throttle (1/60s), AsyncStorage seen-set |
| `components/ContextHint.tsx` | Inline hint UI: dim monospace text + dismiss button, auto-fade |
| `store/cosmetic-store.ts` | Zustand store: crtEnabled, crtIntensity, soundProfile, fontFamily, hapticEnabled |

### Modified Files

| File | Change |
|------|--------|
| `hooks/use-voice-chat.ts` | Export `processTranscript()` separately so AI Pane can call it without full overlay |
| `components/panes/AIPane.tsx` | Add mic button in header, inline voice waveform, voice transcript → dispatch |
| `components/terminal/CommandKeyBar.tsx` | Wire `onVoice` prop to speech input → parseInput routing |
| `components/VoiceChat.tsx` | Add hands-free mode (auto-listen, wake word exit, screen-on, transcript log) |
| `lib/sounds.ts` | Import active profile from `sound-profiles.ts`, apply waveform type per profile |
| `lib/pseudo-shell.ts` | Add `shelly voice`, `shelly config set font/crt/haptic/sound_profile/hints` |
| `store/terminal-store.ts` | Add settings fields: font, crtFont, crtEnabled, crtIntensity, soundProfile, hapticEnabled, hintsEnabled |
| `components/multi-pane/PaneSlot.tsx` | Wrap children in `<CrtOverlay>` when CRT enabled |
| `components/panes/PaneInputBar.tsx` | Add mic icon button for AI/Markdown panes |

---

## Tasks

### Task 1: Cosmetic Store + Settings Fields
- [ ] Create `store/cosmetic-store.ts` with Zustand:
  - `crtEnabled: boolean` (default false)
  - `crtIntensity: number` (default 70, range 0-100)
  - `soundProfile: 'modern' | 'retro' | 'silent'` (default 'modern')
  - `fontFamily: string` (default 'JetBrains Mono')
  - `crtFont: string` (default 'PixelMPlus')
  - `hapticEnabled: boolean` (default true)
  - `hintsEnabled: boolean` (default true)
  - `autoTts: boolean` (default false)
  - Actions: `setCrt()`, `setFont()`, `setSoundProfile()`, `setHaptic()`, `setHints()`, `setAutoTts()`
  - Persist to AsyncStorage via Zustand `persist` middleware
- [ ] Link CRT toggle to sound profile: when `crtEnabled` turns on, auto-set `soundProfile` to 'retro' and `fontFamily` to `crtFont` (save previous font for restore on CRT off)

### Task 2: Sound Profiles
- [ ] Create `lib/sound-profiles.ts`:
  - Export `SoundProfile` type and `PROFILES` map
  - Modern profile: existing sine-wave frequencies from `SOUND_META` (no change)
  - Retro profile: same sound IDs, but `oscillatorType: 'square'`, lower sample rate (11025), frequencies shifted down ~20%, 2x duration for chiptune feel
  - Silent profile: all sounds disabled
- [ ] Modify `lib/sounds.ts`:
  - Import active profile from `cosmetic-store`
  - `playSound()` reads `soundProfile` and selects waveform/frequency from active profile
  - Web: set `oscillator.type` to profile's waveform
  - Native: adjust `generateWavDataUri()` to use square wave for retro (clamp sine to +1/-1)

### Task 3: Haptic Toggle
- [ ] In `store/cosmetic-store.ts`, expose `hapticEnabled`
- [ ] Create `lib/haptics.ts` helper:
  - `triggerHaptic(style?: 'light' | 'medium')`: checks `hapticEnabled` from cosmetic-store, calls `Haptics.impactAsync()` if enabled
  - Replace direct `Haptics.impactAsync()` calls in `CommandKeyBar.tsx` and other components with `triggerHaptic()`
- [ ] Add `shelly config set haptic true|false` to pseudo-shell

### Task 4: Font Manager
- [ ] Create `lib/font-manager.ts`:
  - `FONT_CATALOG`: array of `{ id, name, family, category: 'modern' | 'pixel', hasLigatures: boolean }`
  - Entries: JetBrains Mono, Fira Code, Source Code Pro, IBM Plex Mono, PixelMPlus, Press Start 2P, Silkscreen
  - `getActiveFontFamily()`: reads from cosmetic-store, returns family string
  - `useFontFamily()` hook: subscribes to cosmetic-store, returns current font family
  - Note: Pixel fonts need `expo-font` asset loading — add font files to `assets/fonts/` (Task 4b)
- [ ] Bundle font files: download JetBrains Mono, Fira Code, PixelMPlus10 into `assets/fonts/`
- [ ] Register fonts in `app.config.ts` via `expo-font` plugin or load dynamically with `Font.loadAsync()`

### Task 5: Font Integration
- [ ] Apply `useFontFamily()` to terminal text rendering:
  - `TerminalBlock.tsx`: use font family from hook for output text
  - `CommandInput.tsx`: use font family for input text
  - `RichInputOverlay.tsx`: match font family
  - `AIPane.tsx` message bubbles: use font family
- [ ] Add `shelly config set font "Fira Code"` and `shelly config set font_size 14` to pseudo-shell
- [ ] Add `shelly config set crt_font "PixelMPlus"` to pseudo-shell

### Task 6: CRT Overlay Component
- [ ] Create `components/CrtOverlay.tsx`:
  - Wraps children in a `View` with `pointerEvents="none"` overlay layers
  - **Scanlines**: repeating horizontal bars (2px opaque / 2px transparent), `rgba(0,0,0,0.15)` at 100% intensity
  - **Phosphor tint**: full-screen `View` with `backgroundColor: rgba(0, 255, 68, 0.03)` (P1 green)
  - **Vignette**: `radialGradient` via a pre-rendered PNG or four edge shadows using `boxShadow`/`LinearGradient`
  - **Flicker**: `react-native-reanimated` shared value oscillating opacity between 0.97-1.0 at ~8Hz
  - All sub-effects scale with `crtIntensity` (0 = invisible, 100 = full)
  - `enabled` prop from cosmetic-store; renders nothing when false
- [ ] Performance: use `shouldRasterizeIOS` / `renderToHardwareTextureAndroid` on overlay layers

### Task 7: CRT Integration
- [ ] Wrap `PaneSlot.tsx` children with `<CrtOverlay>` (reads `crtEnabled` from cosmetic-store)
- [ ] When CRT toggles on: auto-switch font to `crtFont`, sound profile to 'retro'
- [ ] When CRT toggles off: restore previous font and sound profile
- [ ] Add `shelly config set crt true|false` and `shelly config set crt_intensity 70` to pseudo-shell
- [ ] Terminal text color override when CRT on: all foreground text gets `#00FF44` tint (blend with theme)

### Task 8: Voice in AI Pane — Mic Button + Inline Mode
- [ ] Refactor `use-voice-chat.ts`: extract `processTranscript(transcript: string)` as a standalone function that takes a transcript and runs the routing/AI/TTS pipeline (currently embedded in `processRecording`)
- [ ] Create `hooks/use-pane-voice.ts`:
  - Uses `useSpeechInput()` for recording/transcription
  - On transcript ready: sends to `useAIPaneDispatch().dispatch()` as a user message
  - Tracks state: idle / recording / transcribing
  - Returns `{ isRecording, startVoice, stopVoice, status }`
- [ ] Add mic button to `AIPane.tsx` header (next to agent selector)
  - Tap: toggle recording via `use-pane-voice`
  - While recording: show `<VoiceWaveform />` inline in pane header area

### Task 9: VoiceWaveform Component
- [ ] Create `components/panes/VoiceWaveform.tsx`:
  - Compact horizontal bar (height: 24px, width: fills container)
  - 5-7 animated bars using `react-native-reanimated` shared values
  - Bar heights oscillate randomly while `isActive` is true
  - Color: `colors.accent` (matches theme)
  - Fade-in on mount, fade-out on unmount
- [ ] Use in AIPane header and CommandKeyBar area when voice is active

### Task 10: Voice in Terminal Pane
- [ ] Wire `CommandKeyBar.tsx` `onVoice` prop:
  - When pressed: use `useSpeechInput()` to record
  - On transcript: route through `parseInput()` from `lib/input-router.ts`
  - If command: inject into terminal input and execute
  - If AI query: dispatch to AI pane (or show inline)
- [ ] Show `<VoiceWaveform />` in CommandKeyBar area while recording
- [ ] Speak command results via `summarizeForSpeech()` + `speakText()` when `autoTts` is enabled

### Task 11: Full-Screen Voice Mode
- [ ] Update `VoiceChat.tsx` for new layout integration:
  - Triggered by: long-press mic button in any pane, or `shelly voice` command
  - Reuse existing overlay (Modal with pulse animation)
  - Connect to pane context: voice commands affect the focused pane's terminal/AI
  - Add pane indicator badge: "Talking to Terminal 1" / "Talking to AI"
- [ ] Add `shelly voice` command to pseudo-shell: opens VoiceChat overlay
- [ ] Add `shelly voice stop` to programmatically close

### Task 12: Hands-Free Mode
- [ ] Extend `VoiceChat.tsx` with `handsFree` prop:
  - When true: auto-start listening immediately on open (no tap needed)
  - After TTS completes: auto-restart listening after 500ms delay (existing `autoContinue` logic)
  - Keep screen awake: `expo-keep-awake` `activateKeepAwakeAsync()` while hands-free active
  - Minimal UI: hide transcript/response text, show only waveform + status icon (AMOLED-friendly)
  - Audio feedback: play `sounds.ai_start` when listening begins, `sounds.ai_complete` when response done
  - Exit keywords: detect "Shelly stop" or "終了" in transcript → auto-close
  - Save transcript log to `~/.shelly/voice-logs/YYYY-MM-DD-HHmmss.txt` via file system
- [ ] Add `shelly voice --hands-free` flag parsing in pseudo-shell
- [ ] Safety: before destructive commands (force-push, rm -rf), speak confirmation prompt and wait for "yes"/"cancel"

### Task 13: Feature Catalog
- [ ] Create `lib/feature-catalog.ts`:
  - Export `FEATURE_CATALOG: FeatureEntry[]`
  - Each entry: `{ id, name, description, category, triggerContext?, keybinding? }`
  - Categories: terminal, ai, voice, cosmetic, workflow, git, navigation, ide
  - Populate with all shipped features (autocomplete, clickable paths, inline blocks, command blocks, workflows, voice, CRT, themes, split panes, AI pane, browser pane, etc.)
  - Export `getCompressedCatalog()`: returns a compact string for system prompt injection (~2KB)
- [ ] Inject `getCompressedCatalog()` into AI pane system prompt (in `use-ai-pane-dispatch.ts` or `lib/ai-pane-context.ts`)

### Task 14: Context Hint Manager
- [ ] Create `lib/context-hint-manager.ts`:
  - `ContextHintManager` class:
    - `seenHints: Set<string>` loaded from AsyncStorage on init
    - `lastHintTime: number` — throttle to max 1 hint per 60 seconds
    - `checkTrigger(trigger: HintTrigger, context: any): HintEntry | null`
    - Triggers: `git_diff_repeated`, `error_detected`, `long_paste`, `repeated_command`, `manual_path_typed`, `first_ai_pane`, `manual_resize`, `ssh_connection`
  - `markSeen(hintId: string)`: persists to AsyncStorage
  - `isDisabled()`: reads `hintsEnabled` from cosmetic-store
- [ ] Create `components/ContextHint.tsx`:
  - Renders a single hint line: dim monospace text + small dismiss `x` button
  - Appears below relevant terminal output block
  - Auto-fades after 8 seconds if not dismissed
  - On dismiss: calls `markSeen()` and unmounts

### Task 15: Context Hints Integration
- [ ] Hook `ContextHintManager` into `TerminalBlock.tsx`:
  - After each command block renders, check triggers:
    - Error output → "Tap the error to send to AI Error Fixer"
    - `git diff` command count >= 3 → "Tip: tap any diff block to fold/unfold"
  - Render `<ContextHint>` below the block when a hint matches
- [ ] Hook into `CommandInput.tsx`:
  - Long paste detected → "Shift+Enter for multi-line editing"
  - Same command 3+ times → "Save as workflow: `shelly workflow save`"
- [ ] Add `shelly config set hints true|false` to pseudo-shell

### Task 16: Smart Command Palette Enhancement
- [ ] Extend existing command palette (if exists) or create `components/SmartCommandPalette.tsx`:
  - **Recent actions** section: last 5 commands/settings changed (stored in cosmetic-store or terminal-store)
  - **Suggested for you** section: based on recent terminal output keywords:
    - Git keywords → surface git features (savepoint, diff viewer)
    - Dev server detected → surface Browser Pane, port forwarding
    - Config file editing → surface themes, font settings
  - **All features** section: fuzzy search over `FEATURE_CATALOG`
  - Each item: icon + name + one-line description + keybinding badge
- [ ] Wire to `shelly` command or Ctrl+Shift+P shortcut

---

## Dependency Order

```
Task 1 (cosmetic store) ──┬── Task 2 (sound profiles)
                          ├── Task 3 (haptic toggle)
                          ├── Task 4 → Task 5 (fonts)
                          └── Task 6 → Task 7 (CRT)

Task 8 (AI voice) ──┬── Task 9 (waveform component)
                     └── Task 10 (terminal voice)
                          └── Task 11 (full-screen voice) → Task 12 (hands-free)

Task 13 (feature catalog) → Task 14 → Task 15 (context hints)
                          → Task 16 (smart palette)
```

Parallelizable groups:
- **Group A** (Tasks 1-7): Cosmetics — can be done independently of voice/discovery
- **Group B** (Tasks 8-12): Voice — depends on existing hooks only
- **Group C** (Tasks 13-16): Discovery — depends on cosmetic-store for hints toggle only

---

## Estimated Time

| Task | Estimate |
|------|----------|
| Task 1: Cosmetic Store | 3 min |
| Task 2: Sound Profiles | 4 min |
| Task 3: Haptic Toggle | 3 min |
| Task 4: Font Manager | 5 min |
| Task 5: Font Integration | 4 min |
| Task 6: CRT Overlay | 5 min |
| Task 7: CRT Integration | 4 min |
| Task 8: Voice in AI Pane | 5 min |
| Task 9: VoiceWaveform | 3 min |
| Task 10: Voice in Terminal | 4 min |
| Task 11: Full-Screen Voice | 3 min |
| Task 12: Hands-Free Mode | 5 min |
| Task 13: Feature Catalog | 5 min |
| Task 14: Context Hint Manager | 4 min |
| Task 15: Context Hints Integration | 4 min |
| Task 16: Smart Command Palette | 5 min |
| **Total** | **~66 min** |
