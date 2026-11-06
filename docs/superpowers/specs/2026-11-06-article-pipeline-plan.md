# Daily article drafts — plan (2026-11-06)

Owner goal: one draft per day per stream, saved to the Obsidian vault, one digest a day, the owner presses publish by hand. Nothing here publishes anything. Business plan: `docs/promo/research/plan-v2.md`.

Decisions taken without asking (cheap to change, recorded here):
- Research uses Gemini grounded by default, not Perplexity `sonar-pro`, because the owner wants no new costs.
- Agents are `autonomous:false` with pinned HTTP engines and memory off. `autonomous:true` strips Groq/Cerebras pins and blocks the new local steps. Autonomous Cloud consent stays off.
- `review: unresolved` drafts are kept and flagged in the digest.
- Run now refuses these chains (the serial TS chain cannot run the new `local` steps). Test with a near-future cron.
- Vintage intent links stay off until the vintage X account exists.

## Design
One agent per stream plus a digest agent, from `buildArticlePipeline(stream)` in `lib/agent-pipeline-presets.ts`. Daily cron staggered about 20 minutes. Draft action into `/sdcard/Documents/ObsidianVault/50_Drafts/<Stream>/`.

Chain: `[research, write, review1, revise1, review2, revise2, assemble]`; dev and vintage add `queue-pop` first.

`orchestration.longform` in the executor gives:
- 12,000-character carry, 24,000-character prompt, newlines kept, in `buildStepPrompt` (TS and JS).
- No briefing post-processing. `enforceSourcedIntermediate` otherwise drops the `VERDICT:` line and strips the article.
- Handoff and local steps excluded from `researchFlags`.
- `MAX_TOKENS` / `length` finish reasons fail the step, and local is dropped from candidates. Local caps at 1024/2048 tokens; cloud engines send no cap (plan-v2 line 58 was wrong).
- Non-model `local` steps: `assemble` (joins the last non-skipped result per part, adds frontmatter, Sources, fixed footer), `list-drafts`, `queue-pop`.

The digest is `[list-drafts, assemble]` with `assemble.plain` (footer only, no frontmatter, because the notification carries the first 500 characters). Folders: `Steam`, `Dev`, `DevEn`, `Vintage`, `VintageEn`, `Digest`; `Substack` and `X` under 50_Drafts already belong to the content-studio mirror. Crons 6:00 to 7:20, digest 8:00 (the last stream's cron plus its 30-minute budget, with a margin). An empty queue ends the run skipped with no notification. A failed tick notifies once, and the run stays a success.

The review loop is preset-emitted `handoff` steps. The role router is not used. Reviews use `of:[0,1]` / `of:[0,3]`, revises `of:[1,2]` / `of:[3,4]`, with `REVIEW_OUTPUT_CONTRACT` appended.

Owner material: the writer emits `【本人の材料: 未記入】` where it is missing, `assemble` sets `material: missing`, the digest shows it. No stream is publishable without the owner, because 本人の見解 and 最終確認者 are human. Vintage drafts carry no listing links or images; Mercari checks stay attended.

## Increments
1. AI×STEAM JA end to end (longform, assemble, truncation check, lint terms, preset, parser, hook, attended refusal, i18n, executor version bump, asset copy, parity).
2. Digest: `list-drafts`, intent links (`planXWeightedLength` ≤ 256), quiet per-stream success notification.
3. Queue + Dev JA: `queue-pop` with a realpath jail, `_queue.md` in the stream folder seeded by hand from `docs/promo/articles/devlog/toc.md`.
4. Remaining streams as data: Dev EN, Hatena, Substack.
5. Docs: fix plan-v2 line 58, add a CLAUDE.md row.
6. Only if Inc 1 shows truncation: chapter-split preset.

## Separate bug to track
Role-routed handoff after research has the same `enforceSourcedIntermediate` problem: a PASS verdict is dropped, so the loop never ends early. Longform avoids it; role loops keep it. Goes in DEFERRED.md.

## Only on-device testing can prove
Real output length and finish reasons, free-tier limits, the CAP-001 10-minute wall, direct `/sdcard` reads from the executor's node, six alarms under Doze on Samsung, Obsidian wikilinks, the X app handling intent links, plain-text confirm flow.
