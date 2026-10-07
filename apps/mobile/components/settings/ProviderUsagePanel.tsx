// Subscription usage for one agent provider: the same five-hour and weekly
// quota readings the overview meters show, spelled out on the provider's own
// settings page.
import {
  overviewProviderLimitRows,
  quotaMeterLevel,
  type AgentLoginProvider,
  type ProviderLimitRow,
  type ProviderLimitState,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatResetDisplay } from '../../lib/time';

const PROVIDER_LABELS: Record<AgentLoginProvider, string> = { claude: 'Claude', codex: 'Codex' };

type UsageState =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; row: ProviderLimitRow | undefined };

export function ProviderUsagePanel({
  client,
  provider,
}: {
  client: VerityClient;
  provider: AgentLoginProvider;
}) {
  const [usage, setUsage] = useState<UsageState>({ kind: 'loading' });
  // The server caches the provider probes for minutes, so a read per visit is
  // as fresh as polling would be and never pushes the upstream usage endpoint
  // into its rate limit.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void client
        .listProviderLimits()
        .then((limits) => {
          if (!active) return;
          const row = overviewProviderLimitRows([], limits, Date.now()).find(
            (candidate) => candidate.providerLabel === PROVIDER_LABELS[provider],
          );
          setUsage({ kind: 'loaded', row });
        })
        .catch(() => {
          if (active) setUsage({ kind: 'failed' });
        });
      return () => {
        active = false;
      };
    }, [client, provider]),
  );

  if (usage.kind === 'loading') {
    return (
      <View style={styles.card}>
        <Text style={styles.empty}>Loading usage…</Text>
      </View>
    );
  }
  if (usage.kind === 'failed' || usage.row === undefined) {
    return (
      <View style={styles.card}>
        <Text style={styles.empty}>
          {usage.kind === 'failed' ? 'Usage could not be loaded.' : 'No usage reported yet.'}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <UsageMeter title="Current 5-hour window" window="five_hour" limit={usage.row.fiveHour} />
      <View style={styles.separator} />
      <UsageMeter title="This week" window="weekly" limit={usage.row.weekly} />
    </View>
  );
}

function UsageMeter({
  title,
  window,
  limit,
}: {
  title: string;
  window: 'five_hour' | 'weekly';
  limit: ProviderLimitState | null;
}) {
  const { theme } = useUnistyles();
  const level = quotaMeterLevel(limit);
  const reported = limit?.usedPercent;
  // A spent window without a percent still reads as full; an unknown percent
  // otherwise draws an empty bar rather than inventing a length.
  const percent =
    reported !== undefined && Number.isFinite(reported)
      ? Math.min(100, Math.max(0, reported))
      : level === 'spent'
        ? 100
        : 0;
  const fillColor =
    level === 'spent'
      ? theme.colors.accent
      : level === 'low'
        ? theme.colors.primary
        : theme.colors.textMuted;
  const percentText =
    reported !== undefined && Number.isFinite(reported) ? `${Math.round(percent)}% used` : null;
  const resetText =
    limit === null ? 'No active window' : `Resets ${formatResetDisplay(limit.resetsAt, window)}`;
  return (
    <View
      style={styles.meter}
      accessible
      accessibilityLabel={`${title}: ${percentText ?? 'usage unknown'}. ${resetText}.`}
    >
      <View style={styles.meterHeader}>
        <Text style={styles.meterTitle}>{title}</Text>
        {percentText !== null ? (
          <Text style={[styles.meterPercent, level === 'spent' ? styles.meterSpent : null]}>
            {percentText}
          </Text>
        ) : null}
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%`, backgroundColor: fillColor }]} />
      </View>
      <Text style={styles.reset}>{resetText}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
  },
  meter: {
    gap: theme.spacing.xs,
  },
  meterHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  meterTitle: {
    flexShrink: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  meterPercent: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  meterSpent: {
    color: theme.colors.accent,
  },
  track: {
    height: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.setup.surfaceAlt,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: theme.radius.pill,
  },
  reset: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
  },
  empty: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
  },
}));
