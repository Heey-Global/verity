import { PullSheet, RepositoriesPage, VERITY, VERITY_PULLS } from './parts';

/** A failing Renovate pull request: no session owns it, so one can be started. */
export default function FixSheetMockup() {
  const pull = VERITY_PULLS[1]!;
  return (
    <RepositoriesPage
      repositories={[VERITY]}
      sheet={
        <PullSheet pull={pull} repository={VERITY} primary={{ label: 'Fix in new session' }} />
      }
    />
  );
}
