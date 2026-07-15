jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import { BOOT_AUTOSTART_ENABLED } from '@/lib/boot-autostart';

describe('BOOT-AUTOSTART production default (P0-2)', () => {
  it('ships enabled on the TS side (the native flag is independently default-true)', () => {
    expect(BOOT_AUTOSTART_ENABLED).toBe(true);
  });
});
