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
  returnToHome?(): Promise<void>;
  addListener(eventName: string, listener: (event: any) => void): { remove(): void };
}

export default requireNativeModule<TerminalEmulatorModuleType>('TerminalEmulator');
