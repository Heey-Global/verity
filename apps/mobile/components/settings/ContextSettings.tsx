import { useCallback, useEffect, useMemo, useState } from 'react';
import { createVerityClient } from '../../lib/client';
import { Button, TextField } from '../ui';
import { SettingsGroup, SettingsMessage, SettingsPanel, SettingsScaffold } from './SettingsChrome';

type Snapshot = { instructions: string; memory: string; revision: number | string };

/** Saving one field preserves the other from the same revision; conflicts keep the draft. */
export function ContextSettings({
  projectId,
  kind,
}: {
  projectId?: string;
  kind: 'instructions' | 'memory';
}) {
  const client = useMemo(() => createVerityClient(), []);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const title = kind === 'instructions' ? 'Instructions' : 'Memory';
  const load = useCallback(async () => {
    if (!client) return;
    try {
      let next: Snapshot;
      if (!projectId) next = await client.getUserContext();
      else if (kind === 'instructions')
        next = { ...(await client.getProjectInstructions(projectId)), memory: '' };
      else {
        next = { ...(await client.getProjectMemory(projectId)), instructions: '' };
      }
      setSnapshot(next);
      setDraft(next[kind]);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load context');
    }
  }, [client, projectId, kind]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (value: string) => {
    if (!client || !snapshot || saving) return;
    setSaving(true);
    try {
      let next: Snapshot;
      if (!projectId)
        next = await client.replaceUserContext({
          instructions: snapshot.instructions,
          memory: snapshot.memory,
          [kind]: value,
          revision: Number(snapshot.revision),
        });
      else if (kind === 'instructions')
        next = {
          ...(await client.replaceProjectInstructions(projectId, {
            instructions: value,
            revision: String(snapshot.revision),
          })),
          memory: '',
        };
      else {
        next = {
          ...(await client.replaceProjectMemory(projectId, {
            memory: value,
            revision: String(snapshot.revision),
          })),
          instructions: '',
        };
      }
      setSnapshot(next);
      setDraft(next[kind]);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save context');
    } finally {
      setSaving(false);
    }
  };
  if (!client)
    return (
      <SettingsMessage
        screenTitle={title}
        title="Server unavailable"
        subtitle="Connect to your Verity server to edit context."
      />
    );
  const limit = kind === 'instructions' ? 12_000 : 8_000;
  return (
    <SettingsScaffold
      title={title}
      detail
      state={{ error, saving }}
      onRetry={() => {
        void load();
      }}
    >
      <SettingsGroup
        title={projectId ? `Project ${title}` : `Personal ${title}`}
        description={
          kind === 'instructions'
            ? projectId
              ? 'Rules for this project. Repository AGENTS.md remains developer-owned.'
              : 'Your rules across projects. Visible only to you.'
            : 'Facts learned by the agent. Review, edit or clear them here. Clearing does not erase past conversations.'
        }
      >
        <SettingsPanel>
          <TextField
            label={title}
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={limit}
            disabled={!snapshot || saving}
            labelAccessory={undefined}
          />
          <Button
            label="Save"
            disabled={!snapshot || saving || draft === snapshot[kind]}
            onPress={() => {
              void save(draft);
            }}
          />
          <Button
            label={`Clear ${title}`}
            disabled={!snapshot || saving || snapshot[kind].length === 0}
            onPress={() => {
              void save('');
            }}
          />
        </SettingsPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
