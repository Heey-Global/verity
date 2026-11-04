import { expect, it } from 'vitest';
import { createProjectEgressInventoryContractReader } from './project-egress-inventory-contract.js';

it('allows absent preactivation and latches the root contract through deletion', () => {
  let source: string | undefined;
  const required = createProjectEgressInventoryContractReader(() => {
    if (source === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return source;
  });
  expect(required()).toBe(false);
  source = '{"version":1,"required":true}';
  expect(required()).toBe(true);
  source = undefined;
  expect(required).toThrow('unavailable');
});

it('fails closed on malformed, unreadable and expanded contracts', () => {
  for (const source of [
    'broken',
    '{}',
    '{"version":1,"required":false}',
    '{"version":1,"required":true,"extra":0}',
  ]) {
    let current: string | undefined = source;
    const required = createProjectEgressInventoryContractReader(() => {
      if (current === undefined) throw Object.assign(new Error(), { code: 'ENOENT' });
      return current;
    });
    expect(required).toThrow('invalid');
    current = undefined;
    expect(required).toThrow('unavailable');
  }
  expect(
    createProjectEgressInventoryContractReader(() => {
      throw Object.assign(new Error(), { code: 'EACCES' });
    }),
  ).toThrow('unavailable');
});
