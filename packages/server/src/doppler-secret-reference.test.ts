import { dopplerBindingGrantId } from '@verity/store';
import { describe, expect, it } from 'vitest';

import {
  brokeredDopplerBindingId,
  brokeredDopplerSnapshot,
  brokeredGrantBindingApplies,
  brokeredSecretSource,
} from './brokered-doppler-binding.js';
import {
  referencedBindings,
  resolveSecretReference,
  secretReferenceNames,
  type ProjectDopplerBinding,
} from './doppler-secret-reference.js';

const portalPrd: ProjectDopplerBinding = {
  id: 'b1',
  connectionId: 'platform',
  dopplerProject: 'portal',
  dopplerConfig: 'prd',
  isDefault: true,
};
const portalStg: ProjectDopplerBinding = {
  ...portalPrd,
  id: 'b2',
  dopplerConfig: 'stg',
  isDefault: false,
};
const billingDev: ProjectDopplerBinding = {
  id: 'b3',
  connectionId: 'payments',
  dopplerProject: 'billing',
  dopplerConfig: 'dev',
  isDefault: false,
};
const bindings = [portalPrd, portalStg, billingDev];

describe('secret references (ADR 0031)', () => {
  it('reads a bare name from the default binding and a full one from its binding', () => {
    expect(resolveSecretReference(bindings, 'API_KEY')).toEqual({
      binding: portalPrd,
      name: 'API_KEY',
    });
    expect(resolveSecretReference(bindings, 'billing/dev/API_KEY')).toEqual({
      binding: billingDev,
      name: 'API_KEY',
    });
    expect(resolveSecretReference(bindings, 'portal/stg/API_KEY').binding).toBe(portalStg);
    // The default may be written in full as well.
    expect(resolveSecretReference(bindings, 'portal/prd/API_KEY').binding).toBe(portalPrd);
  });

  // A gone binding must fail loudly, never fall back to the default: the default
  // config holding a secret of the same name is the usual case, not the exception.
  it('names a binding that is no longer connected, together with what is', () => {
    expect(() => resolveSecretReference(bindings, 'billing/prd/API_KEY')).toThrow(
      'Doppler binding `billing/prd` is no longer connected to this project (connected: portal/prd, portal/stg, billing/dev).',
    );
    expect(() => resolveSecretReference([], 'API_KEY')).toThrow('has no Doppler binding');
    expect(() => resolveSecretReference([portalStg], 'API_KEY')).toThrow('has no Doppler binding');
  });

  it('refuses anything that is neither a name nor a full reference', () => {
    for (const reference of [
      'prd/API_KEY',
      'a/b/c/API_KEY',
      'api_key',
      '/portal/prd/API_KEY',
      '',
    ]) {
      expect(() => resolveSecretReference(bindings, reference)).toThrow('not valid');
    }
  });

  it('lists default names bare and every other binding in full', () => {
    expect(
      secretReferenceNames([
        { binding: billingDev, names: ['API_KEY'] },
        { binding: portalPrd, names: ['API_KEY', 'DATABASE_URL'] },
      ]),
    ).toEqual(['API_KEY', 'DATABASE_URL', 'billing/dev/API_KEY']);
  });
});

describe('approvals and grants per binding', () => {
  const snapshot = (...references: string[]) =>
    brokeredDopplerSnapshot(referencedBindings(bindings, references));

  // A grant for `API_KEY` in one config must never cover the same name in another.
  it('keys a call by the bindings it reads, not by the project', () => {
    const bare = brokeredDopplerBindingId(snapshot('API_KEY'));
    const billing = brokeredDopplerBindingId(snapshot('billing/dev/API_KEY'));
    expect(bare).toBe(dopplerBindingGrantId(portalPrd));
    expect(billing).toBe(dopplerBindingGrantId(billingDev));
    expect(bare).not.toBe(billing);
    expect(brokeredDopplerBindingId(snapshot('portal/prd/API_KEY', 'API_KEY'))).toBe(bare);
    // The same project and config through another connection is another binding.
    expect(dopplerBindingGrantId({ ...billingDev, connectionId: 'platform' })).not.toBe(billing);
  });

  it('applies a grant only while every binding it names is still bound', () => {
    const both = brokeredDopplerBindingId(snapshot('API_KEY', 'billing/dev/API_KEY'));
    const current = new Set(bindings.map(dopplerBindingGrantId));
    expect(brokeredGrantBindingApplies(both, current)).toBe(true);
    expect(brokeredGrantBindingApplies(dopplerBindingGrantId(portalStg), current)).toBe(true);
    current.delete(dopplerBindingGrantId(billingDev));
    expect(brokeredGrantBindingApplies(both, current)).toBe(false);
    expect(brokeredGrantBindingApplies(dopplerBindingGrantId(billingDev), current)).toBe(false);
  });

  it('shows one binding as project and config, several as a list', () => {
    expect(brokeredSecretSource(snapshot('API_KEY'))).toEqual({ project: 'portal', config: 'prd' });
    expect(brokeredSecretSource(snapshot('API_KEY', 'billing/dev/API_KEY'))).toEqual({
      project: 'billing/dev, portal/prd',
      config: '',
    });
  });
});
