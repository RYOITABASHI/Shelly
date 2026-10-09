package com.termux.view;

/**
 * Minimum-contrast safeguard for terminal text (Shelly addition, not vendored).
 * <p>
 * LINE-FOR-LINE PORT of lib/terminal-contrast.ts — that TS file is the
 * reference implementation and is pinned by __tests__/terminal-contrast.test.ts.
 * Change both together. Colors here are ARGB ints; the alpha byte is ignored
 * on input and forced to 0xFF on output.
 * <p>
 * All channel math is integer and non-negative so this and the JS reference
 * give bit-identical results.
 */
public final class MinimumContrast {

    private MinimumContrast() {}

    /** Floor applied by 'auto' on light backgrounds (mirrors AUTO_LIGHT_MIN_CONTRAST). */
    public static final float AUTO_LIGHT_MIN_CONTRAST = 3.0f;
    /** Upper bound of a WCAG contrast ratio. */
    public static final double MAX_CONTRAST = 21;

    /** sRGB channel (0-255) -> linear-light (0-1). */
    public static double channelToLinear(int c) {
        double v = c / 255.0;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    private static final double[] LINEAR_LUT = new double[256];
    static {
        for (int i = 0; i < 256; i++) LINEAR_LUT[i] = channelToLinear(i);
    }

    /** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
    public static double relativeLuminance(int rgb) {
        int r = (rgb >> 16) & 0xff;
        int g = (rgb >> 8) & 0xff;
        int b = rgb & 0xff;
        return 0.2126 * LINEAR_LUT[r] + 0.7152 * LINEAR_LUT[g] + 0.0722 * LINEAR_LUT[b];
    }

    public static double contrastFromLuminance(double la, double lb) {
        double hi = la > lb ? la : lb;
        double lo = la > lb ? lb : la;
        return (hi + 0.05) / (lo + 0.05);
    }

    /** WCAG contrast ratio between two colors (1 .. 21). */
    public static double contrastRatio(int a, int b) {
        return contrastFromLuminance(relativeLuminance(a), relativeLuminance(b));
    }

    /** True when text on this background should be dark (black beats white). */
    public static boolean isLightBackground(int bg) {
        double l = relativeLuminance(bg);
        return contrastFromLuminance(0, l) >= contrastFromLuminance(1, l);
    }

    /** Scale fg toward black by step/256 (hue/saturation preserving). Returns 0xRRGGBB. */
    public static int darkenStep(int fg, int step) {
        int keep = 256 - step;
        int r = (((fg >> 16) & 0xff) * keep + 128) >> 8;
        int g = (((fg >> 8) & 0xff) * keep + 128) >> 8;
        int b = ((fg & 0xff) * keep + 128) >> 8;
        return (r << 16) | (g << 8) | b;
    }

    /** Blend fg toward white by step/256 (hue preserving). Returns 0xRRGGBB. */
    public static int lightenStep(int fg, int step) {
        int keep = 256 - step;
        int r = 255 - (((255 - ((fg >> 16) & 0xff)) * keep + 128) >> 8);
        int g = 255 - (((255 - ((fg >> 8) & 0xff)) * keep + 128) >> 8);
        int b = 255 - (((255 - (fg & 0xff)) * keep + 128) >> 8);
        return (r << 16) | (g << 8) | b;
    }

    /**
     * fg unchanged (as 0xRRGGBB) if it already reaches minRatio against bg;
     * otherwise the least-adjusted hue-preserving darker (light bg) / lighter
     * (dark bg) variant that does. Unreachable floors return black/white.
     * Search runs on luminance (monotonic in the step), not on the V-shaped ratio.
     */
    public static int ensureMinimumContrastRgb(int fg, int bg, double minRatio) {
        fg &= 0xffffff;
        bg &= 0xffffff;
        if (!(minRatio > 1)) return fg;
        double target = minRatio > MAX_CONTRAST ? MAX_CONTRAST : minRatio;
        double lb = relativeLuminance(bg);
        if (contrastFromLuminance(relativeLuminance(fg), lb) >= target) return fg;

        boolean darken = contrastFromLuminance(0, lb) >= contrastFromLuminance(1, lb);
        double needed = darken ? (lb + 0.05) / target - 0.05 : target * (lb + 0.05) - 0.05;
        if (darken ? needed < 0 : needed > 1) return darken ? 0x000000 : 0xffffff;

        int lo = 0;   // known to fail
        int hi = 256; // known to pass (black / white)
        while (hi - lo > 1) {
            int mid = (lo + hi) >> 1;
            double l = relativeLuminance(darken ? darkenStep(fg, mid) : lightenStep(fg, mid));
            if (darken ? l <= needed : l >= needed) hi = mid;
            else lo = mid;
        }
        return darken ? darkenStep(fg, hi) : lightenStep(fg, hi);
    }

    /** ARGB convenience wrapper: opaque result. */
    public static int ensureMinimumContrast(int fg, int bg, double minRatio) {
        return 0xff000000 | ensureMinimumContrastRgb(fg, bg, minRatio);
    }

    /** SGR 2 dim: blend fg 1/3 toward bg (== legacy c*2/3 over black). Returns ARGB. */
    public static int dimToward(int fg, int bg) {
        int r = (2 * ((fg >> 16) & 0xff) + ((bg >> 16) & 0xff)) / 3;
        int g = (2 * ((fg >> 8) & 0xff) + ((bg >> 8) & 0xff)) / 3;
        int b = (2 * (fg & 0xff) + (bg & 0xff)) / 3;
        return 0xff000000 | (r << 16) | (g << 8) | b;
    }

    /** Dim text gets a softer floor so it stays visibly dimmer than normal text. */
    public static double dimMinimumContrast(double minRatio) {
        return minRatio > 1 ? 1 + (minRatio - 1) * 0.75 : minRatio;
    }

    /** xterm's stock palette entry for indices 16..255 (0xRRGGBB). */
    public static int xtermDefaultColor(int index) {
        if (index < 232) {
            int i = index - 16;
            int r = cubeLevel(i / 36);
            int g = cubeLevel((i / 6) % 6);
            int b = cubeLevel(i % 6);
            return (r << 16) | (g << 8) | b;
        }
        int v = 8 + (index - 232) * 10;
        return (v << 16) | (v << 8) | v;
    }

    private static int cubeLevel(int n) {
        return n == 0 ? 0 : n * 40 + 55;
    }

    /**
     * Light-theme remap of the xterm grayscale ramp (232..255): re-anchor the
     * ramp between theme background (232 end) and foreground (255 end).
     * Returns ARGB.
     */
    public static int remapGrayRampForLightTheme(int index, int fg, int bg) {
        double k = (8 + (index - 232) * 10) / 255.0;
        return 0xff000000
            | (mixChannel(fg, bg, 16, k) << 16)
            | (mixChannel(fg, bg, 8, k) << 8)
            | mixChannel(fg, bg, 0, k);
    }

    private static int mixChannel(int fg, int bg, int shift, double k) {
        int b = (bg >> shift) & 0xff;
        int f = (fg >> shift) & 0xff;
        return (int) Math.round(b + (f - b) * k);
    }
}
