package android.util;

/** JVM stub for the OSC 8 harness (__tests__/claude-glibc-s2.test.ts). */
public final class Base64 {
    public static byte[] decode(String s, int flags) {
        return java.util.Base64.getMimeDecoder().decode(s);
    }

    public static String encodeToString(byte[] b, int flags) {
        return java.util.Base64.getEncoder().encodeToString(b);
    }
}
