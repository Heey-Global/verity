import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

it('defaults to the current design and remembers the preview per device', async () => {
  // The preference is module state loaded once; this file holds one case so
  // nothing earlier can have loaded or changed it.
  const { setNewDesignEnabled, useNewDesign } =
    jest.requireActual<typeof import('./homePreferences')>('./homePreferences');
  const { result } = renderHook(() => useNewDesign());
  expect(result.current).toBe(false);
  act(() => setNewDesignEnabled(true));
  expect(result.current).toBe(true);
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem('verity.home.preferences')) ?? '{}')).toEqual({
      inbox: true,
    }),
  );
});
