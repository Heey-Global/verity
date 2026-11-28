// The server's machine at a glance, last on Home: CPU and memory with their
// last few minutes, and the disk that holds Verity's data. A disk that fills
// over days shows up here long before anything fails. Administrators only; for
// anyone else the server refuses and nothing is shown.
import { usedPercent, VerityApiError, type HostResources as Resources } from '@verity/mobile';
import { useEffect, useState } from 'react';

import { createVerityClient } from '../../lib/client';
import { Card, CardHead, ResourceMeter } from '../ui';

/** Readings kept for the history strips: five minutes at the default interval. */
export const HISTORY_SLOTS = 30;

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}`;
const amount = (used: { usedBytes: number; totalBytes: number }) =>
  `${gigabytes(used.usedBytes)} / ${gigabytes(used.totalBytes)} GB`;

type History = { cpu: (number | null)[]; memory: (number | null)[] };
const append = (list: (number | null)[], value: number | null) =>
  [...list, value].slice(-HISTORY_SLOTS);
// At module scope: a default created per render would restart the polling
// effect after every reading and turn the 15-second refresh into a busy loop.
function loadFromActiveServer(): Promise<Resources> | null {
  const client = createVerityClient();
  return client === null ? null : client.getHostResources();
}

export function HostResources({
  load = loadFromActiveServer,
  intervalMs = 10_000,
}: {
  /** Null when there is no server to ask. */
  load?: () => Promise<Resources> | null;
  intervalMs?: number;
}) {
  const [resources, setResources] = useState<Resources | null>(null);
  const [history, setHistory] = useState<History>({ cpu: [], memory: [] });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      const request = load();
      if (request === null) return;
      request
        .then((next) => {
          if (!active) return;
          setResources(next);
          setHistory((previous) => ({
            cpu: append(previous.cpu, next.cpu.percent),
            memory: append(previous.memory, usedPercent(next.memory)),
          }));
          timer = setTimeout(poll, intervalMs);
        })
        .catch((error: unknown) => {
          if (!active) return;
          // Refused: not (or no longer) an administrator. Drop any reading
          // rather than leave stale figures up, and stop asking.
          if (error instanceof VerityApiError && error.status === 403) {
            setResources(null);
            setHistory({ cpu: [], memory: [] });
            return;
          }
          // Anything else is transient: keep the last reading and try again.
          timer = setTimeout(poll, intervalMs);
        });
    };
    poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, intervalMs]);

  if (resources === null) return null;
  return <HostResourcesCard resources={resources} history={history} />;
}

/** One reading with the history collected so far, drawn as the Home card. */
export function HostResourcesCard({
  resources,
  history,
}: {
  resources: Resources;
  history: { cpu: readonly (number | null)[]; memory: readonly (number | null)[] };
}) {
  return (
    <Card stacked>
      <CardHead
        title="Server"
        subtitle="Live · last 5 minutes"
        leading={{ icon: 'server', quiet: true }}
      />
      <ResourceMeter
        testID="host-cpu"
        icon="cpu"
        label={`CPU · ${resources.cpu.cores} cores`}
        share={resources.cpu.percent}
        history={history.cpu}
        slots={HISTORY_SLOTS}
      />
      <ResourceMeter
        testID="host-memory"
        icon="layers"
        label={`RAM · ${amount(resources.memory)}`}
        share={usedPercent(resources.memory)}
        history={history.memory}
        slots={HISTORY_SLOTS}
      />
      {resources.disk === null ? null : (
        <ResourceMeter
          testID="host-disk"
          icon="hard-drive"
          label={`Disk · ${amount(resources.disk)}`}
          share={usedPercent(resources.disk)}
        />
      )}
    </Card>
  );
}
