import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { CPUProfiling } from './CPUProfiling';
import {
  cpuProfilingStatus,
  shareCPUProfile,
  startCPUProfiling,
  stopCPUProfiling,
} from '../../lib/cpuProfiling';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('../../lib/cpuProfiling', () => ({
  cpuProfilingStatus: jest.fn(),
  shareCPUProfile: jest.fn(),
  startCPUProfiling: jest.fn(),
  stopCPUProfiling: jest.fn(),
}));
const capture = {
  recording: false,
  ready: false,
  reason: '',
  error: '',
  captureId: 'one',
  startedAt: 0,
  stoppedAt: 0,
  startedMonotonicUs: 0,
  stoppedMonotonicUs: 0,
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(cpuProfilingStatus).mockResolvedValue({ supported: true, capture });
});
afterEach(() => jest.useRealTimers());
it('keeps the controls hidden in ordinary binaries', async () => {
  jest.mocked(cpuProfilingStatus).mockResolvedValue({ supported: false, capture: null });
  render(<CPUProfiling />);
  await waitFor(() => expect(cpuProfilingStatus).toHaveBeenCalled());
  expect(screen.queryByText('Record CPU activity')).toBeNull();
});
it('reports native start errors and permits a retry', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(startCPUProfiling).mockRejectedValueOnce(new Error('sampler unavailable'));
  render(<CPUProfiling />);
  fireEvent.press(await screen.findByLabelText(/^Record CPU activity(,|$)/));
  await waitFor(() => expect(alert).toHaveBeenCalledWith('CPU profiling', 'sampler unavailable'));
  expect(screen.getByLabelText(/^Record CPU activity(,|$)/)).toBeEnabled();
  alert.mockRestore();
});
it('offers manual stop and observes a native deadline before enabling export', async () => {
  jest.useFakeTimers();
  jest
    .mocked(cpuProfilingStatus)
    .mockResolvedValue({ supported: true, capture: { ...capture, recording: true } });
  render(<CPUProfiling />);
  fireEvent.press(await screen.findByLabelText(/^Stop CPU recording(,|$)/));
  await waitFor(() => expect(stopCPUProfiling).toHaveBeenCalledTimes(1));
  jest.mocked(cpuProfilingStatus).mockResolvedValue({
    supported: true,
    capture: { ...capture, ready: true, reason: 'deadline' },
  });
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await waitFor(() => expect(screen.getByLabelText(/^Export CPU capture(,|$)/)).toBeEnabled());
  fireEvent.press(screen.getByLabelText(/^Export CPU capture(,|$)/));
  await waitFor(() => expect(shareCPUProfile).toHaveBeenCalledTimes(1));
});
