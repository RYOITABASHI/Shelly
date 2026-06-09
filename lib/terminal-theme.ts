/**
 * lib/terminal-theme.ts — Terminal ANSI color theme definitions
 *
 * 8 popular themes with full 16-color ANSI palettes.
 * Used by NativeTerminalView for rendering + settings preview.
 */

export type TerminalTheme = {
  name: string;
  label: string;
  background: string;
  foreground: string;
  cursor: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
};

export const TERMINAL_THEMES: Record<string, TerminalTheme> = {
  blue: {
    name: 'blue', label: 'Blue',
    background: '#000000', foreground: '#D6ECF7', cursor: '#1CA9E0',
    black: '#050A0D', red: '#FF5A3C', green: '#2BD9C4', yellow: '#F2B705',
    blue: '#1CA9E0', magenta: '#6FA8D8', cyan: '#5CC8F0', white: '#D6ECF7',
    brightBlack: '#3E5A70', brightRed: '#FF7A60', brightGreen: '#5FF2DF',
    brightYellow: '#FFD84A', brightBlue: '#5CC8F0', brightMagenta: '#9AC7F0',
    brightCyan: '#8BE8FF', brightWhite: '#FFFFFF',
  },
  orange: {
    name: 'orange', label: 'Red',
    background: '#000000', foreground: '#F7DCD6', cursor: '#FF8A00',
    black: '#1A0807', red: '#FF2E1F', green: '#FFB020', yellow: '#FFB800',
    blue: '#FF6A3C', magenta: '#E6504A', cyan: '#FFA060', white: '#F7DCD6',
    brightBlack: '#70504A', brightRed: '#FF5A4A', brightGreen: '#FFD060',
    brightYellow: '#FFD24A', brightBlue: '#FF8A60', brightMagenta: '#FF6A72',
    brightCyan: '#FFC090', brightWhite: '#FFFFFF',
  },
  purple: {
    name: 'purple', label: 'Purple',
    background: '#000000', foreground: '#E8DCF7', cursor: '#39FF14',
    black: '#160B26', red: '#FF3C5A', green: '#39FF14', yellow: '#C8FF3C',
    blue: '#A06FE0', magenta: '#D24FFF', cyan: '#B56CFF', white: '#E8DCF7',
    brightBlack: '#5A4A70', brightRed: '#FF6A7E', brightGreen: '#75FF5A',
    brightYellow: '#DAFF70', brightBlue: '#C19AFF', brightMagenta: '#E38AFF',
    brightCyan: '#C19AFF', brightWhite: '#FFFFFF',
  },
  'scouter-green': {
    name: 'scouter-green', label: 'Green',
    background: '#000000', foreground: '#E6FFEC', cursor: '#00FF41',
    black: '#031108', red: '#FF5555', green: '#39FF14', yellow: '#F1FA8C',
    blue: '#8BE9FD', magenta: '#BD93F9', cyan: '#8BE9FD', white: '#E6FFEC',
    brightBlack: '#2B8A45', brightRed: '#FF6E6E', brightGreen: '#7DFF9F',
    brightYellow: '#FFFFA5', brightBlue: '#A4FFFF', brightMagenta: '#D6ACFF',
    brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
  },
  shelly: {
    name: 'shelly', label: 'Shelly',
    background: '#0A0A0A', foreground: '#E8E8E8', cursor: '#00D4AA',
    black: '#1A1A2E', red: '#FF6B6B', green: '#00D4AA', yellow: '#FFD93D',
    blue: '#6C63FF', magenta: '#CC6FE8', cyan: '#45E3FF', white: '#E8E8E8',
    brightBlack: '#4B5563', brightRed: '#FF8A8A', brightGreen: '#4AEDC4',
    brightYellow: '#FFE566', brightBlue: '#8B83FF', brightMagenta: '#DD8FEE',
    brightCyan: '#6EEBFF', brightWhite: '#FFFFFF',
  },
  dracula: {
    name: 'dracula', label: 'Dracula',
    background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2',
    black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C',
    blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
    brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94',
    brightYellow: '#FFFFA5', brightBlue: '#D6ACFF', brightMagenta: '#FF92DF',
    brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
  },
  nord: {
    name: 'nord', label: 'Nord',
    background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9',
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B',
    blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C',
    brightYellow: '#EBCB8B', brightBlue: '#81A1C1', brightMagenta: '#B48EAD',
    brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
  },
  monokai: {
    name: 'monokai', label: 'Monokai',
    background: '#272822', foreground: '#F8F8F2', cursor: '#F8F8F0',
    black: '#272822', red: '#F92672', green: '#A6E22E', yellow: '#F4BF75',
    blue: '#66D9EF', magenta: '#AE81FF', cyan: '#A1EFE4', white: '#F8F8F2',
    brightBlack: '#75715E', brightRed: '#F92672', brightGreen: '#A6E22E',
    brightYellow: '#F4BF75', brightBlue: '#66D9EF', brightMagenta: '#AE81FF',
    brightCyan: '#A1EFE4', brightWhite: '#F9F8F5',
  },
  tokyo_night: {
    name: 'tokyo_night', label: 'Tokyo Night',
    background: '#1A1B26', foreground: '#A9B1D6', cursor: '#C0CAF5',
    black: '#15161E', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
    blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#A9B1D6',
    brightBlack: '#414868', brightRed: '#F7768E', brightGreen: '#9ECE6A',
    brightYellow: '#E0AF68', brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7',
    brightCyan: '#7DCFFF', brightWhite: '#C0CAF5',
  },
  gruvbox: {
    name: 'gruvbox', label: 'Gruvbox',
    background: '#282828', foreground: '#EBDBB2', cursor: '#EBDBB2',
    black: '#282828', red: '#CC241D', green: '#98971A', yellow: '#D79921',
    blue: '#458588', magenta: '#B16286', cyan: '#689D6A', white: '#A89984',
    brightBlack: '#928374', brightRed: '#FB4934', brightGreen: '#B8BB26',
    brightYellow: '#FABD2F', brightBlue: '#83A598', brightMagenta: '#D3869B',
    brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
  },
  catppuccin: {
    name: 'catppuccin', label: 'Catppuccin',
    background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC',
    black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF',
    blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE',
    brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1',
    brightYellow: '#F9E2AF', brightBlue: '#89B4FA', brightMagenta: '#F5C2E7',
    brightCyan: '#94E2D5', brightWhite: '#A6ADC8',
  },
  solarized: {
    name: 'solarized', label: 'Solarized Dark',
    background: '#002B36', foreground: '#839496', cursor: '#839496',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
    blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#586E75',
    brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4',
    brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
  },
};

const TERMINAL_THEME_ALIASES: Record<string, string> = {
  // Legacy UI preset ids retained in settings should land on the new
  // three-color ANSI palettes instead of the old standalone terminal colors.
  shelly: 'purple',
  modal: 'purple',
  blackline: 'blue',
  silkscreen: 'blue',
  pixel: 'blue',
  mono: 'blue',
};

export function getTerminalTheme(name: string): TerminalTheme {
  const normalized = TERMINAL_THEME_ALIASES[name] ?? name;
  return TERMINAL_THEMES[normalized] ?? TERMINAL_THEMES.blue;
}

export const TERMINAL_THEME_NAMES = Object.keys(TERMINAL_THEMES);
