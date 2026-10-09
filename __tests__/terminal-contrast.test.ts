import * as fs from 'fs';
import * as path from 'path';
import {
  contrastRatio,
  darkenStep,
  dimMinimumContrast,
  dimToward,
  ensureMinimumContrast,
  isLightBackground,
  lightenStep,
  parseHexColor,
  relativeLuminance,
  remapGrayRampForLightTheme,
  resolveTerminalMinimumContrast,
  xtermDefaultColor,
} from '@/lib/terminal-contrast';
import { getTerminalTheme } from '@/lib/terminal-theme';

const BEIGE = 0xe8e3d0; // Case File bgDeep — the surface behind a transparent terminal
const INK = 0x1e1a12; // Case File terminal foreground
const BLACK = 0x000000;

function hue(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

describe('contrast math basics', () => {
  it('black/white is 21:1 and symmetric', () => {
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 5);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 5);
    expect(contrastRatio(0x777777, 0x777777)).toBe(1);
  });

  it('classifies backgrounds', () => {
    expect(isLightBackground(BEIGE)).toBe(true);
    expect(isLightBackground(0xffffff)).toBe(true);
    expect(isLightBackground(BLACK)).toBe(false);
    expect(isLightBackground(0x282a36)).toBe(false); // Dracula
  });

  it('darken/lighten steps hit the endpoints and preserve hue', () => {
    expect(darkenStep(0x87d787, 0)).toBe(0x87d787);
    expect(darkenStep(0x87d787, 256)).toBe(0x000000);
    expect(lightenStep(0x23407a, 0)).toBe(0x23407a);
    expect(lightenStep(0x23407a, 256)).toBe(0xffffff);
    expect(hueDistance(darkenStep(0x5fd7ff, 128), 0x5fd7ff)).toBeLessThan(3);
    expect(hueDistance(lightenStep(0x23407a, 128), 0x23407a)).toBeLessThan(3);
  });
});

describe('ensureMinimumContrast', () => {
  // Typical dark-terminal TUI colors that wash out on beige (Codex CLI uses
  // light greens/cyans/grays for file names, args and the footer).
  const washedOut = [
    0x87d787, // 256-color 114 light green
    0xa8a8a8, // 256-color 248 gray
    0x5fd7ff, // 256-color 81 light cyan
    0xd7d7af, // 256-color 187 pale yellow
    0xffffff, // pure white (lighter than the background!)
    0xb0c4de, // truecolor light steel blue
  ];

  it.each(washedOut)('lifts %s to >= 3:1 on beige by darkening, keeping hue', (fg) => {
    expect(contrastRatio(fg, BEIGE)).toBeLessThan(3);
    const out = ensureMinimumContrast(fg, BEIGE, 3);
    expect(contrastRatio(out, BEIGE)).toBeGreaterThanOrEqual(3);
    expect(relativeLuminance(out)).toBeLessThan(relativeLuminance(BEIGE));
    // grays have no hue; colored inputs keep theirs
    const isGray = ((fg >> 16) & 0xff) === ((fg >> 8) & 0xff) && ((fg >> 8) & 0xff) === (fg & 0xff);
    if (!isGray) expect(hueDistance(out, fg)).toBeLessThan(4);
  });

  it.each(washedOut)('adjusts %s minimally (one step less would still fail)', (fg) => {
    const out = ensureMinimumContrast(fg, BEIGE, 3);
    // find the step that produced `out` and check the previous step fails
    let step = 0;
    while (step <= 256 && darkenStep(fg, step) !== out) step++;
    expect(step).toBeLessThanOrEqual(256);
    expect(step).toBeGreaterThan(0);
    expect(contrastRatio(darkenStep(fg, step - 1), BEIGE)).toBeLessThan(3);
  });

  it('leaves colors that already pass untouched', () => {
    expect(ensureMinimumContrast(INK, BEIGE, 3)).toBe(INK);
    expect(ensureMinimumContrast(0xffffff, BLACK, 4.5)).toBe(0xffffff);
  });

  it('is a no-op when disabled (<= 1)', () => {
    expect(ensureMinimumContrast(0xeeeeee, BEIGE, 1)).toBe(0xeeeeee);
    expect(ensureMinimumContrast(0xeeeeee, BEIGE, 0)).toBe(0xeeeeee);
    expect(ensureMinimumContrast(0xeeeeee, BEIGE, NaN)).toBe(0xeeeeee);
  });

  it('lightens too-dark text on dark backgrounds', () => {
    const fg = 0x3a3a3a; // 256-color 237 on black
    const out = ensureMinimumContrast(fg, BLACK, 3);
    expect(contrastRatio(out, BLACK)).toBeGreaterThanOrEqual(3);
    expect(relativeLuminance(out)).toBeGreaterThan(relativeLuminance(fg));
    const navy = 0x000087; // 256-color 18 on Dracula
    const out2 = ensureMinimumContrast(navy, 0x282a36, 3);
    expect(contrastRatio(out2, 0x282a36)).toBeGreaterThanOrEqual(3);
    expect(hueDistance(out2, navy)).toBeLessThan(4);
  });

  it('falls back to the readable extreme when the floor is unreachable', () => {
    expect(ensureMinimumContrast(0x808080, 0x777777, 21)).toBe(0x000000);
    expect(ensureMinimumContrast(0x202020, 0x101010, 21)).toBe(0xffffff);
  });

  it('honours ratios above 3 (4.5:1 setting)', () => {
    const out = ensureMinimumContrast(0x87d787, BEIGE, 4.5);
    expect(contrastRatio(out, BEIGE)).toBeGreaterThanOrEqual(4.5);
  });

  it('ignores alpha bytes in the inputs', () => {
    expect(ensureMinimumContrast(0xff87d787 | 0, 0xffe8e3d0 | 0, 3)).toBe(ensureMinimumContrast(0x87d787, BEIGE, 3));
  });
});

describe('dim (SGR 2)', () => {
  it('equals the legacy c*2/3 over black', () => {
    for (const fg of [0xffffff, 0x87d787, 0x123456, 0x010203]) {
      const legacy =
        ((((fg >> 16) & 0xff) * 2 / 3 | 0) << 16) |
        ((((fg >> 8) & 0xff) * 2 / 3 | 0) << 8) |
        ((fg & 0xff) * 2 / 3 | 0);
      expect(dimToward(fg, BLACK)).toBe(legacy);
    }
  });

  it('fades toward the paper on a light background (not darker)', () => {
    const dimmed = dimToward(INK, BEIGE);
    expect(relativeLuminance(dimmed)).toBeGreaterThan(relativeLuminance(INK));
    expect(relativeLuminance(dimmed)).toBeLessThan(relativeLuminance(BEIGE));
  });

  it('gets a softer floor that still stays readable', () => {
    expect(dimMinimumContrast(3)).toBeCloseTo(2.5);
    expect(dimMinimumContrast(1)).toBe(1);
    const dimmed = dimToward(0xa8a8a8, BEIGE);
    const out = ensureMinimumContrast(dimmed, BEIGE, dimMinimumContrast(3));
    expect(contrastRatio(out, BEIGE)).toBeGreaterThanOrEqual(2.5);
    // still lighter than the same color at the full floor -> visibly dimmer
    expect(relativeLuminance(out)).toBeGreaterThanOrEqual(
      relativeLuminance(ensureMinimumContrast(0xa8a8a8, BEIGE, 3)),
    );
  });
});

describe('xterm 256 palette + light gray-ramp remap', () => {
  it('matches the Termux default palette', () => {
    expect(xtermDefaultColor(16)).toBe(0x000000);
    expect(xtermDefaultColor(81)).toBe(0x5fd7ff);
    expect(xtermDefaultColor(114)).toBe(0x87d787);
    expect(xtermDefaultColor(231)).toBe(0xffffff);
    expect(xtermDefaultColor(232)).toBe(0x080808);
    expect(xtermDefaultColor(248)).toBe(0xa8a8a8);
    expect(xtermDefaultColor(255)).toBe(0xeeeeee);
  });

  it('matches every entry of TerminalColorScheme.java DEFAULT_COLORSCHEME (16..255)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalColorScheme.java'),
      'utf8',
    );
    const block = src.slice(src.indexOf('DEFAULT_COLORSCHEME = {'), src.indexOf('};', src.indexOf('DEFAULT_COLORSCHEME = {')));
    const values = Array.from(block.matchAll(/0x[0-9a-f]{8}/gi)).map((m) => parseInt(m[0].slice(4), 16));
    for (let i = 16; i < 256; i++) expect(xtermDefaultColor(i)).toBe(values[i]);
  });

  it('runs from near-background (232) to near-foreground (255), monotonically', () => {
    const ramp = Array.from({ length: 24 }, (_, i) => remapGrayRampForLightTheme(232 + i, INK, BEIGE));
    expect(contrastRatio(ramp[0], BEIGE)).toBeLessThan(1.1);
    expect(contrastRatio(ramp[23], INK)).toBeLessThan(1.5);
    for (let i = 1; i < ramp.length; i++) {
      expect(relativeLuminance(ramp[i])).toBeLessThanOrEqual(relativeLuminance(ramp[i - 1]));
    }
    // Typical "secondary text" grays (244-250) end up readable-ish before the floor.
    expect(contrastRatio(remapGrayRampForLightTheme(250, INK, BEIGE), BEIGE)).toBeGreaterThan(4.5);
  });
});

describe('resolveTerminalMinimumContrast', () => {
  it("'auto' is 3:1 on light surfaces and off on dark ones", () => {
    expect(resolveTerminalMinimumContrast('auto', '#E8E3D0')).toBe(3);
    expect(resolveTerminalMinimumContrast(undefined, '#E8E3D0')).toBe(3);
    expect(resolveTerminalMinimumContrast('auto', '#000000')).toBe(1);
    expect(resolveTerminalMinimumContrast(null, '#282A36')).toBe(1);
    expect(resolveTerminalMinimumContrast('auto', 'not-a-color')).toBe(1);
  });

  it('clamps explicit ratios and treats <= 1 as off', () => {
    expect(resolveTerminalMinimumContrast(4.5, '#000000')).toBe(4.5);
    expect(resolveTerminalMinimumContrast(0, '#E8E3D0')).toBe(1);
    expect(resolveTerminalMinimumContrast(1, '#E8E3D0')).toBe(1);
    expect(resolveTerminalMinimumContrast(99, '#E8E3D0')).toBe(21);
    expect(resolveTerminalMinimumContrast(NaN, '#E8E3D0')).toBe(1);
  });

  it('parses hex colors', () => {
    expect(parseHexColor('#E8E3D0')).toBe(BEIGE);
    expect(parseHexColor('e8e3d0')).toBe(BEIGE);
    expect(parseHexColor('#FFF')).toBeNull();
    expect(parseHexColor(undefined)).toBeNull();
  });
});

describe('Case File palette is untouched by the default 3:1 floor', () => {
  const theme = getTerminalTheme('case-file');
  const keys = [
    'foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
    'brightMagenta', 'brightCyan', 'brightWhite',
  ] as const;
  it.each(keys)('%s', (key) => {
    const fg = parseHexColor(theme[key])!;
    expect(ensureMinimumContrast(fg, BEIGE, 3)).toBe(fg);
  });
});

describe('Java port stays in sync with the TS reference', () => {
  const java = fs.readFileSync(
    path.join(__dirname, '..', 'modules/terminal-view/android/src/main/java/com/termux/view/MinimumContrast.java'),
    'utf8',
  );
  // Load-bearing expressions that must be identical in both implementations.
  it.each([
    'v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)',
    '0.2126 * LINEAR_LUT[r] + 0.7152 * LINEAR_LUT[g] + 0.0722 * LINEAR_LUT[b]',
    'darken ? (lb + 0.05) / target - 0.05 : target * (lb + 0.05) - 0.05',
    '(((fg >> 16) & 0xff) * keep + 128) >> 8',
    '255 - (((255 - ((fg >> 16) & 0xff)) * keep + 128) >> 8)',
    'if (darken ? l <= needed : l >= needed) hi = mid;',
    'minRatio > 1 ? 1 + (minRatio - 1) * 0.75 : minRatio',
    '8 + (index - 232) * 10',
  ])('contains `%s`', (expr) => {
    expect(java).toContain(expr);
    const ts = fs.readFileSync(path.join(__dirname, '..', 'lib/terminal-contrast.ts'), 'utf8');
    expect(ts).toContain(expr);
  });
});
