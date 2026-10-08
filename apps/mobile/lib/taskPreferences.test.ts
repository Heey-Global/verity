import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { saveTaskPreferences, useTaskPreferences } from './taskPreferences';

it('restores the selected task view and persists the next selection', async () => {
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
