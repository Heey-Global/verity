// The server's machine at a glance below the Home project list. Observed: a
// data disk filled over two weeks with nothing on screen until the server
// stopped; the reading here is what shows it coming.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { VerityApiError, type HostResources as Resources } from '@verity/mobile';

const mockGetHostResources = jest.fn<Promise<Resources>, []>();
jest.mock('../lib/client', () => ({
  createVerityClient: () => ({ getHostResources: mockGetHostResources }),
}));

import { HostResources, hostResourcesSummary } from '../components/home/HostResources';

const GiB = 1024 ** 3;
const reading = (overrides: Partial<Resources> = {}): Resources => ({
  observedAt: '2026-11-27T15:00:00.000Z',
  cpu: { percent: 12, cores: 4 },
  memory: { usedBytes: 2.2 * GiB, totalBytes: 7.7 * GiB },
  disk: { usedBytes: 419 * GiB, totalBytes: 465 * GiB },
  ...overrides,
});

it('summarises CPU, memory and disk and details them on tap', async () => {
  render(<HostResources load={() => Promise.resolve(reading())} />);
  expect(await screen.findByText('CPU 12 % · RAM 29 % · Disk 90 %')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Server'));
  expect(screen.getByText('12 % · 4 cores')).toBeOnTheScreen();
  expect(screen.getByText('29 % · 2.2 GB of 7.7 GB')).toBeOnTheScreen();
  expect(screen.getByText('90 % · 419.0 GB of 465.0 GB')).toBeOnTheScreen();
});

it('leaves out what the server cannot measure', () => {
  expect(hostResourcesSummary(reading({ cpu: { percent: null, cores: 4 }, disk: null }))).toBe(
    'CPU – · RAM 29 %',
  );
});

// A member who is not an administrator is refused; asking every 15 seconds for
// a screen they will never see would only cost battery.
it('shows nothing and stops asking when the server refuses', async () => {
  jest.useFakeTimers();
  try {
    const load = jest.fn(() =>
      Promise.reject(new VerityApiError(403, 'Administrator access required')),
    );
    render(<HostResources load={load} intervalMs={1000} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText('Server')).not.toBeOnTheScreen();
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it('keeps the last reading through a failed refresh and keeps refreshing', async () => {
  jest.useFakeTimers();
  try {
    const load = jest
      .fn<Promise<Resources>, []>()
      .mockResolvedValueOnce(reading())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reading({ cpu: { percent: 55, cores: 4 } }));
    render(<HostResources load={load} intervalMs={1000} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText('CPU 12 % · RAM 29 % · Disk 90 %')).toBeOnTheScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText('CPU 55 % · RAM 29 % · Disk 90 %')).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

// A default loader created per render restarted the polling effect after each
// reading, so the 15-second refresh became back-to-back requests.
it('asks the active server once per interval with the default loader', async () => {
  jest.useFakeTimers();
  try {
    mockGetHostResources.mockReset().mockResolvedValue(reading());
    render(<HostResources intervalMs={1000} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText('CPU 12 % · RAM 29 % · Disk 90 %')).toBeOnTheScreen();
    expect(mockGetHostResources).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});

// A server still starting up, or a dropped connection, must not end the
// display for the rest of the visit; only a refusal does.
it('retries a failure before the first reading', async () => {
  jest.useFakeTimers();
  try {
    const load = jest
      .fn<Promise<Resources>, []>()
      .mockRejectedValueOnce(new VerityApiError(503, 'Starting'))
      .mockResolvedValue(reading());
    render(<HostResources load={load} intervalMs={1000} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText('CPU 12 % · RAM 29 % · Disk 90 %')).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

// Administrator rights can be withdrawn while the screen is open; the last
// figures must not stay up, refreshed by nothing.
it('drops the reading and stops when a later refresh is refused', async () => {
  jest.useFakeTimers();
  try {
    const load = jest
      .fn<Promise<Resources>, []>()
      .mockResolvedValueOnce(reading())
      .mockRejectedValue(new VerityApiError(403, 'Administrator access required'));
    render(<HostResources load={load} intervalMs={1000} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText('Server')).not.toBeOnTheScreen();
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
