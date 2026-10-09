/**
 * BrowserPane URL bar → WebView navigation (2026-10-09, build 2495 on-device
 * findings: unreadable URL field on Case File, Enter not navigating, and a
 * ~500ms reload loop on a DNS-failed page).
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@/components/multi-pane/PaneSlot', () => {
  const React = require('react');
  return {
    __esModule: true,
    PaneIdContext: React.createContext(''),
    MultiPaneContext: React.createContext(null),
  };
});
jest.mock('@/hooks/use-multi-pane', () => ({
  __esModule: true,
  useMultiPaneStore: { getState: () => ({ slots: [], maximizedPaneId: null, toggleMaximize: jest.fn() }) },
}));
jest.mock('@/store/pane-store', () => ({
  __esModule: true,
  usePaneStore: { getState: () => ({ focusedPaneId: null }) },
}));
jest.mock('@/components/panes/PaneInputBar', () => ({
  __esModule: true,
  default: () => null,
}));

const mockWebViewInstances: Array<{ reload: jest.Mock; injectJavaScript: jest.Mock; goBack: jest.Mock; goForward: jest.Mock }> = [];
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockWebView = React.forwardRef((props: any, ref: any) => {
    const api = React.useMemo(() => {
      const a = { reload: jest.fn(), injectJavaScript: jest.fn(), goBack: jest.fn(), goForward: jest.fn() };
      mockWebViewInstances.push(a);
      return a;
    }, []);
    React.useImperativeHandle(ref, () => api, [api]);
    return React.createElement(View, { testID: 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView };
});

import React from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { act, render } from '@testing-library/react-native';
import BrowserPane from '@/components/panes/BrowserPane';
import { useBrowserStore } from '@/store/browser-store';
import { applyThemePreset } from '@/lib/theme-presets';

function urlInput(screen: ReturnType<typeof render>) {
  return screen.UNSAFE_getAllByType(TextInput)[0];
}
function webview(screen: ReturnType<typeof render>) {
  return screen.getByTestId('mock-webview');
}

beforeEach(() => {
  mockWebViewInstances.length = 0;
  useBrowserStore.setState({ lastOpenedUrl: null, openSignal: { url: '', seq: 0 } });
});

describe('BrowserPane URL bar submit', () => {
  it('Enter navigates the WebView to the normalized URL', () => {
    const screen = render(<BrowserPane />);
    act(() => {
      urlInput(screen).props.onChangeText('example.com');
    });
    act(() => {
      urlInput(screen).props.onSubmitEditing({ nativeEvent: { text: 'example.com' } });
    });
    expect(webview(screen).props.source).toEqual({ uri: 'https://example.com' });
    expect(urlInput(screen).props.value).toBe('https://example.com');
  });

  it('uses the submitted native text even if controlled state lags behind', () => {
    const screen = render(<BrowserPane />);
    act(() => {
      urlInput(screen).props.onSubmitEditing({ nativeEvent: { text: 'github.com' } });
    });
    expect(webview(screen).props.source).toEqual({ uri: 'https://github.com' });
  });

  it('a stale page navigation event never overrides the URL the user submitted', () => {
    const screen = render(<BrowserPane initialUrl="https://old.example.com" />);
    act(() => {
      urlInput(screen).props.onSubmitEditing({ nativeEvent: { text: 'new.example.com' } });
    });
    // A late event from the old (failing) page arrives afterwards.
    act(() => {
      webview(screen).props.onNavigationStateChange({
        url: 'https://old.example.com/', canGoBack: false, canGoForward: false,
      });
    });
    expect(webview(screen).props.source).toEqual({ uri: 'https://new.example.com' });
  });

  it('keeps the same source object across page navigation events (no WebView reload)', () => {
    const screen = render(<BrowserPane initialUrl="https://example.com" />);
    const before = webview(screen).props.source;
    act(() => {
      webview(screen).props.onNavigationStateChange({
        url: 'https://example.com/redirected', canGoBack: true, canGoForward: false,
      });
    });
    expect(webview(screen).props.source).toBe(before);
  });

  it('re-submitting the URL currently shown reloads instead of being a silent no-op', () => {
    const screen = render(<BrowserPane initialUrl="https://example.com" />);
    act(() => {
      urlInput(screen).props.onSubmitEditing({ nativeEvent: { text: 'https://example.com' } });
    });
    expect(mockWebViewInstances[0].reload).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserPane load errors', () => {
  it('does not auto-reload on a load error (no DNS-failure reload loop)', () => {
    jest.useFakeTimers();
    try {
      const screen = render(<BrowserPane initialUrl="https://example.com" />);
      expect(webview(screen).props.onError).toBeUndefined();
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockWebViewInstances[0].reload).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('records only successful loads as lastOpenedUrl', () => {
    const screen = render(<BrowserPane initialUrl="https://example.com" />);
    act(() => {
      webview(screen).props.onNavigationStateChange({
        url: 'https://bad_host.md/', canGoBack: false, canGoForward: false,
      });
    });
    expect(useBrowserStore.getState().lastOpenedUrl).toBeNull();
    act(() => {
      webview(screen).props.onLoad({ nativeEvent: { url: 'https://example.com/' } });
    });
    expect(useBrowserStore.getState().lastOpenedUrl).toBe('https://example.com/');
  });
});

describe('BrowserPane restore sanitization', () => {
  it('ignores a malformed persisted lastOpenedUrl on mount', () => {
    useBrowserStore.setState({ lastOpenedUrl: 'https://notes.md%20~/hw/ry_md_test.md/?locale=ja' });
    const screen = render(<BrowserPane />);
    expect(screen.queryByTestId('mock-webview')).toBeNull();
    expect(urlInput(screen).props.value).toBe('');
  });

  it('ignores a malformed lastOpenedUrl that arrives late', () => {
    const screen = render(<BrowserPane />);
    act(() => {
      useBrowserStore.setState({ lastOpenedUrl: 'https://ry_md_test.md/?locale=ja' });
    });
    expect(screen.queryByTestId('mock-webview')).toBeNull();
  });

  it('restores a valid persisted lastOpenedUrl', () => {
    useBrowserStore.setState({ lastOpenedUrl: 'https://example.com/page' });
    const screen = render(<BrowserPane />);
    expect(webview(screen).props.source).toEqual({ uri: 'https://example.com/page' });
  });
});

describe('BrowserPane URL field theming', () => {
  it('uses the live (light) palette: light field background, dark text — never the near-black border ink', () => {
    // The real preset swap: Object.assign into the live palette + a
    // theme-version bump (what the Settings theme picker does).
    applyThemePreset('case-file');
    const screen = render(<BrowserPane />);
    const input = urlInput(screen);
    const flat = StyleSheet.flatten(input.props.style);
    expect(flat.backgroundColor).toBe('#E8E3D0');
    expect(flat.backgroundColor).not.toBe('#2A2416');
    expect(flat.color).toBe('#201D16');
    expect(input.props.placeholderTextColor).toBe('#6B6450');
  });
});
