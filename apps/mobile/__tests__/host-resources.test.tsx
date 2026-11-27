// The server's machine at a glance below the Home project list. Observed: a
// data disk filled over two weeks with nothing on screen until the server
// stopped; the reading here is what shows it coming.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { HostResources as Resources } from '@verity/mobile';

jest.mock('../lib/client', () => ({ createVerityClient: () => null }));

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
    const load = jest.fn(() => Promise.reject(new Error('403')));
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
