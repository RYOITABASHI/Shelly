/**
 * __tests__/ai-pane-dispatch-interaction-order.test.tsx
 *
 * Integration-level regression coverage for hooks/use-ai-pane-dispatch.ts's
 * dispatch() function, driven end-to-end through renderHook (not just the
 * pure decision-core functions it delegates to). Written after the
 * 2026-07-24 on-device finding fixed in commit b1145a016 (see that commit's
 * message and lib/agent-slot-fill.ts's hasFresherPendingSlotFillQuestion doc
 * comment): dispatch() has TWO independent "waiting for a reply" mechanisms
 * — session-scoped `pendingAgentSession` and message-attached
 * `pendingSlotFill` — that can both be live at once when a fresh
 * "@agent <command>" is sent while an earlier draft is still awaiting
 * confirm. That interaction was never exercised end-to-end before (the
 * existing convention is unit-testing extracted pure functions in lib/ —
 * see __tests__/agent-slot-fill.test.ts), which is exactly why the ordering
 * bug went undetected until a human found it live on a physical device.
 *
 * This file drives the REAL `dispatch` returned by useAIPaneDispatch(paneId)
 * through realistic multi-turn conversations and asserts on ai-pane-store
 * state after EACH turn, not just the final state — so a wrong intermediate
 * state (like the original bug) would be caught, not just a wrong final
 * answer.
 *
 * Mocking strategy: the REAL ai-pane-store / agent-store / settings-store
 * (zustand, reset between tests) are used so the actual state machine runs —
 * only true I/O boundaries (AsyncStorage, execCommand, the native
 * TerminalEmulator-backed agent persistence layer, local-LLM HTTP, sounds,
 * skill-recipe file reads) are mocked. parseAgentCommand's *routing* branch
 * (list/run/stop/.../create) is trivial for every utterance used below (all
 * of them are plain natural language, so the real function's `default:`
 * branch always applies — see lib/agent-manager.ts) so the whole module is
 * mocked wholesale rather than partially `requireActual`d, which would pull
 * in a much heavier transitive graph (expo-notifications, expo-file-system,
 * the escalation ladder, memory subsystem, etc.) for no benefit to what this
 * file actually exercises.
 */
import { renderHook, act } from '@testing-library/react-native';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function mockT(key: string, params?: Record<string, string | number>): string {
  return params ? `${key}(${JSON.stringify(params)})` : key;
}
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: mockT }),
  t: mockT,
}));

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
  checkOllamaConnection: jest.fn(async () => false),
  ollamaChatStream: jest.fn(),
}));

jest.mock('@/lib/sounds', () => ({
  playSound: jest.fn(),
}));

// Same pattern as __tests__/AgentConfirmCard.test.tsx: the real module's
// bottom-of-file `requireNativeModule('TerminalEmulator')` throws under Jest
// (no native module registered) — this is a transitive import via
// lib/home-path.ts / store/terminal-store.ts / lib/pseudo-shell.ts /
// hooks/use-multi-pane.ts / lib/scouter-telemetry.ts, all reached from
// hooks/use-ai-pane-dispatch.ts's own import graph even though none of
// those native calls are actually exercised by the @agent-only scenarios in
// this file (they're all called lazily, inside functions this file's
// scenarios never reach).
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getHomeDir: jest.fn(async () => '/data/user/0/dev.shelly.terminal/files/home'),
    getNotificationTriggerEnabled: jest.fn(async () => false),
  },
}));

// hooks/use-multi-pane.ts's zustand-persist store getters (e.g. `root`) get
// eagerly evaluated by the persist middleware's rehydrate/merge step under
// Jest + the async-storage mock, before the store's internal `get()` is
// wired up — a pre-existing quirk unrelated to what this file tests
// (terminalSessionForAiPane, the only consumer inside dispatch(), is never
// reached by any @agent-only scenario below). Mocked wholesale rather than
// worked around.
jest.mock('@/hooks/use-multi-pane', () => ({
  getLayout: jest.fn(() => ({ slotRects: {} })),
  useMultiPaneStore: {
    getState: () => ({ slots: [], preset: 'single', ratios: [], focusedSlot: 0 }),
  },
}));

jest.mock('@/lib/agent-skills', () => ({
  matchSkillRecipes: jest.fn(() => []),
  readSkillRecipes: jest.fn(async () => []),
  distillSkillFromRun: jest.fn(),
  writeSkillRecipe: jest.fn(async () => {}),
}));

jest.mock('@/lib/skill-import', () => ({
  readApprovedImportedSkillsAsRecipes: jest.fn(async () => []),
}));

// Wholesale mock — see file doc comment above for why requireActual is
// deliberately avoided here. parseAgentCommand's mock mirrors the REAL
// function's `default:` branch (lib/agent-manager.ts) exactly, which is the
// only branch any utterance in this file ever reaches (none of them are
// list/run/stop/delete/history/edit/status/"autonomous ..." commands).
const mockCreateAgent = jest.fn();
const mockUpdateAgent = jest.fn();
const mockInstallAgent = jest.fn(async () => {});
const mockDeleteAgent = jest.fn(async () => {});
const mockRunAgentNow = jest.fn(async () => {});
const mockStopAgent = jest.fn(async () => {});
jest.mock('@/lib/agent-manager', () => ({
  parseAgentCommand: jest.fn((input: string) => ({
    type: 'create',
    message: input.trim(),
    data: {},
  })),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  updateAgent: (...args: unknown[]) => mockUpdateAgent(...args),
  installAgent: (...args: unknown[]) => mockInstallAgent(...args),
  deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
  runAgentNow: (...args: unknown[]) => mockRunAgentNow(...args),
  stopAgent: (...args: unknown[]) => mockStopAgent(...args),
}));

import { useAIPaneDispatch } from '@/hooks/use-ai-pane-dispatch';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import { useSettingsStore } from '@/store/settings-store';
import { usePaneStore } from '@/store/pane-store';
import type { Agent } from '@/store/types';
import { agentToParsedAgentDraft } from '@/lib/agent-draft-patch';
import { hasDraftAssumptions, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import ja from '@/lib/i18n/locales/ja';

const PANE = 'pane-under-test';

function conv() {
  return useAIPaneStore.getState().getOrCreate(PANE);
}

function lastMessage() {
  const msgs = conv().messages;
  return msgs[msgs.length - 1];
}

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-edit-me',
    name: 'Morning brief',
    description: 'brief',
    prompt: 'Summarize the morning news',
    schedule: '30 8 * * *',
    tool: { type: 'cli', cli: 'codex' } as Agent['tool'],
    outputPath: '$HOME/out.md',
    outputTemplate: null,
    action: { type: 'notify' },
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
    ...overrides,
  } as Agent;
}

beforeEach(() => {
  jest.clearAllMocks();
  useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  useAgentStore.setState({ agents: [] } as any);
  usePaneStore.setState({ paneAgents: {} } as any);
  useSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      // Defaults per store/settings-store.ts (2026-07-24: registration now
      // requires an explicit confirm by default — see feedback memory
      // "Agent registration confirm default").
      agentRegistrationRequireConfirm: true,
      localLlmEnabled: false,
      agentVaultPath: '',
      agentTopicFolder: '',
    },
  }));

  // createAgent's real implementation (lib/agent-manager.ts) both writes the
  // agent into useAgentStore AND returns it synchronously — replicate both
  // so persistAgentDraft's create/update wiring and any later
  // useAgentStore.getState().agents lookups behave the same way the real
  // dispatch() call sites expect.
  mockCreateAgent.mockImplementation((params: any) => {
    const agent = baseAgent({
      id: `agent-created-${mockCreateAgent.mock.calls.length}`,
      name: params.name,
      prompt: params.prompt,
      schedule: params.schedule,
      action: params.action,
      tool: params.tool,
    });
    useAgentStore.getState().addAgent(agent);
    return agent;
  });
  mockUpdateAgent.mockImplementation(async (agentId: string, partial: any) => {
    const current = useAgentStore.getState().agents.find((a) => a.id === agentId);
    if (!current) return null;
    const updated = { ...current, ...partial };
    useAgentStore.getState().updateAgent(agentId, partial);
    return updated;
  });
});

function setup() {
  return renderHook(() => useAIPaneDispatch(PANE));
}

// ─── Scenario 1: the exact regression repro ───────────────────────────────

describe('Scenario 1 — exact on-device regression repro (commit b1145a016)', () => {
  it('a fresh @agent command asking its own question resolves a later reply against ITSELF, not the older pendingAgentSession', async () => {
    const { result } = setup();

    // Turn 1: agent A's utterance has an assumed time-of-day ("朝"→08:00) so
    // it reaches await-confirm directly (schedule already confident) —
    // verified against the real parser: parseAgentNL('毎週月曜の朝に
    // ゴミ出しをリマインドして') resolves scheduleConfident:true,
    // scheduleAssumed:true, action.type:'notify'.
    await act(async () => {
      await result.current.dispatch('@agent 毎週月曜の朝にゴミ出しをリマインドして');
    });
    const sessionAfterA = conv().pendingAgentSession;
    expect(sessionAfterA).toBeTruthy();
    expect(sessionAfterA?.draft.rawText).toBe('毎週月曜の朝にゴミ出しをリマインドして');
    expect(sessionAfterA?.phase).toBe('await-confirm');

    // Turn 2: a FRESH, unrelated @agent command. By design this must NOT
    // clear the ゴミ出し pendingAgentSession — assert that explicitly — and
    // it asks its OWN schedule question (message-attached pendingSlotFill),
    // since 'ニュースを通知して' alone has no confident schedule.
    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    expect(conv().pendingAgentSession).toEqual(sessionAfterA); // untouched, per design
    const questionMsg = lastMessage();
    expect(questionMsg.role).toBe('assistant');
    expect(questionMsg.pendingSlotFill?.field).toBe('schedule');

    // Turn 3: "今" is meant to answer the NEWS agent's fresh question, not
    // the ゴミ出し draft. Pre-fix, this was swallowed by the
    // pendingAgentSession block as a (silent, corrupting) patch attempt
    // against the STALE ゴミ出し draft. Post-fix
    // (hasFresherPendingSlotFillQuestion), it must resolve the NEWS
    // question instead.
    await act(async () => {
      await result.current.dispatch('今');
    });

    // The FIX itself: ゴミ出し's draft must be untouched by "今" — its
    // schedule must still be the original weekly-Monday cron, never patched
    // to 'once'.
    expect(sessionAfterA?.draft.schedule).not.toBe('once');

    // The news agent's own question must have actually been resolved by
    // "今" — nextMissingSlot found nothing else missing (action:'notify'
    // needs no notificationTrigger/outputPath here), so dispatch() should
    // have moved straight to presenting news's OWN draft for confirmation.
    // hasFireableSchedule('once') is true, so this either shows a NEW
    // chat-native pending confirmation for the news draft, or (if
    // auto-register were enabled) registers it directly. Either way, the
    // 'once' schedule must show up SOMEWHERE downstream of this reply
    // (it must not have been silently dropped).
    const pendingNow = conv().pendingAgentSession;

    // ⚠️ SUSPECTED BUG (found by this test, NOT the one b1145a016 already
    // fixed): presentDraftForConfirmation (hooks/use-ai-pane-dispatch.ts)
    // unconditionally OVERWRITES the single per-pane pendingAgentSession
    // slot (store/ai-pane-store.ts's setPendingAgentSession has no
    // "don't clobber an unrelated live session" guard) whenever the newly
    // resolved draft also needs `useChatConfirm` (true here — action.type
    // is 'notify'). So immediately after this reply, pendingAgentSession is
    // the NEWS session, and the ORIGINAL ゴミ出し pendingAgentSession
    // (`sessionAfterA`) is no longer reachable via pendingAgentSession at
    // all — even though its own chat bubble is still on screen and still
    // reads "...リマインド...よろしいですか？"). A typed confirm/cancel
    // reply from here on can only ever resolve against the NEWS session,
    // not ゴミ出し, until news's OWN session is cleared/replaced. This is a
    // DIFFERENT bug from the one b1145a016 fixed (that fix protects the
    // ANSWER text itself from being misrouted; this gap is about what
    // happens to the session pointer immediately afterward) and was not
    // in scope for that commit. Documenting the CURRENT actual behavior
    // here per this task's instructions, not fixing it.
    expect(pendingNow).not.toBeNull();
    expect(pendingNow?.messageId).not.toBe(sessionAfterA?.messageId);
    expect(pendingNow?.draft.rawText).toContain('ニュース');
    expect(pendingNow?.draft.schedule).toBe('once');

    // Consequence: the ORIGINAL ゴミ出し session is no longer the
    // pane's pendingAgentSession — a typed confirm/cancel from here would
    // land on ニュース, not ゴミ出し, despite the task's expectation ("A's
    // pendingAgentSession is STILL there afterward, confirmable/cancelable
    // later"). Recording the actual (buggy) outcome:
    expect(conv().pendingAgentSession?.draft.rawText).not.toBe(sessionAfterA?.draft.rawText);
  });
});

// ─── Scenario 2: inverse ordering ──────────────────────────────────────────

describe('Scenario 2 — inverse ordering (answer the fresh command first, then go back to the original)', () => {
  it('going back to confirm/cancel the ORIGINAL session after the interleaved one resolved lands on whichever session is CURRENTLY pending (same session-overwrite gap as Scenario 1)', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@agent 毎週月曜の朝にゴミ出しをリマインドして');
    });
    const original = conv().pendingAgentSession;
    expect(original?.phase).toBe('await-confirm');

    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    expect(conv().pendingAgentSession).toEqual(original);

    // Answer the fresh command's own question — this reaches
    // presentDraftForConfirmation for the news draft (see Scenario 1),
    // which overwrites pendingAgentSession.
    await act(async () => {
      await result.current.dispatch('今');
    });
    const afterNewsAnswered = conv().pendingAgentSession;
    expect(afterNewsAnswered?.draft.rawText).toContain('ニュース');

    // Now the user goes BACK and tries to cancel what they think is still
    // the ORIGINAL (ゴミ出し) draft.
    await act(async () => {
      await result.current.dispatch('cancel');
    });

    // ⚠️ Same session-overwrite gap as Scenario 1: since
    // pendingAgentSession currently points at the NEWS session (not
    // ゴミ出し), a cancel typed here cancels the NEWS draft, not the
    // original ゴミ出し one the user actually meant. isCancelPhrase's own
    // unconditional top-of-block check (see Scenario 3 below) still fires
    // correctly — it's just aimed at the wrong draft.
    expect(conv().pendingAgentSession).toBeNull();
    const cancelledMsg = conv().messages.find((m) => m.id === afterNewsAnswered?.messageId);
    expect(cancelledMsg?.agentCardState).toBe('cancelled');
    // The ORIGINAL ゴミ出し bubble is untouched — never marked cancelled —
    // demonstrating it was never actually reached by this "cancel" reply.
    const originalMsg = conv().messages.find((m) => m.id === original?.messageId);
    expect(originalMsg?.agentCardState).toBe('pending');
  });
});

// ─── Scenario 3: cancel phrase while both mechanisms are live ─────────────

describe('Scenario 3 — cancel phrase with pendingAgentSession active AND a fresher pendingSlotFill both live', () => {
  it('cancels pendingAgentSession unconditionally — the freshness guard only gates confirm/patch, not cancel (per the code as written)', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@agent 毎週月曜の朝にゴミ出しをリマインドして');
    });
    const original = conv().pendingAgentSession;
    expect(original).toBeTruthy();

    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    // A fresher, unanswered pendingSlotFill now sits on the latest message.
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');

    // dispatch()'s pendingAgentSession block (hooks/use-ai-pane-dispatch.ts)
    // reads:
    //   if (pendingAgentSession && phase==='await-confirm' && !stale && !hasFresherOwnSlotFillQuestion) {
    //     if (isCancelPhrase(userText)) { ...cancel... return; }
    //     ...
    //   }
    // The `!hasFresherOwnSlotFillQuestion` guard wraps the ENTIRE block,
    // including the cancel check — so with a fresher pendingSlotFill
    // present, the pendingAgentSession block is skipped ENTIRELY (cancel
    // included), and "cancel" falls through to the message-attached
    // slot-fill handler instead, which treats it as an answer to the NEWS
    // question (lib/agent-slot-fill.ts's isCancelPhrase check there),
    // cancelling the NEWS slot-fill conversation — NOT the ゴミ出し
    // pendingAgentSession. Confirmed by reading the guard placement: the
    // task description's premise that "pendingAgentSession's own cancel
    // check happens unconditionally at the top of that block regardless of
    // the new freshness guard" turned out to be about a NARROWER top — the
    // freshness guard is on the IF that gates the whole block, so cancel is
    // included in the skip, not exempted from it.
    await act(async () => {
      await result.current.dispatch('cancel');
    });

    // ゴミ出し's pendingAgentSession survives untouched.
    expect(conv().pendingAgentSession).toEqual(original);
    // The NEWS slot-fill conversation was the one cancelled instead.
    const cancelReply = lastMessage();
    expect(cancelReply.role).toBe('assistant');
    // lib/agent-slot-fill.ts's isCancelPhrase branch (message-attached
    // pendingSlotFill path) uses the REAL locale string table directly
    // (ja['slot_fill.cancelled']), not the mocked t() — detectMessageLocale
    // picks 'ja' here since the news draft's rawText is Japanese.
    expect(cancelReply.content).toBe(ja['slot_fill.cancelled']);
  });
});

// ─── Scenario 4: sequential slot-filling, no interleaving (sanity check) ──

describe('Scenario 4 — two agents both reach pendingSlotFill sequentially, no interleaving', () => {
  it('ordinary sequential slot-filling still works with no pendingAgentSession involved at all', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    expect(conv().pendingAgentSession).toBeUndefined();
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');

    await act(async () => {
      await result.current.dispatch('毎日8時');
    });
    // Resolved (confident schedule) and nothing else missing for a 'notify'
    // action → hands off to presentDraftForConfirmation. Deliberately
    // stopping here (NOT sending a confirm phrase) keeps this scenario
    // genuinely "no pendingAgentSession involved" for the SECOND agent's
    // own turn below — see the "Bonus finding" block right after this one
    // for what happens if agent 1 IS fully confirmed first (a separate,
    // real interaction-order bug this test intentionally avoids
    // triggering, to keep this scenario a clean sanity check of the
    // pendingSlotFill mechanism itself, per the task's own framing of
    // Scenario 4 as "no pendingAgentSession involved at all").
    const firstSession = conv().pendingAgentSession;
    expect(firstSession?.draft.rawText).toContain('ニュース');
    expect(firstSession?.draft.schedule).toBe('0 8 * * *');
    useAIPaneStore.getState().setPendingAgentSession(PANE, null);

    // Second, unrelated agent — sequential, not interleaved.
    await act(async () => {
      await result.current.dispatch('@agent 天気を通知して');
    });
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');

    await act(async () => {
      await result.current.dispatch('毎日7時');
    });
    const secondSession = conv().pendingAgentSession;
    expect(secondSession?.draft.rawText).toContain('天気');
    expect(secondSession?.draft.schedule).toBe('0 7 * * *');
  });
});

// ─── Bonus finding: justRegisteredAgent can hijack an unrelated agent's own
// slot-fill reply (discovered while building Scenario 4 above) ────────────

describe('Bonus finding — justRegisteredAgent correction window vs. a fresh agent\'s own pendingSlotFill reply', () => {
  it('FIXED: after agent 1 is fully registered, agent 2\'s OWN schedule answer resolves agent 2\'s question, not a "correction" to agent 1', async () => {
    const { result } = setup();

    // Agent 1: ask → answer → CONFIRM (full round trip, ordinary use).
    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    await act(async () => {
      await result.current.dispatch('毎日8時');
    });
    await act(async () => {
      await result.current.dispatch('OK'); // confirms + registers ニュース
    });
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockCreateAgent.mock.calls[0][0].name).toBe('ニュース');
    // Registering via the chat-native path opens a short (4-minute)
    // "catch a slip of the tongue" correction window — see
    // JUST_REGISTERED_STALE_MS / JustRegisteredAgentRef's doc comments.
    expect(conv().justRegisteredAgent?.agentId).toBe(mockCreateAgent.mock.results[0].value.id);

    // Agent 2: a completely unrelated fresh command, asked immediately
    // after. Per design this must NOT touch the still-open correction
    // window for agent 1 (applyCorrectionToJustRegisteredAgent explicitly
    // bypasses any "@..." command).
    await act(async () => {
      await result.current.dispatch('@agent 天気を通知して');
    });
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');
    expect(conv().justRegisteredAgent?.agentId).toBe(mockCreateAgent.mock.results[0].value.id); // untouched

    // Agent 2's own answer to ITS OWN "いつ実行しますか？" question.
    await act(async () => {
      await result.current.dispatch('毎日7時');
    });

    // FIXED (2026-07-24, same guard/pattern as commit b1145a016): the
    // `justRegistered` correction-window block is now skipped whenever the
    // truly-latest message carries its own fresher, still-live
    // pendingSlotFill (`hasFresherOwnSlotFillQuestion`, computed once near
    // the top of dispatch() and reused here) — so "毎日7時" now correctly
    // falls through past the justRegisteredAgent block entirely and resolves
    // 天気's OWN schedule question instead of being misread as a correction
    // to ニュース. ニュース's schedule must stay untouched.
    expect(mockUpdateAgent).not.toHaveBeenCalled();
    // Nothing else was missing for 天気 (action:'notify' needs no
    // notificationTrigger/outputPath here) once its schedule resolved, so
    // dispatch() moves straight to presentDraftForConfirmation for 天気 —
    // action:'notify' is chat-confirm-eligible, and
    // agentRegistrationRequireConfirm:true (this file's settings mock, line
    // ~184) means it does NOT auto-register even though the schedule is now
    // confident+explicit — it becomes a new pending chat-native confirmation.
    expect(mockCreateAgent).toHaveBeenCalledTimes(1); // still just ニュース — 天気 not yet confirmed
    const pendingAfterWeatherAnswer = conv().pendingAgentSession;
    expect(pendingAfterWeatherAnswer).not.toBeNull();
    expect(pendingAfterWeatherAnswer?.draft.rawText).toContain('天気');
    expect(pendingAfterWeatherAnswer?.draft.schedule).toBe('0 7 * * *');
    const lastAssistantMsg = [...conv().messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistantMsg?.content).toContain('天気');
  });
});

// ─── Scenario 5: stale pendingAgentSession + fresh pendingSlotFill ────────

describe('Scenario 5 — stale pendingAgentSession under a fresh pendingSlotFill', () => {
  it('a pendingAgentSession older than SLOT_FILL_STALE_MS is ignored regardless of the new freshness guard', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@agent 毎週月曜の朝にゴミ出しをリマインドして');
    });
    const original = conv().pendingAgentSession;
    expect(original).toBeTruthy();

    // Backdate it past SLOT_FILL_STALE_MS (15 minutes).
    useAIPaneStore.getState().setPendingAgentSession(PANE, {
      ...original!,
      createdAt: Date.now() - 20 * 60 * 1000,
    });

    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');

    // A plain confirm-shaped reply now must resolve the FRESH news
    // question, not the (already-ignorable-for-being-stale)
    // pendingAgentSession — same outcome the freshness guard alone would
    // produce, but this time staleness is the reason even without it.
    await act(async () => {
      await result.current.dispatch('今');
    });
    expect(conv().pendingAgentSession?.draft.rawText).toContain('ニュース');
    expect(conv().pendingAgentSession?.draft.schedule).toBe('once');
  });
});

// ─── Scenario 6: editingAgentId survives interleaving ─────────────────────

describe('Scenario 6 — Sidebar edit session interleaved with a fresh @agent command', () => {
  it('a typed confirm after the interleaving no longer reaches the ORIGINAL edit session — regresses the previously-fixed "duplicate instead of update" bug via a NEW path', async () => {
    const { result } = setup();
    const existingAgent = baseAgent();
    useAgentStore.getState().addAgent(existingAgent);

    // Simulate Sidebar.tsx's "Edit" button handler exactly (components/
    // layout/Sidebar.tsx) — it does not go through dispatch() at all, it
    // posts a chat-native draft bubble and sets pendingAgentSession with
    // editingAgentId directly.
    const editDraft = agentToParsedAgentDraft(existingAgent);
    const editMessageId = 'agent-edit-existing';
    act(() => {
      useAIPaneStore.getState().addMessage(PANE, {
        id: editMessageId,
        role: 'assistant',
        content: summarizeAgentDraftAsText(editDraft, undefined, true),
        timestamp: Date.now(),
        agentDraft: editDraft,
        agentChatConfirm: true,
      });
      useAIPaneStore.getState().setPendingAgentSession(PANE, {
        draft: editDraft,
        editingAgentId: existingAgent.id,
        phase: 'await-confirm',
        attemptCounts: {},
        hasAssumptions: hasDraftAssumptions(editDraft),
        createdAt: Date.now(),
        messageId: editMessageId,
      });
    });
    const editSession = conv().pendingAgentSession;
    expect(editSession?.editingAgentId).toBe(existingAgent.id);

    // An unrelated fresh command interleaves and asks its OWN question.
    await act(async () => {
      await result.current.dispatch('@agent 天気を通知して');
    });
    // Per design, the edit session must survive this untouched.
    expect(conv().pendingAgentSession).toEqual(editSession);
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');

    // Resolve the new command's own question — reaches
    // presentDraftForConfirmation for the WEATHER draft, which (per
    // Scenarios 1/2's finding) overwrites pendingAgentSession, losing
    // editingAgentId.
    await act(async () => {
      await result.current.dispatch('毎日7時');
    });
    const afterWeatherResolved = conv().pendingAgentSession;
    expect(afterWeatherResolved?.editingAgentId).toBeUndefined();
    expect(afterWeatherResolved?.draft.rawText).toContain('天気');

    // The user now goes back and types a confirm phrase meaning to confirm
    // the ORIGINAL edit.
    await act(async () => {
      await result.current.dispatch('OK');
    });

    // ⚠️ SUSPECTED BUG — same root cause as Scenarios 1/2, but this is the
    // more SEVERE variant the task specifically calls out: the confirm
    // resolves against the WEATHER session (editingAgentId undefined), so
    // confirmAgentDraft creates a brand-new agent for 天気 instead of
    // touching the edit at all. The original edit to `existingAgent` is
    // simply never applied — updateAgent is never called for it, and the
    // edit's own chat bubble is left dangling in 'pending' state forever
    // (no further reply can ever reach it via typed confirm, since
    // pendingAgentSession no longer points at it and nothing re-derives
    // editingAgentId from a stale messageId match). This reproduces the
    // *effect* of the historical "duplicate agent instead of updating"
    // bug (see hooks/use-ai-pane-dispatch.ts's own 2026-07-23 comment on
    // the pendingAgentSession confirm branch) through a different trigger
    // than the one already fixed there.
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockCreateAgent.mock.calls[0][0].name).toBe('天気');
    expect(mockUpdateAgent).not.toHaveBeenCalled();

    const editMsgAfter = conv().messages.find((m) => m.id === editMessageId);
    // Never reached 'confirmed' (confirmAgentDraft's own doing when it
    // actually resolves a session for THIS messageId) — it simply stays
    // whatever it started as. Note components/layout/Sidebar.tsx's real
    // Edit handler never sets agentCardState:'pending' on this bubble to
    // begin with (unlike presentDraftForConfirmation's own addMessage call
    // in hooks/use-ai-pane-dispatch.ts, which does) — mirrored here
    // faithfully rather than "fixed" in the test, since this file is
    // documenting actual current behavior, not an idealized one.
    expect(editMsgAfter?.agentCardState).toBeUndefined();

    // Tapping the ORIGINAL edit bubble's own Confirm button directly still
    // calls confirmAgentDraft(editMessageId, ...) regardless of what
    // pendingAgentSession currently holds (components/panes/AIPane.tsx
    // wires AgentChatConfirm's onConfirm to the bubble's OWN message.id,
    // not to whatever session happens to be pending) — but by then
    // pendingAgentSession.messageId no longer matches editMessageId, so
    // confirmAgentDraft's own `editingAgentId = currentPending?.messageId
    // === messageId ? currentPending.editingAgentId : undefined` resolves
    // to undefined, and persistAgentDraft creates ANOTHER new agent
    // instead of updating existingAgent — the exact historical bug shape,
    // reproduced here directly against the pure helper for clarity without
    // needing to route back through dispatch()/component wiring:
    const editingAgentIdAtTapTime =
      conv().pendingAgentSession?.messageId === editMessageId
        ? conv().pendingAgentSession?.editingAgentId
        : undefined;
    expect(editingAgentIdAtTapTime).toBeUndefined();
  });

  it('sanity check: WITHOUT any interleaving, a typed confirm on a Sidebar edit session correctly calls updateAgent, never createAgent', async () => {
    const { result } = setup();
    const existingAgent = baseAgent();
    useAgentStore.getState().addAgent(existingAgent);

    const editDraft = agentToParsedAgentDraft(existingAgent);
    const editMessageId = 'agent-edit-existing-clean';
    act(() => {
      useAIPaneStore.getState().addMessage(PANE, {
        id: editMessageId,
        role: 'assistant',
        content: summarizeAgentDraftAsText(editDraft, undefined, true),
        timestamp: Date.now(),
        agentDraft: editDraft,
        agentChatConfirm: true,
      });
      useAIPaneStore.getState().setPendingAgentSession(PANE, {
        draft: editDraft,
        editingAgentId: existingAgent.id,
        phase: 'await-confirm',
        attemptCounts: {},
        hasAssumptions: hasDraftAssumptions(editDraft),
        createdAt: Date.now(),
        messageId: editMessageId,
      });
    });

    await act(async () => {
      await result.current.dispatch('OK');
    });

    expect(mockUpdateAgent).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgent).toHaveBeenCalledWith(existingAgent.id, expect.anything(), expect.anything());
    expect(mockCreateAgent).not.toHaveBeenCalled();
    const editMsgAfter = conv().messages.find((m) => m.id === editMessageId);
    expect(editMsgAfter?.agentCardState).toBe('confirmed');
  });
});
