import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import AgentScheduleReadinessCard from '@/components/panes/AgentScheduleReadinessCard';

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    colors: {
      accent: '#00ff00',
      background: '#000000',
      border: '#333333',
      foreground: '#ffffff',
      inactive: '#666666',
      muted: '#999999',
      success: '#00cc66',
      surface: '#111111',
      surfaceHigh: '#111111',
      warning: '#ffcc00',
    },
  }),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockCanScheduleExactAlarms = jest.fn();
const mockRequestScheduleExactAlarm = jest.fn();
const mockIsIgnoringBatteryOptimizations = jest.fn();
const mockRequestBatteryOptimizationExemption = jest.fn();

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    canScheduleExactAlarms: (...args: unknown[]) => mockCanScheduleExactAlarms(...args),
    requestScheduleExactAlarm: (...args: unknown[]) => mockRequestScheduleExactAlarm(...args),
    isIgnoringBatteryOptimizations: (...args: unknown[]) => mockIsIgnoringBatteryOptimizations(...args),
    requestBatteryOptimizationExemption: (...args: unknown[]) => mockRequestBatteryOptimizationExemption(...args),
  },
}));

jest.mock('@/lib/process-guard', () => ({
  getDeviceProfile: jest.fn(() => ({ androidVersion: 34, manufacturer: 'unknown', fixSteps: [] })),
}));

describe('AgentScheduleReadinessCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanScheduleExactAlarms.mockResolvedValue(true);
    mockIsIgnoringBatteryOptimizations.mockResolvedValue(true);
  });

  it('renders without throwing while native checks are pending', () => {
    mockCanScheduleExactAlarms.mockReturnValue(new Promise(() => undefined));
    mockIsIgnoringBatteryOptimizations.mockReturnValue(new Promise(() => undefined));
    expect(() => render(<AgentScheduleReadinessCard onDismiss={jest.fn()} />)).not.toThrow();
  });

  it('shows a Grant action for exact-alarm scheduling when not granted, and fires the request on tap', async () => {
    mockCanScheduleExactAlarms.mockResolvedValue(false);
    const { getByText } = render(<AgentScheduleReadinessCard onDismiss={jest.fn()} />);

    const grantBtn = await waitFor(() => getByText('schedulereadiness.exact_alarm_action'));
    fireEvent.press(grantBtn);
    expect(mockRequestScheduleExactAlarm).toHaveBeenCalledTimes(1);
  });

  it('shows an Exempt action for battery optimization when not exempted, and fires the request on tap', async () => {
    mockIsIgnoringBatteryOptimizations.mockResolvedValue(false);
    const { getByText } = render(<AgentScheduleReadinessCard onDismiss={jest.fn()} />);

    const exemptBtn = await waitFor(() => getByText('schedulereadiness.battery_action'));
    fireEvent.press(exemptBtn);
    expect(mockRequestBatteryOptimizationExemption).toHaveBeenCalledTimes(1);
  });

  it('does not show either action button once both checks resolve granted', async () => {
    const { queryByText, findByText } = render(<AgentScheduleReadinessCard onDismiss={jest.fn()} />);
    await findByText('schedulereadiness.exact_alarm_ok');
    expect(queryByText('schedulereadiness.exact_alarm_action')).toBeNull();
    expect(queryByText('schedulereadiness.battery_action')).toBeNull();
  });

  it('calls onDismiss when the dismiss button is pressed', async () => {
    const onDismiss = jest.fn();
    const { getByText } = render(<AgentScheduleReadinessCard onDismiss={onDismiss} />);
    fireEvent.press(getByText('schedulereadiness.dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not show Samsung-specific guidance on a non-Samsung device', () => {
    const { queryByText } = render(<AgentScheduleReadinessCard onDismiss={jest.fn()} />);
    expect(queryByText('schedulereadiness.samsung_title')).toBeNull();
  });
});

describe('AgentScheduleReadinessCard on a Samsung device', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanScheduleExactAlarms.mockResolvedValue(true);
    mockIsIgnoringBatteryOptimizations.mockResolvedValue(true);
    const { getDeviceProfile } = jest.requireMock('@/lib/process-guard') as { getDeviceProfile: jest.Mock };
    getDeviceProfile.mockReturnValue({
      androidVersion: 34,
      manufacturer: 'samsung',
      fixSteps: [{
        title: 'Samsung battery optimization',
        titleJa: '',
        description: '',
        descriptionJa: '',
        intentUri: 'android.settings.BATTERY_SAVER_SETTINGS',
      }],
    });
  });

  it('shows the Samsung sleeping-apps guidance (informational, no programmatic check)', () => {
    const { getByText } = render(<AgentScheduleReadinessCard onDismiss={jest.fn()} />);
    expect(getByText('schedulereadiness.samsung_title')).toBeTruthy();
    expect(getByText('schedulereadiness.samsung_action')).toBeTruthy();
  });
});
