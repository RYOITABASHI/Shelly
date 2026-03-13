import { NativeModule, requireNativeModule } from 'expo';

declare class TermuxBridgeModule extends NativeModule {
  runCommand(command: string, background: boolean): Promise<{ success: boolean; error?: string }>;
  isPackageInstalled(packageName: string): Promise<boolean>;
}

export default requireNativeModule<TermuxBridgeModule>('TermuxBridge');
