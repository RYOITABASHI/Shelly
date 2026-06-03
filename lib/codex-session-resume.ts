import { PRESET_CAPACITY, useMultiPaneStore, type Slot, type SlotIndex } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useFocusStore } from '@/store/focus-store';
import type { AgentChatSession } from '@/store/agent-chat-store';
import type { TabSession } from '@/store/types';
import { createTerminalSessionForFocusedPane } from '@/lib/terminal-session-actions';
import { detectCodexActiveTranscript, detectShellReadyText } from '@/lib/codex-pty-detection';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

type AddTerminalPane = (
  tab: 'terminal',
  opts?: { silent?: boolean },
) => null | 'terminal_cap' | 'layout_full';

export type CodexSessionResumeResult =
  | { status: 'focused'; sessionId: string }
  | { status: 'queued'; sessionId: string }
  | { status: 'failed'; reason: CodexSessionResumeFailureReason };

export type CodexSessionResumeFailureReason =
  | 'terminal_busy'
  | 'terminal_cap'
  | 'layout_full'
  | 'no_terminal';

export async function resumeCodexSession(
  session: AgentChatSession,
  options: { addTerminalPane: AddTerminalPane },
): Promise<CodexSessionResumeResult> {
  const boundSessionId = await findBoundTerminalSessionId(session);
  if (boundSessionId && focusTerminalSession(boundSessionId)) {
    return { status: 'focused', sessionId: boundSessionId };
  }

  let targetSessionId: string | undefined;
  let failureReason: CodexSessionResumeFailureReason = 'no_terminal';
  const hasTerminalPane = visibleSlotEntries().some(({ slot }) => slot.tab === 'terminal');

  if (hasTerminalPane) {
    targetSessionId = createTerminalSessionForFocusedPane();
    if (!targetSessionId) failureReason = 'terminal_cap';
  } else {
    const beforeIds = new Set(useTerminalStore.getState().sessions.map((terminalSession) => terminalSession.id));
    const addResult = options.addTerminalPane('terminal', { silent: true });
    if (addResult) {
      failureReason = addResult;
    } else {
      targetSessionId = findNewTerminalSessionId(beforeIds);
    }
  }
  targetSessionId = targetSessionId ?? await pickFallbackTerminalSessionId();

  if (!targetSessionId) {
    return {
      status: 'failed',
      reason: reasonForMissingResumeTarget(failureReason),
    };
  }

  const cwd = session.cwd?.trim();
  const resumeCommand = `codex resume ${shellQuote(codexResumeSessionId(session.codexSessionId))}`;
  const command = cwd
    ? `cd ${shellQuote(cwd)} && ${resumeCommand}\n`
    : `${resumeCommand}\n`;
  useTerminalStore.getState().insertCommand(command, targetSessionId, { durable: true });
  focusTerminalSession(targetSessionId);
  return { status: 'queued', sessionId: targetSessionId };
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
  if (activeSession && await isResumeQueueSafeTerminalSession(activeSession) && focusTerminalSession(activeSession.id)) {
    return activeSession.id;
  }

  return undefined;
}

function focusTerminalSession(sessionId: string): boolean {
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
  if (session.sessionStatus !== 'alive' || !session.isAlive) return false;
  if (!await isNativeSessionAlive(session)) return false;
  const screenText = await readTerminalScreen(session);
  if (screenText !== null) {
    return detectCodexActiveTranscript(screenText);
  }
  return false;
}

async function isResumeQueueSafeTerminalSession(session: TabSession): Promise<boolean> {
  if (session.sessionStatus === 'exited') return false;
  if (session.blocks.some((block) => block.isRunning)) return false;
  if (!await isNativeSessionAlive(session)) return false;
  if (session.activeCli && session.activeCli !== 'codex') return false;
  const screenText = await readTerminalScreen(session);
  if (screenText !== null) {
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
