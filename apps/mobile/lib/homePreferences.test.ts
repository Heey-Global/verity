import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

it('defaults to the current Home and remembers the preview per device', async () => {
  // A fresh module per case: the preference is module state loaded once.
  const { setHomeInboxEnabled, useHomePreferences } =
    jest.requireActual<typeof import('./homePreferences')>('./homePreferences');
  const { result } = renderHook(() => useHomePreferences());
  expect(result.current.inbox).toBe(false);
  act(() => setHomeInboxEnabled(true));
  expect(result.current.inbox).toBe(true);
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem('verity.home.preferences')) ?? '{}')).toEqual({
      inbox: true,
    }),
  );
});
