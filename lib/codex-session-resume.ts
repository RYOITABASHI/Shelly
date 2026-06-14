import { PRESET_CAPACITY, useMultiPaneStore, type Slot, type SlotIndex } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useFocusStore } from '@/store/focus-store';
import { useAgentChatStore, type AgentChatSession } from '@/store/agent-chat-store';
import type { TabSession } from '@/store/types';
import { createTerminalSessionForFocusedPane } from '@/lib/terminal-session-actions';
import { detectCodexActiveTranscript, detectCodexLaunchFailureText, detectShellReadyText } from '@/lib/codex-pty-detection';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

type AddTerminalPane = (
  tab: 'terminal',
  opts?: { silent?: boolean },
) => null | 'terminal_cap' | 'layout_full';

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const CTRL_U = '\u0015';
const CODEX_LAUNCH_COMMAND = 'clear && codex';

export type CodexSessionResumeResult =
  | { status: 'focused'; sessionId: string }
  | { status: 'queued'; sessionId: string }
  | { status: 'failed'; reason: CodexSessionResumeFailureReason };

export type CodexSessionInterruptResult =
  | { status: 'sent'; sessionId: string }
  | { status: 'failed'; reason: CodexSessionResumeFailureReason };

export type CodexSessionResumeFailureReason =
  | 'terminal_busy'
  | 'terminal_cap'
  | 'layout_full'
  | 'no_terminal';

export type CodexVisibleTerminalBindResult = {
  terminalSessionId: string;
  nativeSessionId: string;
  session: AgentChatSession;
};

export async function resumeCodexSession(
  session: AgentChatSession,
  options: { addTerminalPane: AddTerminalPane },
): Promise<CodexSessionResumeResult> {
  const boundSessionId = await findBoundTerminalSessionId(session);
  if (boundSessionId && focusTerminalSession(boundSessionId)) {
    return { status: 'focused', sessionId: boundSessionId };
  }

  const visibleCodexBind = await bindVisibleCodexTerminalToSession(session, { focus: true });
  if (visibleCodexBind) {
    return { status: 'focused', sessionId: visibleCodexBind.terminalSessionId };
  }

  let targetSessionId: string | undefined;
  let failureReason: CodexSessionResumeFailureReason = 'no_terminal';
  const hasTerminalPane = visibleSlotEntries().some(({ slot }) => slot.tab === 'terminal');

  targetSessionId = await pickFallbackTerminalSessionId();

  if (!targetSessionId && hasTerminalPane) {
    targetSessionId = createTerminalSessionForFocusedPane();
    if (!targetSessionId) failureReason = 'terminal_cap';
  } else if (!targetSessionId) {
    const beforeIds = new Set(useTerminalStore.getState().sessions.map((terminalSession) => terminalSession.id));
    const addResult = options.addTerminalPane('terminal', { silent: true });
    if (addResult) {
      failureReason = addResult;
    } else {
      targetSessionId = findNewTerminalSessionId(beforeIds);
    }
  }

  if (!targetSessionId) {
    return {
      status: 'failed',
      reason: reasonForMissingResumeTarget(failureReason),
    };
  }

  const cwd = session.cwd?.trim();
  const resumeCommand = `codex resume ${shellQuote(codexResumeSessionId(session.codexSessionId))}`;
  const command = cwd
    ? `cd ${shellQuote(cwd)} && clear && ${resumeCommand}`
    : `clear && ${resumeCommand}`;
  const commandWithEnter = `${command}\r`;
  focusTerminalSession(targetSessionId);
  const wroteDirectly = await writeResumeCommandToTerminal(targetSessionId, command);
  if (!wroteDirectly) {
    useTerminalStore.getState().insertCommand(commandWithEnter, targetSessionId, { durable: true });
  }
  return { status: 'queued', sessionId: targetSessionId };
}

// Cold start: launch a brand-new `codex` (NOT `codex resume`) in a terminal
// pane. Used when a widget prompt arrives but there is no resumable Codex
// session to fall back on (fresh install / Codex never run). Mirrors the
// terminal-acquisition logic of resumeCodexSession but runs bare `codex`.
export async function startFreshCodexSession(
  options: { addTerminalPane: AddTerminalPane; cwd?: string | null; preferNewTerminal?: boolean },
): Promise<CodexSessionResumeResult> {
  let targetSessionId: string | undefined;
  let failureReason: CodexSessionResumeFailureReason = 'no_terminal';
  const hasTerminalPane = visibleSlotEntries().some(({ slot }) => slot.tab === 'terminal');

  if (options.preferNewTerminal && hasTerminalPane) {
    targetSessionId = createTerminalSessionForFocusedPane();
    if (!targetSessionId) failureReason = 'terminal_cap';
  }

  if (!targetSessionId) {
    targetSessionId = await pickFallbackTerminalSessionId();
  }

  if (!targetSessionId && hasTerminalPane) {
    targetSessionId = createTerminalSessionForFocusedPane();
    if (!targetSessionId) failureReason = 'terminal_cap';
  } else if (!targetSessionId) {
    const beforeIds = new Set(useTerminalStore.getState().sessions.map((s) => s.id));
    const addResult = options.addTerminalPane('terminal', { silent: true });
    if (addResult) {
      failureReason = addResult;
    } else {
      targetSessionId = findNewTerminalSessionId(beforeIds);
    }
  }

  if (!targetSessionId) {
    return { status: 'failed', reason: reasonForMissingResumeTarget(failureReason) };
  }

  const cwd = options.cwd?.trim();
  const launchCommand = cwd ? `cd ${shellQuote(cwd)} && ${CODEX_LAUNCH_COMMAND}` : CODEX_LAUNCH_COMMAND;
  focusTerminalSession(targetSessionId);
  const wroteDirectly = await writeResumeCommandToTerminal(targetSessionId, launchCommand);
  if (!wroteDirectly) {
    useTerminalStore.getState().insertCommand(`${launchCommand}\r`, targetSessionId, { durable: true });
  }
  return { status: 'queued', sessionId: targetSessionId };
}

// Full cold-start delivery for a queued widget prompt: spawn a fresh `codex`,
// wait for it to boot into an active transcript, then write the queued prompt
// directly to its PTY. Deliberately bypasses the codexSessionId/binding reply
// machinery — a freshly launched codex has no known session id yet, and the
// pending widget prompt is recorded with no session ids so it consume-matches
// any terminal (ScouterStateStore.pendingTargetMatches). Returns true if the
// cold start was attempted (success OR a reported failure), false if there was
// nothing to do / no terminal could be created.
export async function coldStartCodexAndDeliverWidgetPrompt(
  options: { addTerminalPane: AddTerminalPane; bootTimeoutMs?: number },
): Promise<boolean> {
  if (!TerminalEmulator.consumeScouterWidgetPendingPrompt) return false;
  const pendingTarget = TerminalEmulator.getScouterWidgetPendingPromptTarget
    ? await TerminalEmulator.getScouterWidgetPendingPromptTarget().catch(() => null)
    : null;
  if (!pendingTarget) return false;

  const result = await startFreshCodexSession({
    addTerminalPane: options.addTerminalPane,
    cwd: null,
    preferNewTerminal: true,
  })
    .catch(() => null);
  if (!result || result.status === 'failed') {
    await TerminalEmulator.markScouterWidgetPromptFailed?.(
      `Could not start Codex terminal${result?.status === 'failed' ? `: ${result.reason}` : ''}`,
    ).catch(() => undefined);
    return true;
  }

  const terminalSession = await waitForAliveTerminalSession(result.sessionId, 20_000);
  const nativeSessionId = terminalSession?.nativeSessionId;
  if (!nativeSessionId) {
    await TerminalEmulator.markScouterWidgetPromptFailed?.('Terminal did not start in time').catch(() => undefined);
    return true;
  }

  // Wait for `codex` to paint an active transcript (input-ready). Cold boot
  // after a fresh app update can be slow, so allow a generous window — still
  // under the native 2-minute pending-prompt expiry.
  const deadline = Date.now() + (options.bootTimeoutMs ?? 60_000);
  let launchAttempts = 0;
  let lastLaunchAttemptAt = 0;
  let ready = false;
  while (Date.now() < deadline) {
    const screen = await TerminalEmulator.getScreenText(nativeSessionId).catch(() => null);
    if (typeof screen === 'string') {
      if (detectCodexLaunchFailureText(screen)) break;
      if (detectCodexActiveTranscript(screen)) { ready = true; break; }
      if (detectShellReadyText(screen)) {
        const now = Date.now();
        if (launchAttempts < 4 && now - lastLaunchAttemptAt >= 2500) {
          launchAttempts += 1;
          lastLaunchAttemptAt = now;
          const wrote = await writeCommandToNativeSession(nativeSessionId, CODEX_LAUNCH_COMMAND);
          if (wrote) {
            clearPendingCodexLaunchCommandForSession(result.sessionId);
          } else {
            useTerminalStore.getState().insertCommand(`${CODEX_LAUNCH_COMMAND}\r`, result.sessionId, {
              durable: true,
              ttlMs: 2 * 60 * 1000,
            });
          }
        }
      }
    }
    await sleep(800);
  }
  if (!ready) {
    await TerminalEmulator.markScouterWidgetPromptFailed?.('Codex did not start in time').catch(() => undefined);
    return true;
  }

  // Settle: detectCodexActiveTranscript can fire on the welcome banner a beat
  // before codex's input box actually accepts text. Wait once more and
  // re-confirm the screen is still an active, non-failed transcript before
  // pasting, so the prompt is not written into a not-yet-ready input.
  await sleep(1200);
  const settledScreen = await TerminalEmulator.getScreenText(nativeSessionId).catch(() => null);
  if (typeof settledScreen === 'string' && detectCodexLaunchFailureText(settledScreen)) {
    await TerminalEmulator.markScouterWidgetPromptFailed?.('Codex failed to start').catch(() => undefined);
    return true;
  }

  // Consume using the pending prompt's OWN recorded ids so it always matches
  // itself — this handles a stale post-update binding that recorded old session
  // ids, not just the all-null fresh-install case (ScouterStateStore.
  // pendingTargetMatches needs the consume args to equal the stored ids). The
  // prompt is then written to the freshly started codex regardless of those ids.
  const pending = await TerminalEmulator.consumeScouterWidgetPendingPrompt(
    pendingTarget.codexSessionId ?? null,
    pendingTarget.ptySessionId ?? null,
    pendingTarget.shellySessionId ?? null,
  ).catch(() => null);
  if (!pending?.prompt?.trim()) {
    await TerminalEmulator.markScouterWidgetPromptFailed?.('Widget prompt unavailable after Codex start').catch(() => undefined);
    return true;
  }
  try {
    await TerminalEmulator.writeToSession(nativeSessionId, '');
    await TerminalEmulator.pasteToSession(nativeSessionId, pending.prompt);
    await TerminalEmulator.writeToSession(nativeSessionId, '\r');
    await TerminalEmulator.markScouterWidgetPromptQueued?.(pending.prompt).catch(() => undefined);
    await useAgentChatStore.getState().refresh().catch(() => undefined);
    return true;
  } catch {
    await TerminalEmulator.markScouterWidgetPromptFailed?.('Could not write the prompt to Codex').catch(() => undefined);
    return true;
  }
}

async function waitForAliveTerminalSession(
  sessionId: string,
  timeoutMs: number,
): Promise<TabSession | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = useTerminalStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    if (session?.nativeSessionId && session.sessionStatus === 'alive' && session.isAlive) {
      return session;
    }
    await sleep(250);
  }
  return useTerminalStore.getState().sessions.find((candidate) =>
    candidate.id === sessionId &&
    Boolean(candidate.nativeSessionId) &&
    candidate.sessionStatus === 'alive' &&
    candidate.isAlive
  );
}

function clearPendingCodexLaunchCommandForSession(sessionId: string): void {
  const pending = useTerminalStore.getState().pendingCommand;
  if (!pending || typeof pending === 'string') return;
  if (pending.sessionId !== sessionId) return;
  if (!/\bcodex\b/.test(pending.command)) return;
  useTerminalStore.getState().clearPendingCommand(pending.id);
}

export async function bindVisibleCodexTerminalToSession(
  session: AgentChatSession | null | undefined,
  options: { focus?: boolean } = {},
): Promise<CodexVisibleTerminalBindResult | null> {
  if (!session) return null;
  const terminalSession = await findVisibleCodexTerminalSession();
  if (!terminalSession) return null;

  const now = Date.now();
  useAgentChatStore.getState().bindCodexSessionToPty(session.codexSessionId, {
    ptySessionId: terminalSession.nativeSessionId,
    shellySessionId: terminalSession.id,
    cwd: session.cwd ?? terminalSession.currentDir,
    startedAt: session.sessionStartAt ?? now,
    lastSeenAt: now,
  });
  if (options.focus) {
    focusTerminalSession(terminalSession.id);
  }

  return {
    terminalSessionId: terminalSession.id,
    nativeSessionId: terminalSession.nativeSessionId,
    session: {
      ...session,
      ptySessionId: terminalSession.nativeSessionId,
      shellySessionId: terminalSession.id,
      cwd: session.cwd ?? terminalSession.currentDir,
      bindingConfidence: 'reliable',
    },
  };
}

async function findVisibleCodexTerminalSession(): Promise<TabSession | undefined> {
  const terminalSessions = useTerminalStore.getState().sessions;
  if (terminalSessions.length === 0) return undefined;

  const candidates: TabSession[] = [];
  const seen = new Set<string>();
  const addCandidate = (sessionId: string | null | undefined) => {
    if (!sessionId || seen.has(sessionId)) return;
    const session = terminalSessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    seen.add(session.id);
    candidates.push(session);
  };

  const multiPane = useMultiPaneStore.getState();
  const focusedSlot = multiPane.slots[multiPane.focusedSlot];
  if (focusedSlot?.tab === 'terminal') {
    addCandidate(focusedSlot.sessionId);
  }
  for (const { slot } of visibleSlotEntries()) {
    if (slot.tab === 'terminal') {
      addCandidate(slot.sessionId);
    }
  }
  addCandidate(useTerminalStore.getState().activeSessionId);

  for (const candidate of candidates) {
    if (await isLiveCodexTerminalSession(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findNewTerminalSessionId(beforeIds: Set<string>): string | undefined {
  const terminalState = useTerminalStore.getState();
  const created = terminalState.sessions.find((session) => !beforeIds.has(session.id));
  if (created) return created.id;
  return beforeIds.has(terminalState.activeSessionId) ? undefined : terminalState.activeSessionId;
}

function reasonForMissingResumeTarget(
  reason: CodexSessionResumeFailureReason,
): CodexSessionResumeFailureReason {
  if (reason !== 'no_terminal') return reason;
  return useTerminalStore.getState().sessions.length > 0 ? 'terminal_busy' : 'no_terminal';
}

async function findBoundTerminalSessionId(session: AgentChatSession): Promise<string | undefined> {
  if (session.bindingConfidence !== 'reliable') return undefined;
  const terminalSessions = useTerminalStore.getState().sessions;
  const shellySessionId = session.shellySessionId?.trim();
  if (shellySessionId) {
    const terminalSession = terminalSessions.find((candidate) => candidate.id === shellySessionId);
    if (terminalSession && await isLiveCodexTerminalSession(terminalSession)) {
      return shellySessionId;
    }
  }
  const ptySessionId = session.ptySessionId?.trim();
  if (!ptySessionId) return undefined;
  for (const terminalSession of terminalSessions) {
    if (terminalSession.nativeSessionId === ptySessionId && await isLiveCodexTerminalSession(terminalSession)) {
      return terminalSession.id;
    }
  }
  return undefined;
}

async function pickFallbackTerminalSessionId(): Promise<string | undefined> {
  const terminalSessions = useTerminalStore.getState().sessions;
  if (terminalSessions.length === 0) return undefined;

  const multiPane = useMultiPaneStore.getState();
  const focusedSlot = multiPane.slots[multiPane.focusedSlot];
  const focusedSessionId = focusedSlot?.tab === 'terminal' ? focusedSlot.sessionId : undefined;
  const focusedSession = terminalSessions.find((session) => session.id === focusedSessionId);
  if (
    focusedSession
    && isVisibleSlotIndex(multiPane.focusedSlot)
    && await isResumeQueueSafeTerminalSession(focusedSession)
    && focusTerminalSession(focusedSession.id)
  ) {
    return focusedSession.id;
  }

  for (const { slot } of visibleSlotEntries()) {
    if (slot.tab !== 'terminal' || !slot.sessionId) continue;
    const session = terminalSessions.find((terminalSession) => terminalSession.id === slot.sessionId);
    if (session && await isResumeQueueSafeTerminalSession(session) && focusTerminalSession(session.id)) {
      return session.id;
    }
  }

  const activeSession = terminalSessions.find((session) => session.id === useTerminalStore.getState().activeSessionId);
  if (
    activeSession
    && terminalSessionHasAnySlot(activeSession.id)
    && await isResumeQueueSafeTerminalSession(activeSession)
    && focusTerminalSession(activeSession.id)
  ) {
    return activeSession.id;
  }

  return undefined;
}

function terminalSessionHasAnySlot(sessionId: string): boolean {
  return useMultiPaneStore.getState().slots.some((slot) => slot?.tab === 'terminal' && slot.sessionId === sessionId);
}

export function focusTerminalSession(sessionId: string): boolean {
  const terminalState = useTerminalStore.getState();
  if (!terminalState.sessions.some((session) => session.id === sessionId)) return false;

  let multiPane = useMultiPaneStore.getState();
  let slotIndex = visibleSlotEntries()
    .find(({ slot }) => slot.tab === 'terminal' && slot.sessionId === sessionId)
    ?.index ?? -1;

  if (slotIndex < 0) {
    slotIndex = visibleSlotEntries().find(({ slot }) => slot.tab === 'terminal')?.index ?? -1;
    const slot = slotIndex >= 0 ? multiPane.slots[slotIndex] : null;
    if (slot) {
      multiPane.setSlotSessionId(slot.id, sessionId);
    } else {
      slotIndex = isVisibleSlotIndex(multiPane.focusedSlot) && multiPane.slots[multiPane.focusedSlot]
        ? multiPane.focusedSlot
        : visibleSlotEntries()[0]?.index ?? -1;
      const targetSlot = slotIndex >= 0 ? multiPane.slots[slotIndex] : null;
      if (!targetSlot) return false;
      multiPane.setSlotTab(slotIndex as 0 | 1 | 2 | 3, 'terminal');
      multiPane.setSlotSessionId(targetSlot.id, sessionId);
    }
    multiPane = useMultiPaneStore.getState();
  }

  const targetSlot = slotIndex >= 0 ? useMultiPaneStore.getState().slots[slotIndex] : null;
  if (targetSlot) {
    useMultiPaneStore.getState().focusSlot(slotIndex as 0 | 1 | 2 | 3);
    usePaneStore.getState().setFocusedPane(targetSlot.id);
  }
  useTerminalStore.getState().setActiveSession(sessionId);
  refocusTerminal();
  return true;
}

function refocusTerminal(): void {
  setTimeout(() => useFocusStore.getState().requestTerminalRefocus(), 80);
  setTimeout(() => useFocusStore.getState().requestTerminalRefocus(), 240);
  setTimeout(() => useFocusStore.getState().requestTerminalRefocus(), 600);
}

function visibleSlotEntries(): Array<{ index: SlotIndex; slot: NonNullable<Slot> }> {
  const multiPane = useMultiPaneStore.getState();
  if (multiPane.maximizedSlot !== null) {
    const slot = multiPane.slots[multiPane.maximizedSlot];
    return slot ? [{ index: multiPane.maximizedSlot, slot }] : [];
  }
  const capacity = PRESET_CAPACITY[multiPane.preset] ?? 1;
  const entries: Array<{ index: SlotIndex; slot: NonNullable<Slot> }> = [];
  for (let index = 0; index < Math.min(capacity, multiPane.slots.length); index += 1) {
    const slot = multiPane.slots[index];
    if (slot) entries.push({ index: index as SlotIndex, slot });
  }
  return entries;
}

function isVisibleSlotIndex(index: number): boolean {
  const multiPane = useMultiPaneStore.getState();
  if (multiPane.maximizedSlot !== null) {
    return index === multiPane.maximizedSlot && Boolean(multiPane.slots[index]);
  }
  const capacity = PRESET_CAPACITY[multiPane.preset] ?? 1;
  return index >= 0 && index < capacity && Boolean(multiPane.slots[index]);
}

async function isLiveCodexTerminalSession(session: TabSession): Promise<boolean> {
  if (session.sessionStatus === 'exited') return false;
  if (!await isNativeSessionAlive(session)) return false;
  const screenText = await readTerminalScreen(session);
  if (screenText !== null) {
    if (detectCodexLaunchFailureText(screenText)) return false;
    if (detectCodexActiveTranscript(screenText)) return true;
    return session.activeCli === 'codex' && !detectShellReadyText(screenText);
  }
  return session.activeCli === 'codex';
}

async function isResumeQueueSafeTerminalSession(session: TabSession): Promise<boolean> {
  if (session.sessionStatus === 'exited') return false;
  if (session.blocks.some((block) => block.isRunning)) return false;
  if (!await isNativeSessionAlive(session)) return false;
  if (session.activeCli && session.activeCli !== 'codex') return false;
  const screenText = await readTerminalScreen(session);
  if (screenText !== null) {
    if (detectCodexLaunchFailureText(screenText)) return false;
    return !detectCodexActiveTranscript(screenText) && detectShellReadyText(screenText);
  }
  return false;
}

async function isNativeSessionAlive(session: TabSession): Promise<boolean> {
  const alive = await TerminalEmulator.isSessionAlive(session.nativeSessionId).catch(() => session.isAlive);
  if (!alive) {
    markTerminalSessionExited(session.id);
  }
  return alive;
}

async function writeResumeCommandToTerminal(sessionId: string, command: string): Promise<boolean> {
  const session = useTerminalStore.getState().sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return false;
  if (session.sessionStatus !== 'alive' || !session.isAlive) return false;
  if (!await isNativeSessionAlive(session)) return false;
  return writeCommandToNativeSession(session.nativeSessionId, command);
}

async function writeCommandToNativeSession(nativeSessionId: string, command: string): Promise<boolean> {
  try {
    await TerminalEmulator.writeToSession(nativeSessionId, CTRL_U);
    await TerminalEmulator.pasteToSession(nativeSessionId, command);
    await TerminalEmulator.writeToSession(nativeSessionId, '\r');
    return true;
  } catch {
    try {
      await TerminalEmulator.writeToSession(nativeSessionId, `${CTRL_U}${command}\r`);
      return true;
    } catch {
      return false;
    }
  }
}

export async function sendTerminalInterruptToCodexSession(
  session: AgentChatSession | null | undefined,
): Promise<CodexSessionInterruptResult> {
  if (!session) return { status: 'failed', reason: 'no_terminal' };
  const terminalSession = await findPreciselyBoundCodexTerminalSession(session);
  if (!terminalSession || !focusTerminalSession(terminalSession.id)) {
    return { status: 'failed', reason: 'terminal_busy' };
  }
  try {
    await TerminalEmulator.interruptSession(terminalSession.nativeSessionId);
    return { status: 'sent', sessionId: terminalSession.id };
  } catch {
    return { status: 'failed', reason: 'terminal_busy' };
  }
}

async function findPreciselyBoundCodexTerminalSession(session: AgentChatSession): Promise<TabSession | undefined> {
  if (session.bindingConfidence !== 'reliable') return undefined;
  const terminalSessions = useTerminalStore.getState().sessions;
  const ptySessionId = session.ptySessionId?.trim();
  if (ptySessionId) {
    const terminalSession = terminalSessions.find((candidate) => candidate.nativeSessionId === ptySessionId);
    return terminalSession && await isLiveCodexTerminalSession(terminalSession) ? terminalSession : undefined;
  }

  const shellySessionId = session.shellySessionId?.trim();
  if (!shellySessionId) return undefined;
  const terminalSession = terminalSessions.find((candidate) => candidate.id === shellySessionId);
  return terminalSession && await isLiveCodexTerminalSession(terminalSession) ? terminalSession : undefined;
}

async function readTerminalScreen(session: TabSession): Promise<string | null> {
  const screenText = await TerminalEmulator.getScreenText(session.nativeSessionId).catch(() => null);
  return typeof screenText === 'string' ? screenText : null;
}

function markTerminalSessionExited(sessionId: string): void {
  useTerminalStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            activeCli: null,
            sessionStatus: 'exited' as const,
            isAlive: false,
          }
        : session
    ),
  }));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function codexResumeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(trimmed)?.[1]
    ?? trimmed;
}
