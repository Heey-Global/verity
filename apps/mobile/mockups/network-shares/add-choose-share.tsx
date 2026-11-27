import { SettingsListPanel, SettingsNavRow } from '../../components/settings/SettingsChrome';
import { Sheet } from '../../components/ui';
import { ignore, SHARES } from './parts';
import { ProjectFoldersPage } from './project-network-shares';

/** Step 1 of "Add folder": pick one of the centrally connected shares. */
export default function AddChooseShareMockup() {
  return (
    <ProjectFoldersPage
      overlay={
        <Sheet visible title="Add folder from" onClose={ignore}>
          <SettingsListPanel>
            {SHARES.map((share) => (
              <SettingsNavRow
                key={share.name}
                icon="hard-drive"
                title={share.name}
                subtitle={share.address}
                status={share.status.intent === 'ready' ? undefined : share.status}
                disabled={share.status.intent !== 'ready'}
                onPress={ignore}
              />
            ))}
          </SettingsListPanel>
        </Sheet>
      }
    />
  );
}
