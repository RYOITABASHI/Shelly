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
package com.termux.view;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.HapticFeedbackConstants;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewTreeObserver;
import android.view.accessibility.AccessibilityManager;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Scroller;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

import android.util.Log;
import com.termux.terminal.KeyHandler;
import com.termux.terminal.TerminalEmulator;
import com.termux.terminal.TerminalSession;
import com.termux.view.textselection.TextSelectionCursorController;

/** View displaying and interacting with a {@link TerminalSession}. */
public class TerminalView extends View {

    /** Log terminal view key and IME events. */
    private static boolean TERMINAL_VIEW_KEY_LOGGING_ENABLED = false;

    /** The currently displayed terminal session, whose emulator is {@link #mEmulator}. */
    public TerminalSession mTermSession;
    /** Our terminal emulator whose session is {@link #mTermSession}. */
    public TerminalEmulator mEmulator;

    public TerminalRenderer mRenderer;

    public TerminalViewClient mClient;

    private TextSelectionCursorController mTextSelectionCursorController;

    private Handler mTerminalCursorBlinkerHandler;
    private TerminalCursorBlinkerRunnable mTerminalCursorBlinkerRunnable;
    private int mTerminalCursorBlinkerRate;
    private boolean mCursorInvisibleIgnoreOnce;
    public static final int TERMINAL_CURSOR_BLINK_RATE_MIN = 100;
    public static final int TERMINAL_CURSOR_BLINK_RATE_MAX = 2000;

    /**
     * Phase B (2026-04-21): when true, the padding-region bg fill and
     * the "no emulator" fallback black wash in onDraw() are skipped so
     * a wallpaper behind the view shows through. Cells with the default
     * scheme bg are already skipped by TerminalRenderer.render (see the
     * `backColor != palette[BG]` guard); this flag covers the remaining
     * two paint sites.
     */
    private boolean mTransparentBackground;

    public void setTransparentBackground(boolean enabled) {
        mTransparentBackground = enabled;
        invalidate();
    }

    /** The top row of text to display. Ranges from -activeTranscriptRows to 0. */
    int mTopRow;
    int[] mDefaultSelectors = new int[]{-1,-1,-1,-1};

    float mScaleFactor = 1.f;
    final GestureAndScaleRecognizer mGestureRecognizer;

    /** Composing (pre-edit) text from IME, displayed as overlay at cursor position. */
    private String mComposingText = "";
    private final Paint mComposingPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint mComposingBgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    /** Keep track of where mouse touch event started which we report as mouse scroll. */
    private int mMouseScrollStartX = -1, mMouseScrollStartY = -1;
    /** Keep track of the time when a touch event leading to sending mouse scroll events started. */
    private long mMouseStartDownTime = -1;

    final Scroller mScroller;

    /** What was left in from scrolling movement. */
    float mScrollRemainder;

    /** If non-zero, this is the last unicode code point received if that was a combining character. */
    int mCombiningAccent;

    /**
     * IME shadow buffer — tracks characters we've committed to the PTY but
     * haven't yet seen a newline for. Shared between the BaseInputConnection
     * subclass (normal IME path) and onTouchEvent middle-button paste so both
     * paths keep the delete-storm guard in sync. See bug #58.
     */
    final StringBuilder mImeShadow = new StringBuilder();
    /** Timestamp of the last commit flushed from any path (IME or paste). */
    long mLastImeCommitAt = 0;

    /**
     * The current AutoFill type returned for {@link View#getAutofillType()} by {@link #getAutofillType()}.
     *
     * The default is {@link #AUTOFILL_TYPE_NONE} so that AutoFill UI, like toolbar above keyboard
     * is not shown automatically, like on Activity starts/View create. This value should be updated
     * to required value, like {@link #AUTOFILL_TYPE_TEXT} before calling
     * {@link AutofillManager#requestAutofill(View)} so that AutoFill UI shows. The updated value
     * set will automatically be restored to {@link #AUTOFILL_TYPE_NONE} in
     * {@link #autofill(AutofillValue)} so that AutoFill UI isn't shown anymore by calling
     * {@link #resetAutoFill()}.
     */
    @RequiresApi(api = Build.VERSION_CODES.O)
    private int mAutoFillType = AUTOFILL_TYPE_NONE;

    /**
     * The current AutoFill type returned for {@link View#getImportantForAutofill()} by
     * {@link #getImportantForAutofill()}.
     *
     * The default is {@link #IMPORTANT_FOR_AUTOFILL_NO} so that view is not considered important
     * for AutoFill. This value should be updated to required value, like
     * {@link #IMPORTANT_FOR_AUTOFILL_YES} before calling {@link AutofillManager#requestAutofill(View)}
     * so that Android and apps consider the view as important for AutoFill to process the request.
     * The updated value set will automatically be restored to {@link #IMPORTANT_FOR_AUTOFILL_NO} in
     * {@link #autofill(AutofillValue)} by calling {@link #resetAutoFill()}.
     */
    @RequiresApi(api = Build.VERSION_CODES.O)
    private int mAutoFillImportance = IMPORTANT_FOR_AUTOFILL_NO;

    /**
     * The current AutoFill hints returned for {@link View#getAutofillHints()} ()} by {@link #getAutofillHints()} ()}.
     *
     * The default is an empty `string[]`. This value should be updated to required value. The
     * updated value set will automatically be restored an empty `string[]` in
     * {@link #autofill(AutofillValue)} by calling {@link #resetAutoFill()}.
     */
    private String[] mAutoFillHints = new String[0];

    private final boolean mAccessibilityEnabled;

    /** The {@link KeyEvent} is generated from a virtual keyboard, like manually with the {@link KeyEvent#KeyEvent(int, int)} constructor. */
    public final static int KEY_EVENT_SOURCE_VIRTUAL_KEYBOARD = KeyCharacterMap.VIRTUAL_KEYBOARD; // -1

    /** The {@link KeyEvent} is generated from a non-physical device, like if 0 value is returned by {@link KeyEvent#getDeviceId()}. */
    public final static int KEY_EVENT_SOURCE_SOFT_KEYBOARD = 0;

    private static final String LOG_TAG = "TerminalView";

    public TerminalView(Context context, AttributeSet attributes) { // NO_UCD (unused code)
        super(context, attributes);
        mGestureRecognizer = new GestureAndScaleRecognizer(context, new GestureAndScaleRecognizer.Listener() {

            boolean scrolledWithFinger;

            @Override
            public boolean onUp(MotionEvent event) {
                mScrollRemainder = 0.0f;
                if (mEmulator != null && mEmulator.isMouseTrackingActive() && !event.isFromSource(InputDevice.SOURCE_MOUSE) && !isSelectingText() && !scrolledWithFinger) {
                    // Quick event processing when mouse tracking is active - do not wait for check of double tapping
                    // for zooming.
                    sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, true);
                    sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, false);
                    return true;
                }
                scrolledWithFinger = false;
                return false;
            }

            @Override
            public boolean onSingleTapUp(MotionEvent event) {
                if (mEmulator == null) return true;

                if (isSelectingText()) {
                    stopTextSelectionMode();
                    return true;
                }
                requestFocus();
                mClient.onSingleTapUp(event);
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e, float distanceX, float distanceY) {
                if (mEmulator == null) return true;
                android.util.Log.i("TerminalView", "onScroll: dy=" + distanceY + " mouseTracking=" + mEmulator.isMouseTrackingActive() + " altBuffer=" + mEmulator.isAlternateBufferActive() + " source=" + e.getSource());
                if (mEmulator.isMouseTrackingActive() && e.isFromSource(InputDevice.SOURCE_MOUSE)) {
                    sendMouseEventCode(e, TerminalEmulator.MOUSE_LEFT_BUTTON_MOVED, true);
                } else {
                    scrolledWithFinger = true;
                    distanceY += mScrollRemainder;
                    int deltaRows = (int) (distanceY / mRenderer.mFontLineSpacing);
                    mScrollRemainder = distanceY - deltaRows * mRenderer.mFontLineSpacing;
                    doScroll(e, deltaRows);
                }
                return true;
            }

            @Override
            public boolean onScale(float focusX, float focusY, float scale) {
                if (mEmulator == null || isSelectingText()) return true;
                mScaleFactor *= scale;
                mScaleFactor = mClient.onScale(mScaleFactor);
                return true;
            }

            @Override
            public boolean onFling(final MotionEvent e2, float velocityX, float velocityY) {
                if (mEmulator == null) return true;
                // Do not start scrolling until last fling has been taken care of:
                if (!mScroller.isFinished()) return true;

                final boolean mouseTrackingAtStartOfFling = mEmulator.isMouseTrackingActive();
                float SCALE = 0.25f;
                if (mouseTrackingAtStartOfFling) {
                    mScroller.fling(0, 0, 0, -(int) (velocityY * SCALE), 0, 0, -mEmulator.mRows / 2, mEmulator.mRows / 2);
                } else {
                    mScroller.fling(0, mTopRow, 0, -(int) (velocityY * SCALE), 0, 0, -mEmulator.getScreen().getActiveTranscriptRows(), 0);
                }

                post(new Runnable() {
                    private int mLastY = 0;

                    @Override
                    public void run() {
                        if (mouseTrackingAtStartOfFling != mEmulator.isMouseTrackingActive()) {
                            mScroller.abortAnimation();
                            return;
                        }
                        if (mScroller.isFinished()) return;
                        boolean more = mScroller.computeScrollOffset();
                        int newY = mScroller.getCurrY();
                        int diff = mouseTrackingAtStartOfFling ? (newY - mLastY) : (newY - mTopRow);
                        doScroll(e2, diff);
                        mLastY = newY;
                        if (more) post(this);
                    }
                });

                return true;
            }

            @Override
            public boolean onDown(float x, float y) {
                // Why is true not returned here?
                // https://developer.android.com/training/gestures/detector.html#detect-a-subset-of-supported-gestures
                // Although setting this to true still does not solve the following errors when long pressing in terminal view text area
                // ViewDragHelper: Ignoring pointerId=0 because ACTION_DOWN was not received for this pointer before ACTION_MOVE
                // Commenting out the call to mGestureDetector.onTouchEvent(event) in GestureAndScaleRecognizer#onTouchEvent() removes
                // the error logging, so issue is related to GestureDetector
                return false;
            }

            @Override
            public boolean onDoubleTap(MotionEvent event) {
                // Do not treat is as a single confirmed tap - it may be followed by zoom.
                return false;
            }

            @Override
            public void onLongPress(MotionEvent event) {
                if (mGestureRecognizer.isInProgress()) return;
                if (mClient.onLongPress(event)) return;
                if (!isSelectingText()) {
                    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                    startTextSelectionMode(event);
                }
            }
        });
        mScroller = new Scroller(context);
        AccessibilityManager am = (AccessibilityManager) context.getSystemService(Context.ACCESSIBILITY_SERVICE);
        mAccessibilityEnabled = am.isEnabled();
    }



    /**
     * @param client The {@link TerminalViewClient} interface implementation to allow
     *                           for communication between {@link TerminalView} and its client.
     */
    public void setTerminalViewClient(TerminalViewClient client) {
        this.mClient = client;
    }

    /**
     * Sets whether terminal view key logging is enabled or not.
     *
     * @param value The boolean value that defines the state.
     */
    public void setIsTerminalViewKeyLoggingEnabled(boolean value) {
        TERMINAL_VIEW_KEY_LOGGING_ENABLED = value;
    }



    /**
     * Attach a {@link TerminalSession} to this view.
     *
     * @param session The {@link TerminalSession} this view will be displaying.
     */
    public boolean attachSession(TerminalSession session) {
        if (session == mTermSession) return false;
        mTopRow = 0;

        mTermSession = session;
        mEmulator = null;
        mCombiningAccent = 0;

        updateSize();

        // Wait with enabling the scrollbar until we have a terminal to get scroll position from.
        setVerticalScrollBarEnabled(true);

        return true;
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        // Ensure that inputType is only set if TerminalView is selected view with the keyboard and
        // an alternate view is not selected, like an EditText. This is necessary if an activity is
        // initially started with the alternate view or if activity is returned to from another app
        // and the alternate view was the one selected the last time.
        if (mClient.isTerminalViewSelected()) {
            if (mClient.shouldEnforceCharBasedInput()) {
                outAttrs.inputType = InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            } else {
                // TYPE_CLASS_TEXT enables IME composing (inline preview for CJK input).
                // Combined with FLAG_NO_SUGGESTIONS to avoid unwanted autocorrect for ASCII.
                outAttrs.inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            }
        } else {
            // Corresponds to android:inputType="text"
            outAttrs.inputType =  InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL;
        }

        // Note that IME_ACTION_NONE cannot be used as that makes it impossible to input newlines using the on-screen
        // keyboard on Android TV (see https://github.com/termux/termux-app/issues/221).
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN;

        return new BaseInputConnection(this, true) {

            // ===== Shelly IME shadow-buffer strategy =====
            //
            // Soft keyboards on Android are built around an editable text
            // field. They expect to be able to read the "text before the
            // cursor", insert new characters, compose/uncompose runs,
            // delete surrounding text, and generally treat the input
            // target as a living Editable. A PTY is none of those things:
            // it is a one-way byte stream. The impedance mismatch is the
            // source of every IME bug Shelly has hit (paste first-char
            // loss, phantom DEL storms, Nacre sending 25 deletes on the
            // first keypress, etc.).
            //
            // Strategy: we pretend to be a normal Editable-backed field
            // by maintaining a private shadow buffer. Every IME operation
            // is applied to the shadow first and also logged. When the
            // shadow transitions from "user has committed text" to "user
            // wants to send it", we flush the delta to the PTY.
            //
            // Concretely:
            //
            //   * setComposingText(x, ...) — the IME is showing x as its
            //     in-progress preview. We store x as the current compose
            //     run and update the Editable. We do NOT write to the PTY
            //     yet, because the user has not confirmed.
            //
            //   * commitText(x, ...) — the user confirmed x. We erase any
            //     in-progress compose from the PTY (we never wrote it
            //     there, so this is a no-op in practice), then send x to
            //     the PTY as plain bytes, then clear the compose state.
            //
            //   * finishComposingText() — the IME is done with the current
            //     compose run but has not committed. Treat whatever is
            //     currently in mComposingRun as confirmed and flush it.
            //     This fixes Typeless/voice-input which often calls
            //     finishComposingText() before (or instead of) the final
            //     commitText.
            //
            //   * deleteSurroundingText(N, 0) — the IME wants to delete N
            //     characters left of the cursor. If we have N characters
            //     of committed text in the shadow buffer, we drop them
            //     from the shadow and forward N DELs to the PTY. If we
            //     have fewer, we drop what we have and IGNORE the rest.
            //     This is the key fix for Nacre: when Nacre first attaches
            //     it sends deleteSurroundingText(1,0) twenty-five times
            //     to "reset" the editable. Our shadow is empty at that
            //     point, so all twenty-five become no-ops on the PTY
            //     instead of eating twenty-five prompt characters.
            //
            //   * sendKeyEvent(KEYCODE_DEL) — hardware-ish backspace
            //     comes through here. We drop one char from the shadow
            //     and forward one DEL to the PTY if the shadow was empty
            //     (meaning the user is trying to delete already-committed
            //     bash state, like a previous 'ls' they want to backspace
            //     out of). If the shadow had a char, the shadow consumes
            //     the delete and no DEL is forwarded.
            //
            // The shadow is a StringBuilder that tracks *committed but
            // not-yet-newlined* characters. It resets on \n / \r because
            // at that point the bash line editor owns the buffer, not us.

            // mShadow is promoted to the outer TerminalView class (mImeShadow)
            // so that non-IME paste paths (middle-button paste, JS-side paste)
            // can keep it in sync. See bug #58.
            /** Current compose run (what setComposingText last received) */
            private String mComposingRun = "";
            /**
             * The last string flushed by finishComposingText(). Used by
             * commitText() to suppress the Typeless/Samsung double-flush
             * where the IME calls finishComposingText immediately followed
             * by commitText with the same payload. See bug #27.
             * Cleared after one commitText consumes it.
             */
            private String mLastFinishFlush = "";
            // mLastCommitAt is promoted to TerminalView.mLastImeCommitAt for the same reason.
            private long mLastDeleteAt = 0;
            private int mDeleteBurst = 0;
            /** Window (ms) after a commit during which DELs are treated as IME resync, not user BS */
            private static final long IME_RESYNC_WINDOW_MS = 250;
            /** bug #106 diag: timestamp of the previous commitText, used to detect IME chunk-splitting.
             *  Samsung Keyboard / Nacre have been observed splitting a single paste into multiple
             *  commitText calls within ~10ms; the gap between paste-pipeline (length >= 16) and
             *  per-char (length < 16) routing for the two halves is what produces the
             *  "<te|.json" display-corruption symptom even though bytes reach bash correctly.
             *  This is a logging-only hook for now — when consecutive commits land within
             *  COMMIT_BURST_WINDOW_MS we emit a marker line so logcat traces show the split.
             *  The actual coalescing fix lives in a follow-up commit guarded on this data. */
            private long mPrevCommitAt = 0;
            private static final long COMMIT_BURST_WINDOW_MS = 50;

            private void resetShadowAfterNewline(String text) {
                // If the text that just flew to the PTY contained a newline,
                // the bash line editor now owns the line state and our
                // shadow should start fresh from whatever came after the
                // last newline in the flushed text.
                int idx = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
                if (idx < 0) return;
                mImeShadow.setLength(0);
                if (idx + 1 < text.length()) {
                    mImeShadow.append(text, idx + 1, text.length());
                }
            }

            private void sendToPtyAndShadow(String text) {
                if (text.isEmpty()) return;
                sendTextToTerminal(text);
                // Track what we just sent in the shadow so future
                // deleteSurroundingText calls can consume from it.
                mImeShadow.append(text);
                resetShadowAfterNewline(text);
                mLastImeCommitAt = android.os.SystemClock.uptimeMillis();
                mDeleteBurst = 0;
            }

            @Override
            public boolean setComposingText(CharSequence text, int newCursorPosition) {
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
                    mClient.logInfo(LOG_TAG, "IME: setComposingText(\"" + text + "\", " + newCursorPosition + ")");
                }
                // We do NOT write compose runs to the PTY. The IME's own
                // candidate bar is the compose preview. When the user
                // confirms, commitText (or finishComposingText) will
                // carry the final string and we flush it then.
                mComposingRun = text != null ? text.toString() : "";
                mComposingText = mComposingRun;
                Log.d("ShellyIME", "setComposing=\"" + mComposingRun + "\"");
                return super.setComposingText(text, newCursorPosition);
            }

            @Override
            public boolean finishComposingText() {
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
                    mClient.logInfo(LOG_TAG, "IME: finishComposingText()");
                }
                // Typeless and some Samsung CJK flows call finishComposingText
                // *instead* of commitText to confirm the run. Flush here so
                // the text does not get held back until the keyboard
                // collapses.
                if (!mComposingRun.isEmpty()) {
                    Log.d("ShellyIME", "finishComposing flush=\"" + mComposingRun + "\"");
                    mLastFinishFlush = mComposingRun;
                    sendToPtyAndShadow(mComposingRun);
                    mComposingRun = "";
                }
                mComposingText = "";
                super.finishComposingText();
                return true;
            }

            @Override
            public boolean commitText(CharSequence text, int newCursorPosition) {
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
                    mClient.logInfo(LOG_TAG, "IME: commitText(\"" + text + "\", " + newCursorPosition + ")");
                }
                String commitStr = text != null ? text.toString() : "";

                // GUARD #27: If finishComposingText() already flushed the same
                // string (Typeless/Samsung double-path), don't send twice.
                // The previous version compared against non-empty only, which
                // still double-fired when the IME called finishComposingText
                // followed immediately by commitText with the same run, eating
                // the trailing Enter/quote characters from pasted text.
                if (!commitStr.isEmpty() && commitStr.equals(mLastFinishFlush)) {
                    Log.d("ShellyIME", "commit SUPPRESSED (already flushed via finishComposing) =\"" + commitStr + "\"");
                } else if (!commitStr.isEmpty()) {
                    // bug #91: if the IME just handed us a multi-line block or a
                    // chunk bigger than a realistic typed keystroke, treat it as
                    // a paste. Routing through mEmulator.paste() funnels the
                    // payload through the single CR/LF-normalized + bracketed
                    // path instead of sendTextToTerminal's per-char loop.
                    //
                    // bug #106 (rollback): the earlier "whitespace && len >= 4"
                    // heuristic misclassified CJK IME commits like `あ い`
                    // (space-separated words from Japanese candidate acceptance)
                    // as paste and fed them through bracketed-paste wrap, which
                    // corrupted in-line typing. Restore the conservative
                    // threshold: only commits that CONTAIN a newline or are
                    // long enough to obviously not be typing (>= 16 chars)
                    // route through pasteViaEmulator. Short commands like
                    // `codex --version` (15 chars, no newline) still go through
                    // the per-char path — the first-char loss those hit is a
                    // separate issue (IME deleteSurrounding SWALLOW window
                    // vs PTY prompt echo) that needs its own fix.
                    boolean hasNewline = commitStr.indexOf('\n') >= 0 || commitStr.indexOf('\r') >= 0;
                    boolean isPaste = commitStr.length() > 1
                        && (hasNewline || commitStr.length() >= 16);
                    // bug #106 diag: emit a burst marker when this commit lands
                    // within COMMIT_BURST_WINDOW_MS of the previous one. If we
                    // see commit-as-paste followed by commit-as-typed within
                    // that window, the IME split a single paste and the two
                    // halves took different routing → screen corruption.
                    long now = android.os.SystemClock.uptimeMillis();
                    long delta = mPrevCommitAt == 0 ? -1 : now - mPrevCommitAt;
                    mPrevCommitAt = now;
                    if (delta >= 0 && delta < COMMIT_BURST_WINDOW_MS) {
                        Log.d("ShellyIME", "commit BURST delta=" + delta + "ms (likely IME chunk-split — see #106)");
                    }
                    if (isPaste && mEmulator != null) {
                        Log.d("ShellyIME", "commit-as-paste len=" + commitStr.length() + " nl=" + hasNewline + " delta=" + delta + "ms");
                        TerminalView.this.pasteViaEmulator(commitStr);
                    } else {
                        Log.d("ShellyIME", "commit-as-typed len=" + commitStr.length() + " text=\"" + commitStr + "\" delta=" + delta + "ms");
                        sendToPtyAndShadow(commitStr);
                    }
                }

                mLastFinishFlush = "";
                mComposingRun = "";
                mComposingText = "";
                return super.commitText(text, newCursorPosition);
            }

            @Override
            public boolean deleteSurroundingText(int leftLength, int rightLength) {
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
                    mClient.logInfo(LOG_TAG, "IME: deleteSurroundingText(" + leftLength + ", " + rightLength + ")");
                }
                // Forward DELs to the PTY — this is the path soft keyboards
                // use for backspace. Reject only the two specific IME-init
                // patterns we've caught in logcat:
                //
                //   (a) DELs fired within the 250ms window right after a
                //       commit. That's the Nacre/Gboard resync storm that
                //       was erasing 25 characters of prompt text when the
                //       user first tapped the terminal.
                //   (b) DELs fired while a compose run is active. Those
                //       are IME buffer re-alignments, not user intent.
                //
                // Everything else is forwarded, including long-press BS
                // bursts. The previous "bursting >= 3 within 80ms" heuristic
                // was removed because it also blocked real long-press
                // backspace: soft keyboards auto-repeat at roughly 50ms
                // intervals, which look identical to an IME DEL storm.
                long now = android.os.SystemClock.uptimeMillis();
                boolean justCommitted = now - mLastImeCommitAt < IME_RESYNC_WINDOW_MS;
                boolean composing = !mComposingRun.isEmpty();

                if (justCommitted || composing) {
                    Log.d("ShellyIME", "deleteSurrounding SWALLOW left=" + leftLength
                        + " justCommitted=" + justCommitted + " composing=" + composing);
                    // Drop from shadow so the shadow stays in sync.
                    int drop = Math.min(leftLength, mImeShadow.length());
                    if (drop > 0) mImeShadow.setLength(mImeShadow.length() - drop);
                    return super.deleteSurroundingText(leftLength, rightLength);
                }

                Log.d("ShellyIME", "deleteSurrounding FORWARD left=" + leftLength);
                if (leftLength > 0) {
                    StringBuilder delSeq = new StringBuilder(leftLength);
                    for (int i = 0; i < leftLength; i++) {
                        delSeq.append('\u007F');
                    }
                    sendTextToTerminal(delSeq);
                }
                int drop = Math.min(leftLength, mImeShadow.length());
                if (drop > 0) mImeShadow.setLength(mImeShadow.length() - drop);
                return super.deleteSurroundingText(leftLength, rightLength);
            }

            // bug #12: cold-start Enter key double-press. Some IMEs (Gboard
            // on stock keyboards, Samsung bookcover BT) deliver Enter via
            // BaseInputConnection.sendKeyEvent() rather than commitText("\n"),
            // and the default super.sendKeyEvent() path runs its own
            // onKeyDown route which races the input thread on the very first
            // keystroke after a session is attached. Intercept Enter here
            // and push "\r" straight through sendTextToTerminal so the
            // payload lands on the PTY in a single atomic write — no race,
            // no missed keystroke. KEYCODE_NUMPAD_ENTER is covered too
            // because some hardware keyboards report it instead of Enter.
            //
            // bug #37 + #84: KEYCODE_ESCAPE policy. Samsung/Gboard soft
            // keyboards send KEYCODE_ESCAPE when the user taps the "hide
            // keyboard" button, and letting that reach the PTY corrupts
            // the line and pops vim out of insert mode. We used to swallow
            // *all* sendKeyEvent KEYCODE_ESCAPEs unconditionally, but that
            // also ate the ESC key on hardware/DeX keyboards which legit
            // send it through this same path on Android 13+. Gate the
            // swallow on the SOFT_KEYBOARD flag so only virtual keyboards
            // lose the ESC — physical keyboards fall through to super and
            // behave correctly.
            @Override
            public boolean sendKeyEvent(KeyEvent event) {
                int kc = event.getKeyCode();
                int action = event.getAction();

                if (action == KeyEvent.ACTION_DOWN &&
                        (kc == KeyEvent.KEYCODE_ENTER || kc == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
                    sendTextToTerminal("\r");
                    if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
                        mClient.logInfo(LOG_TAG, "IME: sendKeyEvent(ENTER) intercepted → \\r");
                    }
                    return true;
                }
                if (action == KeyEvent.ACTION_UP &&
                        (kc == KeyEvent.KEYCODE_ENTER || kc == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
                    // Swallow the UP too so super doesn't re-fire.
                    return true;
                }

                if (kc == KeyEvent.KEYCODE_ESCAPE) {
                    // Samsung's OneUI keyboard on Galaxy Z Fold6 was observed
                    // on-device to NOT set FLAG_SOFT_KEYBOARD on the hide-
                    // keyboard ESC event (2026-04-19 smoke test, gemini
                    // exited with "escape was pressed" when user tapped the
                    // keyboard-hide icon). Broaden the detection: also treat
                    // deviceId == VIRTUAL_KEYBOARD (-1) as soft, since any
                    // event attributed to the virtual input device is
                    // definitionally an IME synthesized one — no physical
                    // keyboard reports that deviceId. Combined check keeps
                    // hardware/DeX keyboards working (they have real
                    // deviceIds and often set the flag anyway).
                    boolean isSoft = (event.getFlags() & KeyEvent.FLAG_SOFT_KEYBOARD) != 0;
                    boolean isVirtual = event.getDeviceId() == android.view.KeyCharacterMap.VIRTUAL_KEYBOARD;
                    if (isSoft || isVirtual) {
                        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
                            mClient.logInfo(LOG_TAG, "IME: sendKeyEvent(ESC) swallowed (soft=" + isSoft + ", virtual=" + isVirtual + ")");
                        }
                        return true;
                    }
                    // Hardware keyboard ESC — let the normal path run.
                }
                return super.sendKeyEvent(event);
            }


            void sendTextToTerminal(CharSequence text) {
                stopTextSelectionMode();
                // DIAG bug #63: log whether we're in alt-buffer when a keystroke arrives.
                // If a vim keystroke reaches here but isAlternateBufferActive()==false the
                // emulator never saw CSI?1049h; if it's true but nothing visible happens
                // the byte is being dropped downstream (mTermSession.write / pty).
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED && mEmulator != null) {
                    try {
                        boolean alt = mEmulator.isAlternateBufferActive();
                        mClient.logInfo(LOG_TAG, "sendTextToTerminal: altBuffer=" + alt
                            + " len=" + text.length() + " first=0x"
                            + (text.length() > 0 ? Integer.toHexString(text.charAt(0)) : "-"));
                    } catch (Throwable t) { /* diag only */ }
                }
                final int textLengthInChars = text.length();
                for (int i = 0; i < textLengthInChars; i++) {
                    char firstChar = text.charAt(i);
                    int codePoint;
                    if (Character.isHighSurrogate(firstChar)) {
                        if (++i < textLengthInChars) {
                            codePoint = Character.toCodePoint(firstChar, text.charAt(i));
                        } else {
                            // At end of string, with no low surrogate following the high:
                            codePoint = TerminalEmulator.UNICODE_REPLACEMENT_CHAR;
                        }
                    } else {
                        codePoint = firstChar;
                    }

                    // Check onKeyDown() for details.
                    if (mClient.readShiftKey())
                        codePoint = Character.toUpperCase(codePoint);

                    boolean ctrlHeld = false;
                    if (codePoint <= 31 && codePoint != 27) {
                        if (codePoint == '\n') {
                            // The AOSP keyboard and descendants seems to send \n as text when the enter key is pressed,
                            // instead of a key event like most other keyboard apps. A terminal expects \r for the enter
                            // key (although when icrnl is enabled this doesn't make a difference - run 'stty -icrnl' to
                            // check the behaviour).
                            codePoint = '\r';
                        }

                        // E.g. penti keyboard for ctrl input.
                        ctrlHeld = true;
                        switch (codePoint) {
                            case 31:
                                codePoint = '_';
                                break;
                            case 30:
                                codePoint = '^';
                                break;
                            case 29:
                                codePoint = ']';
                                break;
                            case 28:
                                codePoint = '\\';
                                break;
                            default:
                                codePoint += 96;
                                break;
                        }
                    }

                    inputCodePoint(KEY_EVENT_SOURCE_SOFT_KEYBOARD, codePoint, ctrlHeld, false);
                }
            }

        };
    }

    @Override
    protected int computeVerticalScrollRange() {
        return mEmulator == null ? 1 : mEmulator.getScreen().getActiveRows();
    }

    @Override
    protected int computeVerticalScrollExtent() {
        return mEmulator == null ? 1 : mEmulator.mRows;
    }

    @Override
    protected int computeVerticalScrollOffset() {
        return mEmulator == null ? 1 : mEmulator.getScreen().getActiveRows() + mTopRow - mEmulator.mRows;
    }

    /**
     * bug #91 / #94: single entry point for paste-like payloads.
     *
     * All paste entry points (IME commitText multi-line, CommandKeyBar Paste
     * button, middle-click mouse paste, system clipboard long-press menu)
     * should funnel through this helper instead of the per-char
     * sendTextToTerminal loop. It does three things:
     *
     *   1. Forwards the payload to {@link TerminalEmulator#paste(String)},
     *      which strips ESC + C1 controls, normalizes CRLF → LF, and wraps
     *      in bracketed-paste markers so readline-aware shells treat the
     *      whole block as one paste event.
     *   2. Seeds {@link #mImeShadow} with the pasted text so the IME's
     *      deleteSurroundingText() resync storm that follows a commitText
     *      doesn't eat the prompt (see bug #58 fix for the shadow design).
     *      Shadow content after the last newline is preserved, not cleared,
     *      so bash's line editor state matches what the IME thinks is still
     *      on the line.
     *   3. Stamps {@link #mLastImeCommitAt} so the "justCommitted" window
     *      in deleteSurroundingText swallows IME resyncs for 250ms.
     *
     * This is intentionally package-private so the inner BaseInputConnection
     * anonymous class can reach it via the outer-this reference.
     */
    void pasteViaEmulator(String text) {
        if (mEmulator == null || text == null || text.isEmpty()) return;
        // bug #91 diag: callers include IME commitText multi-line, middle-click
        // mouse paste, CommandKeyBar Paste button. Log every hit so it is
        // trivial to filter paste-specific issues from noisy typing traces.
        int nl = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\n' || c == '\r') nl++;
        }
        Log.d("ShellyPaste", "pasteViaEmulator len=" + text.length() + " nl=" + nl);
        mEmulator.paste(text);
        mLastImeCommitAt = android.os.SystemClock.uptimeMillis();
        mImeShadow.append(text);
        // Mirror resetShadowAfterNewline's behaviour: if the paste
        // contained a newline, bash's line editor now owns the line and
        // our shadow should restart from whatever came after the last
        // newline in the flushed text.
        int idx = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
        if (idx >= 0) {
            mImeShadow.setLength(0);
            if (idx + 1 < text.length()) {
                mImeShadow.append(text, idx + 1, text.length());
            }
        }
    }

    public void onScreenUpdated() {
        onScreenUpdated(false);
    }

    /** Whether user has scrolled up during output. Reset when user scrolls back to bottom. */
    private boolean mUserScrolledUp = false;

    /** Listener for scroll state changes (scrolled up / back to bottom). */
    public interface ScrollStateListener {
        void onScrollStateChanged(boolean isScrolledUp);
    }
    private ScrollStateListener mScrollStateListener;

    public void setScrollStateListener(ScrollStateListener listener) {
        mScrollStateListener = listener;
    }

    private void setUserScrolledUp(boolean scrolledUp) {
        if (mUserScrolledUp != scrolledUp) {
            mUserScrolledUp = scrolledUp;
            if (mScrollStateListener != null) {
                mScrollStateListener.onScrollStateChanged(scrolledUp);
            }
        }
    }

    public void onScreenUpdated(boolean skipScrolling) {
        if (mEmulator == null) return;

        int rowsInHistory = mEmulator.getScreen().getActiveTranscriptRows();
        if (mTopRow < -rowsInHistory) mTopRow = -rowsInHistory;

        if (isSelectingText() || mEmulator.isAutoScrollDisabled()) {

            // Do not scroll when selecting text.
            int rowShift = mEmulator.getScrollCounter();
            if (-mTopRow + rowShift > rowsInHistory) {
                // .. unless we're hitting the end of history transcript, in which
                // case we abort text selection and scroll to end.
                if (isSelectingText())
                    stopTextSelectionMode();

                if (mEmulator.isAutoScrollDisabled()) {
                    mTopRow = -rowsInHistory;
                    skipScrolling = true;
                }
            } else {
                skipScrolling = true;
                mTopRow -= rowShift;
                decrementYTextSelectionCursors(rowShift);
            }
        }

        if (!skipScrolling && mTopRow != 0) {
            // If user has manually scrolled up, keep their scroll position
            // instead of forcing back to bottom. This allows reading output
            // while new content is being produced (like ttyd/xterm.js behavior).
            if (mUserScrolledUp) {
                // Adjust mTopRow to account for new lines pushed into history
                int rowShift = mEmulator.getScrollCounter();
                mTopRow = Math.max(-rowsInHistory, mTopRow - rowShift);
            } else {
                // Auto-scroll to bottom (default behavior)
                if (mTopRow < -3) {
                    awakenScrollBars();
                }
                mTopRow = 0;
            }
        }

        mEmulator.clearScrollCounter();

        invalidate();
        if (mAccessibilityEnabled) setContentDescription(getText());
    }

    /** This must be called by the hosting activity in {@link Activity#onContextMenuClosed(Menu)}
     * when context menu for the {@link TerminalView} is started by
     * {@link TextSelectionCursorController#ACTION_MORE} is closed. */
    public void onContextMenuClosed(Menu menu) {
        // Unset the stored text since it shouldn't be used anymore and should be cleared from memory
        unsetStoredSelectedText();
    }

    /**
     * Sets the text size, which in turn sets the number of rows and columns.
     *
     * @param textSize the new font size, in density-independent pixels.
     */
    public void setTextSize(int textSize) {
        mRenderer = new TerminalRenderer(textSize, mRenderer == null ? Typeface.MONOSPACE : mRenderer.mTypeface);
        updateSize();
    }

    public void setTypeface(Typeface newTypeface) {
        mRenderer = new TerminalRenderer(mRenderer.mTextSize, newTypeface);
        updateSize();
        invalidate();
    }

    @Override
    public boolean onCheckIsTextEditor() {
        return true;
    }

    @Override
    public boolean isOpaque() {
        return true;
    }

    /**
     * Get the zero indexed column and row of the terminal view for the
     * position of the event.
     *
     * @param event The event with the position to get the column and row for.
     * @param relativeToScroll If true the column number will take the scroll
     * position into account. E.g. if scrolled 3 lines up and the event
     * position is in the top left, column will be -3 if relativeToScroll is
     * true and 0 if relativeToScroll is false.
     * @return Array with the column and row.
     */
    public int[] getColumnAndRow(MotionEvent event, boolean relativeToScroll) {
        int column = (int) (event.getX() / mRenderer.mFontWidth);
        int row = (int) ((event.getY() - mRenderer.mFontLineSpacingAndAscent) / mRenderer.mFontLineSpacing);
        if (relativeToScroll) {
            row += mTopRow;
        }
        return new int[] { column, row };
    }

    /** Send a single mouse event code to the terminal. */
    void sendMouseEventCode(MotionEvent e, int button, boolean pressed) {
        int[] columnAndRow = getColumnAndRow(e, false);
        int x = columnAndRow[0] + 1;
        int y = columnAndRow[1] + 1;
        if (pressed && (button == TerminalEmulator.MOUSE_WHEELDOWN_BUTTON || button == TerminalEmulator.MOUSE_WHEELUP_BUTTON)) {
            if (mMouseStartDownTime == e.getDownTime()) {
                x = mMouseScrollStartX;
                y = mMouseScrollStartY;
            } else {
                mMouseStartDownTime = e.getDownTime();
                mMouseScrollStartX = x;
                mMouseScrollStartY = y;
            }
        }
        mEmulator.sendMouseEvent(button, x, y, pressed);
    }

    /** Perform a scroll, either from dragging the screen or by scrolling a mouse wheel. */
    void doScroll(MotionEvent event, int rowsDown) {
        boolean up = rowsDown < 0;
        int amount = Math.abs(rowsDown);
        for (int i = 0; i < amount; i++) {
            if (mEmulator.isMouseTrackingActive()) {
                sendMouseEventCode(event, up ? TerminalEmulator.MOUSE_WHEELUP_BUTTON : TerminalEmulator.MOUSE_WHEELDOWN_BUTTON, true);
            } else if (mEmulator.isAlternateBufferActive()) {
                handleKeyCode(up ? KeyEvent.KEYCODE_DPAD_UP : KeyEvent.KEYCODE_DPAD_DOWN, 0);
            } else {
                mTopRow = Math.min(0, Math.max(-(mEmulator.getScreen().getActiveTranscriptRows()), mTopRow + (up ? -1 : 1)));
                // Track user scroll state for output-during-scroll behavior
                if (mTopRow < 0) {
                    setUserScrolledUp(true);
                } else {
                    // User scrolled back to bottom — re-enable auto-scroll
                    setUserScrolledUp(false);
                }
                if (!awakenScrollBars()) invalidate();
            }
        }
    }

    /** Overriding {@link View#onGenericMotionEvent(MotionEvent)}. */
    @Override
    public boolean onGenericMotionEvent(MotionEvent event) {
        if (mEmulator != null && event.isFromSource(InputDevice.SOURCE_MOUSE) && event.getAction() == MotionEvent.ACTION_SCROLL) {
            // Handle mouse wheel scrolling.
            boolean up = event.getAxisValue(MotionEvent.AXIS_VSCROLL) > 0.0f;
            doScroll(event, up ? -3 : 3);
            return true;
        }
        return false;
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    @TargetApi(23)
    public boolean onTouchEvent(MotionEvent event) {
        if (mEmulator == null) return true;
        final int action = event.getAction();

        if (isSelectingText()) {
            updateFloatingToolbarVisibility(event);
            mGestureRecognizer.onTouchEvent(event);
            return true;
        } else if (event.isFromSource(InputDevice.SOURCE_MOUSE)) {
            if (event.isButtonPressed(MotionEvent.BUTTON_SECONDARY)) {
                if (action == MotionEvent.ACTION_DOWN) showContextMenu();
                return true;
            } else if (event.isButtonPressed(MotionEvent.BUTTON_TERTIARY)) {
                ClipboardManager clipboardManager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clipData = clipboardManager.getPrimaryClip();
                if (clipData != null) {
                    ClipData.Item clipItem = clipData.getItemAt(0);
                    if (clipItem != null) {
                        CharSequence text = clipItem.coerceToText(getContext());
                        if (!TextUtils.isEmpty(text)) {
                            // bug #58 + #91 + #94: funnel through pasteViaEmulator
                            // so the shadow seeding, bracketed-paste wrapping,
                            // and CRLF normalization all happen in one place
                            // shared with the IME commitText path.
                            String pasted = text.toString();
                            Log.d("ShellyPaste", "middle-click len=" + pasted.length());
                            pasteViaEmulator(pasted);
                        }
                    }
                }
            } else if (mEmulator.isMouseTrackingActive()) { // BUTTON_PRIMARY.
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                    case MotionEvent.ACTION_UP:
                        sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, event.getAction() == MotionEvent.ACTION_DOWN);
                        break;
                    case MotionEvent.ACTION_MOVE:
                        sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON_MOVED, true);
                        break;
                }
            }
        }

        mGestureRecognizer.onTouchEvent(event);
        return true;
    }

    @Override
    public boolean onKeyPreIme(int keyCode, KeyEvent event) {
        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
            mClient.logInfo(LOG_TAG, "onKeyPreIme(keyCode=" + keyCode + ", event=" + event + ")");
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            cancelRequestAutoFill();
            if (isSelectingText()) {
                stopTextSelectionMode();
                return true;
            } else if (mClient.shouldBackButtonBeMappedToEscape()) {
                // Intercept back button to treat it as escape:
                switch (event.getAction()) {
                    case KeyEvent.ACTION_DOWN:
                        return onKeyDown(keyCode, event);
                    case KeyEvent.ACTION_UP:
                        return onKeyUp(keyCode, event);
                }
            }
        } else if (mClient.shouldUseCtrlSpaceWorkaround() &&
                   keyCode == KeyEvent.KEYCODE_SPACE && event.isCtrlPressed()) {
            /* ctrl+space does not work on some ROMs without this workaround.
               However, this breaks it on devices where it works out of the box. */
            return onKeyDown(keyCode, event);
        }
        return super.onKeyPreIme(keyCode, event);
    }

    /**
     * Key presses in software keyboards will generally NOT trigger this listener, although some
     * may elect to do so in some situations. Do not rely on this to catch software key presses.
     * Gboard calls this when shouldEnforceCharBasedInput() is disabled (InputType.TYPE_NULL) instead
     * of calling commitText(), with deviceId=-1. However, Hacker's Keyboard, OpenBoard, LG Keyboard
     * call commitText().
     *
     * This function may also be called directly without android calling it, like by
     * `TerminalExtraKeys` which generates a KeyEvent manually which uses {@link KeyCharacterMap#VIRTUAL_KEYBOARD}
     * as the device (deviceId=-1), as does Gboard. That would normally use mappings defined in
     * `/system/usr/keychars/Virtual.kcm`. You can run `dumpsys input` to find the `KeyCharacterMapFile`
     * used by virtual keyboard or hardware keyboard. Note that virtual keyboard device is not the
     * same as software keyboard, like Gboard, etc. Its a fake device used for generating events and
     * for testing.
     *
     * We handle shift key in `commitText()` to convert codepoint to uppercase case there with a
     * call to {@link Character#toUpperCase(int)}, but here we instead rely on getUnicodeChar() for
     * conversion of keyCode, for both hardware keyboard shift key (via effectiveMetaState) and
     * `mClient.readShiftKey()`, based on value in kcm files.
     * This may result in different behaviour depending on keyboard and android kcm files set for the
     * InputDevice for the event passed to this function. This will likely be an issue for non-english
     * languages since `Virtual.kcm` in english only by default or at least in AOSP. For both hardware
     * shift key (via effectiveMetaState) and `mClient.readShiftKey()`, `getUnicodeChar()` is used
     * for shift specific behaviour which usually is to uppercase.
     *
     * For fn key on hardware keyboard, android checks kcm files for hardware keyboards, which is
     * `Generic.kcm` by default, unless a vendor specific one is defined. The event passed will have
     * {@link KeyEvent#META_FUNCTION_ON} set. If the kcm file only defines a single character or unicode
     * code point `\\uxxxx`, then only one event is passed with that value. However, if kcm defines
     * a `fallback` key for fn or others, like `key DPAD_UP { ... fn: fallback PAGE_UP }`, then
     * android will first pass an event with original key `DPAD_UP` and {@link KeyEvent#META_FUNCTION_ON}
     * set. But this function will not consume it and android will pass another event with `PAGE_UP`
     * and {@link KeyEvent#META_FUNCTION_ON} not set, which will be consumed.
     *
     * Now there are some other issues as well, firstly ctrl and alt flags are not passed to
     * `getUnicodeChar()`, so modified key values in kcm are not used. Secondly, if the kcm file
     * for other modifiers like shift or fn define a non-alphabet, like { fn: '\u0015' } to act as
     * DPAD_LEFT, the `getUnicodeChar()` will correctly return `21` as the code point but action will
     * not happen because the `handleKeyCode()` function that transforms DPAD_LEFT to `\033[D`
     * escape sequence for the terminal to perform the left action would not be called since its
     * called before `getUnicodeChar()` and terminal will instead get `21 0x15 Negative Acknowledgement`.
     * The solution to such issues is calling `getUnicodeChar()` before the call to `handleKeyCode()`
     * if user has defined a custom kcm file, like done in POC mentioned in #2237. Note that
     * Hacker's Keyboard calls `commitText()` so don't test fn/shift with it for this function.
     * https://github.com/termux/termux-app/pull/2237
     * https://github.com/agnostic-apollo/termux-app/blob/terminal-code-point-custom-mapping/terminal-view/src/main/java/com/termux/view/TerminalView.java
     *
     * Key Character Map (kcm) and Key Layout (kl) files info:
     * https://source.android.com/devices/input/key-character-map-files
     * https://source.android.com/devices/input/key-layout-files
     * https://source.android.com/devices/input/keyboard-devices
     * AOSP kcm and kl files:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/data/keyboards
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/packages/InputDevices/res/raw
     *
     * KeyCodes:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/core/java/android/view/KeyEvent.java
     * https://cs.android.com/android/platform/superproject/+/master:frameworks/native/include/android/keycodes.h
     *
     * `dumpsys input`:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/services/inputflinger/reader/EventHub.cpp;l=1917
     *
     * Loading of keymap:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/services/inputflinger/reader/EventHub.cpp;l=1644
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/Keyboard.cpp;l=41
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/InputDevice.cpp
     * OVERLAY keymaps for hardware keyboards may be combined as well:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/KeyCharacterMap.cpp;l=165
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/KeyCharacterMap.cpp;l=831
     *
     * Parse kcm file:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/KeyCharacterMap.cpp;l=727
     * Parse key value:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/KeyCharacterMap.cpp;l=981
     *
     * `KeyEvent.getUnicodeChar()`
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/core/java/android/view/KeyEvent.java;l=2716
     * https://cs.android.com/android/platform/superproject/+/master:frameworks/base/core/java/android/view/KeyCharacterMap.java;l=368
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/core/jni/android_view_KeyCharacterMap.cpp;l=117
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/native/libs/input/KeyCharacterMap.cpp;l=231
     *
     * Keyboard layouts advertised by applications, like for hardware keyboards via #ACTION_QUERY_KEYBOARD_LAYOUTS
     * Config is stored in `/data/system/input-manager-state.xml`
     * https://github.com/ris58h/custom-keyboard-layout
     * Loading from apps:
     * https://cs.android.com/android/platform/superproject/+/master:frameworks/base/services/core/java/com/android/server/input/InputManagerService.java;l=1221
     * Set:
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/core/java/android/hardware/input/InputManager.java;l=89
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/core/java/android/hardware/input/InputManager.java;l=543
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:packages/apps/Settings/src/com/android/settings/inputmethod/KeyboardLayoutDialogFragment.java;l=167
     * https://cs.android.com/android/platform/superproject/+/master:frameworks/base/services/core/java/com/android/server/input/InputManagerService.java;l=1385
     * https://cs.android.com/android/platform/superproject/+/master:frameworks/base/services/core/java/com/android/server/input/PersistentDataStore.java
     * Get overlay keyboard layout
     * https://cs.android.com/android/platform/superproject/+/master:frameworks/base/services/core/java/com/android/server/input/InputManagerService.java;l=2158
     * https://cs.android.com/android/platform/superproject/+/android-11.0.0_r40:frameworks/base/services/core/jni/com_android_server_input_InputManagerService.cpp;l=616
     */
    /**
     * Bug #63 (vim keystrokes not reaching pty): when the window regains focus
     * the InputMethodManager sometimes holds a stale InputConnection, so the
     * soft keyboard ends up committing text into a dead editor. Kicking
     * restartInput() forces the IME to re-bind against the current
     * TerminalInputConnection. Cheap, side-effect-free, helps both Gboard and
     * AOSP IMEs after an app like vim switches to the alternate screen.
     */
    @Override
    public void onWindowFocusChanged(boolean hasWindowFocus) {
        super.onWindowFocusChanged(hasWindowFocus);
        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
            mClient.logInfo(LOG_TAG, "onWindowFocusChanged(hasWindowFocus=" + hasWindowFocus + ")");
        if (hasWindowFocus) {
            try {
                InputMethodManager imm = (InputMethodManager) getContext()
                    .getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.restartInput(this);
            } catch (Throwable t) {
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
                    mClient.logInfo(LOG_TAG, "restartInput failed: " + t);
            }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
            boolean alt = false;
            try { alt = mEmulator != null && mEmulator.isAlternateBufferActive(); } catch (Throwable t) {}
            mClient.logInfo(LOG_TAG, "onKeyDown(keyCode=" + keyCode + ", isSystem()=" + event.isSystem() + ", altBuffer=" + alt + ", event=" + event + ")");
        }
        if (mEmulator == null) return true;

        // Intercept Ctrl+V / Cmd+V (hardware or scrcpy-forwarded) — scrcpy's
        // Ctrl+V "type clipboard as key events" path bypasses the IME
        // commitText route entirely, so Shelly's bracketed-paste pipeline
        // never fires and multi-line scripts get mangled. Catch the Ctrl+V
        // chord here, pull the text from the Android clipboard directly,
        // and funnel it through pasteViaEmulator so it lands on a single
        // TerminalEmulator.paste() call with bracketed markers intact.
        //
        // We leave Ctrl+Shift+V untouched — that's the customary paste
        // chord in many terminal emulators but some users rely on it for
        // selection-insert; if the app-level intercept swallowed it they'd
        // lose that behaviour. Plain Ctrl+V is the universal "paste" chord
        // on every major desktop OS, so intercepting only that is safe.
        if (keyCode == KeyEvent.KEYCODE_V
                && (event.isCtrlPressed() || (event.getMetaState() & KeyEvent.META_META_ON) != 0)
                && !event.isAltPressed()) {
            try {
                android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                android.content.ClipData clip = cm != null ? cm.getPrimaryClip() : null;
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(getContext());
                    if (!android.text.TextUtils.isEmpty(text)) {
                        android.util.Log.d("ShellyPaste",
                            "ctrl-v intercept len=" + text.length());
                        pasteViaEmulator(text.toString());
                        return true;
                    }
                }
            } catch (Throwable t) {
                android.util.Log.d("ShellyPaste", "ctrl-v intercept failed: " + t.getMessage());
            }
            // Fall through to default handling if clipboard is empty or
            // the ClipboardManager is unavailable for any reason.
        }

        if (isSelectingText()) {
            stopTextSelectionMode();
        }

        if (mClient.onKeyDown(keyCode, event, mTermSession)) {
            invalidate();
            return true;
        } else if (event.isSystem() && (!mClient.shouldBackButtonBeMappedToEscape() || keyCode != KeyEvent.KEYCODE_BACK)) {
            return super.onKeyDown(keyCode, event);
        } else if (keyCode == KeyEvent.KEYCODE_UNKNOWN) {
            // bug #113: scrcpy's default SDK keyboard mode sends key events
            // with KEYCODE_UNKNOWN because the IME (e.g. Nacre) does not
            // publish an HW keymap. The characters payload carries the
            // unicode the user typed on the PC keyboard.
            //
            // Upstream Termux only handled ACTION_MULTIPLE here and wrote
            // event.getCharacters() raw to the PTY, which (1) bypasses
            // bracketed-paste wrap (multi-line pastes execute line-by-line),
            // (2) NPEs when getCharacters() returns null (Android 29+
            // deprecated ACTION_MULTIPLE so it rarely fires), and (3) misses
            // scrcpy's ACTION_DOWN / ACTION_UP entirely — every typed char
            // from the PC keyboard was silently dropped.
            //
            // New behaviour: read the unicode codepoint from getUnicodeChar()
            // first (works for ACTION_DOWN). Fall back to getCharacters()
            // for legacy ACTION_MULTIPLE. Route through pasteViaEmulator
            // when we got more than one char so bracketed-paste wrap and
            // the IME shadow stay consistent.
            String characters = event.getCharacters();
            int action = event.getAction();
            if (characters != null && characters.length() > 0) {
                if (action == KeyEvent.ACTION_DOWN || action == KeyEvent.ACTION_MULTIPLE) {
                    // Single-character payloads go straight to the PTY via
                    // mTermSession.write — bracketed-paste wrap for length-1
                    // is meaningless overhead and would flood logcat with
                    // `ShellyPaste` lines. Use the paste funnel only when
                    // the IME/scrcpy actually sent a chunk that benefits
                    // from atomic submission. sendTextToTerminal() lives on
                    // the inner InputConnection class and is not visible
                    // from onKeyDown — write directly, matching the
                    // pre-existing upstream `ACTION_MULTIPLE` branch.
                    if (characters.length() == 1) {
                        mTermSession.write(characters);
                    } else if (mEmulator != null) {
                        android.util.Log.d("ShellyPaste",
                            "KEYCODE_UNKNOWN action=" + action + " chars.len=" + characters.length());
                        pasteViaEmulator(characters);
                    } else {
                        mTermSession.write(characters);
                    }
                }
                return true;
            }
            if (action == KeyEvent.ACTION_DOWN) {
                int code = event.getUnicodeChar(event.getMetaState());
                if (code != 0) {
                    android.util.Log.d("ShellyPaste",
                        "KEYCODE_UNKNOWN unicodeChar=0x" + Integer.toHexString(code));
                    mTermSession.write(new String(Character.toChars(code)));
                    return true;
                }
            }
            // Unknown key with no payload — swallow so it doesn't escape
            // to some upstream handler that might interpret it.
            return true;
        } else if (keyCode == KeyEvent.KEYCODE_LANGUAGE_SWITCH) {
            return super.onKeyDown(keyCode, event);
        }

        final int metaState = event.getMetaState();
        final boolean controlDown = event.isCtrlPressed() || mClient.readControlKey();
        final boolean leftAltDown = (metaState & KeyEvent.META_ALT_LEFT_ON) != 0 || mClient.readAltKey();
        final boolean shiftDown = event.isShiftPressed() || mClient.readShiftKey();
        final boolean rightAltDownFromEvent = (metaState & KeyEvent.META_ALT_RIGHT_ON) != 0;

        int keyMod = 0;
        if (controlDown) keyMod |= KeyHandler.KEYMOD_CTRL;
        if (event.isAltPressed() || leftAltDown) keyMod |= KeyHandler.KEYMOD_ALT;
        if (shiftDown) keyMod |= KeyHandler.KEYMOD_SHIFT;
        if (event.isNumLockOn()) keyMod |= KeyHandler.KEYMOD_NUM_LOCK;
        // https://github.com/termux/termux-app/issues/731
        if (!event.isFunctionPressed() && handleKeyCode(keyCode, keyMod)) {
            if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) mClient.logInfo(LOG_TAG, "handleKeyCode() took key event");
            return true;
        }

        // Clear Ctrl since we handle that ourselves:
        int bitsToClear = KeyEvent.META_CTRL_MASK;
        if (rightAltDownFromEvent) {
            // Let right Alt/Alt Gr be used to compose characters.
        } else {
            // Use left alt to send to terminal (e.g. Left Alt+B to jump back a word), so remove:
            bitsToClear |= KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON;
        }
        int effectiveMetaState = event.getMetaState() & ~bitsToClear;

        if (shiftDown) effectiveMetaState |= KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON;
        if (mClient.readFnKey()) effectiveMetaState |= KeyEvent.META_FUNCTION_ON;

        int result = event.getUnicodeChar(effectiveMetaState);
        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
            mClient.logInfo(LOG_TAG, "KeyEvent#getUnicodeChar(" + effectiveMetaState + ") returned: " + result);
        if (result == 0) {
            return false;
        }

        int oldCombiningAccent = mCombiningAccent;
        if ((result & KeyCharacterMap.COMBINING_ACCENT) != 0) {
            // If entered combining accent previously, write it out:
            if (mCombiningAccent != 0)
                inputCodePoint(event.getDeviceId(), mCombiningAccent, controlDown, leftAltDown);
            mCombiningAccent = result & KeyCharacterMap.COMBINING_ACCENT_MASK;
        } else {
            if (mCombiningAccent != 0) {
                int combinedChar = KeyCharacterMap.getDeadChar(mCombiningAccent, result);
                if (combinedChar > 0) result = combinedChar;
                mCombiningAccent = 0;
            }
            inputCodePoint(event.getDeviceId(), result, controlDown, leftAltDown);
        }

        if (mCombiningAccent != oldCombiningAccent) invalidate();

        return true;
    }

    public void inputCodePoint(int eventSource, int codePoint, boolean controlDownFromEvent, boolean leftAltDownFromEvent) {
        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED) {
            mClient.logInfo(LOG_TAG, "inputCodePoint(eventSource=" + eventSource + ", codePoint=" + codePoint + ", controlDownFromEvent=" + controlDownFromEvent + ", leftAltDownFromEvent="
                + leftAltDownFromEvent + ")");
        }

        if (mTermSession == null) return;

        // Ensure cursor is shown when a key is pressed down like long hold on (arrow) keys
        if (mEmulator != null)
            mEmulator.setCursorBlinkState(true);

        final boolean controlDown = controlDownFromEvent || mClient.readControlKey();
        final boolean altDown = leftAltDownFromEvent || mClient.readAltKey();

        if (mClient.onCodePoint(codePoint, controlDown, mTermSession)) return;

        if (controlDown) {
            if (codePoint >= 'a' && codePoint <= 'z') {
                codePoint = codePoint - 'a' + 1;
            } else if (codePoint >= 'A' && codePoint <= 'Z') {
                codePoint = codePoint - 'A' + 1;
            } else if (codePoint == ' ' || codePoint == '2') {
                codePoint = 0;
            } else if (codePoint == '[' || codePoint == '3') {
                codePoint = 27; // ^[ (Esc)
            } else if (codePoint == '\\' || codePoint == '4') {
                codePoint = 28;
            } else if (codePoint == ']' || codePoint == '5') {
                codePoint = 29;
            } else if (codePoint == '^' || codePoint == '6') {
                codePoint = 30; // control-^
            } else if (codePoint == '_' || codePoint == '7' || codePoint == '/') {
                // "Ctrl-/ sends 0x1f which is equivalent of Ctrl-_ since the days of VT102"
                // - http://apple.stackexchange.com/questions/24261/how-do-i-send-c-that-is-control-slash-to-the-terminal
                codePoint = 31;
            } else if (codePoint == '8') {
                codePoint = 127; // DEL
            }
        }

        if (codePoint > -1) {
            // If not virtual or soft keyboard.
            if (eventSource > KEY_EVENT_SOURCE_SOFT_KEYBOARD) {
                // Work around bluetooth keyboards sending funny unicode characters instead
                // of the more normal ones from ASCII that terminal programs expect - the
                // desire to input the original characters should be low.
                switch (codePoint) {
                    case 0x02DC: // SMALL TILDE.
                        codePoint = 0x007E; // TILDE (~).
                        break;
                    case 0x02CB: // MODIFIER LETTER GRAVE ACCENT.
                        codePoint = 0x0060; // GRAVE ACCENT (`).
                        break;
                    case 0x02C6: // MODIFIER LETTER CIRCUMFLEX ACCENT.
                        codePoint = 0x005E; // CIRCUMFLEX ACCENT (^).
                        break;
                }
            }

            // If left alt, send escape before the code point to make e.g. Alt+B and Alt+F work in readline:
            mTermSession.writeCodePoint(altDown, codePoint);
        }
    }

    /** Input the specified keyCode if applicable and return if the input was consumed. */
    public boolean handleKeyCode(int keyCode, int keyMod) {
        // Ensure cursor is shown when a key is pressed down like long hold on (arrow) keys
        if (mEmulator != null)
            mEmulator.setCursorBlinkState(true);

        if (handleKeyCodeAction(keyCode, keyMod))
            return true;

        TerminalEmulator term = mTermSession.getEmulator();
        String code = KeyHandler.getCode(keyCode, keyMod, term.isCursorKeysApplicationMode(), term.isKeypadApplicationMode());
        if (code == null) return false;
        mTermSession.write(code);
        return true;
    }

    public boolean handleKeyCodeAction(int keyCode, int keyMod) {
        boolean shiftDown = (keyMod & KeyHandler.KEYMOD_SHIFT) != 0;

        switch (keyCode) {
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_PAGE_DOWN:
                // shift+page_up and shift+page_down should scroll scrollback history instead of
                // scrolling command history or changing pages
                if (shiftDown) {
                    long time = SystemClock.uptimeMillis();
                    MotionEvent motionEvent = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, 0, 0, 0);
                    doScroll(motionEvent, keyCode == KeyEvent.KEYCODE_PAGE_UP ? -mEmulator.mRows : mEmulator.mRows);
                    motionEvent.recycle();
                    return true;
                }
        }

       return false;
    }

    /**
     * Called when a key is released in the view.
     *
     * @param keyCode The keycode of the key which was released.
     * @param event   A {@link KeyEvent} describing the event.
     * @return Whether the event was handled.
     */
    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
            mClient.logInfo(LOG_TAG, "onKeyUp(keyCode=" + keyCode + ", event=" + event + ")");

        // Do not return for KEYCODE_BACK and send it to the client since user may be trying
        // to exit the activity.
        if (mEmulator == null && keyCode != KeyEvent.KEYCODE_BACK) return true;

        if (mClient.onKeyUp(keyCode, event)) {
            invalidate();
            return true;
        } else if (event.isSystem()) {
            // Let system key events through.
            return super.onKeyUp(keyCode, event);
        }

        return true;
    }

    /**
     * This is called during layout when the size of this view has changed. If you were just added to the view
     * hierarchy, you're called with the old values of 0.
     */
    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        updateSize();
    }

    /** Check if the terminal size in rows and columns should be updated. */
    public void updateSize() {
        // bug #82: honor View padding so the terminal text doesn't crash into
        // the right edge of the pane. getWidth() / getHeight() include
        // padding, so we subtract it explicitly before computing columns /
        // rows. onDraw() translates the canvas by the same amount so the
        // emulator still draws from origin.
        int viewWidth = getWidth() - getPaddingLeft() - getPaddingRight();
        int viewHeight = getHeight() - getPaddingTop() - getPaddingBottom();
        if (viewWidth <= 0 || viewHeight <= 0 || mTermSession == null) return;

        // Set to 80 and 24 if you want to enable vttest.
        int newColumns = Math.max(4, (int) (viewWidth / mRenderer.mFontWidth));
        int newRows = Math.max(4, (viewHeight - mRenderer.mFontLineSpacingAndAscent) / mRenderer.mFontLineSpacing);

        if (mEmulator == null || (newColumns != mEmulator.mColumns || newRows != mEmulator.mRows)) {
            mTermSession.updateSize(newColumns, newRows, (int) mRenderer.getFontWidth(), mRenderer.getFontLineSpacing());
            mEmulator = mTermSession.getEmulator();
            mClient.onEmulatorSet();

            // Update mTerminalCursorBlinkerRunnable inner class mEmulator on session change
            if (mTerminalCursorBlinkerRunnable != null)
                mTerminalCursorBlinkerRunnable.setEmulator(mEmulator);

            mTopRow = 0;
            scrollTo(0, 0);
            invalidate();
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (mEmulator == null) {
            // Phase B: skip the black fallback when transparent mode is on so
            // a wallpaper under the view can show while PTY state is still
            // spinning up (typically 50-100ms on first mount).
            if (!mTransparentBackground) {
                canvas.drawColor(0XFF000000);
            }
        } else {
            // bug #82: paint the padding region in the terminal background
            // so it visually merges with the content, then translate so the
            // renderer still draws from origin. The columns/rows count was
            // already computed against the padding-shrunk width in
            // updateSize(), so this keeps the text away from the pane edge.
            //
            // Phase B: in transparent mode we skip the padding drawColor so
            // the wallpaper bleeds through the gutters too — otherwise we'd
            // paint an opaque strip around every terminal pane.
            int padL = getPaddingLeft();
            int padT = getPaddingTop();
            int padR = getPaddingRight();
            int padB = getPaddingBottom();
            if (padL != 0 || padT != 0 || padR != 0 || padB != 0) {
                if (!mTransparentBackground) {
                    int bg = mEmulator.mColors.mCurrentColors[com.termux.terminal.TextStyle.COLOR_INDEX_BACKGROUND];
                    canvas.drawColor(bg);
                }
                canvas.save();
                canvas.translate(padL, padT);
            }

            // render the terminal view and highlight any selected text
            int[] sel = mDefaultSelectors;
            if (mTextSelectionCursorController != null) {
                mTextSelectionCursorController.getSelectors(sel);
            }

            mRenderer.render(mEmulator, canvas, mTopRow, sel[0], sel[1], sel[2], sel[3]);

            // Draw composing (pre-edit) text overlay at cursor position
            if (mComposingText != null && !mComposingText.isEmpty()) {
                drawComposingText(canvas);
            }

            if (padL != 0 || padT != 0 || padR != 0 || padB != 0) {
                canvas.restore();
            }

            // render the text selection handles
            renderTextSelection();
        }
    }

    /** Draw composing (IME pre-edit) text as a popup above the cursor row. */
    private void drawComposingText(Canvas canvas) {
        if (mEmulator == null || mRenderer == null) return;

        int cursorCol = mEmulator.getCursorCol();
        int cursorRow = mEmulator.getCursorRow();
        int visibleRow = cursorRow - mTopRow;

        // Baseline Y matching TerminalRenderer.render():
        // row N baseline = mFontLineSpacingAndAscent + (N+1) * mFontLineSpacing
        float cursorBaselineY = (visibleRow + 1) * mRenderer.mFontLineSpacing + mRenderer.mFontLineSpacingAndAscent;
        float cursorTopY = cursorBaselineY - mRenderer.mFontLineSpacingAndAscent;

        // Setup paint (match terminal font)
        mComposingPaint.setTypeface(mRenderer.mTypeface);
        mComposingPaint.setTextSize(mRenderer.mTextSize);
        mComposingPaint.setColor(0xFFFFFFFF);

        mComposingBgPaint.setColor(0xCC333333);

        float textWidth = mComposingPaint.measureText(mComposingText);
        float padding = 4f;

        // X position: start at cursor column
        float x = cursorCol * mRenderer.mFontWidth;
        if (x + textWidth + padding * 2 > getWidth()) {
            x = getWidth() - textWidth - padding * 2;
        }
        if (x < 0) x = 0;

        // Y position: place popup ABOVE the cursor row.
        // If cursor is on the first visible row, place BELOW instead.
        float popupHeight = mRenderer.mFontLineSpacing + padding * 2;
        float bgTop, bgBottom, baselineY;
        if (visibleRow > 0) {
            // Above cursor row
            bgBottom = cursorTopY - 2f;
            bgTop = bgBottom - popupHeight;
            baselineY = bgBottom - padding;
        } else {
            // Below cursor row (cursor on first row)
            bgTop = cursorBaselineY + 2f;
            bgBottom = bgTop + popupHeight;
            baselineY = bgBottom - padding;
        }

        canvas.drawRoundRect(
            new RectF(x - padding, bgTop, x + textWidth + padding, bgBottom),
            6f, 6f, mComposingBgPaint
        );

        mComposingPaint.setUnderlineText(true);
        canvas.drawText(mComposingText, x, baselineY, mComposingPaint);
        mComposingPaint.setUnderlineText(false);
    }

    public TerminalSession getCurrentSession() {
        return mTermSession;
    }

    private CharSequence getText() {
        return mEmulator.getScreen().getSelectedText(0, mTopRow, mEmulator.mColumns, mTopRow + mEmulator.mRows);
    }

    public int getCursorX(float x) {
        return (int) (x / mRenderer.mFontWidth);
    }

    public int getCursorY(float y) {
        return (int) (((y - 40) / mRenderer.mFontLineSpacing) + mTopRow);
    }

    public int getPointX(int cx) {
        if (cx > mEmulator.mColumns) {
            cx = mEmulator.mColumns;
        }
        return Math.round(cx * mRenderer.mFontWidth);
    }

    public int getPointY(int cy) {
        return Math.round((cy - mTopRow) * mRenderer.mFontLineSpacing);
    }

    public int getTopRow() {
        return mTopRow;
    }

    public void setTopRow(int mTopRow) {
        this.mTopRow = mTopRow;
    }



    /**
     * Define functions required for AutoFill API
     */
    @RequiresApi(api = Build.VERSION_CODES.O)
    @Override
    public void autofill(AutofillValue value) {
        if (value.isText()) {
            mTermSession.write(value.getTextValue().toString());
        }

        resetAutoFill();
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    @Override
    public int getAutofillType() {
        return mAutoFillType;
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    @Override
    public String[] getAutofillHints() {
        return mAutoFillHints;
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    @Override
    public AutofillValue getAutofillValue() {
        return AutofillValue.forText("");
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    @Override
    public int getImportantForAutofill() {
        return mAutoFillImportance;
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    private synchronized void resetAutoFill() {
        // Restore none type so that AutoFill UI isn't shown anymore.
        mAutoFillType = AUTOFILL_TYPE_NONE;
        mAutoFillImportance = IMPORTANT_FOR_AUTOFILL_NO;
        mAutoFillHints = new String[0];
    }

    public AutofillManager getAutoFillManagerService() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null;

        try {
            Context context = getContext();
            if (context == null) return null;
            return context.getSystemService(AutofillManager.class);
        } catch (Exception e) {
            mClient.logStackTraceWithMessage(LOG_TAG, "Failed to get AutofillManager service", e);
            return null;
        }
    }

    public boolean isAutoFillEnabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;

        try {
            AutofillManager autofillManager = getAutoFillManagerService();
            return autofillManager != null && autofillManager.isEnabled();
        } catch (Exception e) {
            mClient.logStackTraceWithMessage(LOG_TAG, "Failed to check if Autofill is enabled", e);
            return false;
        }
    }

    public synchronized void requestAutoFillUsername() {
        requestAutoFill(
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new String[]{View.AUTOFILL_HINT_USERNAME} :
                null);
    }

    public synchronized void requestAutoFillPassword() {
        requestAutoFill(
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new String[]{View.AUTOFILL_HINT_PASSWORD} :
            null);
    }

    public synchronized void requestAutoFill(String[] autoFillHints) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (autoFillHints == null || autoFillHints.length < 1) return;

        try {
            AutofillManager autofillManager = getAutoFillManagerService();
            if (autofillManager != null && autofillManager.isEnabled()) {
                // Update type that will be returned by `getAutofillType()` so that AutoFill UI is shown.
                mAutoFillType = AUTOFILL_TYPE_TEXT;
                // Update importance that will be returned by `getImportantForAutofill()` so that
                // AutoFill considers the view as important.
                mAutoFillImportance = IMPORTANT_FOR_AUTOFILL_YES;
                // Update hints that will be returned by `getAutofillHints()` for which to show AutoFill UI.
                mAutoFillHints = autoFillHints;
                autofillManager.requestAutofill(this);
            }
        } catch (Exception e) {
            mClient.logStackTraceWithMessage(LOG_TAG, "Failed to request Autofill", e);
        }
    }

    public synchronized void cancelRequestAutoFill() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (mAutoFillType == AUTOFILL_TYPE_NONE) return;

        try {
            AutofillManager autofillManager = getAutoFillManagerService();
            if (autofillManager != null && autofillManager.isEnabled()) {
                resetAutoFill();
                autofillManager.cancel();
            }
        } catch (Exception e) {
            mClient.logStackTraceWithMessage(LOG_TAG, "Failed to cancel Autofill request", e);
        }
    }





    /**
     * Set terminal cursor blinker rate. It must be between {@link #TERMINAL_CURSOR_BLINK_RATE_MIN}
     * and {@link #TERMINAL_CURSOR_BLINK_RATE_MAX}, otherwise it will be disabled.
     *
     * The {@link #setTerminalCursorBlinkerState(boolean, boolean)} must be called after this
     * for changes to take effect if not disabling.
     *
     * @param blinkRate The value to set.
     * @return Returns {@code true} if setting blinker rate was successfully set, otherwise [@code false}.
     */
    public synchronized boolean setTerminalCursorBlinkerRate(int blinkRate) {
        boolean result;

        // If cursor blinking rate is not valid
        if (blinkRate != 0 && (blinkRate < TERMINAL_CURSOR_BLINK_RATE_MIN || blinkRate > TERMINAL_CURSOR_BLINK_RATE_MAX)) {
            mClient.logError(LOG_TAG, "The cursor blink rate must be in between " + TERMINAL_CURSOR_BLINK_RATE_MIN + "-" + TERMINAL_CURSOR_BLINK_RATE_MAX + ": " + blinkRate);
            mTerminalCursorBlinkerRate = 0;
            result = false;
        } else {
            mClient.logVerbose(LOG_TAG, "Setting cursor blinker rate to " + blinkRate);
            mTerminalCursorBlinkerRate = blinkRate;
            result = true;
        }

        if (mTerminalCursorBlinkerRate == 0) {
            mClient.logVerbose(LOG_TAG, "Cursor blinker disabled");
            stopTerminalCursorBlinker();
        }

        return result;
    }

    /**
     * Sets whether cursor blinker should be started or stopped. Cursor blinker will only be
     * started if {@link #mTerminalCursorBlinkerRate} does not equal 0 and is between
     * {@link #TERMINAL_CURSOR_BLINK_RATE_MIN} and {@link #TERMINAL_CURSOR_BLINK_RATE_MAX}.
     *
     * This should be called when the view holding this activity is resumed or stopped so that
     * cursor blinker does not run when activity is not visible. If you call this on onResume()
     * to start cursor blinking, then ensure that {@link #mEmulator} is set, otherwise wait for the
     * {@link TerminalViewClient#onEmulatorSet()} event after calling {@link #attachSession(TerminalSession)}
     * for the first session added in the activity since blinking will not start if {@link #mEmulator}
     * is not set, like if activity is started again after exiting it with double back press. Do not
     * call this directly after {@link #attachSession(TerminalSession)} since {@link #updateSize()}
     * may return without setting {@link #mEmulator} since width/height may be 0. Its called again in
     * {@link #onSizeChanged(int, int, int, int)}. Calling on onResume() if emulator is already set
     * is necessary, since onEmulatorSet() may not be called after activity is started after device
     * display timeout with double tap and not power button.
     *
     * It should also be called on the
     * {@link com.termux.terminal.TerminalSessionClient#onTerminalCursorStateChange(boolean)}
     * callback when cursor is enabled or disabled so that blinker is disabled if cursor is not
     * to be shown. It should also be checked if activity is visible if blinker is to be started
     * before calling this.
     *
     * It should also be called after terminal is reset with {@link TerminalSession#reset()} in case
     * cursor blinker was disabled before reset due to call to
     * {@link com.termux.terminal.TerminalSessionClient#onTerminalCursorStateChange(boolean)}.
     *
     * How cursor blinker starting works is by registering a {@link Runnable} with the looper of
     * the main thread of the app which when run, toggles the cursor blinking state and re-registers
     * itself to be called with the delay set by {@link #mTerminalCursorBlinkerRate}. When cursor
     * blinking needs to be disabled, we just cancel any callbacks registered. We don't run our own
     * "thread" and let the thread for the main looper do the work for us, whose usage is also
     * required to update the UI, since it also handles other calls to update the UI as well based
     * on a queue.
     *
     * Note that when moving cursor in text editors like nano, the cursor state is quickly
     * toggled `-> off -> on`, which would call this very quickly sequentially. So that if cursor
     * is moved 2 or more times quickly, like long hold on arrow keys, it would trigger
     * `-> off -> on -> off -> on -> ...`, and the "on" callback at index 2 is automatically
     * cancelled by next "off" callback at index 3 before getting a chance to be run. For this case
     * we log only if {@link #TERMINAL_VIEW_KEY_LOGGING_ENABLED} is enabled, otherwise would clutter
     * the log. We don't start the blinking with a delay to immediately show cursor in case it was
     * previously not visible.
     *
     * @param start If cursor blinker should be started or stopped.
     * @param startOnlyIfCursorEnabled If set to {@code true}, then it will also be checked if the
     *                                 cursor is even enabled by {@link TerminalEmulator} before
     *                                 starting the cursor blinker.
     */
    public synchronized void setTerminalCursorBlinkerState(boolean start, boolean startOnlyIfCursorEnabled) {
        // Stop any existing cursor blinker callbacks
        stopTerminalCursorBlinker();

        if (mEmulator == null) return;

        mEmulator.setCursorBlinkingEnabled(false);

        if (start) {
            // If cursor blinker is not enabled or is not valid
            if (mTerminalCursorBlinkerRate < TERMINAL_CURSOR_BLINK_RATE_MIN || mTerminalCursorBlinkerRate > TERMINAL_CURSOR_BLINK_RATE_MAX)
                return;
            // If cursor blinder is to be started only if cursor is enabled
            else if (startOnlyIfCursorEnabled && ! mEmulator.isCursorEnabled()) {
                if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
                    mClient.logVerbose(LOG_TAG, "Ignoring call to start cursor blinker since cursor is not enabled");
                return;
            }

            // Start cursor blinker runnable
            if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
                mClient.logVerbose(LOG_TAG, "Starting cursor blinker with the blink rate " + mTerminalCursorBlinkerRate);
            if (mTerminalCursorBlinkerHandler == null)
                mTerminalCursorBlinkerHandler = new Handler(Looper.getMainLooper());
            mTerminalCursorBlinkerRunnable = new TerminalCursorBlinkerRunnable(mEmulator, mTerminalCursorBlinkerRate);
            mEmulator.setCursorBlinkingEnabled(true);
            mTerminalCursorBlinkerRunnable.run();
        }
    }

    /**
     * Cancel the terminal cursor blinker callbacks
     */
    private void stopTerminalCursorBlinker() {
        if (mTerminalCursorBlinkerHandler != null && mTerminalCursorBlinkerRunnable != null) {
            if (TERMINAL_VIEW_KEY_LOGGING_ENABLED)
                mClient.logVerbose(LOG_TAG, "Stopping cursor blinker");
            mTerminalCursorBlinkerHandler.removeCallbacks(mTerminalCursorBlinkerRunnable);
        }
    }

    private class TerminalCursorBlinkerRunnable implements Runnable {

        private TerminalEmulator mEmulator;
        private final int mBlinkRate;

        // Initialize with false so that initial blink state is visible after toggling
        boolean mCursorVisible = false;

        public TerminalCursorBlinkerRunnable(TerminalEmulator emulator, int blinkRate) {
            mEmulator = emulator;
            mBlinkRate = blinkRate;
        }

        public void setEmulator(TerminalEmulator emulator) {
            mEmulator = emulator;
        }

        public void run() {
            try {
                if (mEmulator != null) {
                    // Toggle the blink state and then invalidate() the view so
                    // that onDraw() is called, which then calls TerminalRenderer.render()
                    // which checks with TerminalEmulator.shouldCursorBeVisible() to decide whether
                    // to draw the cursor or not
                    mCursorVisible = !mCursorVisible;
                    //mClient.logVerbose(LOG_TAG, "Toggling cursor blink state to " + mCursorVisible);
                    mEmulator.setCursorBlinkState(mCursorVisible);
                    invalidate();
                }
            } finally {
                // Recall the Runnable after mBlinkRate milliseconds to toggle the blink state
                mTerminalCursorBlinkerHandler.postDelayed(this, mBlinkRate);
            }
        }
    }



    /**
     * Define functions required for text selection and its handles.
     */
    TextSelectionCursorController getTextSelectionCursorController() {
        if (mTextSelectionCursorController == null) {
            mTextSelectionCursorController = new TextSelectionCursorController(this);

            final ViewTreeObserver observer = getViewTreeObserver();
            if (observer != null) {
                observer.addOnTouchModeChangeListener(mTextSelectionCursorController);
            }
        }

        return mTextSelectionCursorController;
    }

    private void showTextSelectionCursors(MotionEvent event) {
        getTextSelectionCursorController().show(event);
    }

    private boolean hideTextSelectionCursors() {
        return getTextSelectionCursorController().hide();
    }

    private void renderTextSelection() {
        if (mTextSelectionCursorController != null)
            mTextSelectionCursorController.render();
    }

    public boolean isSelectingText() {
        if (mTextSelectionCursorController != null) {
            return mTextSelectionCursorController.isActive();
        } else {
            return false;
        }
    }

    /** Get the currently selected text if selecting. */
    public String getSelectedText() {
        if (isSelectingText() && mTextSelectionCursorController != null)
            return mTextSelectionCursorController.getSelectedText();
        else
            return null;
    }

    /** Get the selected text stored before "MORE" button was pressed on the context menu. */
    @Nullable
    public String getStoredSelectedText() {
        return mTextSelectionCursorController != null ? mTextSelectionCursorController.getStoredSelectedText() : null;
    }

    /** Unset the selected text stored before "MORE" button was pressed on the context menu. */
    public void unsetStoredSelectedText() {
        if (mTextSelectionCursorController != null) mTextSelectionCursorController.unsetStoredSelectedText();
    }

    private ActionMode getTextSelectionActionMode() {
        if (mTextSelectionCursorController != null) {
            return mTextSelectionCursorController.getActionMode();
        } else {
            return null;
        }
    }

    public void startTextSelectionMode(MotionEvent event) {
        if (!requestFocus()) {
            return;
        }

        showTextSelectionCursors(event);
        mClient.copyModeChanged(isSelectingText());

        invalidate();
    }

    public void stopTextSelectionMode() {
        if (hideTextSelectionCursors()) {
            mClient.copyModeChanged(isSelectingText());
            invalidate();
        }
    }

    private void decrementYTextSelectionCursors(int decrement) {
        if (mTextSelectionCursorController != null) {
            mTextSelectionCursorController.decrementYTextSelectionCursors(decrement);
        }
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();

        if (mTextSelectionCursorController != null) {
            getViewTreeObserver().addOnTouchModeChangeListener(mTextSelectionCursorController);
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();

        if (mTextSelectionCursorController != null) {
            // Might solve the following exception
            // android.view.WindowLeaked: Activity com.termux.app.TermuxActivity has leaked window android.widget.PopupWindow
            stopTextSelectionMode();

            getViewTreeObserver().removeOnTouchModeChangeListener(mTextSelectionCursorController);
            mTextSelectionCursorController.onDetached();
        }
    }



    /**
     * Define functions required for long hold toolbar.
     */
    private final Runnable mShowFloatingToolbar = new Runnable() {
        @RequiresApi(api = Build.VERSION_CODES.M)
        @Override
        public void run() {
            if (getTextSelectionActionMode() != null) {
                getTextSelectionActionMode().hide(0);  // hide off.
            }
        }
    };

    @RequiresApi(api = Build.VERSION_CODES.M)
    private void showFloatingToolbar() {
        if (getTextSelectionActionMode() != null) {
            int delay = ViewConfiguration.getDoubleTapTimeout();
            postDelayed(mShowFloatingToolbar, delay);
        }
    }

    @RequiresApi(api = Build.VERSION_CODES.M)
    void hideFloatingToolbar() {
        if (getTextSelectionActionMode() != null) {
            removeCallbacks(mShowFloatingToolbar);
            getTextSelectionActionMode().hide(-1);
        }
    }

    public void updateFloatingToolbarVisibility(MotionEvent event) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && getTextSelectionActionMode() != null) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_MOVE:
                    hideFloatingToolbar();
                    break;
                case MotionEvent.ACTION_UP:  // fall through
                case MotionEvent.ACTION_CANCEL:
                    showFloatingToolbar();
            }
        }
    }

}
