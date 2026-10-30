/**
 * components/monitor/MonitorMap.tsx — the MONITOR pane's MAP view: an
 * editable "column" wiring editor with live playback state.
 *
 * Steps run left → right in columns; nodes stacked in one column run at the
 * same time. Edges are derived (lib/monitor-team.ts deriveEdges) — the user
 * never draws a line. Long-press + drag moves a node between columns; tap
 * opens the inline editor (role / provider / ask-before-writing / move).
 * Every edit goes through the pure model, which refuses invalid shapes; the
 * refusal is shown as a short inline message. No modal, no confirm card.
 *
 * LIVE (readOnly): the map is the wiring of a real run — no editing, and the
 * provider line shows what the run actually used (the camera def), not the
 * team node's planned provider.
 *
 * REGISTER (DEMO / DRAFT): hands the team to the AI chat as an agent draft
 * (lib/monitor-team-registration.ts) — the user confirms there with a plain
 * "OK", same as `@agent`. Enabled only for a team that passes validate().
 * RUN NOW appears once a registered agent is shown (also in LIVE).
 * TEAM FILE shows the text form (copy) and loads a pasted one; parse and
 * shape errors are shown inline under the paste box.
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from '@/lib/i18n';
import { logInfo } from '@/lib/debug-logger';
import {
  addNode,
  deriveEdges,
  destinationPath,
  findNode,
  makeParallel,
  moveNode,
  parseTeamFile,
  validate,
  MONITOR_PROVIDER_KIND,
  MONITOR_PROVIDER_LABEL,
  MONITOR_PROVIDERS,
  removeNode,
  resolveDropTarget,
  serializeTeamFile,
  shiftNode,
  updateNode,
  type MonitorTeam,
  type MonitorTeamError,
  type MonitorTeamNode,
  type MonitorTeamResult,
} from '@/lib/monitor-team';
import {
  agentProgress,
  edgeState,
  summarize,
  formatMoney,
  formatTokens,
  type MonitorAgentDef,
  type MonitorEdgeState,
  type MonitorSnapshot,
} from '@/lib/monitor-source';
import { MON, MON_FONT_MONO, MON_FONT_OSD, kindColor, stateColor } from './monitor-palette';
import { translateMonitorText } from './monitor-i18n';

const COL_W = 156;
const GAP = 40;
const NODE_H = 76;
const ROW_GAP = 12;
const PAD = 14;
const LANE_H = 24;
const GOAL_H = 104;

const colX = (c: number) => PAD + c * (COL_W + GAP);
const rowY = (r: number) => PAD + LANE_H + r * (NODE_H + ROW_GAP);

type Placed = { node: MonitorTeamNode; x: number; y: number; column: number; sub: boolean };

function layout(team: MonitorTeam) {
  const placed: Record<string, Placed> = {};
  let maxRows = 1;
  team.columns.forEach((col, c) => {
    col.forEach((node, r) => {
      placed[node.id] = { node, x: colX(c), y: rowY(r), column: c, sub: false };
    });
    const subs = team.subAgents.filter((s) => col.some((n) => n.id === s.parentId));
    subs.forEach((s, j) => {
      placed[s.id] = { node: s, x: colX(c), y: rowY(col.length + j), column: c, sub: true };
    });
    maxRows = Math.max(maxRows, col.length + subs.length);
  });
  const last = team.columns[team.columns.length - 1]?.[0];
  const goalX = colX(team.columns.length);
  const goalY = last ? placed[last.id].y + NODE_H / 2 - GOAL_H / 2 : rowY(0);
  const height = Math.max(rowY(maxRows) + PAD, goalY + GOAL_H + PAD);
  const width = goalX + COL_W + PAD;
  return { placed, goalX, goalY, width, height };
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

function Edge({
  d,
  state,
  sub,
  clock,
  reduceMotion,
}: {
  d: string;
  state: MonitorEdgeState;
  sub: boolean;
  clock: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const moving = (state === 'flow' || state === 'pending') && !reduceMotion;
  const period = state === 'pending' ? 1.4 : 0.7;
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: moving ? -((clock.value / period) % 1) * 18 : 0,
  }));
  const stroke =
    state === 'pending' ? MON.amber : state === 'done' ? MON.done : state === 'flow' || state === 'held' ? MON.phosphor : MON.phosphorDim;
  const opacity = state === 'idle' ? 0.55 : state === 'held' ? 0.6 : state === 'done' ? 0.9 : 1;
  const dash = state === 'flow' || state === 'pending' ? '10 8' : sub && state !== 'done' ? '4 6' : undefined;
  return (
    <AnimatedPath
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={3}
      strokeOpacity={opacity}
      strokeDasharray={dash}
      animatedProps={animatedProps}
    />
  );
}

type NodeProps = {
  placed: Placed;
  def?: MonitorAgentDef;
  snap: MonitorSnapshot;
  selected: boolean;
  onTap: (id: string) => void;
  onDrop: (id: string, dropX: number) => void;
  readOnly: boolean;
};

function MapNode({ placed, def, snap, selected, onTap, onDrop, readOnly }: NodeProps) {
  const { t } = useTranslation();
  const { node, x, y, sub } = placed;
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const lifted = useSharedValue(0);
  const a = snap.agents[node.id];
  const state = a?.state ?? 'STANDBY';
  const pr = a ? agentProgress(a) : 0;
  const kind = readOnly && def ? def.kind : MONITOR_PROVIDER_KIND[node.provider];
  const providerLabel = readOnly && def ? def.providerName : MONITOR_PROVIDER_LABEL[node.provider];

  const pan = Gesture.Pan()
    .enabled(!sub && !readOnly)
    .activateAfterLongPress(320)
    .onStart(() => {
      lifted.value = withTiming(1, { duration: 120 });
    })
    .onUpdate((e) => {
      tx.value = e.translationX;
      ty.value = e.translationY;
    })
    .onEnd((e) => {
      runOnJS(onDrop)(node.id, x + COL_W / 2 + e.translationX);
    })
    .onFinalize(() => {
      tx.value = 0;
      ty.value = 0;
      lifted.value = withTiming(0, { duration: 120 });
    });
  const tap = Gesture.Tap().enabled(!readOnly).onEnd(() => {
    runOnJS(onTap)(node.id);
  });
  const gesture = Gesture.Exclusive(pan, tap);

  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: 1 + lifted.value * 0.05 }] as const,
    zIndex: lifted.value > 0 ? 10 : 1,
    opacity: 1 - lifted.value * 0.15,
  }));

  const border = selected ? MON.amber : state === 'STANDBY' ? MON.phosphorDim : stateColor(state);
  const title = def ? `${def.channel} ${node.name ?? def.name}` : node.name ?? node.role;
  const line3 =
    state === 'STANDBY'
      ? translateMonitorText(t, a?.note) || (def ? '' : node.role)
      : `${t(`monitor.state.${state}`)}  ${Math.round(pr * 100)}%`;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityRole="button"
        accessibilityLabel={title}
        style={[styles.node, { left: x, top: y, borderColor: border, borderStyle: sub ? 'dashed' : 'solid' }, dragStyle]}
      >
        <Text style={styles.n1} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.n2} numberOfLines={1}>
          <Text style={{ color: kindColor(kind) }}>{kind}</Text>
          {` · ${providerLabel}`}
          {node.askBeforeWrite ? ` · ${t('monitor.map.ask_short')}` : ''}
        </Text>
        <Text style={[styles.n3, { color: state === 'STANDBY' ? MON.muted : stateColor(state) }]} numberOfLines={1}>
          {line3}
        </Text>
        <View style={styles.pbg}>
          <View style={[styles.pfg, { width: `${Math.round(pr * 100)}%`, backgroundColor: stateColor(state === 'STANDBY' ? 'RUNNING' : state) }]} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

type Props = {
  team: MonitorTeam;
  defaultTeam: MonitorTeam;
  defs: readonly MonitorAgentDef[];
  snap: MonitorSnapshot;
  clock: SharedValue<number>;
  reduceMotion: boolean;
  /** DEMO source: edits are a local preview only (not saved, not run). */
  isDemo: boolean;
  /** Wide layout: the goal node also repeats MISSION % and API cost. On
   *  folded/compact widths the mission bar already shows them. */
  wide: boolean;
  /** Run date (YYYY-MM-DD) filled into the destination path. */
  date: string;
  onChange: (team: MonitorTeam) => void;
  /** LIVE: show the run's wiring without the editor. */
  readOnly?: boolean;
  /** REGISTER key (editable map only). Omitted = no key. */
  onRegister?: () => void;
  /** A registration is waiting for the chat OK — the key is disabled. */
  registerBusy?: boolean;
  /** One status line under the register row (e.g. "confirm in chat"). */
  registerNote?: string | null;
  /** RUN NOW key for the registered agent. Omitted = no key. */
  onRunNow?: () => void;
  runNowBusy?: boolean;
  /** A pasted team file was loaded (defaults to onChange). */
  onLoadTeam?: (team: MonitorTeam) => void;
};

export function MonitorMap({
  team,
  defaultTeam,
  defs,
  snap,
  clock,
  reduceMotion,
  isDemo,
  wide,
  date,
  onChange,
  readOnly = false,
  onRegister,
  registerBusy = false,
  registerNote = null,
  onRunNow,
  runNowBusy = false,
  onLoadTeam,
}: Props) {
  const { t, locale } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newRole, setNewRole] = useState('');
  const [showFile, setShowFile] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shapeErrors = useMemo(() => validate(team), [team]);
  const geo = useMemo(() => layout(team), [team]);
  const edges = useMemo(() => deriveEdges(team), [team]);
  const defById = useMemo(() => Object.fromEntries(defs.map((d) => [d.id, d])), [defs]);
  const summary = summarize(defs, snap);

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(id);
  }, [message]);

  const errorText = (e: MonitorTeamError) => t(`monitor.map.err.${e.code}`);
  const commit = (res: MonitorTeamResult, what: string) => {
    if ('error' in res) {
      logInfo('Monitor', `map edit refused: ${what} (${res.error.code})`);
      setMessage(errorText(res.error));
      return false;
    }
    if (res.team !== team) onChange(res.team);
    setMessage(null);
    return true;
  };

  const onDrop = (id: string, dropX: number) => {
    const target = resolveDropTarget(dropX, team.columns.length, COL_W, GAP, PAD);
    commit(moveNode(team, id, target), `move ${id}`);
  };

  const selected = selectedId
    ? findNode(team, selectedId)?.node ?? team.subAgents.find((s) => s.id === selectedId) ?? null
    : null;
  const selectedIsSub = !!selected && team.subAgents.some((s) => s.id === selected.id);
  const selectedCol = selected && !selectedIsSub ? findNode(team, selected.id)?.column ?? -1 : -1;

  const edgePath = (from: Placed, toX: number, toY: number, sub: boolean) => {
    if (sub) {
      const sx = from.x + 10;
      return `M${sx} ${from.y + NODE_H} L ${sx} ${toY}`;
    }
    const x1 = from.x + COL_W;
    const y1 = from.y + NODE_H / 2;
    const mx = (x1 + toX) / 2;
    return `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${toY}, ${toX} ${toY}`;
  };

  const fileText = serializeTeamFile(team, t('monitor.map.file_parallel'), locale);
  const loadPasted = () => {
    const res = parseTeamFile(paste);
    if ('error' in res) {
      const e = res.error;
      logInfo('Monitor', `team file refused (${e.code})`);
      setPasteError(
        e.code === 'syntax'
          ? t('monitor.map.file_err_syntax', { line: (e as { line: number }).line })
          : e.code === 'too_long'
            ? t('monitor.map.file_err_too_long')
            : errorText(e as MonitorTeamError),
      );
      return;
    }
    setPasteError(null);
    setPaste('');
    setSelectedId(null);
    if (res.ok) (onLoadTeam ?? onChange)(res.team);
  };
  const copyFile = () => {
    Clipboard.setStringAsync(fileText)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  const canRegister = shapeErrors.length === 0 && !registerBusy;

  const goalLit = snap.complete;
  const finalId = team.columns[team.columns.length - 1]?.[0]?.id;
  const finalState = finalId ? snap.agents[finalId]?.state : undefined;

  return (
    <View style={styles.map}>
      <Text style={styles.cap}>{t('monitor.map.caption')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={{ width: geo.width, height: geo.height }}>
          <Svg width={geo.width} height={geo.height} style={StyleSheet.absoluteFill}>
            {edges.map((e) => {
              const from = geo.placed[e.from];
              if (!from) return null;
              let d: string;
              if (e.to === 'goal') d = edgePath(from, geo.goalX, from.y + NODE_H / 2, false);
              else {
                const to = geo.placed[e.to];
                if (!to) return null;
                d = e.sub ? edgePath(from, to.x, to.y, true) : edgePath(from, to.x, to.y + NODE_H / 2, false);
              }
              return (
                <Edge
                  key={e.id}
                  d={d}
                  sub={!!e.sub}
                  state={edgeState(e, snap.agents)}
                  clock={clock}
                  reduceMotion={reduceMotion}
                />
              );
            })}
          </Svg>
          {team.columns.map((col, c) => (
            <Text key={`lane-${c}`} style={[styles.lane, { left: colX(c), top: PAD }]} numberOfLines={1}>
              {col.length > 1
                ? t('monitor.map.lane_parallel', { n: col.length })
                : t('monitor.map.lane_step', { n: c + 1 })}
            </Text>
          ))}
          <Text style={[styles.lane, { left: geo.goalX, top: PAD }]}>{t('monitor.map.lane_result')}</Text>
          {Object.values(geo.placed).map((p) => (
            <MapNode
              key={p.node.id}
              placed={p}
              def={defById[p.node.id]}
              snap={snap}
              selected={selectedId === p.node.id}
              onTap={(id) => setSelectedId((cur) => (cur === id ? null : id))}
              onDrop={onDrop}
              readOnly={readOnly}
            />
          ))}
          <View
            style={[
              styles.goal,
              { left: geo.goalX, top: geo.goalY },
              goalLit ? styles.goalLit : null,
            ]}
          >
            <Text style={styles.goalTitle} numberOfLines={1}>
              {t('monitor.map.goal_title')}
            </Text>
            {team.destination && (
              <>
                <Text style={styles.destLabel} numberOfLines={1}>
                  {team.destination.label}
                </Text>
                <Text style={styles.n2} numberOfLines={1} ellipsizeMode="head">
                  {destinationPath(team.destination, date)}
                </Text>
              </>
            )}
            {goalLit || finalState === 'FAILED' || finalState === 'STOPPED' || wide ? (
              <Text style={styles.n2} numberOfLines={1}>
                {goalLit
                  ? t(team.destination ? 'monitor.map.goal_done' : 'monitor.map.goal_done_plain')
                  : finalState === 'STOPPED'
                    ? t('monitor.map.goal_stopped')
                    : finalState === 'FAILED'
                      ? t('monitor.map.goal_failed')
                      : t('monitor.map.goal_progress', { pct: summary.missionPct })}
              </Text>
            ) : null}
            {wide && (
              <Text style={styles.n2} numberOfLines={1}>
                {`API ${summary.apiUsdKnown ? formatMoney(summary.apiUsd, locale) : formatTokens(summary.apiTokens)}`}
              </Text>
            )}
          </View>
        </View>
      </ScrollView>

      {!readOnly && <Text style={styles.hint}>{t('monitor.map.hint')}</Text>}
      {isDemo && (
        <Text style={styles.demoNote} testID="monitor-map-demo-note">
          {t('monitor.map.demo_note')}
        </Text>
      )}
      {message && (
        <Text style={styles.message} accessibilityLiveRegion="polite">
          {message}
        </Text>
      )}

      {selected && !readOnly && (
        <NodeEditor
          key={selected.id}
          node={selected}
          isSub={selectedIsSub}
          column={selectedCol}
          team={team}
          onCommit={commit}
          onClose={() => setSelectedId(null)}
        />
      )}

      {!readOnly && <View style={styles.toolRow}>
        {adding ? (
          <View style={styles.addRow}>
            <TextInput
              value={newRole}
              onChangeText={setNewRole}
              placeholder={t('monitor.map.add_placeholder')}
              placeholderTextColor={MON.muted}
              style={styles.input}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => {
                const res = addNode(team, { role: newRole });
                if (commit(res, 'add')) {
                  setNewRole('');
                  setAdding(false);
                  if (res.ok && res.id) setSelectedId(res.id);
                }
              }}
            />
            <MapKey
              label={t('monitor.map.add_confirm')}
              onPress={() => {
                const res = addNode(team, { role: newRole });
                if (commit(res, 'add')) {
                  setNewRole('');
                  setAdding(false);
                  if (res.ok && res.id) setSelectedId(res.id);
                }
              }}
            />
            <MapKey label={t('monitor.map.cancel')} onPress={() => setAdding(false)} />
          </View>
        ) : (
          <>
            <MapKey label={t('monitor.map.add')} onPress={() => setAdding(true)} />
            <MapKey label={t('monitor.map.file')} pressed={showFile} onPress={() => setShowFile((v) => !v)} />
            <MapKey
              label={t('monitor.map.reset')}
              onPress={() => {
                setSelectedId(null);
                onChange(defaultTeam);
              }}
            />
          </>
        )}
      </View>}
      {showFile && !readOnly && (
        <View style={styles.file} testID="monitor-map-file">
          <Text style={styles.fileText} selectable>
            {fileText}
          </Text>
          <View style={styles.chips}>
            <MapKey label={copied ? t('monitor.map.file_copied') : t('monitor.map.file_copy')} onPress={copyFile} />
          </View>
          <Text style={styles.fieldLabel}>{t('monitor.map.file_paste_label')}</Text>
          <TextInput
            value={paste}
            onChangeText={(v) => {
              setPaste(v);
              setPasteError(null);
            }}
            multiline
            placeholder={t('monitor.map.file_paste_placeholder')}
            placeholderTextColor={MON.muted}
            style={[styles.input, styles.pasteInput]}
            autoCapitalize="none"
            autoCorrect={false}
            testID="monitor-map-paste"
          />
          <View style={styles.chips}>
            <MapKey label={t('monitor.map.file_load')} onPress={loadPasted} />
          </View>
          {pasteError && (
            <Text style={styles.message} accessibilityLiveRegion="polite" testID="monitor-map-paste-error">
              {pasteError}
            </Text>
          )}
        </View>
      )}

      {((onRegister && !readOnly) || onRunNow) && (
        <View style={styles.toolRow} testID="monitor-map-register-row">
          {onRegister && !readOnly && (
            <MapKey
              label={t('monitor.map.register')}
              onPress={onRegister}
              disabled={!canRegister}
              testID="monitor-map-register"
            />
          )}
          {onRunNow && (
            <MapKey label={t('monitor.map.run_now')} onPress={onRunNow} disabled={runNowBusy} testID="monitor-map-run-now" />
          )}
        </View>
      )}
      {onRegister && !readOnly && shapeErrors.length > 0 && (
        <Text style={styles.message} testID="monitor-map-register-blocked">
          {t('monitor.map.register_blocked', { reason: errorText(shapeErrors[0]) })}
        </Text>
      )}
      {registerNote && (
        <Text style={styles.demoNote} accessibilityLiveRegion="polite" testID="monitor-map-register-note">
          {registerNote}
        </Text>
      )}
    </View>
  );
}

function MapKey({
  label,
  onPress,
  pressed,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  pressed?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: !!pressed, disabled: !!disabled }}
      style={({ pressed: p }) => [styles.key, (pressed || p) && !disabled && styles.keyOn, disabled && styles.keyOff]}
    >
      <Text style={[styles.keyText, pressed && { color: MON.phosphor }, disabled && { color: MON.muted }]}>{label}</Text>
    </Pressable>
  );
}

function NodeEditor({
  node,
  isSub,
  column,
  team,
  onCommit,
  onClose,
}: {
  node: MonitorTeamNode;
  isSub: boolean;
  column: number;
  team: MonitorTeam;
  onCommit: (res: MonitorTeamResult, what: string) => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [role, setRole] = useState(node.role);
  const others = team.columns.flatMap((col, c) => (c === column ? [] : col.map((n) => ({ n, c }))));

  return (
    <View style={styles.editor}>
      <View style={styles.editorHead}>
        <Text style={styles.editorTitle} numberOfLines={1}>
          {node.name ?? t('monitor.map.edit_title')}
        </Text>
        <MapKey label={t('monitor.map.close')} onPress={onClose} />
      </View>
      <Text style={styles.fieldLabel}>{t('monitor.map.role_label')}</Text>
      <TextInput
        value={role}
        onChangeText={setRole}
        onEndEditing={() => {
          if (role !== node.role && !onCommit(updateNode(team, node.id, { role }), 'role')) setRole(node.role);
        }}
        style={styles.input}
        placeholderTextColor={MON.muted}
        placeholder={t('monitor.map.add_placeholder')}
        returnKeyType="done"
        blurOnSubmit
      />
      <Text style={styles.fieldLabel}>{t('monitor.map.provider_label')}</Text>
      <View style={styles.chips}>
        {MONITOR_PROVIDERS.map((p) => (
          <MapKey
            key={p}
            label={p === 'auto' ? t('monitor.map.provider_auto') : MONITOR_PROVIDER_LABEL[p]}
            pressed={node.provider === p}
            onPress={() => onCommit(updateNode(team, node.id, { provider: p }), 'provider')}
          />
        ))}
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: node.askBeforeWrite }}
        onPress={() => onCommit(updateNode(team, node.id, { askBeforeWrite: !node.askBeforeWrite }), 'ask')}
        style={styles.toggleRow}
      >
        <View style={[styles.checkbox, node.askBeforeWrite && styles.checkboxOn]} />
        <Text style={styles.toggleText}>{t('monitor.map.ask_before_writing')}</Text>
      </Pressable>
      {!isSub && (
        <>
          <Text style={styles.fieldLabel}>{t('monitor.map.move_label')}</Text>
          <View style={styles.chips}>
            <MapKey label={t('monitor.map.move_earlier')} onPress={() => onCommit(shiftNode(team, node.id, -1), 'shift-left')} />
            <MapKey label={t('monitor.map.move_later')} onPress={() => onCommit(shiftNode(team, node.id, 1), 'shift-right')} />
          </View>
          {others.length > 0 && (
            <>
              <Text style={styles.fieldLabel}>{t('monitor.map.parallel_with')}</Text>
              <View style={styles.chips}>
                {others.map(({ n }) => (
                  <MapKey
                    key={n.id}
                    label={n.name ?? n.role}
                    onPress={() => onCommit(makeParallel(team, node.id, n.id), 'parallel')}
                  />
                ))}
              </View>
            </>
          )}
        </>
      )}
      <View style={styles.chips}>
        <MapKey
          label={t('monitor.map.remove')}
          onPress={() => {
            if (onCommit(removeNode(team, node.id), 'remove')) onClose();
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  cap: { fontFamily: MON_FONT_OSD, fontSize: 16, color: MON.label },
  lane: { position: 'absolute', width: COL_W, fontFamily: MON_FONT_OSD, fontSize: 13, color: MON.muted },
  node: {
    position: 'absolute',
    width: COL_W,
    height: NODE_H,
    backgroundColor: MON.screen,
    borderWidth: 2,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingTop: 5,
    gap: 1,
  },
  n1: { fontFamily: MON_FONT_OSD, fontSize: 14, color: MON.osd },
  n2: { fontFamily: MON_FONT_MONO, fontSize: 10, color: MON.label },
  n3: { fontFamily: MON_FONT_OSD, fontSize: 12 },
  pbg: { height: 4, backgroundColor: MON.barBg, marginTop: 3, overflow: 'hidden' },
  pfg: { height: 4 },
  goal: {
    position: 'absolute',
    width: COL_W,
    height: GOAL_H,
    backgroundColor: MON.panel,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: MON.muted,
    borderRadius: 6,
    padding: 8,
    gap: 3,
  },
  goalLit: { borderStyle: 'solid', borderColor: MON.amber, backgroundColor: MON.amberDeep },
  goalTitle: { fontFamily: MON_FONT_OSD, fontSize: 15, color: MON.amber },
  hint: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.muted },
  demoNote: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.amber },
  destLabel: { fontFamily: MON_FONT_OSD, fontSize: 12, color: MON.osd },
  message: { fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.amber },
  toolRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  addRow: { flexDirection: 'row', flex: 1, gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: MON_FONT_MONO,
    fontSize: 13,
    color: MON.osd,
    backgroundColor: MON.black,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  key: {
    backgroundColor: MON.keyTop,
    borderWidth: 1,
    borderColor: MON.keyEdge,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  keyOn: { backgroundColor: MON.keyTopOn },
  keyOff: { opacity: 0.5 },
  pasteInput: { minHeight: 72, textAlignVertical: 'top' },
  keyText: { fontFamily: MON_FONT_OSD, fontSize: 14, color: MON.osd },
  editor: {
    borderWidth: 1,
    borderColor: MON.amber,
    borderRadius: 10,
    padding: 10,
    gap: 6,
    backgroundColor: MON.screen,
  },
  editorHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  editorTitle: { fontFamily: MON_FONT_OSD, fontSize: 16, color: MON.osd, flexShrink: 1 },
  fieldLabel: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.label },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  checkbox: { width: 16, height: 16, borderWidth: 1, borderColor: MON.phosphorDim, backgroundColor: MON.black },
  checkboxOn: { backgroundColor: MON.amber, borderColor: MON.amber },
  toggleText: { fontFamily: MON_FONT_MONO, fontSize: 12, color: MON.osd },
  file: { backgroundColor: MON.black, borderWidth: 1, borderColor: MON.bezelHi, borderRadius: 8, padding: 8, gap: 6 },
  fileText: { fontFamily: MON_FONT_MONO, fontSize: 11.5, color: MON.phosphor },
});
