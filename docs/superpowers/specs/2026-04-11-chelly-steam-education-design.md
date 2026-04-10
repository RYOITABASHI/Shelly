# Chelly — STEAM Education Tool Design Spec

**Date**: 2026-04-11
**Status**: Draft
**Extends**: `2026-04-10-chelly-design.md` (base spec — Chat UI, AI Dispatch, Exec Bridge, Command Safety retained as-is)
**Repository**: https://github.com/RYOITABASHI/Chelly (to be created)

## Overview

Chelly is a STEAM education tool where users learn by creating. Users type what they want in natural language, an LLM generates code, the app executes it, and results are shown as live previews — games you can play, graphs you can interact with, art you can see, music you can hear. No programming knowledge required.

**Core loop**: User message → LLM → code generation → execute → **live preview**

Chelly is Rork for non-engineers, with structured STEAM education built in.

## Vision

- **Learn by making**: Don't study programming — make things, and learn along the way
- **Instant gratification**: Type "make a space invaders game" → play it 30 seconds later
- **STEAM across disciplines**: Science experiments, math visualizations, generative art, music composition, engineering simulations — all through the same chat interface
- **Progressive disclosure**: Start with "just chatting", discover you can make things, then follow structured missions to deepen skills

---

## What's New (vs Base Spec)

The base spec (`2026-04-10-chelly-design.md`) defines:
- Chat UI (ChatBubble, ChatMessageList, ChatHeader, CommandInput)
- AI Dispatch (multi-provider LLM routing)
- Exec Bridge (Kotlin/JNI fork+exec)
- Command Safety (SAFE/WRITE/DESTRUCTIVE classification)
- Auth & API Keys
- Runtime Manager (deferred download)

This spec **overrides** the base spec on:
- **Distribution**: Base spec said "No Play Store". Chelly has no Termux dependency and targets education, so Play Store is viable and desirable. Play Store + F-Droid + GitHub Releases
- **Scope**: Base spec was a generic chat+exec tool. This spec refocuses on STEAM education with missions, previews, and progress tracking

This spec **adds**:

| Module | Purpose |
|--------|---------|
| Preview Engine | WebView + inline media + code viewer |
| Mission System | Curated + LLM-generated STEAM missions |
| Progress Tracker | Skill tree, levels, achievements |
| Education Platform | Classroom management, teacher tools (PC version) |
| Token Budget | Cost guardrails for API key usage |
| Privacy / Compliance | COPPA/GDPR-K readiness for education market |

---

## Module: Preview Engine

The preview engine is what makes Chelly feel magical. When the LLM generates code, users don't just see "exit code 0" — they see the result rendered live.

### Architecture

```
┌─────────────────────────────────────────┐
│              Chat UI                     │
│  ┌───────────────────────────────────┐  │
│  │  ChatBubble                        │  │
│  │  ├─ Text explanation               │  │
│  │  ├─ PreviewCard (tap to expand)    │  │
│  │  │   ├─ WebView (HTML/JS/Game)     │  │
│  │  │   ├─ ImageView (PNG/SVG)        │  │
│  │  │   └─ AudioPlayer (WAV/MP3)      │  │
│  │  ├─ CodeToggle (optional)          │  │
│  │  └─ ExecutionCard (fold-out)       │  │
│  └───────────────────────────────────┘  │
│                                          │
│  ┌───────────────────────────────────┐  │
│  │  FullscreenPreview (modal)         │  │
│  │  ├─ WebView (interactive, game)    │  │
│  │  ├─ Back button overlay            │  │
│  │  └─ Share button                   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### Preview Types

| Type | Trigger | Renderer | Example |
|------|---------|----------|---------|
| **Web** | `.html` file created | WebView (`react-native-webview`) | Games, interactive pages, p5.js sketches |
| **Image** | `.png`, `.jpg`, `.svg` output | `<Image>` component | matplotlib charts, generated art |
| **Audio** | `.wav`, `.mp3` output | `expo-av` AudioPlayer | Generated music, sound effects |
| **Chart** | Structured data from LLM | `react-native-chart-kit` or WebView+Chart.js | Science data, math graphs |
| **Text/Code** | Code file created | Syntax-highlighted `<Text>` | Scripts, config files |

### Preview Detection

After command execution, the preview engine scans results:

1. **File output scan**: Check `~/chelly/workspace/` for new/modified files matching preview-able extensions
2. **stdout scan**: Detect base64-encoded images, SVG markup, or structured data in command output
3. **LLM hint**: The LLM can explicitly specify `preview: { type: "web", file: "game.html" }` in its response

Priority: LLM hint > file output > stdout.

### WebView Sandbox

Games and interactive content run in a sandboxed WebView:

- **No network access** by default (prevent data exfiltration from generated code)
- **Network enforcement**: Custom `WebViewClient.shouldInterceptRequest` in Kotlin — returns null for all non-`chelly://` schemes. Additionally, inject CSP header via `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' chelly:; connect-src 'none';">` into all served HTML. `originWhitelist={['chelly://*']}` on the React Native side
- **Network-allowed missions**: Some missions (e.g., API data visualization) require network. Mission schema has `networkAllowed: boolean` flag (default `false`). When `true`, CSP relaxed to allow `connect-src https:` only (no `http:`, no WebSocket). UI shows 🌐 badge so user knows network is active
- **File access**: Read-only to `~/chelly/workspace/` via custom URL scheme (`chelly://workspace/`)
- **JavaScript**: Enabled (required for games/interactivity)
- **Touch/input**: Fully enabled (games need it)
- **Fullscreen mode**: Tap PreviewCard → modal fullscreen. Back button overlaid at top-left
- **Device APIs**: Accelerometer, touch only. No camera, mic, location from WebView

### Code Viewer

For users who want to learn:

- **Toggle**: "コードを見る" button on PreviewCard
- **Syntax highlighting**: `highlight.js` via WebView (lightweight, no native dependency)
- **Editable (v2)**: Users can modify code and re-run. Not in v1 — complexity too high
- **Language detection**: Automatic based on file extension

### Preview Components

```
components/
├── PreviewCard.tsx        # Inline preview in chat bubble
├── FullscreenPreview.tsx  # Modal for games/interactive content
├── WebPreview.tsx         # WebView renderer (sandbox configured)
├── ImagePreview.tsx       # Image display with zoom
├── AudioPreview.tsx       # Audio player with waveform
├── ChartPreview.tsx       # Chart renderer
└── CodeViewer.tsx         # Syntax-highlighted code display
```

---

## Module: Mission System

Missions are structured learning experiences. Each mission guides the user to build something, learning STEAM concepts along the way.

### Mission Types

**Curated Missions** (bundled with app):
- Hand-crafted by humans, quality-assured
- Cover all 5 STEAM disciplines
- Difficulty levels: Beginner / Intermediate / Advanced
- Shipped as JSON files in `assets/missions/`

**LLM-Generated Missions** (dynamic):
- Generated based on user's interests, level, and completed missions
- Follow the same JSON schema as curated missions
- Validated by the app before presenting (schema check + safety check)
- Marked as "AI-generated" in UI

### Mission Schema

```typescript
interface Mission {
  id: string;
  title: string;                    // "スペースインベーダーを作ろう"
  description: string;              // Short hook
  discipline: 'S' | 'T' | 'E' | 'A' | 'M';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedMinutes: number;         // 10, 20, 30...
  skills: string[];                 // ["html", "javascript", "game-loop"]
  steps: MissionStep[];
  completionCriteria: CompletionCriteria;
  networkAllowed?: boolean;           // Default false. When true, WebView CSP allows https:
  source: 'curated' | 'generated';
}

interface MissionStep {
  order: number;
  instruction: string;              // "まず、ゲームの画面を作りましょう"
  hint?: string;                    // "「ゲームの画面を作って」と言ってみよう"
  expectedOutcome: string;          // "HTMLファイルが作成され、キャンバスが表示される"
  validation?: StepValidation;      // Auto-check: file exists, preview renders, etc.
}

interface CompletionCriteria {
  type: 'file_exists' | 'preview_renders' | 'output_contains' | 'manual';
  value: string;                    // "game.html" | "canvas" | "Game Over"
}
// preview_renders heuristic: WebView fires onLoad → inject JS to check
// document.body.innerHTML.length > 0 && document.querySelector(value) !== null
// e.g. value="canvas" checks that a <canvas> element exists in the rendered DOM.
// Timeout: 5 seconds. If check fails, mission step is not marked complete.

interface StepValidation {
  type: 'file_exists' | 'file_contains' | 'preview_renders' | 'command_succeeds';
  target: string;
  message_on_fail: string;          // "まだファイルが作成されていないようです。もう一度試してみましょう"
}
```

### Sample Curated Missions (v1 — 15 missions)

| # | Discipline | Title | Difficulty | Minutes |
|---|-----------|-------|------------|---------|
| 1 | T | じゃんけんゲームを作ろう | Beginner | 10 |
| 2 | T | スネークゲームを作ろう | Intermediate | 20 |
| 3 | T | ブロック崩しを作ろう | Intermediate | 20 |
| 4 | A | ジェネラティブアートを作ろう | Beginner | 10 |
| 5 | A | ピクセルアートエディタを作ろう | Intermediate | 25 |
| 6 | A | ビートメーカーを作ろう | Intermediate | 20 |
| 7 | M | フラクタルを描こう | Beginner | 10 |
| 8 | M | サイコロシミュレーターで確率を学ぼう | Beginner | 10 |
| 9 | M | グラフ電卓を作ろう | Intermediate | 20 |
| 10 | S | 天気APIでデータ可視化しよう | Intermediate | 20 |
| 11 | S | 太陽系シミュレーションを作ろう | Advanced | 30 |
| 12 | S | 化学反応シミュレーター | Advanced | 30 |
| 13 | E | 橋の強度シミュレーション | Advanced | 30 |
| 14 | E | 簡単なロボット制御シミュレーター | Advanced | 30 |
| 15 | T | 自分だけのWebサイトを作ろう | Beginner | 15 |

### Mission UI Flow

```
1. Home画面 → "ミッション" タブ
2. STEAM discipline filter (S/T/E/A/M アイコン)
3. Mission card (タイトル, 難易度バッジ, 所要時間, プレビュー画像)
4. Tap → Mission detail (概要 + ステップ一覧)
5. "はじめる" → Chat画面に遷移、ミッションコンテキスト注入
6. ステップごとにヒント表示、進捗バー更新
7. 完了 → 🎉 celebration animation + スキル獲得 + 作品をギャラリーに保存
```

### Mission Context Injection

When a mission is active, the system prompt is extended:

```
## Active Mission
Title: スネークゲームを作ろう
Current Step: 2/5 — "ヘビを動かせるようにしよう"
Hint for user: "「ヘビをキーボードで動かせるようにして」と言ってみよう"
Files so far: snake.html (step 1 output)

Guide the user through this step. If they ask something unrelated, help them,
then gently remind them of the current mission step.
Don't give away the full solution — guide them step by step.
```

---

## Module: Progress Tracker

### Skill Tree

Skills are unlocked by completing missions:

```typescript
interface Skill {
  id: string;                 // "html-basics"
  name: string;               // "HTML基礎"
  discipline: 'S' | 'T' | 'E' | 'A' | 'M';
  level: number;              // 1-5
  unlockedBy: string[];       // mission IDs that contribute
}
```

Skills are displayed as a visual tree/map grouped by STEAM discipline.

### User Profile

```typescript
interface UserProgress {
  level: number;                        // Overall level (XP-based)
  xp: number;
  completedMissions: string[];          // Mission IDs
  skills: Record<string, number>;       // skill ID → level
  creations: Creation[];                // Gallery of things they've made
  streak: number;                       // Consecutive days active
  badges: string[];                     // Achievement IDs
}
```

Stored in AsyncStorage. No server-side sync for mobile (local only). PC/education version syncs to server.

### Achievements (Badges)

| Badge | Condition |
|-------|-----------|
| 🎮 First Game | Complete first game mission |
| 🎨 Artist | Complete 3 Art missions |
| 🔬 Scientist | Complete 3 Science missions |
| 📐 Mathematician | Complete 3 Math missions |
| ⚙️ Engineer | Complete 3 Engineering missions |
| 💻 Coder | Complete 5 Technology missions |
| 🌟 STEAM Master | Complete at least 2 in each discipline |
| 🔥 7-Day Streak | Use Chelly 7 days in a row |
| 🏗️ Builder | Create 10 projects in free mode |

### XP & Leveling

| Action | XP |
|--------|-----|
| Complete mission step | +10 |
| Complete beginner mission | +50 |
| Complete intermediate mission | +100 |
| Complete advanced mission | +200 |
| Free mode creation saved to gallery | +20 |
| 7-day streak milestone | +100 |

**Level formula**: `level = floor(sqrt(xp / 50))`. Level 1 = 50 XP, Level 5 = 1250 XP, Level 10 = 5000 XP. Provides a gentle curve that rewards continued use.

### Gallery

Users can save their creations:
- Screenshot of preview: captured via `react-native-view-shot` wrapping the PreviewCard. `ViewShot.capture({ format: 'png', quality: 0.8 })` triggered automatically on mission completion, manually via "Save" button in free mode
- Source files (zipped via `JSZip` in JS thread)
- Shareable link (v2 — requires server)

---

## Module: Education Platform (PC Version — Phase 2)

Deferred to after mobile v1 launch. Architecture decisions now to avoid blocking later.

### Teacher Features (PC only)

- **Class creation**: Teacher creates a class, gets join code
- **Mission assignment**: Assign curated/custom missions to class
- **Progress dashboard**: See each student's progress, completed missions, skills
- **Custom missions**: Teachers create missions using the same JSON schema
- **Code review**: View student-generated code (opt-in)

### Student Features (PC)

- Same as mobile + class join + assignment view
- Progress syncs to server (teacher can see)
- Collaborative missions (pair programming via shared chat — v3)

### Technical Decisions (now, for later)

- **Mission schema**: Designed to be portable (JSON). Same schema works on mobile and PC
- **Progress data**: Mobile = AsyncStorage (local). PC = server sync. Same TypeScript types, different persistence layer
- **Auth**: Mobile = none (local). PC = school SSO (Google Workspace, Microsoft 365)
- **API**: tRPC (same as Shelly) for PC backend. Mobile has no backend

### Monetization

| | Mobile (Android) | PC (Chromebook/Web) |
|---|---|---|
| **Price** | Free | Paid (per-school or per-student license) |
| **Distribution** | Play Store + F-Droid + GitHub Releases | PWA (TBD) |
| **Target** | Individual learners | Schools, classrooms |
| **Revenue** | None (OSS goodwill + funnel to PC) | Subscription or 買い切り per school year |
| **LLM cost** | User's own API key | School-provided key or bundled (margin on API cost) |

---

## Updated Project Structure

Additions to the base spec's project structure:

```
Chelly/
├── app/
│   ├── _layout.tsx
│   ├── index.tsx              # Home (missions + free chat)
│   ├── chat.tsx               # Chat screen
│   ├── mission/
│   │   ├── [id].tsx           # Mission detail + execution
│   │   └── index.tsx          # Mission browser
│   ├── gallery.tsx            # User's creations
│   ├── profile.tsx            # Progress, skills, badges
│   └── settings.tsx           # API keys, preferences
├── components/
│   ├── ... (base spec components)
│   ├── preview/
│   │   ├── PreviewCard.tsx
│   │   ├── FullscreenPreview.tsx
│   │   ├── WebPreview.tsx
│   │   ├── ImagePreview.tsx
│   │   ├── AudioPreview.tsx
│   │   ├── ChartPreview.tsx
│   │   └── CodeViewer.tsx
│   ├── mission/
│   │   ├── MissionCard.tsx
│   │   ├── MissionDetail.tsx
│   │   ├── MissionStepGuide.tsx
│   │   ├── MissionFilter.tsx
│   │   └── CompletionCelebration.tsx
│   └── progress/
│       ├── SkillTree.tsx
│       ├── BadgeGrid.tsx
│       ├── LevelBar.tsx
│       └── GalleryGrid.tsx
├── assets/
│   └── missions/
│       ├── t-001-janken.json
│       ├── t-002-snake.json
│       ├── ... (15 curated missions)
│       └── index.ts            # Mission registry
├── lib/
│   ├── ... (base spec libs)
│   ├── preview-detector.ts     # Detect preview-able outputs
│   ├── mission-engine.ts       # Mission state machine
│   ├── mission-generator.ts    # LLM-powered mission generation
│   ├── progress-tracker.ts     # XP, levels, badges
│   └── gallery-manager.ts      # Save/load creations
├── store/
│   ├── ... (base spec stores)
│   ├── mission-store.ts        # Active mission state
│   └── progress-store.ts       # User progress
└── types/
    ├── mission.ts              # Mission, MissionStep, etc.
    └── progress.ts             # UserProgress, Skill, Badge
```

---

## Updated System Prompt

Extend the base spec's system prompt:

```
You are Chelly, an AI assistant that helps users learn and create through STEAM education.

(... base prompt: execute_commands, respond tools ...)

## Education mode
When a mission is active, guide the user step by step. Don't give the full
solution at once — let them discover. If they're stuck, offer hints before
showing the answer.

## Preview awareness
When you create visual content (HTML, images, charts), tell the user what
they'll see. Structure HTML files to be self-contained (inline CSS/JS) so
the preview works immediately.

For games: use HTML5 Canvas or plain DOM. Include touch event handling for
mobile. Test dimensions: 360x640 (phone viewport).

For charts/graphs: prefer HTML+Chart.js (rendered in WebView) over matplotlib
(requires Python runtime).

## User language
- Detect the user's language from their message and respond in the same language
- Default to Japanese (primary market)
- Keep explanations simple — assume no technical background
- Use encouraging tone: "すごい！" "できたね！" "次は..."
```

---

## Data Flow: Mission Execution

### "スネークゲームを作ろう" — Step 1

```
1. User starts mission T-002
2. mission-store: activeMission = T-002, currentStep = 1
3. System prompt extended with mission context
4. Chat shows: "スネークゲームを作りましょう！まず、ゲームの画面を作ります。
               「ゲームの画面を作って」と言ってみよう 💡"
5. User: "ゲームの画面を作って"
6. LLM → generates HTML with canvas element
7. Exec bridge → creates snake.html
8. Preview detector → finds snake.html → type: web
9. ChatBubble renders:
   - Text: "ゲーム画面ができました！タップしてみてね"
   - PreviewCard: WebView showing canvas (inline, 16:9 ratio)
   - CodeToggle: "コードを見る ▸"
   - ExecutionCard: (folded)
10. StepValidation: file_exists("snake.html") → ✅
11. mission-store: currentStep = 2
12. Progress: +10 XP
13. Chat shows next step hint
```

### Free Mode (No Mission)

Same as base spec flow. Preview engine still activates for any generated visual content.

---

## Implementation Priority

| Phase | Content | Depends On |
|-------|---------|-----------|
| **Phase 1** | Base spec (Chat + Exec + Safety) | — |
| **Phase 2** | Preview Engine (WebView + Image + Audio) | Phase 1 |
| **Phase 3** | Mission System (schema + 5 curated missions + UI) | Phase 2 |
| **Phase 4** | Progress Tracker (XP + skills + badges + gallery) | Phase 3 |
| **Phase 5** | Full mission set (15 curated) + LLM generation | Phase 3 |
| **Phase 6** | Play Store submission + F-Droid | Phase 1-5 |
| **Phase 7** | PC version (education platform) | Phase 1-5 + new backend |

Phase 1-2 can ship as a useful "chat + preview" app. Phase 3-5 adds the education layer. Phase 6-7 are distribution/monetization.

---

## What's NOT in v1 (Mobile)

- Code editor (editable code) — view only in v1
- Multiplayer / collaborative missions
- Server-side progress sync
- Teacher dashboard
- Custom mission editor UI (teachers use JSON directly or LLM)
- Offline LLM (requires local model — future)
- iOS version

---

## LLM Token Budget & Cost Guardrails

Children (or anyone) could exhaust an API key by chatting endlessly. Guardrails:

- **Per-session limit**: 100 LLM requests per session (configurable in settings). At limit → "今日はたくさん作ったね！また明日遊ぼう 🌟" message. Settings で上限変更可能
- **Daily token cap**: 500K tokens/day (default). Estimated cost: ~$0.04/day on Gemini Flash. Configurable
- **Long output guard**: If LLM response exceeds 8K tokens, truncate and warn (prevents runaway generation)
- **Mission mode optimization**: Missions use focused system prompts (shorter context = fewer tokens). Free mode uses full context (more expensive)
- **Cost display**: Settings画面にAPIキーの推定使用量を表示（累計トークン数、推定コスト）
- **No-key mode (future)**: PC education version bundles API access — school pays, students don't need keys

---

## Privacy & Compliance (COPPA / GDPR-K)

Chelly targets minors. Play Store requires Designed for Families compliance. Critical requirements:

### Data Collection

- **No account required**: Mobile version has no sign-up, no server, no tracking
- **Local-only storage**: All data (progress, creations, chat history) stored on-device via AsyncStorage
- **No analytics**: No Firebase Analytics, no Crashlytics, no telemetry in mobile v1
- **API keys**: Stored in `expo-secure-store` (Keystore on Android). Never transmitted except to the chosen LLM provider

### LLM Provider Data

- User messages are sent to the configured LLM provider (Gemini, Claude, etc.). This is disclosed in:
  - First-launch privacy notice (before API key setup)
  - Settings screen
  - Play Store listing privacy policy
- **Recommendation**: Use Gemini Flash (Google AI Studio free tier) — Google's data handling is well-documented for education use

### Play Store Requirements

- **Target age**: "Everyone" (not "Designed for Families" in v1 — that program has strict ad/content rules). Position as educational tool, not children's app
- **Privacy policy**: Required. Hosted on GitHub Pages (`chelly.dev/privacy`)
- **Content rating**: IARC questionnaire → likely "Everyone"
- **Data safety form**: "No data collected", "No data shared". API key stored on-device only
- **Teacher-supervised use recommended**: Disclosure that LLM outputs are AI-generated and may contain errors

### PC Education Version (Phase 7)

- Full COPPA/GDPR-K compliance required (server-side data)
- Student accounts → parental/school consent flow
- Data processing agreement (DPA) for schools
- EU: GDPR Article 8 (parental consent for <16)
- US: COPPA (parental consent for <13, verifiable)
- Defer detailed design to Phase 7 spec

---

## OSS Considerations (Updated)

- **License**: MIT (mobile app + mission schema). Education platform backend may be source-available (not OSS)
- **Bundle ID**: `dev.chelly.app`
- **Package name**: `chelly`
- **Play Store**: Yes (STEAM education app — no Termux dependency, clean sandbox. Base spec said "No Play Store" due to Shelly's Termux dependency — Chelly has no such constraint)
- **F-Droid**: Yes (free/OSS track)
- **GitHub Releases**: Yes (APK direct download)
- **Mission contributions**: Community can submit curated missions via PR (JSON files)
