import { NativeModule, requireNativeModule } from 'expo-modules-core';

export interface SessionConfig {
  sessionId: string;
  cwd?: string;
  rows?: number;
  cols?: number;
  useTmux?: boolean;
  tmuxSessionName?: string;
}

declare class TerminalEmulatorModuleType extends NativeModule {
  createSession(config: SessionConfig): Promise<string>;
  destroySession(sessionId: string): Promise<void>;
  writeToSession(sessionId: string, data: string): Promise<void>;
  sendKeyEvent(sessionId: string, keyCode: number, modifiers: number): Promise<void>;
  resizeSession(sessionId: string, rows: number, cols: number): Promise<void>;
  isSessionAlive(sessionId: string): Promise<boolean>;
  getTranscriptText(sessionId: string, maxLines: number): Promise<string>;
  getSessionTitle(sessionId: string): Promise<string>;
}

export default requireNativeModule<TerminalEmulatorModuleType>('TerminalEmulator');
