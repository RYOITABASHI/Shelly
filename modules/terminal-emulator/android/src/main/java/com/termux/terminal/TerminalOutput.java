/*
 * Copyright (C) 2016-2024 The Termux Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Vendored from https://github.com/termux/termux-app — see VENDORED.md
 */
package com.termux.terminal;

import java.nio.charset.StandardCharsets;

/** A client which receives callbacks from events triggered by feeding input to a {@link TerminalEmulator}. */
public abstract class TerminalOutput {

    /** Write a string using the UTF-8 encoding to the terminal client. */
    public final void write(String data) {
        if (data == null) return;
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        write(bytes, 0, bytes.length);
    }

    /** Write bytes to the terminal client. */
    public abstract void write(byte[] data, int offset, int count);

    /** Notify the terminal client that the terminal title has changed. */
    public abstract void titleChanged(String oldTitle, String newTitle);

    /** Notify the terminal client that text should be copied to clipboard. */
    public abstract void onCopyTextToClipboard(String text);

    /** Notify the terminal client that text should be pasted from clipboard. */
    public abstract void onPasteTextFromClipboard();

    /** Notify the terminal client that a bell character (ASCII 7, bell, BEL, \a, ^G)) has been received. */
    public abstract void onBell();

    public abstract void onColorsChanged();

    /**
     * Return the OS pid of the local shell process driving this PTY, or
     * 0 when no local process is involved (e.g. a stream-based session
     * for socat/SSH). Used by {@link TerminalEmulator#paste(String)} to
     * decide between the readline-compatible C-x C-b trigger (bash
     * prompt) and the standard bracketed-paste markers (any child TUI
     * currently holding the TTY).
     */
    public int getShellPid() {
        return 0;
    }

}
