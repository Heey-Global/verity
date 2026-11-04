import type { SessionDirectory, SessionFileRoot } from '@verity/mobile';
import { Disclosure } from './ui/Disclosure';
import { Row } from './ui/Card';
import { Text } from './ui/Text';

type Props = {
  root: SessionFileRoot;
  documentSession: boolean;
  status?: SessionDirectory['documentStatus'];
  disabled: boolean;
  error?: string | null;
  hasConflicts?: boolean;
  navigate: (root: SessionFileRoot) => void;
};

/** Working copies are recovery tools, not a second primary Wiki navigation. */
export function WikiDetails({
  root,
  documentSession,
  status,
  disabled,
  navigate,
  error,
  hasConflicts,
}: Props) {
  if (root !== 'documents' && root !== 'drafts' && !(documentSession && root === 'worktree'))
    return null;
  const unsupported = status?.excludedEntries?.some((entry) => entry.reason === 'unsupported');
  const legacyWarning = status?.warning && status.excludedEntries === undefined;
  return (
    <>
      {root !== 'documents' ? (
        <Row title="Back to Wiki" onPress={() => navigate('documents')} disabled={disabled} />
      ) : null}
      {unsupported || legacyWarning ? (
        <Text variant="bodySmall" tone="attention" accessibilityLiveRegion="polite">
          Some files could not be added to the Wiki. Open Details to review them.
        </Text>
      ) : null}
      {status?.inspectionError ? (
        <Text variant="bodySmall" tone="attention" accessibilityLiveRegion="polite">
          Wiki save status could not be checked. Reopen the Wiki to try again.
        </Text>
      ) : null}
      {error ? (
        <Text variant="bodySmall" tone="attention" accessibilityLiveRegion="polite">
          The Wiki request could not be completed. Open Details for the error and try again.
        </Text>
      ) : null}
      {hasConflicts ? (
        <Text variant="bodySmall" tone="attention" accessibilityLiveRegion="polite">
          Wiki changes need review. Open the Conflicts folder to compare the saved versions.
        </Text>
      ) : null}
      <Disclosure title="Details">
        {error ? (
          <Text variant="bodySmall" tone="muted">
            {error}
          </Text>
        ) : null}
        {documentSession && root !== 'worktree' ? (
          <Row
            title="Current session files"
            subtitle="Files this session is working on. Wiki changes are saved automatically after each turn."
            onPress={() => navigate('worktree')}
            disabled={disabled}
          />
        ) : null}
        {root !== 'drafts' ? (
          <Row
            title="Files from other sessions"
            subtitle="Browse saved session copies, including files kept for recovery."
            onPress={() => navigate('drafts')}
            disabled={disabled}
          />
        ) : null}
        {status?.excludedEntries?.map((entry) => (
          <Text key={entry.path} variant="bodySmall" tone="muted">
            {entry.path}:{' '}
            {entry.reason === 'generated'
              ? 'Generated files are excluded from the Wiki. Keep code and build files in Code.'
              : 'This entry was skipped. Use a regular document file; replace links with copies and check file access.'}
          </Text>
        ))}
        {legacyWarning ? (
          <Text variant="bodySmall" tone="muted">
            {status?.warning}
          </Text>
        ) : null}
      </Disclosure>
    </>
  );
}
