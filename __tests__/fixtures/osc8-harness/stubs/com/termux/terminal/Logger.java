package com.termux.terminal;

/** JVM stub for the OSC 8 harness (replaces the android.util.Log-backed Logger). */
public final class Logger {
    public static void logError(TerminalSessionClient c, String tag, String m) {}
    public static void logWarn(TerminalSessionClient c, String tag, String m) {}
    public static void logInfo(TerminalSessionClient c, String tag, String m) {}
    public static void logDebug(TerminalSessionClient c, String tag, String m) {}
    public static void logVerbose(TerminalSessionClient c, String tag, String m) {}
    public static void logStackTraceWithMessage(TerminalSessionClient c, String tag, String m, Exception e) {}
}
