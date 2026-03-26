/**
 * Terminal Screen — Raw terminal via ttyd + WebView
 * Japanese input proxy + auto-retry + setup guide
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTtydConnection } from '@/hooks/use-ttyd-connection';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation, t } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { stripAnsi } from '@/lib/strip-ansi';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useActiveSession, useTerminalStore } from '@/store/terminal-store';
import { TerminalHeader } from '@/components/terminal/TerminalHeader';
import { killTtyd } from '@/lib/ttyd-manager';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import * as FileSystem from 'expo-file-system/legacy';
import { CommandKeyBar } from '@/components/terminal/CommandKeyBar';
import { TerminalActionBar } from '@/components/terminal/TerminalActionBar';
import { startSmartWakelock, stopSmartWakelock } from '@/lib/smart-wakelock';
import { startPhantomGuard, stopPhantomGuard, monitorPort, unmonitorPort, showPhantomKillerRecovery } from '@/lib/phantom-process-guard';
import { loadSessionsFromProject, startAutoSave, stopAutoSave } from '@/lib/session-persistence';
import { VoiceChat } from '@/components/VoiceChat';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASHRC_SCRIPT = `# Shelly auto-start
if ! pgrep -x ttyd > /dev/null; then
  ttyd -W -p 7681 bash &>/dev/null &
fi`;

// One-tap setup: installs ttyd + configures .bashrc in a single command
const ONE_TAP_SETUP = `pkg update -y && pkg install -y ttyd && mkdir -p ~/.shelly && cat >> ~/.bashrc << 'SHELLY_EOF'

# Shelly auto-start
if ! pgrep -x ttyd > /dev/null; then
  ttyd -W -p 7681 bash &>/dev/null &
fi
SHELLY_EOF
echo "Setup complete! Restart Termux to activate."`;


type ConnectionState = 'connecting' | 'connected' | 'error';

// ─── Terminal Output Capture ───────────────────────────────────────────────────

const CAPTURE_INJECT_JS = `
(function() {
  if (window.__shellyCaptureActive) return;
  window.__shellyCaptureActive = true;

  function hookXterm() {
    var term = window.term || document.querySelector('.xterm')?.xterm;
    if (!term) {
      setTimeout(hookXterm, 500);
      return;
    }

    var buf = term.buffer;
    if (!buf || !buf.active) {
      setTimeout(hookXterm, 500);
      return;
    }

    // Track absolute line position (baseY + cursorY)
    var lastAbsLine = buf.active.baseY + buf.active.cursorY;

    setInterval(function() {
      try {
        var active = term.buffer.active;
        var currentAbsLine = active.baseY + active.cursorY;
        if (currentAbsLine <= lastAbsLine) return;

        // Read only the new lines since last check
        var lines = [];
        var start = Math.max(0, lastAbsLine);
        var end = Math.min(currentAbsLine, active.length - 1);
        for (var i = start; i <= end; i++) {
          var line = active.getLine(i);
          if (line) {
            var text = line.translateToString(true);
            if (text.trim()) lines.push(text);
          }
        }
        lastAbsLine = currentAbsLine;

        if (lines.length > 0) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'terminal-output',
            text: lines.join('\\n')
          }));
        }
      } catch(e) {}
    }, 500);
  }
  hookXterm();
})();
true;
`;

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { t } = useTranslation();
  const layout = useDeviceLayout();
  const webViewRef = useRef<WebView>(null);
  const inputRef = useRef<TextInput>(null);
  const activeSession = useActiveSession();
  const { removeSession, sessions } = useTerminalStore();
  const { runRawCommand } = useTermuxBridge();
  const {
    status,
    retryCount,
    retry,
    onWebViewLoad,
    onWebViewError,
    ttyUrl,
  } = useTtydConnection(activeSession?.ttyUrl);

  // Voice dialog mode state
  const [voiceChatVisible, setVoiceChatVisible] = useState(false);

  // Recovery state — shown while WebView reloads after render process kill
  const [isRecovering, setIsRecovering] = useState(false);

  // Clean up WebView on unmount (e.g. when multi-pane → single-pane)
  useEffect(() => {
    return () => {
      webViewRef.current?.stopLoading();
    };
  }, []);

  // Start smart wakelock + phantom process guard on mount
  useEffect(() => {
    startSmartWakelock(runRawCommand);
    const ports = sessions.map((s) => s.port);
    startPhantomGuard(ports, runRawCommand, (killedPort) => {
      const killed = sessions.find((s) => s.port === killedPort);
      if (killed) {
        showPhantomKillerRecovery(killed.name, () => {
          retry();
        });
      }
    });
    return () => {
      stopSmartWakelock();
      stopPhantomGuard();
    };
  }, []);

  // Keep phantom guard in sync with session changes
  useEffect(() => {
    for (const s of sessions) {
      monitorPort(s.port);
    }
  }, [sessions.length]);

  // Auto-save sessions to project directory (if chat has a projectPath)
  useEffect(() => {
    // Try to detect project path from first session's cwd or chat store
    const cwd = activeSession?.currentDir;
    if (cwd && cwd !== '/home/user' && cwd !== '') {
      startAutoSave(cwd, runRawCommand);
      return () => stopAutoSave();
    }
  }, [activeSession?.currentDir, runRawCommand]);

  // Track actual WebView render success (distinct from HTTP HEAD check)
  const [webViewFailed, setWebViewFailed] = useState(false);

  // Reset state on session switch — WebView URI change triggers onLoadEnd → re-injection
  const prevSessionIdRef = useRef(activeSession?.id);
  useEffect(() => {
    if (activeSession && activeSession.id !== prevSessionIdRef.current) {
      prevSessionIdRef.current = activeSession.id;
      setWebViewFailed(false);
    }
  }, [activeSession?.id]);

  const addTerminalOutput = useExecutionLogStore((s) => s.addTerminalOutput);

  // Japanese input proxy state
  const [jpInput, setJpInput] = useState('');
  const [showJpInput, setShowJpInput] = useState(false);

  const handleReload = () => {
    retry();
    webViewRef.current?.reload();
  };

  // Send text to terminal via xterm.js paste() API (Bracketed Paste Mode)
  const sendToTerminal = useCallback((text: string) => {
    if (!webViewRef.current || !text) return;
    // Use JSON.stringify for safe JS string escaping (prevents XSS injection)
    const safeText = JSON.stringify(text);
    const js = `
      (function() {
        var text = ${safeText};
        var term = window.term || document.querySelector('.xterm')?.xterm;
        if (term && typeof term.paste === 'function') {
          // Official xterm.js API — handles bracketed paste mode automatically
          term.paste(text);
        } else if (term && term._core && term._core._coreService) {
          // Fallback for older xterm.js without paste()
          var data = '\\x1b[200~' + text + '\\x1b[201~';
          term._core._coreService.triggerDataEvent(data, true);
        } else if (window.socket && window.socket.send) {
          // Last resort: send directly via ttyd WebSocket
          window.socket.send('0' + text);
        }
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(js);
  }, []);

  // Send raw key code to xterm.js (for command key bar)
  const sendKey = useCallback((keyCode: string) => {
    if (!webViewRef.current) return;
    const safeKey = JSON.stringify(keyCode);
    const js = `
      (function() {
        var term = window.term || (window.lib && window.lib.terminal) || window.tty;
        if (!term) {
          var el = document.querySelector('.xterm');
          if (el) term = el._xterm || el.xterm;
        }
        if (term && term._core && term._core._coreService) {
          term._core._coreService.triggerDataEvent(${safeKey}, true);
        } else if (window.socket && window.socket.send) {
          window.socket.send('0' + ${safeKey});
        }
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(js);
  }, []);

  // Copy file from device to terminal cwd via bridge
  const copyFileToCwd = useCallback(async (sourceUri: string, fileName: string) => {
    try {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      // Copy to Termux-accessible path via expo-file-system, then mv via bridge
      const tempPath = `${FileSystem.cacheDirectory}${safeName}`;
      await FileSystem.copyAsync({ from: sourceUri, to: tempPath });
      // Copy from app cache to terminal cwd via bridge
      await runRawCommand(
        `cp '${tempPath}' './${safeName}' 2>/dev/null && echo "Copied ${safeName} to $(pwd)"`,
        { timeoutMs: 10000, reason: 'file-attach' },
      );
    } catch (e) {
      console.warn('[Terminal] file copy failed:', e);
    }
  }, [runRawCommand]);

  const handleJpSend = useCallback(() => {
    const text = jpInput.trim();
    if (!text) return;
    sendToTerminal(text);
    setJpInput('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [jpInput, sendToTerminal]);

  const handleJpSendNewline = useCallback(() => {
    const text = jpInput;
    if (!text) {
      // Just send Enter
      sendToTerminal('\r');
      return;
    }
    sendToTerminal(text + '\r');
    setJpInput('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [jpInput, sendToTerminal]);

  const toggleJpInput = useCallback(() => {
    setShowJpInput((v) => !v);
    if (!showJpInput) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [showJpInput]);

  const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'terminal-output' && data.text) {
        const lines = stripAnsi(data.text).split('\n').filter((l: string) => l.trim());
        const sid = activeSession?.id;
        for (const line of lines) {
          addTerminalOutput(line, sid);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }, [addTerminalOutput, activeSession?.id]);

  // Adaptive terminal font size for small screens (Z Fold6 cover ≈ 373dp)
  // Adaptive font size: compact cover screen needs bigger text due to high DPI
  // Note: Z Fold6 cover (968px @ 464dpi ≈ 333dp) may report as Wide due to
  // configChanges preventing Activity recreation on fold/unfold, so we also
  // check actual pixel width via PixelRatio for a secondary compact detection.
  const termFontSize = layout.isCompact ? 20 : layout.width < 500 ? 18 : layout.isWide ? 14 : 16;

  // Build font injection JS that tries multiple approaches
  const FONT_INJECT_JS = `
    (function() {
      var TARGET_SIZE = ${termFontSize};
      var attempts = 0;
      function apply() {
        // Approach 1: ttyd stores terminal on window.term (older ttyd)
        // Approach 2: ttyd 1.7+ stores on lib.terminal or window.tty
        var term = window.term || (window.lib && window.lib.terminal) || window.tty;
        // Approach 3: find xterm instance via DOM
        if (!term) {
          var xtermEl = document.querySelector('.xterm');
          if (xtermEl) {
            // xterm.js 4.x+ stores instance in _core
            term = xtermEl._xterm || xtermEl.xterm;
            if (!term) {
              // Walk up to find Terminal instance
              var keys = Object.keys(xtermEl);
              for (var i = 0; i < keys.length; i++) {
                var val = xtermEl[keys[i]];
                if (val && val.options && typeof val.options.fontSize === 'number') {
                  term = val; break;
                }
              }
            }
          }
        }
        if (term && term.options) {
          term.options.fontSize = TARGET_SIZE;
          // Fix Unicode/CJK rendering: use a font stack that covers symbols and CJK
          term.options.fontFamily = '"Droid Sans Mono", "Noto Sans Mono", "Noto Sans CJK JP", monospace';
          // Enable Unicode 11 for correct CJK character width calculation
          if (term.unicode && term.unicode.activeVersion !== '11') {
            try {
              if (typeof Unicode11Addon !== 'undefined') {
                term.loadAddon(new Unicode11Addon.Unicode11Addon());
                term.unicode.activeVersion = '11';
              } else {
                // Dynamically load unicode11 addon from CDN
                var script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/xterm-addon-unicode11@0.6.0/lib/xterm-addon-unicode11.js';
                script.onload = function() {
                  try {
                    term.loadAddon(new Unicode11Addon.Unicode11Addon());
                    term.unicode.activeVersion = '11';
                    term.refresh(0, term.rows - 1);
                  } catch(e2) {}
                };
                document.head.appendChild(script);
              }
            } catch(e) {}
          }
          // Force re-render
          try { term.refresh(0, term.rows - 1); } catch(e) {}
          try {
            // FitAddon — multiple possible locations
            var fit = window.fitAddon || (term._addonManager && term._addonManager._addons);
            if (window.fitAddon && window.fitAddon.fit) { window.fitAddon.fit(); }
            else if (fit) {
              fit.forEach(function(a) { if (a.instance && a.instance.fit) a.instance.fit(); });
            }
          } catch(e) {}
          return;
        }
        // Approach 4: CSS fallback — force font-size on xterm canvas/rows
        var xtermScreen = document.querySelector('.xterm-screen');
        if (xtermScreen) {
          var style = document.createElement('style');
          style.textContent = '.xterm-rows { font-size: ' + TARGET_SIZE + 'px !important; font-family: "Droid Sans Mono", "Noto Sans Mono", "Noto Sans CJK JP", monospace !important; } .xterm { font-size: ' + TARGET_SIZE + 'px !important; }';
          document.head.appendChild(style);
          return;
        }
        if (attempts++ < 20) setTimeout(apply, 500);
      }
      apply();
    })();
    true;
  `;

  const handleWebViewLoad = useCallback(() => {
    setWebViewFailed(false);
    setIsRecovering(false);
    onWebViewLoad();
    // Inject terminal output capture after xterm.js initializes
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(CAPTURE_INJECT_JS);
    }, 1000);
    // Font size injection — delayed + retrying to catch late xterm.js init
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(FONT_INJECT_JS);
    }, 2000);
    // Restore previous terminal output after reconnect
    setTimeout(() => {
      const sessionLines = useExecutionLogStore.getState().sessionBuffer;
      if (sessionLines.length > 0) {
        const lines = sessionLines
          .slice(-50)
          .map(l => l.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n'))
          .join('\\r\\n');
        const restoreJS = `
          (function() {
            function restore() {
              var term = window.term || (window.lib && window.lib.terminal) || window.tty;
              if (!term) {
                var xtermEl = document.querySelector('.xterm');
                if (xtermEl) {
                  term = xtermEl._xterm || xtermEl.xterm;
                  if (!term) {
                    var keys = Object.keys(xtermEl);
                    for (var i = 0; i < keys.length; i++) {
                      var val = xtermEl[keys[i]];
                      if (val && val.write) { term = val; break; }
                    }
                  }
                }
              }
              if (term && term.write) {
                term.write('\\x1b[90m--- Previous session output ---\\x1b[0m\\r\\n');
                term.write('\\x1b[90m${lines}\\x1b[0m\\r\\n');
                term.write('\\x1b[90m--- End of previous output ---\\x1b[0m\\r\\n\\r\\n');
              } else {
                setTimeout(restore, 500);
              }
            }
            restore();
          })();
          true;
        `;
        webViewRef.current?.injectJavaScript(restoreJS);
      }
    }, 3000);
  }, [onWebViewLoad, FONT_INJECT_JS]);

  const handleWebViewError2 = useCallback(() => {
    setWebViewFailed(true);
    onWebViewError();
  }, [onWebViewError]);

  // WebView render process killed (split-screen, memory pressure, etc.)
  // Show recovery splash while WebView reloads — ttyd/tmux are still alive
  const handleRenderProcessGone = useCallback(() => {
    console.warn('[Terminal] WebView render process gone — recovering');
    setIsRecovering(true);
    setWebViewFailed(false);
    setTimeout(() => {
      webViewRef.current?.reload();
      retry();
    }, 300);
  }, [retry]);

  // Scroll xterm.js to bottom
  const scrollToBottom = useCallback(() => {
    if (!webViewRef.current) return;
    const js = `
      (function() {
        var term = window.term || (window.lib && window.lib.terminal) || window.tty;
        if (!term) {
          var el = document.querySelector('.xterm');
          if (el) term = el._xterm || el.xterm;
        }
        if (term && term.scrollToBottom) term.scrollToBottom();
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(js);
  }, []);

  // Handle session removal with ttyd cleanup
  const handleRemoveSession = useCallback(async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      killTtyd(session.port, runRawCommand);
    }
    removeSession(sessionId);
  }, [sessions, removeSession, runRawCommand]);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: c.background }]}>
      {/* Session Tab Header */}
      <TerminalHeader />

      {/* Quick Actions Bar (JP input + reload) */}
      <View style={[styles.quickBar, { backgroundColor: c.surfaceHigh, borderBottomColor: c.border }]}>
        <StatusBadge state={webViewFailed ? 'error' : status} retryCount={retryCount} colors={c} />
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={toggleJpInput}
          style={[
            styles.jpToggle,
            { backgroundColor: showJpInput ? withAlpha(c.accent, 0.15) : 'transparent', borderColor: showJpInput ? c.accent : c.border },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Japanese input toggle"
        >
          <Text style={[styles.jpToggleText, { color: showJpInput ? c.accent : c.muted }]}>あ</Text>
        </TouchableOpacity>
        <Pressable onPress={handleReload} style={styles.reloadBtn} accessibilityRole="button" accessibilityLabel="Reload terminal">
          <MaterialIcons name="refresh" size={18} color={c.foreground} />
        </Pressable>
      </View>

      {/* Connecting Spinner */}
      {status === 'connecting' && (
        <View style={styles.connectingContainer}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={[styles.connectingText, { color: c.foreground }]}>{t('terminal.connecting_ttyd')}</Text>
          {retryCount > 0 && (
            <Text style={[styles.connectingRetry, { color: c.muted }]}>
              {t('terminal.retry_count', { count: retryCount })}
            </Text>
          )}
        </View>
      )}

      {/* WebView (ttyd) — always mounted to prevent reload on tab switch */}
      <WebView
        ref={webViewRef}
        source={{ uri: ttyUrl }}
        style={[styles.webView, status !== 'connected' && { height: 0, opacity: 0 }]}
        javaScriptEnabled
        domStorageEnabled
        textZoom={100}
        onLoadEnd={handleWebViewLoad}
        onError={handleWebViewError2}
        onHttpError={handleWebViewError2}
        onRenderProcessGone={handleRenderProcessGone}
        onMessage={handleWebViewMessage}
      />

      {/* Recovery splash — shown while WebView reloads after render process kill */}
      {isRecovering && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center', zIndex: 10 }]}>
          <ActivityIndicator size="small" color="#00D4AA" />
          <Text style={{ color: '#4B5563', fontFamily: 'monospace', fontSize: 11, marginTop: 8 }}>
            Restoring session...
          </Text>
        </View>
      )}

      {/* Japanese Input Proxy */}
      {status === 'connected' && showJpInput && (
        <View style={[styles.jpInputBar, { backgroundColor: c.surfaceHigh, borderTopColor: c.border }]}>
          <TextInput
            ref={inputRef}
            style={[styles.jpInputField, { backgroundColor: c.backgroundDeep, color: c.foreground, borderColor: c.borderLight }]}
            value={jpInput}
            onChangeText={setJpInput}
            placeholder={t('terminal.jp_placeholder')}
            placeholderTextColor={c.inactive}
            autoCapitalize="none"
            autoCorrect={false}
            multiline={false}
            returnKeyType="send"
            onSubmitEditing={handleJpSendNewline}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            onPress={handleJpSend}
            style={[styles.jpSendBtn, { backgroundColor: withAlpha(c.accent, 0.15) }]}
            activeOpacity={0.7}
          >
            <Text style={[styles.jpSendText, { color: c.accent }]}>{t('terminal.paste')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleJpSendNewline}
            style={[styles.jpSendBtn, { backgroundColor: c.accent }]}
            activeOpacity={0.7}
          >
            <MaterialIcons name="send" size={16} color={c.background} />
          </TouchableOpacity>
        </View>
      )}

      {/* Command Key Bar (Ctrl+C, Tab, ↑, ↓, Paste) */}
      {status === 'connected' && (
        <CommandKeyBar
          sendKey={sendKey}
          sendText={sendToTerminal}
          isCompact={layout.isCompact || layout.width < 400}
        />
      )}

      {/* Scroll to bottom FAB */}
      {status === 'connected' && (
        <Pressable
          onPress={scrollToBottom}
          style={styles.scrollToBottomFab}
          accessibilityRole="button"
          accessibilityLabel="Scroll to bottom"
        >
          <MaterialIcons name="keyboard-arrow-down" size={22} color="#00D4AA" />
        </Pressable>
      )}

      {/* Action Bar (Attach + Voice) */}
      {status === 'connected' && (
        <TerminalActionBar
          copyFileToCwd={copyFileToCwd}
          sendText={sendToTerminal}
          onVoiceDialog={() => setVoiceChatVisible(true)}
        />
      )}

      {/* Voice Dialog Mode */}
      <VoiceChat
        visible={voiceChatVisible}
        onClose={() => setVoiceChatVisible(false)}
      />

      {/* Error: Setup Guide */}
      {(status === 'error' || webViewFailed) && <SetupGuide url={ttyUrl} onRetry={() => { setWebViewFailed(false); retry(); }} colors={c} />}
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state, retryCount, colors: c }: { state: ConnectionState; retryCount: number; colors: any }) {
  const label =
    state === 'connected' ? t('terminal.connected') :
    state === 'connecting' ? (retryCount > 0 ? t('terminal.connecting_retry', { count: retryCount }) : t('terminal.connecting')) :
    t('terminal.disconnected');

  const color =
    state === 'connected' ? '#4ADE80' :
    state === 'connecting' ? '#FBBF24' :
    '#FF7878';

  return (
    <View style={[styles.badge, { borderColor: color }]}>
      {state === 'connecting' ? (
        <ActivityIndicator size={8} color={color} style={{ marginRight: 2 }} />
      ) : (
        <View style={[styles.badgeDot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function SetupGuide({ url, onRetry, colors: c }: { url: string; onRetry: () => void; colors: any }) {
  const [copied, setCopied] = useState(false);
  const [oneTapCopied, setOneTapCopied] = useState(false);

  const handleCopy = async () => {
    try { await Clipboard.setStringAsync(BASHRC_SCRIPT); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOneTapSetup = async () => {
    try { await Clipboard.setStringAsync(ONE_TAP_SETUP); } catch {}
    setOneTapCopied(true);
    // Open Termux so user can paste
    Linking.openURL('com.termux://').catch(() => {
      Linking.openURL('https://play.google.com/store/apps/details?id=com.termux').catch(() => {});
    });
    setTimeout(() => setOneTapCopied(false), 3000);
  };

  const handleOpenTermux = () => {
    Linking.openURL('com.termux://').catch(() => {
      Linking.openURL('https://play.google.com/store/apps/details?id=com.termux').catch(() => {});
    });
  };

  return (
    <ScrollView style={styles.guideContainer} contentContainerStyle={styles.guideContent}>
      <MaterialIcons name="terminal" size={48} color={c.accent} />
      <Text style={[styles.guideTitle, { color: c.accent }]}>{t('terminal.cannot_connect')}</Text>
      <Text style={[styles.guideSubtitle, { color: c.muted }]}>
        {t('terminal.cannot_connect_desc', { url })}
      </Text>

      {/* One-tap setup button */}
      <Pressable
        style={[styles.oneTapBtn, { backgroundColor: c.accent }]}
        onPress={handleOneTapSetup}
        accessibilityRole="button"
        accessibilityLabel="One-tap setup"
      >
        <MaterialIcons name={oneTapCopied ? 'check' : 'flash-on'} size={22} color="#0A0A0A" />
        <View>
          <Text style={styles.oneTapBtnTitle}>
            {oneTapCopied ? t('terminal.one_tap_copied') : t('terminal.one_tap_setup')}
          </Text>
          <Text style={styles.oneTapBtnDesc}>{t('terminal.one_tap_desc')}</Text>
        </View>
      </Pressable>

      <Text style={[styles.orDivider, { color: c.muted }]}>{t('terminal.or_manually')}</Text>

      <View style={[styles.stepsCard, { backgroundColor: c.surfaceHigh, borderColor: c.border }]}>
        <Text style={[styles.stepHeader, { color: c.accent }]}>{t('terminal.manual_setup')}</Text>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>1</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>{t('terminal.install_ttyd')}</Text>
            <View style={[styles.codeBlock, { borderColor: c.border }]}>
              <Text style={[styles.codeText, { color: c.accent }]}>pkg install ttyd</Text>
            </View>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>2</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>{t('terminal.add_autostart')}</Text>
            <View style={[styles.codeBlock, { borderColor: c.border }]}>
              <Text style={[styles.codeText, { color: c.accent }]}>{BASHRC_SCRIPT}</Text>
            </View>
            <Pressable onPress={handleCopy} style={[styles.copyBtn, { borderColor: c.border }]}>
              <MaterialIcons name={copied ? 'check' : 'content-copy'} size={16} color={copied ? '#4ADE80' : c.accent} />
              <Text style={[styles.copyBtnText, { color: copied ? '#4ADE80' : c.accent }]}>
                {copied ? t('ai.copied') : t('ai.copy')}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>3</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>{t('terminal.open_termux')}</Text>
            <Pressable onPress={handleOpenTermux} style={styles.termuxBtn}>
              <MaterialIcons name="open-in-new" size={16} color="#0A0A0A" />
              <Text style={styles.termuxBtnText}>{t('terminal.open_termux')}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>4</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>{t('terminal.reload_tab')}</Text>
          </View>
        </View>
      </View>

      <Pressable style={[styles.retryBtn, { backgroundColor: c.accent }]} onPress={onRetry}>
        <MaterialIcons name="refresh" size={20} color="#0A0A0A" />
        <Text style={styles.retryBtnText}>{t('terminal.reload')}</Text>
      </Pressable>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Quick actions bar (below TerminalHeader)
  quickBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 6,
  },
  reloadBtn: { padding: 4, borderRadius: 6 },

  // JP toggle
  jpToggle: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  jpToggleText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },

  // Badge
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 10, fontFamily: 'monospace', fontWeight: '600' },

  // Connecting
  connectingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  connectingText: { fontSize: 15, fontFamily: 'monospace', fontWeight: '600' },
  connectingRetry: { fontSize: 12, fontFamily: 'monospace' },

  // WebView
  webView: { flex: 1, backgroundColor: '#000' },

  // Japanese input bar
  jpInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    gap: 6,
  },
  jpInputField: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 14,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 38,
  },
  jpSendBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 38,
  },
  jpSendText: { fontSize: 12, fontWeight: '700', fontFamily: 'monospace' },

  // Setup guide
  guideContainer: { flex: 1 },
  guideContent: { alignItems: 'center', padding: 24, gap: 16 },
  guideTitle: { fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  guideSubtitle: { fontSize: 13, fontFamily: 'monospace', textAlign: 'center', lineHeight: 20 },
  oneTapBtn: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 12 },
  oneTapBtnTitle: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  oneTapBtnDesc: { color: '#0A0A0Aaa', fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  orDivider: { fontSize: 12, fontFamily: 'monospace' },
  stepsCard: { width: '100%', borderRadius: 12, borderWidth: 1, padding: 16, gap: 16 },
  stepHeader: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1 },
  step: { flexDirection: 'row', gap: 12 },
  stepNumber: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace', width: 20, textAlign: 'center' },
  stepBody: { flex: 1, gap: 6 },
  stepLabel: { fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  codeBlock: { backgroundColor: '#1A1A2E', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1 },
  codeText: { fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  copyBtnText: { fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
  termuxBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, backgroundColor: '#4ADE80' },
  termuxBtnText: { color: '#0A0A0A', fontSize: 13, fontFamily: 'monospace', fontWeight: '700' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  scrollToBottomFab: {
    position: 'absolute',
    right: 12,
    bottom: 120,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderWidth: 1,
    borderColor: '#00D4AA44',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
});
