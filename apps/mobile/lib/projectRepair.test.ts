import { VerityApiError, type VerityClient, type ProjectRecord } from '@verity/mobile';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { repairProject } from './projectRepair';

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));

const project = { id: 'p1', state: 'cloning' } as ProjectRecord;

function client(repair: jest.Mock): VerityClient {
  return { repairProject: repair } as unknown as VerityClient;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('repairProject', () => {
  it('keeps the request pending through warning confirmation and awaits the confirmed retry', async () => {
    const repair = jest
      .fn()
      .mockRejectedValueOnce(
        new VerityApiError(409, 'confirmation required', {
          requiresConfirmation: true,
          warnings: ['Local changes may be overwritten.'],
        }),
      )
      .mockResolvedValueOnce(project);
    let continueRepair: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      continueRepair = buttons?.find((button) => button.text === 'Continue')?.onPress;
    });
    const onUpdated = jest.fn();
    let settled = false;

    const pending = repairProject({
      client: client(repair),
      projectId: 'p1',
      returnTo: '/project/p1',
      onUpdated,
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(repair).toHaveBeenCalledTimes(1);
    continueRepair?.();
    await pending;

    expect(repair).toHaveBeenNthCalledWith(2, 'p1', { confirmWarnings: true });
    expect(onUpdated).toHaveBeenCalledWith(project);
  });

  it('settles without retrying when warning confirmation is cancelled', async () => {
    const repair = jest.fn().mockRejectedValue(
      new VerityApiError(409, 'confirmation required', {
        requiresConfirmation: true,
        warnings: ['Warning'],
      }),
    );
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Cancel')?.onPress?.();
    });

    await repairProject({ client: client(repair), projectId: 'p1', returnTo: '/' });

    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('routes sealed-secret failures to unlock with the requested return route', async () => {
    const repair = jest.fn().mockRejectedValue(new VerityApiError(503, 'secret store is sealed'));

    await repairProject({
      client: client(repair),
      projectId: 'p1',
      returnTo: '/project/p1',
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/unlock-device',
      params: { returnTo: '/project/p1', serverSecret: '1' },
    });
  });

  it('reports ordinary API failures through the caller callback', async () => {
    const repair = jest.fn().mockRejectedValue(new VerityApiError(500, 'Docker unavailable'));
    const onError = jest.fn();

    await repairProject({ client: client(repair), projectId: 'p1', returnTo: '/', onError });

    expect(onError).toHaveBeenCalledWith('Docker unavailable');
  });
});
