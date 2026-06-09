import { Platform } from "react-native";

import { themeColors } from "@/theme.config";

export type ColorScheme = "light" | "dark";

export const ThemeColors = themeColors;

type ThemeColorTokens = typeof ThemeColors;
type ThemeColorName = keyof ThemeColorTokens;
type SchemePalette = Record<ColorScheme, Record<ThemeColorName, string>>;
type SchemePaletteItem = SchemePalette[ColorScheme];

function buildSchemePalette(colors: ThemeColorTokens): SchemePalette {
  const palette: SchemePalette = {
    light: {} as SchemePalette["light"],
    dark: {} as SchemePalette["dark"],
  };

  (Object.keys(colors) as ThemeColorName[]).forEach((name) => {
    const swatch = colors[name];
    palette.light[name] = swatch.light;
    palette.dark[name] = swatch.dark;
  });

  return palette;
}

export const SchemeColors = buildSchemePalette(ThemeColors);

type RuntimePalette = SchemePaletteItem & {
  text: string;
  background: string;
  tint: string;
  icon: string;
  tabIconDefault: string;
  tabIconSelected: string;
  border: string;
};

function buildRuntimePalette(scheme: ColorScheme): RuntimePalette {
  const base = SchemeColors[scheme];
  return {
    ...base,
    text: base.foreground,
    background: base.background,
    tint: base.primary,
    icon: base.muted,
    tabIconDefault: base.muted,
    tabIconSelected: base.primary,
    border: base.border,
  };
}

export const Colors = {
  light: buildRuntimePalette("light"),
  dark: buildRuntimePalette("dark"),
} satisfies Record<ColorScheme, RuntimePalette>;

export type ThemeColorPalette = (typeof Colors)[ColorScheme];

type RuntimeThemeSource = {
  bgDeep: string;
  bgSurface: string;
  bgSidebar: string;
  btnSecondaryBg: string;
  text1: string;
  text2: string;
  text3: string;
  border: string;
  accent: string;
  accentGreen: string;
  accentBlue: string;
  accentPurple: string;
  accentCode: string;
  warning: string;
  errorText: string;
};

export function refreshRuntimeThemeColors(palette: RuntimeThemeSource) {
  const base = {
    primary: palette.accent,
    background: palette.bgDeep,
    backgroundDeep: palette.bgDeep,
    surface: palette.bgSurface,
    surfaceHigh: palette.bgSidebar,
    surface2: palette.btnSecondaryBg,
    foreground: palette.text1,
    foregroundDim: palette.text1,
    muted: palette.text2,
    inactive: palette.text3,
    hint: palette.text3,
    border: palette.border,
    borderLight: palette.border,
    borderHeavy: palette.border,
    success: palette.accentGreen,
    warning: palette.warning,
    error: palette.errorText,
    accent: palette.accent,
    prompt: palette.accent,
    command: palette.accentCode,
    tint: palette.accent,
    link: palette.accentBlue,
    aiPurple: palette.accentPurple,
    interpretPurple: palette.accentPurple,
    interpretText: palette.accentPurple,
    keyLabel: palette.text2,
    infoText: palette.text2,
  };

  const runtime = {
    ...base,
    text: base.foreground,
    background: base.background,
    tint: base.primary,
    icon: base.muted,
    tabIconDefault: base.muted,
    tabIconSelected: base.primary,
  };

  Object.assign(Colors.light, runtime);
  Object.assign(Colors.dark, runtime);
}

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: "system-ui",
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: "ui-serif",
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: "ui-rounded",
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
