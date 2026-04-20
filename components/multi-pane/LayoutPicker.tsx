// components/multi-pane/LayoutPicker.tsx
//
// Visual preset selector for the 4-pane layout system. Shows a thumbnail
// for each of the 7 presets (p1 / p2h / p2v / p3l / p3r / p3t / p4), marks
// the active one, and disables any preset whose capacity is smaller than
// the number of currently-open panes.
//
// Usage:
//   <LayoutPicker onPicked={close} />
//
// Drop into any bottom sheet or popover. The component is stateless beyond
// the store subscription.

import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import {
  useMultiPaneStore,
  PRESET_CAPACITY,
  type PresetId,
} from '@/hooks/use-multi-pane';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

type PresetEntry = {
  id: PresetId;
  label: string;
};

const PRESETS: PresetEntry[] = [
  { id: 'p1',  label: '1' },
  { id: 'p2h', label: '2 Cols' },
  { id: 'p2v', label: '2 Rows' },
  { id: 'p3l', label: 'L 1+2' },
  { id: 'p3r', label: 'R 2+1' },
  { id: 'p3t', label: 'T 1+2' },
  { id: 'p3b', label: 'B 2+1' },
  { id: 'p4',  label: '2×2' },
];

export function LayoutPicker({ onPicked }: { onPicked?: () => void }) {
  const preset   = useMultiPaneStore((s) => s.preset);
  const slots    = useMultiPaneStore((s) => s.slots);
  const setPreset = useMultiPaneStore((s) => s.setPreset);

  const used = useMemo(
    () => slots.filter((s) => s !== null).length,
    [slots],
  );

  // Every tile is now tappable. Downsizing to a smaller preset trims surplus
  // panes in setPreset; disabling tiles for `used > capacity` was the old
  // behavior and it trapped users in p4 with no UI path back to p1.
  return (
    <View style={styles.root}>
      <Text style={styles.title}>LAYOUT</Text>
      <View style={styles.grid}>
        {PRESETS.map((p) => {
          const capacity = PRESET_CAPACITY[p.id];
          const willTrim = used > capacity;
          const active = preset === p.id;
          return (
            <Pressable
              key={p.id}
              style={[
                styles.tile,
                active && styles.tileActive,
              ]}
              onPress={() => {
                setPreset(p.id);
                onPicked?.();
              }}
            >
              <PresetThumbnail preset={p.id} active={active} disabled={false} />
              <Text
                style={[
                  styles.label,
                  active && styles.labelActive,
                ]}
              >
                {p.label}
                {willTrim ? ` (-${used - capacity})` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ─── Thumbnail rendering ────────────────────────────────────────────────────
//
// Each thumbnail is a miniature absolute-positioned version of the real
// layout. We reuse the same rect formulas so the user sees exactly what
// they'll get. Fixed size so it fits in a preset tile.

const THUMB_W = 56;
const THUMB_H = 36;
const BORDER = 1;

type Rect = { left: number; top: number; width: number; height: number };

function thumbRects(preset: PresetId): Rect[] {
  const W = THUMB_W - BORDER * 2;
  const H = THUMB_H - BORDER * 2;
  const half = (v: number) => Math.round(v * 0.5);
  switch (preset) {
    case 'p1':
      return [{ left: 0, top: 0, width: W, height: H }];
    case 'p2h': {
      const mx = half(W);
      return [
        { left: 0,  top: 0, width: mx, height: H },
        { left: mx, top: 0, width: W - mx, height: H },
      ];
    }
    case 'p2v': {
      const my = half(H);
      return [
        { left: 0, top: 0,  width: W, height: my },
        { left: 0, top: my, width: W, height: H - my },
      ];
    }
    case 'p3l': {
      const mx = half(W), ry = half(H);
      return [
        { left: 0,  top: 0,  width: mx, height: H },
        { left: mx, top: 0,  width: W - mx, height: ry },
        { left: mx, top: ry, width: W - mx, height: H - ry },
      ];
    }
    case 'p3r': {
      const mx = half(W), ly = half(H);
      return [
        { left: 0,  top: 0,  width: mx, height: ly },
        { left: 0,  top: ly, width: mx, height: H - ly },
        { left: mx, top: 0,  width: W - mx, height: H },
      ];
    }
    case 'p3t': {
      const my = half(H), bx = half(W);
      return [
        { left: 0,  top: 0,  width: W, height: my },
        { left: 0,  top: my, width: bx, height: H - my },
        { left: bx, top: my, width: W - bx, height: H - my },
      ];
    }
    case 'p3b': {
      const my = half(H), tx = half(W);
      return [
        { left: 0,  top: 0,  width: tx, height: my },
        { left: tx, top: 0,  width: W - tx, height: my },
        { left: 0,  top: my, width: W, height: H - my },
      ];
    }
    case 'p4': {
      const mx = half(W), my = half(H);
      return [
        { left: 0,  top: 0,  width: mx, height: my },
        { left: mx, top: 0,  width: W - mx, height: my },
        { left: 0,  top: my, width: mx, height: H - my },
        { left: mx, top: my, width: W - mx, height: H - my },
      ];
    }
  }
}

function PresetThumbnail({
  preset,
  active,
  disabled,
}: {
  preset: PresetId;
  active: boolean;
  disabled: boolean;
}) {
  const rects = thumbRects(preset);
  const cellColor = disabled
    ? 'rgba(255,255,255,0.08)'
    : active
      ? withAlpha(C.accent, 0.55)
      : withAlpha(C.accent, 0.25);
  return (
    <View
      style={{
        width: THUMB_W,
        height: THUMB_H,
        borderWidth: BORDER,
        borderColor: active ? C.accent : C.border,
        backgroundColor: C.bgDeep,
        position: 'relative',
      }}
    >
      {rects.map((r, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            borderWidth: 0.5,
            borderColor: C.bgDeep,
            backgroundColor: cellColor,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 6,
  },
  title: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 4,
  },
  tile: {
    width: '31%',
    borderWidth: S.borderWidth,
    borderColor: C.border,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
    backgroundColor: 'transparent',
  },
  tileActive: {
    borderColor: C.accent,
    backgroundColor: withAlpha(C.accent, 0.10),
  },
  tileDisabled: {
    opacity: 0.35,
  },
  label: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    letterSpacing: 0.5,
  },
  labelActive: {
    color: C.accent,
  },
  labelDisabled: {
    color: C.text3,
  },
});
