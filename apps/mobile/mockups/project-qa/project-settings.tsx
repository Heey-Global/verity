import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Fill, ignore } from './parts';

/** Project settings: QA on or off for this project and its mode, replacing the three repair modes. */
export default function ProjectSettingsMockup() {
  return (
    <Fill>
      <SettingsScaffold title="Project settings" state={{ error: undefined, saving: false }}>
        <SettingsGroup
          title="QA"
          description="Watches pull requests and CI of this project and assigns repairs. It never merges, releases or deploys."
        >
          <SettingsListPanel>
            <SettingsToggleRow
              label="QA for this project"
              subtitle="On by default from the system settings"
              value
              onValueChange={ignore}
            />
            <SettingsChoiceRow
              title="Repair within mandate"
              subtitle="Default · origin session first, otherwise a new one"
              selected
              onPress={ignore}
            />
            <SettingsChoiceRow
              title="Observe and propose"
              subtitle="Report and suggest repairs, start nothing"
              selected={false}
              onPress={ignore}
            />
            <SettingsChoiceRow
              title="Pause"
              subtitle="Keep issues, stop watching until resumed"
              selected={false}
              onPress={ignore}
            />
          </SettingsListPanel>
        </SettingsGroup>
        <SettingsGroup title="Activity">
          <SettingsListPanel>
            <SettingsNavRow
              icon="shield"
              title="Open QA"
              subtitle="3 open issues · checked 08:12"
              onPress={ignore}
            />
          </SettingsListPanel>
        </SettingsGroup>
      </SettingsScaffold>
    </Fill>
  );
}
