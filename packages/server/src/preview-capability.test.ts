import { expect, it } from 'vitest';
import { previewSharingCapability } from './preview-capability.js';
it('distinguishes entitlement refusal from transport unavailability', () => {
  expect(previewSharingCapability(true, true)).toBe('available');
  expect(previewSharingCapability(false, false)).toBe('premium-required');
  const base = { sharing: 'unavailable', remoteControl: 'unavailable' } as const;
  expect(previewSharingCapability(false, true, { ...base, control: 'connected' })).toBe(
    'premium-required',
  );
  expect(
    previewSharingCapability(false, true, { ...base, control: 'rejected', reason: 'expired' }),
  ).toBe('premium-required');
  expect(previewSharingCapability(false, true, { ...base, control: 'reconnecting' })).toBe(
    'unavailable',
  );
});
