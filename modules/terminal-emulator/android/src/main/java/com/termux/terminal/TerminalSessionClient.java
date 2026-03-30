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

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * The interface for communication between {@link TerminalSession} and its client. It is used to
 * send callbacks to the client when {@link TerminalSession} changes or for sending other
 * back data to the client like logs.
 */
public interface TerminalSessionClient {

    void onTextChanged(@NonNull TerminalSession changedSession);

    void onTitleChanged(@NonNull TerminalSession changedSession);

    void onSessionFinished(@NonNull TerminalSession finishedSession);

    void onCopyTextToClipboard(@NonNull TerminalSession session, String text);

    void onPasteTextFromClipboard(@Nullable TerminalSession session);

    void onBell(@NonNull TerminalSession session);

    void onColorsChanged(@NonNull TerminalSession session);

    void onTerminalCursorStateChange(boolean state);

    void setTerminalShellPid(@NonNull TerminalSession session, int pid);



    Integer getTerminalCursorStyle();



    void logError(String tag, String message);

    void logWarn(String tag, String message);

    void logInfo(String tag, String message);

    void logDebug(String tag, String message);

    void logVerbose(String tag, String message);

    void logStackTraceWithMessage(String tag, String message, Exception e);

    void logStackTrace(String tag, Exception e);

}
