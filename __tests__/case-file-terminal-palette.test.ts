import * as fs from 'fs';
import * as path from 'path';
import { getTerminalTheme, type TerminalTheme } from '@/lib/terminal-theme';
// Mirrors lib/theme-presets.ts caseFilePalette.bgDeep / .bgSurface (that
// module pulls in react-native, so it can't load in the unit project).
const CASE_FILE_BG_DEEP = '#E8E3D0';
const CASE_FILE_BG_SURFACE = '#F2ECD6';

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not #RRGGBB: ${hex}`);
  const ch = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_KEYS: (keyof TerminalTheme)[] = [
  'foreground', 'cursor',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

describe('Case File terminal palette (retro-PC ink on beige)', () => {
  const theme = getTerminalTheme('case-file');
  // The Case File terminal renders over the cream app surface (wallpaper
  // transparency), so check against both cream tones the pane can sit on.
  const backgrounds = [theme.background, CASE_FILE_BG_DEEP, CASE_FILE_BG_SURFACE];

  it('resolves to the case-file entry, not the dark default', () => {
    expect(theme.name).toBe('case-file');
    expect(theme.background).toBe('#E8E3D0');
  });

  it.each(TEXT_KEYS)('%s is >= 4.5:1 on every beige background', (key) => {
    for (const bg of backgrounds) {
      expect(contrast(theme[key] as string, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('default foreground is high-contrast ink (>= 10:1)', () => {
    for (const bg of backgrounds) {
      expect(contrast(theme.foreground, bg)).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('native emulator palette refresh on attach (regression guard)', () => {
  // Kotlin isn't unit-testable under Jest; guard the fix structurally.
  // TerminalEmulators are built at PTY creation and only snapshot
  // COLOR_SCHEME at construction/reset(), so attach must re-sync a stale
  // emulator or the very first colorScheme prop (boot theme gate) never
  // reaches the screen (white-on-beige Case File regression, build 2469).
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'modules/terminal-view/android/src/main/java/expo/modules/terminalview/ShellyTerminalView.kt'),
    'utf8',
  );

  it('attachShellySession re-syncs the emulator palette', () => {
    const attach = src.slice(src.indexOf('fun attachShellySession('), src.indexOf('private fun scheduleCatchupBlits'));
    expect(attach).toContain('syncEmulatorThemeColors(shellySession)');
    expect(src).toMatch(/private fun syncEmulatorThemeColors[\s\S]*?emulator\.mColors\.reset\(\)/);
  });
});
