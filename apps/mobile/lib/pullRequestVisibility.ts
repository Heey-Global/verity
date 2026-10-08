import type { BranchList } from '@verity/mobile';

export function shouldShowPullRequest(
  phase: NonNullable<BranchList['pullRequest']>['phase'] | undefined,
  dismissalsLoaded: boolean,
  dismissed: boolean,
): boolean {
  return phase !== undefined && (phase === 'open' || dismissalsLoaded) && !dismissed;
}
