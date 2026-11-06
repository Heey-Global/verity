import { useState } from 'react';

import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Row } from '../../components/ui';

type Level = 'off' | 'on_request' | 'required';

const LEVELS: readonly { level: Level; title: string; subtitle: string }[] = [
  { level: 'off', title: 'Off', subtitle: 'Plans go straight to implementation' },
  {
    level: 'on_request',
    title: 'On request',
    subtitle: 'Mockups when you ask for them or the agent suggests them',
  },
  {
    level: 'required',
    title: 'Required for UI changes',
    subtitle: 'Every plan that changes the interface waits for approved mockups',
  },
];

/** Project settings › Agents › Design: when plans stop for mockups. */
export default function DesignSettingsMockup() {
  const [level, setLevel] = useState<Level>('on_request');
  return (
    <SettingsScaffold title="Design" detail state={{ error: undefined, saving: false }}>
      <SettingsGroup
        title="Mockups"
        description="Mockups are shown after you approve a plan and before the agent builds it. You approve each screen or comment on it."
      >
        <SettingsListPanel>
          {LEVELS.map((entry) => (
            <SettingsChoiceRow
              key={entry.level}
              title={entry.title}
              subtitle={entry.subtitle}
              selected={level === entry.level}
              onPress={() => setLevel(entry.level)}
            />
          ))}
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup
        title="Design system"
        description="Mockups are built from the project's own components where it has them."
      >
        <SettingsListPanel>
          <Row
            title="docs/design-system.md"
            subtitle="Found · 23 components in apps/mobile/components/ui"
            leading={{ icon: 'check-circle', intent: 'ready' }}
          />
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
