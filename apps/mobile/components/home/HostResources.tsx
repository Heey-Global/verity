// The server's machine at a glance, closing the Home project list: CPU, memory
// and the disk that holds Verity's data. A disk that fills over days shows up
// here long before anything fails. Administrators only; for anyone else the
// server refuses and nothing is shown.
import { usedPercent, type HostResources as Resources } from '@verity/mobile';
import { useEffect, useState } from 'react';

import { createVerityClient } from '../../lib/client';
import { Group, Row, Text } from '../ui';
import { Disclosure } from '../ui/Disclosure';

/** From here a value reads as a warning. */
const BUSY_PERCENT = 90;

const percent = (value: number | null) => (value === null ? '–' : `${Math.round(value)} %`);
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function hostResourcesSummary(resources: Resources): string {
  const parts = [
    `CPU ${percent(resources.cpu.percent)}`,
    `RAM ${percent(usedPercent(resources.memory))}`,
  ];
  if (resources.disk) parts.push(`Disk ${percent(usedPercent(resources.disk))}`);
  return parts.join(' · ');
}

function Value({ share, detail }: { share: number | null; detail: string }) {
  return (
    <Text variant="subtitle" tone={share !== null && share >= BUSY_PERCENT ? 'attention' : 'muted'}>
      {`${percent(share)} · ${detail}`}
    </Text>
  );
}

export function HostResources({
  load = () => {
    const client = createVerityClient();
    return client === null ? null : client.getHostResources();
  },
  intervalMs = 15_000,
}: {
  /** Null when there is no server to ask. */
  load?: () => Promise<Resources> | null;
  intervalMs?: number;
}) {
  const [resources, setResources] = useState<Resources | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    const poll = () => {
      const request = load();
      if (request === null) return;
      request
        .then((next) => {
          if (!active) return;
          loaded = true;
          setResources(next);
          timer = setTimeout(poll, intervalMs);
        })
        .catch(() => {
          // A refusal before anything loaded (not an administrator) ends it; a
          // failure after that keeps the last reading and tries again.
          if (active && loaded) timer = setTimeout(poll, intervalMs);
        });
    };
    poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, intervalMs]);

  if (resources === null) return null;
  const memory = usedPercent(resources.memory);
  const disk = resources.disk === null ? null : usedPercent(resources.disk);
  return (
    <Group>
      <Disclosure title="Server" subtitle={hostResourcesSummary(resources)}>
        <Row
          title="CPU"
          trailing={<Value share={resources.cpu.percent} detail={`${resources.cpu.cores} cores`} />}
        />
        <Row
          title="Memory"
          trailing={
            <Value
              share={memory}
              detail={`${gigabytes(resources.memory.usedBytes)} of ${gigabytes(resources.memory.totalBytes)}`}
            />
          }
        />
        {resources.disk === null ? null : (
          <Row
            title="Disk"
            trailing={
              <Value
                share={disk}
                detail={`${gigabytes(resources.disk.usedBytes)} of ${gigabytes(resources.disk.totalBytes)}`}
              />
            }
          />
        )}
      </Disclosure>
    </Group>
  );
}
