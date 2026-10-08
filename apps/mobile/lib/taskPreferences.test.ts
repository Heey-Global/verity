import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as React from 'react';

function freshPreferences(): typeof import('./taskPreferences') {
  // A fresh module models a cold app start, including failed storage reads.
  jest.doMock('react', () => React);
  jest.doMock('@react-native-async-storage/async-storage', () => AsyncStorage);
  let preferences!: typeof import('./taskPreferences');
  jest.isolateModules(() => {
    preferences = require('./taskPreferences');
  });
  return preferences;
}

it('restores the selected task view and persists the next selection', async () => {
  const { saveTaskPreferences, useTaskPreferences } = freshPreferences();
  jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify({ tab: 'issues' }));
  const { result } = renderHook(() => useTaskPreferences());
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.tab).toBe('issues');
  await act(async () => saveTaskPreferences({ tab: 'agent' }));
  expect(result.current.tab).toBe('agent');
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
    'verity.tasks.preferences',
    expect.any(String),
  );
  const persisted = JSON.parse(jest.mocked(AsyncStorage.setItem).mock.calls.at(-1)![1]);
  // A tab that is only kept in React state is forgotten when the app restarts.
  expect(persisted.tab).toBe('agent');
});

it.each(['unreadable storage', 'malformed JSON'])(
  'settles preference loading with defaults after %s',
  async (failure) => {
    const { saveTaskPreferences, useTaskPreferences } = freshPreferences();
    if (failure === 'unreadable storage')
      jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('Unavailable'));
    else jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce('{invalid');
    const { result } = renderHook(() => useTaskPreferences());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.tab).toBe('mine');
    await act(async () => saveTaskPreferences({ tab: 'agent' }));
    expect(result.current.tab).toBe('agent');
  },
);
