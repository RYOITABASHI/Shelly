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
  formatTokens,
  type MonitorAgentDef,
  type MonitorAgentSnapshot,
} from '@/lib/monitor-source';
import { MON, MON_FONT_MONO, MON_FONT_OSD, kindColor, operatorImage, stateColor } from './monitor-palette';
import { translateMonitorText } from './monitor-i18n';

/** Prototype canvas space; overlay geometry is authored in it. */
const CW = 240;
const CH = 160;

type Props = {
  def: MonitorAgentDef;
  snap: MonitorAgentSnapshot;
  parentChannel?: string;
  clock: SharedValue<number>;
  reduceMotion: boolean;
  timestamp: string;
  showTimestamp: boolean;
  /** Single (enlarged) view: shows the log list instead of the last line. */
  single: boolean;
  /** Single view on a wide screen: screen and HUD side by side. */
  sideBySide: boolean;
  compactText: boolean;
  onPress: () => void;
};

export function costText(def: MonitorAgentDef, a: MonitorAgentSnapshot, flatLabel: string): string {
  if (def.kind === 'LOCAL') return `${formatTokens(a.tokens)} · ¥0`;
  if (def.kind === 'CLI') return `${formatTokens(a.tokens)} · ${flatLabel}`;
  return `$${a.usd.toFixed(4)} · ${formatTokens(a.tokens)}`;
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
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.35} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={w} height={h} fill="url(#cl)" />
    </Svg>
  );
}

function MeterBar({
  index,
  scale,
  clock,
  seed,
  color,
  talkingMode,
  reduceMotion,
}: {
  index: number;
  scale: number;
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
    return { height: hgt * scale, top: (112 - hgt) * scale };
  });
  return (
    <Animated.View
      style={[
        { position: 'absolute', left: (10 + index * 5) * scale, width: 3 * scale, backgroundColor: color },
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
  compactText,
}: Pick<Props, 'def' | 'snap' | 'clock' | 'reduceMotion' | 'timestamp' | 'showTimestamp' | 'compactText'>) {
  const { t } = useTranslation();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - size.w) > 0.5 || Math.abs(height - size.h) > 0.5) setSize({ w: width, h: height });
  };
  const seed = def.operator * 1.13;
  const st = snap.state;
  const scale = size.w / CW;
  const active = ACTIVE_STATES.has(st);

  const imageStyle = useAnimatedStyle(() => {
    const t = clock.value;
    const still = reduceMotion ? 0 : 1;
    const z = 1.05 + still * 0.03 * Math.sin(t * 0.23 + seed);
    let dx = still * Math.sin(t * 0.17 + seed) * 5;
    const dy = still * Math.cos(t * 0.21 + seed) * 3 + (st === 'STANDBY' ? 4 : 0);
    // Occasional signal tear: a brief horizontal jolt.
    if (still && Math.sin(t * 1.3 + seed * 2) > 0.985) dx += Math.sin(t * 40) * 9;
    return { transform: [{ translateX: dx * scale }, { translateY: dy * scale }, { scale: z }] as const };
  });
  const lightStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.6 : 0.6 + 0.3 * Math.sin(clock.value * 7.3 + seed),
  }));
  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (((clock.value * 40) % (CH + 16)) - 12) * scale }],
  }));
  const recStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 : Math.floor(clock.value * 2) % 2 === 0 ? 1 : 0,
  }));
  const bangStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 : Math.floor(clock.value * 3) % 2 === 0 ? 1 : 0,
  }));

  const pillColor = stateColor(st);
  const osdSize = compactText ? 13 : 16;

  return (
    <View style={styles.screen} onLayout={onLayout}>
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
                scale={scale}
                clock={clock}
                seed={seed}
                color={st === 'APPROVAL' ? MON.amber : MON.phosphor}
                talkingMode={st === 'APPROVAL' ? 'always' : 'interval'}
                reduceMotion={reduceMotion}
              />
            ))}
          {st === 'APPROVAL' && (
            <Animated.View style={[StyleSheet.absoluteFill, bangStyle]} pointerEvents="none">
              <View style={[styles.bang, { left: 212 * scale, top: 40 * scale, width: 9 * scale, height: 28 * scale }]} />
              <View style={[styles.bang, { left: 212 * scale, top: 74 * scale, width: 9 * scale, height: 9 * scale }]} />
            </Animated.View>
          )}
          {!reduceMotion && (
            <Animated.View
              pointerEvents="none"
              style={[styles.interference, { height: 7 * scale }, barStyle]}
            />
          )}
          <ScanlineLayer w={size.w} h={size.h} />
        </>
      )}
      <View style={[styles.osd, styles.osdTop]} pointerEvents="none">
        <Text style={[styles.osdText, { fontSize: osdSize }]}>{def.channel}</Text>
        {active && (
          <Animated.Text style={[styles.osdText, { fontSize: osdSize, color: MON.rec }, recStyle]}>
            {t('monitor.rec')}
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
  const { t } = useTranslation();
  const pr = agentProgress(snap);
  const pct = Math.round(pr * 100);
  const isApproval = snap.state === 'APPROVAL';
  const fill = stateColor(snap.state === 'STANDBY' || snap.state === 'RUNNING' || snap.state === 'WAITING' ? 'RUNNING' : snap.state);
  const lastLine = snap.lines.length ? snap.lines[snap.lines.length - 1] : snap.state === 'STANDBY' ? t('monitor.standby_line') : '';
  const logLines = useMemo(() => snap.lines.slice(-8), [snap.lines]);
  const note = translateMonitorText(t, snap.note);

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
            {t('monitor.step', { n: Math.min(snap.logs, snap.totalLogs), total: snap.totalLogs, pct })}
          </Text>
          <Text style={[styles.metaText, { color: MON.osd }]} numberOfLines={1}>
            {costText(def, snap, t('monitor.cost_flat'))}
          </Text>
        </View>
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
export function NoSignalCamera({ channel, reduceMotion }: { channel: string; reduceMotion: boolean }) {
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
  return (
    <View style={styles.cam}>
      <View style={styles.screen}>
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
});
