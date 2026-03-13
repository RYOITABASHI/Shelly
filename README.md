# Shelly

AI-powered terminal IDE for Android.

## Features

- **Multi-agent AI routing** — automatically selects the best LLM (Claude, Gemini, local llama.cpp) for each task
- **Termux bridge** — execute real shell commands on Android via WebSocket bridge to Termux
- **Voice chat** — speak commands and hear AI responses with built-in audio support
- **Creator engine** — scaffold full projects from natural language descriptions
- **Snippet manager** — save, organize, and quickly insert code snippets
- **Obsidian integration** — RAG-powered search over your Obsidian vault
- **Perplexity web search** — AI-assisted web research from the terminal
- **Team roundtable** — multi-AI discussion mode for complex decisions
- **Local LLM support** — run models on-device via llama.cpp with guided setup

## Tech Stack

- **Framework**: Expo 54 / React Native 0.81
- **Language**: TypeScript
- **UI**: NativeWind (TailwindCSS 3)
- **State management**: Zustand
- **API layer**: tRPC + TanStack React Query
- **Package manager**: pnpm 9.12

## Getting Started

```bash
# Install dependencies
pnpm install

# Start the development server
pnpm start

# Run on Android
pnpm android
```

For the Termux bridge, install and run the bridge server in Termux:

```bash
cd ~/shelly-bridge && node server.js
```

## License

[MIT](./LICENSE)
