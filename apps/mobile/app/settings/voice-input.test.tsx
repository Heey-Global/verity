import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('../../components/settings/SettingsChrome', () => ({
  SettingsScaffold: ({ children }: { children: React.ReactNode }) => children,
}));
import VoiceInputSettings from './voice-input';
import { loadVoiceVocabulary, saveVoiceVocabulary } from '../../lib/voiceVocabulary';

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});
test('edits terms, explicit variants and disabled correction locally', async () => {
  render(<VoiceInputSettings />);
  await waitFor(() => expect(screen.getByLabelText('Voice vocabulary').props.editable).toBe(true));
  fireEvent.changeText(screen.getByLabelText('Voice vocabulary'), 'Example | sample');
  fireEvent(screen.getByLabelText('Correct finalized dictation'), 'valueChange', false);
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Saved on this device.');
  expect(await loadVoiceVocabulary()).toEqual({
    enabled: false,
    terms: [{ term: 'Example', aliases: ['sample'] }],
  });
  expect(screen.getByText(/currently ignores vocabulary hints/)).toBeTruthy();
});
test('rejects more than 100 entries without replacing saved terms', async () => {
  const saved = { enabled: true, terms: [{ term: 'Example', aliases: [] }] };
  await saveVoiceVocabulary(saved);
  render(<VoiceInputSettings />);
  await waitFor(() => expect(screen.getByLabelText('Voice vocabulary').props.editable).toBe(true));
  fireEvent.changeText(
    screen.getByLabelText('Voice vocabulary'),
    Array.from({ length: 101 }, () => 'Sample').join('\n'),
  );
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Use at most 100 terms.');
  expect(await loadVoiceVocabulary()).toEqual(saved);
});
test('failed persistence does not claim success and allows a retry', async () => {
  render(<VoiceInputSettings />);
  await waitFor(() => expect(screen.getByLabelText('Voice vocabulary').props.editable).toBe(true));
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Storage unavailable'));
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Storage unavailable');
  expect(screen.queryByText('Saved on this device.')).toBeNull();
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Saved on this device.');
});
