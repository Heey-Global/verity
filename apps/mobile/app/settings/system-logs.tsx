import type { VerityClient } from '@verity/mobile';
import { useFocusEffect, useLocalSearchParams, router, type Href } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { FilterChips, Row, Text } from '../../components/ui';
import { createVerityClient } from '../../lib/client';

type Logs = Awaited<ReturnType<VerityClient['systemLogs']>>;
type Build = Awaited<ReturnType<VerityClient['buildDiagnostic']>>;
const states = {
  pending: 'The build is still running.',
  expired: 'The seven-day build diagnostic retention period has ended.',
  unavailable:
    'No retained output is available. It may predate diagnostic capture or have been removed by the storage limit.',
  failed: 'The diagnostic source could not be read.',
  available: '',
};

export default function SystemLogsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage title="Not connected" subtitle="Connect to your server to read logs." />
    );
  return <SystemLogsView client={client} />;
}

export function SystemLogsView({ client }: { client: VerityClient }) {
  const { operationId } = useLocalSearchParams<{ operationId?: string }>();
  const [source, setSource] = useState<'server' | 'host'>('server');
  const [hours, setHours] = useState<'1' | '24'>('1');
  const [level, setLevel] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [logs, setLogs] = useState<Logs>();
  const [build, setBuild] = useState<Build>();
  const [error, setError] = useState<string>();
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    setError(undefined);
    setLogs(undefined);
    setBuild(undefined);
    const read = async () => {
      if (operationId) {
        const result = await client.buildDiagnostic(operationId);
        if (latest.current === request) setBuild(result);
      } else {
        const until = new Date();
        const result = await client.systemLogs({
          source,
          level: source === 'host' ? 'all' : level,
          since: new Date(until.getTime() - Number(hours) * 3600_000).toISOString(),
          until: until.toISOString(),
        });
        if (latest.current === request) setLogs(result);
      }
    };
    void read().catch(() => {
      if (latest.current === request)
        setError(
          'Could not read logs. Administrator access and a server with diagnostic support are required.',
        );
    });
    return () => {
      latest.current += 1;
    };
  }, [client, operationId, source, hours, level]);
  useFocusEffect(load);
  return (
    <SettingsScaffold
      title={operationId ? 'Build output' : 'Logs'}
      detail
      state={{ error, saving: false }}
      onRetry={load}
    >
      {!operationId ? (
        <>
          <FilterChips
            accessibilityLabel="Log view"
            value="system"
            options={[
              { value: 'audit', label: 'Audit' },
              { value: 'system', label: 'System' },
            ]}
            onChange={(value) => {
              if (value === 'audit') router.replace('/settings/audit-logs' as Href);
            }}
          />
          <FilterChips
            accessibilityLabel="Log source"
            value={source}
            onChange={setSource}
            options={[
              { value: 'server', label: 'Server container' },
              { value: 'host', label: 'Host events' },
            ]}
          />
          <FilterChips
            accessibilityLabel="Time window"
            value={hours}
            onChange={setHours}
            options={[
              { value: '1', label: 'Last hour' },
              { value: '24', label: 'Last 24 hours' },
            ]}
          />
          {source === 'server' ? (
            <FilterChips
              accessibilityLabel="Severity"
              value={level}
              onChange={setLevel}
              options={[
                { value: 'all', label: 'All levels' },
                { value: 'error', label: 'Errors' },
                { value: 'warning', label: 'Warnings' },
                { value: 'info', label: 'Info' },
              ]}
            />
          ) : (
            <Text variant="footnote">
              Host events are classified signals; journal text and severity are not available.
            </Text>
          )}
        </>
      ) : null}
      {!operationId && source === 'server' ? (
        <Text variant="footnote">
          Output comes from the current server container. Docker controls retention; replacing the
          container can remove its history. Severity filters apply to structured server messages.
        </Text>
      ) : null}
      {operationId ? (
        <Text variant="footnote">
          Build output is sanitized and retained for up to seven days, subject to storage limits.
        </Text>
      ) : null}
      {build ? (
        <SettingsGroup title="Build diagnostic">
          <SettingsListPanel>
            {build.diagnostic ? (
              <>
                <Row title="Phase" subtitle="Image build · build_failed" />
                <Row title="Captured" subtitle={build.diagnostic.recordedAt} />
                {build.diagnostic.truncated ? (
                  <Row
                    title="Output shortened"
                    subtitle="The retained output reached the per-build limit."
                  />
                ) : null}
                <Text variant="code" selectable>
                  {build.diagnostic.text}
                </Text>
              </>
            ) : (
              <Row title="Output unavailable" subtitle={states[build.state]} />
            )}
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
      {logs ? (
        <SettingsGroup title={source === 'server' ? 'Server output' : 'Host events'}>
          <SettingsListPanel>
            <Row
              title="Requested window"
              subtitle={`${logs.window.since} — ${logs.window.until}`}
            />
            {logs.sourceWindow ? (
              <Row
                title="Source coverage"
                subtitle={`${logs.sourceWindow.since} — ${logs.sourceWindow.until}`}
              />
            ) : null}
            {logs.sources ? (
              <Row
                title="Sources"
                subtitle={Object.entries(logs.sources)
                  .map(([name, state]) => `${name}: ${state}`)
                  .join(' · ')}
              />
            ) : null}
            {logs.state !== 'available' ? (
              <Row
                title="Source unavailable"
                subtitle={
                  logs.state === 'failed'
                    ? 'The source could not be read.'
                    : 'This source is not configured or has no snapshot.'
                }
              />
            ) : null}
            {logs.stale ? (
              <Row
                title="Stale snapshot"
                subtitle="These events may not include the latest activity."
              />
            ) : null}
            {logs.truncated ? (
              <Row
                title="Partial output"
                subtitle="The source limit was reached; earlier events may be missing."
              />
            ) : null}
            {logs.state === 'available' && !logs.entries.length ? (
              <Row title="No matching entries" />
            ) : null}
            {logs.entries.map((entry, index) => (
              <Text key={index} variant="code" selectable>
                {[entry.at, entry.text].filter(Boolean).join(' ')}
              </Text>
            ))}
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
    </SettingsScaffold>
  );
}
