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
  // summarizeAgentDraftAsText routes through tFor(locale, ...) instead of the
  // global-locale-bound t() (2026-07-27 language-mismatch fix) — keep the
  // same key(params)-JSON shape so assertions stay locale-blind.
  tFor: (_locale: string, key: string, params?: Record<string, string | number>) => mockT(key, params),
}));

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
  checkOllamaConnection: jest.fn(async () => false),
  ollamaChatStream: jest.fn(),
}));

jest.mock('@/lib/openrouter', () => ({
  OPENROUTER_DEFAULT_MODEL: 'openrouter/auto',
  openRouterChatStream: jest.fn(),
}));

// 2026-07-27 regression coverage (on-device finding: "@agent 手伝って" never
// asked its task-clarity clarifying question): the two
// extractAgentFieldsWithLlm call sites in hooks/use-ai-pane-dispatch.ts now
// call ensureLocalLlmServerRunning first when local LLM is enabled, mirroring
// the agent==='local' chat-streaming path. Mocked here (real module reads
// settings-store + shells out via execCommand) so Scenario 7 below can assert
// it was actually invoked, without the real 30s+ connect-retry loop running
// under Jest.
jest.mock('@/lib/local-llm-autostart', () => ({
  ensureLocalLlmServerRunning: jest.fn(async () => ({ ok: true, status: 'ready' })),
  kickLocalLlmAutoStart: jest.fn(),
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
const mockWriteGlobalMemoryNote = jest.fn(async () => {});
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
  // 2026-07-29: the ONLY production writer of a user-scope (`_global`) memory
  // note. Mocked so Scenario 8 can assert the new entry point routes through
  // THIS wrapper — the one that also re-bakes every agent's baked recall and
  // therefore preserves the G2 secret-guard invariant — and never through a
  // raw memory write.
  writeGlobalMemoryNote: (...args: unknown[]) => mockWriteGlobalMemoryNote(...args),
}));

import { useAIPaneDispatch } from '@/hooks/use-ai-pane-dispatch';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import { useSettingsStore } from '@/store/settings-store';
import { usePaneStore } from '@/store/pane-store';
import type { Agent } from '@/store/types';
import { agentToParsedAgentDraft } from '@/lib/agent-draft-patch';
import { hasDraftAssumptions, summarizeAgentDraftAsText, draftToConfirmedAgentDraft } from '@/lib/agent-plan-summary';
import ja from '@/lib/i18n/locales/ja';
import en from '@/lib/i18n/locales/en';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ollamaChat: mockOllamaChat } = require('@/lib/local-llm') as { ollamaChat: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureLocalLlmServerRunning: mockEnsureLocalLlmServerRunning } =
  require('@/lib/local-llm-autostart') as { ensureLocalLlmServerRunning: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openRouterChatStream: mockOpenRouterChatStream } =
  require('@/lib/openrouter') as { openRouterChatStream: jest.Mock };

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

describe('@openrouter attended dispatch', () => {
  it('routes the mention to openRouterChatStream', async () => {
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        openrouterApiKey: 'sk-or-test',
        openrouterModel: 'openrouter/auto',
      },
    }));
    mockOpenRouterChatStream.mockImplementation(
      async (
        _apiKey: string,
        _prompt: string,
        onChunk: (text: string, done: boolean) => void,
      ) => {
        onChunk('OpenRouter reply', false);
        onChunk('', true);
        return { success: true, content: 'OpenRouter reply' };
      },
    );
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@openrouter hello');
    });

    expect(mockOpenRouterChatStream).toHaveBeenCalledWith(
      'sk-or-test',
      'hello',
      expect.any(Function),
      'openrouter/auto',
      expect.any(Array),
      expect.any(AbortSignal),
      expect.any(String),
    );
    expect(lastMessage().content).toBe('OpenRouter reply');
  });
});

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

    // bug #157 (docs/superpowers/DEFERRED.md, fixed): presentDraftForConfirmation
    // (hooks/use-ai-pane-dispatch.ts) still claims the single per-pane
    // pendingAgentSession slot for the NEWS draft here — DEFERRED.md's own
    // analysis found that NOT doing so just moves the identical bug onto the
    // news draft's own typed reply instead (a genuine multi-session redesign
    // is out of scope for this fix), so this part of the behavior is
    // unchanged by design. So immediately after this reply, pendingAgentSession
    // is the NEWS session, and the ORIGINAL ゴミ出し pendingAgentSession
    // (`sessionAfterA`) is no longer reachable via pendingAgentSession at
    // all — its chat bubble is still on screen and still reads
    // "...リマインド...よろしいですか？"). A typed confirm/cancel reply from
    // here on can only ever resolve against the NEWS session, not ゴミ出し,
    // until news's OWN session is cleared/replaced.
    expect(pendingNow).not.toBeNull();
    expect(pendingNow?.messageId).not.toBe(sessionAfterA?.messageId);
    expect(pendingNow?.draft.rawText).toContain('ニュース');
    expect(pendingNow?.draft.schedule).toBe('once');

    // Consequence: the ORIGINAL ゴミ出し session is no longer the
    // pane's pendingAgentSession — a typed confirm/cancel from here would
    // land on ニュース, not ゴミ出し, despite the task's expectation ("A's
    // pendingAgentSession is STILL there afterward, confirmable/cancelable
    // later"). Recording the actual outcome:
    expect(conv().pendingAgentSession?.draft.rawText).not.toBe(sessionAfterA?.draft.rawText);

    // ✅ THE FIX: unlike before, the takeover is no longer SILENT — the
    // ゴミ出し bubble itself (still visible, still 'pending') was updated
    // with a notice explaining that typed replies now resolve the newer
    // (news) draft and that this one must be confirmed via its own tap
    // button instead.
    const gomiDashiMsg = conv().messages.find((m) => m.id === sessionAfterA?.messageId);
    expect(gomiDashiMsg?.content).toContain(ja['agentplan.superseded_notice']);
    expect(gomiDashiMsg?.agentCardState).toBe('pending'); // still tap-confirmable
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

    // bug #157 (fixed — see Scenario 1's own updated notes): same
    // session-overwrite as Scenario 1, unchanged by design. Since
    // pendingAgentSession currently points at the NEWS session (not
    // ゴミ出し), a cancel typed here cancels the NEWS draft, not the
    // original ゴミ出し one the user actually meant. isCancelPhrase's own
    // unconditional top-of-block check (see Scenario 3 below) still fires
    // correctly — it's just aimed at the wrong draft.
    expect(conv().pendingAgentSession).toBeNull();
    const cancelledMsg = conv().messages.find((m) => m.id === afterNewsAnswered?.messageId);
    expect(cancelledMsg?.agentCardState).toBe('cancelled');
    // The ORIGINAL ゴミ出し bubble's card state is untouched — never marked
    // cancelled — demonstrating it was never actually reached by this
    // "cancel" reply. ✅ THE FIX: it DOES carry the superseded notice from
    // when the news draft first claimed pendingAgentSession (turn 3 above),
    // so the user has a way to know a typed "cancel" no longer reaches it —
    // and can still tap its own Cancel/Confirm button directly.
    const originalMsg = conv().messages.find((m) => m.id === original?.messageId);
    expect(originalMsg?.agentCardState).toBe('pending');
    expect(originalMsg?.content).toContain(ja['agentplan.superseded_notice']);
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

// ─── Bug fix regression (2026-07-27, on-device repro at versionCode 1988):
// "今すぐ実行して" during the post-registration correction window must NOT
// silently wipe an already-registered agent's recurring schedule — see
// lib/agent-draft-patch.ts's applyCorrectionToJustRegisteredAgent doc
// comment (runNowRequested) for the root-cause writeup. This is the
// end-to-end version of __tests__/agent-registered-correction.test.ts's
// pure-function coverage of the same fix, driven through the REAL dispatch()
// hook so the hooks/use-ai-pane-dispatch.ts wiring (runAgentNow call,
// updateAgent partial, message content) is exercised too, not just the pure
// decision core. ──────────────────────────────────────────────────────────

describe('Bug fix — "今すぐ実行して" in the correction window runs the agent once without touching its persisted schedule', () => {
  it('on-device repro sequence: register a real recurring-schedule agent, then "今すぐ実行して" — schedule survives unchanged, runAgentNow fires', async () => {
    const { result } = setup();

    // Turn 1+2: register a recurring agent via the chat-native flow — same
    // single-message shape Scenario 1 already verified reaches await-confirm
    // directly with a confident weekly cron (毎週月曜の朝 → Monday 08:00),
    // then confirm it.
    await act(async () => {
      await result.current.dispatch('@agent 毎週月曜の朝にゴミ出しをリマインドして');
    });
    await act(async () => {
      await result.current.dispatch('OK');
    });
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const agentId = mockCreateAgent.mock.results[0].value.id;
    const registeredSchedule = useAgentStore.getState().agents.find((a) => a.id === agentId)?.schedule;
    // Confirms this is a REAL recurring cron, not 'once'/null — the exact
    // precondition the bug needed (nothing to protect otherwise).
    expect(registeredSchedule).toBeTruthy();
    expect(registeredSchedule).not.toBe('once');
    expect(conv().justRegisteredAgent?.agentId).toBe(agentId);

    // Turn 3: within the 4-minute post-registration correction window, the
    // exact on-device repro phrasing — "run it right now".
    await act(async () => {
      await result.current.dispatch('今すぐ実行して');
    });

    // FIX: runAgentNow fired for this agent as an ADDITIONAL one-off action.
    expect(mockRunAgentNow).toHaveBeenCalled();
    expect(mockRunAgentNow.mock.calls[0][0]).toBe(agentId);

    // THE BUG: pre-fix, updateAgent was called with { schedule: null } here
    // (parseSchedule's 'once' sentinel normalized straight into a persisted
    // null), flipping Sidebar's schedule column from the real cron to
    // "manual". Post-fix, the agent's persisted schedule must be byte-for-
    // byte unchanged.
    const scheduleAfterRunNow = useAgentStore.getState().agents.find((a) => a.id === agentId)?.schedule;
    expect(scheduleAfterRunNow).toBe(registeredSchedule);
    // Belt-and-suspenders: updateAgent must never have been called with a
    // `schedule` field at all as part of this correction (whether or not it
    // was called for some other field).
    for (const call of mockUpdateAgent.mock.calls) {
      expect((call[1] as Record<string, unknown> | undefined)?.schedule).toBeUndefined();
    }
  });

  it('sanity check: a still-unregistered draft\'s "今" reply during await-confirm is UNCHANGED by this fix — it still resolves to a one-shot schedule', async () => {
    const { result } = setup();

    // "ニュースを通知して" alone has no confident schedule, so it reaches
    // await-confirm's message-attached pendingSlotFill question first (same
    // as the Bonus finding scenario above) — NOT yet a registered agent, so
    // applyCorrectionToJustRegisteredAgent is never even reached here; only
    // applyPatchToPendingSession-adjacent slot-fill code runs.
    await act(async () => {
      await result.current.dispatch('@agent ニュースを通知して');
    });
    expect(lastMessage().pendingSlotFill?.field).toBe('schedule');

    // "今" answers the still-pending draft's OWN schedule question — this is
    // the legitimate case the task explicitly requires stay intact: a
    // genuinely new, still-unregistered draft resolving "今" to a one-shot
    // ('once') schedule, exactly as before this fix (applyPatchToPendingSession
    // and the slot-fill answer path are untouched by this fix — only
    // applyCorrectionToJustRegisteredAgent, reached only AFTER registration,
    // was changed).
    await act(async () => {
      await result.current.dispatch('今');
    });

    // Nothing else was missing once schedule resolved, so dispatch() moves
    // straight to presentDraftForConfirmation — agentRegistrationRequireConfirm:true
    // (this file's settings mock) means it becomes a pending chat-native
    // confirmation rather than auto-registering, same as the Bonus finding
    // scenario's "毎日7時" answer above. The point here is specifically that
    // schedule resolved to 'once' (a real answer, not silently dropped) and
    // registration was never blocked or forced into requiring a real cron.
    expect(mockCreateAgent).not.toHaveBeenCalled();
    const pendingAfterNow = conv().pendingAgentSession;
    expect(pendingAfterNow).not.toBeNull();
    expect(pendingAfterNow?.draft.schedule).toBe('once');
  });
});

// ─── Bug fix regression (2026-07-28) — same shape as the correction-window
// fix above (a8076125f, 2026-07-27), applied one layer earlier: a bare
// "今"/"今すぐ" patch reply to a still-PENDING (not yet registered) draft
// that ALREADY has a real recurring schedule must not silently overwrite it
// with parseSchedule's 'once' sentinel — see lib/agent-draft-patch.ts's
// applyPatchToPendingSession doc comment and
// docs/superpowers/DEFERRED.md's "「今」/「今すぐ」が保留下書きへのパッチ・
// 登録済みエージェントへの補正として schedule:'once' を無条件に信頼する"
// entry for the shared root-cause write-up. This is the end-to-end version
// of __tests__/agent-draft-patch.test.ts's pure-function coverage of the
// same fix, driven through the REAL dispatch() hook so the
// hooks/use-ai-pane-dispatch.ts wiring (the patch-reply message, the
// eventual confirmAgentDraft registration with schedule left untouched, and
// the additional runAgentNow call) is exercised too, not just the pure
// decision core. ─────────────────────────────────────────────────────────

describe('Bug fix — "今すぐ実行して" against a still-PENDING draft with a real recurring schedule does not wipe it either', () => {
  it('on-device-shaped repro: a chat-native draft reaches await-confirm with a real weekly cron, "今すぐ実行して" patches it, then "OK" registers with the schedule intact and fires an additional run', async () => {
    const { result } = setup();

    // Turn 1: same single-message shape Scenario 1 already verified reaches
    // await-confirm directly with a confident weekly cron (毎週月曜の朝 →
    // Monday 08:00) — NOT yet confirmed/registered.
    await act(async () => {
      await result.current.dispatch('@agent 毎週月曜の朝にゴミ出しをリマインドして');
    });
    const sessionAfterTurn1 = conv().pendingAgentSession;
    expect(sessionAfterTurn1).toBeTruthy();
    expect(sessionAfterTurn1?.phase).toBe('await-confirm');
    const originalSchedule = sessionAfterTurn1!.draft.schedule;
    // Confirms this is a REAL recurring cron, not 'once'/null — the exact
    // precondition the bug needed (nothing to protect otherwise).
    expect(originalSchedule).toBeTruthy();
    expect(originalSchedule).not.toBe('once');
    expect(mockCreateAgent).not.toHaveBeenCalled(); // nothing registered yet

    // Turn 2: NOT a confirm phrase (see lib/agent-confirm-phrase.ts's
    // isConfirmPhrase — "今すぐ実行して" is not in its whitelist), so this
    // falls through to the patch-detection branch, applyPatchToPendingSession.
    await act(async () => {
      await result.current.dispatch('今すぐ実行して');
    });

    // FIX: the draft's schedule survives untouched, and the patch reply
    // carries the run-once-on-confirm note instead of a schedule-change line.
    const sessionAfterTurn2 = conv().pendingAgentSession;
    expect(sessionAfterTurn2).toBeTruthy();
    expect(sessionAfterTurn2?.phase).toBe('await-confirm'); // still not registered
    expect(sessionAfterTurn2?.draft.schedule).toBe(originalSchedule);
    expect(sessionAfterTurn2?.draft.runOnceOnConfirm).toBe(true);
    expect(lastMessage().content).toContain(ja['agentplan.run_once_on_confirm_note']);
    expect(mockCreateAgent).not.toHaveBeenCalled(); // still not registered

    // Turn 3: an actual confirm phrase now commits the draft.
    await act(async () => {
      await result.current.dispatch('OK');
    });

    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    // THE BUG (pre-fix): createAgent would have been called with
    // schedule: null (parseSchedule's 'once' sentinel normalized straight
    // through), silently registering a manual-only agent instead of the
    // weekly recurring one the user actually asked for. Post-fix, the
    // persisted schedule must be byte-for-byte the ORIGINAL cron.
    expect(mockCreateAgent.mock.calls[0][0].schedule).toBe(originalSchedule);
    const agentId = mockCreateAgent.mock.results[0].value.id;
    const persistedSchedule = useAgentStore.getState().agents.find((a) => a.id === agentId)?.schedule;
    expect(persistedSchedule).toBe(originalSchedule);

    // FIX: the run-once intent was not lost either — an ADDITIONAL runAgentNow
    // fired for the newly-registered agent right after registration.
    expect(mockRunAgentNow).toHaveBeenCalled();
    expect(mockRunAgentNow.mock.calls[0][0]).toBe(agentId);
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
  it('bug #157 fix: a tapped confirm on the ORIGINAL edit bubble still calls updateAgent, never createAgent, even after an interleaved draft overwrote pendingAgentSession', async () => {
    const { result } = setup();
    const existingAgent = baseAgent();
    useAgentStore.getState().addAgent(existingAgent);

    // Simulate Sidebar.tsx's "Edit" button handler exactly (components/
    // layout/Sidebar.tsx) — it does not go through dispatch() at all, it
    // posts a chat-native draft bubble (now carrying editingAgentId on the
    // MESSAGE too, per the bug #157 fix) and sets pendingAgentSession with
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
        editingAgentId: existingAgent.id,
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
    // presentDraftForConfirmation for the WEATHER draft, which (per bug
    // #157's own analysis — see hooks/use-ai-pane-dispatch.ts's doc comment
    // right above its setPendingAgentSession call) STILL overwrites
    // pendingAgentSession (a genuine multi-session redesign is out of scope
    // for this fix), losing editingAgentId FROM THE SESSION. The fix is that
    // this no longer matters for the edit bubble's own eventual confirm —
    // see below.
    await act(async () => {
      await result.current.dispatch('毎日7時');
    });
    const afterWeatherResolved = conv().pendingAgentSession;
    expect(afterWeatherResolved?.editingAgentId).toBeUndefined();
    expect(afterWeatherResolved?.draft.rawText).toContain('天気');

    // ✅ THE FIX (visible-signal mitigation): the overwrite is no longer
    // silent — the edit bubble was updated with the edit-specific superseded
    // notice (not the generic one) since editSession.editingAgentId was set.
    // baseAgent()'s prompt ("Summarize the morning news") is English, so
    // detectMessageLocale(editDraft.rawText) picks the 'en' table here,
    // unlike Scenarios 1/2's Japanese-utterance drafts.
    const editMsgAfterOverwrite = conv().messages.find((m) => m.id === editMessageId);
    expect(editMsgAfterOverwrite?.content).toContain(en['agentplan.superseded_notice_edit']);

    // The user now goes back and types a confirm phrase. Per bug #157's own
    // documented tradeoff (see Scenario 1/2 above), a typed reply from here
    // still resolves whichever session is CURRENTLY pending — the WEATHER
    // one, not the edit — so this correctly registers 天気 as a NEW agent
    // (it genuinely is one), not the edit.
    await act(async () => {
      await result.current.dispatch('OK');
    });
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockCreateAgent.mock.calls[0][0].name).toBe('天気');
    expect(mockUpdateAgent).not.toHaveBeenCalled();

    const editMsgAfter = conv().messages.find((m) => m.id === editMessageId);
    // Never reached 'confirmed' via the typed "OK" above (that resolved
    // weather, not this bubble) — it simply stays whatever it started as.
    // Note components/layout/Sidebar.tsx's real Edit handler never sets
    // agentCardState:'pending' on this bubble to begin with (unlike
    // presentDraftForConfirmation's own addMessage call in hooks/use-ai-pane-
    // dispatch.ts, which does) — mirrored here faithfully.
    expect(editMsgAfter?.agentCardState).toBeUndefined();

    // ✅ THE FIX itself: tapping the ORIGINAL edit bubble's own Confirm
    // button — exactly what AgentChatConfirm's onConfirm does, calling
    // confirmAgentDraft(editMessageId, ...) directly regardless of what
    // pendingAgentSession currently holds (components/panes/AIPane.tsx wires
    // it to the bubble's OWN message.id) — now correctly calls updateAgent,
    // not createAgent, because confirmAgentDraft recovers editingAgentId
    // from the MESSAGE itself (ChatMessage.editingAgentId) rather than only
    // from pendingAgentSession, which no longer matches this messageId.
    await act(async () => {
      await result.current.confirmAgentDraft(editMessageId, draftToConfirmedAgentDraft(editDraft));
    });
    expect(mockUpdateAgent).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgent).toHaveBeenCalledWith(existingAgent.id, expect.anything(), expect.anything());
    // Still exactly one createAgent call (天気, from the typed "OK" above) —
    // the historical "duplicate agent instead of updating" bug does NOT
    // recur here.
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const editMsgConfirmed = conv().messages.find((m) => m.id === editMessageId);
    expect(editMsgConfirmed?.agentCardState).toBe('confirmed');
  });

  it('sanity check: WITHOUT any interleaving, a typed confirm on a Sidebar edit session correctly calls updateAgent, never createAgent', async () => {
    const { result } = setup();
    const existingAgent = baseAgent();
    useAgentStore.getState().addAgent(existingAgent);

    // Deliberately does NOT set editingAgentId on the message itself (unlike
    // the fixed Scenario 6 test above) — this exercises confirmAgentDraft's
    // fallback branch (originatingMessage?.editingAgentId ?? session-derived
    // value), covering a message/session pair that predates the bug #157
    // message-level field, e.g. state persisted before an app update.
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

// ─── Scenario 7: task-clarity LLM fallback autostart preflight ────────────
//
// 2026-07-27 on-device finding: "@agent 手伝って" (an utterance with neither a
// confident schedule NOR an explicit action — isLowConfidenceAgentDraft
// should be true) skipped straight to "いつ実行しますか？" instead of ever
// asking what the task actually is. Root cause: the two
// extractAgentFieldsWithLlm call sites in hooks/use-ai-pane-dispatch.ts never
// called ensureLocalLlmServerRunning before firing the extraction request —
// unlike the agent==='local' chat-streaming path, which always does. If
// llama-server wasn't already running, the extraction request fails closed
// silently (by design — see extractAgentFieldsWithLlm's own doc comment) and
// the flow falls through to the ordinary schedule slot-fill question,
// indistinguishable from "the LLM judged the task as clear" from the user's
// perspective. First fix gated the new preflight on `localLlmEnabled` — a
// SECOND on-device repro then showed that field is not a user preference, it
// is overwritten every 120s by hooks/use-tool-discovery.ts's live
// availability poll, so it reads false for up to two minutes after the
// server merely idles out — precisely when this preflight is needed most.
// Re-gated on `localLlmUrl` being configured instead (matching the exact
// check ensureLocalLlmServerRunningOnce already does internally).
describe('Scenario 7 — task-clarity LLM fallback calls ensureLocalLlmServerRunning before extraction (2026-07-27 on-device finding)', () => {
  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        localLlmEnabled: true,
        localLlmUrl: 'http://127.0.0.1:8080',
        localLlmModel: 'qwen3.5-2b',
      },
    }));
  });

  it('calls ensureLocalLlmServerRunning before ollamaChat, and a taskClear:false response asks the clarifying question BEFORE the schedule question', async () => {
    mockEnsureLocalLlmServerRunning.mockClear();
    mockOllamaChat.mockClear();
    const callOrder: string[] = [];
    mockEnsureLocalLlmServerRunning.mockImplementation(async () => {
      callOrder.push('ensureLocalLlmServerRunning');
      return { ok: true, status: 'ready' };
    });
    mockOllamaChat.mockImplementation(async () => {
      callOrder.push('ollamaChat');
      return {
        success: true,
        content: JSON.stringify({
          name: '',
          scheduleText: '',
          actionType: 'draft',
          outputPath: '',
          prompt: '',
          taskClear: false,
          clarifyingQuestion: '何を手伝ってほしいか、具体的に教えてください',
        }),
      };
    });

    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 手伝って');
    });

    // The autostart preflight ran, and ran BEFORE the extraction call.
    expect(mockEnsureLocalLlmServerRunning).toHaveBeenCalled();
    expect(mockEnsureLocalLlmServerRunning.mock.calls[0][0]).toEqual(
      expect.objectContaining({ waitForReady: true, reason: 'agent-llm-fallback-initial' }),
    );
    expect(callOrder).toEqual(['ensureLocalLlmServerRunning', 'ollamaChat']);

    // The clarifying question — NOT "いつ実行しますか？" — is what the user sees.
    const question = lastMessage();
    expect(question.role).toBe('assistant');
    expect(question.pendingSlotFill?.field).toBe('taskDetail');
    expect(question.content).toBe('何を手伝ってほしいか、具体的に教えてください');
    expect(question.content).not.toBe(ja['slot_fill.question_schedule']);
  });

  it('still calls ensureLocalLlmServerRunning even when localLlmEnabled has lapsed false from the availability poll (2026-07-27 follow-up finding)', async () => {
    // localLlmEnabled=false here on purpose, WITH localLlmUrl still set — the
    // exact on-device state that broke the first fix: the 120s poll had
    // marked local LLM unavailable, but the URL/model are still configured.
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, localLlmEnabled: false } }));
    mockEnsureLocalLlmServerRunning.mockClear();
    mockOllamaChat.mockClear();
    mockOllamaChat.mockImplementation(async () => ({
      success: true,
      content: JSON.stringify({
        name: '',
        scheduleText: '',
        actionType: 'draft',
        outputPath: '',
        prompt: '',
        taskClear: false,
        clarifyingQuestion: '何を手伝ってほしいか、具体的に教えてください',
      }),
    }));

    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 手伝って');
    });

    expect(mockEnsureLocalLlmServerRunning).toHaveBeenCalled();
    expect(mockOllamaChat).toHaveBeenCalled();
    const question = lastMessage();
    expect(question.pendingSlotFill?.field).toBe('taskDetail');
  });

  it('does not call ensureLocalLlmServerRunning when local LLM has never been configured (no URL at all)', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, localLlmEnabled: false, localLlmUrl: '' } }));
    mockEnsureLocalLlmServerRunning.mockClear();
    mockOllamaChat.mockClear();

    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 手伝って');
    });

    expect(mockEnsureLocalLlmServerRunning).not.toHaveBeenCalled();
    expect(mockOllamaChat).not.toHaveBeenCalled();
    // Falls through to the ordinary schedule question, exactly as before.
    const question = lastMessage();
    expect(question.pendingSlotFill?.field).toBe('schedule');
  });
});

// ─── Scenario 8: confirmAgentDraft re-entrancy dedupe (bug #164 follow-up) ──
//
// 2026-07-28 on-device re-repro (versionCode 1987, DEFERRED.md bug #164):
// AgentConfirmCard's Confirm button has no "submitting…"/disabled state, and
// message.agentCardState only flips away from 'pending' (which is what
// unmounts the card — components/panes/AIPane.tsx) once confirmAgentDraft's
// WHOLE async chain (persistAgentDraft → installAgent → …) resolves. A slow
// or hung installAgent therefore leaves the card fully visible and tappable
// for the entire stall, and a user who sees no feedback naturally taps
// Confirm again — each tap calling confirmAgentDraft fresh, and (since
// editingAgentId is undefined for a new registration) each one independently
// creating a BRAND NEW duplicate agent. On-device this produced four separate
// materialize (`mkdir -p .../agents`) NativeExec bursts for what the user
// experienced as one registration attempt. hooks/use-ai-pane-dispatch.ts's
// confirmAgentDraft now dedupes concurrent calls for the same messageId via
// the module-level inFlightConfirmDrafts map — mirrors lib/agent-manager.ts's
// runAgentNow/inFlightAgentRuns guard for the identical double-tap class of
// bug (see __tests__/agent-manager-inflight-dedupe.test.ts).
describe('Scenario 8 — confirmAgentDraft re-entrancy dedupe (bug #164 follow-up)', () => {
  it('a second confirm for the same pending draft while installAgent is still in flight joins the first instead of creating a duplicate agent', async () => {
    const { result } = setup();

    // Reach a pending chat-native confirmation the same way Scenario 4 does.
    await act(async () => {
      await result.current.dispatch('@agent 天気を通知して');
    });
    await act(async () => {
      await result.current.dispatch('毎日7時');
    });
    const pending = conv().pendingAgentSession;
    expect(pending).toBeTruthy();
    const messageId = pending!.messageId;
    const confirmed = draftToConfirmedAgentDraft(pending!.draft);

    // Hold installAgent open (the exact stall shape observed on-device — see
    // lib/agent-manager.ts's materializeAgentBody/installSchedule diagnostics
    // added alongside this test) so a second confirm call provably starts
    // while the first is still in flight, before either resolves.
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    mockInstallAgent.mockImplementation(async () => {
      await installGate;
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.confirmAgentDraft(messageId, confirmed);
      // Let the first call's microtasks run far enough to reach (and start
      // awaiting) installAgent before firing the second — mirrors a real
      // repeated tap landing while the card is still visibly 'pending'.
      await Promise.resolve();
      await Promise.resolve();
      second = result.current.confirmAgentDraft(messageId, confirmed);
    });

    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockInstallAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseInstall();
      await Promise.all([first, second]);
    });

    // Still exactly one agent created/installed — the second call joined the
    // first instead of running persistAgentDraft/installAgent a second time.
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockInstallAgent).toHaveBeenCalledTimes(1);
    const msgAfter = conv().messages.find((m) => m.id === messageId);
    expect(msgAfter?.agentCardState).toBe('confirmed');
  });
});

// ─── Scenario 8: the shared ("every agent") memory write entry point ───────
//
// Roadmap item 3 part 2 (2026-07-29). Before this, writeGlobalMemoryNote had
// no production caller at all — a `_global` note could only be created by
// hand-writing the file on-device. These drive the real dispatch() and assert
// the whole confidence bar end-to-end: detection, the MANDATORY confirm turn,
// the commit going through writeGlobalMemoryNote (never a raw write), and —
// most important — that ambiguous input writes NOTHING.

describe('Scenario 8 — "remember this for every agent" write entry point', () => {
  it('asks for confirmation first and writes nothing until an explicit confirm', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@agent 全エージェント共通で、返信は日本語でということを覚えておいて');
    });

    // Nothing written yet — this is the whole point of the confirm gate.
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    // …and it must NOT have been misread as an agent-creation request.
    expect(mockCreateAgent).not.toHaveBeenCalled();
    expect(conv().pendingAgentSession).toBeFalsy();

    const question = lastMessage();
    expect(question.role).toBe('assistant');
    expect(question.pendingGlobalMemory?.text).toContain('日本語');
    expect(question.pendingGlobalMemory?.attempts).toBe(0);
    expect(question.content).toContain(
      ja['globalmemory.confirm_prompt'].split('{{text}}')[0],
    );

    // Turn 2: an exact confirm phrase commits the write — and it goes through
    // writeGlobalMemoryNote (the re-baking wrapper), with the scope-stripped
    // text and the fixed 'preference' type.
    await act(async () => {
      await result.current.dispatch('はい');
    });

    expect(mockWriteGlobalMemoryNote).toHaveBeenCalledTimes(1);
    const [, params] = mockWriteGlobalMemoryNote.mock.calls[0] as unknown as [
      unknown,
      { type: string; text: string },
    ];
    expect(params.type).toBe('preference');
    expect(params.text).toBe(question.pendingGlobalMemory!.text);
    expect(params.text).not.toContain('エージェント'); // scope clause stripped
    expect(lastMessage().content).toContain(ja['globalmemory.saved'].split('{{text}}')[0]);
    // The pending marker is cleared, so a later stray "OK" cannot re-fire it.
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);
  });

  it('the EN phrasing works the same way and reports in EN', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.dispatch('@agent remember for all agents that I prefer metric units');
    });
    expect(lastMessage().pendingGlobalMemory?.text).toBe('I prefer metric units');
    expect(lastMessage().content).toContain(en['globalmemory.confirm_prompt'].split('{{text}}')[0]);

    await act(async () => {
      await result.current.dispatch('OK');
    });
    expect(mockWriteGlobalMemoryNote).toHaveBeenCalledTimes(1);
  });

  it('a cancel reply discards it and writes nothing', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 全エージェントで、単位はメートル法を使うことを覚えておいて');
    });
    await act(async () => {
      await result.current.dispatch('キャンセル');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(lastMessage().content).toBe(ja['globalmemory.cancelled']);
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);
  });

  it('an unclear reply re-asks once, then discards — it never writes', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 全エージェントで、単位はメートル法を使うことを覚えておいて');
    });

    await act(async () => {
      await result.current.dispatch('うーん、どうかな');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(lastMessage().pendingGlobalMemory?.attempts).toBe(1);

    await act(async () => {
      await result.current.dispatch('やっぱりよくわからない');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(lastMessage().content).toBe(ja['globalmemory.discarded_unclear']);
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);
  });

  // ── The important negatives: ambiguous / low-confidence input must never
  // reach the global write path at all. A wrong `_global` note pollutes EVERY
  // agent's prompt on every future run.
  it('an ordinary per-agent "覚えておいて" never triggers a global write', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 毎朝8時にニュースをまとめて、要点を覚えておいて');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(lastMessage().pendingGlobalMemory).toBeUndefined();
    // It stayed on the ordinary agent-creation flow instead.
    expect(
      conv().pendingAgentSession !== null || conv().messages.some((m) => m.agentDraft || m.pendingSlotFill),
    ).toBe(true);
  });

  it('an all-agents command with no memory marker never triggers a global write', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 全エージェントの状態を毎朝9時に教えて');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);
  });

  it('a scoped request with no actual payload never triggers a global write', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent これは全エージェントで覚えておいて');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);
  });

  it('a confirm phrase with no pending shared-memory question writes nothing', async () => {
    const { result } = setup();
    // Routed as an ordinary @agent utterance — there is no pending shared-memory
    // question anywhere, so nothing may reach the global write path.
    await act(async () => {
      await result.current.dispatch('@agent はい');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);
  });

  it('a fresh "@…" command drops the pending question instead of leaving it armed', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.dispatch('@agent 全エージェントで、単位はメートル法を使うことを覚えておいて');
    });
    await act(async () => {
      await result.current.dispatch('@agent 毎朝8時にニュースを通知して');
    });
    expect(conv().messages.some((m) => m.pendingGlobalMemory)).toBe(false);

    // A later "OK" now belongs to whatever the fresh command asked for — it
    // must never retro-commit the abandoned shared note.
    await act(async () => {
      await result.current.dispatch('はい');
    });
    expect(mockWriteGlobalMemoryNote).not.toHaveBeenCalled();
  });
});
