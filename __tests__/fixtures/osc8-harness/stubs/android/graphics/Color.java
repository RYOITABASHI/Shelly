package android.graphics;

/** JVM stub for the OSC 8 harness. */
public final class Color {
    public static int red(int c) { return (c >> 16) & 0xFF; }
    public static int green(int c) { return (c >> 8) & 0xFF; }
    public static int blue(int c) { return c & 0xFF; }
}
