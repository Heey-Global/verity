import type { ReactNode } from 'react';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Fill, ignore } from './parts';

/** Sample data only: the folders this project was granted. */
export const PROJECT_FOLDERS = [
  { name: 'Briefs', path: 'Studio NAS › Projects › Briefs', access: 'Read and write' },
  { name: 'Guidelines', path: 'Archive › Reference › Guidelines', access: 'Read only' },
] as const;

/**
 * Project settings › Connectors › Network shares: one flat list of the folders
 * this project's agents may use, each with its access level as the row value.
 */
export function ProjectFoldersPage({ overlay }: { overlay?: ReactNode }) {
  return (
    <Fill>
      <SettingsScaffold title="Network shares" detail state={{ error: undefined, saving: false }}>
        <SettingsGroup
          title="Folders for this project"
          description="Agents in this project can use only these folders. Everything else on the share stays out of reach."
        >
          <SettingsListPanel>
            {PROJECT_FOLDERS.map((folder) => (
              <SettingsNavRow
                key={folder.name}
                icon="folder"
                title={folder.name}
                subtitle={folder.path}
                value={folder.access}
                onPress={ignore}
              />
            ))}
            <SettingsNavRow title="Add folder" icon="plus" onPress={ignore} />
          </SettingsListPanel>
        </SettingsGroup>
      </SettingsScaffold>
      {overlay}
    </Fill>
  );
}

export default function ProjectNetworkSharesMockup() {
  return <ProjectFoldersPage />;
}
