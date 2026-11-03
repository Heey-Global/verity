import type { ProjectRecord, SessionSummary } from '@verity/mobile';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Button, Group, Row, SearchField, SectionHeader, Sheet, Text } from '../ui';

export interface AssignableMeeting {
  id: string;
  title: string | null;
  startedAt: number;
  people: number;
}

/** Projects a meeting can go to, most recently used first: the session list is in
 * creation order, so a project's newest session tells when it was last worked in. */
export function recentProjects(
  projects: ProjectRecord[],
  sessions: Pick<SessionSummary, 'projectId' | 'name'>[],
): Array<{ project: ProjectRecord; latestSession: string | null }> {
  const latest = new Map<string, string | null>();
  for (const session of sessions) {
    if (!session.projectId) continue;
    latest.delete(session.projectId);
    latest.set(session.projectId, session.name);
  }
  const rank = [...latest.keys()].reverse();
  return projects
    .filter((project) => project.kind !== 'control_plane' && !project.archived)
    .map((project) => ({ project, latestSession: latest.get(project.id) ?? null }))
    .sort((a, b) => {
      const ra = rank.indexOf(a.project.id);
      const rb = rank.indexOf(b.project.id);
      if (ra !== rb) return (ra === -1 ? Infinity : ra) - (rb === -1 ? Infinity : rb);
      return a.project.repo.localeCompare(b.project.repo);
    });
}

/**
 * Picks the project for a meeting that started without one (mockup: live meeting intake,
 * "Assign meeting"). There is no suggestion: one calendar account serves many projects,
 * so the operator always chooses. A tap assigns at once and the caller opens the meeting.
 */
export function AssignMeetingSheet({
  meeting,
  onClose,
  onAssigned,
  onDiscard,
}: {
  meeting: AssignableMeeting | null;
  onClose: () => void;
  onAssigned: (sessionId: string) => void;
  onDiscard: () => void;
}) {
  const [choices, setChoices] = useState<ReturnType<typeof recentProjects> | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = meeting !== null;

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setError(null);
    const client = createVerityClient();
    if (!client) return;
    let current = true;
    void Promise.all([client.listProjects(), client.listSessions()])
      .then(([projects, sessions]) => {
        if (current) setChoices(recentProjects(projects, sessions));
      })
      .catch(() => {
        if (current) setError('Could not load projects.');
      });
    return () => {
      current = false;
    };
  }, [visible]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = choices ?? [];
    if (!needle) return list.slice(0, 6);
    return list.filter(({ project }) =>
      `${project.owner}/${project.repo}`.toLowerCase().includes(needle),
    );
  }, [choices, query]);

  const assign = async (projectId: string) => {
    const client = createVerityClient();
    if (!meeting || !client || busy) return;
    setBusy(projectId);
    setError(null);
    try {
      const result = await client.assignLiveMeeting(meeting.id, { projectId });
      onAssigned(result.sessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not assign the meeting.');
    } finally {
      setBusy(null);
    }
  };

  const started = meeting
    ? new Date(meeting.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <Sheet
      visible={visible}
      title="Assign meeting"
      onClose={onClose}
      dismissible={busy === null}
      footer={
        <Button
          label="Discard meeting"
          icon="trash-2"
          variant="destructive"
          disabled={busy !== null}
          onPress={onDiscard}
          fullWidth
        />
      }
    >
      <View style={styles.body}>
        <Text variant="subtitle">
          {[
            meeting?.title || 'Online meeting',
            `since ${started}`,
            meeting && meeting.people > 0
              ? `${meeting.people} ${meeting.people === 1 ? 'person' : 'people'}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects"
          accessibilityLabel="Search projects"
        />
        {shown.length > 0 ? (
          <View>
            <SectionHeader title={query.trim() ? 'Projects' : 'Recent projects'} />
            <Group>
              {shown.map(({ project, latestSession }) => (
                <Row
                  key={project.id}
                  title={project.repo}
                  subtitle={latestSession ? `Latest session: ${latestSession}` : undefined}
                  navigates
                  disabled={busy !== null}
                  accessibilityHint="Creates a session there and opens the meeting"
                  onPress={() => void assign(project.id)}
                />
              ))}
            </Group>
          </View>
        ) : choices !== null ? (
          <Text variant="footnote">No project matches.</Text>
        ) : null}
        {error ? (
          <Text variant="footnote" tone="attention">
            {error}
          </Text>
        ) : (
          <Text variant="footnote">
            Tap a project to create a session there and open the meeting with everything said so
            far.
          </Text>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing.md },
}));
