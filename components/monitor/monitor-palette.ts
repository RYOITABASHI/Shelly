/**
 * components/monitor/monitor-palette.ts — the MONITOR pane's fixed palette.
 *
 * Deliberate exception to the "use useTheme() colors" rule: the monitor wall
 * is a green-phosphor CRT surveillance console whose look is the feature
 * itself (the operator portraits are pre-dithered to this exact phosphor
 * ramp), so it must not follow the user's theme preset. Same precedent as
 * TerminalPane's fixed TERMINAL_SURFACE_BACKGROUND. Every color the pane uses
 * lives in this one block.
 */
import type { ImageSourcePropType } from 'react-native';
import type { MonitorAgentState } from '@/lib/monitor-source';
import type { MonitorProviderKind } from '@/lib/monitor-team';

export const MON = {
  room: '#0b0f0d',
  bezel: '#1b221e',
  bezelHi: '#2d3832',
  panel: '#08100c',
  screen: '#03100a',
  phosphor: '#a8f0cf',
  phosphorMid: '#5fc796',
  phosphorDim: '#2a6a4c',
  osd: '#eaf5ee',
  label: '#a9b7ae',
  muted: '#6c7a71',
  rec: '#ff4436',
  amber: '#ffb21e',
  amberDeep: '#1c1608',
  done: '#8fa6bd',
  fail: '#ff6b5e',
  kApi: '#7cc7ff',
  kCli: '#d4a8ff',
  kLocal: '#a8f0cf',
  kAuto: '#a9b7ae',
  barBg: '#02140c',
  keyTop: '#3b453f',
  keyTopOn: '#25553f',
  keyEdge: '#070908',
  ledOff: '#141a17',
  black: '#000000',
  scanline: 'rgba(0,0,0,0.30)',
  interference: 'rgba(168,240,207,0.07)',
  consoleLight: 'rgba(255,255,255,0.16)',
  osdShadow: 'rgba(0,0,0,0.9)',
  pillBg: 'rgba(0,0,0,0.55)',
} as const;

/** Pixel/OSD face (bundled, loaded in app/_layout.tsx) and mono face. */
export const MON_FONT_OSD = 'DotGothic16_400Regular';
export const MON_FONT_MONO = 'JetBrainsMono_400Regular';

export function stateColor(state: MonitorAgentState): string {
  switch (state) {
    case 'STANDBY':
      return MON.muted;
    case 'APPROVAL':
      return MON.amber;
    case 'DONE':
      return MON.done;
    case 'FAILED':
      return MON.fail;
    default:
      return MON.phosphor;
  }
}

export function kindColor(kind: MonitorProviderKind): string {
  switch (kind) {
    case 'API':
      return MON.kApi;
    case 'CLI':
      return MON.kCli;
    case 'LOCAL':
      return MON.kLocal;
    default:
      return MON.kAuto;
  }
}

type Look = 'live' | 'dim' | 'alert' | 'fail';

const OPERATORS: Record<number, Record<Look, ImageSourcePropType>> = {
  1: {
    live: require('@/assets/images/monitor/operator-1-live.png'),
    dim: require('@/assets/images/monitor/operator-1-dim.png'),
    alert: require('@/assets/images/monitor/operator-1-alert.png'),
    fail: require('@/assets/images/monitor/operator-1-fail.png'),
  },
  2: {
    live: require('@/assets/images/monitor/operator-2-live.png'),
    dim: require('@/assets/images/monitor/operator-2-dim.png'),
    alert: require('@/assets/images/monitor/operator-2-alert.png'),
    fail: require('@/assets/images/monitor/operator-2-fail.png'),
  },
  3: {
    live: require('@/assets/images/monitor/operator-3-live.png'),
    dim: require('@/assets/images/monitor/operator-3-dim.png'),
    alert: require('@/assets/images/monitor/operator-3-alert.png'),
    fail: require('@/assets/images/monitor/operator-3-fail.png'),
  },
  4: {
    live: require('@/assets/images/monitor/operator-4-live.png'),
    dim: require('@/assets/images/monitor/operator-4-dim.png'),
    alert: require('@/assets/images/monitor/operator-4-alert.png'),
    fail: require('@/assets/images/monitor/operator-4-fail.png'),
  },
  5: {
    live: require('@/assets/images/monitor/operator-5-live.png'),
    dim: require('@/assets/images/monitor/operator-5-dim.png'),
    alert: require('@/assets/images/monitor/operator-5-alert.png'),
    fail: require('@/assets/images/monitor/operator-5-fail.png'),
  },
};

/** live = RUNNING/WAITING, alert = APPROVAL, dim = STANDBY/DONE, fail = FAILED. */
export function operatorImage(operator: number, state: MonitorAgentState): ImageSourcePropType {
  const set = OPERATORS[operator] ?? OPERATORS[1];
  if (state === 'RUNNING' || state === 'WAITING') return set.live;
  if (state === 'APPROVAL') return set.alert;
  if (state === 'FAILED') return set.fail;
  return set.dim;
}
