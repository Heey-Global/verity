import { Alert } from 'react-native';
import type { VerityClient } from '@verity/mobile';
import { openPublicPreview, runPremiumFeature } from './premiumFeature';

afterEach(() => jest.restoreAllMocks());

it.each([false, undefined])('blocks preview sharing without a configured key (%s)', async (key) => {
  const alert = jest.spyOn(Alert, 'alert');
  const open = jest.fn();
  const client = {
    getVeritySettings: jest.fn(async () =>
      key === undefined ? null : { uplinkSubscriptionKeyConfigured: key },
    ),
  } as unknown as VerityClient;

  await openPublicPreview(client, open);

  expect(open).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith('Premium feature', expect.stringContaining('Uplink'));
});

it('checks again after a key is added and opens preview sharing', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const open = jest.fn();
  const getVeritySettings = jest
    .fn()
    .mockResolvedValueOnce({ uplinkSubscriptionKeyConfigured: false })
    .mockResolvedValueOnce({ uplinkSubscriptionKeyConfigured: true });
  const client = { getVeritySettings } as unknown as VerityClient;

  await openPublicPreview(client, open);
  await openPublicPreview(client, open);

  expect(getVeritySettings).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('does not mislabel a failed availability check as a missing subscription', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const open = jest.fn();
  await runPremiumFeature(
    {
      name: 'Another feature',
      requirement: 'Configure its subscription in Settings.',
      isConfigured: async () => {
        throw new Error('offline');
      },
    },
    open,
  );

  expect(open).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith('Could not check availability', expect.any(String));
});

it('uses the supplied feature name and setup instructions for other premium features', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const feature = {
    name: 'Another feature',
    requirement: 'Configure its subscription in Settings.',
    isConfigured: async () => false,
  };
  await runPremiumFeature(feature, jest.fn());
  expect(alert).toHaveBeenCalledWith('Premium feature', expect.stringContaining(feature.name));
  expect(alert.mock.calls[0]?.[1]).toContain(feature.requirement);
});
