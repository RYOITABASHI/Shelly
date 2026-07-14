// @ts-expect-error — expo-modules-core types not exposed by pnpm hoisting; runtime resolves fine
import { NativeModule, requireNativeModule } from 'expo-modules-core';

export interface SessionConfig {
  sessionId: string;
  rows?: number;
  cols?: number;
}

declare class TerminalEmulatorModuleType extends NativeModule {
  createSession(config: SessionConfig): Promise<{ sessionId: string; resumed: boolean }>;
  destroySession(sessionId: string): Promise<void>;
  writeToSession(sessionId: string, data: string): Promise<void>;
  interruptSession(sessionId: string): Promise<number>;
  sendKeyEvent(sessionId: string, keyCode: number, modifiers: number): Promise<void>;
  resizeSession(sessionId: string, rows: number, cols: number): Promise<void>;
  isSessionAlive(sessionId: string): Promise<boolean>;
  hasEmulator(sessionId: string): Promise<boolean>;
  getTranscriptText(sessionId: string, maxLines: number): Promise<string>;
  getScreenText(sessionId: string): Promise<string>;
  writeToEmulator(sessionId: string, text: string): Promise<void>;
  getSessionTitle(sessionId: string): Promise<string>;
  startSessionService(): Promise<void>;
  stopSessionService(): Promise<void>;
  updateSessionNotification(info: string): Promise<void>;
  runAgent(agentId: string): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestBatteryOptimizationExemption(): Promise<void>;
  /** bug #92: Android 11+ MANAGE_EXTERNAL_STORAGE gate — true on < API 30 since legacy perms cover /sdcard. */
  hasAllFilesAccess(): Promise<boolean>;
  /** bug #92: Fires the per-package all-files-access settings intent. No-op when already granted or API < 30. */
  requestAllFilesAccess(): Promise<void>;
  /** NOTIFY-001 Increment 0: OS-level "Notification access" special permission check (Settings.Secure.ENABLED_NOTIFICATION_LISTENERS). */
  hasNotificationListenerAccess(): Promise<boolean>;
  /** NOTIFY-001 Increment 0: opens Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS so the user can grant notification-listener access. */
  requestNotificationListenerAccess(): Promise<void>;
  /** NOTIFY-001 Increment 2: reads Shelly's own dormant flag (SharedPreferences, default false) gating the notification-trigger feature. */
  getNotificationTriggerEnabled(): Promise<boolean>;
  /** NOTIFY-001 Increment 2: writes Shelly's own dormant flag gating the notification-trigger feature. */
  setNotificationTriggerEnabled(enabled: boolean): Promise<void>;
  /** Independent, default-off native gate for sending notification replies. */
  getNotificationReplyEnabled(): Promise<boolean>;
  setNotificationReplyEnabled(enabled: boolean): Promise<void>;
  sendNotificationReply(packageName: string, replyText: string): Promise<boolean>;
  findDmPairingCandidates(code: string): Promise<Array<{
    packageName: string;
    notificationId: number;
    notificationTag: string | null;
    shortcutId: string | null;
    title: string;
    textPreview: string;
  }>>;
  sendPairedDmReply(dmPairingId: string, replyText: string): Promise<boolean>;
  postDmReplyTestNotification(): Promise<boolean>;
  getDmReplyTestResult(): Promise<{ receivedText: string | null; receivedAtMs: number | null }>;
  clearDmReplyTestResult(): Promise<void>;
  testExecve(): Promise<{ success: boolean; result?: string; error?: string }>;
  scheduleAgent(agentId: string, intervalMs: number, triggerAtMs: number, cron?: string): Promise<void>;
  cancelAgent(agentId: string): Promise<void>;
  execCommand(command: string, timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readProcNetFile(path: string): Promise<string>;
  readDir(path: string): Promise<string>;
  queryListenSockets(family: number): Promise<string>;
  getHomeDir(): Promise<string>;
  getAppVersionInfo(): Promise<{ packageName: string; versionName: string; versionCode: number }>;
  installApk(apkPath: string): Promise<void>;
  enqueueApkDownload(url: string, downloadSubdir: string, fileName: string): Promise<{ downloadId: number; path: string }>;
  getApkDownloadStatus(downloadId: number): Promise<{
    downloadId: number;
    status: 'pending' | 'running' | 'paused' | 'successful' | 'failed' | 'missing' | 'unknown';
    reason: number;
    downloadedBytes: number;
    totalBytes: number;
    localUri?: string | null;
  }>;
  verifyApkFile(apkPath: string, expectedSha256: string, expectedSizeBytes: number): Promise<{
    ok: boolean;
    actualSha256: string;
    bytes: number;
    error?: string | null;
  }>;
  removeApkDownload(downloadId: number): Promise<void>;
  pasteToSession(sessionId: string, text: string): Promise<void>;
  pasteClipboardToSession(sessionId: string): Promise<void>;
  setScouterEnabled(enabled: boolean): Promise<void>;
  getScouterDebugInfo(): Promise<string>;
  refreshScouter?(): Promise<string>;
  installScouterCodexPetZip?(uri: string): Promise<{
    installedCount: number;
    installedIds: string[];
    targetRoot: string;
  }>;
  getScouterHookTemplate(source: 'cc' | 'codex' | string): Promise<string>;
  setScouterCodexBinding?(binding: {
    codexSessionId: string;
    ptySessionId?: string | null;
    shellySessionId?: string | null;
    cwd?: string | null;
  }): Promise<void>;
  clearScouterWidgetCodexBinding?(): Promise<void>;
  clearScouterWidgetConversationForPrivacy?(): Promise<void>;
  consumeScouterWidgetPendingPrompt?(
    codexSessionId?: string | null,
    ptySessionId?: string | null,
    shellySessionId?: string | null,
  ): Promise<{
    prompt: string;
    queuedAt: number;
    codexSessionId?: string | null;
    ptySessionId?: string | null;
    shellySessionId?: string | null;
  } | null>;
  getScouterWidgetPendingPromptTarget?(): Promise<{
    queuedAt: number;
    codexSessionId?: string | null;
    ptySessionId?: string | null;
    shellySessionId?: string | null;
  } | null>;
  consumeScouterWidgetPendingApproval?(
    codexSessionId?: string | null,
    ptySessionId?: string | null,
    shellySessionId?: string | null,
  ): Promise<{
    decision: 'allow' | 'deny';
    queuedAt: number;
    approvalAt?: number | null;
    approvalText?: string | null;
    codexSessionId?: string | null;
    ptySessionId?: string | null;
    shellySessionId?: string | null;
  } | null>;
  getScouterWidgetPendingApprovalTarget?(): Promise<{
    queuedAt: number;
    codexSessionId?: string | null;
    ptySessionId?: string | null;
    shellySessionId?: string | null;
  } | null>;
  markScouterWidgetPromptQueued?(prompt: string): Promise<void>;
  markScouterWidgetApprovalDecision?(decision: 'allow' | 'deny'): Promise<void>;
  markScouterWidgetApprovalFailed?(message: string): Promise<void>;
  markScouterWidgetApprovalResolved?(): Promise<void>;
  markScouterWidgetPromptFailed?(message: string): Promise<void>;
  markScouterWidgetChoicePending?(message: string): Promise<void>;
  getAgentEscalationBridgePaths?(): Promise<{
    requestDirPath: string;
    requestDirUri: string;
    replyDirPath: string;
    verifierPublicKeyPath: string;
    verifierPublicKeySha256?: string;
    preapprovalGrantFilePath?: string;
  }>;
  notifyAgentEscalationApprovalNeeded?(request: {
    runId: string;
    agentId?: string | null;
    reqId: string;
    command: string;
    commandSha256?: string | null;
    workspaceRoot?: string | null;
    cwd?: string | null;
    reason?: string | null;
    signals?: string[];
    level?: string | null;
    ts?: string | null;
    state?: string | null;
    queuedAt?: string | null;
  }): Promise<void>;
  processAgentGrantSpendRequest?(request: {
    type: 'grant_spend_request';
    grantId: string;
    reqId: string;
    requestSha256: string;
    ts?: string | null;
  }): Promise<void>;
  cancelAgentEscalationApproval?(runId: string, reqId: string): Promise<void>;
  getAgentActionApprovalBridgePaths?(): Promise<{
    requestDirPath: string;
    requestDirUri: string;
    replyDirPath: string;
  }>;
  readAgentActionApprovalRequest?(runId: string): Promise<{
    runId: string;
    agentId: string;
    actionType: 'draft' | 'notify' | 'webhook' | 'cli' | 'intent' | 'dm-reply' | 'app-act';
    preview?: string | null;
    destinationHost?: string | null;
    destinationHostAllowlisted?: boolean;
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
    appActRecipeId?: string | null;
    appActParamsResolved?: string | null;
    actionNonce?: string | null;
  }>;
  notifyAgentActionApprovalNeeded?(request: {
    runId: string;
    agentId?: string | null;
    actionType: 'draft' | 'notify' | 'webhook' | 'cli' | 'intent' | 'dm-reply' | 'app-act';
    preview?: string | null;
    destinationHost?: string | null;
    destinationHostAllowlisted?: boolean;
    command?: string | null;
    safetyLevel?: string | null;
    safetyReason?: string | null;
    payloadPath?: string | null;
    resultPath?: string | null;
    ts?: string | null;
    expiresAt?: number | null;
    intentMode?: 'launch' | 'share' | null;
    intentTarget?: string | null;
    intentShareText?: string | null;
    dmPairingId?: string | null;
    dmPairingLabel?: string | null;
    dmReplyText?: string | null;
    appActRecipeId?: string | null;
    appActParamsResolved?: string | null;
  }): Promise<void>;
  resolveAgentActionApproval?(
    runId: string,
    decision: 'accept' | 'decline',
    expectedRequestSha256: string,
    actionNonce: string
  ): Promise<void>;
  cancelAgentActionApproval?(runId: string): Promise<void>;
  fireAgentIntent?(mode: 'launch' | 'share', target: string, shareText?: string | null): Promise<void>;
  /** Agent action executor (app-act phase): fires a registered app-action
   *  recipe (e.g. 'x.post', 'line.send-message') with `params` resolved
   *  against the run result, via ShellyAccessibilityService/AppActExecutor.
   *  Never called with an un-reviewed request -- the approval tier for
   *  "app-act" requires in-app Review before Accept, same as
   *  fireAgentIntent. Throws if the Accessibility Service isn't connected or
   *  the recipe run fails, so the caller can resolve the pending approval as
   *  'decline' on any throw (fail-closed). */
  fireAgentAppAct?(recipeId: string, params: Record<string, string>): Promise<void>;
  /** app.act Milestone 0 (dev-only debug scaffold, docs/superpowers/specs/
   *  2026-07-11-app-act-design.md §6): types `text` into LINE's message
   *  field and taps send, against whatever conversation is currently
   *  foregrounded via ShellyAccessibilityService. `message` is always a
   *  specific reason (success or the exact precondition that failed). */
  debugAppActSendLineMessage?(text: string): Promise<{ success: boolean; message: string }>;
  /** app.act Milestone 0, X (Twitter) variant — same shape as
   *  debugAppActSendLineMessage, targets X's compose screen instead. */
  debugAppActPostToX?(text: string): Promise<{ success: boolean; message: string }>;
  /** app.act Track 1 (navigation, dev-only debug scaffold, docs/superpowers/
   *  specs/2026-07-11-app-act-design.md §2.1/§6): navigates to `targetName`'s
   *  LINE conversation via LINE's search screen (requiring an EXACT,
   *  non-fuzzy single text match — fails closed on zero or multiple
   *  matches), then types `text` into the message field and taps send.
   *  Unlike debugAppActSendLineMessage, does NOT require the conversation
   *  to already be open. */
  debugAppActSendLineMessageToContact?(
    targetName: string,
    text: string
  ): Promise<{ success: boolean; message: string }>;
  /** Native primitive for LockPromptActivity's lock-screen bridge
   *  (docs/superpowers/specs/2026-07-11-app-act-design.md §0.1): if the
   *  device is already unlocked, resolves true immediately with no UI. If
   *  locked, wakes the screen and shows a prompt over the keyguard asking
   *  the user to unlock via the OS's own PIN/pattern/biometric challenge
   *  (Shelly never sees the credential), then resolves true iff they
   *  succeed before the internal timeout. Not wired into any RN UI in this
   *  pass — for on-device testing of the primitive itself. */
  debugTestLockPrompt?(): Promise<boolean>;
  returnToHome?(): Promise<void>;
  addListener(eventName: string, listener: (event: any) => void): { remove(): void };
}

export default requireNativeModule<TerminalEmulatorModuleType>('TerminalEmulator');
