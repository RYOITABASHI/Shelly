/**
 * Z Fold6 cover-screen right-edge clipping (2026-10-08).
 *
 * Cover display: 968px @ density 464dpi -> 968 / 2.9 ~= 333dp wide, i.e. the
 * "compact" layout. Non-wide layouts no longer dock the 38dp sidebar rail
 * (it is an overlay drawer), so the terminal pane is 333 - 2 (pane borders)
 * = 331dp and the CommandKeyBar's paging viewport is
 * 331 - 2*28 (attach/mic) - 19 (dots) = 256dp, still below the keys' natural
 * 274dp. (With the old rail it was 218dp; with the drawer-less expanded
 * sidebar even less.) These tests pin that nothing in the compact chrome
 * demands more horizontal space than the screen provides.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';

const COVER_WIDTH = 333;
const COVER_PANE_WIDTH = COVER_WIDTH - 2; // no docked rail on compact
const COVER_KEYBAR_VIEWPORT = COVER_PANE_WIDTH - 2 * 28 - 19; // 256
const OLD_RAIL_KEYBAR_VIEWPORT = 218;

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@/hooks/use-pane-voice', () => ({
  usePaneVoice: () => ({
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    isRecording: false,
    isTranscribing: false,
  }),
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => '') }));
jest.mock('@/hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({
    isLandscape: false,
    isWide: false,
    isCompact: true,
    useSplitLayout: false,
    width: 333,
    height: 819,
    fontSize: 13,
    terminalFlex: 2.5,
    isFoldInner: false,
    isFoldOuter: true,
  }),
}));
// Heavy modal children of AgentBar are irrelevant to the bar's own row width.
jest.mock('@/components/layout/SettingsDropdown', () => ({ SettingsDropdown: () => null }));
jest.mock('@/components/layout/BuildsModal', () => ({
  BuildsModal: () => null,
  buildStatusColor: () => '#888',
  fetchUpdateAvailabilityStatus: jest.fn(async () => 'unknown'),
}));
jest.mock('@/components/layout/RecentLogsModal', () => ({ RecentLogsModal: () => null }));
jest.mock('@/components/multi-pane/LayoutAddSheet', () => ({ LayoutAddSheet: () => null }));
// Two open panes (TERMINAL + AI CHAT) so the pane-tab strip renders, as in the
// product-owner report.
jest.mock('@/hooks/use-multi-pane', () => {
  const state = {
    slots: [{ id: 'p1', tab: 'terminal' }, { id: 'p2', tab: 'ai' }, null, null],
    focusedSlot: 0,
    maximizedSlot: null,
    preset: 'p1',
  };
  return {
    PRESET_CAPACITY: { p1: 1, p2h: 2, p2v: 2, p3l: 3, p4: 4 },
    useMultiPaneStore: Object.assign((sel: (s: any) => any) => sel(state), {
      getState: () => state,
    }),
  };
});

import { CommandKeyBar, KEY_PAGE_NATURAL_MIN_WIDTH } from '@/components/terminal/CommandKeyBar';
import PaneInputBar from '@/components/panes/PaneInputBar';

const flat = (style: unknown): any => StyleSheet.flatten(style as any) ?? {};

function isPage(node: any): boolean {
  const s = flat(node?.props?.style);
  return s.flexDirection === 'row' && typeof s.width === 'number';
}

function renderKeyBarAt(viewport: number) {
  render(
    <CommandKeyBar
      sendKey={jest.fn()}
      sendText={jest.fn()}
      onAttach={jest.fn()}
      onVoice={jest.fn()}
      isCompact
    />,
  );
  const scroll = screen.UNSAFE_getByType(ScrollView);
  fireEvent(scroll.parent!, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: viewport, height: 52 } },
  });
  // Every key's host node carries the resolved key style (with minWidth).
  const enterHost = screen.getAllByLabelText('Enter')[0];
  let page: any = enterHost;
  while (page && !isPage(page)) page = page.parent;
  const keyHosts = screen
    .getAllByRole('button')
    .filter((n: any) => {
      let p: any = n.parent;
      while (p && !isPage(p)) p = p.parent;
      return p === page;
    });
  return { page, keyHosts };
}

/** Minimum width a row of keys can occupy given their resolved styles. */
function minRowWidth(page: any, keyHosts: any[]): number {
  const row = flat(page.props.style);
  const gap = Number(row.gap ?? 0);
  const padX = Number(row.paddingHorizontal ?? 0) * 2;
  const mins = keyHosts.map((k) => Number(flat(k.props.style).minWidth ?? 0));
  return mins.reduce((a, b) => a + b, 0) + gap * (keyHosts.length - 1) + padX;
}

describe('CommandKeyBar on the Fold6 cover screen', () => {
  it('natural key set needs 274dp, wider than the 256dp cover viewport', () => {
    expect(COVER_KEYBAR_VIEWPORT).toBe(256);
    expect(KEY_PAGE_NATURAL_MIN_WIDTH).toBe(274);
    expect(KEY_PAGE_NATURAL_MIN_WIDTH).toBeGreaterThan(COVER_KEYBAR_VIEWPORT);
  });

  it.each([COVER_KEYBAR_VIEWPORT, OLD_RAIL_KEYBAR_VIEWPORT, 200, 180])('fits every key inside a %idp viewport', (vp) => {
    const { page, keyHosts } = renderKeyBarAt(vp);
    expect(flat(page.props.style).width).toBe(vp);
    expect(keyHosts).toHaveLength(7);
    expect(minRowWidth(page, keyHosts)).toBeLessThanOrEqual(vp);
  });

  it('keeps the natural 36dp keys when the viewport is wide enough (standard/wide unchanged)', () => {
    const { page, keyHosts } = renderKeyBarAt(512);
    expect(minRowWidth(page, keyHosts)).toBe(KEY_PAGE_NATURAL_MIN_WIDTH);
  });
});

describe('PaneInputBar at cover width', () => {
  it('lets the composer input shrink (minWidth 0) so attach/mic/send stay on screen', () => {
    render(
      <View style={{ width: COVER_PANE_WIDTH }}>
        <PaneInputBar onSubmit={() => {}} onAttach={() => {}} />
      </View>,
    );
    const s = flat(screen.UNSAFE_getByType(TextInput).props.style);
    expect(s.flex).toBe(1);
    expect(s.minWidth).toBe(0);
  });
});

/** Host (string-typed) descendants directly below `node`, skipping composites. */
function hostChildren(node: any): any[] {
  const out: any[] = [];
  for (const c of (node.children as any[]) ?? []) {
    if (typeof c !== 'object') continue;
    if (typeof c.type === 'string') out.push(c);
    else out.push(...hostChildren(c));
  }
  return out;
}

describe('AgentBar fixed chrome in compact mode', () => {
  it('leaves room for the pane tabs inside 333dp (and 300dp)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentBar } = require('@/components/layout/AgentBar');
    const { UNSAFE_root } = render(<AgentBar />);
    // The bar is the first host View with a row direction and fixed height.
    const bar = UNSAFE_root.findAll(
      (n: any) => typeof n.type === 'string' && flat(n.props.style).flexDirection === 'row'
        && typeof flat(n.props.style).height === 'number',
    )[0];
    let fixed = 0;
    let sawScroller = false;
    for (const child of hostChildren(bar)) {
      const s = flat(child.props?.style);
      const margins = Number(s.marginLeft ?? 0) + Number(s.marginRight ?? 0);
      if (s.flex === 1) {
        // Pane-tab scroller: grows into the leftover space; only margins are fixed.
        sawScroller = true;
        fixed += margins;
        continue;
      }
      if (typeof s.width === 'number') {
        fixed += s.width + margins;
        continue;
      }
      if (s.flexDirection === 'row') {
        // Right-hand icon cluster: each button = 16dp glyph + 2 x 4dp padding.
        const buttons = hostChildren(child);
        fixed += buttons.length * 24 + Number(s.gap ?? 0) * (buttons.length - 1)
          + Number(s.paddingRight ?? 0) + Number(s.paddingLeft ?? 0);
        continue;
      }
      // Logo: estimate the "Shelly" wordmark at 0.62em per mono cell.
      const text = child.findAllByType(Text)[0];
      if (text && typeof text.props.children === 'string') {
        const ts = flat(text.props.style);
        const textW = text.props.children.length * Number(ts.fontSize ?? 13) * 0.62;
        const padX = Number(s.paddingHorizontal ?? 0) * 2;
        fixed += Math.max(Number(s.minWidth ?? 0), textW + padX) + margins;
      }
    }
    expect(sawScroller).toBe(true);
    // Before the fix the fixed chrome was ~239dp (logo 69 + "+" 36 + tab
    // margins 12 + icons 122), leaving ~94dp for the pane tabs and nothing
    // once the running-agents chip (~72dp) appeared. Keep >= 90dp for the
    // tabs/chip even on a 300dp screen.
    expect(fixed).toBeLessThanOrEqual(210);
    expect(300 - fixed).toBeGreaterThanOrEqual(90);
  });
});

describe('Sidebar on non-wide layouts (CLAUDE.md: hidden + swipe)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useSidebarStore, resolveEffectiveSidebarMode } = require('@/store/sidebar-store');

  beforeEach(() => {
    useSidebarStore.setState({ mode: 'icons', drawerOpen: false });
  });

  it('resolves to hidden (no docked rail) unless the drawer is open', () => {
    for (const persisted of ['icons', 'expanded', 'hidden'] as const) {
      expect(resolveEffectiveSidebarMode(persisted, false, false)).toBe('hidden');
      expect(resolveEffectiveSidebarMode(persisted, false, true)).toBe('expanded');
      // Wide layouts keep honouring the persisted preference.
      expect(resolveEffectiveSidebarMode(persisted, true, false)).toBe(persisted);
      expect(resolveEffectiveSidebarMode(persisted, true, true)).toBe(persisted);
    }
  });

  it('showSidebar opens the drawer on non-wide without rewriting the wide preference', () => {
    useSidebarStore.getState().showSidebar(false);
    expect(useSidebarStore.getState().drawerOpen).toBe(true);
    expect(useSidebarStore.getState().mode).toBe('icons');
    useSidebarStore.getState().showSidebar(true);
    expect(useSidebarStore.getState().mode).toBe('expanded');
  });

  it('AgentBar compact shows a menu button that opens the drawer', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentBar } = require('@/components/layout/AgentBar');
    render(<AgentBar />);
    expect(screen.queryByText('Shelly')).toBeNull(); // wordmark yields its slot
    fireEvent.press(screen.getByTestId('agentbar-open-sidebar'));
    expect(useSidebarStore.getState().drawerOpen).toBe(true);
    expect(useSidebarStore.getState().mode).toBe('icons');
  });
});
