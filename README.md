<p align="center">
  <!-- TODO: Hero screenshot — Shelly UI with Nacre keyboard visible -->
  <img src="docs/images/hero.png" alt="Shelly — AI Terminal IDE" width="600">
</p>

<h1 align="center">Shelly</h1>

<p align="center">
  A chat-first terminal IDE for Android.<br>
  Chat and Terminal, side by side. Connected by AI.<br>
  <em>Say "fix the error on the right" — and it's done.</em>
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="docs/DESIGN_PHILOSOPHY.md">Design Philosophy</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## I can't write code.

I'm not an engineer. I've never written a line of TypeScript. I don't fully understand how Git works internally. I have no formal training in computer science.

But I built this — a 70,000-line terminal IDE — by talking to AI.

Every function, every component, every architectural decision in Shelly was created through conversation with [Claude Code](https://claude.ai/), running inside [Termux](https://termux.dev/) on a Samsung Galaxy Z Fold6. No desktop. No laptop. Just a foldable phone, a terminal emulator, and an AI that can execute commands.

The keyboard you see in the screenshots? I built that too. It's called [Nacre](https://github.com/RYOITABASHI/Nacre) — an 11,000-line Android IME written in Kotlin, also created entirely through AI conversation. I'm typing on it right now, inside Shelly, improving both apps simultaneously.

This is not a portfolio project. This is a tool I use every day to build things. And I'm releasing it as open source — not because the code is perfect, but because I believe this represents a new way of making software.

If you find rough edges in the code, that's expected. This is AI-generated code shaped by a designer's intent. **Improvements are not just welcome — they're the reason this is open source.**

---

## The Story

Mobile development never took off — not because phones lack computing power, but because the **input** and **interface** weren't designed for creation.

- **Chat apps** (ChatGPT, Claude, Gemini) can *talk* about code, but they can't *run* it. You get suggestions, but executing them is your problem.
- **Terminal emulators** (Termux) can *run* anything, but they're hostile to anyone who isn't already a developer.

Shelly fills the gap between conversation and execution. You type "make me a portfolio site" in a chat bubble, and a real shell runs `mkdir`, `npm init`, generates files, and shows you the results — all inside the same chat interface you already know from ChatGPT.

For the person who wants to build things but doesn't speak terminal, Shelly translates. For the person who speaks terminal fluently, a raw shell is one tab away.

### Why Native?

Early versions of Shelly used ttyd and a WebView to render the terminal. It worked — until it didn't.

WebSocket connections dropped without warning. Termux's Phantom Process Killer silently terminated background processes. Every time you switched apps and came back, the terminal was dead. Reconnect, reload, re-run. A dozen times a day.

So I made the decision to throw it all away and go native.

Shelly now embeds a **native terminal emulator** — Kotlin code derived from Termux's own `terminal-emulator` library — directly inside an Expo/React Native app. The terminal view renders on an Android Canvas, not in a WebView. Input goes through a real PTY via socat TCP bridge, not through JavaScript event handlers.

This means:
- **No WebSocket reconnection hell.** The terminal is a native view, not a web page.
- **No ttyd dependency.** One fewer process for Android to kill.
- **Terminal output flows directly into React Native state.** The AI can read what the terminal shows without scraping a WebView.

As far as we know, this is the **only React Native app in the world** with an embedded native terminal emulator. It shouldn't be possible in Expo — but it works.

### The Copy-Paste Problem

But there's a deeper pain that even experienced developers live with every day.

You're running Claude Code in the terminal. It throws an error. You select the error text. You copy it. You switch to a browser tab — ChatGPT, Claude, whatever. You paste. You ask "what went wrong?" You read the answer. You copy the fix. You switch back to the terminal. You paste. You run it.

**Seven steps. Every single time.**

This isn't a beginner problem. This is the daily workflow of every developer using CLI-based AI tools. The terminal and the chat live in different worlds, and *you* are the copy-paste bridge between them.

### The Solution: Cross-Pane Intelligence

Shelly puts Chat and Terminal side by side — and connects them with AI.

Say **"fix the error on the right"** in the Chat pane. Shelly reads the terminal output, understands the error, explains it in plain language, and generates executable commands. Tap **[▶ Run]** and the fix lands directly in the Terminal pane.

No copy. No paste. No tab switching. Zero friction.

This works because Shelly's Chat pane is aware of what's happening in the Terminal pane — always, in real time. On wide screens (foldables, tablets), the terminal context is injected into every AI conversation automatically. On single-pane phones, just say "the error" or "the terminal output" and Shelly knows what you mean.

**Three levels of value:**
- **Level 1:** Chat alone — build things by talking. The entry point for beginners.
- **Level 2:** Terminal alone — a full TTY for power users.
- **Level 3:** Both panes, side by side — a development experience that doesn't exist anywhere else.

---

## Features

### Cross-Pane Intelligence
- **"Fix the error on the right"** — AI reads terminal output and responds with executable fixes
- **ActionBlock** — Code blocks in AI responses have [▶ Run] buttons that execute directly in Terminal
- **Real-time terminal awareness** — Chat AI always knows what's happening in Terminal (wide mode: automatic, single pane: on reference)
- **CLI Co-Pilot** — Real-time translation of terminal output, approval prompt explanations, second opinions, session summaries
- **Auto-savepoint timeline** — Game-like save/load system. Every change is auto-committed. Revert to any point with one tap.

### Chat-First Development
- **Natural language execution** — Talk naturally, get real execution. Commands run behind the scenes in Termux.
- **Multi-agent AI routing** — Automatically selects Claude Code, Gemini, Perplexity, Cerebras, Groq, or local LLM based on the task.
- **@mention routing** — `@claude`, `@gemini`, `@local`, `@perplexity`, `@cerebras`, `@team` for direct control.
- **Voice input** — Speak commands and hear AI responses.

### Safety & Learning
- **5-level command safety** — Every command is risk-assessed before execution. Dangerous operations require explicit confirmation.
- **Learning mode** — AI explains what each command does and what the output means, in your language.
- **Onboarding wizard** — 5-minute setup from zero. Termux install, AI configuration, everything guided.

### Power Features
- **Native Terminal Emulator** — Kotlin-based terminal rendering on Android Canvas. No WebView, no xterm.js. Derived from Termux's terminal-emulator library, connected via socat PTY-TCP bridge across UID boundaries.
- **Immortal sessions** — tmux-backed sessions survive app switches, screen locks, and Termux restarts. Come back hours later and your Claude Code session is still running.
- **Termux bridge** — Native Kotlin module for direct Termux integration. No WebSocket server required.
- **Local LLM support** — Run Gemma/Qwen on-device via llama.cpp with guided setup wizard.
- **Terminal tab** — Full TTY access with Japanese input support (something Termux alone can't do).
- **Multi-pane layout** — Split view on foldable/wide screens.
- **Project management** — Chat history tied to project folders, with savepoint timeline.
- **Theme engine** — 30+ customizable themes.
- **i18n** — English and Japanese.

---

## Architecture

### Chat → Execution Pipeline

```
User input (natural language)
       │
       ▼
┌─────────────────────┐
│   Input Router       │  ← Intent classification (4 layers + 4.5 routing)
│   "What does the     │
│    user want?"       │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌──────────┐
│ Light  │  │ AI Agent │  ← Claude Code / Gemini / Local LLM / Perplexity / Cerebras / Groq
│ Tasks  │  │ Selection│
│(direct)│  └────┬─────┘
└────────┘       │
                 ▼
          ┌─────────────┐
          │Termux Bridge │  ← Native Kotlin module → Termux RunCommandService
          │(real shell)  │
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │  Chat UI     │  ← Results rendered as chat bubbles
          │  (response)  │     Command output collapsed/expandable
          └─────────────┘
```

The Input Router is the heart of Shelly. It decides whether your message is:
- A **light task** (file listing, simple lookup) → handled directly, no AI needed
- An **AI task** → routed to the best available backend
- A **@mention** → sent to the specified AI
- A **slash command** → executed as a shortcut

This design emerged from a non-engineer's question: *"Why do I have to know which tool to use? Can't the app just figure it out?"*

### Cross-Pane Intelligence

```
┌─────────────────────────────────────────────────┐
│              Shelly (Wide Mode)                  │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐  │
│  │   Chat Pane   │    │    Terminal Pane        │  │
│  │              │    │                        │  │
│  │  User: "fix  │    │  $ npm run build       │  │
│  │  the error   │    │  Error: Cannot find     │  │
│  │  on the      │    │  module './utils'       │  │
│  │  right"      │    │                        │  │
│  │              │    │                        │  │
│  │  AI: The     │◄───│  (output captured via    │  │
│  │  error is... │    │   native terminal view)  │  │
│  │              │    │                        │  │
│  │  ┌────────┐  │    │                        │  │
│  │  │▶ Run   │──┼───►│  $ mv util.ts utils.ts │  │
│  │  └────────┘  │    │                        │  │
│  └──────────────┘    └────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Chat reads Terminal. Terminal executes Chat. The user just talks.

---

## Built With

| Layer | Technology |
|-------|-----------|
| Framework | Expo 54 / React Native 0.81 |
| Language | TypeScript (strict) |
| UI | NativeWind (TailwindCSS 3) |
| State | Zustand |
| API | tRPC + TanStack React Query |
| Animation | React Native Reanimated v4 |
| Navigation | expo-router v6 |
| Terminal | Native emulator (Kotlin, Termux-derived) + socat + tmux |
| Native modules | Kotlin (Termux Bridge, Terminal View) |
| i18n | expo-localization + Zustand |
| Package manager | pnpm 9.12 |

---

## Getting Started

### Prerequisites

- Android device with [Termux](https://f-droid.org/en/packages/com.termux/) installed (F-Droid version recommended)
- Node.js 18+ (via Termux or build environment)

### Install

```bash
# Clone the repository
git clone https://github.com/RYOITABASHI/Shelly.git
cd Shelly

# Install dependencies
pnpm install

# Start the development server
pnpm start

# Run on Android
pnpm android
```

### Termux Bridge Setup

Shelly communicates with Termux via a native bridge module. On first launch, the Setup Wizard guides you through:

1. Installing Termux (if not present)
2. Granting necessary permissions
3. Configuring the bridge connection

---

## Design Philosophy

Shelly was designed by someone who can't use a terminal — for people who can't use a terminal.

Every design decision comes from the question: *"If I don't know what this command does, how should the app protect me and teach me at the same time?"*

The cross-pane system comes from an even simpler question: *"Why do I have to copy an error from one window and paste it into another? Can't the app just see what's on my screen?"*

Read the full design philosophy: **[docs/DESIGN_PHILOSOPHY.md](docs/DESIGN_PHILOSOPHY.md)**

---

## Contributing

This is my first open source project. I'm a designer, not a developer. The code was generated by AI, and there's plenty of room for improvement.

If you find something that could be better — a cleaner pattern, a performance optimization, a bug fix — **please open an issue or PR**. That's exactly why this is open source.

Read the contributing guide: **[CONTRIBUTING.md](CONTRIBUTING.md)**

---

## Vision

Mobile terminals are about to become standard. Most developers don't see it yet.

Right now, even engineers working in Silicon Valley are surprised to learn that Termux exists — that you can run a full Linux shell on an Android phone. The awareness gap is enormous.

But the hardware is ready. Modern mobile SoCs have NPUs pushing 40+ TOPS. Local LLMs that required a desktop GPU two years ago now run on phones. The models are getting smaller and faster every quarter. Soon, 7B-13B parameter models will run natively on mobile at acceptable speeds.

When that happens, you'll have:
- **Zero-cost AI-assisted development** — no API keys, no internet required
- **Complete privacy** — your code never leaves your device
- **Development anywhere** — airplanes, remote sites, commutes

Shelly was built for that future. Local LLM integration (llama.cpp / Ollama) is already implemented. The native terminal is already there. The multi-agent routing already supports local models alongside cloud APIs.

The question isn't whether mobile development will happen. It's who builds the tools for it first.

---

## About the Creator

**RYO ITABASHI** — Creative Director at [Rebuild Factoryz](https://rebuildfactoryz.com/). Branding and design are my profession. Code is not.

I built Shelly because I wanted to use Claude Code on my phone, but Termux was too intimidating. So I made a chat interface that hides the terminal complexity while keeping its full power. Then I realized the real problem wasn't the terminal itself — it was the gap between the terminal and the AI. So I connected them.

The keyboard in the screenshots is **Nacre** — a split-layout Android IME I built (also through AI) to solve the input problem on mobile. Shelly handles the interface. Nacre handles the input. Together, they make phone-only development actually possible.

Both were developed entirely on a Samsung Galaxy Z Fold6, in Termux, without ever touching a desktop computer.

---

## License

[MIT](./LICENSE) — Copyright (c) 2026 RYO ITABASHI
