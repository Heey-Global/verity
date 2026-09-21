// Settings › Knowledge: the one model every project's Wiki maintenance runs on.
//
// The failure this suite exists for is silent scope: the picker used to sit in a
// single project's Knowledge tab while writing a server-wide setting, so the
// screen had to both apply to every project and say so.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import KnowledgeSettingsScreen from '../app/settings/knowledge';
import {
  expectPatchClearsNothing,
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  resetSettingsHarness,
} from './support/settingsHarness';

const MODELS = {
  models: ['claude-opus-4-8', 'claude-haiku-4-5-20251001', 'deepinfra/zai-org/GLM-5.2'],
  modelOrder: ['claude-opus-4-8', 'claude-haiku-4-5-20251001', 'deepinfra/zai-org/GLM-5.2'],
  moreModels: ['deepinfra/zai-org/GLM-5.2'],
  default: 'claude-opus-4-8',
};

function renderScreen(settings = makeSettings()) {
  const updateVeritySettings = jest.fn().mockImplementation((patch: Record<string, unknown>) => {
    expectPatchClearsNothing(patch, settings);
    return Promise.resolve({ ...settings, ...patch });
  });
  mockCreateVerityClient.mockReturnValue(
    makeClient('unlocked', {
      settings,
      updateVeritySettings,
      listModels: jest.fn().mockResolvedValue(MODELS),
    }),
  );
  render(<KnowledgeSettingsScreen />);
  return updateVeritySettings;
}

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('settings/knowledge', () => {
  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<KnowledgeSettingsScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });

  it('pins the chosen model for every project', async () => {
    const update = renderScreen();

    fireEvent.press(await screen.findByLabelText('Use claude-haiku-4-5-20251001'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ knowledgeModel: 'claude-haiku-4-5-20251001' }),
    );
  });

  // The screen must never offer a way back to "no choice". An inherited default
  // is what put every project's Wiki on a model nobody picked, so the absence of
  // that option is the behaviour under guard, not an omission.
  it('offers no automatic option to fall back to', async () => {
    renderScreen();

    await screen.findByLabelText('Use claude-opus-4-8');
    for (const label of [/automatic/i, /default/i, /server default/i]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it('says maintenance is paused until a model is chosen', async () => {
    renderScreen();

    expect(await screen.findByText(/Wiki maintenance stays queued/)).toBeOnTheScreen();
    for (const model of MODELS.models.filter((name) => !MODELS.moreModels.includes(name))) {
      expect(screen.getByLabelText(`Use ${model}`).props.accessibilityState.checked).toBe(false);
    }
  });

  it('marks the pinned model as the current choice', async () => {
    renderScreen(makeSettings({ knowledgeModel: 'claude-opus-4-8' }));

    const pinned = await screen.findByLabelText('Use claude-opus-4-8');
    expect(pinned.props.accessibilityState.checked).toBe(true);
    expect(
      screen.getByLabelText('Use claude-haiku-4-5-20251001').props.accessibilityState.checked,
    ).toBe(false);
    expect(screen.queryByText(/Wiki maintenance stays queued/)).toBeNull();
  });

  // A model the server has stopped offering is still the one maintenance runs
  // on. Dropping it from the list would leave nothing selected, which reads as
  // "not set yet" — and would invite a second, unnecessary choice.
  it('keeps a pinned model visible after the server stops offering it', async () => {
    renderScreen(makeSettings({ knowledgeModel: 'retired/model' }));

    const pinned = await screen.findByLabelText('Use retired/model');
    expect(pinned.props.accessibilityState.checked).toBe(true);
    expect(screen.queryByText(/Wiki maintenance stays queued/)).toBeNull();
  });

  it('says the choice covers every project', async () => {
    renderScreen();

    expect(await screen.findByText(/applies to all projects/)).toBeOnTheScreen();
  });
});
