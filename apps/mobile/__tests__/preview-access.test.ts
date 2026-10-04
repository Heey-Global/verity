import { Alert, Linking } from 'react-native';
import { localPreviewReachable, type LocalPreviewShare } from '@verity/mobile';
import { openLocalPreview } from '../components/project/previewAccess';

jest.mock('@verity/mobile', () => ({
  ...jest.requireActual('@verity/mobile'),
  localPreviewReachable: jest.fn(),
}));

const share = { id: 'local-one', url: 'http://host:8100/' } as LocalPreviewShare;
const probe = localPreviewReachable as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

it('opens a reachable preview without asking to publish it', async () => {
  probe.mockResolvedValue(true);
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const publish = jest.fn();
  await openLocalPreview(share, 'available', publish);
  expect(open).toHaveBeenCalledWith(share.url);
  expect(publish).not.toHaveBeenCalled();
});

it('requires a deliberate choice before publishing an unreachable local preview', async () => {
  probe.mockResolvedValue(false);
  const alert = jest.spyOn(Alert, 'alert');
  const publish = jest.fn();
  await openLocalPreview(share, 'available', publish);
  expect(publish).not.toHaveBeenCalled();
  const choices = alert.mock.calls[0]?.[2];
  choices?.find((choice) => choice.text === 'Share publicly')?.onPress?.();
  expect(publish).toHaveBeenCalledTimes(1);
});

it.each(['premium-required', 'unavailable'] as const)(
  'explains %s without offering unavailable sharing',
  async (status) => {
    probe.mockResolvedValue(false);
    const alert = jest.spyOn(Alert, 'alert');
    await openLocalPreview(share, status, jest.fn());
    expect(alert.mock.calls[0]?.[1]).toContain(
      status === 'premium-required' ? 'Premium' : 'temporarily unavailable',
    );
    expect(alert.mock.calls[0]?.[2]?.some((choice) => choice.text === 'Share publicly')).toBe(
      false,
    );
  },
);

it('offers Premium settings when the local network cannot be reached without entitlement', async () => {
  probe.mockResolvedValue(false);
  const alert = jest.spyOn(Alert, 'alert');
  const settings = jest.fn();
  await openLocalPreview(share, 'premium-required', jest.fn(), settings);
  alert.mock.calls[0]?.[2]?.find((choice) => choice.text === 'Open settings')?.onPress?.();
  expect(settings).toHaveBeenCalledTimes(1);
});
