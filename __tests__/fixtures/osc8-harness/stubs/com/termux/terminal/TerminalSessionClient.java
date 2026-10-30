package com.termux.terminal;

/** JVM stub for the OSC 8 harness: only what TerminalEmulator calls. */
public interface TerminalSessionClient {
    Integer getTerminalCursorStyle();
    void onTerminalCursorStateChange(boolean state);
}
