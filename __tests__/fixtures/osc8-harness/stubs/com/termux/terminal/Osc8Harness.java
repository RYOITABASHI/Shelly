package com.termux.terminal;

import java.nio.charset.StandardCharsets;

/**
 * Feeds real terminal bytes through the vendored TerminalEmulator and prints
 * every URI the OSC 8 observer receives, one per line prefixed "URI ".
 * Usage: java Osc8Harness <chunk-size> <hex-encoded input bytes>
 */
public final class Osc8Harness {
    public static void main(String[] args) {
        int chunk = Integer.parseInt(args[0]);
        byte[] in = hex(args[1]);
        TerminalEmulator.sHyperlinkObserver = uri -> System.out.println("URI " + uri);
        TerminalOutput out = new TerminalOutput() {
            @Override public void write(byte[] data, int offset, int count) {}
            @Override public void titleChanged(String oldTitle, String newTitle) {}
            @Override public void onCopyTextToClipboard(String text) {}
            @Override public void onPasteTextFromClipboard() {}
            @Override public void onBell() {}
            @Override public void onColorsChanged() {}
        };
        TerminalSessionClient client = new TerminalSessionClient() {
            @Override public Integer getTerminalCursorStyle() { return 0; }
            @Override public void onTerminalCursorStateChange(boolean state) {}
        };
        TerminalEmulator emu = new TerminalEmulator(out, 40, 10, 10, 20, 100, client);
        for (int i = 0; i < in.length; i += chunk) {
            // chunks model PTY reads split at arbitrary byte boundaries
            int n = Math.min(chunk, in.length - i);
            byte[] part = new byte[n];
            System.arraycopy(in, i, part, 0, n);
            emu.append(part, n);
        }
        System.out.println("SCREEN " + emu.getScreen().getTranscriptText().replace('\n', '|'));
        System.out.flush();
    }

    private static byte[] hex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    @SuppressWarnings("unused")
    private static final java.nio.charset.Charset UTF8 = StandardCharsets.UTF_8;
}
