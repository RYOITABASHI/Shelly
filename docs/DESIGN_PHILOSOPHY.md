# Shelly — Design Philosophy

## What is Shelly?

Shelly fuses "ChatGPT's UI + real terminal execution" into a single app.

- **Chat apps** (ChatGPT, Claude, Gemini) → Can *talk* about code, but can't *run* it. They generate code, but where to put it and how to execute it is your problem.
- **CLI tools** (Claude Code, Gemini CLI) → Maximum execution power, but only developers benefit.
- **Shelly** → You chat, and the CLI executes behind the scenes. Say "build me an app" and the AI generates files, manages git, runs tests — all visible as chat bubbles.

The execution power that chat apps lack. The accessibility that CLIs lack. Shelly fills the gap.

## Target Users

Users satisfied with ChatGPT or Gemini's chat apps won't use Shelly. Shelly's users are:

1. **People who want to build things with CLI but can't master terminal commands**
2. **People who want to develop through chat-based interaction**
3. **Capable creators who aren't engineers and don't know programming jargon**

A hybrid tool that bridges chat and terminal.

## Core Architecture: "CLI runs behind chat UI"

Shelly is a chat interface, but behind it, real CLIs (Claude Code, Gemini CLI, Codex, etc.) execute actual commands. This is the core insight.

### 4-Tab Structure

| Tab | Role | For |
|-----|------|-----|
| **Projects** | Project list + chat history | Everyone |
| **Chat** | Main screen. Right: user, Left: AI. CLI executes behind the scenes | Everyone |
| **Terminal** | Raw TTY terminal with Japanese input support | Power users |
| **Settings** | Config + snippets + Obsidian RAG + backup | Initial setup |

The previous design had 8 tabs (Chat/TTY/Snippets/Creator/Browser/Obsidian/Search/Settings) — confusing whether it was a "chat app" or "terminal app".

New design: **A UI familiar to GPT/Claude users.** Pick a project → Chat → Terminal if needed.

### Chat Tab UI

Same layout as GPT/Claude/Gemini apps:
- Right-aligned: User messages
- Left-aligned: AI responses (with avatar)
- Command results: Embedded in AI bubbles (collapsible)
- Long output: Auto-collapsed, tap to expand
- Dangerous commands: Red confirmation bubble

**Philosophy**: The AI summarizes and translates raw terminal output into chat bubbles. Users see chat, but a real shell runs underneath.

### Projects Tab

Same concept as GPT/Claude's left sidebar, but on mobile, sidebars are awkward (open → select → close = 3 actions), so it's a tab.

- Chat history (conversation rooms)
- Project folder binding (cwd)
- New chat creation
- Full-text search across all history

### Terminal Tab

Termux alone **can't even handle Japanese input** (Gboard's IME doesn't work correctly). Shelly's Terminal tab enables Japanese input through Shelly's keyboard layer.

This alone justifies Shelly's existence.

## Termuxless Design

A complete beginner who has never used Shelly *or* Termux should be able to install the app and use every feature.

### 5-Layer Architecture

```
Chat UI (natural language input)
    ↓
Intent Router (local LLM classifies the task)
    ↓
Tool Orchestrator (CLI management + permission translation)
    ↓
Environment Manager (auto-install tools + authentication)
    ↓
Termux Bridge (command execution)
```

### Intent Routing

Users don't even need to know *which tool to use*.

Example: "Build me a portfolio"
1. Local LLM analyzes intent → decides "Claude Code is optimal"
2. Detects Claude Code not installed
3. Chat guidance: "Claude Code is the best tool for this project. Start setup?"
4. User approves → Auto-install → Auth flow → Development begins

Tool selection and setup happen entirely within the chat.

## Persona-Based Default Agents

### Persona A: Users with Local LLM
- The AI visible in chat is the local LLM
- "Hello" → Local LLM responds
- "Build me an app" → Local LLM analyzes intent, delegates to Claude Code / Gemini
- Local LLM functions as the intent router

### Persona B: Users without Local LLM
- Default agent is **Gemini CLI**
  - Has a free tier (beginners shouldn't have to pay upfront)
  - Setup with just a Google account
  - Returns answers in natural language

## Why Mobile Development Never Took Off

It wasn't a specs problem.

### 1. The Input Problem
Coding on a phone keyboard is painful. But Shelly's design philosophy solves this — just give instructions in natural language and the CLI writes code for you.

### 2. No Terminal Access
Termux existed, but a black screen with command prompts was unusable for non-developers. You couldn't even type Japanese. Shelly fills that layer.

### 3. The Concept Itself Didn't Exist
Now that local LLMs are lightweight enough to run on phones, mobile Vibe Coding will inevitably become mainstream. Shelly is ahead of that curve.

## Resource Consumption

| Process | Memory | Notes |
|---------|--------|-------|
| Shelly APK | ~40MB | UI only |
| Termux + Node Bridge | ~130MB | Near-zero load |
| + Gemini CLI | ~150-200MB | Only during execution |
| + Claude Code CLI | ~200-300MB | Only during execution |
| + llama-server (4B) | **~5GB** | Always high load |

Without local LLM, everything combined uses about 500MB RAM. Shelly works on mid-range devices with 4GB RAM.

## Summary

Shelly = ChatGPT's UI + real terminal execution.

Beginners use Chat. Power users use Terminal. Both connect to the same AI backends and the same Linux filesystem. Mobile development didn't take off because of a UX wall, not a specs wall. Shelly breaks that wall.

---

# 設計思想（日本語版）

以下は上記英語版の原文（日本語）です。

## Shellyとは何か

Shellyは「ChatGPTのUI + 実際のターミナル実行」を1つのアプリに融合したもの。

- **チャットアプリ（ChatGPT等）** → 会話はできるが、実行できない。コードを生成しても、それをどこに置いてどう動かすかはユーザー任せ。
- **CLI（Claude Code等）** → 実行力は最強だが、ターミナルを使える人しか恩恵を受けられない。
- **Shelly** → チャットで話しかけるだけで、裏でCLIが実行する。ユーザーは「アプリ作って」と言うだけで、AIがファイル生成・git管理・テスト実行まで全部やる。その過程もチャットバブルで見える。

チャットアプリにはない実行力、CLIにはない手軽さ。その間を埋める唯一のポジション。

## ターゲットユーザー

ChatGPTやGemini、Claudeのチャットアプリで満足しているユーザーは、そもそもShellyを使わない。Shellyのユーザーは：

1. **CLIを使ってものづくりをしたいけれど、CLIを使いこなしきれない人たち**
2. **チャットベースで開発を進めたい人たち**
3. **ゴリゴリ開発もできるが、エンジニアではないから専門用語やプログラムに詳しくないという人たち**

つまり、チャットとターミナルをハイブリッドで扱えるツール。

## コアアーキテクチャ: 「チャットUIの裏でCLIが走る」

Shellyはチャットインターフェースだが、裏ではCLI（Claude Code, Gemini CLI, Codex等）が実際にコマンドを実行している。これがShellyの味噌。

### 4タブ構成

| タブ | 役割 | 対象 |
|------|------|------|
| **Projects** | プロジェクト一覧 + チャット履歴 | 全員 |
| **Chat** | メイン画面。右:ユーザー、左:AI。裏でCLI実行 | 全員 |
| **Terminal** | TTY生ターミナル。日本語入力可能 | 上級者 |
| **Settings** | 設定 + スニペット + Obsidian RAG + バックアップ | 初回設定時 |

旧設計は8タブ（Chat/TTY/Snippets/Creator/Browser/Obsidian/Search/Settings）だったが、これは「チャットアプリ」なのか「ターミナルアプリ」なのか分からない中途半端なUIだった。

新設計: **GPT/Claudeアプリに馴染みのあるユーザーが迷わないUI**。プロジェクト選ぶ → チャットする → 必要ならターミナル。

## Termuxless設計

全くの初学者が、ShellyはもちろんTermux自体も使ったことがない状態でインストールしても、Shellyの全機能を満足に使えるようにする。

### 5層アーキテクチャ

```
Chat UI（自然言語入力）
    ↓
Intent Router（ローカルLLMがタスクを分類）
    ↓
Tool Orchestrator（CLI管理・パーミッション翻訳）
    ↓
Environment Manager（ツール自動インストール・認証）
    ↓
Termux Bridge（コマンド実行）
```

## モバイル開発が流行らなかった本当の理由

スペックの問題ではなかった。入力の問題、ターミナルへのアクセス手段がなかった問題、そして「スマホで開発」という発想自体がなかった問題。ローカルLLMがスマホに実装できるサイズまで軽量化された今、モバイルでのVibe Codingは間違いなく一般化する。Shellyはその流れを先取りする。

## リソース消費の実態

| 処理 | メモリ消費 | 備考 |
|------|-----------|------|
| Shelly APK | ~40MB | UIのみ |
| Termux + Node Bridge | ~130MB | ほぼゼロ負荷 |
| + Gemini CLI | ~150-200MB | コマンド実行時のみ |
| + Claude Code CLI | ~200-300MB | コマンド実行時のみ |
| + llama-server (4B) | **~5GB** | 常時高負荷 |

ローカルLLMを除けば、全部合わせてもRAM 500MB程度。RAM 4GBの中スペック端末でもShellyは成立する。
