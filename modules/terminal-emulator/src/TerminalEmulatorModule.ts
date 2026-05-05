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
  writeToEmulator(sessionId: string, text: string): Promise<void>;
  getSessionTitle(sessionId: string): Promise<string>;
  startSessionService(): Promise<void>;
  stopSessionService(): Promise<void>;
  updateSessionNotification(info: string): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestBatteryOptimizationExemption(): Promise<void>;
  /** bug #92: Android 11+ MANAGE_EXTERNAL_STORAGE gate — true on < API 30 since legacy perms cover /sdcard. */
  hasAllFilesAccess(): Promise<boolean>;
  /** bug #92: Fires the per-package all-files-access settings intent. No-op when already granted or API < 30. */
  requestAllFilesAccess(): Promise<void>;
  testExecve(): Promise<{ success: boolean; result?: string; error?: string }>;
  scheduleAgent(agentId: string, intervalMs: number, triggerAtMs: number): Promise<void>;
  cancelAgent(agentId: string): Promise<void>;
  execCommand(command: string, timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readProcNetFile(path: string): Promise<string>;
  readDir(path: string): Promise<string>;
  queryListenSockets(family: number): Promise<string>;
  getHomeDir(): Promise<string>;
  installApk(apkPath: string): Promise<void>;
  pasteToSession(sessionId: string, text: string): Promise<void>;
  pasteClipboardToSession(sessionId: string): Promise<void>;
}

export default requireNativeModule<TerminalEmulatorModuleType>('TerminalEmulator');
