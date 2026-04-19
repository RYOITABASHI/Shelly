# Ask Pane Stage 2 — Issue Creation + UX Polish

**Status**: design doc. Stage 1 (question/answer + status badges) shipped
in commit `6de28e13`. This doc captures Stage 2 scope so the
implementation session has a clear handoff.

## Goal

Close the feedback loop: when Shelly can't do something the user asks
about, turn the question into a GitHub issue with one tap. Zero context
switch, zero copy-paste, zero "let me file that later and forget."

## Success criteria

- On `[NOT_AVAILABLE]` responses, a **`📝 Create GitHub issue`** button
  is visible under the status badge.
- Tapping it shows a preview (title + body, editable) pre-populated
  from the user's question and the AI's explanation.
- A second tap posts to `/repos/RYOITABASHI/Shelly/issues` using the
  `shelly-cs` OAuth token (already has `repo` scope).
- The created issue URL is rendered as a clickable link in the answer,
  so the user can verify in Browser Pane.
- Rate-limited: one active draft per turn, no accidental duplicates.

## Non-goals

- No edit of existing issues.
- No comments on existing issues.
- No issue search / dedup against existing issues (Stage 3).
- No custom labels beyond a single `from-ask-pane` marker (Stage 3 adds
  category-aware labels).

## Architecture

```
┌──────────────────────────────────────────────────┐
│ AskPane.tsx (existing Stage 1)                   │
│                                                  │
│  Turn state:                                     │
│    question, answer, status, streaming           │
│                                                  │
│  On streaming end, if status === 'NOT_AVAILABLE' │
│    render <IssueDraftAction turnId={...} />      │  NEW
│                                                  │
│  <IssueDraftAction>                              │
│    1. Button: 📝 Create GitHub issue             │
│    2. Modal: preview + editable title/body       │
│    3. Submit → lib/github-issues.ts              │
│       → success: inline link + toast             │
│       → fail:    error chip + retry              │
└──────────────────────────────────────────────────┘

lib/github-issues.ts (new, ~100 LoC)
  - readShellyCSToken()   — file read of ~/.shelly-cs/token
  - buildDraft(q, a)      — pure function: title + body template
  - createIssue(draft)    — POST /repos/RYOITABASHI/Shelly/issues
  - listRecentDraft-like titles for dedup hint (Stage 3)
```

## Token access — how Ask Pane reads the `shelly-cs` token

Stage 1 stores the token at `$HOME/.shelly-cs/token` (0600). The
`expo-file-system` API can read it directly from the React Native
side. No JSI bridge needed. No `shelly-cs` subprocess.

```typescript
import * as FileSystem from 'expo-file-system';
import { initHomePath, getHomePath } from '@/lib/home-path';

async function readShellyCSToken(): Promise<string | null> {
  await initHomePath();
  const home = getHomePath();
  const uri = `file://${home}/.shelly-cs/token`;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    return (await FileSystem.readAsStringAsync(uri)).trim();
  } catch {
    return null;
  }
}
```

If the file doesn't exist (user hasn't run `shelly-cs auth`), show an
inline hint: "Run `shelly-cs auth` first to enable issue creation."

## Draft template

```markdown
### Context
The user asked Ask Pane: "<USER_QUESTION>"

### AI response
<AI_ANSWER_STRIPPED_OF_STATUS_TAG>

### Environment
- Shelly version: <package.json version>
- Platform: <Platform.OS> <Platform.Version>
- BASHRC_VERSION: <read from $HOME/.bashrc_version>

---
Filed via Shelly Ask Pane on <YYYY-MM-DD HH:MM>.
```

- Title derivation: the first 72 chars of the user question with a
  `[Ask Pane] ` prefix. User can edit before submit.
- Body is fully editable (TextArea in the modal).
- `labels: ['from-ask-pane']` added server-side.

## UX detail — the modal

Reuses the existing `Modal` pattern from `components/multi-pane/
AddPaneSheet.tsx` (slide-up sheet with backdrop).

```
┌─ 📝 Create GitHub Issue ─────────────────────────┐
│                                                  │
│  Title                                           │
│  [Ask Pane] MIDI keyboard support                │
│                                                  │
│  Body                                            │
│  ┌────────────────────────────────────────────┐  │
│  │ ### Context                                │  │
│  │ The user asked Ask Pane: "MIDI keyboa..."  │  │
│  │                                            │  │
│  │ ### AI response                            │  │
│  │ No dedicated MIDI input support today...   │  │
│  │                                            │  │
│  │ ### Environment                            │  │
│  │ - Shelly 0.1.0                             │  │
│  │ ...                                        │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  [  Cancel  ]            [  Create  ] ← accent  │
└──────────────────────────────────────────────────┘
```

- Title: single-line `TextInput`.
- Body: multi-line `TextInput` with `numberOfLines={12}`.
- Spinner overlay during POST.
- On success: collapse modal, render `✓ Issue #123 filed — [View]` in
  the turn bubble; the [View] taps through to `shelly://browser?url=`
  of the issue URL (reusing the Browser Pane bridge).
- On failure: inline error under the button, [Retry] tap.

## REST API

```
POST https://api.github.com/repos/RYOITABASHI/Shelly/issues
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: shelly-ask/0.1

{
  "title": "[Ask Pane] MIDI keyboard support",
  "body":  "### Context\n...",
  "labels": ["from-ask-pane"]
}
```

Response: `{ "number": 123, "html_url": "https://github.com/..." }`.

## Error handling matrix

| Failure | Behaviour |
|---|---|
| Token file missing | Inline: "Run `shelly-cs auth` first." |
| Token expired (401) | Inline: "Session expired. Run `shelly-cs auth` again." |
| 403 / rate limit | Retry button + remaining-time hint from `X-RateLimit-Reset` |
| 422 validation | Surface the GitHub message verbatim |
| Network down | "Offline — draft kept. Tap Create again when online." Draft retained in turn state. |

## Implementation order (for the Stage 2 session)

1. `lib/github-issues.ts` — pure fetch + token read. 80-120 LoC.
2. `components/panes/ask/IssueDraftAction.tsx` — button + modal.
   200-300 LoC.
3. Wire into `AskPane.tsx`: render when
   `turn.status === 'NOT_AVAILABLE' && !turn.streaming`.
4. Add a `label` "from-ask-pane" to the Shelly repo (one-time manual
   step before release).
5. Test plan:
   - Ask "MIDI keyboard support" → NOT_AVAILABLE → click button → modal
     shows draft → edit title → submit → issue 見つかる in browser.
   - Simulate expired token (move token file aside) → expected inline hint.
   - Simulate offline (airplane mode) → expected "draft kept" behaviour.

Estimated: 1 day for implementation + half day for test/polish.

## Future (Stage 3+)

- **Dedup search**: before showing modal, search existing issues for
  similar titles. Show "5 similar open issues" with quick links.
- **Category labels**: use the question's feature-catalog category
  (`ai`, `terminal`, `browser`, etc.) to auto-apply category labels.
- **"What's new" card**: top of Ask Pane shows the latest CHANGELOG
  [Unreleased] section ("Since your last visit: 3 new features").
- **History**: pane-local history of Q&A + filed issues. Persisted via
  `AsyncStorage` so dev restarts don't lose context.
- **Voice input**: `PaneInputBar` integration so the user can ask by
  voice (same pattern as AI Pane).
- **Doc ingestion**: when README / CLAUDE.md / DEFERRED.md change, a
  CI script regenerates `lib/docs-content.ts` with full-text chunks.
  Embed and rank at query time for larger contexts.
