/**
 * lib/agent-capability-catalog.ts — "what can an agent do for me?" discovery data.
 *
 * Sibling to lib/feature-catalog.ts, built on the SAME `Feature` shape so it
 * keeps feeding the existing catalog consumers (lib/ask-context.ts's ASK Pane
 * system prompt + main-AI-Chat capability grounding blocks) automatically —
 * the `'agent'` category entries live in FEATURE_CATALOG itself, this module
 * just re-exports the filtered slice plus a small, VERIFIED example-utterance
 * library for the dedicated "What can agents do?" UI surface
 * (components/layout/AgentCapabilitiesModal.tsx).
 *
 * The example utterances below are not aspirational copy — each one is
 * asserted against the real deterministic parser (lib/agent-nl-parser.ts's
 * parseAgentNL) in __tests__/agent-capability-catalog.test.ts, mirroring the
 * project rule that user-facing example prompts must be verified against the
 * actual parser, not invented (see the "on-device test needs example
 * prompts" standing feedback). Do not add an example here without a matching
 * assertion in that test file.
 */
import { FEATURE_CATALOG, type Feature } from './feature-catalog';

/** The agent-only slice of FEATURE_CATALOG, in declaration order. */
export const AGENT_CAPABILITIES: Feature[] = FEATURE_CATALOG.filter((f) => f.category === 'agent');

export interface AgentExampleUtterance {
  id: string;
  /** Full copy-pasteable text, including the leading "@agent " mention — what
   *  a user would literally type into an AI pane. */
  utterance: string;
  /** One-line plain-language explanation of what this utterance registers. */
  explain: string;
}

/**
 * A small set of realistic, copy-pasteable `@agent …` utterances covering:
 * plain daily scheduling + the default draft action, an explicit notify
 * action, an hourly interval, multi-day weekly scheduling, and the
 * autonomous (no per-run approval tap) intent phrase. Each is confirmed to
 * produce a confident (non-null) schedule via parseSchedule/parseAgentNL —
 * see the test file referenced in this module's doc comment above.
 */
export const AGENT_EXAMPLE_UTTERANCES: AgentExampleUtterance[] = [
  {
    id: 'daily-draft',
    utterance: '@agent 毎日8時にSTEAM×AI教育系の論文とニュースを集めて下書きに保存して',
    explain: 'Registers a daily 8:00 agent that writes its findings to a file (the default draft action) — no approval tap needed to deliver the result.',
  },
  {
    id: 'daily-notify',
    utterance: '@agent every day at 9am notify me of new mail',
    explain: 'Registers a daily 9:00 agent that delivers its result as a device notification instead of a file.',
  },
  {
    id: 'hourly-interval',
    utterance: '@agent every 3 hours check the server',
    explain: 'Registers an agent that runs every 3 hours on a fixed-minute interval schedule.',
  },
  {
    id: 'weekly-multi-day',
    utterance: '@agent every monday and thursday at 7am send a digest',
    explain: 'Registers a weekly agent that fires on both Monday and Thursday at 7:00, from a single utterance naming both days.',
  },
  {
    id: 'autonomous',
    utterance: '@agent 毎日8時にニュースをまとめて自律的に実行して',
    explain: 'The same daily schedule, but "自律的に実行して" (run autonomously) sets the Autonomous toggle — this agent runs unattended with no per-step approval tap.',
  },
];
