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

it('reports a stored key with Online sharing switched off as disabled, never as premium-required', () => {
  // Switched off must not read like "buy a subscription": the operator has one.
  expect(previewSharingCapability(false, true, undefined, false)).toBe('disabled');
  expect(previewSharingCapability(true, true, undefined, false)).toBe('disabled');
  // Without a key the switch is irrelevant.
  expect(previewSharingCapability(false, false, undefined, false)).toBe('premium-required');
});
