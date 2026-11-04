import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { completeness, formatReportTime, testName, useHold } from './DiagnosticsParts';

const now = new Date(2026, 10, 4, 21, 30);
const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

it('names a report without a start time instead of showing a raw placeholder', () => {
  expect(formatReportTime(null, now)).toBe('Earlier test');
  expect(formatReportTime('not a date', now)).toBe('Earlier test');
});
it('uses local relative days and drops the year only within the current year', () => {
  expect(formatReportTime(at(2026, 10, 4, 20, 34), now)).toBe('Today, 20:34');
  expect(formatReportTime(at(2026, 10, 3, 8, 5), now)).toBe('Yesterday, 08:05');
  expect(formatReportTime(at(2026, 9, 15, 19, 34), now)).toBe('15 Oct, 19:34');
  expect(formatReportTime(at(2025, 9, 15, 19, 34), now)).toBe('15 Oct 2025, 19:34');
});
it('names exactly the missing sources of an incomplete report', () => {
  const sources = { app: true, core: false, uplink: false };
  expect(completeness({ complete: false, sources })).toBe(
    'Incomplete – Core and Uplink data missing',
  );
  expect(completeness({ complete: false, sources: { app: true, core: true, uplink: true } })).toBe(
    'Incomplete – some details could not be confirmed',
  );
  expect(completeness({ complete: true, sources })).toBe('Complete');
});
it('names report types from older versions instead of rendering undefined', () => {
  expect(testName('quick_test')).toBe('Quick test');
  expect(testName('problem_recording')).toBe('Long test');
  expect(testName('something_older')).toBe('Connection test');
});
it('keeps a hold set while the stored deadline is still being read', async () => {
  const getItem = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .mocked(AsyncStorage.getItem)
    .mockImplementation(async (name: string) => pending.then(() => getItem(name)));
  try {
    const { result } = renderHook(() => useHold('verity.test.hold'));
    // Unread storage holds conservatively.
    expect(result.current[2]()).toBe(true);
    await act(async () => {
      await result.current[1](Date.now() + 40_000);
    });
    // The older stored value (absent here) arrives last and must not shorten it.
    await AsyncStorage.removeItem('verity.test.hold');
    await act(async () => {
      release();
      await pending;
    });
    await waitFor(() => expect(result.current[3]).toBe(true));
    expect(result.current[2]()).toBe(true);
    expect(result.current[0]).toBeGreaterThan(30);
  } finally {
    jest.mocked(AsyncStorage.getItem).mockImplementation(getItem);
  }
});

it('keeps both tests held when the persisted deadline cannot be read', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
  const { result } = renderHook(() => useHold('verity.test.unreadable.hold'));
  await waitFor(() => expect(result.current[3]).toBe(true));
  expect(result.current[2]()).toBe(true);
  expect(result.current[0]).toBeGreaterThan(590);
});
