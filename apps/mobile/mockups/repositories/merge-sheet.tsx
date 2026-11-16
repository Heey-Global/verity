import { PullSheet, RepositoriesPage, VERITY } from './parts';

/** A green pull request from a session: merge here, or open the session. */
export default function MergeSheetMockup() {
  return (
    <RepositoriesPage
      repositories={[VERITY]}
      sheet={
        <PullSheet
          pull={{
            number: 2403,
            title: 'Reduce the task list',
            branch: 'agent/5c2e81d0',
            state: 'ready',
            origin: { kind: 'session', title: 'Aufgabenliste Reduzieren' },
            checks: '14 checks passed',
          }}
          repository={VERITY}
          primary={{ label: 'Merge' }}
        />
      }
    />
  );
}
