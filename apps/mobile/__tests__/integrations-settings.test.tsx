import type { VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import IntegrationsSettingsScreen from '../app/settings/integrations';
import {
  mockCreateVerityClient,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

const source = {
  accountId: '@verity:example.test',
  sourceId: '!room:example.test',
  displayName: 'Project chat',
  inviter: null,
  projectId: null,
  status: 'pending' as const,
  activatedAt: null,
  lastIngestedAt: null,
  lastError: null,
};

afterEach(() => resetSettingsHarness());

it('configures one Matrix account in Verity Settings', async () => {
  const saveMatrixConfig = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [source] }),
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    saveMatrixConfig,
  } as unknown as VerityClient);
  setSearchParams({});
  render(<IntegrationsSettingsScreen />);

  fireEvent.changeText(
    await screen.findByLabelText('Matrix homeserver URL'),
    'https://matrix.example.test',
  );
  fireEvent.changeText(screen.getByLabelText('Matrix account ID'), '@verity:example.test');
  fireEvent.changeText(screen.getByLabelText('Matrix password'), 'private-password');
  fireEvent.press(screen.getByText('Save Matrix account'));

  await waitFor(() =>
    expect(saveMatrixConfig).toHaveBeenCalledWith({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      password: 'private-password',
    }),
  );
  expect(screen.queryByText('Project chat')).toBeNull();
});

it('assigns an invited room from a project without showing server credentials', async () => {
  const bindIntegrationSource = jest
    .fn()
    .mockResolvedValue({ ...source, projectId: 'project-one', status: 'active' });
  mockCreateVerityClient.mockReturnValue({
    listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [source] }),
    getMatrixConfig: jest.fn().mockResolvedValue(null),
    bindIntegrationSource,
  } as unknown as VerityClient);
  setSearchParams({ projectId: 'project-one' });
  render(<IntegrationsSettingsScreen />);

  fireEvent.press(await screen.findByText('Project chat'));
  await waitFor(() =>
    expect(bindIntegrationSource).toHaveBeenCalledWith(
      source.accountId,
      source.sourceId,
      'project-one',
    ),
  );
  expect(screen.queryByLabelText('Matrix password')).toBeNull();
});
