import { readFileSync } from 'node:fs';
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
  // The server takes it once: a copy per call would leave it observing none.
  expect(provisioner.disconnectedSandboxProjects()).toBe(provisioner.disconnectedSandboxProjects());
});

// Every change of the set makes the server read the project's sessions and
// publish their rows. A pass that cleared and refilled it would do so on every
// reconcile tick for every cut-off sandbox, though nothing changed.
it('changes the disconnected sandboxes one project at a time', () => {
  const source = readFileSync(new URL('./provisioner.ts', import.meta.url), 'utf8');
  const writes = [...source.matchAll(/this\.disconnectedSandboxes\.(add|delete|clear)\(/gu)].map(
    (m) => m[1],
  );
  expect(writes.length).toBeGreaterThan(0);
  expect(new Set(writes)).toEqual(new Set(['add', 'delete']));
  expect(source).not.toMatch(/this\.disconnectedSandboxes\s*=(?!\s*new ObservedSet)/u);
});
