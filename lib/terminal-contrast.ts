/**
 * lib/terminal-contrast.ts — minimum-contrast safeguard for terminal text.
 *
 * TUI apps (Codex CLI, etc.) emit 256-color / truecolor foregrounds tuned for
 * dark terminals — light greens/grays/cyans, SGR 2 dim text — that all but
 * vanish on a light theme such as Case File's beige (#E8E3D0). The native
 * renderer enforces a "minimum contrast ratio" floor (iTerm2 / VS Code style):
 * when a cell's resolved foreground has a WCAG contrast ratio below the floor
 * against the cell's effective background, its lightness is pushed toward the
 * readable side (darker on light backgrounds, lighter on dark ones) while the
 * hue is preserved, stopping at the first value that meets the floor.
 *
 * THIS FILE IS THE REFERENCE IMPLEMENTATION. The renderer runs a line-for-line
 * Java port in
 *   modules/terminal-view/android/src/main/java/com/termux/view/MinimumContrast.java
 * Any change to the math here MUST be mirrored there (and vice versa); the
 * jest suite in __tests__/terminal-contrast.test.ts pins the behaviour.
 *
 * Colors are 0xRRGGBB integers (alpha ignored). All channel math is integer
 * and non-negative so JS (`>>`, Math.floor) and Java (`>>`, int division)
 * produce bit-identical results.
 */

/** Setting value: 'auto' picks a default from the background; a number is the
 *  explicit ratio floor (<= 1 means off). */
export type TerminalMinimumContrastSetting = 'auto' | number;

/** Floor applied by 'auto' on light backgrounds. */
export const AUTO_LIGHT_MIN_CONTRAST = 3.0;
/** 'auto' leaves dark schemes untouched (users' palettes stay as authored). */
export const AUTO_DARK_MIN_CONTRAST = 1.0;
/** Upper bound of a WCAG contrast ratio. */
export const MAX_CONTRAST = 21;

/** sRGB channel (0-255) -> linear-light (0-1). */
export function channelToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

const LINEAR_LUT: number[] = Array.from({ length: 256 }, (_, i) => channelToLinear(i));

/** WCAG 2.x relative luminance of 0xRRGGBB, 0 (black) .. 1 (white). */
export function relativeLuminance(rgb: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return 0.2126 * LINEAR_LUT[r] + 0.7152 * LINEAR_LUT[g] + 0.0722 * LINEAR_LUT[b];
}

export function contrastFromLuminance(la: number, lb: number): number {
  const hi = la > lb ? la : lb;
  const lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG contrast ratio between two 0xRRGGBB colors (1 .. 21). */
export function contrastRatio(a: number, b: number): number {
  return contrastFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

/** True when text on this background should be dark (black beats white). */
export function isLightBackground(bg: number): boolean {
  const l = relativeLuminance(bg);
  return contrastFromLuminance(0, l) >= contrastFromLuminance(1, l);
}

/**
 * Scale fg toward black by step/256 (step 0 = unchanged, 256 = black).
 * Scaling every channel by the same factor keeps the HSV hue and saturation.
 */
export function darkenStep(fg: number, step: number): number {
  const keep = 256 - step;
  const r = (((fg >> 16) & 0xff) * keep + 128) >> 8;
  const g = (((fg >> 8) & 0xff) * keep + 128) >> 8;
  const b = ((fg & 0xff) * keep + 128) >> 8;
  return (r << 16) | (g << 8) | b;
}

/**
 * Blend fg toward white by step/256 (step 0 = unchanged, 256 = white).
 * Shrinking every channel's distance to 255 by the same factor keeps the hue.
 */
export function lightenStep(fg: number, step: number): number {
  const keep = 256 - step;
  const r = 255 - (((255 - ((fg >> 16) & 0xff)) * keep + 128) >> 8);
  const g = 255 - (((255 - ((fg >> 8) & 0xff)) * keep + 128) >> 8);
  const b = 255 - (((255 - (fg & 0xff)) * keep + 128) >> 8);
  return (r << 16) | (g << 8) | b;
}

/**
 * Return fg unchanged if it already reaches `minRatio` against bg; otherwise
 * the least-adjusted hue-preserving darker (light bg) / lighter (dark bg)
 * variant that does. If the floor is unreachable (e.g. 21:1 on mid-gray) the
 * extreme (black/white) on the readable side is returned.
 *
 * The search runs on luminance, not on the contrast ratio, because the ratio
 * is V-shaped when fg starts on the "wrong" side of bg (white text on beige
 * must pass through beige on its way to dark) while luminance is monotonic
 * in the step.
 */
export function ensureMinimumContrast(fg: number, bg: number, minRatio: number): number {
  fg &= 0xffffff;
  bg &= 0xffffff;
  if (!(minRatio > 1)) return fg;
  const target = minRatio > MAX_CONTRAST ? MAX_CONTRAST : minRatio;
  const lb = relativeLuminance(bg);
  if (contrastFromLuminance(relativeLuminance(fg), lb) >= target) return fg;

  const darken = contrastFromLuminance(0, lb) >= contrastFromLuminance(1, lb);
  // Luminance the adjusted fg has to cross for (hi+0.05)/(lo+0.05) >= target.
  const needed = darken ? (lb + 0.05) / target - 0.05 : target * (lb + 0.05) - 0.05;
  if (darken ? needed < 0 : needed > 1) return darken ? 0x000000 : 0xffffff;

  let lo = 0;   // known to fail
  let hi = 256; // known to pass (black / white)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const l = relativeLuminance(darken ? darkenStep(fg, mid) : lightenStep(fg, mid));
    if (darken ? l <= needed : l >= needed) hi = mid;
    else lo = mid;
  }
  return darken ? darkenStep(fg, hi) : lightenStep(fg, hi);
}

/**
 * SGR 2 (dim) when the safeguard is on: blend fg one third of the way toward
 * the effective background. Over black this is exactly the legacy xterm/libvte
 * `c * 2 / 3` the renderer used before; over a light background it fades the
 * text toward the paper instead of (wrongly) darkening it into extra emphasis.
 */
export function dimToward(fg: number, bg: number): number {
  const r = (2 * ((fg >> 16) & 0xff) + ((bg >> 16) & 0xff)) / 3 | 0;
  const g = (2 * ((fg >> 8) & 0xff) + ((bg >> 8) & 0xff)) / 3 | 0;
  const b = (2 * (fg & 0xff) + (bg & 0xff)) / 3 | 0;
  return (r << 16) | (g << 8) | b;
}

/** Dim text gets a softer floor so it stays visibly dimmer than normal text. */
export function dimMinimumContrast(minRatio: number): number {
  return minRatio > 1 ? 1 + (minRatio - 1) * 0.75 : minRatio;
}

/** xterm's stock 256-color palette entry for indices 16..255 (0xRRGGBB). */
export function xtermDefaultColor(index: number): number {
  if (index < 232) {
    const i = index - 16;
    const level = (n: number) => (n === 0 ? 0 : n * 40 + 55);
    const r = level(Math.floor(i / 36));
    const g = level(Math.floor(i / 6) % 6);
    const b = level(i % 6);
    return (r << 16) | (g << 8) | b;
  }
  const v = 8 + (index - 232) * 10;
  return (v << 16) | (v << 8) | v;
}

/**
 * Light-theme remap of the xterm grayscale ramp (232..255). On a dark terminal
 * the ramp runs from ~background (232, #080808) to ~foreground (255, #EEEEEE),
 * and TUIs use it that way: 235 for panel fills, 240-246 for secondary text.
 * Taken literally on beige, the upper half is invisible and the lower half
 * paints near-black slabs. Re-anchoring the ramp between the theme background
 * and foreground keeps every step's meaning ("k% of the way from paper to
 * ink") on a light theme.
 */
export function remapGrayRampForLightTheme(index: number, fg: number, bg: number): number {
  const k = (8 + (index - 232) * 10) / 255;
  const mix = (shift: number) => {
    const b = (bg >> shift) & 0xff;
    const f = (fg >> shift) & 0xff;
    return Math.round(b + (f - b) * k);
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/** Parse '#RRGGBB' (or 'RRGGBB') to 0xRRGGBB; null if malformed. */
export function parseHexColor(hex: string | null | undefined): number | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Resolve the user setting to the ratio actually sent to the native view.
 * 'auto'/undefined: 3:1 on light effective backgrounds, off on dark ones.
 * Numbers are clamped to [1, 21]; anything <= 1 (incl. 0) means off.
 */
export function resolveTerminalMinimumContrast(
  setting: TerminalMinimumContrastSetting | undefined | null,
  effectiveBackgroundHex: string,
): number {
  if (setting === undefined || setting === null || setting === 'auto') {
    const bg = parseHexColor(effectiveBackgroundHex);
    if (bg === null) return AUTO_DARK_MIN_CONTRAST;
    return isLightBackground(bg) ? AUTO_LIGHT_MIN_CONTRAST : AUTO_DARK_MIN_CONTRAST;
  }
  if (typeof setting !== 'number' || !Number.isFinite(setting) || setting <= 1) return 1;
  return setting > MAX_CONTRAST ? MAX_CONTRAST : setting;
}
