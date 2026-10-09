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

/** "Quote to AI" tap in the native text-selection menu. */
export interface QuoteSelectionEvent {
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

export interface SelectionModeChangedEvent {
  nativeEvent: {
    /** true while the native long-press text selection (handles + action menu) is up. */
    active: boolean;
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
   * Kept for native ABI compatibility. Android terminal panes are forced
   * opaque black so session attach, prompt paint, and IME resize cannot
   * expose panel or wallpaper layers behind empty terminal cells.
   */
  transparentBackground?: boolean;
  /**
   * Minimum WCAG contrast ratio enforced for text (<= 1 disables). Resolve
   * the user setting with lib/terminal-contrast.ts
   * resolveTerminalMinimumContrast() before passing it.
   */
  minimumContrastRatio?: number;
  /** '#RRGGBB' of the surface visible behind transparent terminal cells. */
  contrastBackground?: string;
  onOutput?: (event: OutputEvent) => void;
  onBlockCompleted?: (event: BlockCompletedEvent) => void;
  onSelectionChanged?: (event: SelectionChangedEvent) => void;
  onUrlDetected?: (event: UrlDetectedEvent) => void;
  onBell?: () => void;
  onTitleChanged?: (event: TitleChangedEvent) => void;
  onResize?: (event: ResizeEvent) => void;
  onScrollStateChanged?: (event: ScrollStateChangedEvent) => void;
  /** Throttled (~500ms) ping while the user finger-scrolls / flings scrollback. */
  onScrollActivity?: () => void;
  onSelectionModeChanged?: (event: SelectionModeChangedEvent) => void;
  onFocusRequested?: (event: FocusRequestedEvent) => void;
  /** Label for the extra "Quote to AI" item in the selection menu (i18n'd on
   *  the JS side). Omit/empty to hide the item. */
  quoteActionLabel?: string;
  onQuoteSelection?: (event: QuoteSelectionEvent) => void;
}

export const NativeTerminalView =
  requireNativeViewManager<NativeTerminalViewProps>('TerminalView');
