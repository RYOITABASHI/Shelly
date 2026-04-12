# Chelly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Chelly — a standalone Android chat app where users accomplish tasks via natural language, with invisible command execution powered by LLMs.

**Architecture:** Expo 54 + React Native app with a single chat screen. LLM (Gemini default) translates natural language into shell commands. JNI exec bridge (fork+pipe, no PTY) runs commands and returns results. Manus-style fold-out cards show execution details.

**Tech Stack:** Expo 54, React Native 0.81, TypeScript, NativeWind, Zustand, Gemini API, JNI (C + Kotlin)

**Spec:** `docs/superpowers/specs/2026-04-10-chelly-design.md`

**Reference codebase:** `~/Shelly/` — copy and simplify, do not import as dependency.

---

## File Map

### New project: `~/Chelly/`

| File | Responsibility | Source |
|---|---|---|
| `app.config.ts` | Expo config, bundle ID `dev.chelly.app` | New (based on Shelly) |
| `package.json` | Dependencies | New |
| `tailwind.config.js` | NativeWind config | Copy from Shelly |
| `tsconfig.json` | TypeScript config | Copy from Shelly |
| `app/_layout.tsx` | Root layout, store init, welcome gate | New |
| `app/index.tsx` | Chat screen (main) | Simplified from `~/Shelly/chelly/ChatScreen.tsx` |
| `app/settings.tsx` | Settings modal (API keys, cwd) | New |
| `components/ChatBubble.tsx` | Message rendering + execution fold-out | Simplified from `~/Shelly/chelly/components/ChatBubble.tsx` |
| `components/ChatMessageList.tsx` | FlatList + auto-scroll | Copy from `~/Shelly/chelly/components/ChatMessageList.tsx` |
| `components/ChatHeader.tsx` | Title bar + settings | Simplified from `~/Shelly/chelly/components/ChatHeader.tsx` |
| `components/CommandInput.tsx` | Text input + send + voice + attach | Simplified from `~/Shelly/components/input/CommandInput.tsx` |
| `components/ExecutionCard.tsx` | Manus-style fold-out for command results | New |
| `components/SafetyConfirm.tsx` | Destructive command confirmation bubble | New |
| `components/WelcomeScreen.tsx` | Onboarding + API key setup | New |
| `components/ArenaBubble.tsx` | Arena mode side-by-side | Copy from `~/Shelly/chelly/components/ArenaBubble.tsx` |
| `components/ActionsWizard.tsx` | GitHub Actions wizard | Simplified from `~/Shelly/chelly/components/ActionsWizardBubble.tsx` |
| `components/FileBrowser.tsx` | File cards in chat | New (simple) |
| `components/RuntimeInstaller.tsx` | "Installing Python..." UI | New |
| `hooks/use-ai-dispatch.ts` | Core AI orchestration | Heavily simplified from `~/Shelly/chelly/hooks/use-ai-dispatch.ts` |
| `hooks/use-exec.ts` | Exec bridge React hook | Simplified from `~/Shelly/hooks/use-native-exec.ts` |
| `lib/gemini.ts` | Gemini API + function calling | Based on `~/Shelly/lib/gemini.ts` + function calling additions |
| `lib/claude.ts` | Claude API (direct fetch) | New |
| `lib/groq.ts` | Groq API | Copy from `~/Shelly/lib/groq.ts` |
| `lib/cerebras.ts` | Cerebras API | Copy from `~/Shelly/lib/cerebras.ts` |
| `lib/perplexity.ts` | Perplexity API | Copy from `~/Shelly/lib/perplexity.ts` |
| `lib/local-llm.ts` | Ollama client | Simplified from `~/Shelly/lib/local-llm.ts` |
| `lib/arena-selector.ts` | Arena agent selection | Copy from `~/Shelly/lib/arena-selector.ts` |
| `lib/system-prompt.ts` | System prompt generation | New |
| `lib/command-safety.ts` | Command classification + blocklist | Based on `~/Shelly/lib/command-safety.ts` |
| `lib/runtime-manager.ts` | Deferred runtime download | New |
| `lib/id.ts` | ID generation | Copy from `~/Shelly/lib/id.ts` |
| `store/chat-store.ts` | Chat messages + persistence | Simplified from `~/Shelly/chelly/store/chat-store.ts` |
| `store/settings-store.ts` | API keys, cwd, preferences | New |
| `store/arena-store.ts` | Arena state | Copy from `~/Shelly/store/arena-store.ts` |
| `modules/exec-bridge/android/src/main/jni/chelly-exec.c` | JNI fork+exec+pipe | From `~/Shelly/modules/terminal-emulator/android/src/main/jni/shelly-exec.c` (+ buffer fix) |
| `modules/exec-bridge/android/src/main/java/.../ChellyJNI.kt` | JNI wrapper (exec only) | From `~/Shelly/.../ShellyJNI.kt` (remove PTY) |
| `modules/exec-bridge/android/src/main/java/.../ExecModule.kt` | Expo module | From `~/Shelly/.../TerminalEmulatorModule.kt` (exec only) |
| `modules/exec-bridge/android/CMakeLists.txt` | CMake build | Based on Shelly's |
| `modules/exec-bridge/src/ExecBridgeModule.ts` | TS interface | New |
| `modules/exec-bridge/expo-module.config.json` | Module config | New |
| `modules/voice-input/android/src/main/java/.../VoiceInputModule.kt` | SpeechRecognizer wrapper | New |
| `modules/voice-input/src/VoiceInputModule.ts` | TS interface | New |
| `modules/voice-input/expo-module.config.json` | Module config | New |

---

## Task 1: Project Scaffold

**Files:**
- Create: `~/Chelly/package.json`
- Create: `~/Chelly/app.config.ts`
- Create: `~/Chelly/tsconfig.json`
- Create: `~/Chelly/tailwind.config.js`
- Create: `~/Chelly/babel.config.js`
- Create: `~/Chelly/metro.config.js`
- Create: `~/Chelly/global.css`
- Create: `~/Chelly/app/_layout.tsx`
- Create: `~/Chelly/app/index.tsx` (placeholder)
- Create: `~/Chelly/lib/id.ts`

- [ ] **Step 1: Create Expo project**

```bash
cd ~
npx create-expo-app@latest Chelly --template blank-typescript
cd ~/Chelly
```

- [ ] **Step 2: Install core dependencies**

```bash
cd ~/Chelly
pnpm add zustand @react-native-async-storage/async-storage expo-secure-store nativewind tailwindcss@3 react-native-reanimated react-native-safe-area-context
pnpm add -D @types/react @types/react-native
```

- [ ] **Step 3: Configure NativeWind**

Copy `tailwind.config.js` from `~/Shelly/tailwind.config.js`, update content paths to `./app/**/*.tsx`, `./components/**/*.tsx`.

Copy `babel.config.js` from Shelly, ensure `nativewind/babel` plugin is included.

Copy `metro.config.js` from Shelly with NativeWind `withNativeWind` wrapper.

Create `global.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Create app.config.ts**

```typescript
import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Chelly",
  slug: "chelly",
  version: "1.0.0",
  orientation: "default",
  icon: "./assets/icon.png",
  scheme: "chelly",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#000000",
    },
    package: "dev.chelly.app",
  },
  plugins: ["expo-secure-store"],
};

export default config;
```

- [ ] **Step 5: Create lib/id.ts**

```typescript
export const generateId = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
```

- [ ] **Step 6: Create minimal app/_layout.tsx**

```typescript
import "@/global.css";
import { Stack } from "expo-router";

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

- [ ] **Step 7: Create placeholder app/index.tsx**

```typescript
import { View, Text } from "react-native";

export default function ChatScreen() {
  return (
    <View className="flex-1 bg-black items-center justify-center">
      <Text className="text-white text-xl">Chelly</Text>
    </View>
  );
}
```

- [ ] **Step 8: Init git and commit**

```bash
cd ~/Chelly
git init
echo "node_modules/\n.expo/\nandroid/\nios/\n*.apk" > .gitignore
git add -A
git commit -m "feat: initial Chelly project scaffold (Expo 54 + NativeWind)"
```

---

## Task 2: Stores (chat-store + settings-store)

**Files:**
- Create: `~/Chelly/store/chat-store.ts`
- Create: `~/Chelly/store/settings-store.ts`

- [ ] **Step 1: Create settings-store.ts**

```typescript
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

type Provider = "gemini" | "claude" | "groq" | "cerebras" | "perplexity" | "local";

type SettingsStore = {
  activeProvider: Provider;
  geminiApiKey: string;
  claudeApiKey: string;
  groqApiKey: string;
  cerebrasApiKey: string;
  perplexityApiKey: string;
  localLlmUrl: string;
  currentCwd: string;
  isOnboarded: boolean;
  isLoaded: boolean;

  load: () => Promise<void>;
  save: () => Promise<void>;
  setApiKey: (provider: Provider, key: string) => Promise<void>;
  setActiveProvider: (provider: Provider) => void;
  setCwd: (cwd: string) => void;
  setOnboarded: () => void;
};

const DEFAULT_CWD = "/data/data/com.termux/files/home/chelly/workspace";
const SETTINGS_KEY = "chelly_settings";

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  activeProvider: "gemini",
  geminiApiKey: "",
  claudeApiKey: "",
  groqApiKey: "",
  cerebrasApiKey: "",
  perplexityApiKey: "",
  localLlmUrl: "",
  currentCwd: DEFAULT_CWD,
  isOnboarded: false,
  isLoaded: false,

  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_KEY);
      const data = raw ? JSON.parse(raw) : {};
      // Load API keys from secure storage
      const geminiApiKey = await SecureStore.getItemAsync("chelly_gemini_key") ?? "";
      const claudeApiKey = await SecureStore.getItemAsync("chelly_claude_key") ?? "";
      const groqApiKey = await SecureStore.getItemAsync("chelly_groq_key") ?? "";
      const cerebrasApiKey = await SecureStore.getItemAsync("chelly_cerebras_key") ?? "";
      const perplexityApiKey = await SecureStore.getItemAsync("chelly_perplexity_key") ?? "";
      set({
        activeProvider: data.activeProvider ?? "gemini",
        localLlmUrl: data.localLlmUrl ?? "",
        currentCwd: data.currentCwd ?? DEFAULT_CWD,
        isOnboarded: data.isOnboarded ?? false,
        geminiApiKey, claudeApiKey, groqApiKey, cerebrasApiKey, perplexityApiKey,
        isLoaded: true,
      });
    } catch { set({ isLoaded: true }); }
  },

  save: async () => {
    const s = get();
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({
      activeProvider: s.activeProvider,
      localLlmUrl: s.localLlmUrl,
      currentCwd: s.currentCwd,
      isOnboarded: s.isOnboarded,
    }));
  },

  setApiKey: async (provider, key) => {
    await SecureStore.setItemAsync(`chelly_${provider}_key`, key);
    set({ [`${provider}ApiKey`]: key } as any);
  },

  setActiveProvider: (provider) => { set({ activeProvider: provider }); get().save(); },
  setCwd: (cwd) => { set({ currentCwd: cwd }); get().save(); },
  setOnboarded: () => { set({ isOnboarded: true }); get().save(); },
}));
```

- [ ] **Step 2: Create chat-store.ts**

Copy from `~/Shelly/chelly/store/chat-store.ts` with these changes:
- Storage key: `chelly_chats` → `STORAGE_KEY = 'chelly_chats'`
- Remove `WizardType`, `ActionsWizardData`, `AutoCheckState` types
- Remove `approvalData`, `wizardType`, `wizardData`, `autoCheckState`, `arenaId`, `errorSummaryData` from `ChatMessage`
- Remove `searchSessions` (single session)
- Keep `ChatAgent` type but simplify to: `'gemini' | 'claude' | 'groq' | 'cerebras' | 'perplexity' | 'local' | 'arena'`
- Add `safetyConfirm` field to `ChatMessage`:
  ```typescript
  safetyConfirm?: {
    commands: Array<{ cmd: string; desc: string }>;
    status: 'pending' | 'approved' | 'rejected';
  };
  ```

- [ ] **Step 3: Commit**

```bash
cd ~/Chelly
git add store/
git commit -m "feat: add chat-store and settings-store (Zustand + AsyncStorage + SecureStore)"
```

---

## Task 3: Exec Bridge Native Module

**Files:**
- Create: `~/Chelly/modules/exec-bridge/expo-module.config.json`
- Create: `~/Chelly/modules/exec-bridge/src/ExecBridgeModule.ts`
- Create: `~/Chelly/modules/exec-bridge/src/index.ts`
- Create: `~/Chelly/modules/exec-bridge/android/build.gradle`
- Create: `~/Chelly/modules/exec-bridge/android/CMakeLists.txt`
- Create: `~/Chelly/modules/exec-bridge/android/src/main/AndroidManifest.xml`
- Create: `~/Chelly/modules/exec-bridge/android/src/main/jni/chelly-exec.c`
- Create: `~/Chelly/modules/exec-bridge/android/src/main/java/dev/chelly/execbridge/ChellyJNI.kt`
- Create: `~/Chelly/modules/exec-bridge/android/src/main/java/dev/chelly/execbridge/ExecBridgeModule.kt`

- [ ] **Step 1: Create expo-module.config.json**

```json
{
  "platforms": ["android"],
  "android": {
    "modules": ["dev.chelly.execbridge.ExecBridgeModule"]
  }
}
```

- [ ] **Step 2: Create TypeScript interface**

`modules/exec-bridge/src/ExecBridgeModule.ts`:
```typescript
import { requireNativeModule } from "expo-modules-core";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const ExecBridge = requireNativeModule("ExecBridge");

export async function execCommand(
  command: string,
  cwd?: string,
  timeoutMs: number = 30000
): Promise<ExecResult> {
  return ExecBridge.execCommand(command, cwd ?? "", timeoutMs);
}
```

`modules/exec-bridge/src/index.ts`:
```typescript
export { execCommand, type ExecResult } from "./ExecBridgeModule";
```

- [ ] **Step 3: Create chelly-exec.c**

Copy from `~/Shelly/modules/terminal-emulator/android/src/main/jni/shelly-exec.c` with:
- Rename JNI function: `Java_expo_modules_terminalemulator_ShellyJNI_execSubprocess` → `Java_dev_chelly_execbridge_ChellyJNI_execSubprocess`
- Add `cwd` parameter (use provided cwd instead of hardcoded homePath for chdir)
- Fix buffer overflow: before `stdout_buf[stdout_len] = '\0'`, add:
  ```c
  /* Ensure space for null terminator */
  if (stdout_len >= stdout_cap) {
      stdout_buf = (char *)realloc(stdout_buf, stdout_len + 1);
  }
  stdout_buf[stdout_len] = '\0';
  ```
  Same fix for `stderr_buf`.

- [ ] **Step 4: Create ChellyJNI.kt**

```kotlin
package dev.chelly.execbridge

object ChellyJNI {
    init {
        System.loadLibrary("chelly-exec")
    }

    @JvmStatic
    external fun execSubprocess(
        linkerPath: String,
        bashPath: String,
        ldLibPath: String,
        homePath: String,
        cwd: String,
        command: String,
        timeoutMs: Int
    ): Array<String>
}
```

- [ ] **Step 5: Create ExecBridgeModule.kt**

```kotlin
package dev.chelly.execbridge

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ExecBridgeModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ExecBridge")

        AsyncFunction("execCommand") { command: String, cwd: String, timeoutMs: Int ->
            val linkerPath = findLinker()
            val bashPath = findBash()
            val ldLibPath = findLdLibPath()
            val homePath = System.getenv("HOME") ?: "/data/data/dev.chelly.app/files"
            val workDir = if (cwd.isNotEmpty()) cwd else "$homePath/chelly/workspace"

            // Ensure workspace exists
            File(workDir).mkdirs()

            val result = ChellyJNI.execSubprocess(
                linkerPath, bashPath, ldLibPath, homePath, workDir, command, timeoutMs
            )

            mapOf(
                "exitCode" to (result[0].toIntOrNull() ?: -1),
                "stdout" to result[1],
                "stderr" to result[2]
            )
        }
    }

    private fun findLinker(): String {
        val candidates = listOf(
            "/system/bin/linker64",
            "/apex/com.android.runtime/bin/linker64",
            "/system/bin/linker"
        )
        return candidates.firstOrNull { File(it).exists() }
            ?: throw RuntimeException("linker64 not found")
    }

    private fun findBash(): String {
        // Look for bundled bash first, then system sh
        val appLib = appContext.reactContext?.applicationInfo?.nativeLibraryDir ?: ""
        val candidates = listOf(
            "$appLib/libbash.so",
            "/system/bin/sh"
        )
        return candidates.firstOrNull { File(it).exists() } ?: "/system/bin/sh"
    }

    private fun findLdLibPath(): String {
        val appLib = appContext.reactContext?.applicationInfo?.nativeLibraryDir ?: ""
        return appLib
    }
}
```

- [ ] **Step 6: Create CMakeLists.txt and build.gradle**

`modules/exec-bridge/android/CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.10)
project(chelly-exec)

add_library(chelly-exec SHARED src/main/jni/chelly-exec.c)
target_link_libraries(chelly-exec log)
```

`modules/exec-bridge/android/build.gradle`:
```groovy
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'
apply plugin: 'expo-module-gradle-plugin'

android {
    namespace "dev.chelly.execbridge"
    compileSdk 34

    defaultConfig {
        minSdk 24
        externalNativeBuild { cmake { cppFlags "" } }
    }

    externalNativeBuild {
        cmake { path "CMakeLists.txt" }
    }
}

dependencies {
    implementation project(':expo-modules-core')
}
```

- [ ] **Step 7: Create AndroidManifest.xml**

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android" />
```

- [ ] **Step 8: Add module to app.config.ts plugins**

Add `"./modules/exec-bridge"` to the `plugins` array.

- [ ] **Step 9: Create hooks/use-exec.ts**

```typescript
import { useCallback } from "react";
import { execCommand, type ExecResult } from "@/modules/exec-bridge";
import { useSettingsStore } from "@/store/settings-store";

export function useExec() {
  const cwd = useSettingsStore((s) => s.currentCwd);
  const setCwd = useSettingsStore((s) => s.setCwd);

  const exec = useCallback(async (command: string, timeoutMs?: number): Promise<ExecResult> => {
    // Detect cd commands and update cwd
    const cdMatch = command.match(/^cd\s+(.+)$/);
    if (cdMatch) {
      const target = cdMatch[1].replace(/^~/, "/data/data/com.termux/files/home");
      // Execute cd and pwd to get resolved path
      const result = await execCommand(`cd ${target} && pwd`, cwd, timeoutMs);
      if (result.exitCode === 0) {
        setCwd(result.stdout.trim());
      }
      return result;
    }
    return execCommand(command, cwd, timeoutMs);
  }, [cwd, setCwd]);

  return { exec, cwd };
}
```

- [ ] **Step 10: Commit**

```bash
cd ~/Chelly
git add modules/exec-bridge/ hooks/use-exec.ts app.config.ts
git commit -m "feat: add exec-bridge native module (JNI fork+exec+pipe)"
```

---

## Task 4: Command Safety

**Files:**
- Create: `~/Chelly/lib/command-safety.ts`
- Create: `~/Chelly/components/SafetyConfirm.tsx`

- [ ] **Step 1: Create lib/command-safety.ts**

Reference: `~/Shelly/lib/command-safety.ts`. Simplify and add Chelly-specific rules.

```typescript
export type SafetyLevel = "SAFE" | "WRITE" | "DESTRUCTIVE" | "BLOCKED";

const BLOCKLIST = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\//,  // rm -rf /
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?~/,     // rm -rf ~
  /\bdd\s+if=/,
  /\bcurl\s.*\|\s*(sh|bash)/,
  /\bwget\s.*\|\s*(sh|bash)/,
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/, /\brmdir\b/, /\bchmod\b/, /\bchown\b/,
  /\bkill\b/, /\bkillall\b/, /\bmkfs\b/, /\bformat\b/,
];

export function classifyCommand(cmd: string): SafetyLevel {
  const trimmed = cmd.trim();

  // Check blocklist
  if (BLOCKLIST.some((p) => p.test(trimmed))) return "BLOCKED";

  // Check destructive
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed))) return "DESTRUCTIVE";

  // Check write (file modification)
  if (/\bcat\s.*>|>>|\btee\b|\bmkdir\b|\btouch\b|\bcp\b|\bmv\b|\bpip\b|\bnpm\b|\bgit\s+(commit|push|merge)/.test(trimmed)) return "WRITE";

  return "SAFE";
}

export function getBlockMessage(): string {
  return "この操作は安全上の理由で実行できません。別の方法を試します。";
}

export function getConfirmMessage(cmd: string, desc: string): string {
  return desc || `このコマンドを実行します: ${cmd.slice(0, 50)}`;
}
```

- [ ] **Step 2: Create components/SafetyConfirm.tsx**

```typescript
import { View, Text, Pressable } from "react-native";

type Props = {
  description: string;
  onApprove: () => void;
  onReject: () => void;
};

export function SafetyConfirm({ description, onApprove, onReject }: Props) {
  return (
    <View className="bg-yellow-900/30 border border-yellow-600/50 rounded-xl p-4 my-2">
      <Text className="text-yellow-200 text-sm mb-3">{description}</Text>
      <View className="flex-row gap-3">
        <Pressable onPress={onApprove} className="bg-yellow-600 rounded-lg px-4 py-2">
          <Text className="text-white font-medium">実行</Text>
        </Pressable>
        <Pressable onPress={onReject} className="bg-zinc-700 rounded-lg px-4 py-2">
          <Text className="text-zinc-300 font-medium">キャンセル</Text>
        </Pressable>
      </View>
    </View>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/Chelly
git add lib/command-safety.ts components/SafetyConfirm.tsx
git commit -m "feat: add command safety classification and confirmation UI"
```

---

## Task 5: System Prompt & LLM Clients

**Files:**
- Create: `~/Chelly/lib/system-prompt.ts`
- Create: `~/Chelly/lib/gemini.ts`
- Create: `~/Chelly/lib/claude.ts`
- Create: `~/Chelly/lib/groq.ts`
- Create: `~/Chelly/lib/cerebras.ts`
- Create: `~/Chelly/lib/perplexity.ts`
- Create: `~/Chelly/lib/local-llm.ts`

- [ ] **Step 1: Create lib/system-prompt.ts**

```typescript
export function buildSystemPrompt(cwd: string): string {
  return `You are Chelly, a helpful assistant that accomplishes tasks on the user's Android device.

You have two response modes:
1. EXECUTE — run shell commands on the device
2. RESPOND — reply with text only (no commands needed)

When you need to run commands, respond with JSON:
{"explanation":"...","commands":[{"cmd":"...","desc":"..."}]}

When no commands are needed, respond with plain text (no JSON).

## Command rules
- Commands must work with sh/bash
- Current working directory: ${cwd}
- Use relative paths within the working directory
- For file creation, use heredoc: cat > file.txt << 'EOF'
- For long-running commands, add "timeout": 60 to the command object

## Style rules
- Keep explanations concise and non-technical
- Never reference "terminal", "shell", "command line", or "Termux"
- Speak the user's language (detect from their message)
- You're helping someone who may have never programmed before`;
}
```

- [ ] **Step 2: Create lib/gemini.ts**

Copy from `~/Shelly/lib/gemini.ts`. Key changes:
- Add function calling tools definition for `execute_commands` and `respond`
- Add `supportsFC` capability detection (try function calling, cache result)
- Fall back to JSON prompting if function calling not supported
- Remove all Shelly-specific imports (terminal store, etc.)
- Keep streaming support and history format conversion

- [ ] **Step 3: Create lib/claude.ts**

New file — direct Anthropic API via fetch (not CLI):

```typescript
export type ClaudeMessage = { role: "user" | "assistant"; content: string };

export async function claudeChatStream(
  apiKey: string,
  systemPrompt: string,
  messages: ClaudeMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    // Parse SSE events
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "content_block_delta" && parsed.delta?.text) {
          full += parsed.delta.text;
          onChunk(parsed.delta.text);
        }
      } catch {}
    }
  }

  return full;
}
```

- [ ] **Step 4: Copy and adapt remaining LLM clients**

Copy from Shelly, removing all Shelly-specific imports:
- `~/Shelly/lib/groq.ts` → `~/Chelly/lib/groq.ts`
- `~/Shelly/lib/cerebras.ts` → `~/Chelly/lib/cerebras.ts`
- `~/Shelly/lib/perplexity.ts` → `~/Chelly/lib/perplexity.ts`
- `~/Shelly/lib/local-llm.ts` → `~/Chelly/lib/local-llm.ts` (simplify: remove terminal-specific orchestration, keep Ollama streaming core)

- [ ] **Step 5: Commit**

```bash
cd ~/Chelly
git add lib/
git commit -m "feat: add system prompt and LLM clients (Gemini, Claude, Groq, Cerebras, Perplexity, Local)"
```

---

## Task 6: AI Dispatch Hook

**Files:**
- Create: `~/Chelly/hooks/use-ai-dispatch.ts`

This is the core orchestration. Heavily simplified from Shelly's 1363-line version.

- [ ] **Step 1: Create hooks/use-ai-dispatch.ts**

Key structure:
```typescript
import { useCallback, useRef } from "react";
import { useChatStore, type ChatMessage } from "@/store/chat-store";
import { useSettingsStore } from "@/store/settings-store";
import { useExec } from "@/hooks/use-exec";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { classifyCommand, getBlockMessage, getConfirmMessage } from "@/lib/command-safety";
import { generateId } from "@/lib/id";

// Import LLM clients
import { geminiChatStream } from "@/lib/gemini";
import { claudeChatStream } from "@/lib/claude";
import { groqChatStream } from "@/lib/groq";
import { cerebrasChatStream } from "@/lib/cerebras";
import { perplexityChatStream } from "@/lib/perplexity";
import { orchestrateChatStream } from "@/lib/local-llm";
```

Core flow:
1. Build conversation context (last 20 messages, 500 char truncation)
2. Route to active provider
3. Parse response (try JSON, fall back to plain text)
4. For each command: classify → SAFE/WRITE: execute, DESTRUCTIVE: prompt, BLOCKED: reject+retry
5. Execute via `useExec`
6. Add result message to chat store

Target: ~300-400 lines (vs Shelly's 1363).

Remove: terminal context injection, input-router, decision-log, auth URL detection, CLI output filtering, arena mode (separate hook), all Shelly-specific imports.

- [ ] **Step 2: Commit**

```bash
cd ~/Chelly
git add hooks/use-ai-dispatch.ts
git commit -m "feat: add AI dispatch hook (LLM routing + command execution + safety)"
```

---

## Task 7: Chat UI Components

**Files:**
- Create: `~/Chelly/components/ExecutionCard.tsx`
- Create: `~/Chelly/components/ChatBubble.tsx`
- Create: `~/Chelly/components/ChatMessageList.tsx`
- Create: `~/Chelly/components/ChatHeader.tsx`
- Create: `~/Chelly/components/CommandInput.tsx`

- [ ] **Step 1: Create components/ExecutionCard.tsx**

Manus-style fold-out card:
```typescript
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import type { CommandExecution } from "@/store/chat-store";

type Props = { executions: CommandExecution[] };

export function ExecutionCard({ executions }: Props) {
  const [expanded, setExpanded] = useState(false);
  const allSuccess = executions.every((e) => e.exitCode === 0);

  return (
    <Pressable onPress={() => setExpanded(!expanded)} className="mt-2">
      <View className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
        <View className="flex-row items-center gap-2">
          <Text className={allSuccess ? "text-green-400" : "text-red-400"}>
            {allSuccess ? "✓" : "✗"}
          </Text>
          <Text className="text-zinc-400 text-xs">
            {executions.length} step{executions.length > 1 ? "s" : ""} completed
          </Text>
          <Text className="text-zinc-500 text-xs ml-auto">
            {expanded ? "▲" : "▼"}
          </Text>
        </View>
        {expanded && executions.map((e, i) => (
          <View key={i} className="mt-2 border-t border-zinc-700/30 pt-2">
            <Text className="text-zinc-500 text-xs font-mono">{e.command}</Text>
            {e.output ? (
              <Text className="text-zinc-300 text-xs font-mono mt-1">{e.output.slice(0, 500)}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </Pressable>
  );
}
```

- [ ] **Step 2: Create ChatBubble.tsx**

Simplified from `~/Shelly/chelly/components/ChatBubble.tsx` (~740 lines → ~150 lines):
- User bubble: right-aligned, blue background
- Assistant bubble: left-aligned, dark background
- If message has `executions`, render `ExecutionCard`
- If message has `safetyConfirm`, render `SafetyConfirm`
- Streaming: show `streamingText` with cursor animation
- Remove: approval proxy, wizard rendering, arena, error summary, translate overlay

- [ ] **Step 3: Create ChatMessageList.tsx**

Copy from `~/Shelly/chelly/components/ChatMessageList.tsx` (~270 lines).
Simplify: remove terminal-specific scroll behavior.
Keep: FlatList, auto-scroll on new message, inverted list.

- [ ] **Step 4: Create ChatHeader.tsx**

Simple header: app name + settings gear icon + clear chat button.
~50 lines.

- [ ] **Step 5: Create CommandInput.tsx**

Text input with send button. Simplified from Shelly's.
- TextInput with placeholder "何でも聞いてください..."
- Send button (arrow icon)
- Voice button (microphone icon, wired in Task 11)
- No file attach in v1 (add later)
~100 lines.

- [ ] **Step 6: Commit**

```bash
cd ~/Chelly
git add components/
git commit -m "feat: add chat UI components (bubbles, execution cards, input)"
```

---

## Task 8: Main Chat Screen + Welcome Screen

**Files:**
- Modify: `~/Chelly/app/index.tsx`
- Modify: `~/Chelly/app/_layout.tsx`
- Create: `~/Chelly/components/WelcomeScreen.tsx`
- Create: `~/Chelly/app/settings.tsx`

- [ ] **Step 1: Create WelcomeScreen.tsx**

Onboarding flow:
1. Welcome text: "Chellyは自然言語でなんでもできるアプリです"
2. Gemini API key input with inline guide link to AI Studio
3. "始める" button → saves key → navigates to chat

~120 lines.

- [ ] **Step 2: Update app/_layout.tsx**

Add store initialization:
```typescript
import "@/global.css";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { useChatStore } from "@/store/chat-store";
import { useSettingsStore } from "@/store/settings-store";

export default function RootLayout() {
  const loadChat = useChatStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.load);

  useEffect(() => {
    loadChat();
    loadSettings();
  }, []);

  return <Stack screenOptions={{ headerShown: false }} />;
}
```

- [ ] **Step 3: Update app/index.tsx (ChatScreen)**

Main screen — simplified from Shelly's 1410-line ChatScreen to ~200 lines:
- If not onboarded → show WelcomeScreen
- Else → ChatHeader + ChatMessageList + CommandInput
- Wire `useAiDispatch` hook for send handler
- Handle safety confirmations via callback

- [ ] **Step 4: Create app/settings.tsx**

Settings modal:
- Active provider selector (dropdown/radio)
- API key fields per provider (with show/hide toggle)
- Local LLM URL field
- Current working directory display + reset button
- ~150 lines.

- [ ] **Step 5: Commit**

```bash
cd ~/Chelly
git add app/ components/WelcomeScreen.tsx
git commit -m "feat: add chat screen, welcome onboarding, and settings"
```

---

## Task 9: Arena Mode

**Files:**
- Create: `~/Chelly/store/arena-store.ts`
- Create: `~/Chelly/lib/arena-selector.ts`
- Create: `~/Chelly/components/ArenaBubble.tsx`

- [ ] **Step 1: Copy arena files from Shelly**

- `~/Shelly/store/arena-store.ts` → `~/Chelly/store/arena-store.ts` (134 lines, minimal changes)
- `~/Shelly/lib/arena-selector.ts` → `~/Chelly/lib/arena-selector.ts` (37 lines, as-is)
- `~/Shelly/chelly/components/ArenaBubble.tsx` → `~/Chelly/components/ArenaBubble.tsx` (305 lines, remove terminal refs)

- [ ] **Step 2: Wire arena into use-ai-dispatch**

Add arena routing: when `@arena` prefix or arena mode enabled → dispatch to multiple providers → create arena entries.

- [ ] **Step 3: Commit**

```bash
cd ~/Chelly
git add store/arena-store.ts lib/arena-selector.ts components/ArenaBubble.tsx hooks/use-ai-dispatch.ts
git commit -m "feat: add Arena mode (multi-LLM comparison)"
```

---

## Task 10: GitHub Actions Wizard

**Files:**
- Create: `~/Chelly/components/ActionsWizard.tsx`

- [ ] **Step 1: Copy and simplify from Shelly**

Source: `~/Shelly/chelly/components/ActionsWizardBubble.tsx` (442 lines).
Simplify: remove terminal-specific execution. Use `useExec` hook to run git commands.
~300 lines.

- [ ] **Step 2: Wire into chat flow**

Detect "CI", "GitHub Actions", "ワークフロー" in user message → trigger wizard mode.

- [ ] **Step 3: Commit**

```bash
cd ~/Chelly
git add components/ActionsWizard.tsx
git commit -m "feat: add GitHub Actions wizard"
```

---

## Task 11: Voice Input Module

**Files:**
- Create: `~/Chelly/modules/voice-input/expo-module.config.json`
- Create: `~/Chelly/modules/voice-input/src/VoiceInputModule.ts`
- Create: `~/Chelly/modules/voice-input/src/index.ts`
- Create: `~/Chelly/modules/voice-input/android/build.gradle`
- Create: `~/Chelly/modules/voice-input/android/src/main/AndroidManifest.xml`
- Create: `~/Chelly/modules/voice-input/android/src/main/java/dev/chelly/voiceinput/VoiceInputModule.kt`

- [ ] **Step 1: Create Kotlin module**

Thin wrapper around Android `SpeechRecognizer`:
- `startListening()` → starts STT, emits events
- `stopListening()` → stops
- Events: `onResult(text)`, `onError(msg)`
~100 lines Kotlin.

- [ ] **Step 2: Create TypeScript interface**

```typescript
import { requireNativeModule } from "expo-modules-core";

const VoiceInput = requireNativeModule("VoiceInput");

export function startListening(): void { VoiceInput.startListening(); }
export function stopListening(): void { VoiceInput.stopListening(); }

// Events: subscribe via NativeEventEmitter
```

- [ ] **Step 3: Wire into CommandInput**

Add microphone button. On press → `startListening()`. On result → fill text input.

- [ ] **Step 4: Add RECORD_AUDIO permission to app.config.ts**

```typescript
android: {
  permissions: ["android.permission.RECORD_AUDIO"],
}
```

- [ ] **Step 5: Commit**

```bash
cd ~/Chelly
git add modules/voice-input/ components/CommandInput.tsx app.config.ts
git commit -m "feat: add voice input (Android SpeechRecognizer native module)"
```

---

## Task 12: File Browser

**Files:**
- Create: `~/Chelly/components/FileBrowser.tsx`
- Create: `~/Chelly/components/FilePreview.tsx`

- [ ] **Step 1: Create FileBrowser.tsx**

After command execution, detect file creation/modification. Show inline card with:
- File name + icon
- File size
- "View" button → opens FilePreview

Detection: parse command output for file paths, or check `stdout` for file-related output.
~100 lines.

- [ ] **Step 2: Create FilePreview.tsx**

Modal that reads file via exec bridge (`cat file`) and displays content:
- Text files: monospace view
- Images: `<Image>` component with `file://` URI
- Other: "Unsupported format" message
~120 lines.

- [ ] **Step 3: Commit**

```bash
cd ~/Chelly
git add components/FileBrowser.tsx components/FilePreview.tsx
git commit -m "feat: add file browser and preview in chat"
```

---

## Task 13: Runtime Manager

**Files:**
- Create: `~/Chelly/lib/runtime-manager.ts`
- Create: `~/Chelly/components/RuntimeInstaller.tsx`

- [ ] **Step 1: Create lib/runtime-manager.ts**

```typescript
type Runtime = "python3" | "node" | "git";

const RUNTIME_MAP: Record<Runtime, { url: string; size: string; sha256: string }> = {
  python3: {
    url: "https://github.com/RYOITABASHI/Chelly/releases/download/runtimes-v1/python3.tar.gz",
    size: "~50MB",
    sha256: "TBD",
  },
  node: {
    url: "https://github.com/RYOITABASHI/Chelly/releases/download/runtimes-v1/node.tar.gz",
    size: "~35MB",
    sha256: "TBD",
  },
  git: {
    url: "https://github.com/RYOITABASHI/Chelly/releases/download/runtimes-v1/git.tar.gz",
    size: "~15MB",
    sha256: "TBD",
  },
};

export function detectMissingRuntime(stderr: string, exitCode: number): Runtime | null {
  if (exitCode !== 127) return null;
  if (/python3?.*not found/.test(stderr)) return "python3";
  if (/node.*not found/.test(stderr)) return "node";
  if (/git.*not found/.test(stderr)) return "git";
  return null;
}

export function getRuntimeInfo(runtime: Runtime) {
  return RUNTIME_MAP[runtime];
}

// Download + extract + verify will use exec bridge to run curl + tar + sha256sum
```

- [ ] **Step 2: Create RuntimeInstaller.tsx**

Chat-inline component showing:
- "Pythonをセットアップ中..."
- Download progress (if available)
- Wi-Fi recommendation with override button
- Success/failure message
~100 lines.

- [ ] **Step 3: Wire into use-ai-dispatch**

After command fails with exit 127, call `detectMissingRuntime`. If detected:
1. Show RuntimeInstaller in chat
2. Download + install
3. Retry original command

- [ ] **Step 4: Commit**

```bash
cd ~/Chelly
git add lib/runtime-manager.ts components/RuntimeInstaller.tsx hooks/use-ai-dispatch.ts
git commit -m "feat: add runtime manager (deferred Python/Node/Git download)"
```

---

## Task 14: README & OSS Prep

**Files:**
- Create: `~/Chelly/README.md`
- Create: `~/Chelly/LICENSE`
- Create: `~/Chelly/.github/workflows/build-android.yml`

- [ ] **Step 1: Create README.md**

Sections: What is Chelly, Features, Screenshots (placeholder), Getting Started, Build from Source, Contributing, License.

- [ ] **Step 2: Create LICENSE (MIT)**

- [ ] **Step 3: Create GitHub Actions workflow**

Copy from `~/Shelly/.github/workflows/build-android.yml`, adapt for Chelly (different package name, no Termux dependencies).

- [ ] **Step 4: Create GitHub repo and push**

```bash
cd ~/Chelly
gh repo create RYOITABASHI/Chelly --public --source=. --remote=origin
git push -u origin main
```

- [ ] **Step 5: Commit**

```bash
cd ~/Chelly
git add README.md LICENSE .github/
git commit -m "docs: add README, LICENSE (MIT), and CI workflow"
git push
```

---

## Task 15: Build & Smoke Test

- [ ] **Step 1: Generate Android project**

```bash
cd ~/Chelly
npx expo prebuild --platform android
```

- [ ] **Step 2: Build debug APK**

```bash
cd ~/Chelly/android
./gradlew :app:assembleDebug
```

- [ ] **Step 3: Verify APK exists**

```bash
ls -la ~/Chelly/android/app/build/outputs/apk/debug/
```

- [ ] **Step 4: Trigger CI build**

```bash
cd ~/Chelly
git push
gh run watch
```

---

## Execution Order & Dependencies

```
Task 1 (Scaffold)
  └→ Task 2 (Stores)
      └→ Task 3 (Exec Bridge)
          └→ Task 4 (Safety)
          └→ Task 5 (LLM Clients)
              └→ Task 6 (AI Dispatch)
                  └→ Task 7 (Chat UI)
                      └→ Task 8 (Main Screen)
                          ├→ Task 9 (Arena) — independent
                          ├→ Task 10 (Actions) — independent
                          ├→ Task 11 (Voice) — independent
                          ├→ Task 12 (File Browser) — independent
                          └→ Task 13 (Runtime Manager) — independent
                              └→ Task 14 (OSS Prep)
                                  └→ Task 15 (Build)
```

Tasks 9-13 can be parallelized after Task 8 is complete.
