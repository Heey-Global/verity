import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  resetServerUpdateBannerDismissalForTests,
  serverUpdateBannerFor,
  useServerUpdateBannerDismissal,
} from './serverUpdateBannerDismissal';

beforeEach(async () => {
  await AsyncStorage.clear();
  resetServerUpdateBannerDismissalForTests();
});

describe('server update banner dismissal', () => {
  it('puts away one version and brings the banner back for the next', async () => {
    const { result, rerender } = renderHook(
      ({ version }: { version: string }) => useServerUpdateBannerDismissal('http://a', version),
      { initialProps: { version: '4.54.0' } },
    );
    await waitFor(() => expect(result.current.dismissed).toBe(false));

    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);

    rerender({ version: '4.55.0' });
    expect(result.current.dismissed).toBe(false);
  });

  // A dismissal that only lived in memory would come back on every launch,
  // which is exactly the nagging it is meant to stop.
  it('survives a restart and stays with the server it was made on', async () => {
    const first = renderHook(() => useServerUpdateBannerDismissal('http://a', '4.54.0'));
    await waitFor(() => expect(first.result.current.dismissed).toBe(false));
    act(() => first.result.current.dismiss());
    await waitFor(async () =>
      expect(await AsyncStorage.getItem('verity.serverUpdateBanner.v1.dismissed')).not.toBeNull(),
    );
    first.unmount();
    resetServerUpdateBannerDismissalForTests();

    const same = renderHook(() => useServerUpdateBannerDismissal('http://a', '4.54.0'));
    const other = renderHook(() => useServerUpdateBannerDismissal('http://b', '4.54.0'));
    await waitFor(() => expect(other.result.current.dismissed).toBe(false));
    expect(same.result.current.dismissed).toBe(true);
  });

  it('keeps the banner hidden until storage has answered, then shows it', async () => {
    const { result } = renderHook(() => useServerUpdateBannerDismissal('http://a', '4.54.0'));
    expect(result.current.dismissed).toBe(true);
    await waitFor(() => expect(result.current.dismissed).toBe(false));
  });
});

describe('which banner the overview shows', () => {
  it('shows an ordinary release until its version is dismissed', () => {
    const notice = { version: '4.54.0', problem: false };
    expect(serverUpdateBannerFor(notice, false)).toEqual({
      version: '4.54.0',
      problem: false,
      dismissible: true,
    });
    expect(serverUpdateBannerFor(notice, true)).toBeNull();
    expect(serverUpdateBannerFor(null, false)).toBeNull();
  });

  // Dismissing a version must not also hide that the update to it broke.
  it('keeps a problem on screen even for a dismissed version', () => {
    expect(serverUpdateBannerFor({ version: '4.54.0', problem: true }, true)).toEqual({
      version: '4.54.0',
      problem: true,
      dismissible: false,
    });
  });
});
