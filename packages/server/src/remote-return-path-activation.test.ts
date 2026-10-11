import { describe, expect, it } from 'vitest';
import { ReturnPathActivation } from './remote-return-path-activation.js';

describe('return-path consent', () => {
  const baseline = Date.parse('2026-10-11T18:00:00Z');
  function fixture(environment = false) {
    let wall = baseline,
      mono = 0;
    const descriptor = { enabled: true, installationId: 'private-installation' };
    const consent = new ReturnPathActivation(
      () => descriptor,
      environment
        ? { installationId: descriptor.installationId, expiresAt: baseline + 60_000 }
        : undefined,
      () => wall,
      () => mono,
    );
    return {
      consent,
      descriptor,
      advance: (w: number, m: number) => {
        wall += w;
        mono += m;
      },
    };
  }
  it('defaults off and derives private identity from the authenticated descriptor', () => {
    const { consent } = fixture();
    expect(consent.status().enabled).toBe(false);
    const state = consent.start(new Date(baseline + 60_000).toISOString());
    expect(state).toMatchObject({ enabled: true, source: 'runtime', remainingMs: 60_000 });
    expect(JSON.stringify(state)).not.toContain('private-installation');
    expect(state.installationFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    consent.dispose();
  });
  it('rejects ambiguous, rolled-over, expired and overlong deadlines', () => {
    const { consent } = fixture();
    for (const date of [
      'tomorrow',
      '2026-10-11',
      '2026-02-30T18:00:00Z',
      new Date(baseline).toISOString(),
      new Date(baseline + 600_001).toISOString(),
    ])
      expect(() => consent.start(date)).toThrow('invalid_expiry');
    consent.dispose();
  });
  it('does not renew an active lease on duplicate or conflicting start', () => {
    const { consent, advance } = fixture();
    const expiry = new Date(baseline + 60_000).toISOString();
    consent.start(expiry);
    advance(1_000, 1_000);
    expect(consent.start(expiry).remainingMs).toBe(59_000);
    expect(() => consent.start(new Date(baseline + 120_000).toISOString())).toThrow(
      'already_active',
    );
    consent.dispose();
  });
  it('expires even when the wall clock rolls back and notifies running connectors', () => {
    const { consent, advance } = fixture();
    let changes = 0;
    consent.subscribe(() => changes++);
    consent.start(new Date(baseline + 60_000).toISOString());
    advance(-120_000, 60_000);
    expect(consent.expiry()).toBeUndefined();
    expect(changes).toBe(2);
    consent.dispose();
  });
  it('stops permanently on identity change or entitlement loss', () => {
    for (const identity of [true, false]) {
      const { consent, descriptor } = fixture();
      consent.start(new Date(baseline + 60_000).toISOString());
      if (identity) descriptor.installationId = 'other';
      else descriptor.enabled = false;
      expect(consent.status().enabled).toBe(false);
      descriptor.enabled = true;
      descriptor.installationId = 'private-installation';
      expect(consent.expiry()).toBeUndefined();
      consent.dispose();
    }
  });
  it('stop suppresses environment consent and restart does not retain runtime consent', () => {
    const { consent } = fixture(true);
    expect(consent.status().source).toBe('environment');
    consent.stop();
    consent.stop();
    expect(consent.expiry()).toBeUndefined();
    consent.dispose();
    const next = fixture();
    expect(next.consent.status().enabled).toBe(false);
    next.consent.dispose();
  });
});

it('keeps startup consent pending until its authenticated installation appears', () => {
  const now = Date.now();
  const descriptor = { enabled: false, installationId: 'paired' };
  const consent = new ReturnPathActivation(() => descriptor, {
    installationId: 'paired',
    expiresAt: now + 60_000,
  });
  expect(consent.expiry()).toBeUndefined();
  expect(consent.status().source).toBe('environment');
  descriptor.enabled = true;
  expect(consent.expiry()).toBe(now + 60_000);
  consent.dispose();
});

it('ends consent even when the final metadata exporter fails', () => {
  const consent = new ReturnPathActivation(() => ({ enabled: true, installationId: 'paired' }));
  consent.beforeStop(() => {
    throw new Error('untrusted exporter error');
  });
  consent.start(new Date(Date.now() + 60_000).toISOString());
  expect(() => consent.stop()).not.toThrow();
  expect(consent.status()).toMatchObject({ enabled: false, source: 'none' });
  consent.dispose();
});
