// The server's machine at a glance, last on Home: one row with CPU, memory and
// disk that opens to CPU and memory with their last few minutes and the disk
// that holds Verity's data. A disk that fills
// over days shows up here long before anything fails. Administrators only; for
// anyone else the server refuses and nothing is shown.
import { usedPercent, VerityApiError, type HostResources as Resources } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Icon } from '../Icon';
import { Group, ResourceFigure, ResourceMeter, Row } from '../ui';

/** Readings kept for the history strips: five minutes at the default interval. */
export const HISTORY_SLOTS = 30;

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}`;
const amount = (used: { usedBytes: number; totalBytes: number }) =>
  `${gigabytes(used.usedBytes)} / ${gigabytes(used.totalBytes)} GB`;

const spokenShare = (name: string, share: number | null) =>
  share === null ? `${name} not measured` : `${name} ${Math.round(share)} percent`;
/** The row is one element for VoiceOver, so it names every figure itself. */
const spoken = (cpu: number | null, memory: number | null, disk: number | null | undefined) =>
  ['Server', spokenShare('CPU', cpu), spokenShare('RAM', memory)]
    .concat(disk === undefined ? [] : [spokenShare('Disk', disk)])
    .join(', ');

type History = { cpu: (number | null)[]; memory: (number | null)[] };
/** One shared empty history: resetting to it again is no state change. */
const NO_HISTORY: History = { cpu: [], memory: [] };
const append = (list: (number | null)[], value: number | null) =>
  [...list, value].slice(-HISTORY_SLOTS);
// At module scope: a default created per render would restart the polling
// effect after every reading and turn the 10-second refresh into a busy loop.
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
  const [history, setHistory] = useState<History>(NO_HISTORY);
  // Collapsed by default: one quiet row at the end of Home. The history keeps
  // being collected meanwhile, so the strips are filled when it is opened.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A new loader is a new server: its figures must not stand in for, or be
    // charted after, those of the previous one.
    setResources(null);
    setHistory(NO_HISTORY);
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
            setHistory(NO_HISTORY);
            return;
          }
          // Anything else is transient: keep the last reading and try again.
          // The missed reading leaves an empty slot, so the strips keep
          // covering the last five minutes.
          setHistory((previous) => ({
            cpu: append(previous.cpu, null),
            memory: append(previous.memory, null),
          }));
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
  return (
    // The room above belongs to the widget, so Home has no gap when it is hidden.
    <View style={styles.spaced} testID="host-resources">
      <HostResourcesCard
        resources={resources}
        history={history}
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
      />
    </View>
  );
}

/**
 * One reading with the history collected so far, drawn as the Home card:
 * collapsed, a single row with the three figures; expanded, a meter each.
 */
export function HostResourcesCard({
  resources,
  history,
  expanded,
  onToggle,
}: {
  resources: Resources;
  history: { cpu: readonly (number | null)[]; memory: readonly (number | null)[] };
  expanded: boolean;
  onToggle: () => void;
}) {
  const { theme } = useUnistyles();
  const memory = usedPercent(resources.memory);
  const disk = resources.disk === null ? null : usedPercent(resources.disk);
  return (
    <Group>
      <View>
        <Row
          title="Server"
          subtitle={expanded ? 'Live · last 5 minutes' : undefined}
          leading={{ icon: 'server', quiet: true }}
          onPress={onToggle}
          expanded={expanded}
          accessibilityHint={expanded ? 'Collapse details' : 'Expand details'}
          // Collapsed, the figures take the line under the title: beside it,
          // the trailing side is capped and would cut the last one off.
          tag={
            expanded ? undefined : (
              <View style={styles.figures} testID="host-figures">
                <ResourceFigure icon="cpu" label="CPU" share={resources.cpu.percent} />
                <ResourceFigure icon="layers" label="RAM" share={memory} />
                {resources.disk === null ? null : (
                  <ResourceFigure icon="hard-drive" label="Disk" share={disk} />
                )}
              </View>
            )
          }
          accessibilityLabel={spoken(
            resources.cpu.percent,
            memory,
            resources.disk === null ? undefined : disk,
          )}
          trailing={
            <Icon
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={theme.colors.textMuted}
            />
          }
        />
        {expanded ? (
          <View style={styles.meters}>
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
              share={memory}
              history={history.memory}
              slots={HISTORY_SLOTS}
            />
            {resources.disk === null ? null : (
              <ResourceMeter
                testID="host-disk"
                icon="hard-drive"
                label={`Disk · ${amount(resources.disk)}`}
                share={disk}
              />
            )}
          </View>
        ) : null}
      </View>
    </Group>
  );
}

const styles = StyleSheet.create((theme) => ({
  spaced: { paddingTop: theme.spacing.lg },
  figures: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg },
  meters: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.md,
  },
}));
