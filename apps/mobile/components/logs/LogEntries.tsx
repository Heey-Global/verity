import type { VerityClient } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { Row, Text } from '../ui';
import { Disclosure } from '../ui/Disclosure';
import { EventRow } from './EventRow';
import { CodeBlock } from '../ui/CodeBlock';
import { auditDate, auditTime } from '../../lib/auditLabels';

type Logs = Awaited<ReturnType<VerityClient['systemLogs']>>;
export type LogEntry = Logs['entries'][number];
export type Source = 'server' | 'host';
const SOURCE_NAMES = { server: 'Server', host: 'Host' };
const HOST_LABELS: Record<string, string> = {
  runtime_error: 'Container runtime error',
  die: 'Container exited',
  oom: 'Out-of-memory event',
  oom_kill: 'Process killed after memory exhaustion',
  kernel_oom: 'Kernel out-of-memory event',
};
function eventTitle(entry: LogEntry, source: Source): string {
  if (source === 'host') {
    const code = entry.code ?? /^\w+:\s*([^\s(]+)/u.exec(entry.text)?.[1];
    return (code && HOST_LABELS[code]) || 'Host event';
  }
  try {
    const value = JSON.parse(entry.text) as { msg?: unknown; message?: unknown };
    const message = value.msg ?? value.message;
    if (typeof message === 'string' && message.trim()) return message;
  } catch {
    /* Unstructured messages remain readable as text. */
  }
  return entry.text;
}
const PROBLEM_CODES = new Set(['oom', 'oom_kill', 'kernel_oom']);
export function SystemEventRow({ entry, source }: { entry: LogEntry; source: Source }) {
  const title = eventTitle(entry, source);
  const exited = entry.exitCode !== undefined;
  const severity = exited
    ? `Exit ${entry.exitCode}`
    : entry.level
      ? ({ error: 'Error', warning: 'Warning', info: 'Info' }[entry.level] ?? entry.level)
      : undefined;
  return (
    <EventRow
      message={title}
      context={source === 'host' && title === 'Host event' ? entry.text : undefined}
      at={entry.at}
      source={SOURCE_NAMES[source]}
      severity={severity}
      problem={
        entry.level === 'error' ||
        (exited && entry.exitCode !== 0) ||
        (entry.code !== undefined && PROBLEM_CODES.has(entry.code))
      }
      original={JSON.stringify(entry, null, 2)}
    />
  );
}

const REASONS: Record<string, string> = {
  not_configured: 'Log access for this source is not configured.',
  container_not_found: 'The current server container could not be found.',
  access_denied: 'Docker denied access to the server logs.',
  docker_unreachable: 'The Docker service could not be reached.',
  read_failed: 'The source could not be read.',
};
export function SourceStatus({
  source,
  logs,
  failed,
  onRetry,
}: {
  source: Source;
  logs: Logs | undefined;
  failed: boolean;
  onRetry: () => void;
}) {
  const name = SOURCE_NAMES[source];
  const summary = failed
    ? 'Could not load this source.'
    : !logs
      ? 'Loading…'
      : logs.state !== 'available'
        ? REASONS[logs.reason ?? (logs.state === 'failed' ? 'read_failed' : 'not_configured')]
        : [
            logs.entries.length === 0
              ? 'No entries in this window'
              : `${logs.entries.length} ${logs.entries.length === 1 ? 'entry' : 'entries'} loaded`,
            logs.stale ? 'snapshot is stale' : '',
            logs.truncated ? 'partial history' : '',
          ]
            .filter(Boolean)
            .join(' · ');
  return (
    <Disclosure title={name} subtitle={summary}>
      <Text variant="footnote">{summary}</Text>
      <Text variant="footnote">
        {source === 'server'
          ? 'Current container output only. Docker controls retention; replacing the container can remove its history. Up to 1,000 lines / 64 KiB are loaded.'
          : 'Classified host signals, not complete journal logs. Severity is not recorded.'}
      </Text>
      {logs ? (
        <Text variant="footnote">
          Requested: {auditDate(logs.window.since)} {auditTime(logs.window.since)} –{' '}
          {auditDate(logs.window.until)} {auditTime(logs.window.until)}
        </Text>
      ) : null}
      {logs?.sourceWindow ? (
        <Text variant="footnote">
          Coverage: {auditDate(logs.sourceWindow.since)} {auditTime(logs.sourceWindow.since)} –{' '}
          {auditDate(logs.sourceWindow.until)} {auditTime(logs.sourceWindow.until)}
        </Text>
      ) : null}
      {logs?.sources ? (
        <Text variant="footnote">
          {Object.entries(logs.sources)
            .map(([key, state]) => `${key}: ${state}`)
            .join(' · ')}
        </Text>
      ) : null}
      <Row title={`Retry ${name.toLowerCase()} logs`} onPress={onRetry} />
    </Disclosure>
  );
}
const BUILD_STATES = {
  pending: 'The build is still running.',
  expired: 'The seven-day build diagnostic retention period has ended.',
  unavailable:
    'No retained output is available. This build may predate capture, or its output was removed by the storage limit.',
  failed: 'The build output could not be read.',
  available: '',
};
export function BuildOutput({
  client,
  operationId,
  status,
}: {
  client: VerityClient;
  operationId: string;
  status: string;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<VerityClient['buildDiagnostic']>>>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (status === 'succeeded') return;
    setResult(undefined);
    setFailed(false);
    void Promise.resolve()
      .then(() => client.buildDiagnostic(operationId))
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, operationId, status, retry]);
  if (status === 'succeeded')
    return <Row title="Build output" subtitle="Successful build output is not archived." />;
  const canRetry = failed || result?.state === 'failed';
  if (!result?.diagnostic)
    return (
      <Row
        title="Build output"
        subtitle={
          canRetry
            ? 'Could not read build output. Tap to retry.'
            : result
              ? BUILD_STATES[result.state]
              : 'Loading build output…'
        }
        onPress={canRetry ? () => setRetry(retry + 1) : undefined}
      />
    );
  const output = result.diagnostic;
  return (
    <Disclosure
      title="Build output"
      subtitle={`Image build · ${auditDate(output.recordedAt)} · ${auditTime(output.recordedAt)}${output.truncated ? ' · Output shortened' : ''}`}
    >
      <Text variant="footnote">
        Sanitized failure output · retained for up to seven days, subject to storage limits.
      </Text>
      <CodeBlock text={output.text} />
    </Disclosure>
  );
}
