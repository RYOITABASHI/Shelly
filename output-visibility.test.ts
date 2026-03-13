/**
 * Shelly v2.4.1 — Output Visibility Tests
 *
 * Ensures that stdout/stderr colors always meet minimum contrast requirements
 * against the terminal block background (#1A1A1A) on OLED displays (Z Fold6).
 *
 * WCAG contrast ratio formula:
 *   L1 = relative luminance of lighter color
 *   L2 = relative luminance of darker color
 *   ratio = (L1 + 0.05) / (L2 + 0.05)
 *
 * Targets:
 *   stdout  → WCAG AAA (≥ 7:1)
 *   stderr  → WCAG AA  (≥ 4.5:1)
 *   info    → WCAG AA  (≥ 4.5:1)
 *   prompt  → WCAG AA  (≥ 4.5:1)
 */

import { describe, it, expect } from 'vitest';
import { getOutputColor } from '../lib/output-colors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert 0-255 sRGB channel to linear light */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Parse "#RRGGBB" hex string to relative luminance (0–1) */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two hex colors */
function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Terminal block background color (from TerminalBlock styles.container)
const BLOCK_BG = '#1A1A1A';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getOutputColor — high contrast mode (default ON)', () => {
  it('stdout color meets WCAG AAA (≥ 7:1) against block background', () => {
    const color = getOutputColor('stdout', true);
    const ratio = contrastRatio(color, BLOCK_BG);
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  it('stderr color meets WCAG AA (≥ 4.5:1) against block background', () => {
    const color = getOutputColor('stderr', true);
    const ratio = contrastRatio(color, BLOCK_BG);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('info color meets WCAG AA (≥ 4.5:1) against block background', () => {
    const color = getOutputColor('info', true);
    const ratio = contrastRatio(color, BLOCK_BG);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('prompt color meets WCAG AA (≥ 4.5:1) against block background', () => {
    const color = getOutputColor('prompt', true);
    const ratio = contrastRatio(color, BLOCK_BG);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('stdout opacity equivalent is never below 0.6 (no alpha channel used)', () => {
    // Colors must be solid hex — no rgba with low alpha
    const color = getOutputColor('stdout', true);
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('stderr opacity equivalent is never below 0.6 (no alpha channel used)', () => {
    const color = getOutputColor('stderr', true);
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('getOutputColor — legacy mode (highContrast = false)', () => {
  it('returns a valid hex color for stdout', () => {
    const color = getOutputColor('stdout', false);
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('returns a valid hex color for stderr', () => {
    const color = getOutputColor('stderr', false);
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('returns a different color from high-contrast mode for stdout', () => {
    // Legacy mode intentionally uses dimmer colors
    const hc = getOutputColor('stdout', true);
    const legacy = getOutputColor('stdout', false);
    expect(hc).not.toBe(legacy);
  });
});

describe('getOutputColor — default argument behavior', () => {
  it('defaults to high-contrast mode when second arg is omitted', () => {
    const withDefault = getOutputColor('stdout');
    const withTrue = getOutputColor('stdout', true);
    expect(withDefault).toBe(withTrue);
  });

  it('stdout default color is near-white (#E8E8E8)', () => {
    expect(getOutputColor('stdout')).toBe('#E8E8E8');
  });

  it('stderr default color is high-contrast red (#FF7878)', () => {
    expect(getOutputColor('stderr')).toBe('#FF7878');
  });
});

describe('Contrast ratios — numerical verification', () => {
  it('#E8E8E8 stdout has contrast ratio ≥ 13 against #1A1A1A (OLED-safe)', () => {
    const ratio = contrastRatio('#E8E8E8', '#1A1A1A');
    expect(ratio).toBeGreaterThanOrEqual(13);
  });

  it('#FF7878 stderr has contrast ratio ≥ 5 against #1A1A1A', () => {
    const ratio = contrastRatio('#FF7878', '#1A1A1A');
    expect(ratio).toBeGreaterThanOrEqual(5);
  });

  it('#9BA1A6 info has contrast ratio ≥ 4.5 against #1A1A1A', () => {
    const ratio = contrastRatio('#9BA1A6', '#1A1A1A');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('#00D4AA prompt has contrast ratio ≥ 6 against #1A1A1A', () => {
    const ratio = contrastRatio('#00D4AA', '#1A1A1A');
    expect(ratio).toBeGreaterThanOrEqual(6);
  });
});
