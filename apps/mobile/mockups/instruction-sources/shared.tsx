import type { CodeHostProvider } from '@verity/mobile';
import { useState, type ReactNode } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { CodeHostIcon } from '../../components/CodeHostIcon';
import { Icon } from '../../components/Icon';
import { SettingsScaffold } from '../../components/settings/SettingsChrome';
import { Card, CardHead, SectionHeader, StatusTag, Text, TextField } from '../../components/ui';

/** Sample content only: the project's own instructions and two repositories. */
export const PROJECT_INSTRUCTIONS =
  'Write clearly and concisely.\nPreserve existing project conventions.\nAsk before publishing externally.';

const REPOSITORIES: readonly {
  provider: CodeHostProvider;
  name: string;
  instructions: string;
}[] = [
  {
    provider: 'github',
    name: 'acme/mobile',
    instructions: 'Use the shared UI components.\nRun the affected mobile tests.',
  },
  {
    provider: 'forgejo',
    name: 'acme/api',
    instructions: 'Validate API changes with contract tests.\nKeep migrations reversible.',
  },
];

/** A repository's AGENTS.md: shown for reference, edited in the repository. */
function RepositoryInstructions({ provider, name, instructions }: (typeof REPOSITORIES)[number]) {
  const { theme } = useUnistyles();
  return (
    <Card stacked divided>
      <CardHead
        leading={{ element: <CodeHostIcon provider={provider} color={theme.colors.action} /> }}
        title={name}
        subtitle="AGENTS.md"
        trailing={<StatusTag intent="optional" label="Read only" />}
      />
      <Text variant="bodySmall" tone="muted">
        {instructions}
      </Text>
    </Card>
  );
}

/** The project's own instructions: the same card as a repository's, edited in place. */
function ProjectInstructions({
  draft,
  onChange,
  footer,
}: {
  draft: string;
  onChange: (draft: string) => void;
  footer: ReactNode;
}) {
  const { theme } = useUnistyles();
  return (
    <Card stacked divided>
      <CardHead
        leading={{ element: <Icon name="layers" size={16} color={theme.colors.action} /> }}
        title="Project instructions"
        subtitle="Tap the text to edit"
      />
      <TextField
        label="Instructions"
        inline
        value={draft}
        onChangeText={onChange}
        multiline
        lines={{ min: Math.min(Math.max(3, draft.split('\n').length), 40), max: 40 }}
      />
      {footer}
    </Card>
  );
}

/** The whole screen; `footer` is the save action, offered only after an edit. */
export function InstructionsScreen({
  initial,
  footer,
}: {
  initial: string;
  footer?: (draft: string) => ReactNode;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <SettingsScaffold title="Instructions" detail state={{ error: undefined, saving: false }}>
      <Text variant="bodySmall" tone="muted">
        Instructions are rules every agent in this project follows. Repositories can add their own
        for work in that repository.
      </Text>
      <ProjectInstructions draft={draft} onChange={setDraft} footer={footer?.(draft)} />
      <SectionHeader title="From repositories" />
      {REPOSITORIES.map((repository) => (
        <RepositoryInstructions key={repository.name} {...repository} />
      ))}
    </SettingsScaffold>
  );
}
