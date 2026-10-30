/**
 * components/panes/MonitorPane.tsx — MONITOR pane: a CCTV-style wall with one
 * camera per agent, a mission bar, a hardware-style switcher, the Shelly chat
 * strip, and the editable MAP (wiring) view.
 *
 * Phase A: plays the built-in DEMO run only (lib/monitor-demo.ts) and labels
 * it DEMO everywhere costs or states could be mistaken for a real run. The
 * pane only consumes the MonitorSource interface (lib/monitor-source.ts), so a
 * live source can replace the demo later without UI changes.
 *
 * Approval is asked in plain chat text and answered by typing ok / no — no
 * confirm cards or modals (standing product rule).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { useFrameCallback, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/lib/i18n';
import { logInfo } from '@/lib/debug-logger';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useAgentStore, type MonitorSpeed } from '@/store/agent-store';
import { createDemoSource, demoDateLabel } from '@/lib/monitor-demo';
import { destinationPath } from '@/lib/monitor-team';
import {
  ACTIVE_STATES,
  formatTokens,
  summarize,
  formatMoney,
  type MonitorAgentState,
} from '@/lib/monitor-source';
import { MAX_PARALLEL_BRANCHES } from '@/lib/agent-orchestration';
import { MonitorCamera, NoSignalCamera } from '@/components/monitor/MonitorCamera';
import { MonitorMap } from '@/components/monitor/MonitorMap';
import { MON, MON_FONT_MONO, MON_FONT_OSD, kindColor } from '@/components/monitor/monitor-palette';
import { translateMonitorText } from '@/components/monitor/monitor-i18n';

const TICK_MS = 200;
const AUTO_CYCLE_MS = 3200;
const GAP = 10;

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
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  led?: MonitorAgentState;
  a11y?: string;
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
            : MON.ledOff;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ selected: !!pressed }}
      style={({ pressed: p }) => [styles.key, (pressed || p) && styles.keyOn]}
    >
      {led !== undefined && <View style={[styles.led, { backgroundColor: ledColor }]} />}
      <Text style={[styles.keyText, pressed && { color: MON.phosphor }]}>{label}</Text>
    </Pressable>
  );
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
  const { t: playT, speed, view, selectedId, auto, inputs, runId } = monitor;

  // The demo is dated "today" and its wall clock starts at RESTART.
  const run = useMemo(() => {
    const date = demoDateLabel();
    return { id: runId, date, source: createDemoSource(date), startWall: Date.now() };
  }, [runId]);
  const { source, startWall, date } = run;
  const team = monitor.team ?? source.team;
  const snap = useMemo(() => source.snapshot(playT, inputs), [source, playT, inputs]);
  const summary = summarize(source.agents, snap);

  // Playback clock (JS, coarse) — drives the timeline.
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      tickMonitor((now - last) / 1000);
      last = now;
    }, TICK_MS);
    return () => clearInterval(id);
  }, [tickMonitor]);

  useEffect(() => {
    logInfo('Monitor', `pane mounted (demo, run ${runId})`);
  }, [runId]);

  // Animation clock (UI thread) — drives the liveness overlays only; frozen
  // under reduced motion so every overlay renders as a still frame.
  const clock = useSharedValue(0);
  useFrameCallback((frame) => {
    'worklet';
    clock.value = frame.timeSinceFirstFrame / 1000;
  }, !reduceMotion);

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
  const cols = isWide ? 3 : 2;
  const camW = wallWidth > 0 ? (wallWidth - GAP * (cols - 1)) / cols : 0;

  const [draft, setDraft] = useState('');
  const send = () => {
    if (!draft.trim()) return;
    logInfo('Monitor', 'chat input', { approvalPending: snap.approvalPending });
    sendMonitorInput(draft);
    setDraft('');
  };

  const select = (id: string) => setMonitor({ selectedId: id, view: 'single', auto: false });
  const playClock = formatPlayClock(playT);
  // A DEMO feed must never look like a real recording: playback time, not
  // the wall clock.
  const timestamp = source.isDemo ? playClock : formatClock(startWall + playT * 1000);
  const defById = useMemo(() => Object.fromEntries(source.agents.map((d) => [d.id, d])), [source]);
  const selectedDef = defById[selectedId] ?? source.agents[0];

  const doneCount = t('monitor.done_count', { n: summary.done, total: summary.total });
  const statusLabel = snap.complete
    ? t('monitor.mission_complete')
    : snap.approvalPending
      ? t('monitor.waiting_for_you')
      : doneCount;
  // Folded/compact: "DONE n/5" moves into the progress label to save a row.
  const showStatusInStats = isWide || snap.complete || snap.approvalPending;
  const progressLabel =
    !isWide && !snap.complete ? `${doneCount} · ${summary.missionPct}%` : `${summary.missionPct}%`;
  const capText = team.capUsd !== undefined ? ` / ${formatMoney(team.capUsd, locale)}` : '';
  const savedTo =
    snap.complete && team.destination
      ? t('monitor.saved_to', { label: team.destination.label, path: destinationPath(team.destination, date) })
      : null;
  // The question the source is waiting on (latest ask line in the chat).
  const pendingAsk = snap.approvalPending ? [...snap.chat].reverse().find((m) => m.ask) : undefined;
  // Folded screens show only the MAP while it is open; wide keeps the wall.
  const showWall = view !== 'map' || isWide;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* ── Mission bar ── */}
      <View style={styles.mission}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>
            {'SHELLY '}
            <Text style={{ color: MON.muted }}>▸</Text>
            {' MONITOR'}
          </Text>
          {source.isDemo && <Text style={styles.demoBadge}>{t('monitor.demo_badge')}</Text>}
        </View>
        <Text style={styles.goalLine} numberOfLines={2}>
          {t('monitor.mission')} <Text style={{ color: MON.osd }}>{team.title}</Text>
          {team.schedule ? <Text style={{ color: MON.muted }}>{`  ${team.schedule}`}</Text> : null}
        </Text>
        <View style={styles.mstats}>
          <Text style={[styles.mstat, { color: MON.phosphor }]}>
            {t('monitor.run_count', { n: summary.running, max: MAX_PARALLEL_BRANCHES })}
          </Text>
          {showStatusInStats && (
            <Text style={[styles.mstat, (snap.complete || snap.approvalPending) && { color: MON.amber }]}>
              {statusLabel}
            </Text>
          )}
          <Text style={styles.mstat}>{playClock}</Text>
        </View>
        {savedTo && (
          <Text style={styles.savedTo} numberOfLines={2} testID="monitor-saved-to">
            {savedTo}
          </Text>
        )}
        <View style={styles.mprog}>
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
          <Text style={styles.mpct}>{progressLabel}</Text>
        </View>
        <View style={styles.costs}>
          <Text style={styles.cost}>
            <Text style={[styles.costK, { color: kindColor('API') }]}> API </Text>
            {` ${t('monitor.cost_api')} `}
            <Text style={{ color: MON.osd }}>{`${formatMoney(summary.apiUsd, locale)}${capText}`}</Text>
          </Text>
          <Text style={styles.cost}>
            <Text style={[styles.costK, { color: kindColor('CLI') }]}> CLI </Text>
            {` ${t('monitor.cost_cli')} `}
            <Text style={{ color: MON.osd }}>{formatTokens(summary.cliTokens)}</Text>
          </Text>
          <Text style={styles.cost}>
            <Text style={[styles.costK, { color: kindColor('LOCAL') }]}> LOCAL </Text>
            {` ${t('monitor.cost_local')} `}
            <Text style={{ color: MON.osd }}>{formatTokens(summary.localTokens)}</Text>
            {` · ${formatMoney(0, locale)}`}
          </Text>
          {source.isDemo && (
            <Text style={[styles.cost, { color: MON.muted }]}>{t('monitor.cost_sample')}</Text>
          )}
        </View>
        {!monitor.legendDismissed && (
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
      {snap.approvalPending && (
        <View style={styles.pinned} testID="monitor-pinned-approval">
          <Text style={styles.pinnedAsk} numberOfLines={2}>
            {pendingAsk
              ? (pendingAsk.text ?? translateMonitorText(t, pendingAsk.message))
              : t('monitor.waiting_for_you')}
          </Text>
          <View style={styles.row}>
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
          onChange={(next) => setMonitorTeam(next === source.team ? null : next)}
        />
      )}

      {/* ── Wall ── */}
      {showWall && (
        <View style={styles.wall} onLayout={onWallLayout} testID="monitor-wall">
          {view === 'single' ? (
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
              onPress={() => setMonitor({ view: 'grid', auto: false })}
            />
          ) : (
            camW > 0 && (
              <View style={styles.grid}>
                {source.agents.map((d) => (
                  <View key={d.id} style={{ width: camW }}>
                    <MonitorCamera
                      def={d}
                      snap={snap.agents[d.id]}
                      parentChannel={d.parentId ? defById[d.parentId]?.channel : undefined}
                      clock={clock}
                      reduceMotion={reduceMotion}
                      timestamp={timestamp}
                      showTimestamp={isWide}
                      demo={source.isDemo}
                      single={false}
                      sideBySide={false}
                      compactText={!isWide || isCompact}
                      onPress={() => select(d.id)}
                    />
                  </View>
                ))}
                {/* The empty CH-06 tile only earns its space on a wide wall. */}
                {isWide && (
                  <View style={{ width: camW }}>
                    <NoSignalCamera channel={`CH-0${source.agents.length + 1}`} reduceMotion={reduceMotion} />
                  </View>
                )}
              </View>
            )
          )}
        </View>
      )}

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
        <View style={styles.grp}>
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
        </View>
      </View>

      {/* ── Chat ── */}
      <View style={styles.chat}>
        <Text style={styles.chatHead}>{t('monitor.chat_head')}</Text>
        <View style={styles.lines} accessibilityLiveRegion="polite">
          {snap.chat.map((m, i) => (
            <Text key={i} style={[styles.line, m.ask && { color: MON.amber }]}>
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
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: MON.room },
  content: { padding: 10, gap: 10, paddingBottom: 24 },
  mission: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  brand: { fontFamily: MON_FONT_OSD, fontSize: 22, color: MON.phosphor, letterSpacing: 1 },
  demoBadge: {
    fontFamily: MON_FONT_OSD,
    fontSize: 13,
    color: MON.amber,
    borderWidth: 1,
    borderColor: MON.amber,
    paddingHorizontal: 6,
  },
  goalLine: { fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.label },
  mstats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  mstat: { fontFamily: MON_FONT_OSD, fontSize: 16, color: MON.osd },
  mprog: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mbar: {
    flex: 1,
    height: 12,
    backgroundColor: MON.barBg,
    borderWidth: 1,
    borderColor: MON.phosphorDim,
    overflow: 'hidden',
  },
  mbarFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  mpct: { fontFamily: MON_FONT_OSD, fontSize: 20, color: MON.phosphor, minWidth: 48, textAlign: 'right' },
  costs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 },
  cost: { fontFamily: MON_FONT_MONO, fontSize: 11.5, color: MON.label },
  costK: { fontFamily: MON_FONT_OSD, fontSize: 13 },
  savedTo: { fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.amber },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legend: { flex: 1, fontFamily: MON_FONT_MONO, fontSize: 10.5, color: MON.muted },
  legendX: { fontFamily: MON_FONT_OSD, fontSize: 16, color: MON.muted, paddingHorizontal: 4 },
  pinned: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.amber,
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  pinnedAsk: { fontSize: 13, color: MON.amber, lineHeight: 18 },
  wall: { width: '100%' },
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
  keyOn: { backgroundColor: MON.keyTopOn },
  keyText: { fontFamily: MON_FONT_OSD, fontSize: 15, color: MON.osd },
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
  lines: { gap: 4, minHeight: 64 },
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
