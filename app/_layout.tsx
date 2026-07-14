import "@/global.css";
import React, { useCallback, useEffect, useState } from "react";
import { logInfo, logError, logLifecycle } from '@/lib/debug-logger';
import { Stack, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Alert, AppState, View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { JetBrainsMono_400Regular, JetBrainsMono_700Bold } from "@expo-google-fonts/jetbrains-mono";
import { useTerminalStore } from "@/store/terminal-store";
import { useSoundStore, unloadSounds } from "@/lib/sounds";
import { loadAgentsFromDisk, syncAgentRunLogsFromDisk } from "@/lib/agent-manager";
import { t, useI18n } from '@/lib/i18n';
import { useThemeStore } from '@/lib/theme-engine';
import { useA11yStore } from '@/lib/accessibility';
import { usePluginStore } from '@/lib/plugin-api';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { useSettingsStore } from '@/store/settings-store';
import { useDmPairingStore } from '@/store/dm-pairing-store';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as WebBrowser from 'expo-web-browser';
import { useBrowserStore } from '@/store/browser-store';
import { PRESET_CAPACITY, useMultiPaneStore, type PresetId } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';
import { useAgentChatStore, type AgentChatSession } from '@/store/agent-chat-store';
import { resumeCodexSession, coldStartCodexAndDeliverWidgetPrompt } from '@/lib/codex-session-resume';
import {
  getCodexApprovalReadiness,
  getCodexReplyReadiness,
  sendCodexApproval,
  sendCodexReply,
  type CodexApprovalDecision,
} from '@/lib/codex-session-reply';
import { detectCodexApprovalPrompt, detectCodexInteractivePrompt } from '@/lib/codex-pty-detection';
import { execCommand } from '@/hooks/use-native-exec';
import { useTelegramInbound } from '@/hooks/use-telegram-inbound';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { fireReviewedAgentIntent } from '@/lib/agent-intent-review';

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

const BACKGROUND_AGENT_LOG_START_DELAY_MS = 45_000;
const BACKGROUND_AGENT_REPAIR_DELAY_MS = 90_000;
const AGENT_LOG_SYNC_INTERVAL_MS = 60_000;

type WidgetPromptTarget = {
  queuedAt?: number;
  codexSessionId?: string | null;
  ptySessionId?: string | null;
  shellySessionId?: string | null;
};

type AgentEscalationRequest = {
  runId: string;
  agentId: string;
  reqId: string;
  command: string;
  commandSha256?: string | null;
  workspaceRoot?: string | null;
  cwd?: string | null;
  reason?: string | null;
  signals: string[];
  level?: string | null;
  ts?: string | null;
  state?: string | null;
  queuedAt?: string | null;
};

type AgentGrantSpendRequest = {
  type: 'grant_spend_request';
  grantId: string;
  reqId: string;
  requestSha256: string;
  ts?: string | null;
};

type AgentActionApprovalRequest = {
  runId: string;
  agentId: string;
  agentName?: string | null;
  toolLabel?: string | null;
  actionType: 'draft' | 'notify' | 'webhook' | 'cli' | 'intent' | 'dm-reply';
  preview?: string | null;
  destinationHost?: string | null;
  command?: string | null;
  safetyLevel?: string | null;
  safetyReason?: string | null;
  payloadPath?: string | null;
  resultPath?: string | null;
  ts?: string | null;
  expiresAt?: number | null;
  requestSha256?: string | null;
  intentMode?: 'launch' | 'share' | null;
  intentTarget?: string | null;
  intentShareText?: string | null;
  dmPairingId?: string | null;
  dmPairingLabel?: string | null;
  dmReplyText?: string | null;
  actionNonce?: string | null;
};

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'JetBrainsMono_400Regular': JetBrainsMono_400Regular,
    'JetBrainsMono_700Bold': JetBrainsMono_700Bold,
  });
  // Phase 3 inbound gateway: long-poll Telegram for the authorized chat (no-op
  // unless enabled + token + chat id are configured). Enqueues confirm cards only.
  useTelegramInbound();
  const [pendingAgentActionApproval, setPendingAgentActionApproval] =
    useState<AgentActionApprovalRequest | null>(null);
  const [agentActionResolving, setAgentActionResolving] = useState(false);
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'blue');
  const loadSettings = useTerminalStore((s) => s.loadSettings);
  const resolvePendingAgentActionApproval = useCallback(async (decision: 'accept' | 'decline') => {
    const request = pendingAgentActionApproval;
    if (!request) return;
    if (!TerminalEmulator.resolveAgentActionApproval) {
      Alert.alert(t('agent_action_confirm_not_ready'));
      return;
    }
    // Fail closed: the native writeHumanReply now requires both the content
    // hash and the single-use action nonce minted when this request was read
    // for review (readAgentActionApprovalRequest). Bail out here with a clear
    // message rather than letting a missing value reach the native call and
    // surface as a generic error.
    const requestSha256 = request.requestSha256;
    const actionNonce = request.actionNonce;
    if (!requestSha256 || !actionNonce) {
      Alert.alert(t('agent_action_confirm_not_ready'));
      return;
    }
    setAgentActionResolving(true);
    if (decision === 'accept' && request.actionType === 'intent') {
      if (!TerminalEmulator.fireAgentIntent) {
        Alert.alert(t('agent_action_confirm_not_ready'));
        setAgentActionResolving(false);
        return;
      }
      try {
        await fireReviewedAgentIntent(request, TerminalEmulator.fireAgentIntent);
      } catch (e) {
        // Platform intent-dispatch exceptions (e.g. ActivityNotFoundException)
        // embed the raw Intent.toString() -- including the deep-link URI or
        // share text -- inside error.message. redactSecrets() only recognizes
        // known secret patterns, not arbitrary URIs, so logging `e` directly
        // here would leak intent content into logcat. Log only the error
        // class/type, matching this feature's redacted-native-logging intent.
        const errorKind = (e as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? 'UnknownError';
        logError('AgentActionApproval', `fireAgentIntent failed: ${errorKind}`);
        // Fail closed: tell the waiting executor "declined" (a fast, honest
        // signal) rather than leaving it to time out after a failed fire.
        await TerminalEmulator.resolveAgentActionApproval?.(request.runId, 'decline', requestSha256, actionNonce).catch(() => undefined);
        setPendingAgentActionApproval(null);
        setAgentActionResolving(false);
        Alert.alert(t('agent_action_confirm_intent_failed'));
        return;
      }
    }
    if (decision === 'accept' && request.actionType === 'dm-reply') {
      let sent = false;
      try {
        sent = await TerminalEmulator.sendPairedDmReply(
          request.dmPairingId ?? '',
          request.dmReplyText ?? '',
        );
      } catch (error) {
        logError('AgentActionApproval', 'sendPairedDmReply failed', error);
      }
      if (!sent) {
        await TerminalEmulator.resolveAgentActionApproval(
          request.runId,
          'decline',
          requestSha256,
          actionNonce,
        ).catch(() => undefined);
        setPendingAgentActionApproval(null);
        setAgentActionResolving(false);
        Alert.alert(t('agent_action_confirm_dmreply_failed'));
        return;
      }
    }
    try {
      await TerminalEmulator.resolveAgentActionApproval(
        request.runId,
        decision,
        requestSha256,
        actionNonce,
      );
      setPendingAgentActionApproval(null);
    } catch (e) {
      logError('AgentActionApproval', `resolve ${decision} failed`, e);
      Alert.alert(t('agent_action_confirm_not_ready'));
    } finally {
      setAgentActionResolving(false);
    }
  }, [pendingAgentActionApproval]);
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
    useCosmeticStore.getState().loadCosmetics();
    logInfo('RootLayout', 'Loaded: cosmetics');
    useDmPairingStore.getState().loadPairings();
    logInfo('RootLayout', 'Loaded: dm-pairings');

    // Resolve dynamic HOME path from native layer
    import('@/lib/home-path').then(({ initHomePath }) => {
      initHomePath().then(() => logInfo('RootLayout', 'Loaded: homePath'));
    });

    loadSettings().then(() => {
      logInfo('RootLayout', 'Loaded: settings');
    }).catch((e: any) => {
      logError('RootLayout', 'loadSettings failed', e);
    });

    let disposed = false;
    const runNativeShell = async (cmd: string, timeoutMs = 30_000) => {
      const result = await execCommand(cmd, timeoutMs);
      if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
      return result.stdout;
    };

    // Restore agent metadata immediately so manual @agent commands work after
    // launch. Heavy log sync and script/alarm repair are still deferred below.
    void (async () => {
      try {
        const { initHomePath } = await import('@/lib/home-path');
        await initHomePath();
        if (disposed) return;
        await loadAgentsFromDisk(runNativeShell, {
          syncLogs: false,
          repairSchedules: true,
          repairDelayMs: BACKGROUND_AGENT_REPAIR_DELAY_MS,
          shouldRepair: () => !disposed && AppState.currentState === 'active',
        });
        logInfo('RootLayout', 'Loaded: agents');
      } catch (e: any) {
        logError('RootLayout', 'loadAgentsFromDisk failed', e);
      }
    })();

    // Background agents can complete while the JS bridge is asleep. Refresh
    // their on-disk logs when Shelly returns to foreground, and periodically
    // while it is open, so the sidebar/history reflects scheduled runs.
    let agentLogSyncInFlight = false;
    let agentLogSyncReady = false;
    let agentLogInterval: ReturnType<typeof setInterval> | null = null;
    const syncAgentLogs = async () => {
      if (disposed || agentLogSyncInFlight) return;
      agentLogSyncInFlight = true;
      try {
        await import('@/lib/home-path').then(({ initHomePath }) => initHomePath());
        if (disposed) return;
        await syncAgentRunLogsFromDisk(runNativeShell);
      } catch (e: any) {
        logError('RootLayout', 'syncAgentRunLogsFromDisk failed', e);
      } finally {
        agentLogSyncInFlight = false;
      }
    };
    const agentLogStartTimer = setTimeout(() => {
      if (disposed) return;
      agentLogSyncReady = true;
      void syncAgentLogs();
      agentLogInterval = setInterval(syncAgentLogs, AGENT_LOG_SYNC_INTERVAL_MS);
    }, BACKGROUND_AGENT_LOG_START_DELAY_MS);
    const agentLogSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && agentLogSyncReady) void syncAgentLogs();
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

    // Initialize reduce-motion detection for sound/animation system
    useSoundStore.getState().initReduceMotion();

    // Deep-link handler — routes `shelly://` URLs into the right in-app
    // surface instead of kicking users out to an external browser.
    //
    // Supported schemes so far:
    //   shelly://browser?url=<encoded>  — navigate the Browser Pane to a URL.
    //                                     Adds a browser pane if none exists.
    //   shelly://scouter                 — open Scouter detail.
    //   shelly:///agent-chat?compose=1   — open Agent Chat and focus input.
    //   shelly://agent-chat?compose=1    — legacy form, still accepted.
    //
    // Primary client today is `shelly-cs open <codespace>` which fires
    //   am start -a android.intent.action.VIEW \
    //     -d 'shelly://browser?url=https%3A%2F%2F<name>.github.dev'
    // to keep the codespace web UI inside Shelly instead of Chrome.
    let agentChatResumeInFlight = false;

    const normalizeDeepLinkTarget = (parsed: { hostname?: string | null; path?: string | null }) => {
      const pathTarget = typeof parsed.path === 'string'
        ? parsed.path.replace(/^\/+/, '').split('/')[0]
        : '';
      const hostTarget = typeof parsed.hostname === 'string' ? parsed.hostname : '';
      return pathTarget || hostTarget;
    };

    const visiblePresetForSlot = (currentPreset: PresetId, slotIndex: number): PresetId => {
      const currentCapacity = PRESET_CAPACITY[currentPreset] ?? 1;
      if (slotIndex < currentCapacity) return currentPreset;
      if (slotIndex <= 1) return 'p2h';
      if (slotIndex === 2) return 'p3l';
      return 'p4';
    };

    const focusPaneByTab = (tab: 'agent-chat') => {
      const multiPane = useMultiPaneStore.getState();
      const existingIndex = multiPane.slots.findIndex((slot) => slot?.tab === tab);
      if (existingIndex >= 0) {
        const slot = multiPane.slots[existingIndex];
        multiPane.maximizeSlot(null);
        const visiblePreset = visiblePresetForSlot(multiPane.preset, existingIndex);
        if (visiblePreset !== multiPane.preset) {
          multiPane.setPreset(visiblePreset);
        }
        multiPane.focusSlot(existingIndex as 0 | 1 | 2 | 3);
        if (slot) usePaneStore.getState().setFocusedPane(slot.id);
        return true;
      }

      const result = multiPane.addPane(tab);
      if (result) {
        logInfo('DeepLink', `could not add ${tab} pane: ${result}`);
        return false;
      }
      return true;
    };

    const waitForMultiPaneHydration = () => new Promise<void>((resolve) => {
      if (useMultiPaneStore.getState()._hasHydrated) {
        resolve();
        return;
      }
      let unsubscribe: (() => void) | null = null;
      const done = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        resolve();
      };
      unsubscribe = useMultiPaneStore.subscribe((state) => {
        if (state._hasHydrated) done();
      });
    });

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

    const matchesWidgetPromptTarget = (
      session: AgentChatSession,
      target: WidgetPromptTarget | null | undefined,
    ) => {
      if (!target) return false;
      return Boolean(
        (target.codexSessionId && sameCodexSessionId(session.codexSessionId, target.codexSessionId)) ||
          (target.ptySessionId && session.ptySessionId === target.ptySessionId) ||
          (target.shellySessionId && session.shellySessionId === target.shellySessionId),
      );
    };

    const normalizeCodexSessionId = (sessionId: string | null | undefined): string | null => {
      const trimmed = sessionId?.trim();
      if (!trimmed) return null;
      return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(trimmed)?.[1] ?? trimmed;
    };

    const sameCodexSessionId = (
      left: string | null | undefined,
      right: string | null | undefined,
    ): boolean => {
      const leftValue = normalizeCodexSessionId(left);
      const rightValue = normalizeCodexSessionId(right);
      return Boolean(leftValue && rightValue && leftValue === rightValue);
    };

    const ptyAuthoritativeWidgetSession = (session: AgentChatSession): AgentChatSession => ({
      ...session,
      currentStatus: 'idle',
    });

    const approvalAuthoritativeWidgetSession = (session: AgentChatSession): AgentChatSession => ({
      ...session,
      currentStatus: 'WAITING_PERMISSION',
    });

    const resumeLatestAgentChatSession = async (
      preferredTarget?: WidgetPromptTarget | null,
    ): Promise<{ session: AgentChatSession; resumedSession: AgentChatSession } | null> => {
      await useAgentChatStore.getState().refresh().catch((e) => {
        logError('DeepLink', 'Agent Chat refresh before resume failed', e);
      });
      const { sessions, latestSessionId, bindCodexSessionToPty } = useAgentChatStore.getState();
      const session = sessions.find((candidate) => matchesWidgetPromptTarget(candidate, preferredTarget))
        ?? sessions.find((candidate) => candidate.codexSessionId === latestSessionId)
        ?? sessions[0]
        ?? null;
      if (!session) {
        logInfo('DeepLink', 'Agent Chat resume skipped: no Codex session');
        return null;
      }

      const result = await resumeCodexSession(session, {
        addTerminalPane: (tab) => useMultiPaneStore.getState().addPane(tab),
      }).catch((e) => {
        logError('DeepLink', 'Agent Chat resume failed', e);
        return null;
      });
      if (!result) return null;
      if (result.status === 'failed') {
        logInfo('DeepLink', `Agent Chat resume failed: ${result.reason}`);
        return null;
      }

      let resumedSession = session;
      const terminalSession = useTerminalStore.getState().sessions.find((candidate) => candidate.id === result.sessionId);
      if (terminalSession?.nativeSessionId) {
        const now = Date.now();
        const cwd = session.cwd ?? terminalSession.currentDir;
        bindCodexSessionToPty(session.codexSessionId, {
          ptySessionId: terminalSession.nativeSessionId,
          shellySessionId: terminalSession.id,
          cwd,
          startedAt: now,
          lastSeenAt: now,
        });
        resumedSession = {
          ...session,
          ptySessionId: terminalSession.nativeSessionId,
          shellySessionId: terminalSession.id,
          cwd,
          bindingConfidence: 'reliable',
        };
      }
      logInfo('DeepLink', `Agent Chat resume ${result.status}: ${result.sessionId}`);
      return { session, resumedSession };
    };

    const latestWidgetSession = (session: AgentChatSession): AgentChatSession => {
      const latest = useAgentChatStore.getState().sessions
        .find((candidate) => sameCodexSessionId(candidate.codexSessionId, session.codexSessionId));
      if (!latest) return session;
      return {
        ...latest,
        ptySessionId: session.ptySessionId ?? latest.ptySessionId,
        shellySessionId: session.shellySessionId ?? latest.shellySessionId,
        bindingConfidence: session.bindingConfidence === 'reliable'
          ? 'reliable'
          : latest.bindingConfidence,
      };
    };

    const waitForWidgetCodexReady = async (session: AgentChatSession, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      let current = latestWidgetSession(session);
      let last = await getCodexReplyReadiness(ptyAuthoritativeWidgetSession(current)).catch(() => null);
      while (!last?.ready && Date.now() < deadline) {
        if (last?.reason === 'interactive_prompt') break;
        await sleep(650);
        await useAgentChatStore.getState().refresh().catch(() => undefined);
        current = latestWidgetSession(current);
        last = await getCodexReplyReadiness(ptyAuthoritativeWidgetSession(current)).catch(() => null);
      }
      return { readiness: last, session: current };
    };

    const waitForWidgetCodexApprovalReady = async (session: AgentChatSession, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      let noApprovalPromptSince: number | null = null;
      let current = latestWidgetSession(session);
      let last = await getCodexApprovalReadiness(approvalAuthoritativeWidgetSession(current)).catch(() => null);
      while (!last?.ready && Date.now() < deadline) {
        if (last?.reason === 'no_approval_prompt') {
          noApprovalPromptSince ??= Date.now();
          if (Date.now() - noApprovalPromptSince >= 3_000) break;
        } else {
          noApprovalPromptSince = null;
        }
        await sleep(650);
        await useAgentChatStore.getState().refresh().catch(() => undefined);
        current = latestWidgetSession(current);
        last = await getCodexApprovalReadiness(approvalAuthoritativeWidgetSession(current)).catch(() => null);
      }
      return { readiness: last, session: current };
    };

    const drainWidgetPromptForSession = async (session: AgentChatSession) => {
      if (!TerminalEmulator.consumeScouterWidgetPendingPrompt) {
        await TerminalEmulator.markScouterWidgetPromptFailed?.('Widget prompt bridge unavailable').catch(() => undefined);
        return;
      }
      const { readiness, session: readySession } = await waitForWidgetCodexReady(session);
      const ready = readiness;
      if (!ready?.ready) {
        if (ready?.reason === 'interactive_prompt') {
          await TerminalEmulator.markScouterWidgetChoicePending?.('Codex is waiting for a terminal choice').catch(() => undefined);
        } else {
          // Retention: do NOT mark failed here — recordWidgetPromptFailed clears
          // the pending prompt, losing it permanently. A resumed Codex that is
          // just slow to become ready (cold post-update boot, rate-limit
          // handshake) should keep the prompt pending so a subsequent widget
          // tap / deep link can redeliver within the native 2-minute window.
          logInfo('DeepLink', `Widget prompt kept pending (not ready: ${ready?.reason ?? 'not_ready'})`);
          return;
        }
        logInfo('DeepLink', `Widget prompt drain skipped: ${ready?.reason ?? 'not_ready'}`);
        return;
      }
      const screenText = await TerminalEmulator.getScreenText(ready.nativeSessionId).catch(() => null);
      if (typeof screenText === 'string' && detectCodexApprovalPrompt(screenText)) {
        await TerminalEmulator.markScouterWidgetPromptFailed?.('Codex approval is pending').catch(() => undefined);
        logInfo('DeepLink', 'Widget prompt drain skipped: approval pending');
        return;
      }
      if (typeof screenText === 'string' && detectCodexInteractivePrompt(screenText)) {
        await TerminalEmulator.markScouterWidgetChoicePending?.('Codex is waiting for a terminal choice').catch(() => undefined);
        logInfo('DeepLink', 'Widget prompt drain skipped: interactive choice pending');
        return;
      }
      const pending = await TerminalEmulator.consumeScouterWidgetPendingPrompt(
        readySession.codexSessionId,
        readySession.ptySessionId ?? null,
        readySession.shellySessionId ?? null,
      ).catch((e) => {
        logError('DeepLink', 'Widget prompt consume failed', e);
        return null;
      });
      if (!pending?.prompt?.trim()) {
        await TerminalEmulator.markScouterWidgetPromptFailed?.('Widget prompt no longer matches the resumed Codex session').catch(() => undefined);
        logInfo('DeepLink', 'Widget prompt drain skipped: no matching pending prompt');
        return;
      }

      const result = await sendCodexReply(ptyAuthoritativeWidgetSession(readySession), pending.prompt).catch(() => ({
        status: 'failed' as const,
        reason: 'screen_unavailable' as const,
      }));
      if (result.status === 'sent') {
        await TerminalEmulator.markScouterWidgetPromptQueued?.(pending.prompt).catch(() => undefined);
        await useAgentChatStore.getState().refresh().catch(() => undefined);
        logInfo('DeepLink', 'Widget prompt sent after Codex resume');
        return;
      }
      const reason = result.reason;
      await TerminalEmulator.markScouterWidgetPromptFailed?.(`Codex prompt send blocked: ${reason}`).catch(() => undefined);
      logInfo('DeepLink', `Widget prompt send blocked: ${reason}`);
    };

    const normalizeApprovalDecision = (value: string | null | undefined): CodexApprovalDecision | null => {
      if (value === 'allow' || value === 'deny') return value;
      return null;
    };

    const markWidgetApprovalFailed = async (message: string) => {
      if (TerminalEmulator.markScouterWidgetApprovalFailed) {
        await TerminalEmulator.markScouterWidgetApprovalFailed(message).catch(() => undefined);
      } else {
        await TerminalEmulator.markScouterWidgetPromptFailed?.(message).catch(() => undefined);
      }
    };

    const markWidgetApprovalResolved = async () => {
      await TerminalEmulator.markScouterWidgetApprovalResolved?.().catch(() => undefined);
    };

    const drainWidgetApprovalForSession = async (
      session: AgentChatSession,
      requestedDecision: CodexApprovalDecision | null,
    ) => {
      if (!TerminalEmulator.consumeScouterWidgetPendingApproval) {
        await markWidgetApprovalFailed('Widget approval bridge unavailable');
        return;
      }
      const { readiness, session: readySession } = await waitForWidgetCodexApprovalReady(session);
      const ready = readiness;
      if (!ready?.ready) {
        if (ready?.reason === 'no_approval_prompt') {
          const pending = await TerminalEmulator.consumeScouterWidgetPendingApproval(
            readySession.codexSessionId,
            readySession.ptySessionId ?? null,
            readySession.shellySessionId ?? null,
          ).catch((e) => {
            logError('DeepLink', 'Widget approval auto-resolve consume failed', e);
            return null;
          });
          const pendingDecision = normalizeApprovalDecision(pending?.decision);
          if (pending && (!requestedDecision || pendingDecision === requestedDecision)) {
            await markWidgetApprovalResolved();
            await useAgentChatStore.getState().refresh().catch(() => undefined);
            logInfo('DeepLink', 'Widget approval resolved without prompt after Codex resume');
            return;
          }
        }
        await markWidgetApprovalFailed(
          `Codex approval resume did not become ready: ${ready?.reason ?? 'not_ready'}`,
        );
        logInfo('DeepLink', `Widget approval drain skipped: ${ready?.reason ?? 'not_ready'}`);
        return;
      }
      const pending = await TerminalEmulator.consumeScouterWidgetPendingApproval(
        readySession.codexSessionId,
        readySession.ptySessionId ?? null,
        readySession.shellySessionId ?? null,
      ).catch((e) => {
        logError('DeepLink', 'Widget approval consume failed', e);
        return null;
      });
      if (!pending) {
        await markWidgetApprovalFailed('Widget approval no longer matches the resumed Codex session');
        logInfo('DeepLink', 'Widget approval drain skipped: no matching pending approval');
        return;
      }
      const decision = normalizeApprovalDecision(pending.decision);
      if (!decision) {
        await markWidgetApprovalFailed('Widget approval decision is missing');
        logInfo('DeepLink', 'Widget approval drain skipped: missing decision');
        return;
      }
      if (requestedDecision && requestedDecision !== decision) {
        await markWidgetApprovalFailed('Widget approval decision changed before Codex resumed');
        logInfo('DeepLink', 'Widget approval drain skipped: decision mismatch');
        return;
      }

      const result = await sendCodexApproval(approvalAuthoritativeWidgetSession(readySession), decision).catch(() => ({
        status: 'failed' as const,
        reason: 'screen_unavailable' as const,
      }));
      if (result.status === 'sent') {
        await TerminalEmulator.markScouterWidgetApprovalDecision?.(decision).catch(() => undefined);
        await useAgentChatStore.getState().refresh().catch(() => undefined);
        logInfo('DeepLink', `Widget approval ${decision} sent after Codex resume`);
        return;
      }
      const reason = result.reason;
      await markWidgetApprovalFailed(`Codex approval send blocked: ${reason}`);
      logInfo('DeepLink', `Widget approval send blocked: ${reason}`);
    };

    const queryValue = (value: string | string[] | undefined): string | undefined =>
      Array.isArray(value) ? value[0] : value;

    const returnHomeFromWidgetFlow = () => {
      void TerminalEmulator.returnToHome?.().catch(() => undefined);
    };

    const fallbackActionApprovalRequestDirUri = `${FileSystem.documentDirectory}home/.shelly/agents/action-approvals`;
    const notifiedActionApprovals = new Map<string, { runId: string; seenAt: number }>();
    let actionApprovalRequestDirUri: string | null = null;
    let isDrainingActionApprovals = false;
    const trimActionFileUri = (uri: string) => uri.replace(/\/+$/, '');
    const joinActionFileUri = (dirUri: string, name: string) => `${trimActionFileUri(dirUri)}/${name}`;
    const safeActionFilePart = (value: string) =>
      value.replace(/[^A-Za-z0-9_.=-]/g, '_').slice(0, 160) || 'request';

    const parseActionApprovalRequest = (raw: unknown): AgentActionApprovalRequest | null => {
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      if (!value) return null;
      const str = (field: string) => typeof value[field] === 'string' ? (value[field] as string).trim() : '';
      const runId = str('runId');
      const agentId = str('agentId');
      const actionType = str('actionType');
      if (!runId || !agentId) return null;
      if (
        actionType !== 'draft' &&
        actionType !== 'notify' &&
        actionType !== 'webhook' &&
        actionType !== 'cli' &&
        actionType !== 'intent' &&
        actionType !== 'dm-reply'
      ) {
        return null;
      }
      const expiresAtRaw = value.expiresAt;
      const expiresAt = typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw)
        ? expiresAtRaw
        : null;
      const intentModeRaw = str('intentMode');
      const intentMode = intentModeRaw === 'launch' || intentModeRaw === 'share' ? intentModeRaw : null;
      return {
        runId,
        agentId,
        agentName: str('agentName') || null,
        toolLabel: str('toolLabel') || null,
        actionType,
        preview: str('preview') || null,
        destinationHost: str('destinationHost') || null,
        command: str('command') || null,
        safetyLevel: str('safetyLevel') || null,
        safetyReason: str('safetyReason') || null,
        payloadPath: str('payloadPath') || null,
        resultPath: str('resultPath') || null,
        ts: str('ts') || null,
        expiresAt,
        requestSha256: str('requestSha256') || null,
        intentMode,
        intentTarget: str('intentTarget') || null,
        intentShareText: str('intentShareText') || null,
        dmPairingId: str('dmPairingId') || null,
        dmPairingLabel: str('dmPairingLabel') || null,
        dmReplyText: typeof value.dmReplyText === 'string' ? value.dmReplyText : null,
        // Only ever populated by the native readAgentActionApprovalRequest
        // round trip (freshly minted per read). The raw-JSON fallback path
        // and the notify-only poll loop below never set it, and must not --
        // resolvePendingAgentActionApproval treats a missing nonce as "not
        // ready" rather than silently skipping the replay check.
        actionNonce: str('actionNonce') || null,
      };
    };

    const actionApprovalKey = (request: AgentActionApprovalRequest) => JSON.stringify({
      runId: request.runId,
      agentId: request.agentId,
      actionType: request.actionType,
      preview: request.preview,
      destinationHost: request.destinationHost,
      command: request.command,
      safetyLevel: request.safetyLevel,
      safetyReason: request.safetyReason,
      payloadPath: request.payloadPath,
      resultPath: request.resultPath,
      ts: request.ts,
      expiresAt: request.expiresAt,
      requestSha256: request.requestSha256,
      intentMode: request.intentMode,
      intentTarget: request.intentTarget,
      intentShareText: request.intentShareText,
      dmPairingId: request.dmPairingId,
      dmPairingLabel: request.dmPairingLabel,
      dmReplyText: request.dmReplyText,
    });

    const getActionApprovalRequestDirUri = async () => {
      if (actionApprovalRequestDirUri) return actionApprovalRequestDirUri;
      if (TerminalEmulator.getAgentActionApprovalBridgePaths) {
        const paths = await TerminalEmulator.getAgentActionApprovalBridgePaths().catch((e) => {
          logError('AgentActionApproval', 'bridge path lookup failed', e);
          return null;
        });
        if (paths?.requestDirUri) {
          actionApprovalRequestDirUri = trimActionFileUri(paths.requestDirUri);
          logInfo('AgentActionApproval', `watching ${paths.requestDirPath}`);
          return actionApprovalRequestDirUri;
        }
      }
      actionApprovalRequestDirUri = trimActionFileUri(fallbackActionApprovalRequestDirUri);
      return actionApprovalRequestDirUri;
    };

    const readActionApprovalRequest = async (runId: string) => {
      if (TerminalEmulator.readAgentActionApprovalRequest) {
        return parseActionApprovalRequest(await TerminalEmulator.readAgentActionApprovalRequest(runId));
      }
      const dirUri = await getActionApprovalRequestDirUri();
      const name = `action-${safeActionFilePart(runId)}.json`;
      const fileUri = joinActionFileUri(dirUri, name);
      const raw = await FileSystem.readAsStringAsync(fileUri);
      return parseActionApprovalRequest(JSON.parse(raw));
    };

    const handleAgentActionConfirm = async (runId: string) => {
      if (!runId) return;
      try {
        const request = await readActionApprovalRequest(runId);
        if (!request || (request.actionType !== 'cli' && request.actionType !== 'intent' && request.actionType !== 'dm-reply')) {
          Alert.alert(t('agent_action_confirm_not_ready'));
          return;
        }
        if (request.expiresAt && request.expiresAt < Date.now()) {
          Alert.alert(t('agent_action_confirm_expired'));
          return;
        }
        setPendingAgentActionApproval(request);
      } catch (e) {
        logError('AgentActionApproval', `read request failed run=${runId}`, e);
        Alert.alert(t('agent_action_confirm_not_ready'));
      }
    };

    const handleDeepLink = async (url: string) => {
      try {
        const parsed = Linking.parse(url);
        const target = normalizeDeepLinkTarget(parsed);
        logInfo(
          'DeepLink',
          `received: ${url} → target=${target || '(none)'} host=${parsed.hostname ?? '(null)'} path=${parsed.path ?? '(null)'} params=${JSON.stringify(parsed.queryParams)}`,
        );
        if (target === 'browser') {
          await waitForMultiPaneHydration();
          const raw = parsed.queryParams?.url;
          const browserUrl = Array.isArray(raw) ? raw[0] : raw;
          if (typeof browserUrl === 'string' && browserUrl.length > 0) {
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
            useBrowserStore.getState().openUrl(browserUrl);
            logInfo('DeepLink', `openUrl dispatched: ${browserUrl}`);
          }
        } else if (target === 'clipboard') {
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
        } else if (target === 'scouter') {
          useSettingsStore.getState().setShowScouterDetail(true);
          logInfo('DeepLink', 'Scouter detail opened');
        } else if (target === 'agent-action-confirm') {
          const runId = queryValue(parsed.queryParams?.runId);
          if (typeof runId === 'string') {
            await handleAgentActionConfirm(runId);
          }
        } else if (target === 'agent-chat') {
          await waitForMultiPaneHydration();
          const compose = queryValue(parsed.queryParams?.compose);
          const drainWidgetApproval = normalizeApprovalDecision(queryValue(parsed.queryParams?.drainWidgetApproval));
          const widgetFlow =
            queryValue(parsed.queryParams?.source) === 'widget' ||
            queryValue(parsed.queryParams?.drainWidgetPrompt) === '1' ||
            drainWidgetApproval !== null ||
            queryValue(parsed.queryParams?.returnHome) === '1';
          if (widgetFlow && (compose === '1' || compose === 'true' || drainWidgetApproval !== null)) {
            useAgentChatStore.getState().allowWidgetBindingForWidgetAction();
          }
          const opened = focusPaneByTab('agent-chat');
          if (!opened && widgetFlow) {
            if (drainWidgetApproval) {
              logInfo('DeepLink', 'Widget approval continuing without Agent Chat pane');
            } else {
              logInfo('DeepLink', 'Widget prompt continuing without Agent Chat pane');
            }
          } else if (!opened) {
            return;
          }
          if (compose === '1' || compose === 'true') {
            if (!agentChatResumeInFlight) {
              agentChatResumeInFlight = true;
              let widgetTarget: WidgetPromptTarget | null = null;
              if (widgetFlow && drainWidgetApproval) {
                widgetTarget = TerminalEmulator.getScouterWidgetPendingApprovalTarget
                  ? await TerminalEmulator.getScouterWidgetPendingApprovalTarget().catch((e) => {
                      logError('DeepLink', 'Widget approval target read failed', e);
                      return null;
                    })
                  : null;
              } else if (widgetFlow) {
                widgetTarget = TerminalEmulator.getScouterWidgetPendingPromptTarget
                  ? await TerminalEmulator.getScouterWidgetPendingPromptTarget().catch((e) => {
                      logError('DeepLink', 'Widget prompt target read failed', e);
                      return null;
                    })
                  : null;
              }
              void resumeLatestAgentChatSession(widgetTarget)
                .then(async (outcome) => {
                  if (!widgetFlow) return;
                  if (!outcome) {
                    if (drainWidgetApproval) {
                      await markWidgetApprovalFailed('Codex resume failed');
                      return;
                    }
                    // No resumable Codex session (fresh install / Codex never
                    // run). Cold-start a brand-new `codex` and deliver the
                    // queued widget prompt directly into it.
                    const coldStarted = await coldStartCodexAndDeliverWidgetPrompt({
                      addTerminalPane: (tab) => useMultiPaneStore.getState().addPane(tab),
                    }).catch(() => false);
                    if (!coldStarted) {
                      await TerminalEmulator.markScouterWidgetPromptFailed?.('Codex resume failed').catch(() => undefined);
                    }
                    return;
                  }
                  if (drainWidgetApproval) {
                    await drainWidgetApprovalForSession(outcome.resumedSession, drainWidgetApproval);
                  } else {
                    await drainWidgetPromptForSession(outcome.resumedSession);
                  }
                })
                .finally(() => {
                  agentChatResumeInFlight = false;
                  if (widgetFlow) {
                    returnHomeFromWidgetFlow();
                    return;
                  }
                  focusPaneByTab('agent-chat');
                  useAgentChatStore.getState().requestComposeFocus();
                });
            } else {
              logInfo('DeepLink', 'Agent Chat resume skipped: already in flight');
              if (!widgetFlow) {
                useAgentChatStore.getState().requestComposeFocus();
              } else {
                returnHomeFromWidgetFlow();
              }
            }
          } else if (widgetFlow) {
            returnHomeFromWidgetFlow();
          }
          logInfo('DeepLink', `Agent Chat ${opened ? 'opened' : 'open failed'}`);
        }
      } catch (e) {
        logError('DeepLink', 'parse failed', e);
      }
    };
    const linkSub = Linking.addEventListener('url', (event) => {
      void handleDeepLink(event.url);
    });
    // Cold-start case: app launched directly from the deep link (no prior
    // process to receive the 'url' event).
    Linking.getInitialURL().then((url) => {
      if (url) void handleDeepLink(url);
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
    // form supports OAuth flows that need a real browser process via
    // Custom Tabs because Chromium WebView can append headers that some
    // providers use to gate sign-in. JSON shape (all fields
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
      // Last resort: open in-app. A visible failure is better than a
      // silent hang.
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
    // (shelly-xdg-open.c, shelly-codex-auth.js, or another CLI bridge)
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
        } catch {
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
            } catch {
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

    const fallbackEscalationRequestDirUri = `${FileSystem.documentDirectory}home/.shelly/agents/escalations`;
    const notifiedEscalations = new Map<string, { runId: string; reqId: string; seenAt: number }>();
    const processedGrantSpends = new Map<string, { seenAt: number }>();
    let escalationRequestDirUri: string | null = null;
    let isDrainingEscalations = false;

    const trimFileUri = (uri: string) => uri.replace(/\/+$/, '');
    const joinFileUri = (dirUri: string, name: string) => `${trimFileUri(dirUri)}/${name}`;

    const parseEscalationRequest = (raw: unknown): AgentEscalationRequest | null => {
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      if (!value) return null;
      const str = (field: string) => typeof value[field] === 'string' ? (value[field] as string).trim() : '';
      const runId = str('runId');
      const reqId = str('reqId');
      const command = str('command');
      if (!runId || !reqId || !command) return null;
      const signals = Array.isArray(value.signals)
        ? value.signals.map((item) => String(item).trim()).filter(Boolean)
        : [];
      return {
        runId,
        reqId,
        command,
        signals,
        agentId: str('agentId') || 'agent',
        commandSha256: str('commandSha256') || null,
        workspaceRoot: str('workspaceRoot') || null,
        cwd: str('cwd') || null,
        reason: str('reason') || null,
        level: str('level') || null,
        ts: str('ts') || null,
        state: str('state') || null,
        queuedAt: str('queuedAt') || null,
      };
    };

    const parseGrantSpendRequest = (raw: unknown): AgentGrantSpendRequest | null => {
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      if (!value || value.type !== 'grant_spend_request') return null;
      const str = (field: string) => typeof value[field] === 'string' ? (value[field] as string).trim() : '';
      const grantId = str('grantId');
      const reqId = str('reqId');
      const requestSha256 = str('requestSha256');
      if (!grantId || !reqId || !/^[0-9a-f]{64}$/i.test(requestSha256)) return null;
      return {
        type: 'grant_spend_request',
        grantId,
        reqId,
        requestSha256: requestSha256.toLowerCase(),
        ts: str('ts') || null,
      };
    };

    const escalationKey = (request: AgentEscalationRequest) => JSON.stringify({
      runId: request.runId,
      reqId: request.reqId,
      agentId: request.agentId,
      command: request.command,
      commandSha256: request.commandSha256,
      workspaceRoot: request.workspaceRoot,
      cwd: request.cwd,
      reason: request.reason,
      signals: request.signals,
      level: request.level,
      ts: request.ts,
      state: request.state,
      queuedAt: request.queuedAt,
    });

    const getEscalationRequestDirUri = async () => {
      if (escalationRequestDirUri) return escalationRequestDirUri;
      if (TerminalEmulator.getAgentEscalationBridgePaths) {
        const paths = await TerminalEmulator.getAgentEscalationBridgePaths().catch((e) => {
          logError('AgentEscalation', 'bridge path lookup failed', e);
          return null;
        });
        if (paths?.requestDirUri) {
          escalationRequestDirUri = trimFileUri(paths.requestDirUri);
          logInfo('AgentEscalation', `watching ${paths.requestDirPath}`);
          return escalationRequestDirUri;
        }
      }
      escalationRequestDirUri = trimFileUri(fallbackEscalationRequestDirUri);
      return escalationRequestDirUri;
    };

    const rememberEscalation = (key: string, request: AgentEscalationRequest) => {
      const now = Date.now();
      notifiedEscalations.set(key, { runId: request.runId, reqId: request.reqId, seenAt: now });
      for (const [candidate, record] of notifiedEscalations) {
        if (now - record.seenAt > 10 * 60_000) notifiedEscalations.delete(candidate);
      }
    };

    const drainAgentEscalationRequests = async () => {
      if (isDrainingEscalations || disposed || !TerminalEmulator.notifyAgentEscalationApprovalNeeded) return;
      isDrainingEscalations = true;
      try {
        const requestDirUri = await getEscalationRequestDirUri();
        const names = await FileSystem.readDirectoryAsync(requestDirUri).catch(() => null);
        if (!names) return;
        const activeKeys = new Set<string>();
        const activeAnchors = new Set<string>();
        const activeGrantSpendKeys = new Set<string>();
        for (const name of names) {
          const fileUri = joinFileUri(requestDirUri, name);
          if (/^grant-spend-[A-Za-z0-9_.=-]+-[A-Za-z0-9_.=-]+\.json$/.test(name)) {
            if (!TerminalEmulator.processAgentGrantSpendRequest) continue;
            let parsedSpend: AgentGrantSpendRequest | null = null;
            try {
              parsedSpend = parseGrantSpendRequest(JSON.parse(await FileSystem.readAsStringAsync(fileUri)));
            } catch (e) {
              logError('AgentEscalation', `rejected unreadable grant spend request ${name}`, e);
              continue;
            }
            if (!parsedSpend) {
              logError('AgentEscalation', `rejected invalid grant spend request ${name}`);
              continue;
            }
            const spendKey = `${parsedSpend.grantId}|${parsedSpend.reqId}|${parsedSpend.requestSha256}`;
            activeGrantSpendKeys.add(spendKey);
            if (!processedGrantSpends.has(spendKey)) {
              await TerminalEmulator.processAgentGrantSpendRequest(parsedSpend);
              processedGrantSpends.set(spendKey, { seenAt: Date.now() });
              logInfo('AgentEscalation', `grant spend processed grant=${parsedSpend.grantId} req=${parsedSpend.reqId}`);
            }
            continue;
          }
          if (!/^req-[A-Za-z0-9_.=-]+-[A-Za-z0-9_.=-]+\.json$/.test(name)) continue;
          let parsed: AgentEscalationRequest | null = null;
          try {
            parsed = parseEscalationRequest(JSON.parse(await FileSystem.readAsStringAsync(fileUri)));
          } catch (e) {
            logError('AgentEscalation', `rejected unreadable request ${name}`, e);
            continue;
          }
          if (!parsed) {
            logError('AgentEscalation', `rejected invalid request ${name}`);
            continue;
          }
          const key = escalationKey(parsed);
          activeKeys.add(key);
          activeAnchors.add(`${parsed.runId}|${parsed.reqId}`);
          if (notifiedEscalations.has(key)) continue;
          await TerminalEmulator.notifyAgentEscalationApprovalNeeded(parsed);
          rememberEscalation(key, parsed);
          logInfo('AgentEscalation', `approval notification posted run=${parsed.runId} req=${parsed.reqId}`);
        }
        for (const [key, record] of processedGrantSpends) {
          if (activeGrantSpendKeys.has(key)) continue;
          if (Date.now() - record.seenAt > 10 * 60_000) processedGrantSpends.delete(key);
        }
        for (const [key, record] of notifiedEscalations) {
          if (activeKeys.has(key)) continue;
          if (activeAnchors.has(`${record.runId}|${record.reqId}`)) {
            notifiedEscalations.delete(key);
            continue;
          }
          await TerminalEmulator.cancelAgentEscalationApproval?.(record.runId, record.reqId).catch(() => undefined);
          notifiedEscalations.delete(key);
          logInfo('AgentEscalation', `stale approval notification cancelled run=${record.runId} req=${record.reqId}`);
        }
      } catch (e) {
        logError('AgentEscalation', 'poll iteration failed', e);
      } finally {
        isDrainingEscalations = false;
      }
    };
    const escalationInterval = setInterval(drainAgentEscalationRequests, 500);
    void drainAgentEscalationRequests();

    const rememberActionApproval = (key: string, request: AgentActionApprovalRequest) => {
      const now = Date.now();
      notifiedActionApprovals.set(key, { runId: request.runId, seenAt: now });
      for (const [candidate, record] of notifiedActionApprovals) {
        if (now - record.seenAt > 10 * 60_000) notifiedActionApprovals.delete(candidate);
      }
    };

    const drainAgentActionApprovalRequests = async () => {
      if (
        isDrainingActionApprovals ||
        disposed ||
        !TerminalEmulator.notifyAgentActionApprovalNeeded
      ) {
        return;
      }
      isDrainingActionApprovals = true;
      try {
        const requestDirUri = await getActionApprovalRequestDirUri();
        const names = await FileSystem.readDirectoryAsync(requestDirUri).catch(() => null);
        if (!names) return;
        const activeKeys = new Set<string>();
        const activeRunIds = new Set<string>();
        for (const name of names) {
          if (!/^action-[A-Za-z0-9_.=-]+\.json$/.test(name)) continue;
          const fileUri = joinActionFileUri(requestDirUri, name);
          let parsed: AgentActionApprovalRequest | null = null;
          try {
            parsed = parseActionApprovalRequest(JSON.parse(await FileSystem.readAsStringAsync(fileUri)));
          } catch (e) {
            logError('AgentActionApproval', `rejected unreadable request ${name}`, e);
            continue;
          }
          if (!parsed) {
            logError('AgentActionApproval', `rejected invalid request ${name}`);
            continue;
          }
          if (parsed.expiresAt && parsed.expiresAt < Date.now()) {
            continue;
          }
          const key = actionApprovalKey(parsed);
          activeKeys.add(key);
          activeRunIds.add(parsed.runId);
          if (notifiedActionApprovals.has(key)) continue;
          await TerminalEmulator.notifyAgentActionApprovalNeeded(parsed);
          rememberActionApproval(key, parsed);
          logInfo('AgentActionApproval', `approval notification posted run=${parsed.runId} action=${parsed.actionType}`);
        }
        for (const [key, record] of notifiedActionApprovals) {
          if (activeKeys.has(key)) continue;
          if (activeRunIds.has(record.runId)) {
            notifiedActionApprovals.delete(key);
            continue;
          }
          await TerminalEmulator.cancelAgentActionApproval?.(record.runId).catch(() => undefined);
          notifiedActionApprovals.delete(key);
          logInfo('AgentActionApproval', `stale approval notification cancelled run=${record.runId}`);
        }
      } catch (e) {
        logError('AgentActionApproval', 'poll iteration failed', e);
      } finally {
        isDrainingActionApprovals = false;
      }
    };
    const actionApprovalInterval = setInterval(drainAgentActionApprovalRequests, 500);
    void drainAgentActionApprovalRequests();

    // Snapshot terminal state before the bridge can be paused or killed.
    const sub = AppState.addEventListener('change', (state) => {
      logInfo('RootLayout', `AppState changed: ${state}`);
      if (state === 'inactive' || state === 'background') {
        void useTerminalStore.getState().saveSessionState();
      }
      if (state === 'background') {
        unloadSounds();
      }
    });
    return () => {
      disposed = true;
      sub.remove();
      agentLogSub.remove();
      linkSub.remove();
      clearTimeout(agentLogStartTimer);
      clearInterval(queueInterval);
      clearInterval(escalationInterval);
      clearInterval(actionApprovalInterval);
      if (agentLogInterval) clearInterval(agentLogInterval);
    };
  }, [loadSettings]);

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
      <SafeAreaProvider>
        <Stack key={locale} screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
        </Stack>
        {pendingAgentActionApproval ? (
          <View style={actionApprovalStyles.backdrop}>
            <View style={actionApprovalStyles.panel}>
              <Text style={actionApprovalStyles.eyebrow}>
                {pendingAgentActionApproval.actionType === 'intent'
                  ? t('agent_action_confirm_title_intent')
                  : pendingAgentActionApproval.actionType === 'dm-reply'
                    ? t('agent_action_confirm_title_dmreply')
                  : t('agent_action_confirm_title')}
              </Text>
              <Text style={actionApprovalStyles.body}>
                {pendingAgentActionApproval.actionType === 'intent'
                  ? t('agent_action_confirm_body_intent')
                  : pendingAgentActionApproval.actionType === 'dm-reply'
                    ? t('agent_action_confirm_body_dmreply')
                  : t('agent_action_confirm_body')}
              </Text>
              {pendingAgentActionApproval.actionType === 'intent' ? (
                <>
                  <Text style={actionApprovalStyles.label}>
                    {t('agent_action_confirm_intent_mode')}
                  </Text>
                  <Text style={actionApprovalStyles.meta}>
                    {pendingAgentActionApproval.intentMode || ''}
                  </Text>
                  <Text style={actionApprovalStyles.label}>
                    {t('agent_action_confirm_intent_target')}
                  </Text>
                  <Text selectable style={actionApprovalStyles.commandText}>
                    {pendingAgentActionApproval.intentTarget || ''}
                  </Text>
                  {pendingAgentActionApproval.intentMode === 'share' ? (
                    <>
                      <Text style={actionApprovalStyles.label}>
                        {t('agent_action_confirm_intent_share_text')}
                      </Text>
                      <ScrollView style={actionApprovalStyles.commandBox}>
                        <Text selectable style={actionApprovalStyles.commandText}>
                          {pendingAgentActionApproval.intentShareText || ''}
                        </Text>
                      </ScrollView>
                    </>
                  ) : null}
                </>
              ) : pendingAgentActionApproval.actionType === 'dm-reply' ? (
                <>
                  <Text style={actionApprovalStyles.label}>{t('agent_action_confirm_dmreply_target')}</Text>
                  <Text selectable style={actionApprovalStyles.commandText}>
                    {pendingAgentActionApproval.dmPairingLabel || ''}
                  </Text>
                  <Text style={actionApprovalStyles.label}>{t('agent_action_confirm_dmreply_text')}</Text>
                  <ScrollView style={actionApprovalStyles.commandBox}>
                    <Text selectable style={actionApprovalStyles.commandText}>
                      {pendingAgentActionApproval.dmReplyText || ''}
                    </Text>
                  </ScrollView>
                </>
              ) : (
                <>
                  <Text style={actionApprovalStyles.label}>{t('agent_action_confirm_safety')}</Text>
                  <Text style={actionApprovalStyles.meta}>
                    {(pendingAgentActionApproval.safetyLevel || 'UNKNOWN')}: {pendingAgentActionApproval.safetyReason || ''}
                  </Text>
                  <Text style={actionApprovalStyles.label}>{t('agent_action_confirm_command')}</Text>
                  <ScrollView style={actionApprovalStyles.commandBox}>
                    <Text selectable style={actionApprovalStyles.commandText}>
                      {pendingAgentActionApproval.command || ''}
                    </Text>
                  </ScrollView>
                </>
              )}
              <View style={actionApprovalStyles.actions}>
                <Pressable
                  disabled={agentActionResolving}
                  style={[actionApprovalStyles.button, actionApprovalStyles.declineButton]}
                  onPress={() => void resolvePendingAgentActionApproval('decline')}
                >
                  <Text style={actionApprovalStyles.buttonText}>
                    {t('agent_action_confirm_decline')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={agentActionResolving}
                  style={[actionApprovalStyles.button, actionApprovalStyles.allowButton]}
                  onPress={() => void resolvePendingAgentActionApproval('accept')}
                >
                  <Text style={actionApprovalStyles.buttonText}>
                    {t('agent_action_confirm_allow')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const actionApprovalStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5000,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  panel: {
    width: '100%',
    maxWidth: 680,
    maxHeight: '86%',
    borderWidth: 1,
    borderColor: '#00FF66',
    backgroundColor: '#050805',
    padding: 18,
    gap: 12,
  },
  eyebrow: {
    color: '#00FF66',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 16,
  },
  body: {
    color: '#BDE8C6',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 13,
    lineHeight: 20,
  },
  label: {
    color: '#7AF59C',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 12,
    textTransform: 'uppercase',
  },
  meta: {
    color: '#D7FCE0',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 12,
    lineHeight: 18,
  },
  commandBox: {
    maxHeight: 260,
    borderWidth: 1,
    borderColor: '#1D7F42',
    backgroundColor: '#000',
    padding: 12,
  },
  commandText: {
    color: '#E8FFF0',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  button: {
    minWidth: 120,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  declineButton: {
    borderColor: '#FF6B73',
    backgroundColor: '#170508',
  },
  allowButton: {
    borderColor: '#00FF66',
    backgroundColor: '#063516',
  },
  buttonText: {
    color: '#F5FFF8',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 13,
  },
});
