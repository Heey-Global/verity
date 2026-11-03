import { useState } from 'react';
import type { AuditEvent } from '@verity/mobile';
import { router, type Href } from 'expo-router';
import { Button, LogRow, Sheet, Text } from '../ui';
import { CodeBlock } from '../ui/CodeBlock';
import { auditDate, logTime } from '../../lib/auditLabels';

const EVENT_TITLES: Record<string, string> = {
  'build.requested': 'Image build requested',
  'build.succeeded': 'Image build succeeded',
  'build.failed': 'Image build failed',
  'image.removed': 'Image removed',
  'project.deleted': 'Project deleted',
  'audit.write_gap': 'Audit events could not be recorded',
};
export function EventRow({
  message,
  context,
  at,
  source,
  severity,
  problem = false,
  tag,
  original,
  operationId,
}: {
  message: string;
  context?: string | undefined;
  at: string | null;
  source: string;
  severity?: string | undefined;
  problem?: boolean;
  tag?: string | undefined;
  original: string;
  operationId?: string;
}) {
  const [open, setOpen] = useState(false);
  const dated = at !== null && Number.isFinite(Date.parse(at));
  const time = dated ? logTime(at) : 'Time not recorded';
  return (
    <>
      <LogRow
        time={time}
        source={source}
        severity={severity}
        problem={problem}
        tag={tag}
        message={message}
        context={context}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <Sheet visible={open} title={message} onClose={() => setOpen(false)}>
          <Text variant="footnote">
            {[dated ? `${auditDate(at)} · ${time}` : time, source, severity]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {context ? <Text variant="subtitle">{context}</Text> : null}
          <CodeBlock text={original} />
          {operationId ? (
            <Button
              label={tag ? 'Open operation and build output' : 'Open operation'}
              onPress={() => {
                setOpen(false);
                router.push(`/settings/audit-logs/${encodeURIComponent(operationId)}` as Href);
              }}
            />
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}
export function AuditEventRow({ event }: { event: AuditEvent }) {
  const failed = event.kind === 'build.failed';
  const gap = event.kind === 'audit.write_gap';
  return (
    <EventRow
      message={EVENT_TITLES[event.kind] ?? event.kind}
      context={event.project?.label ?? event.imageId ?? undefined}
      at={event.recordedAt}
      source="Audit"
      severity={failed ? 'Failed' : gap ? 'Error' : undefined}
      problem={failed || gap}
      tag={failed ? 'Output' : undefined}
      original={JSON.stringify(event, null, 2)}
      operationId={event.operationId}
    />
  );
}
