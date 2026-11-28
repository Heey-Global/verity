// The server's machine at a glance, last on Home. Observed: a
// data disk filled over two weeks with nothing on screen until the server
// stopped; the reading here is what shows it coming.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { VerityApiError, type HostResources as Resources } from '@verity/mobile';

const mockGetHostResources = jest.fn<Promise<Resources>, []>();
jest.mock('../lib/client', () => ({
  createVerityClient: () => ({ getHostResources: mockGetHostResources }),
}));

import { HISTORY_SLOTS, HostResources } from '../components/home/HostResources';

const GiB = 1024 ** 3;
const reading = (overrides: Partial<Resources> = {}): Resources => ({
  observedAt: '2026-11-27T15:00:00.000Z',
  cpu: { percent: 12, cores: 4 },
  memory: { usedBytes: 2.2 * GiB, totalBytes: 7.7 * GiB },
  disk: { usedBytes: 419 * GiB, totalBytes: 465 * GiB },
  ...overrides,
});

it('shows CPU, memory and disk with their sizes', async () => {
  render(<HostResources load={() => Promise.resolve(reading())} />);
  expect(await screen.findByText('Server')).toBeOnTheScreen();
  expect(screen.getByText('CPU · 4 cores')).toBeOnTheScreen();
  expect(screen.getByText('RAM · 2.2 / 7.7 GB')).toBeOnTheScreen();
  expect(screen.getByText('Disk · 419.0 / 465.0 GB')).toBeOnTheScreen();
  expect(screen.getByText('12%')).toBeOnTheScreen();
  expect(screen.getByText('29%')).toBeOnTheScreen();
  expect(screen.getByText('90%')).toBeOnTheScreen();
});

it('leaves out what the server cannot measure', async () => {
  render(
    <HostResources
      load={() => Promise.resolve(reading({ cpu: { percent: null, cores: 4 }, disk: null }))}
    />,
  );
  expect(await screen.findByText('CPU · 4 cores')).toBeOnTheScreen();
  expect(screen.getByText('–')).toBeOnTheScreen();
  expect(screen.queryByTestId('host-disk')).not.toBeOnTheScreen();
});

// The strips are the point of the CPU and memory meters: each reading must add
// a bar, and the strip must stop at its slots rather than grow off the card.
it('collects one bar per reading and keeps only the last slots', async () => {
  jest.useFakeTimers();
  try {
    let n = 0;
    const load = jest.fn(() => Promise.resolve(reading({ cpu: { percent: ++n, cores: 4 } })));
    render(<HostResources load={load} intervalMs={1000} />);
    const filled = () => screen.queryAllByTestId('host-cpu-bar').length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    expect(filled()).toBe(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000 * (HISTORY_SLOTS + 5));
    });
    expect(filled()).toBe(HISTORY_SLOTS);
  } finally {
    jest.useRealTimers();
  }
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
    expect(screen.getByText('12%')).toBeOnTheScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText('55%')).toBeOnTheScreen();
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
    expect(screen.getByText('12%')).toBeOnTheScreen();
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
    expect(screen.getByText('12%')).toBeOnTheScreen();
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
