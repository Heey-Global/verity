import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createProtectedBuildAdmission } from './project-egress-build-admission.js';
import { ProtectedBuildAuthorityError } from './project-egress-build-error.js';
import type { ProjectFenceBinding } from './project-egress-fence.js';

const helper = resolve(import.meta.dirname, '../../../deploy/egress/project-egress-deadline.py');
// Runs the installed helper's own expiry bookkeeping, which its revoke and renew
// operations perform first, against the nft tables the admission applied so far.
// Only the nft read is replaced: an absent table fails as libnftables does.
const harness = `
import importlib.util, json, re, sys
spec = importlib.util.spec_from_file_location('deadline', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
data = json.load(sys.stdin)
def run(*args):
    if args[:5] != ('/usr/sbin/nft', '-j', 'list', 'table', 'inet'):
        raise ValueError('Unexpected helper command')
    table = re.search(r'^table inet ' + re.escape(args[5]) + r' \\{\\n(.*?)^\\}', data['script'], re.M | re.S)
    if not table:
        raise ValueError('Deadline nft inspection failed')
    names = re.findall(r'^set (\\S+) \\{', table.group(1), re.M)
    return json.dumps({'nftables': [{'set': {'name': name}} for name in names]})
helper.run = run
helper.remember_expiry(data['binding'], {'nftAuthorities': [None], 'expiredAuthorities': []})
`;
function rememberExpiry(binding: ProjectFenceBinding, script: string): void {
  const result = spawnSync('python3', ['-I', '-c', harness, helper], {
    input: JSON.stringify({ binding, script }),
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(result.stderr.trim().split('\n').at(-1) ?? 'helper failed');
}

const binding: ProjectFenceBinding = {
  projectId: '3ee8da80-15d4-4924-8024-9e2d7eb82313',
  generation: '11111111-1111-4111-8111-111111111111',
  containerId: 'a'.repeat(64),
  networkId: 'b'.repeat(64),
  endpointId: 'c'.repeat(64),
  bridge: 'veb123456789abc',
  ipv4: '172.30.1.2',
  ipv6: 'fd42::2',
};
const clock = {
  bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
  realNs: '1000000000',
  bootBeforeNs: '1000000000',
  bootAfterNs: '1000000000',
};
function fixture() {
  let applied = '';
  const deadline = {
    prepare: vi.fn(async (value: ProjectFenceBinding) => void value),
    clock: vi.fn(async () => clock),
    arm: vi.fn(async () => undefined),
    // The helper records observed expiry before it revokes or renews a guard.
    revoke: vi.fn(async (value: ProjectFenceBinding) => rememberExpiry(value, applied)),
    renew: vi.fn(async (value: ProjectFenceBinding) => rememberExpiry(value, applied)),
  };
  const dependencies = {
    inspect: vi.fn(async () => ({ ...binding })),
    apply: vi.fn(async (script: string) => {
      applied += script;
    }),
    resolve: vi.fn(async () => ({ addresses: ['8.8.8.8'], expiresAt: 10000 })),
    directTargetAllowed: vi.fn(async () => false),
    destinationAllowed: vi.fn(async () => false),
    deadline,
  };
  return {
    deadline,
    dependencies,
    admission: createProtectedBuildAdmission({
      binding,
      dependencies,
      networkInventory: async () => ({ blocked: [], uplinks: ['eth0'] }),
    }),
  };
}

it('prepares, renews and revokes packet authority that the root helper accepts', async () => {
  // Every protected build failed with authority_prepare_failed: the first revoke
  // ran before the build table existed, and the table never declared the
  // standing tombstones that the helper requires.
  const f = fixture();
  await f.admission.prepare();
  expect(f.deadline.revoke).toHaveBeenCalledOnce();
  await f.admission.refresh();
  await f.admission.refresh();
  expect(f.deadline.renew).toHaveBeenCalledOnce();
  await f.admission.revoke();
  await f.admission.retire();
  expect(f.deadline.revoke).toHaveBeenCalledTimes(3);
});

it('names the refused step and stays revocable when the packet guard is refused', async () => {
  const f = fixture();
  f.deadline.prepare.mockRejectedValueOnce(
    new Error('Deadline requires an inspected software veth'),
  );
  const refused = await f.admission.prepare().catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ProtectedBuildAuthorityError);
  expect(refused).toMatchObject({ step: 'packet_guard' });
  // No registration exists to revoke; the denying table is still installed, and
  // a later denial or retirement must not fail on the missing registration.
  expect(f.deadline.revoke).not.toHaveBeenCalled();
  expect(f.dependencies.apply).toHaveBeenCalled();
  await f.admission.revoke();
  await f.admission.retire();
  expect(f.deadline.revoke).not.toHaveBeenCalled();
  await expect(f.admission.refresh()).rejects.toThrow('Inactive build admission');
});

it.each([
  ['attachment', (f: ReturnType<typeof fixture>) => f.dependencies.inspect],
  ['fence_rules', (f: ReturnType<typeof fixture>) => f.dependencies.apply],
  ['packet_revoke', (f: ReturnType<typeof fixture>) => f.deadline.revoke],
] as const)('classifies a refused %s step', async (step, dependency) => {
  const f = fixture();
  (dependency(f) as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('private'));
  await expect(f.admission.prepare()).rejects.toMatchObject({ step });
});
