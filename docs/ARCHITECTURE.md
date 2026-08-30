# Architecture Detail

Deeper diagrams for [Shelly](../README.md)'s architecture. The [README's Architecture section](../README.md#architecture) covers the system-level picture and the cross-pane data flow; this file has the internals underneath specific subsystems.

### Screen Layout

```mermaid
block-beta
  columns 5
  AB["Agent Bar — layout / add pane / search / settings"]:5
  SB["Sidebar\nRepos, File Tree\nTasks, Device"]:1 TP["Terminal Pane\n$ npm run build\nError: missing..."]:2 AP["AI Pane\n'Fix the error →'\n[Accept hunk]"]:2
  space:1 BP["Browser Pane\nlocalhost:3000\nYouTube / GitHub"]:2 MP["Preview Pane\nCode / MD / Image"]:2
  CB["Context Bar — ~/Shelly  main  ↑2  Native"]:5

  style AB fill:#1a1a1a,stroke:#00D4AA,color:#00D4AA
  style SB fill:#111,stroke:#333,color:#ccc
  style TP fill:#0a0a0a,stroke:#333,color:#0f0
  style AP fill:#0a0a0a,stroke:#D4A574,color:#D4A574
  style BP fill:#0a0a0a,stroke:#333,color:#61AFEF
  style MP fill:#0a0a0a,stroke:#333,color:#ccc
  style CB fill:#1a1a1a,stroke:#333,color:#666
```

### AI Edit Golden Path

```mermaid
flowchart LR
  FT["FileTree tap"] --> OF["openFile()"]
  OF -->|*.md| MP["Markdown pane"]
  OF -->|other| CT["Preview → Code tab"]
  CT -->|AI button| SE["stageAiEdit()"]
  SE --> AIP["AI pane w/ file in context"]
  AIP --> DIFF["assistant unified diff"]
  DIFF --> IND["InlineDiff — per-hunk Accept"]
  IND --> ASD["acceptStagedDiff() (strict → fuzzy)"]
  ASD --> WF["writeFileNative() on disk"]
  WF --> RELOAD["Preview Code tab auto-reload"]
```

Each step is a real module: `lib/open-file.ts`, `lib/ai-edit.ts`, `components/panes/InlineDiff.tsx`, `hooks/use-native-exec.ts`.

### Native PTY — JNI forkpty

```mermaid
flowchart TB
  JS["React Native JS"] -- "Expo Module call" --> KT["Kotlin NativeModule"]
  KT -- "JNI" --> PTY["shelly-pty.c (forkpty)"]
  KT -- "JNI" --> EXEC["shelly-exec.c (fork+exec+pipe)"]
  PTY -- "ptmx / setsid" --> SH["shell process\nbash / zsh / sh"]
  PTY -- "read/write fd" --> TV["ShellyTerminalView.kt\nKotlin renderer"]
  TV --> VIEW["Android View\nCanvas path / optional GLSurfaceView path"]
```

Two JNI entry points for two different needs. **`shelly-pty.c`** owns interactive shells: it opens `/dev/ptmx`, calls `forkpty`-equivalent logic (`grantpt` + `unlockpt` + `setsid` + `execve` via `/system/bin/linker64`), and hands the master fd back to Kotlin for the terminal view to read. **`shelly-exec.c`** owns programmatic one-shots (`git status`, `ls`, file I/O, AI dispatch helpers): it does a vanilla `fork` + `exec` + `pipe` and returns `{exitCode, stdout, stderr}` synchronously, with an EAGAIN-aware read loop that distinguishes spurious select wakes from genuine EOF (bug #70 fix).

No TCP. No socket terminal server. No separate PTY helper daemon. Shells still run as normal forked child processes, while the PTY master fd is owned by the app and read directly from Kotlin via JNI.

### Runtime Theme Swap

```mermaid
flowchart LR
  U["Settings → Font: Shelly"] --> S["settings-store.uiFont"]
  S --> E["RootLayout effect"]
  E --> AP["applyThemePreset()"]
  AP --> M["Object.assign(colors, palette)"]
  AP --> P["patchTextRenderOnce()"]
  AP --> V["theme-version bump"]
  V --> R["ShellLayout key-remount"]
  R --> UI["all Text re-renders with new fontFamily"]
  PTY["native PTY"] -. unaffected .- R
```

The `colors` object is mutable and keeps the same identity, so every `import { colors as C }` consumer sees the new values without a code change. The Text monkey-patch handles font changes. The theme-version key-remount forces all rendered Text through the patch. PTY lives outside JS, so it's untouched.
