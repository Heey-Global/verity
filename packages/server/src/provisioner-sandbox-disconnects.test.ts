import { expect, it } from 'vitest';
import type { EventStore } from '@verity/store';
import { ObservedSet } from './observed-set.js';
import { createProvisioner, fakeDocker, fakeGit } from './provisioner.test-helper.js';

// The sessions of a project name a cut-off sandbox in their overview row, and
// learn of a change only by observing the set the reconciler writes. A plain
// Set there would leave every row showing the old state until something
// unrelated hinted the session.
it('keeps the disconnected sandboxes in a set the server can observe', () => {
  const provisioner = createProvisioner({
    store: {} as unknown as EventStore,
    db: {} as never,
    docker: fakeDocker().client,
    git: fakeGit([]).runner,
    projectTokenMint: async () => 'tok',
    defaultImageRef: 'default',
    hostCloneRoot: '/srv/verity/workspaces',
    isDirectory: () => false,
  });
  expect(provisioner.disconnectedSandboxProjects()).toBeInstanceOf(ObservedSet);
});
