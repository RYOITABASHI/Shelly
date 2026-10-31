/**
 * components/monitor/MonitorCamera.tsx — one surveillance feed on the
 * MONITOR wall: the agent's operator portrait with CRT liveness overlays
 * (scanlines, drift/zoom, rolling interference bar, console-light flicker,
 * radio voice meter, approval "!"), the OSD, and the HUD under it.
 *
 * Every animation is driven by the pane-level `clock` shared value (seconds,
 * UI thread). Under reduced motion the clock never advances and the
 * overlays render as a still frame.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Svg, { Defs, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useTranslation } from '@/lib/i18n';
import {
  agentProgress,
  ACTIVE_STATES,
  formatDuration,
  formatMoney,
  formatTokens,
  type MonitorAgentDef,
  type MonitorAgentSnapshot,
} from '@/lib/monitor-source';
import { MON, MON_FONT_MONO, MON_FONT_OSD, kindColor, operatorImage, stateColor } from './monitor-palette';
import { translateMonitorText } from './monitor-i18n';
import {
  CARD_BORDER,
  CARD_INSET,
  CARD_PAD,
  HUD_BAR_H,
  HUD_GAP,
  HUD_META_H,
  HUD_TICK_H,
  HUD_TITLE_H,
  META_GAP,
  planMetaRow,
  type MonitorHudLevel,
} from './monitor-grid';

/** Prototype canvas space; overlay geometry is authored in it. The canvas is
 *  scaled per axis (sx = w / CW, sy = h / CH), so the overlays keep their
 *  place in a frame of any aspect between a square and 2:1 (monitor-grid.ts
 *  SCREEN_ASPECT_TALL / _WIDE). */
const CW = 240;
const CH = 160;

/** GRID wall fitted to the pane (monitor-grid.ts): the card is exactly the
 *  cell, the picture box is fixed, and the HUD shows `hud` rows only. */
export interface MonitorCameraFit {
  width: number;
  height: number;
  screenW: number;
  screenH: number;
  hud: MonitorHudLevel;
}

type Props = {
  def: MonitorAgentDef;
  snap: MonitorAgentSnapshot;
  parentChannel?: string;
  clock: SharedValue<number>;
  reduceMotion: boolean;
  /** Wall clock for a real run; playback time (T+mm:ss) for the DEMO. */
  timestamp: string;
  showTimestamp: boolean;
  /** DEMO playback: the OSD shows "▶ DEMO" instead of "● REC". */
  demo: boolean;
  /** Single (enlarged) view: shows the log list instead of the last line. */
  single: boolean;
  /** Single view on a wide screen: screen and HUD side by side. */
  sideBySide: boolean;
  compactText: boolean;
  /** Fitted GRID cell; absent = natural size (single view, scroll fallback). */
  fit?: MonitorCameraFit;
  onPress: () => void;
};

export function costText(def: MonitorAgentDef, a: MonitorAgentSnapshot, flatLabel: string, locale: string): string {
  if (def.kind === 'LOCAL') return `${formatTokens(a.tokens)} · ${formatMoney(0, locale)}`;
  if (def.kind === 'CLI') return `${formatTokens(a.tokens)} · ${flatLabel}`;
  // AUTO (provider not reported yet) or an API step whose provider reported
  // no cost: tokens only — never an invented amount.
  if (def.kind === 'AUTO' || a.usd === null) return formatTokens(a.tokens);
  return `${formatMoney(a.usd, locale)} · ${formatTokens(a.tokens)}`;
}

/** LIVE: "⏱ mm:ss · updated Ns ago", or the stale warning. '' on DEMO. */
export function timingText(
  a: MonitorAgentSnapshot,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (a.elapsedSec === undefined && a.updatedAgoSec === undefined) return '';
  const parts: string[] = [];
  if (a.elapsedSec !== undefined) parts.push(t('monitor.live.step_elapsed', { time: formatDuration(a.elapsedSec) }));
  if (a.updatedAgoSec !== undefined && (a.state === 'RUNNING' || a.state === 'APPROVAL')) {
    parts.push(
      a.stale
        ? t('monitor.live.stale', { n: a.updatedAgoSec })
        : t('monitor.live.updated_ago', { n: a.updatedAgoSec }),
    );
  }
  return parts.join(' · ');
}

function ScanlineLayer({ w, h }: { w: number; h: number }) {
  // One SVG per screen: 1px dark line every 3px + a dark vignette.
  return (
    <Svg width={w} height={h} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <Pattern id="scan" x="0" y="0" width={w} height="3" patternUnits="userSpaceOnUse">
          <Rect x="0" y="0" width={w} height="1" fill={MON.black} fillOpacity={0.3} />
        </Pattern>
        <RadialGradient id="vig" cx="50%" cy="50%" rx="60%" ry="60%">
          <Stop offset="0.7" stopColor={MON.black} stopOpacity={0} />
          <Stop offset="1" stopColor={MON.black} stopOpacity={0.6} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={w} height={h} fill="url(#scan)" />
      <Rect x="0" y="0" width={w} height={h} fill="url(#vig)" />
    </Svg>
  );
}

function ConsoleLight({ w, h }: { w: number; h: number }) {
  return (
    <Svg width={w} height={h} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="cl" cx="92%" cy="94%" rx="62%" ry="94%">
          <Stop offset="0" stopColor={MON.glow} stopOpacity={0.35} />
          <Stop offset="1" stopColor={MON.glow} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={w} height={h} fill="url(#cl)" />
    </Svg>
  );
}

function MeterBar({
  index,
  sx,
  sy,
  clock,
  seed,
  color,
  talkingMode,
  reduceMotion,
}: {
  index: number;
  /** Canvas → frame scale, horizontal / vertical. */
  sx: number;
  sy: number;
  clock: SharedValue<number>;
  seed: number;
  color: string;
  /** 'always' (APPROVAL) or 'interval' (RUNNING: talks every other 2.4s). */
  talkingMode: 'always' | 'interval';
  reduceMotion: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const t = clock.value;
    const talking = talkingMode === 'always' || Math.floor(t / 2.4 + seed) % 2 === 0;
    const still = reduceMotion ? 0 : 1;
    const hgt = talking ? 2 + Math.abs(Math.sin(t * 13 + index * 1.3)) * 18 * still : 1;
    return { height: hgt * sy, top: (112 - hgt) * sy };
  });
  return (
    <Animated.View
      style={[
        { position: 'absolute', left: (10 + index * 5) * sx, width: 3 * sx, backgroundColor: color },
        style,
      ]}
    />
  );
}

function CameraScreen({
  def,
  snap,
  clock,
  reduceMotion,
  timestamp,
  showTimestamp,
  demo,
  compactText,
  fit,
}: Pick<Props, 'def' | 'snap' | 'clock' | 'reduceMotion' | 'timestamp' | 'showTimestamp' | 'demo' | 'compactText' | 'fit'>) {
  const { t } = useTranslation();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - size.w) > 0.5 || Math.abs(height - size.h) > 0.5) setSize({ w: width, h: height });
  };
  const seed = def.operator * 1.13;
  const st = snap.state;
  // Canvas → frame scale per axis; the frame may be squarer or wider than
  // the 3:2 canvas, so vertical geometry uses sy and horizontal uses sx.
  const sx = size.w / CW;
  const sy = size.h / CH;
  const active = ACTIVE_STATES.has(st);

  const imageStyle = useAnimatedStyle(() => {
    const t = clock.value;
    const still = reduceMotion ? 0 : 1;
    const z = 1.05 + still * 0.03 * Math.sin(t * 0.23 + seed);
    let dx = still * Math.sin(t * 0.17 + seed) * 5;
    const dy = still * Math.cos(t * 0.21 + seed) * 3 + (st === 'STANDBY' ? 4 : 0);
    // Occasional signal tear: a brief horizontal jolt.
    if (still && Math.sin(t * 1.3 + seed * 2) > 0.985) dx += Math.sin(t * 40) * 9;
    return { transform: [{ translateX: dx * sx }, { translateY: dy * sy }, { scale: z }] as const };
  });
  const lightStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.6 : 0.6 + 0.3 * Math.sin(clock.value * 7.3 + seed),
  }));
  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (((clock.value * 40) % (CH + 16)) - 12) * sy }],
  }));
  const recStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 : Math.floor(clock.value * 2) % 2 === 0 ? 1 : 0,
  }));
  const bangStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 : Math.floor(clock.value * 3) % 2 === 0 ? 1 : 0,
  }));

  const pillColor = stateColor(st);
  // A small fitted picture gets a smaller OSD so it does not cover the face.
  const osdSize = fit && fit.screenH < 90 ? 11 : compactText ? 13 : 16;

  return (
    <View
      style={[styles.screen, fit && { aspectRatio: undefined, width: fit.screenW, height: fit.screenH }]}
      onLayout={onLayout}
    >
      {size.w > 0 && (
        <>
          <Animated.Image
            source={operatorImage(def.operator, st)}
            resizeMode="cover"
            fadeDuration={0}
            style={[styles.portrait, imageStyle]}
          />
          {st === 'RUNNING' && (
            <Animated.View style={[StyleSheet.absoluteFill, lightStyle]} pointerEvents="none">
              <ConsoleLight w={size.w} h={size.h} />
            </Animated.View>
          )}
          {(st === 'RUNNING' || st === 'APPROVAL') &&
            Array.from({ length: 9 }, (_, b) => (
              <MeterBar
                key={b}
                index={b}
                sx={sx}
                sy={sy}
                clock={clock}
                seed={seed}
                color={st === 'APPROVAL' ? MON.amber : MON.phosphor}
                talkingMode={st === 'APPROVAL' ? 'always' : 'interval'}
                reduceMotion={reduceMotion}
              />
            ))}
          {st === 'APPROVAL' && (
            <Animated.View style={[StyleSheet.absoluteFill, bangStyle]} pointerEvents="none">
              <View style={[styles.bang, { left: 212 * sx, top: 40 * sy, width: 9 * sx, height: 28 * sy }]} />
              <View style={[styles.bang, { left: 212 * sx, top: 74 * sy, width: 9 * sx, height: 9 * sy }]} />
            </Animated.View>
          )}
          {!reduceMotion && (
            <Animated.View
              pointerEvents="none"
              style={[styles.interference, { height: 7 * sy }, barStyle]}
            />
          )}
          <ScanlineLayer w={size.w} h={size.h} />
        </>
      )}
      <View style={[styles.osd, styles.osdTop]} pointerEvents="none">
        <Text style={[styles.osdText, { fontSize: osdSize }]}>{def.channel}</Text>
        {active && (
          <Animated.Text
            style={[styles.osdText, { fontSize: osdSize, color: demo ? MON.amber : MON.rec }, recStyle]}
          >
            {demo ? t('monitor.osd_demo') : t('monitor.rec')}
          </Animated.Text>
        )}
      </View>
      <View style={[styles.osd, styles.osdBottom]} pointerEvents="none">
        <Text
          style={[
            styles.osdText,
            styles.pill,
            { fontSize: osdSize - 2, color: pillColor, borderColor: pillColor },
            st === 'WAITING' && styles.pillDashed,
          ]}
          numberOfLines={1}
        >
          {t(`monitor.state.${st}`)}
        </Text>
        {showTimestamp && (
          <Text style={[styles.osdText, { fontSize: osdSize - 2, color: MON.label }]} numberOfLines={1}>
            {timestamp}
          </Text>
        )}
      </View>
    </View>
  );
}

export function KindChip({ kind, size = 13 }: { kind: string; size?: number }) {
  const c = kindColor(kind as never);
  return <Text style={[styles.chip, { color: c, borderColor: c, fontSize: size }]}>{kind}</Text>;
}

function MonitorCameraImpl(props: Props) {
  const { def, snap, single, sideBySide, compactText, parentChannel, onPress } = props;
  const { t, locale } = useTranslation();
  const pr = agentProgress(snap);
  const pct = Math.round(pr * 100);
  const isApproval = snap.state === 'APPROVAL';
  const fill = stateColor(snap.state === 'STANDBY' || snap.state === 'RUNNING' || snap.state === 'WAITING' ? 'RUNNING' : snap.state);
  const lastLine = snap.lines.length ? snap.lines[snap.lines.length - 1] : snap.state === 'STANDBY' ? t('monitor.standby_line') : '';
  const logLines = useMemo(() => snap.lines.slice(-8), [snap.lines]);
  const note = translateMonitorText(t, snap.note);
  const timing = timingText(snap, t);

  if (props.fit && !single) {
    const { fit } = props;
    // One line each: title · provider + % + cost · bar · timer + last output.
    // Rows drop from the bottom as the cell shrinks (monitor-grid.ts).
    const tick = note.length > 0 ? note : lastLine;
    const pctText = `${pct}%`;
    const cost = costText(def, snap, t('monitor.cost_flat'), locale);
    // Narrow cell: keep the cost, shorten / drop the provider, then the %.
    const meta = planMetaRow(fit.width - CARD_INSET, def.kind, def.providerName, pctText, cost);
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${def.channel} ${def.name} · ${def.providerName}`}
        style={[styles.cam, styles.camFit, { width: fit.width, height: fit.height }, isApproval && styles.camApproval]}
        testID={`monitor-cam-${def.id}`}
      >
        {/* The picture box is exactly the picture (never a flex share of the
            card): the HUD rows below it sit at fixed offsets, so no leftover
            height can open a band above them or push them past the card's
            bottom edge. */}
        <View style={[styles.fitScreen, { height: fit.screenH }]} testID={`monitor-cam-picture-${def.id}`}>
          <CameraScreen {...props} />
        </View>
        <View style={styles.fitRow}>
          <Text style={[styles.name, styles.fitName, compactText && { fontSize: 13 }]} numberOfLines={1}>
            {def.name}
          </Text>
          {parentChannel && (
            <Text style={[styles.sub, styles.fitSub]} numberOfLines={1}>
              {t('monitor.sub_of', { channel: parentChannel })}
            </Text>
          )}
        </View>
        {fit.hud !== 'title' && (
          <View style={[styles.fitRow, styles.fitRowMeta]} testID={`monitor-meta-${def.id}`}>
            <KindChip kind={def.kind} size={9} />
            {meta.provider !== null && (
              <Text style={[styles.provName, styles.fitText, styles.fitShrink]} numberOfLines={1}>
                {meta.provider}
              </Text>
            )}
            {meta.showPct && (
              <Text style={[styles.metaText, styles.fitText]} numberOfLines={1}>
                {pctText}
              </Text>
            )}
            <Text style={[styles.metaText, styles.fitText, styles.fitKeep, { color: MON.osd }]} numberOfLines={1}>
              {cost}
            </Text>
          </View>
        )}
        <View style={[styles.bar, styles.fitBar]}>
          <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: fill }]} />
        </View>
        {fit.hud === 'full' && (
          <Text
            style={[styles.tick, styles.fitTick, note.length > 0 && { color: MON.amber }]}
            numberOfLines={1}
            testID={snap.stale ? `monitor-stale-${def.id}` : undefined}
          >
            {timing.length > 0 && (
              <Text style={[styles.metaText, snap.stale && { color: MON.amber }]}>{`${timing}  `}</Text>
            )}
            <Text style={{ color: MON.phosphorDim }}>{'› '}</Text>
            {tick}
          </Text>
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${def.channel} ${def.name} · ${def.providerName}`}
      style={[styles.cam, isApproval && styles.camApproval, sideBySide && styles.camRow]}
    >
      <View style={sideBySide ? { flex: 1.7 } : undefined}>
        <CameraScreen {...props} />
      </View>
      <View style={[styles.hud, sideBySide && { flex: 1 }]}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, compactText && { fontSize: 15 }]} numberOfLines={1}>
            {def.name}
          </Text>
          {parentChannel && (
            <Text style={styles.sub} numberOfLines={1}>
              {t('monitor.sub_of', { channel: parentChannel })}
            </Text>
          )}
        </View>
        <View style={styles.provRow}>
          <KindChip kind={def.kind} />
          <Text style={styles.provName} numberOfLines={1}>
            {def.providerName}
          </Text>
          {(!compactText || single) && (
            <Text style={styles.model} numberOfLines={1}>
              {def.model}
            </Text>
          )}
        </View>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: fill }]} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.metaText} numberOfLines={1}>
            {`${pct}%`}
          </Text>
          <Text style={[styles.metaText, { color: MON.osd }]} numberOfLines={1}>
            {costText(def, snap, t('monitor.cost_flat'), locale)}
          </Text>
        </View>
        {timing.length > 0 && (
          <Text
            style={[styles.metaText, snap.stale && { color: MON.amber }]}
            numberOfLines={1}
            testID={snap.stale ? `monitor-stale-${def.id}` : undefined}
          >
            {timing}
          </Text>
        )}
        {note.length > 0 && <Text style={styles.note}>{note}</Text>}
        {single ? (
          <View style={styles.log}>
            {(logLines.length ? logLines : [t('monitor.standby_line')]).map((l, i) => (
              <Text key={`${i}-${l}`} style={styles.logLine}>
                <Text style={{ color: MON.phosphorDim }}>{'› '}</Text>
                {l}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={styles.tick} numberOfLines={1}>
            <Text style={{ color: MON.phosphorDim }}>{'› '}</Text>
            {lastLine}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export const MonitorCamera = React.memo(MonitorCameraImpl);

/** Empty slot: animated static noise + NO SIGNAL. */
export function NoSignalCamera({
  channel,
  reduceMotion,
  fit,
}: {
  channel: string;
  reduceMotion: boolean;
  /** Fitted GRID cell (see MonitorCameraFit); absent = natural size. */
  fit?: MonitorCameraFit;
}) {
  const { t } = useTranslation();
  const [seed, setSeed] = useState(1);
  React.useEffect(() => {
    if (reduceMotion) return;
    const id = setInterval(() => setSeed((s) => (s * 9301 + 49297) % 233280), 160);
    return () => clearInterval(id);
  }, [reduceMotion]);
  const cells = useMemo(() => {
    let s = seed;
    const out: { x: number; y: number; v: number }[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 12; x++) {
        s = (s * 9301 + 49297) % 233280;
        out.push({ x, y, v: s / 233280 });
      }
    }
    return out;
  }, [seed]);
  const screen = (
    <View style={[styles.screen, fit && { aspectRatio: undefined, width: fit.screenW, height: fit.screenH }]}>
      <Svg width="100%" height="100%" viewBox="0 0 12 8" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        {cells.map((c) => (
          <Rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1} height={1} fill={MON.phosphorDim} fillOpacity={c.v * 0.8} />
        ))}
      </Svg>
      <View style={[styles.osd, styles.osdTop]}>
        <Text style={[styles.osdText, { fontSize: 15 }]}>{channel}</Text>
      </View>
      <View style={[styles.osd, styles.osdBottom]}>
        <Text style={[styles.osdText, styles.pill, { fontSize: 13, color: MON.muted, borderColor: MON.muted }]}>
          {t('monitor.no_signal')}
        </Text>
      </View>
    </View>
  );
  if (fit) {
    return (
      <View style={[styles.cam, styles.camFit, { width: fit.width, height: fit.height }]}>
        <View style={[styles.fitScreen, { height: fit.screenH }]}>{screen}</View>
        <View style={styles.fitRow}>
          <Text style={[styles.name, styles.fitName]} numberOfLines={1}>
            {t('monitor.empty')}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.cam}>
      {screen}
      <View style={styles.hud}>
        <Text style={styles.name}>{t('monitor.empty')}</Text>
        <Text style={styles.model}>{t('monitor.empty_hint')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cam: {
    backgroundColor: MON.bezel,
    borderColor: MON.bezelHi,
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
    gap: 7,
  },
  camApproval: { borderColor: MON.amber, shadowColor: MON.amber, shadowOpacity: 0.6, shadowRadius: 10, elevation: 6 },
  camRow: { flexDirection: 'row', gap: 12 },
  screen: {
    aspectRatio: 3 / 2,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: MON.screen,
    borderWidth: 2,
    borderColor: MON.black,
  },
  portrait: { position: 'absolute', top: '-6%', left: '-6%', width: '112%', height: '112%' },
  bang: { position: 'absolute', backgroundColor: MON.amber },
  interference: { position: 'absolute', left: 0, right: 0, top: 0, backgroundColor: MON.interference },
  osd: { position: 'absolute', left: 8, right: 8, flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  osdTop: { top: 6 },
  osdBottom: { bottom: 6, alignItems: 'flex-end' },
  osdText: {
    fontFamily: MON_FONT_OSD,
    color: MON.osd,
    textShadowColor: MON.osdShadow,
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  pill: { borderWidth: 1, paddingHorizontal: 5, backgroundColor: MON.pillBg },
  pillDashed: { borderStyle: 'dashed' },
  hud: { gap: 5, minWidth: 0 },
  nameRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  name: { fontFamily: MON_FONT_OSD, fontSize: 18, color: MON.osd, flexShrink: 1 },
  sub: { fontFamily: MON_FONT_OSD, fontSize: 14, color: MON.amber },
  provRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  chip: { fontFamily: MON_FONT_OSD, borderWidth: 1, paddingHorizontal: 4 },
  provName: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.osd },
  model: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.muted, flexShrink: 1 },
  bar: { height: 8, backgroundColor: MON.barBg, borderWidth: 1, borderColor: MON.phosphorDim, overflow: 'hidden' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  meta: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  metaText: { fontFamily: MON_FONT_MONO, fontSize: 10.5, color: MON.label, flexShrink: 1 },
  note: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.amber },
  tick: { fontFamily: MON_FONT_MONO, fontSize: 11, color: MON.phosphor },
  log: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 2,
  },
  logLine: { fontFamily: MON_FONT_MONO, fontSize: 11.5, color: MON.phosphor },
  // ── Fitted GRID cell: row heights match monitor-grid.ts exactly ──
  // The card is exactly its content (cellHeightFor) and every child has an
  // explicit height: the picture box gets `fit.screenH` inline (never a flex
  // share of the card), the HUD rows their line heights, and none of them
  // grows or shrinks. Nothing in the card is left to flex distribution, so
  // the rows sit at inset + picture + gaps regardless of how the native
  // layout resolves the card's own height — the on-device clipping bug was a
  // flex:1 picture box that took the card's whole inner height and pushed
  // the caption rows past its clipped bottom edge.
  camFit: { padding: CARD_PAD, borderWidth: CARD_BORDER, gap: HUD_GAP, overflow: 'hidden' },
  fitScreen: {
    flexGrow: 0,
    flexShrink: 0,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflow: 'hidden',
  },
  fitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: META_GAP,
    minWidth: 0,
    height: HUD_TITLE_H,
    flexShrink: 0,
    overflow: 'hidden',
  },
  fitRowMeta: { height: HUD_META_H },
  fitName: { fontSize: 15, lineHeight: HUD_TITLE_H },
  fitSub: { fontSize: 12, lineHeight: HUD_TITLE_H },
  fitText: { lineHeight: HUD_META_H },
  fitTick: { height: HUD_TICK_H, lineHeight: HUD_TICK_H, flexShrink: 0 },
  fitShrink: { flexShrink: 1, minWidth: 0 },
  /** Never squeezed by its row-mates (the plan already made room for it). */
  fitKeep: { flexShrink: 0 },
  fitBar: { height: HUD_BAR_H, flexShrink: 0 },
});
