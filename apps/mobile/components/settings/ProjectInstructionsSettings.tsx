import type { RepositoryInstructions } from '@verity/mobile';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { createVerityClient } from '../../lib/client';
import { CodeHostIcon } from '../CodeHostIcon';
import { Icon } from '../Icon';
import { Button, Card, CardHead, SectionHeader, StatusTag, Text, TextField } from '../ui';
import { SettingsMessage, SettingsScaffold } from './SettingsChrome';

const INSTRUCTIONS_LIMIT = 12_000;

type Snapshot = { instructions: string; revision: string };
type Repositories =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; repositories: RepositoryInstructions[] };

/**
 * A project's Instructions on one page: the project's own rules, edited in
 * place, and below them the root AGENTS.md of each connected repository, shown
 * for reference only — those files belong to the repository and change there.
 */
export function ProjectInstructionsSettings({ projectId }: { projectId: string }) {
  const client = useMemo(() => createVerityClient(), []);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [repositories, setRepositories] = useState<Repositories>({ state: 'loading' });

  const loadInstructions = useCallback(
    async (preserveDraft = false) => {
      if (!client) return;
      try {
        const next = await client.getProjectInstructions(projectId);
        setSnapshot(next);
        if (!preserveDraft) setDraft(next.instructions);
        setError(undefined);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not load Instructions');
      }
    },
    [client, projectId],
  );
  // Loaded on its own: a code host that is down must not keep the project's
  // own Instructions from being read or edited.
  const loadRepositories = useCallback(async () => {
    if (!client) return;
    setRepositories({ state: 'loading' });
    try {
      setRepositories({
        state: 'loaded',
        repositories: await client.getProjectRepositoryInstructions(projectId),
      });
    } catch {
      setRepositories({ state: 'failed' });
    }
  }, [client, projectId]);
  useEffect(() => {
    void loadInstructions();
    void loadRepositories();
  }, [loadInstructions, loadRepositories]);

  const save = async () => {
    if (!client || !snapshot || saving) return;
    setSaving(true);
    try {
      const next = await client.replaceProjectInstructions(projectId, {
        instructions: draft,
        revision: snapshot.revision,
      });
      setSnapshot(next);
      setDraft(next.instructions);
      setError(undefined);
    } catch (failure) {
      // The draft stays: a conflict or a lost connection must not cost the edit.
      setError(failure instanceof Error ? failure.message : 'Could not save Instructions');
    } finally {
      setSaving(false);
    }
  };

  if (!client)
    return (
      <SettingsMessage
        screenTitle="Instructions"
        title="Server unavailable"
        subtitle="Connect to your Verity server to edit Instructions."
      />
    );
  const changed = snapshot !== undefined && draft !== snapshot.instructions;
  const present =
    repositories.state === 'loaded'
      ? repositories.repositories.filter((repository) => repository.status === 'present')
      : [];
  const unavailable =
    repositories.state === 'loaded'
      ? repositories.repositories.filter((repository) => repository.status === 'unavailable')
      : [];
  return (
    <SettingsScaffold
      title="Instructions"
      detail
      state={{ error, saving }}
      onRetry={() => {
        void loadInstructions(snapshot !== undefined);
      }}
    >
      <Text variant="bodySmall" tone="muted">
        Instructions are rules every agent in this project follows. Repositories can add their own
        for work in that repository.
      </Text>
      <ProjectInstructionsCard
        draft={draft}
        onChange={setDraft}
        loaded={snapshot !== undefined}
        saving={saving}
        changed={changed}
        onSave={() => {
          void save();
        }}
      />
      {present.length > 0 ? <SectionHeader title="From repositories" /> : null}
      {present.map((repository) => (
        <RepositoryInstructionsCard key={repository.id} repository={repository} />
      ))}
      {repositories.state === 'failed' || unavailable.length > 0 ? (
        <RepositoryLoadFailure
          names={
            repositories.state === 'failed' ? [] : unavailable.map((repository) => repository.name)
          }
          onRetry={() => {
            void loadRepositories();
          }}
        />
      ) : null}
    </SettingsScaffold>
  );
}

function ProjectInstructionsCard({
  draft,
  onChange,
  loaded,
  saving,
  changed,
  onSave,
}: {
  draft: string;
  onChange: (draft: string) => void;
  loaded: boolean;
  saving: boolean;
  changed: boolean;
  onSave: () => void;
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
        label="Project instructions"
        inline
        value={draft}
        onChangeText={onChange}
        placeholder="Add rules every agent in this project follows."
        multiline
        // Sized to the text, so the card reads as a document rather than a box.
        lines={{ min: Math.min(Math.max(3, draft.split('\n').length), 40), max: 40 }}
        maxLength={INSTRUCTIONS_LIMIT}
        disabled={!loaded || saving}
      />
      {changed ? <Button label="Save" fullWidth loading={saving} onPress={onSave} /> : null}
    </Card>
  );
}

function RepositoryInstructionsCard({
  repository,
}: {
  repository: Extract<RepositoryInstructions, { status: 'present' }>;
}) {
  const { theme } = useUnistyles();
  return (
    <Card stacked divided>
      <CardHead
        leading={{
          element: <CodeHostIcon provider={repository.kind} color={theme.colors.action} />,
        }}
        title={repository.name}
        subtitle={repository.path}
        trailing={<StatusTag intent="optional" label="Read only" />}
      />
      <Text variant="bodySmall" tone="muted">
        {repository.instructions}
      </Text>
      {repository.truncated ? (
        <Text variant="footnote" tone="faint">
          Shortened here. The full file is in the repository.
        </Text>
      ) : null}
    </Card>
  );
}

function RepositoryLoadFailure({ names, onRetry }: { names: string[]; onRetry: () => void }) {
  return (
    <>
      <Text variant="footnote" tone="faint">
        {names.length === 0
          ? 'Repository instructions could not be loaded.'
          : `Could not load AGENTS.md from ${names.join(', ')}.`}
      </Text>
      <Button label="Try again" variant="secondary" size="compact" onPress={onRetry} />
    </>
  );
}
