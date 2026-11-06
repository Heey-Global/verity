// Agent subscription usage on the overview: one ring per quota window and the
// reset beside it, for every provider that reports a limit. On a wide screen it
// sits in the header next to the wordmark; on a phone it is a fixed row above
// Home and Projects. Tapping it opens the details for all providers — an
// anchored popover on a wide screen, a sheet on a phone.
import {
  pacePercent,
  quotaMeterLevel,
  type ProviderLimitRow,
  type ProviderLimitState,
} from '@verity/mobile';
import { router, type Href } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatResetDisplay, formatTimeUntil } from '../lib/time';
import { AgentProviderIcon } from './AgentProviderIcon';
import { Sheet } from './ui/Sheet';
import { UsageRing, type UsageRingLevel } from './ui/UsageRing';

type QuotaWindow = 'five_hour' | 'weekly';

/** One window as the overview draws it. */
interface UsageWindow {
  window: QuotaWindow;
  ringLabel: string;
  title: string;
  percent: number;
  /** The provider's own figure; undefined when it sent none. */
  reportedPercent: number | undefined;
  pace: number | null;
  level: UsageRingLevel;
  resetsAt: number;
}

interface ProviderUsage {
  providerLabel: string;
  windows: UsageWindow[];
}

// Settings pages that show one provider's usage in full.
const PROVIDER_SETTINGS: Record<string, Href> = {
  Claude: '/settings/services/claude',
  Codex: '/settings/services/codex',
};
const PROVIDER_ICONS: Record<string, 'claude' | 'codex' | 'opencode'> = {
  Claude: 'claude',
  Codex: 'codex',
  OpenCode: 'opencode',
};
// Off-pace by less than this reads as on pace, as the earlier meters did.
const PACE_TOLERANCE = 2;
// The pace notch and countdown move with the clock, not with the data: a
// window nobody is using still advances its even-pace position.
const CLOCK_TICK_MS = 60_000;

function usageWindow(window: QuotaWindow, limit: ProviderLimitState, nowMs: number): UsageWindow {
  const level = quotaMeterLevel(limit);
  const reported =
    limit.usedPercent !== undefined && Number.isFinite(limit.usedPercent)
      ? limit.usedPercent
      : undefined;
  return {
    window,
    ringLabel: window === 'five_hour' ? '5h' : 'W',
    title: window === 'five_hour' ? '5-hour window' : 'This week',
    // A spent window without a figure still reads as full; an unknown figure
    // otherwise draws an empty arc rather than inventing a length.
    percent: reported ?? (level === 'spent' ? 100 : 0),
    reportedPercent: reported,
    pace: pacePercent(limit.resetsAt, window, nowMs),
    level,
    resetsAt: limit.resetsAt,
  };
}

/**
 * The windows each provider reports. A window without data is left out rather
 * than drawn empty — some providers have no five-hour window at all — and a
 * provider left with none is left out too.
 */
export function providerUsage(
  rows: readonly ProviderLimitRow[],
  nowMs: number = Date.now(),
): ProviderUsage[] {
  return rows
    .map((row) => ({
      providerLabel: row.providerLabel,
      windows: [
        ...(row.fiveHour ? [usageWindow('five_hour', row.fiveHour, nowMs)] : []),
        ...(row.weekly ? [usageWindow('weekly', row.weekly, nowMs)] : []),
      ],
    }))
    .filter((usage) => usage.windows.length > 0);
}

function paceStatus(window: UsageWindow): string | null {
  if (window.level === 'spent') return 'Limit reached';
  if (window.pace === null || window.reportedPercent === undefined) return null;
  const ahead = Math.round(window.reportedPercent - window.pace);
  if (ahead > PACE_TOLERANCE) return `${ahead}% ahead of even pace`;
  if (ahead < -PACE_TOLERANCE) return `${-ahead}% of room to even pace`;
  return 'On even pace';
}

/** The figure next to a ring: only once it matters, from 90 % or when spent. */
function criticalText(window: UsageWindow): string | null {
  if (window.level === 'spent') return 'Limit';
  if (window.level === 'low' && window.reportedPercent !== undefined)
    return `${Math.round(window.reportedPercent)}%`;
  return null;
}

function spokenWindow(window: UsageWindow): string {
  const used =
    window.reportedPercent !== undefined
      ? `${Math.round(window.reportedPercent)} percent used`
      : window.level === 'spent'
        ? null
        : 'usage unknown';
  // A spent window always says so — a provider may stop a window short of
  // 100 % — and has no pace to report; the others add their pace.
  const status = paceStatus(window);
  return [
    window.title,
    used,
    status,
    `resets ${formatResetDisplay(window.resetsAt, window.window)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

function ProviderMark({ label, size = 15 }: { label: string; size?: number }) {
  const { theme } = useUnistyles();
  const provider = PROVIDER_ICONS[label];
  if (provider === undefined) {
    return (
      <Text style={styles.providerName} numberOfLines={1}>
        {label}
      </Text>
    );
  }
  return <AgentProviderIcon provider={provider} size={size} color={theme.colors.text} />;
}

function WindowCell({ window, showReset }: { window: UsageWindow; showReset: boolean }) {
  const critical = criticalText(window);
  const spent = window.level === 'spent';
  return (
    <View style={styles.cell}>
      <UsageRing
        label={window.ringLabel}
        percent={window.percent}
        pace={window.pace}
        level={window.level}
      />
      {critical !== null || showReset ? (
        <View style={styles.cellText}>
          {critical !== null ? (
            <Text style={[styles.critical, spent ? styles.spent : null]} numberOfLines={1}>
              {critical}
            </Text>
          ) : null}
          {showReset ? (
            <Text style={[styles.reset, spent ? styles.spent : null]} numberOfLines={1}>
              {formatResetDisplay(window.resetsAt, window.window, { compact: true })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function UsageRow({ usage, showReset }: { usage: ProviderUsage[]; showReset: boolean }) {
  return (
    <>
      {usage.map((provider, index) => (
        <Fragment key={provider.providerLabel}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <View style={styles.provider}>
            <ProviderMark label={provider.providerLabel} />
            {provider.windows.map((window) => (
              <WindowCell key={window.window} window={window} showReset={showReset} />
            ))}
          </View>
        </Fragment>
      ))}
    </>
  );
}

// "Resets 11:49 (in 1h 9m)"; a reset already reached drops the countdown.
function resetLine(window: UsageWindow, nowMs: number): string {
  const until = formatTimeUntil(window.resetsAt, nowMs);
  const at = `Resets ${formatResetDisplay(window.resetsAt, window.window)}`;
  return until === 'now' ? at : `${at} (in ${until})`;
}

function UsageDetails({
  usage,
  now,
  onNavigate,
}: {
  usage: ProviderUsage[];
  /** The same clock the rings were drawn with, so countdown and notch agree. */
  now: number;
  onNavigate: () => void;
}) {
  return (
    <View style={styles.details}>
      {usage.map((provider, index) => {
        const settings = PROVIDER_SETTINGS[provider.providerLabel];
        return (
          <View
            key={provider.providerLabel}
            style={[styles.detailsBlock, index > 0 ? styles.detailsBlockSeparated : null]}
          >
            <View style={styles.detailsHead}>
              <ProviderMark label={provider.providerLabel} size={16} />
              <Text style={styles.detailsProvider}>{provider.providerLabel}</Text>
            </View>
            {provider.windows.map((window) => {
              const status = paceStatus(window);
              return (
                <View key={window.window} style={styles.detailsRow}>
                  <UsageRing
                    label={window.ringLabel}
                    percent={window.percent}
                    pace={window.pace}
                    level={window.level}
                    size={34}
                  />
                  <View style={styles.detailsText}>
                    <Text style={styles.detailsTitle}>
                      {window.title}
                      {window.reportedPercent !== undefined
                        ? ` · ${Math.round(window.reportedPercent)}% used`
                        : ''}
                    </Text>
                    <Text style={styles.detailsLine}>{resetLine(window, now)}</Text>
                    {status !== null ? (
                      <Text
                        style={[styles.detailsHint, window.level === 'spent' ? styles.spent : null]}
                      >
                        {status}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
            {settings !== undefined ? (
              <Pressable
                style={({ pressed }) => [styles.detailsLink, pressed ? styles.pressed : null]}
                onPress={() => {
                  onNavigate();
                  router.push(settings);
                }}
                accessibilityRole="link"
              >
                <Text style={styles.detailsLinkText}>{provider.providerLabel} settings</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      <Text style={styles.detailsFootnote}>
        The notch on each ring marks where usage would be now if the limit were spread evenly.
      </Text>
    </View>
  );
}

/**
 * The usage rings for every reporting provider, centred in whatever room it is
 * given. When that room is too narrow for the reset times, only the rings stay;
 * the times remain one tap away.
 */
export function ProviderUsageGroup({
  rows,
  presentation,
}: {
  rows: readonly ProviderLimitRow[];
  /** `popover` anchors the details under the group; `sheet` slides them up. */
  presentation: 'popover' | 'sheet';
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const usage = providerUsage(rows, now);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  // Width the slot offers and width the rings need with their reset times.
  const [room, setRoom] = useState<number | null>(null);
  const [needed, setNeeded] = useState<number | null>(null);
  const showReset = room === null || needed === null || needed <= room;
  // The popover is placed in window coordinates; a rotation or a split-view
  // resize would leave it hanging where the group used to be.
  useEffect(() => {
    setOpen(false);
    setAnchor(null);
  }, [screenWidth, screenHeight]);

  if (usage.length === 0) return null;

  const close = () => {
    setOpen(false);
    setAnchor(null);
  };
  const openDetails = () => {
    if (presentation === 'sheet') {
      setOpen(true);
      return;
    }
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      const cardWidth = Math.min(340, screenWidth - 24);
      const left = Math.max(
        12,
        Math.min(x + width / 2 - cardWidth / 2, screenWidth - cardWidth - 12),
      );
      setAnchor({ top: y + height + 10, left, width: cardWidth });
      setOpen(true);
    });
  };
  const spoken = usage
    .map(
      (provider) => `${provider.providerLabel}: ${provider.windows.map(spokenWindow).join('; ')}`,
    )
    .join('. ');

  return (
    <View
      testID="provider-usage-slot"
      style={styles.slot}
      onLayout={(event: LayoutChangeEvent) => setRoom(event.nativeEvent.layout.width)}
    >
      <Pressable
        ref={anchorRef}
        testID="provider-usage"
        style={({ pressed }) => [styles.group, pressed ? styles.pressed : null]}
        onPress={open ? close : openDetails}
        accessibilityRole="button"
        accessibilityLabel={`Agent usage. ${spoken}.`}
        accessibilityHint="Shows usage details"
        accessibilityState={{ expanded: open }}
        hitSlop={6}
      >
        <UsageRow usage={usage} showReset={showReset} />
      </Pressable>
      {/* An invisible copy with the reset times, outside the flow and in a row
          parent so the slot does not cap it: its width is what the full row
          would need. The row itself cannot say, as the slot limits it. */}
      <View
        testID="provider-usage-measure"
        style={[styles.group, styles.measure]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        onLayout={(event: LayoutChangeEvent) => setNeeded(event.nativeEvent.layout.width)}
      >
        <UsageRow usage={usage} showReset />
      </View>
      {presentation === 'sheet' ? (
        <Sheet visible={open} title="Agent usage" onClose={close}>
          <UsageDetails usage={usage} now={now} onNavigate={close} />
        </Sheet>
      ) : anchor !== null ? (
        <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
          <View style={styles.backdrop} accessibilityViewIsModal onAccessibilityEscape={close}>
            <Pressable style={StyleSheet.absoluteFill} onPress={close} accessible={false} />
            <View
              style={[
                styles.popover,
                {
                  top: anchor.top,
                  left: anchor.left,
                  width: anchor.width,
                  maxHeight: Math.max(0, screenHeight - anchor.top - 12),
                },
              ]}
            >
              <ScrollView bounces={false}>
                <Text style={styles.popoverTitle} accessibilityRole="header">
                  Agent usage
                </Text>
                <UsageDetails usage={usage} now={now} onNavigate={close} />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

/** The phone's fixed usage row above Home and Projects. */
export function ProviderUsageStrip({ rows }: { rows: readonly ProviderLimitRow[] }) {
  if (providerUsage(rows).length === 0) return null;
  return (
    <View style={styles.strip} testID="provider-usage-strip">
      <ProviderUsageGroup rows={rows} presentation="sheet" />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A row, not a column: Yoga caps an absolutely positioned child at a
  // column parent's width, which would cap the measuring copy as well.
  slot: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 44,
    paddingHorizontal: theme.spacing.xs,
  },
  pressed: {
    opacity: 0.62,
  },
  measure: {
    position: 'absolute',
    opacity: 0,
  },
  provider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  providerName: {
    ...theme.typography.footnote,
    fontFamily: theme.fonts.bold,
    color: theme.colors.text,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: theme.colors.border,
  },
  cell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  cellText: {
    justifyContent: 'center',
  },
  critical: {
    ...theme.typography.caption,
    fontFamily: theme.fonts.bold,
    color: theme.colors.text,
    fontVariant: ['tabular-nums'],
  },
  reset: {
    ...theme.typography.caption,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  spent: {
    color: theme.colors.attention,
  },
  strip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
  },
  popover: {
    position: 'absolute',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surface,
    ...theme.elevation.floating,
  },
  popoverTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  details: {
    gap: theme.spacing.md,
  },
  detailsBlock: {
    gap: theme.spacing.sm,
  },
  detailsBlockSeparated: {
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  detailsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  detailsProvider: {
    ...theme.typography.row,
    color: theme.colors.text,
  },
  detailsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  detailsText: {
    flex: 1,
    minWidth: 0,
  },
  detailsTitle: {
    ...theme.typography.bodySmall,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.text,
  },
  detailsLine: {
    ...theme.typography.footnote,
    color: theme.colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  detailsHint: {
    ...theme.typography.footnote,
    color: theme.colors.textFaint,
  },
  detailsLink: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  detailsLinkText: {
    ...theme.typography.bodySmall,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.actionLabel,
  },
  detailsFootnote: {
    ...theme.typography.footnote,
    color: theme.colors.textFaint,
  },
}));
