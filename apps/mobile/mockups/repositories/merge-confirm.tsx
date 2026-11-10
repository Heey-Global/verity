import { ConfirmSheet } from '../../components/ui';
import { RepositoriesPage, VERITY } from './parts';

const ignore = () => undefined;

/** Merging asks once and names the commit it merges; a moved head stops it. */
export default function MergeConfirmMockup() {
  return (
    <RepositoriesPage
      repositories={[VERITY]}
      sheet={
        <ConfirmSheet
          visible
          title="Merge PR #2399?"
          message="Merges “fix(deps): update dependency graphql to v17.1.0” into main at commit 4f2c9a1. If the branch changes before then, nothing is merged."
          confirmLabel="Merge"
          onConfirm={ignore}
          onCancel={ignore}
        />
      }
    />
  );
}
