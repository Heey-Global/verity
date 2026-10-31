import type { VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Button, Card, CardHead, Text, useConfirm } from '../ui';

type Status = Awaited<ReturnType<VerityClient['getStorageReclamation']>>;
export function StorageReclamation({ client }: { client: VerityClient }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirm, sheet] = useConfirm();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const value = await client.getStorageReclamation();
      if (version === generation.current) {
        setStatus(value);
        setError(null);
      }
    } catch {
      if (version === generation.current)
        setError('Storage maintenance is unavailable or requires administrator access.');
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const running = status?.state === 'running';
  const pending = status?.nativePending === true;
  useEffect(() => {
    if (!running && !pending) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [running, pending, refresh]);
  const result = status?.result;
  return (
    <>
      <Card stacked>
        <CardHead
          title="Host storage"
          subtitle="Reclaim unused resources across all projects on this server."
        />
        <Text>
          Removes eligible old containers and images, unchanged private dependencies in idle
          sessions, and verified unused native builder state. Local changes and active work remain
          protected.
        </Text>
        {error ? <Text>{error}</Text> : null}
        {running ? <Text>Reclamation is running…</Text> : null}
        {status?.error ? <Text>{status.error}</Text> : null}
        {result ? (
          <>
            <Text>{`${result.imagesRemoved} images, ${result.containersRemoved} containers and ${result.dependenciesRemoved} dependency installations removed.`}</Text>
            <Text>
              {result.filesystemFreeBytesChange === null
                ? 'Filesystem change unavailable.'
                : `Filesystem free-space change: ${(result.filesystemFreeBytesChange / 1024 ** 3).toFixed(1)} GiB. Other host activity can affect this measurement.`}
            </Text>
            <Text>{`${result.retainedPins.length} images retained. ${result.blockers.length} cleanup blockers.`}</Text>
            {result.retainedPins.slice(0, 20).map((pin) => (
              <Text key={pin.imageId}>{`${pin.imageId.slice(0, 19)}: ${pin.reason}`}</Text>
            ))}
            {result.blockers.slice(0, 20).map((reason, index) => (
              <Text key={index}>{reason}</Text>
            ))}
          </>
        ) : null}
        {pending ? (
          <Text>Host builder cleanup is pending; refreshes while this screen is open.</Text>
        ) : null}
        {status?.nativeBuildkit ? (
          <>
            <Text>{`Native builder: ${status.nativeBuildkit.state ?? 'inventory only'}.`}</Text>
            {status.nativeBuildkit.lastCompletedAt ? (
              <Text>{`Last native retirement: ${status.nativeBuildkit.lastCompletedAt}`}</Text>
            ) : null}
            {status.nativeBuildkit.filesystemFreedBytes != null ? (
              <Text>{`Native cleanup filesystem change: ${(status.nativeBuildkit.filesystemFreedBytes / 1024 ** 3).toFixed(1)} GiB.`}</Text>
            ) : null}
            {status.nativeBuildkit.blockers.map((reason, index) => (
              <Text key={index}>{reason}</Text>
            ))}
          </>
        ) : null}
        <Button
          label="Reclaim now"
          disabled={!status?.supported || running || submitting}
          loading={running || submitting}
          onPress={() =>
            confirm({
              title: 'Reclaim host storage?',
              confirmLabel: 'Reclaim now',
              message:
                'Run storage cleanup across all projects. Eligible unused builder state is permanently removed; active work and local modifications remain protected.',
              onConfirm: async () => {
                generation.current++;
                setSubmitting(true);
                try {
                  setStatus(await client.reclaimStorage());
                  setError(null);
                } catch {
                  setError('Could not start storage reclamation.');
                } finally {
                  setSubmitting(false);
                }
              },
            })
          }
        />
        <Button label="Refresh storage status" variant="secondary" onPress={() => void refresh()} />
      </Card>
      {sheet}
    </>
  );
}
