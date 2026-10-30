/**
 * components/panes/MonitorPane.tsx — MONITOR pane: a CCTV-style wall with one
 * camera per agent, a mission bar, a hardware-style switcher, the Shelly chat
 * strip, and the editable MAP (wiring) view.
 *
 * Two sources behind one MonitorSource interface (lib/monitor-source.ts):
 *  - LIVE (lib/monitor-live.ts): a real agent run, read from its
 *    progress.jsonl by the poller (hooks/use-monitor-live-poller.ts) into
 *    agent-store `liveRuns`. Default whenever any run is known: the most
 *    recent running run, else the most recent finished one.
 *  - DEMO (lib/monitor-demo.ts): the built-in playback, labelled DEMO
 *    everywhere costs or states could be mistaken for a real run; shown when
 *    there is no run at all, or when the user picks it.
 *  - DRAFT (lib/monitor-team-source.ts): your own team in the MAP editor,
 *    shown still — no playback, no sample costs.
 * A small "LIVE ▸ <agent> / DEMO / DRAFT" selector switches between them.
 * LIVE hides the playback controls (SPEED / RESTART), the DEMO chat strip
 * and the MAP editor; the MAP shows the run's real wiring read-only.
 *
 * Register / run: the MAP's REGISTER hands the team to the AI chat as an
 * agent draft (lib/monitor-team-registration.ts); the user confirms there
 * with a plain "OK". Once registered the pane switches to LIVE for that
 * agent (STANDBY until it runs) and RUN NOW starts it through runAgentNow,
 * the same path as the Sidebar's RUN NOW (eligible parallel teams take the
 * attended PlanSpec executor route).
 *
 * Approval: DEMO asks in its own chat strip (type ok / no). LIVE never
 * approves anything here — the pinned strip points the user to the chat /
 * review prompt where Shelly asked. No confirm cards or modals (standing
 * product rule).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { useFrameCallback, useReducedMotion, useSharedValue, type FrameInfo } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/lib/i18n';
import { logInfo } from '@/lib/debug-logger';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useAgentStore, type MonitorSpeed } from '@/store/agent-store';
import { createDemoSource, demoDateLabel, DEMO_TEAM } from '@/lib/monitor-demo';
import { createTeamSource, teamFromAgent } from '@/lib/monitor-team-source';
import { acknowledgeTeamRegistration, requestTeamRegistration, useMonitorTeamRegistration } from '@/lib/monitor-team-registration';
import { runAgentNow } from '@/lib/agent-manager';
import { execCommand } from '@/hooks/use-native-exec';
import { destinationPath } from '@/lib/monitor-team';
import {
  ACTIVE_STATES,
  formatDuration,
  formatTokens,
  summarize,
  formatMoney,
  type MonitorAgentState,
  type MonitorSnapshot,
  type MonitorSource,
} from '@/lib/monitor-source';
import { createLiveSource, liveLoopText, pickDefaultLiveRun, type LiveAgentInfo } from '@/lib/monitor-live';
import type { MonitorRun } from '@/lib/agent-progress';
import type { Agent } from '@/store/types';
import { useMonitorLivePoller } from '@/hooks/use-monitor-live-poller';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { multiPaneSlotOps } from '@/lib/pane-focus';
import { canReturnFromMonitor, restoreFromMonitor } from '@/lib/monitor-widget-link';
import { openFile } from '@/lib/open-file';
import { openAgentChatThread } from '@/lib/agent-thread-open';
import { MAX_PARALLEL_BRANCHES, normalizeSteps, planParallelGroups } from '@/lib/agent-orchestration';
import { MonitorCamera, NoSignalCamera } from '@/components/monitor/MonitorCamera';
import { MonitorMap } from '@/components/monitor/MonitorMap';
import { MonitorProviderPicker } from '@/components/monitor/MonitorProviderPicker';
import { useMonitorProviderPick } from '@/hooks/use-monitor-provider-pick';
import { MON, MON_FONT_MONO, MON_FONT_OSD, kindColor } from '@/components/monitor/monitor-palette';
import { translateMonitorText } from '@/components/monitor/monitor-i18n';
import { computeMonitorGrid, GRID_GAP } from '@/components/monitor/monitor-grid';

const TICK_MS = 200;
const AUTO_CYCLE_MS = 3200;
const GAP = 10;
/** Pane padding and the gap between its blocks (styles.content). */
const PAD = 10;
const ROOT_GAP = 10;
/** Largest single step of the animation clock (ms): ~6 frames at 60 Hz. */
const MAX_CLOCK_STEP_MS = 100;

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Playback time since RESTART as T+mm:ss. */
function formatPlayClock(seconds: number): string {
  const sec = Math.floor(seconds);
  return `T+${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
}

function Key({
  label,
  pressed,
  onPress,
  led,
  a11y,
  small,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  led?: MonitorAgentState;
  a11y?: string;
  /** Header-size key (source selector, inline OPEN CHAT). */
  small?: boolean;
}) {
  const ledColor =
    led === 'RUNNING' || led === 'WAITING'
      ? MON.phosphor
      : led === 'APPROVAL'
        ? MON.amber
        : led === 'DONE'
          ? MON.done
          : led === 'FAILED'
            ? MON.fail
            : led === 'STOPPED'
              ? MON.label
              : MON.ledOff;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ selected: !!pressed }}
      style={({ pressed: p }) => [styles.key, small && styles.keySmall, (pressed || p) && styles.keyOn]}
    >
      {led !== undefined && <View style={[styles.led, { backgroundColor: ledColor }]} />}
      <Text style={[styles.keyText, small && styles.keyTextSmall, pressed && { color: MON.phosphor }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Step instructions of an agent's chain, in plan order. */
/** Parallel group per step (same as the progress writers report), for the
 *  STANDBY cameras of steps that have not reported an event yet. */
function agentStepGroups(agent: Agent | undefined): (string | undefined)[] | undefined {
  if (!agent?.orchestration?.steps?.length) return undefined;
  try {
    return planParallelGroups(normalizeSteps(agent.orchestration)).group;
  } catch {
    return undefined;
  }
}

function agentStepLabels(agent: Agent | undefined): string[] | undefined {
  const steps = agent?.orchestration?.steps;
  if (!steps || !steps.length) return undefined;
  return steps.map((s) => (typeof s === 'string' ? s : s?.instruction ?? ''));
}

function latestRun(list: { run: MonitorRun }[] | undefined): MonitorRun | undefined {
  return list && list.length ? list[list.length - 1].run : undefined;
}

async function runShell(cmd: string): Promise<string> {
  const r = await execCommand(cmd, 120_000);
  if (r.exitCode !== 0) throw new Error(r.stderr || `exit ${r.exitCode}`);
  return r.stdout;
}

export default function MonitorPane() {
  const { t, locale } = useTranslation();
  const reduceMotion = useReducedMotion();
  const { isWide, isCompact } = useDeviceLayout();
  const monitor = useAgentStore(useShallow((s) => s.monitor));
  const { tickMonitor, setMonitor, sendMonitorInput, restartMonitor, setMonitorTeam } = useAgentStore(
    useShallow((s) => ({
      tickMonitor: s.tickMonitor,
      setMonitor: s.setMonitor,
      sendMonitorInput: s.sendMonitorInput,
      restartMonitor: s.restartMonitor,
      setMonitorTeam: s.setMonitorTeam,
    })),
  );
  const { t: playT, speed, view, selectedId, auto, inputs, runId, sourceMode, liveAgentId } = monitor;
  const { liveRuns, agents, runningAgentIds, liveLoops } = useAgentStore(
    useShallow((s) => ({ liveRuns: s.liveRuns, agents: s.agents, runningAgentIds: s.runningAgentIds, liveLoops: s.liveLoops })),
  );

  // A MONITOR widget tap that found no free slot borrowed this one: offer BACK.
  const slots = useMultiPaneStore((s) => s.slots);
  const canGoBack = canReturnFromMonitor(slots);

  // Reads progress.jsonl into liveRuns while this pane is mounted.
  useMonitorLivePoller();

  // Wall clock for LIVE (elapsed / "updated Ns ago" / stale), 1 s resolution.
  const [now, setNow] = useState(() => Date.now());

  // ── Source selection ──
  // Existing agents with a known run, most recently started first (a deleted
  // agent's leftover runs never show up).
  const liveAgentOrder = useMemo(() => {
    const known = new Set(agents.map((a) => a.id));
    const ids = Object.keys(liveRuns).filter((id) => known.has(id) && latestRun(liveRuns[id]));
    const start = (id: string) => Date.parse(latestRun(liveRuns[id])!.startedAt) || 0;
    return ids.sort((a, b) => start(b) - start(a));
  }, [liveRuns, agents]);
  // LIVE picked for an agent that has not run yet (e.g. just registered from
  // the MAP): show its wiring on STANDBY instead of another agent's run.
  const standbyAgent =
    sourceMode === 'live' && liveAgentId && !latestRun(liveRuns[liveAgentId])
      ? agents.find((a) => a.id === liveAgentId)
      : undefined;
  const liveRun: MonitorRun | null = useMemo(() => {
    if (sourceMode === 'demo' || sourceMode === 'draft' || standbyAgent) return null;
    if (sourceMode === 'live' && liveAgentId && liveAgentOrder.includes(liveAgentId)) {
      const chosen = latestRun(liveRuns[liveAgentId]);
      if (chosen) return chosen;
    }
    return pickDefaultLiveRun(
      liveAgentOrder.map((id) => latestRun(liveRuns[id])!),
      runningAgentIds,
      now,
    );
  }, [sourceMode, liveAgentId, liveRuns, liveAgentOrder, runningAgentIds, now, standbyAgent]);
  const isLive = liveRun !== null;
  const liveAgent = isLive ? agents.find((a) => a.id === liveRun.agentId) : undefined;
  const liveAgentName = liveAgent?.name ?? liveRun?.agentId ?? '';
  const liveEntry = isLive ? liveRuns[liveRun.agentId]?.find((e) => e.run.runId === liveRun.runId) : undefined;
  const stepLabels = useMemo(() => agentStepLabels(liveAgent), [liveAgent]);
  const stepGroups = useMemo(() => agentStepGroups(liveAgent), [liveAgent]);
  const liveSource = useMemo(() => {
    if (!liveRun) return null;
    const info: LiveAgentInfo = { name: liveAgentName, steps: stepLabels, groups: stepGroups };
    return createLiveSource(liveRun, info);
  }, [liveRun, liveAgentName, stepLabels, stepGroups]);

  // The demo is dated "today" and its wall clock starts at RESTART.
  const run = useMemo(() => {
    const date = demoDateLabel();
    return { id: runId, date, source: createDemoSource(date), startWall: Date.now() };
  }, [runId]);
  const { startWall, date } = run;
  const registration = useMonitorTeamRegistration(
    useShallow((s) => ({ status: s.status, agentId: s.agentId, team: s.team })),
  );
  const isDraft = sourceMode === 'draft' && !standbyAgent;
  const draftTeam = monitor.team ?? DEMO_TEAM;
  const stillSource = useMemo(() => {
    if (standbyAgent) {
      const registered = registration.agentId === standbyAgent.id && registration.team;
      return createTeamSource(registered || teamFromAgent(standbyAgent));
    }
    return isDraft ? createTeamSource(draftTeam) : null;
  }, [standbyAgent, registration.agentId, registration.team, isDraft, draftTeam]);
  const source: MonitorSource = liveSource ?? stillSource ?? run.source;
  // Editable map: DEMO (preview edits) and DRAFT. LIVE / standby are read-only.
  const editable = !isLive && !standbyAgent;
  const team = editable ? monitor.team ?? source.team : source.team;
  const snap: MonitorSnapshot = useMemo(
    () => (liveSource ? liveSource.snapshot(now, []) : run.source.snapshot(playT, inputs)),
    [liveSource, run.source, now, playT, inputs],
  );
  const summary = summarize(source.agents, snap);

  // Playback clock (JS, coarse) — drives the DEMO timeline only.
  useEffect(() => {
    if (!source.isDemo) return;
    let last = Date.now();
    const id = setInterval(() => {
      const n = Date.now();
      tickMonitor((n - last) / 1000);
      last = n;
    }, TICK_MS);
    return () => clearInterval(id);
  }, [tickMonitor, source.isDemo]);

  // LIVE clock; also re-evaluates the default pick (a run may go silent).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), isLive ? 1000 : 5000);
    return () => clearInterval(id);
  }, [isLive]);

  useEffect(() => {
    logInfo('Monitor', isLive ? `pane showing live run ${liveRun?.runId}` : `pane showing demo (run ${runId})`);
  }, [isLive, liveRun?.runId, runId]);

  // Animation clock (UI thread) — drives the liveness overlays only; frozen
  // under reduced motion so every overlay renders as a still frame.
  //
  // The frame callback must keep one identity across renders: useFrameCallback
  // re-registers whenever the callback changes, and a re-registered callback
  // starts a new `timeSinceFirstFrame` from 0. This pane re-renders every
  // second (LIVE wall clock) / every tick (DEMO), so an inline callback made
  // the clock rewind to 0 each time and the slow drifts (0.17–0.23 rad/s)
  // never got anywhere; only an operator whose seed put the "signal tear"
  // phase inside the first second visibly moved. Accumulating the per-frame
  // delta also keeps the clock monotonic across a reduced-motion toggle.
  const clock = useSharedValue(0);
  const advanceClock = useCallback(
    (frame: FrameInfo) => {
      'worklet';
      const dt = frame.timeSincePreviousFrame;
      // First frame after (re)registration has no delta; a long pause
      // (backgrounded app) advances by at most one short step, never a jolt.
      if (dt !== null) clock.value += Math.min(dt, MAX_CLOCK_STEP_MS) / 1000;
    },
    [clock],
  );
  useFrameCallback(advanceClock, !reduceMotion);

  // AUTO: cycle through active channels; jump to the approval channel.
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const cycle = useCallback(
    (stay: boolean) => {
      const s = snapRef.current;
      if (s.approvalPending && s.approvalAgentId) {
        setMonitor({ selectedId: s.approvalAgentId, view: 'single' });
        return;
      }
      let pool = source.agents.filter((d) => ACTIVE_STATES.has(s.agents[d.id]?.state ?? 'STANDBY'));
      if (pool.length === 0) pool = [...source.agents];
      const i = pool.findIndex((d) => d.id === selRef.current);
      const next = stay && i >= 0 ? pool[i] : pool[(i + 1) % pool.length];
      setMonitor({ selectedId: next.id, view: 'single' });
    },
    [setMonitor, source],
  );
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => cycle(false), AUTO_CYCLE_MS);
    return () => clearInterval(id);
  }, [auto, cycle]);
  useEffect(() => {
    if (auto && snap.approvalPending) cycle(true);
  }, [auto, snap.approvalPending, cycle]);

  const [wallWidth, setWallWidth] = useState(0);
  const onWallLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - wallWidth) > 0.5) setWallWidth(w);
  };
  // ── No-scroll GRID fit ──
  // The wall's height is what the pane has left after the chrome above
  // (mission bar + approval strip) and below (switcher + DEMO chat). Both are
  // measured on their own, never from the wall, so sizing the wall cannot
  // feed back into its own measurement.
  const [paneH, setPaneH] = useState(0);
  const [topH, setTopH] = useState(0);
  const [bottomH, setBottomH] = useState(0);
  const measureH = (cur: number, set: (h: number) => void) => (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (Math.abs(h - cur) > 0.5) set(h);
  };
  const fitMode = view === 'grid' && paneH > 0 && topH > 0 && bottomH > 0 && wallWidth > 0;
  const wallH = Math.floor(paneH - PAD * 2 - ROOT_GAP * 2 - topH - bottomH) - 1;
  const grid = useMemo(
    () => (fitMode ? computeMonitorGrid(wallWidth, wallH, source.agents.length) : null),
    [fitMode, wallWidth, wallH, source.agents.length],
  );
  // Fits: every camera inside the pane. Otherwise (tiny pane, many cameras)
  // the wall keeps natural-height cells and the pane scrolls.
  const fitted = grid?.fits ? grid : null;
  const cols = grid ? grid.cols : isWide ? 3 : 2;
  const camW = grid ? grid.cellW : wallWidth > 0 ? (wallWidth - GAP * (cols - 1)) / cols : 0;
  const gridGap = grid ? GRID_GAP : GAP;
  const cameraFit = fitted
    ? { width: fitted.cellW, height: fitted.cellH, screenW: fitted.screenW, screenH: fitted.screenH, hud: fitted.hud }
    : undefined;
  // The empty "free channel" tile only takes a cell the chosen grid leaves
  // free (and only on a wide wall, where it reads as part of the bank).
  const showEmptyTile = isWide && (grid ? grid.freeCells > 0 : true);

  const [draft, setDraft] = useState('');
  // OPEN CHAT found no room for a chat pane (4 panes full).
  const [chatUnavailable, setChatUnavailable] = useState(false);
  useEffect(() => {
    if (!snap.approvalPending) setChatUnavailable(false);
  }, [snap.approvalPending]);
  const send = () => {
    if (!draft.trim()) return;
    logInfo('Monitor', 'chat input', { approvalPending: snap.approvalPending });
    sendMonitorInput(draft);
    setDraft('');
  };

  const select = (id: string) => setMonitor({ selectedId: id, view: 'single', auto: false });
  const playClock = snap.run ? `T+${formatDuration(snap.run.elapsedSec)}` : formatPlayClock(playT);
  // A DEMO feed must never look like a real recording: playback time, not
  // the wall clock. LIVE shows the real wall clock.
  const timestamp = source.isDemo ? playClock : isLive ? formatClock(now) : formatClock(startWall + playT * 1000);
  const defById = useMemo(() => Object.fromEntries(source.agents.map((d) => [d.id, d])), [source]);
  const selectedDef = defById[selectedId] ?? source.agents[0];
  // Provider picker (live single view): tap the camera to open it.
  const providerPick = useMonitorProviderPick(isLive ? liveRun : null, liveAgent, selectedDef?.id, t);

  const doneCount = t('monitor.done_count', { n: summary.done, total: summary.total });
  const outcome = snap.run?.outcome;
  const ended = outcome !== undefined && outcome !== 'running' && outcome !== 'success';
  const statusLabel = snap.complete
    ? t('monitor.mission_complete')
    : snap.approvalPending
      ? t('monitor.waiting_for_you')
      : ended
        ? t(`monitor.live.outcome.${outcome}`)
        : doneCount;
  // Folded/compact: "DONE n/5" moves into the progress label to save a row.
  const showStatusInStats = isWide || snap.complete || snap.approvalPending || ended;
  // "RUN n/3" is live concurrency; once the run is over it reads as a stuck
  // 0/3, so the slot shows "DONE n/total" instead.
  const runOver = snap.complete || ended;
  const runSlotLabel = runOver
    ? doneCount
    : t('monitor.run_count', { n: summary.running, max: MAX_PARALLEL_BRANCHES });
  const progressLabel =
    !isWide && !runOver ? `${doneCount} · ${summary.missionPct}%` : `${summary.missionPct}%`;
  const capText = team.capUsd !== undefined ? ` / ${formatMoney(team.capUsd, locale)}` : '';
  const apiCostText = summary.apiUsdKnown
    ? `${formatMoney(summary.apiUsd, locale)}${capText}`
    : `${formatTokens(summary.apiTokens)}${
        summary.apiUsd > 0 ? ` · ${t('monitor.cost_reported', { amount: formatMoney(summary.apiUsd, locale) })}` : ''
      }`;
  const savedTo = isLive
    ? null
    : snap.complete && team.destination
      ? t('monitor.saved_to', { label: team.destination.label, path: destinationPath(team.destination, date) })
      : null;
  // LIVE: only a path the run itself recorded (its run log's savedPath).
  const liveSavedPath = isLive && snap.complete ? liveEntry?.savedPath : undefined;
  // Continuous mode: "LOOP · iteration N" (+ the stop reason) for a loop agent.
  const loopText = isLive ? liveLoopText(liveLoops?.[liveRun.agentId], t) : null;
  const failureText =
    snap.run?.outcome === 'failed' && snap.run.failedChannel
      ? t('monitor.live.failure', { channel: snap.run.failedChannel, reason: snap.run.failureReason ?? '—' })
      : null;
  const approvalChannel = snap.approvalAgentId
    ? source.agents.find((d) => d.id === snap.approvalAgentId)?.channel ?? ''
    : '';

  const pickLive = () => {
    if (!liveAgentOrder.length) return;
    // Already on LIVE: step to the next agent that has a run.
    const current = liveRun?.agentId;
    const i = current ? liveAgentOrder.indexOf(current) : -1;
    const nextId = isLive ? liveAgentOrder[(i + 1) % liveAgentOrder.length] : current ?? liveAgentOrder[0];
    logInfo('Monitor', `source → live ${nextId}`);
    setMonitor({ sourceMode: 'live', liveAgentId: nextId, auto: false });
  };
  const pickDemo = () => {
    logInfo('Monitor', 'source → demo');
    setMonitor({ sourceMode: 'demo', auto: false });
  };
  const pickDraft = () => {
    logInfo('Monitor', 'source → draft');
    setMonitor({ sourceMode: 'draft', auto: false, view: 'map' });
  };

  // ── Register / run ──
  // Registered from the MAP and confirmed in chat → LIVE for that agent.
  const registeredId = registration.status === 'registered' ? registration.agentId : null;
  useEffect(() => {
    if (!registeredId) return;
    logInfo('Monitor', `team registered → live ${registeredId}`);
    setMonitor({ sourceMode: 'live', liveAgentId: registeredId, auto: false });
    // Switch once: a later DEMO pick or a remount must not jump back.
    acknowledgeTeamRegistration();
  }, [registeredId, setMonitor]);
  const [registerFeedback, setRegisterFeedback] = useState<string | null>(null);
  const onRegister = () => {
    const res = requestTeamRegistration(team, locale === 'ja' ? 'ja' : 'en');
    setRegisterFeedback(
      res === 'no_pane' ? t('monitor.register.no_pane') : res === 'invalid' ? t('monitor.register.invalid') : null,
    );
  };
  const registerNote =
    registerFeedback ??
    (registration.status === 'awaiting-confirm'
      ? t('monitor.register.awaiting')
      : registration.status === 'cancelled'
        ? t('monitor.register.cancelled')
        : null);
  // RUN NOW target: the agent shown in LIVE / standby.
  const runTargetId = standbyAgent?.id ?? (isLive ? liveRun.agentId : null);
  const runTargetName = standbyAgent?.name ?? liveAgentName;
  const targetRunning =
    !!runTargetId && (runningAgentIds.includes(runTargetId) || (isLive && snap.run?.outcome === 'running'));
  const [runRequested, setRunRequested] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);
  const onRunNow = () => {
    if (!runTargetId || runRequested) return;
    const id = runTargetId;
    logInfo('Monitor', `run now ${id}`);
    setRunRequested(id);
    setRunNote(t('monitor.register.run_started', { name: runTargetName }));
    runAgentNow(id, runShell)
      .then(() => setRunNote(null))
      .catch((e) => {
        logInfo('Monitor', `run now failed: ${e instanceof Error ? e.message : String(e)}`);
        setRunNote(t('monitor.register.run_failed', { name: runTargetName }));
      })
      .finally(() => setRunRequested((cur) => (cur === id ? null : cur)));
  };
  // The question the source is waiting on (latest ask line in the chat).
  const pendingAsk = snap.approvalPending ? [...snap.chat].reverse().find((m) => m.ask) : undefined;
  // Folded screens show only the MAP while it is open; wide keeps the wall.
  const showWall = view !== 'map' || isWide;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, fitted && styles.contentFit]}
      keyboardShouldPersistTaps="handled"
      onLayout={measureH(paneH, setPaneH)}
      testID="monitor-root"
    >
      <View style={styles.chrome} onLayout={measureH(topH, setTopH)} testID="monitor-chrome-top">
      {/* ── Mission bar: title + source tabs on one row, RUN / status / clock
          + progress on the next, then the cost line. ── */}
      <View style={styles.mission}>
        <View style={styles.brandRow}>
          <Text style={styles.brand} numberOfLines={1}>
            {'SHELLY '}
            <Text style={{ color: MON.muted }}>▸</Text>
            {' MONITOR'}
          </Text>
          {source.isDemo && <Text style={styles.demoBadge}>{t('monitor.demo_badge')}</Text>}
          <Text style={styles.goalLine} numberOfLines={1}>
            {t('monitor.mission')} <Text style={{ color: MON.osd }}>{team.title}</Text>
            {team.schedule ? <Text style={{ color: MON.muted }}>{`  ${team.schedule}`}</Text> : null}
          </Text>
        <View style={styles.selector} testID="monitor-source-selector">
          <Key
            label={
              standbyAgent
                ? t('monitor.source.live', { name: standbyAgent.name })
                : liveAgentOrder.length
                  ? t('monitor.source.live', { name: isLive ? liveAgentName : agents.find((a) => a.id === liveAgentOrder[0])?.name ?? liveAgentOrder[0] })
                  : t('monitor.source.live_none')
            }
            pressed={isLive || !!standbyAgent}
            onPress={pickLive}
            a11y={t('monitor.source.live_a11y')}
            small
          />
          <Key label={t('monitor.source.demo')} pressed={source.isDemo} onPress={pickDemo} a11y={t('monitor.source.demo_a11y')} small />
          <Key label={t('monitor.source.draft')} pressed={isDraft} onPress={pickDraft} a11y={t('monitor.source.draft_a11y')} small />
        </View>
        </View>
        {loopText && (
          <Text style={styles.savedTo} numberOfLines={1} testID="monitor-loop">
            {loopText}
          </Text>
        )}
        <View style={styles.mstats}>
          <Text style={[styles.mstat, { color: MON.phosphor }]} numberOfLines={1} testID="monitor-run-slot">
            {runSlotLabel}
          </Text>
          {showStatusInStats && (
            <Text
              style={[
                styles.mstat,
                (snap.complete || snap.approvalPending) && { color: MON.amber },
                outcome === 'failed' && { color: MON.fail },
              ]}
              numberOfLines={1}
              testID="monitor-status"
            >
              {statusLabel}
            </Text>
          )}
          <Text style={styles.mstat} numberOfLines={1}>
            {playClock}
          </Text>
          <View
            style={styles.mbar}
            accessibilityRole="progressbar"
            accessibilityLabel={t('monitor.mission_progress')}
            accessibilityValue={{ min: 0, max: 100, now: summary.missionPct }}
          >
            <View
              style={[
                styles.mbarFill,
                { width: `${summary.missionPct}%`, backgroundColor: snap.complete ? MON.amber : MON.phosphor },
              ]}
            />
          </View>
          <Text style={styles.mpct} numberOfLines={1}>
            {progressLabel}
          </Text>
        </View>
        {standbyAgent && (
          <Text style={styles.savedTo} numberOfLines={1} testID="monitor-standby">
            {t('monitor.register.standby')}
          </Text>
        )}
        {savedTo && (
          <Text style={styles.savedTo} numberOfLines={1} testID="monitor-saved-to">
            {savedTo}
          </Text>
        )}
        {liveSavedPath && (
          <Pressable
            onPress={() => {
              logInfo('Monitor', 'open saved output');
              openFile(liveSavedPath).catch(() => {});
            }}
            accessibilityRole="link"
            accessibilityLabel={t('monitor.live.saved_open_a11y')}
            testID="monitor-saved-to"
          >
            <Text style={[styles.savedTo, styles.link]} numberOfLines={1} ellipsizeMode="head">
              {t('monitor.live.saved_to', { path: liveSavedPath })}
            </Text>
          </Pressable>
        )}
        {failureText && (
          <Text style={styles.failure} numberOfLines={2} testID="monitor-failure">
            {failureText}
          </Text>
        )}
        <View style={styles.costs}>
          <Text style={styles.cost} numberOfLines={1}>
            <Text style={[styles.costK, { color: kindColor('API') }]}> API </Text>
            {` ${t('monitor.cost_api')} `}
            <Text style={{ color: MON.osd }}>{apiCostText}</Text>
          </Text>
          <Text style={styles.cost} numberOfLines={1}>
            <Text style={[styles.costK, { color: kindColor('CLI') }]}> CLI </Text>
            {` ${t('monitor.cost_cli')} `}
            <Text style={{ color: MON.osd }}>{formatTokens(summary.cliTokens)}</Text>
          </Text>
          <Text style={styles.cost} numberOfLines={1}>
            <Text style={[styles.costK, { color: kindColor('LOCAL') }]}> LOCAL </Text>
            {` ${t('monitor.cost_local')} `}
            <Text style={{ color: MON.osd }}>{formatTokens(summary.localTokens)}</Text>
            {` · ${formatMoney(0, locale)}`}
          </Text>
          {source.isDemo && (
            <Text style={[styles.cost, { color: MON.muted }]}>{t('monitor.cost_sample')}</Text>
          )}
        </View>
        {/* The legend is a one-time tip: the fitted GRID leaves its row to
            the cameras (it still shows on the single / MAP views). */}
        {!monitor.legendDismissed && !fitMode && (
          <View style={styles.legendRow}>
            <Text style={styles.legend} testID="monitor-cost-legend">
              {t('monitor.legend', { zero: formatMoney(0, locale) })}
            </Text>
            <Pressable
              onPress={() => setMonitor({ legendDismissed: true })}
              accessibilityRole="button"
              accessibilityLabel={t('monitor.legend_dismiss')}
              hitSlop={8}
            >
              <Text style={styles.legendX}>×</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* ── Pinned approval: stays right under the mission bar so the ask is
          on screen on a folded phone. Same draft + send as the chat strip. ── */}
      {snap.approvalPending && isLive && (
        // LIVE never approves from here: the ask lives in Shelly's chat /
        // review prompt, so point there instead of offering a reply box.
        <View style={styles.pinned} testID="monitor-pinned-approval">
          {/* One line: where to answer + OPEN CHAT inline. */}
          <View style={styles.row}>
            <Text style={[styles.pinnedAsk, styles.pinnedAskInline]} numberOfLines={2}>
              {t('monitor.live.approval_where', { channel: approvalChannel })}
            </Text>
            <Key
              label={t('monitor.live.open_chat')}
              a11y={t('monitor.live.open_chat_a11y')}
              small
              onPress={() => {
                logInfo('Monitor', 'open agent chat for approval');
                setChatUnavailable(!openAgentChatThread(liveRun.agentId));
              }}
            />
          </View>
          {chatUnavailable && (
            <Text style={styles.hintLine} testID="monitor-chat-unavailable">
              {t('monitor.live.chat_unavailable')}
            </Text>
          )}
        </View>
      )}
      {snap.approvalPending && !isLive && (
        <View style={[styles.pinned, styles.pinnedWrap]} testID="monitor-pinned-approval">
          <Text style={[styles.pinnedAsk, styles.pinnedAskWrap]} numberOfLines={2}>
            {pendingAsk
              ? (pendingAsk.text ?? translateMonitorText(t, pendingAsk.message))
              : t('monitor.waiting_for_you')}
          </Text>
          <View style={[styles.row, styles.pinnedReply]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={send}
              placeholder={t('monitor.pinned_placeholder')}
              placeholderTextColor={MON.muted}
              accessibilityLabel={t('monitor.pinned_a11y')}
              style={styles.input}
              returnKeyType="send"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Key label={t('monitor.send')} onPress={send} a11y={t('monitor.pinned_send_a11y')} />
          </View>
        </View>
      )}
      </View>

      {/* ── Map ── */}
      {view === 'map' && (
        <MonitorMap
          team={team}
          defaultTeam={source.team}
          defs={source.agents}
          snap={snap}
          clock={clock}
          reduceMotion={reduceMotion}
          isDemo={source.isDemo}
          wide={isWide}
          date={date}
          onChange={(next) => {
            if (editable) setMonitorTeam(next === source.team ? null : next);
          }}
          onLoadTeam={(next) => {
            // A pasted team file is your own team: edit it in DRAFT.
            setMonitorTeam(next);
            setMonitor({ sourceMode: 'draft' });
          }}
          readOnly={!editable}
          onRegister={editable ? onRegister : undefined}
          registerBusy={registration.status === 'awaiting-confirm'}
          registerNote={editable ? registerNote : runNote}
          onRunNow={runTargetId ? onRunNow : undefined}
          runNowBusy={!!runRequested || targetRunning}
        />
      )}

      {/* ── Wall ── */}
      {showWall && view === 'single' && providerPick.open && providerPick.available && (
        <MonitorProviderPicker
          channel={selectedDef.channel}
          current={providerPick.current}
          canRestart={providerPick.canRestart}
          busy={providerPick.busy}
          onApply={providerPick.apply}
          onClose={providerPick.toggle}
        />
      )}
      {showWall && (
        <View style={[styles.wall, fitted && { height: wallH }]} onLayout={onWallLayout} testID="monitor-wall">
          {view === 'single' ? (
            <View style={styles.singleWrap}>
            {/* The single camera can push the switcher's GRID key off-screen;
                keep a way back right above it. */}
            <View style={styles.singleBack}>
              <Key
                label={t('monitor.back_to_grid')}
                small
                onPress={() => setMonitor({ view: 'grid', auto: false })}
              />
            </View>
            <MonitorCamera
              def={selectedDef}
              snap={snap.agents[selectedDef.id]}
              parentChannel={selectedDef.parentId ? defById[selectedDef.parentId]?.channel : undefined}
              clock={clock}
              reduceMotion={reduceMotion}
              timestamp={timestamp}
              showTimestamp
              demo={source.isDemo}
              single
              sideBySide={isWide}
              compactText={false}
              onPress={() => (providerPick.available ? providerPick.toggle() : setMonitor({ view: 'grid', auto: false }))}
            />
            </View>
          ) : (
            camW > 0 && (
              <View style={[styles.grid, { gap: gridGap }]} testID={fitted ? 'monitor-grid-fit' : 'monitor-grid'}>
                {source.agents.map((d) => (
                  <View key={d.id} style={{ width: camW }}>
                    <MonitorCamera
                      def={d}
                      snap={snap.agents[d.id]}
                      parentChannel={d.parentId ? defById[d.parentId]?.channel : undefined}
                      clock={clock}
                      reduceMotion={reduceMotion}
                      timestamp={timestamp}
                      showTimestamp={isWide && (!fitted || fitted.screenH >= 90)}
                      demo={source.isDemo}
                      single={false}
                      sideBySide={false}
                      compactText={fitted ? fitted.compactText : !isWide || isCompact}
                      fit={cameraFit}
                      onPress={() => select(d.id)}
                    />
                  </View>
                ))}
                {/* The empty "free channel" tile only takes a cell the grid
                    leaves free; it never forces a worse layout. */}
                {showEmptyTile && (
                  <View style={{ width: camW }}>
                    <NoSignalCamera
                      channel={`CH-0${source.agents.length + 1}`}
                      reduceMotion={reduceMotion}
                      fit={cameraFit}
                    />
                  </View>
                )}
              </View>
            )
          )}
        </View>
      )}

      <View style={styles.chrome} onLayout={measureH(bottomH, setBottomH)} testID="monitor-chrome-bottom">
      {/* ── Switcher ── */}
      <View style={styles.switcher}>
        <View style={styles.grp}>
          {source.agents.map((d) => (
            <Key
              key={d.id}
              label={d.channel.replace('CH-0', 'CH')}
              a11y={`${d.channel} ${d.name}`}
              led={snap.agents[d.id]?.state}
              pressed={view === 'single' && selectedId === d.id}
              onPress={() => select(d.id)}
            />
          ))}
        </View>
        <View style={styles.grp}>
          {canGoBack && (
            <Key
              label={t('monitor.widget_back')}
              pressed={false}
              onPress={() => restoreFromMonitor(multiPaneSlotOps())}
            />
          )}
          <Key label="GRID" pressed={view === 'grid'} onPress={() => setMonitor({ view: 'grid', auto: false })} />
          <Key
            label="MAP"
            pressed={view === 'map'}
            onPress={() => setMonitor({ view: view === 'map' ? 'grid' : 'map', auto: false })}
          />
          <Key
            label="AUTO"
            pressed={auto}
            onPress={() => {
              const next = !auto;
              setMonitor({ auto: next });
              if (next) cycle(true);
            }}
          />
        </View>
        {/* Playback controls exist only for the DEMO; a real run has no speed. */}
        {source.isDemo && <View style={styles.grp}>
          <Key
            label={`SPEED ${speed}×`}
            pressed={speed > 1}
            onPress={() => setMonitor({ speed: (speed === 1 ? 2 : speed === 2 ? 4 : 1) as MonitorSpeed })}
          />
          <Key
            label={`↺ ${t('monitor.restart')}`}
            onPress={() => {
              logInfo('Monitor', 'restart demo');
              restartMonitor();
            }}
          />
        </View>}
      </View>

      {/* ── Chat (DEMO only: LIVE approvals are answered in Shelly's chat) ── */}
      {source.isDemo && <View style={[styles.chat, fitMode && styles.chatFit]}>
        {!fitMode && <Text style={styles.chatHead}>{t('monitor.chat_head')}</Text>}
        {/* Fitted GRID: the latest two lines only, one row each, so the strip
            keeps a fixed height and the wall keeps its size. */}
        <View style={[styles.lines, fitMode && styles.linesFit]} accessibilityLiveRegion="polite">
          {(fitMode ? snap.chat.slice(-2) : snap.chat).map((m, i) => (
            <Text key={i} style={[styles.line, m.ask && { color: MON.amber }]} numberOfLines={fitMode ? 1 : undefined}>
              <Text style={[styles.who, m.who === 'you' && { color: MON.label }]}>
                {m.who === 'you' ? t('monitor.who_you') : t('monitor.who_shelly')}
              </Text>
              {'  '}
              {m.text ?? translateMonitorText(t, m.message)}
            </Text>
          ))}
        </View>
        <View style={styles.row}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={send}
            placeholder={t('monitor.chat_placeholder')}
            placeholderTextColor={MON.muted}
            accessibilityLabel={t('monitor.chat_a11y')}
            style={styles.input}
            returnKeyType="send"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Key label={t('monitor.send')} onPress={send} />
        </View>
      </View>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: MON.room },
  content: { padding: PAD, gap: ROOT_GAP, paddingBottom: 24 },
  // Fitted GRID: the wall height assumes PAD at the bottom too.
  contentFit: { paddingBottom: PAD },
  chrome: { gap: 8 },
  mission: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 5,
  },
  brandRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 },
  brand: { fontFamily: MON_FONT_OSD, fontSize: 18, color: MON.phosphor, letterSpacing: 1 },
  demoBadge: {
    fontFamily: MON_FONT_OSD,
    fontSize: 13,
    color: MON.amber,
    borderWidth: 1,
    borderColor: MON.amber,
    paddingHorizontal: 6,
  },
  // Grows into the space between the title and the source tabs; wraps to
  // its own line on a narrow pane.
  goalLine: { flexGrow: 1, flexShrink: 1, flexBasis: 160, fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.label },
  mstats: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 },
  mstat: { fontFamily: MON_FONT_OSD, fontSize: 15, color: MON.osd },
  mbar: {
    flexGrow: 1,
    flexBasis: 80,
    height: 8,
    backgroundColor: MON.barBg,
    borderWidth: 1,
    borderColor: MON.phosphorDim,
    overflow: 'hidden',
  },
  mbarFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  mpct: { fontFamily: MON_FONT_OSD, fontSize: 16, color: MON.phosphor, minWidth: 40, textAlign: 'right' },
  costs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 2 },
  cost: { fontFamily: MON_FONT_MONO, fontSize: 11.5, color: MON.label },
  costK: { fontFamily: MON_FONT_OSD, fontSize: 13 },
  savedTo: { fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.amber },
  link: { textDecorationLine: 'underline' },
  hintLine: { fontFamily: MON_FONT_MONO, fontSize: 11.5, color: MON.label },
  failure: { fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.fail },
  selector: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legend: { flex: 1, fontFamily: MON_FONT_MONO, fontSize: 10.5, color: MON.muted },
  legendX: { fontFamily: MON_FONT_OSD, fontSize: 16, color: MON.muted, paddingHorizontal: 4 },
  pinned: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.amber,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  pinnedAsk: { fontSize: 13, color: MON.amber, lineHeight: 18 },
  pinnedAskInline: { flex: 1, minWidth: 0 },
  // DEMO strip: the question and the reply box share one row when wide.
  pinnedWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10 },
  pinnedAskWrap: { flexGrow: 1, flexShrink: 1, flexBasis: 200 },
  pinnedReply: { flexGrow: 1, flexBasis: 220 },
  wall: { width: '100%' },
  singleWrap: { gap: 6 },
  singleBack: { flexDirection: 'row' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  switcher: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    backgroundColor: MON.bezel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 12,
    padding: 8,
  },
  grp: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: MON.keyTop,
    borderWidth: 1,
    borderColor: MON.keyEdge,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  keySmall: { paddingHorizontal: 8, paddingVertical: 3 },
  keyOn: { backgroundColor: MON.keyTopOn },
  keyText: { fontFamily: MON_FONT_OSD, fontSize: 15, color: MON.osd },
  keyTextSmall: { fontSize: 13 },
  led: { width: 8, height: 8, borderRadius: 4 },
  chat: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  chatHead: { fontFamily: MON_FONT_OSD, fontSize: 15, color: MON.muted },
  chatFit: { paddingVertical: 6, gap: 6 },
  lines: { gap: 4, minHeight: 64 },
  // Two one-row lines (line height 19 + gap 4).
  linesFit: { minHeight: 42 },
  line: { fontSize: 13, color: MON.osd, lineHeight: 19 },
  who: { fontFamily: MON_FONT_MONO, fontSize: 11.5, color: MON.phosphor },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: MON_FONT_MONO,
    fontSize: 14,
    color: MON.osd,
    backgroundColor: MON.black,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
});
