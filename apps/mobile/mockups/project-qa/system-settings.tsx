import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Row, Text } from '../../components/ui';
import { Fill, ignore } from './parts';

const value = (text: string) => <Text variant="bodySmall">{text}</Text>;

/**
 * System settings: one switch turns QA on in every coding project; the default
 * mode and the limits apply to all of them. Merging is never part of it.
 */
export default function SystemSettingsMockup() {
  return (
    <Fill>
      <SettingsScaffold title="QA" detail state={{ error: undefined, saving: false }}>
        <SettingsGroup title="QA">
          <SettingsListPanel>
            <SettingsToggleRow
              label="QA in coding projects"
              subtitle="Active in every project with a repository; projects can switch it off"
              value
              onValueChange={ignore}
            />
          </SettingsListPanel>
        </SettingsGroup>
        <SettingsGroup
          title="Default mode"
          description="Applies to projects without their own choice. QA never merges, releases or deploys."
        >
          <SettingsListPanel>
            <SettingsChoiceRow
              title="Repair within mandate"
              subtitle="Assign repairs to the origin session or a new one"
              selected
              onPress={ignore}
            />
            <SettingsChoiceRow
              title="Observe and propose"
              subtitle="Report and suggest repairs, start nothing"
              selected={false}
              onPress={ignore}
            />
          </SettingsListPanel>
        </SettingsGroup>
        <SettingsGroup title="Limits">
          <SettingsListPanel>
            <Row title="Rework rounds per issue" trailing={value('2')} />
            <Row title="Parallel repairs per project" trailing={value('3, then queued')} />
            <Row
              title="Emergency brake"
              subtitle="Stops QA everywhere after 20 session starts in an hour"
              trailing={value('On')}
            />
          </SettingsListPanel>
        </SettingsGroup>
        <SettingsGroup title="Projects">
          <SettingsListPanel>
            <SettingsNavRow
              icon="folder"
              title="website"
              subtitle="Repair within mandate"
              status={{ intent: 'needsSetup', label: 'Needs you' }}
              onPress={ignore}
            />
            <SettingsNavRow
              icon="folder"
              title="heey-global/verity"
              subtitle="Repair within mandate"
              status={{ intent: 'ready', label: 'All clear' }}
              onPress={ignore}
            />
            <SettingsNavRow
              icon="folder"
              title="playground"
              subtitle="Switched off in the project"
              status={{ intent: 'unknown', label: 'Off' }}
              onPress={ignore}
            />
          </SettingsListPanel>
        </SettingsGroup>
      </SettingsScaffold>
    </Fill>
  );
}
