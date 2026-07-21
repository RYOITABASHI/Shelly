// Unit coverage for the Sidebar RUNNING sub-section's elapsed-time
// formatter. Lives in lib/agent-running-format.ts (not Sidebar.tsx) so this
// test can run in the plain 'unit' jest project (ts-jest/node) without
// mocking the native TerminalEmulator module and the rest of Sidebar.tsx's
// import graph — see that file's own header comment for why.
import { formatElapsedMs } from '@/lib/agent-running-format';

describe('formatElapsedMs (Sidebar RUNNING-row elapsed display)', () => {
  it('renders sub-minute durations as plain seconds', () => {
    expect(formatElapsedMs(0)).toBe('0s');
    expect(formatElapsedMs(999)).toBe('0s'); // floors, doesn't round up
    expect(formatElapsedMs(5_000)).toBe('5s');
    expect(formatElapsedMs(59_000)).toBe('59s');
  });

  it('renders sub-hour durations as MmSSs with zero-padded seconds', () => {
    expect(formatElapsedMs(60_000)).toBe('1m00s');
    expect(formatElapsedMs(65_000)).toBe('1m05s');
    expect(formatElapsedMs(9 * 60_000 + 30_000)).toBe('9m30s');
    expect(formatElapsedMs(59 * 60_000 + 59_000)).toBe('59m59s');
  });

  it('renders hour-plus durations as HhMMm, dropping seconds', () => {
    expect(formatElapsedMs(60 * 60_000)).toBe('1h00m');
    expect(formatElapsedMs(61 * 60_000)).toBe('1h01m');
    expect(formatElapsedMs(2 * 60 * 60_000 + 5 * 60_000)).toBe('2h05m');
  });

  it('clamps negative input to 0s instead of throwing or going negative', () => {
    expect(formatElapsedMs(-1)).toBe('0s');
    expect(formatElapsedMs(-100_000)).toBe('0s');
  });
});
