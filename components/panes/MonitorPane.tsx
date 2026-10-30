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
import {
  ACTIVE_STATES,
  formatTokens,
  summarize,
  USD_TO_YEN,
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
  const { t } = useTranslation();
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
  const run = useMemo(
    () => ({ id: runId, source: createDemoSource(demoDateLabel()), startWall: Date.now() }),
    [runId],
  );
  const { source, startWall } = run;
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
  const sec = Math.floor(playT);
  const timestamp = formatClock(startWall + playT * 1000);
  const defById = useMemo(() => Object.fromEntries(source.agents.map((d) => [d.id, d])), [source]);
  const selectedDef = defById[selectedId] ?? source.agents[0];

  const statusLabel = snap.complete
    ? t('monitor.mission_complete')
    : snap.approvalPending
      ? t('monitor.waiting_for_you')
      : t('monitor.done_count', { n: summary.done, total: summary.total });

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
          {team.meta ? <Text style={{ color: MON.muted }}>{`  ${team.meta}`}</Text> : null}
        </Text>
        <View style={styles.mstats}>
          <Text style={[styles.mstat, { color: MON.phosphor }]}>
            {t('monitor.run_count', { n: summary.running, max: MAX_PARALLEL_BRANCHES })}
          </Text>
          <Text style={[styles.mstat, (snap.complete || snap.approvalPending) && { color: MON.amber }]}>
            {statusLabel}
          </Text>
          <Text style={styles.mstat}>{`T+${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`}</Text>
        </View>
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
          <Text style={styles.mpct}>{`${summary.missionPct}%`}</Text>
        </View>
        <View style={styles.costs}>
          <Text style={styles.cost}>
            <Text style={[styles.costK, { color: kindColor('API') }]}> API </Text>
            {` ${t('monitor.cost_api')} `}
            <Text style={{ color: MON.osd }}>{`$${summary.apiUsd.toFixed(4)}`}</Text>
            <Text style={{ color: MON.muted }}>{` ≈ ¥${(summary.apiUsd * USD_TO_YEN).toFixed(1)}`}</Text>
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
            {' · ¥0'}
          </Text>
          {source.isDemo && (
            <Text style={[styles.cost, { color: MON.muted }]}>{t('monitor.cost_sample', { yen: USD_TO_YEN })}</Text>
          )}
        </View>
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
          onChange={(next) => setMonitorTeam(next === source.team ? null : next)}
        />
      )}

      {/* ── Wall ── */}
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
                    single={false}
                    sideBySide={false}
                    compactText={!isWide || isCompact}
                    onPress={() => select(d.id)}
                  />
                </View>
              ))}
              <View style={{ width: camW }}>
                <NoSignalCamera channel={`CH-0${source.agents.length + 1}`} reduceMotion={reduceMotion} />
              </View>
            </View>
          )
        )}
      </View>

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
        <Text style={styles.chatHead}>
          {t('monitor.chat_head')}
          {source.isDemo ? <Text style={{ color: MON.amber }}>{`  ${t('monitor.demo_badge')}`}</Text> : null}
        </Text>
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
