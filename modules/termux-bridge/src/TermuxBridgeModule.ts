import { NativeModule, requireNativeModule } from 'expo';

declare class TermuxBridgeModule extends NativeModule {
  runCommand(command: string, background: boolean): Promise<{ success: boolean; error?: string }>;
  launchTermux(): Promise<{ success: boolean; error?: string }>;
  isPackageInstalled(packageName: string): Promise<boolean>;
  startForeground(): Promise<{ success: boolean }>;
  stopForeground(): Promise<{ success: boolean }>;
  isForegroundRunning(): boolean;
}

export default requireNativeModule<TermuxBridgeModule>('TermuxBridge');
