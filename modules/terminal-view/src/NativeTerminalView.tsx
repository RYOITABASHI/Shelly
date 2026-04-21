// @ts-expect-error — expo-modules-core types not exposed by pnpm hoisting; runtime resolves fine
import { requireNativeViewManager } from 'expo-modules-core';
import { ViewProps } from 'react-native';

export type FontFamily = 'jetbrains-mono' | 'fira-code' | 'pixel-mplus';

export type CursorShape = 'block' | 'underline' | 'bar';

export interface OutputEvent {
  nativeEvent: {
    text: string;
    isError: boolean;
  };
}

export interface BlockCompletedEvent {
  nativeEvent: {
    command: string;
    output: string;
    exitCode: number;
  };
}

export interface SelectionChangedEvent {
  nativeEvent: {
    text: string;
  };
}

export interface UrlDetectedEvent {
  nativeEvent: {
    url: string;
    type: string;
  };
}

export interface TitleChangedEvent {
  nativeEvent: {
    title: string;
  };
}

export interface ResizeEvent {
  nativeEvent: {
    cols: number;
    rows: number;
  };
}

export interface ScrollStateChangedEvent {
  nativeEvent: {
    isScrolledUp: boolean;
  };
}

export interface FocusRequestedEvent {
  nativeEvent: {
    sessionId: string;
  };
}

export interface NativeTerminalViewProps extends ViewProps {
  sessionId: string;
  fontFamily: FontFamily;
  fontSize: number;
  cursorShape?: CursorShape;
  cursorBlink?: boolean;
  colorScheme?: Record<string, string>;
  gpuRendering?: boolean;
  /**
   * Phase B (2026-04-21). When true, the underlying Android view drops
   * its opaque background + the padding-region bg fill so a wallpaper
   * behind the ShellLayout can show through. Cells with non-default
   * backgrounds still paint, so prompt / syntax colours stay visible.
   * Default false preserves the pre-Phase-B opaque look.
   */
  transparentBackground?: boolean;
  onOutput?: (event: OutputEvent) => void;
  onBlockCompleted?: (event: BlockCompletedEvent) => void;
  onSelectionChanged?: (event: SelectionChangedEvent) => void;
  onUrlDetected?: (event: UrlDetectedEvent) => void;
  onBell?: () => void;
  onTitleChanged?: (event: TitleChangedEvent) => void;
  onResize?: (event: ResizeEvent) => void;
  onScrollStateChanged?: (event: ScrollStateChangedEvent) => void;
  onFocusRequested?: (event: FocusRequestedEvent) => void;
}

export const NativeTerminalView =
  requireNativeViewManager<NativeTerminalViewProps>('TerminalView');
