import { dopplerBindingGrantId } from '@verity/store';
import { describe, expect, it } from 'vitest';

import {
  assertBrokeredDopplerBinding,
  brokeredDopplerBindingId,
  brokeredDopplerSnapshot,
  brokeredDopplerSnapshotApplies,
  defaultDopplerGrantMember,
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

  it('omits invalid stored slugs from agent-facing binding alternatives', () => {
    const stored = [
      { ...portalPrd, dopplerProject: 'portal\nprivate text' },
      { ...portalStg, dopplerConfig: 'stg/another' },
      billingDev,
    ];
    expect(() => resolveSecretReference(stored, 'portal/prd/API_KEY')).toThrow(
      'Doppler binding `portal/prd` is no longer connected to this project (connected: billing/dev). No secret value was exposed.',
    );
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
  // These aliases are names for configuration values. The snapshot contains binding metadata.
  const snapshot = (...references: string[]) =>
    brokeredDopplerSnapshot(referencedBindings(bindings, references));

  // A grant for `SERVICE_REGION` in one config must never cover the same name in another.
  it('keys a call by the bindings it reads, not by the project', () => {
    const bare = brokeredDopplerBindingId(snapshot('SERVICE_REGION'));
    const billing = brokeredDopplerBindingId(snapshot('billing/dev/SERVICE_REGION'));
    expect(bare).toBe(dopplerBindingGrantId(portalPrd));
    expect(billing).toBe(dopplerBindingGrantId(billingDev));
    expect(bare).not.toBe(billing);
    expect(brokeredDopplerBindingId(snapshot('portal/prd/SERVICE_REGION', 'SERVICE_REGION'))).toBe(
      bare,
    );
    // The same project and config through another connection is another binding.
    expect(dopplerBindingGrantId({ ...billingDev, connectionId: 'platform' })).not.toBe(billing);
  });

  it('rechecks the default before approving a standing grant for a bare reference', () => {
    const approved = snapshot('SERVICE_REGION');
    const switched = bindings.map((binding) => ({
      ...binding,
      isDefault: binding.id === billingDev.id,
    }));
    expect(brokeredDopplerSnapshotApplies(approved, bindings)).toBe(true);
    expect(brokeredDopplerSnapshotApplies(approved, switched)).toBe(false);
  });

  it('applies a grant only while every binding it names is still bound', () => {
    const both = brokeredDopplerBindingId(snapshot('SERVICE_REGION', 'billing/dev/SERVICE_REGION'));
    const current = new Set([
      ...bindings.map(dopplerBindingGrantId),
      defaultDopplerGrantMember(dopplerBindingGrantId(portalPrd)),
    ]);
    expect(brokeredGrantBindingApplies(both, current)).toBe(true);
    expect(brokeredGrantBindingApplies(dopplerBindingGrantId(portalStg), current)).toBe(true);
    current.delete(dopplerBindingGrantId(billingDev));
    expect(brokeredGrantBindingApplies(both, current)).toBe(false);
    expect(brokeredGrantBindingApplies(dopplerBindingGrantId(billingDev), current)).toBe(false);
  });

  it('changes authorization when a mixed request resolves its bare reference elsewhere', () => {
    const references = [
      'SERVICE_REGION',
      'portal/prd/SERVICE_REGION',
      'billing/dev/SERVICE_REGION',
    ];
    const switched = bindings.map((binding) => ({
      ...binding,
      isDefault: binding.id === billingDev.id,
    }));
    expect(
      brokeredDopplerBindingId(brokeredDopplerSnapshot(referencedBindings(switched, references))),
    ).not.toBe(brokeredDopplerBindingId(snapshot(...references)));
  });

  it('keeps an approval valid when the same bindings are listed in another order', () => {
    const approved = snapshot('portal/prd/SERVICE_REGION', 'billing/dev/SERVICE_REGION');
    expect(approved.bindings).toHaveLength(2);
    // setDefault or a re-insert reorders the list; that is not a change of access.
    const reordered = { bindings: [...approved.bindings].reverse() };
    expect(() => assertBrokeredDopplerBinding(reordered, approved)).not.toThrow();
  });

  it('invalidates exact approvals when a binding row changes without changing grant identity', () => {
    const approved = snapshot('SERVICE_REGION');
    const recreated = bindings.map((binding) =>
      binding.id === portalPrd.id ? { ...binding, id: 'recreated' } : binding,
    );
    const current = brokeredDopplerSnapshot(referencedBindings(recreated, ['SERVICE_REGION']));
    expect(brokeredDopplerBindingId(current)).toBe(brokeredDopplerBindingId(approved));
    expect(() => assertBrokeredDopplerBinding(current, approved)).toThrow('Doppler access changed');
  });

  it('changes authorization when a connection token is replaced', () => {
    const rotated = bindings.map((binding) => ({
      ...binding,
      tokenRevision: 'a31833e4-8584-4ec4-888b-95ce87e4d44a',
    }));
    expect(
      brokeredDopplerBindingId(
        brokeredDopplerSnapshot(referencedBindings(rotated, ['SERVICE_REGION'])),
      ),
    ).not.toBe(brokeredDopplerBindingId(snapshot('SERVICE_REGION')));
  });

  it('shows one binding as project and config, several as a list', () => {
    expect(brokeredSecretSource(snapshot('SERVICE_REGION'))).toEqual({
      project: 'portal',
      config: 'prd',
    });
    expect(brokeredSecretSource(snapshot('SERVICE_REGION', 'billing/dev/SERVICE_REGION'))).toEqual({
      project: 'billing/dev, portal/prd',
      config: '',
    });
  });
});
