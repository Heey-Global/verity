import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import ProjectServicesScreen from '../app/project/[id]/settings/services';
import { dopplerBinding, dopplerConnection, makeClient } from './support/projectHarness';
import {
  mockCreateVerityClient,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('project Doppler settings', () => {
  it('lets a member connect, replace and disconnect tokens without managing bindings', async () => {
    const platform = {
      connectionId: 'platform',
      label: 'Platform',
      bindings: ['portal/prd'],
      connected: true,
      updatedAt: null,
      usesInstanceToken: false,
    };
    const payments = {
      connectionId: 'payments',
      label: 'Payments',
      bindings: ['billing/dev'],
      connected: false,
      updatedAt: null,
      usesInstanceToken: false,
    };
    let tokens = [platform, payments];
    const personalTokens = jest.fn(async () => ({ canManageBindings: false, connections: tokens }));
    const connectPersonalToken = jest.fn(async (_id: string, connectionId: string) => {
      tokens = tokens.map((entry) =>
        entry.connectionId === connectionId ? { ...entry, connected: true } : entry,
      );
      return personalTokens();
    });
    const disconnectPersonalToken = jest.fn(async (_id: string, connectionId: string) => {
      tokens = tokens.map((entry) =>
        entry.connectionId === connectionId ? { ...entry, connected: false } : entry,
      );
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        doppler: {
          listBindings: jest.fn().mockResolvedValue([
            dopplerBinding(),
            dopplerBinding({
              id: 'b2',
              connectionId: 'payments',
              connectionLabel: 'Payments',
              dopplerProject: 'billing',
              dopplerConfig: 'dev',
              isDefault: false,
            }),
          ]),
          personalTokens,
          disconnectPersonalToken,
          connectPersonalToken,
        },
      }),
    );
    setSearchParams({ id: 'p/1', section: 'doppler' });
    render(<ProjectServicesScreen />);

    expect(await screen.findByText('Your token connected')).toBeOnTheScreen();
    expect(screen.getByText('Connect your token')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Add binding/)).toBeNull();
    expect(screen.queryByLabelText(/^Manage portal/)).toBeNull();

    fireEvent.press(screen.getByLabelText(/^Payments.*Connect your token/));
    fireEvent.changeText(await screen.findByLabelText(/^Your Doppler token/), 'dp.st.billing');
    fireEvent.press(screen.getByLabelText(/^Validate and connect/));
    await waitFor(() =>
      expect(connectPersonalToken).toHaveBeenCalledWith('p/1', 'payments', 'dp.st.billing'),
    );

    fireEvent.press(await screen.findByLabelText(/^Platform.*Your token connected/));
    fireEvent.changeText(await screen.findByLabelText(/^New Doppler token/), 'dp.st.replacement');
    fireEvent.press(screen.getByLabelText(/^Validate and replace/));
    await waitFor(() =>
      expect(connectPersonalToken).toHaveBeenCalledWith('p/1', 'platform', 'dp.st.replacement'),
    );

    fireEvent.press(await screen.findByLabelText(/^Platform.*Your token connected/));
    fireEvent.press(await screen.findByLabelText(/^Disconnect token/));
    await waitFor(() => expect(disconnectPersonalToken).toHaveBeenCalledWith('p/1', 'platform'));
    expect(await screen.findByLabelText(/^Platform.*Connect your token/)).toBeOnTheScreen();
  });

  it.each(['single', 'multiple', 'same labels'])('adds a binding with %s', async (scenario) => {
    const multiple = scenario !== 'single';
    const connectionId = multiple ? 'payments' : 'platform';
    const listConnections = jest.fn().mockResolvedValue(
      multiple
        ? [
            dopplerConnection(),
            dopplerConnection({
              id: 'payments',
              label: scenario === 'same labels' ? 'Platform' : 'Payments',
              workplaceName: 'Northstar Finance',
            }),
          ]
        : [dopplerConnection()],
    );
    const addBinding = jest.fn().mockResolvedValue(dopplerBinding({ id: 'b2', isDefault: false }));
    const listDopplerProjects = jest
      .fn()
      .mockResolvedValue({ projects: [{ slug: 'billing', name: 'Billing' }] });
    const listDopplerConfigs = jest.fn().mockResolvedValue({ configs: [{ name: 'dev' }] });
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        listDopplerProjects,
        listDopplerConfigs,
        doppler: { addBinding, listConnections },
      }),
    );
    setSearchParams({ id: 'p/1', section: 'doppler' });
    render(<ProjectServicesScreen />);

    fireEvent.press(await screen.findByLabelText(/^Add binding(,|$)/));
    if (multiple) {
      const payments = await screen.findByLabelText(
        scenario === 'same labels' ? 'Platform · Northstar Finance' : 'Payments',
      );
      expect(listDopplerProjects).not.toHaveBeenCalled();
      fireEvent.press(payments);
    }
    await waitFor(() => expect(listDopplerProjects).toHaveBeenCalledWith(connectionId));
    fireEvent.press(await screen.findByLabelText(/^billing(,|$)/));
    await waitFor(() => expect(listDopplerConfigs).toHaveBeenCalledWith('billing', connectionId));
    fireEvent.press(await screen.findByLabelText(/^dev(,|$)/));
    expect(
      await screen.findByText('Agents write secrets as billing/dev/API_KEY'),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getAllByLabelText(/^Add binding(,|$)/).at(-1)!);
    await waitFor(() =>
      expect(addBinding).toHaveBeenCalledWith('p/1', {
        connectionId,
        dopplerProject: 'billing',
        dopplerConfig: 'dev',
      }),
    );
  });

  it('can recover binding management after a failed token status request', async () => {
    const personalTokens = jest
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ connections: [], canManageBindings: true });
    mockCreateVerityClient.mockReturnValue(makeClient({ doppler: { personalTokens } }));
    setSearchParams({ id: 'p/1', section: 'doppler' });
    render(<ProjectServicesScreen />);

    expect(await screen.findByText('Could not load your Doppler tokens.')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Add binding/)).toBeNull();
    fireEvent.press(screen.getByLabelText(/^Retry loading tokens/));
    expect(await screen.findByLabelText(/^Add binding/)).toBeOnTheScreen();
  });

  it('retries project and config requests for the selected connection', async () => {
    const listDopplerProjects = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ projects: [{ slug: 'portal', name: 'Portal' }] });
    const listDopplerConfigs = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ configs: [{ name: 'prd' }] });
    mockCreateVerityClient.mockReturnValue(makeClient({ listDopplerProjects, listDopplerConfigs }));
    setSearchParams({ id: 'p/1', section: 'doppler' });
    render(<ProjectServicesScreen />);

    fireEvent.press(await screen.findByLabelText(/^Add binding/));
    expect(await screen.findByText('Could not load Doppler projects')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText(/^Retry/));
    fireEvent.press(await screen.findByLabelText(/^portal(,|$)/));
    expect(await screen.findByText('Could not load Doppler configs')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText(/^Retry/));
    expect(await screen.findByLabelText(/^prd(,|$)/)).toBeOnTheScreen();
    expect(listDopplerProjects).toHaveBeenLastCalledWith('platform');
    expect(listDopplerConfigs).toHaveBeenLastCalledWith('portal', 'platform');
  });

  it('sets another binding as the default and removes one after confirming', async () => {
    const setDefaultBinding = jest.fn().mockResolvedValue([]);
    const removeBinding = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        doppler: {
          listBindings: jest
            .fn()
            .mockResolvedValue([
              dopplerBinding(),
              dopplerBinding({ id: 'b2', dopplerConfig: 'stg', isDefault: false }),
            ]),
          setDefaultBinding,
          removeBinding,
        },
      }),
    );
    setSearchParams({ id: 'p/1', section: 'doppler' });
    render(<ProjectServicesScreen />);

    fireEvent.press(await screen.findByLabelText(/^Manage portal\/stg(,|$)/));
    expect(
      screen.getByText('Agents then write API_KEY instead of portal/stg/API_KEY'),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText(/^Set as default/));
    await waitFor(() => expect(setDefaultBinding).toHaveBeenCalledWith('p/1', 'b2'));

    fireEvent.press(await screen.findByLabelText(/^Manage portal\/prd(,|$)/));
    // The default has nothing to become.
    expect(screen.queryByLabelText(/^Set as default/)).toBeNull();
    fireEvent.press(screen.getByLabelText(/^Remove binding(,|$)/));
    expect(
      await screen.findByText(/The oldest remaining binding becomes the default/),
    ).toBeOnTheScreen();
    expect(removeBinding).not.toHaveBeenCalled();
    fireEvent.press(screen.getAllByLabelText(/^Remove binding(,|$)/).at(-1)!);
    await waitFor(() => expect(removeBinding).toHaveBeenCalledWith('p/1', 'b1'));
  });
});
