import { Linking } from 'react-native';
import { useCallback, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { SettingsScaffold, SettingsGroup } from '../../components/settings/SettingsChrome';
import { Button, Text, Group } from '../../components/ui';
import { createVerityClient } from '../../lib/client';
import { useScanResource } from '../../lib/useScanResource';

function evidenceLink(raw: string): string | undefined {
  try {
    const evidence = JSON.parse(raw) as { url?: unknown; status?: { url?: unknown } } | null;
    const candidate = evidence?.status?.url ?? evidence?.url;
    if (typeof candidate === 'string' && new URL(candidate).protocol === 'https:') return candidate;
  } catch {
    /* An unavailable evidence link must not hide the incident. */
  }
  return undefined;
}

export default function RepairSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(async () => {
      if (!client) throw new Error('Connect to a server first.');
      const projects = (await client.listProjects()).filter(
        (p) => !p.kind || p.kind === 'github' || p.kind === 'forgejo',
      );
      const rows = [];
      for (const project of projects)
        rows.push({ project, ...(await client.projectRepairs(project.id)) });
      return { rows, qa: await client.qaSettings() };
    }, [client]),
  );
  const act = async (work: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await work();
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not update supervision.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsScaffold
      title="QA · CI supervision"
      detail
      state={{ error: resource.error, saving }}
      onRetry={resource.reload}
    >
      <Text variant="footnote">
        Choose access and repair mode in each project’s settings. Monitoring shares status reads
        with PR bars. Automatic repair creates ordinary project sessions with existing project
        rights and approval gates; it does not provide restricted repository permissions.
      </Text>
      <SettingsGroup title="QA">
        <Text>
          {resource.data?.qa.enabled ? 'Enabled' : 'Disabled'} ·{' '}
          {resource.data?.qa.health ?? 'Not loaded'}
        </Text>
        <Text variant="footnote">
          Disabled by default. Turning QA off stops background monitoring, automatic AI reviews and
          new repair assignments. Running repair sessions continue; open a session to stop it. PR
          bars remain available.
        </Text>
        <Button
          label={resource.data?.qa.enabled ? 'Disable QA' : 'Enable QA'}
          disabled={saving || !resource.data}
          onPress={() => void act(() => client!.qaSettings(!resource.data!.qa.enabled))}
        />
        {resource.data?.qa.session_id ? (
          <Button
            variant="secondary"
            label="Open QA activity"
            onPress={() => router.push(`/session/${resource.data!.qa.session_id}`)}
          />
        ) : null}
      </SettingsGroup>
      {resource.data?.rows.map(({ project, mandate, incidents }) => (
        <SettingsGroup key={project.id} title={`${project.owner}/${project.repo}`}>
          <Text>
            {mandate?.mode ?? 'off'} · {mandate?.health ?? 'Not enabled'}
          </Text>
          <Text variant="footnote">
            {mandate?.checked_at
              ? `Last checked: ${new Date(mandate.checked_at).toLocaleString()}`
              : 'No completed check'}
          </Text>
          <Button
            variant="secondary"
            label="Project settings"
            onPress={() => router.push(`/project/${project.id}/settings/model`)}
          />
          {incidents?.map((incident) => (
            <Group key={incident.id}>
              <Text>
                {incident.resource} ·{' '}
                {incident.state === 'blocked'
                  ? incident.owner_session_id
                    ? 'Needs attention · worker still assigned'
                    : 'Needs a decision'
                  : incident.state === 'awaiting_merge'
                    ? 'Fix prepared · awaiting merge'
                    : incident.state}{' '}
                · {incident.attempts}/2 attempts
              </Text>
              {evidenceLink(incident.evidence) ? (
                <Button
                  variant="text"
                  label="Open PR or workflow"
                  onPress={() => {
                    void Linking.openURL(evidenceLink(incident.evidence)!).catch(() =>
                      resource.setError('Could not open the forge link.'),
                    );
                  }}
                />
              ) : null}
              {incident.last_session_id ? (
                <Button
                  variant="secondary"
                  label="Open repair session"
                  onPress={() => router.push(`/session/${incident.last_session_id}`)}
                />
              ) : null}
              {incident.last_session_id ? (
                <Button
                  variant="secondary"
                  label="Take over"
                  accessibilityHint="Pause new automatic repairs and open the session. Running work continues."
                  disabled={saving}
                  onPress={() =>
                    void act(async () => {
                      await client!.projectRepairs(project.id, 'off');
                      router.push(`/session/${incident.last_session_id}`);
                    })
                  }
                />
              ) : null}
              {['blocked', 'verifying'].includes(incident.state) &&
              !incident.owner_session_id &&
              incident.attempts < 2 ? (
                <Button
                  variant="secondary"
                  label="Retry repair"
                  disabled={saving}
                  onPress={() => void act(() => client!.retryRepair(project.id, incident.id))}
                />
              ) : null}
            </Group>
          ))}
        </SettingsGroup>
      ))}
    </SettingsScaffold>
  );
}
