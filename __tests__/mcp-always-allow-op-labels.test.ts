/**
 * Every always-allow op has a label in both locales: the settings list
 * renders t(`mcp_always_allow.op.${op}`), so a missing key shows the raw key.
 */
import { TYPED_OPS } from '@/lib/mcp-always-allow';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

describe('always-allow op labels', () => {
  it.each([...TYPED_OPS])('%s has en and ja labels', (op) => {
    const key = `mcp_always_allow.op.${op}`;
    expect((en as Record<string, string>)[key]).toBeTruthy();
    expect((ja as Record<string, string>)[key]).toBeTruthy();
  });
});
