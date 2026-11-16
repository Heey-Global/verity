import { useCallback, useEffect, useMemo, useState } from 'react';
import { createVerityClient } from '../../lib/client';
import { Button, TextField, useConfirm } from '../ui';
import { ProjectInstructionsSettings } from './ProjectInstructionsSettings';
import { SettingsGroup, SettingsMessage, SettingsPanel, SettingsScaffold } from './SettingsChrome';

type Snapshot = { instructions: string; memory: string; revision: number | string };
type ContextSettingsProps = { projectId?: string; kind: 'instructions' | 'memory' };

export function ContextSettings(props: ContextSettingsProps) {
  // Each scope owns its draft and requests. Navigation must never reuse either.
  if (props.projectId !== undefined && props.kind === 'instructions')
    return <ProjectInstructionsSettings key={props.projectId} projectId={props.projectId} />;
  return <ContextSettingsEditor key={JSON.stringify([props.projectId, props.kind])} {...props} />;
}

/** Personal context and project Memory. Saving one field preserves the other from the
 *  same revision; conflicts keep the draft. Project Instructions have their own screen. */
function ContextSettingsEditor({ projectId, kind }: ContextSettingsProps) {
  const client = useMemo(() => createVerityClient(), []);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirm, confirmSheet] = useConfirm();
  const title = kind === 'instructions' ? 'Instructions' : 'Memory';
  const load = useCallback(
    async (preserveDraft = false) => {
      if (!client) return;
      try {
        let next: Snapshot;
        if (!projectId) next = await client.getUserContext();
        else {
          next = { ...(await client.getProjectMemory(projectId)), instructions: '' };
        }
        setSnapshot(next);
        if (!preserveDraft) setDraft(next[kind]);
        setError(undefined);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not load context');
      }
    },
    [client, projectId, kind],
  );
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
  const unchanged = !snapshot || draft === snapshot[kind];
  return (
    <SettingsScaffold
      title={title}
      detail
      state={{ error, saving }}
      onRetry={() => {
        void load(!!snapshot);
      }}
      // The screen's one main action, pinned clear of the home indicator (§ 5.1).
      footer={
        <Button
          label="Save"
          fullWidth
          loading={saving}
          disabled={!snapshot || unchanged}
          onPress={() => {
            void save(draft);
          }}
        />
      }
    >
      <SettingsGroup
        title={projectId ? `Project ${title}` : `Personal ${title}`}
        description={
          kind === 'instructions'
            ? 'Your rules across projects. Visible only to you.'
            : 'Facts learned by the agent. Review, edit or clear them here. Clearing does not erase past conversations.'
        }
      >
        <SettingsPanel>
          <TextField
            label={title}
            value={draft}
            onChangeText={setDraft}
            multiline
            lines={{ min: 8, max: 24 }}
            maxLength={limit}
            disabled={!snapshot || saving}
            labelAccessory={undefined}
          />
          {snapshot && snapshot[kind].length > 0 ? (
            <Button
              label={`Clear ${title}`}
              variant="destructive"
              size="compact"
              disabled={saving}
              onPress={() =>
                confirm({
                  title: `Clear ${title}?`,
                  message:
                    kind === 'memory'
                      ? 'Agents no longer see these facts. Past conversations stay as they are.'
                      : 'Agents no longer follow these rules. This cannot be undone.',
                  confirmLabel: 'Clear',
                  destructive: true,
                  onConfirm: () => save(''),
                })
              }
            />
          ) : null}
        </SettingsPanel>
      </SettingsGroup>
      {confirmSheet}
    </SettingsScaffold>
  );
}
