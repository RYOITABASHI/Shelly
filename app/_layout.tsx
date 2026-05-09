import "@/global.css";
import React from "react";
import { logInfo, logError, logLifecycle } from '@/lib/debug-logger';
import { Stack } from "expo-router";
import { ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, View, Text, Pressable, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { Silkscreen_400Regular, Silkscreen_700Bold } from "@expo-google-fonts/silkscreen";
import { JetBrainsMono_400Regular, JetBrainsMono_700Bold } from "@expo-google-fonts/jetbrains-mono";
import { useTerminalStore } from "@/store/terminal-store";
import { useSoundStore, unloadSounds } from "@/lib/sounds";
import { loadAgentsFromDisk } from "@/lib/agent-manager";
import { useI18n } from '@/lib/i18n';
import { useThemeStore } from '@/lib/theme-engine';
import { useA11yStore } from '@/lib/accessibility';
import { usePluginStore } from '@/lib/plugin-api';
import { useSettingsStore } from '@/store/settings-store';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as WebBrowser from 'expo-web-browser';
import { useBrowserStore } from '@/store/browser-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  logError('ErrorBoundary', 'Uncaught error', error);
  return (
    <View style={ebStyles.container}>
      <Text style={ebStyles.title}>Something went wrong</Text>
      <Text style={ebStyles.message}>{error.message}</Text>
      <Pressable style={ebStyles.button} onPress={retry}>
        <Text style={ebStyles.buttonText}>Try Again</Text>
      </Pressable>
    </View>
  );
}

const ebStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D1117', justifyContent: 'center', alignItems: 'center', padding: 24 },
  title: { color: '#F85149', fontSize: 20, fontWeight: '700', fontFamily: 'JetBrainsMono_400Regular', marginBottom: 12 },
  message: { color: '#8B949E', fontSize: 14, fontFamily: 'JetBrainsMono_400Regular', textAlign: 'center', marginBottom: 24 },
  button: { backgroundColor: '#21262D', borderWidth: 1, borderColor: '#30363D', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  buttonText: { color: '#C9D1D9', fontSize: 14, fontFamily: 'JetBrainsMono_400Regular', fontWeight: '600' },
});

export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'PixelMplus12': require('@/assets/fonts/PixelMplus12-Regular.ttf'),
    'GeistPixel-Square': require('@/assets/fonts/GeistPixel-Square.ttf'),
    'PressStart2P': require('@/assets/fonts/PressStart2P_400Regular.ttf'),
    // Silkscreen — closer to the mock's readable pixel aesthetic than
    // PressStart2P (which is a pure 8×8 grid). Provided via
    // @expo-google-fonts/silkscreen's named export (not a direct .ttf
    // path — Metro can't resolve that through the package subpath).
    'Silkscreen': Silkscreen_400Regular,
    'Silkscreen-Bold': Silkscreen_700Bold,
    // JetBrains Mono — default UI font replacing Silkscreen. Silkscreen
    // renders lowercase code points with uppercase glyphs (Google Fonts
    // design), which made every lowercase UI label read as shouting.
    // JetBrains Mono gives us real lowercase, keeps the monospace feel
    // across terminal + UI, and avoids shipping yet another font file.
    'JetBrainsMono_400Regular': JetBrainsMono_400Regular,
    'JetBrainsMono_700Bold': JetBrainsMono_700Bold,
  });
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'shelly');
  const loadSettings = useTerminalStore((s) => s.loadSettings);
  // Runtime theme preset swap. applyThemePreset() rewrites the live
  // colors object in place, re-injects Text.defaultProps.style.fontFamily,
  // and bumps the theme-version store so ShellLayout's root re-mounts
  // with the fresh palette. PTY sessions are unaffected because only
  // JS styles re-compute.
  useEffect(() => {
    if (!fontsLoaded) return;
    import('@/lib/theme-presets').then(({ applyThemePreset }) => {
      applyThemePreset(uiFont as any);
      logInfo('RootLayout', 'Theme preset applied: ' + uiFont);
    });
  }, [uiFont, fontsLoaded]);

  useEffect(() => {
    logLifecycle('RootLayout', 'mounted');
    logInfo('RootLayout', 'Initializing stores...');

    useI18n.getState().loadLocale();
    logInfo('RootLayout', 'Loaded: i18n');
    useThemeStore.getState().loadTheme();
    logInfo('RootLayout', 'Loaded: theme');
    useA11yStore.getState().loadConfig();
    logInfo('RootLayout', 'Loaded: a11y');
    usePluginStore.getState().loadPlugins();
    logInfo('RootLayout', 'Loaded: plugins');

    // Resolve dynamic HOME path from native layer
    import('@/lib/home-path').then(({ initHomePath }) => {
      initHomePath().then(() => logInfo('RootLayout', 'Loaded: homePath'));
    });

    loadSettings().then(() => {
      logInfo('RootLayout', 'Loaded: settings');
    }).catch((e: any) => {
      logError('RootLayout', 'loadSettings failed', e);
    });

    // Load background agents from disk
    loadAgentsFromDisk(async (_cmd) => {
      try {
        // Bridge may not be ready at startup — return empty string
        // Agents will be re-loaded when a session connects
        return '';
      } catch {
        return '';
      }
    }).then(() => {
      logInfo('RootLayout', 'Loaded: agents');
    }).catch((e: any) => {
      logError('RootLayout', 'loadAgentsFromDisk failed', e);
      console.warn(e);
    });



    // Wire savepoint auto-save subscriber. The store's `pendingRequest` is
    // set from use-terminal-output (file-change-detected) and from other hooks,
    // but after the Plan B / Superset migration nothing consumed it — so the
    // 💾 badge never fired. Subscribe here at the root and run checkAndSave
    // via JNI execCommand in the active session's currentDir.
    import('@/store/savepoint-store').then(({ useSavepointStore }) => {
      import('@/hooks/use-native-exec').then(({ execCommand }) => {
        import('@/lib/auto-savepoint').then(({ checkAndSave, initGitIfNeeded }) => {
          import('@/store/terminal-store').then(({ useTerminalStore }) => {
            const runCmd = async (cmd: string) => {
              const r = await execCommand(cmd, 30_000);
              return { stdout: r.stdout, exitCode: r.exitCode };
            };
            let inFlight = false;
            useSavepointStore.subscribe((state, prev) => {
              if (!state.pendingRequest || state.pendingRequest === prev.pendingRequest) return;
              if (inFlight) return;
              if (!state.isEnabled) {
                useSavepointStore.getState().clearPendingRequest();
                return;
              }
              const ts = useTerminalStore.getState();
              const session = ts.sessions.find((s) => s.id === ts.activeSessionId);
              const dir = session?.currentDir;
              if (!dir) {
                useSavepointStore.getState().clearPendingRequest();
                return;
              }
              inFlight = true;
              useSavepointStore.getState().setSaving(true);
              (async () => {
                try {
                  await initGitIfNeeded(dir, runCmd);
                  const result = await checkAndSave(dir, runCmd, (issues) => {
                    useSavepointStore.getState().setSecurityWarnings(
                      issues.map((i) => `${i.file}: ${i.label}`),
                    );
                  });
                  if (result) {
                    useSavepointStore.getState().flashBadge();
                  }
                } catch (e) {
                  logError('SavepointBridge', 'checkAndSave failed', e);
                } finally {
                  useSavepointStore.getState().setSaving(false);
                  useSavepointStore.getState().clearPendingRequest();
                  inFlight = false;
                }
              })();
            });
            logInfo('RootLayout', 'Loaded: savepoint bridge');
          });
        });
      });
    });

    // Wire voice-chain bridge so VoiceChat can execute terminal commands.
    // The bridge was exported but never hooked up, leaving the voice dialogue
    // loop unable to reach the terminal.
    import('@/hooks/use-voice-chat').then(({ setVoiceChainBridge }) => {
      import('@/hooks/use-native-exec').then(({ execCommand }) => {
        setVoiceChainBridge(async (cmd) => {
          const r = await execCommand(cmd, 30_000);
          return { stdout: r.stdout, stderr: r.stderr };
        });
        logInfo('RootLayout', 'Loaded: voice-chain bridge');
      });
    });

    // bug #50: Start Foreground Service immediately at app launch so lmkd
    // treats us as a foreground-adjacent process even before the first pane
    // is created. Without this, switching to Termux for a few minutes would
    // let lmkd reap Shelly and destroy all PTY state. Idempotent with the
    // call already in TerminalPane.tsx:227.
    import('@/modules/terminal-emulator/src/TerminalEmulatorModule').then((mod) => {
      const TerminalEmulator: any = (mod as any).default ?? mod;
      try {
        TerminalEmulator.startSessionService?.().catch(() => {});
      } catch {}
      try {
        TerminalEmulator.requestBatteryOptimizationExemption?.().catch(() => {});
      } catch {}
      logInfo('RootLayout', 'Loaded: FGS startup');
    }).catch((e: any) => {
      logError('RootLayout', 'FGS startup failed', e);
    });


    // Initialize reduce-motion detection for sound/animation system
    useSoundStore.getState().initReduceMotion();

    // Deep-link handler — routes `shelly://` URLs into the right in-app
    // surface instead of kicking users out to an external browser.
    //
    // Supported schemes so far:
    //   shelly://browser?url=<encoded>  — navigate the Browser Pane to a URL.
    //                                     Adds a browser pane if none exists.
    //
    // Primary client today is `shelly-cs open <codespace>` which fires
    //   am start -a android.intent.action.VIEW \
    //     -d 'shelly://browser?url=https%3A%2F%2F<name>.github.dev'
    // to keep the codespace web UI inside Shelly instead of Chrome.
    const handleDeepLink = (url: string) => {
      try {
        const parsed = Linking.parse(url);
        logInfo('DeepLink', `received: ${url} → host=${parsed.hostname ?? '(null)'} params=${JSON.stringify(parsed.queryParams)}`);
        if (parsed.hostname === 'browser') {
          const raw = parsed.queryParams?.url;
          const target = Array.isArray(raw) ? raw[0] : raw;
          if (typeof target === 'string' && target.length > 0) {
            // Only addPane('browser') when no Browser Pane is mounted.
            // The store's addPane unconditionally creates a new slot; if
            // we called it on every deep link, repeated `shelly://browser`
            // dispatches would spawn extra Browser Panes side-by-side.
            // BrowserPane reads openSignal.url at initial mount so a
            // freshly-created pane still picks up the URL on first
            // render. (Was: "addPane is idempotent" — that was wrong;
            // verified by use-multi-pane.ts:471.)
            try {
              const slots = useMultiPaneStore.getState().slots;
              const hasBrowser = slots.some((s) => s?.tab === 'browser');
              if (!hasBrowser) {
                useMultiPaneStore.getState().addPane('browser');
              }
            } catch {}
            useBrowserStore.getState().openUrl(target);
            logInfo('DeepLink', `openUrl dispatched: ${target}`);
          }
        } else if (parsed.hostname === 'clipboard') {
          // shelly://clipboard?text=<encoded>
          // Used by shelly-cs auth to copy the OAuth device code to the
          // clipboard automatically. Avoids making the user squint at the
          // terminal and type the 8-char code by hand.
          const rawText = parsed.queryParams?.text;
          const text = Array.isArray(rawText) ? rawText[0] : rawText;
          if (typeof text === 'string' && text.length > 0) {
            Clipboard.setStringAsync(text).catch((e) => {
              logError('DeepLink', 'clipboard set failed', e);
            });
            logInfo('DeepLink', `clipboard set (${text.length} chars)`);
          }
        }
      } catch (e) {
        logError('DeepLink', 'parse failed', e);
      }
    };
    const linkSub = Linking.addEventListener('url', (event) => {
      handleDeepLink(event.url);
    });
    // Cold-start case: app launched directly from the deep link (no prior
    // process to receive the 'url' event).
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(url);
    }).catch(() => {});

    // bug #102 / #115 phase 1 (2026-05-08): file-queue poller for the
    // native xdg-open binary. `am start` from `untrusted_app` uid is
    // structurally rejected by ActivityManagerService on Galaxy Z Fold6
    // (and almost certainly any Knox-augmented Samsung device) — every
    // variant returned `Failure calling service activity: Failed
    // transaction (2147483646)` regardless of flags or scheme. So
    // shelly-xdg-open.c writes URLs to `$HOME/.shelly-deep-link-queue`
    // (one URL per line, append-mode atomic) and we poll-drain the
    // queue here. RN main thread runs in the activity context so calling
    // useBrowserStore.openUrl directly works fine; the binder restriction
    // only applies when starting an Intent via `am`, not when
    // dispatching to an already-running React component.
    //
    // 250 ms cadence balances responsiveness (OAuth flows feel
    // instantaneous) against battery / wakeups when idle. We could move
    // to a Kotlin-side FileObserver later if the poll cost becomes
    // measurable, but right now the file is checked-empty in <1 ms.
    //
    // FileSystem.documentDirectory points at `/data/data/<pkg>/files/`
    // with a `file://` prefix, and HomeInitializer.kt creates $HOME as
    // `${context.filesDir}/home`, so the queue path resolves correctly.
    const queuePath = `${FileSystem.documentDirectory}home/.shelly-deep-link-queue`;

    // Phase 1.2 (bug #102/#115): each queue line is either a plain URL
    // (legacy format used by shelly-xdg-open.c and shelly-codex-auth.js)
    // or a JSON object describing how the URL should be opened. The JSON
    // form was added to support Google OAuth (Gemini login), which needs
    // a real Chrome process via Custom Tabs because Chromium WebView
    // unconditionally appends an X-Requested-With header that
    // accounts.google.com uses to gate sign-in. JSON shape (all fields
    // optional except `url`):
    //
    //   {
    //     "type": "open-url",                  // reserved
    //     "url": "https://accounts.google.com/...",
    //     "provider": "google",                // diagnostic / future routing
    //     "authMode": "external-browser"       // "in-app" (default) | "external-browser"
    //   }
    //
    // authMode === "external-browser" → WebBrowser.openBrowserAsync(),
    // which on Android resolves to Chrome Custom Tabs (or whatever
    // Custom-Tabs-compatible browser the user has set as default). The
    // CLI's own loopback callback (http://127.0.0.1:<port>/...) receives
    // the redirect; Shelly does NOT touch the auth code or token
    // exchange — the CLI owns the OAuth flow entirely (RFC 8252 path,
    // per Codex 2026-05-08 design review for Phase 1.2).
    //
    // Default (no authMode, plain URL line, or "in-app") preserves the
    // existing Phase 1 behaviour: navigate Browser Pane in-app.
    const dispatchExternalBrowser = async (url: string, provider: string | null) => {
      // Trim provider to a short safe label for log lines.
      const providerTag = provider ? provider.slice(0, 32) : 'unknown';
      try {
        const result = await WebBrowser.openBrowserAsync(url, {
          // Slight tint so the Custom Tab header matches the Shelly
          // accent without competing with the OAuth provider's branding.
          toolbarColor: '#0D1117',
          showTitle: true,
          enableBarCollapsing: false,
        });
        logInfo('DeepLinkQueue', `external browser opened (provider=${providerTag}): result=${result.type}`);
        return;
      } catch (e) {
        // Codex review (PR #50, Phase 1.2 Stage 1): Custom Tabs binding
        // can fail for many reasons — no Custom-Tabs-capable default
        // browser, MDM-style policy, foreground race, etc. Before
        // collapsing to the in-app Browser Pane (which Google OAuth
        // would re-block via X-Requested-With), try a plain
        // Intent.ACTION_VIEW via Linking.openURL. That route still gets
        // a real Chrome process most of the time on consumer devices,
        // even when Custom Tabs failed to bind.
        logError('DeepLinkQueue', `Custom Tabs failed (provider=${providerTag}), trying Linking.openURL: ${e}`);
      }
      try {
        await Linking.openURL(url);
        logInfo('DeepLinkQueue', `Linking.openURL fallback opened (provider=${providerTag})`);
        return;
      } catch (e) {
        logError('DeepLinkQueue', `Linking.openURL also failed (provider=${providerTag}); collapsing to in-app: ${e}`);
      }
      // Last resort: open in-app. For Google OAuth the user will see
      // the WebView block message, but a visible failure is better than
      // a silent hang.
      try {
        const slots = useMultiPaneStore.getState().slots;
        const hasBrowser = slots.some((s) => s?.tab === 'browser');
        if (!hasBrowser) {
          useMultiPaneStore.getState().addPane('browser');
        }
      } catch {}
      useBrowserStore.getState().openUrl(url);
    };

    const dispatchInApp = (url: string) => {
      // Only call addPane('browser') if no Browser Pane is already
      // mounted. addPane unconditionally allocates a new slot, so
      // calling it when a Browser Pane already exists creates a
      // SECOND one — and even worse, the new pane misses the
      // openSignal because its lastOpenSeqRef captures the current
      // (post-openUrl) seq on mount and the useEffect skips the
      // navigation. The combined effect is the "Browser Pane
      // appears but the URL doesn't load" bug observed on Z Fold6.
      // BrowserPane's currentUrl initial state also reads
      // openSignal.url so a fresh pane picks up the URL on first
      // render; this guard just keeps us from spamming new panes
      // on every queued URL.
      try {
        const slots = useMultiPaneStore.getState().slots;
        const hasBrowser = slots.some((s) => s?.tab === 'browser');
        if (!hasBrowser) {
          useMultiPaneStore.getState().addPane('browser');
        }
      } catch {}
      useBrowserStore.getState().openUrl(url);
    };

    // Codex review (PR #50, Phase 1.2 Stage 1): the original
    // read-then-delete flow lost any line a concurrent emitter
    // (shelly-xdg-open.c, shelly-codex-auth.js, future Gemini wrapper)
    // appended between the read and the delete. Append-mode atomic
    // writes survive a missing-file gap, so move-to-spool first then
    // consume the spool — anything written after the move lands in a
    // freshly-created queue and survives to the next poll.
    let isDraining = false;
    const drainQueue = async () => {
      // Codex review: re-entry guard. drainQueue is async; if a
      // dispatchExternalBrowser await takes longer than the 250 ms
      // setInterval period (very plausible for Custom Tabs binding),
      // setInterval will fire a second drainQueue while the first is
      // still mid-loop. Two concurrent drains race on the same spool
      // path. The flag below collapses overlapping wakeups; nothing is
      // lost because the next setInterval tick will pick up a fresh
      // queue if there is one.
      if (isDraining) return;
      isDraining = true;
      try {
        const info = await FileSystem.getInfoAsync(queuePath);
        if (!info.exists) return;
        // Per-process unique spool name avoids collisions if two
        // RootLayout instances ever co-exist (HMR / fast refresh during
        // development). Date.now() + crypto-ish suffix keeps it readable
        // in adb logcat without needing a real RNG.
        const spoolPath = `${queuePath}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}.spool`;
        try {
          await FileSystem.moveAsync({ from: queuePath, to: spoolPath });
        } catch (e) {
          // The queue file may have been consumed by a sibling drain
          // between getInfoAsync and moveAsync. Not an error.
          return;
        }
        const content = await FileSystem.readAsStringAsync(spoolPath);
        await FileSystem.deleteAsync(spoolPath, { idempotent: true });
        const lines = content.split('\n').map((s) => s.trim()).filter(Boolean);
        for (const line of lines) {
          let url: string;
          let provider: string | null = null;
          let authMode: 'in-app' | 'external-browser' = 'in-app';
          if (line.startsWith('{')) {
            // JSON-line entry. Tolerate malformed JSON by logging and
            // skipping rather than crashing the poll loop.
            let parsed: any;
            try {
              parsed = JSON.parse(line);
            } catch (e) {
              logError('DeepLinkQueue', `rejected malformed JSON line: ${line.slice(0, 96)}`);
              continue;
            }
            if (typeof parsed?.url !== 'string') {
              logError('DeepLinkQueue', `rejected JSON line without url field: ${line.slice(0, 96)}`);
              continue;
            }
            url = parsed.url;
            if (typeof parsed.provider === 'string') provider = parsed.provider;
            if (parsed.authMode === 'external-browser') {
              authMode = 'external-browser';
            }
          } else {
            // Legacy plain-URL format (still emitted by shelly-xdg-open.c
            // and shelly-codex-auth.js — keep working unchanged).
            url = line;
          }
          if (!/^https?:\/\//i.test(url)) {
            logError('DeepLinkQueue', `rejected non-http(s) url: ${url.slice(0, 64)}`);
            continue;
          }
          // Phase 1.2 Stage 2 (Google OAuth safety routing): upgrade any
          // queue line currently routed in-app whose host is
          // accounts.google.com to external-browser dispatch. Google's
          // OAuth flow blocks WebView via the X-Requested-With header
          // that Chromium injects unconditionally, and UA spoofing alone
          // can't bypass it (established 2026-05-08). Custom Tabs runs
          // the same Chromium core but as the system browser process, no
          // `wv` token, no X-Requested-With, so Google accepts the sign-in.
          //
          // SAFETY WINS over explicit declaration: an emitter that sent
          // {"authMode":"in-app"} for a Google OAuth URL is also upgraded.
          // OAuth URLs in WebView fail predictably; routing them through
          // Custom Tabs is the safer default. Emitters that have a real
          // reason to need in-app rendering for accounts.google.com would
          // be misrouting OAuth into a known-broken path. Explicit
          // {"authMode":"external-browser"} is left untouched (already
          // resolved upstream of this branch).
          //
          // We narrow the auto-upgrade to accounts.google.com exactly
          // (NOT *.google.com) because:
          //   - User-pasted YouTube / Drive / Maps URLs should still open
          //     in-app (Phase 1 behaviour, no auth gating).
          //   - Only the OAuth host is the one that fingerprints WebView.
          //
          // Scope note: this layer makes Google OAuth URLs SAFE once they
          // reach the queue. It does NOT implement Gemini auth on its
          // own. Gemini CLI must invoke xdg-open (which routes through
          // shelly-xdg-open.c → file queue) for this upgrade to fire. If
          // Gemini CLI only prints the OAuth URL to stdout without
          // invoking xdg-open, a follow-up wrapper that pushes the URL
          // into the queue is still needed (deferred until on-device
          // observation confirms which behaviour Gemini CLI exhibits).
          if (authMode === 'in-app') {
            try {
              const parsedUrl = new URL(url);
              if (parsedUrl.host.toLowerCase() === 'accounts.google.com') {
                authMode = 'external-browser';
                provider = provider ?? 'google';
                logInfo('DeepLinkQueue', `auto-upgraded Google OAuth URL to external-browser: ${url}`);
              }
            } catch {
              // URL constructor threw on a string that passed http(s)
              // regex earlier — extremely unlikely. Fall through to
              // existing in-app dispatch; safer than hard-fail on a path
              // that's only best-effort anyway.
            }
          }
          if (authMode === 'external-browser') {
            await dispatchExternalBrowser(url, provider);
            logInfo('DeepLinkQueue', `external dispatched (provider=${provider ?? 'unknown'}): ${url}`);
          } else {
            dispatchInApp(url);
            logInfo('DeepLinkQueue', `openUrl dispatched (queue): ${url}`);
          }
        }
      } catch (e) {
        logError('DeepLinkQueue', 'poll iteration failed', e);
      } finally {
        isDraining = false;
      }
    };
    const queueInterval = setInterval(drainQueue, 250);

    // Unload sounds when app goes to background
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        unloadSounds();
      }
    });
    return () => {
      sub.remove();
      linkSub.remove();
      clearInterval(queueInterval);
    };
  }, []);

  // bug #62 (regression restore): Wave E added `<Stack key={locale}>` as the
  // emergency fix for "i18n language switch doesn't update UI strings" —
  // module-scope `t()` calls are evaluated at import time, so swapping EN/JA
  // at runtime leaves components rendering the old language until a full
  // refresh. Keying the Stack on the current locale forces a remount on
  // language change, which is ugly but reliable until the full
  // useTranslation() migration lands. The key got dropped in an unrelated
  // refactor; reinstate it so switching EN/JA in Settings actually takes
  // effect without relaunching the app.
  const locale = useI18n((s) => s.locale);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <Stack key={locale} screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
        </Stack>
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
