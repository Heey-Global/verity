import type { OnlineMeetingStatus } from '@verity/mobile';
import { Image, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { BrandTile, Button, IconButton, Text } from '../ui';
import { tint } from '../ui/tint';
import { MeetingWave } from './MeetingWave';

const VERITY_MARK = require('../../assets/brand/verity-v-mark.png') as number;
const VERITY_MARK_RATIO = 240 / 168;

export const PLATFORM_NAME = { google_meet: 'Google Meet', teams: 'Microsoft Teams', zoom: 'Zoom' };

/** Long enough for a normal join; after it, a host-held lobby is the likely cause. */
const LOBBY_HINT_AFTER_MS = 45_000;

/** One sentence for a provider failure code; unknown codes get the general one. */
export function joinFailureText(reason: string | null): string {
  switch (reason) {
    case 'login_required':
    case 'bot_login_attempt_failed':
      return 'The meeting requires sign-in.';
    case 'request_to_join_denied':
      return 'The host declined Verity.';
    case 'waiting_room_timeout_exceeded':
      return 'Nobody let Verity in.';
    case 'meeting_not_found':
      return 'The meeting link no longer works.';
    case 'meeting_not_started_waiting_for_host':
      return 'The meeting has not started yet.';
    case 'meeting_ended_before_bot_joined':
      return 'The meeting ended before Verity got in.';
    case 'blocked_by_captcha':
      return 'The meeting platform blocked Verity.';
    case 'unable_to_connect_to_meeting':
      return 'Verity could not connect to the meeting.';
    case 'out_of_credits':
      return 'The meeting service has no credits left.';
    default:
      return reason?.startsWith('zoom_') || reason === 'unpublished_zoom_app'
        ? 'Zoom did not let Verity join.'
        : 'The meeting service did not let Verity in.';
  }
}

type Step = { key: string; icon: IconName; label: string };
const JOINING: Step = { key: 'joining', icon: 'phone-call', label: 'Joining' };
const LET_IN: Step = { key: 'let-in', icon: 'user-check', label: 'Let in' };
const LIVE: Step = { key: 'live', icon: 'radio', label: 'Live' };

/**
 * Shown in place of the meeting until Verity's bot is in the call; the meeting screen opens
 * once it is. The admission step appears only when the provider reports a waiting room.
 */
export function OnlineJoinScreen({
  title,
  status,
  platform,
  waitedMs,
  topInset,
  bottomInset,
  cancelling,
  cancelFailed = false,
  onMinimize,
  onCancel,
  onRetry,
  onClose,
}: {
  title: string;
  status: Pick<OnlineMeetingStatus, 'status' | 'reason'>;
  platform: OnlineMeetingStatus['platform'];
  /** How long the bot has been trying to get in. */
  waitedMs: number;
  topInset: number;
  bottomInset: number;
  cancelling: boolean;
  /** The last Cancel did not reach the server; the bot may still be joining. */
  cancelFailed?: boolean;
  onMinimize: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
  const failed = status.status === 'failed';
  const waiting = status.status === 'waiting';
  const steps = waiting ? [JOINING, LET_IN, LIVE] : [JOINING, LIVE];
  const current = waiting ? 1 : 0;
  const headline = failed
    ? 'Could not join'
    : waiting
      ? 'Waiting to be let in'
      : 'Joining the call';
  const lead = failed
    ? joinFailureText(status.reason)
    : waiting
      ? 'Ask the host to admit Verity.'
      : waitedMs >= LOBBY_HINT_AFTER_MS
        ? 'The host may need to let Verity in.'
        : platform
          ? PLATFORM_NAME[platform]
          : 'Online meeting';
  return (
    <View style={[styles.root, { paddingTop: topInset + 12, paddingBottom: bottomInset + 12 }]}>
      <View style={styles.header}>
        <IconButton
          icon="chevron-down"
          accessibilityLabel="Minimize meeting"
          onPress={onMinimize}
        />
        <Text variant="row" numberOfLines={1} style={styles.fill}>
          {title}
        </Text>
      </View>
      <View style={styles.center} accessibilityLiveRegion="polite">
        <View style={styles.tile}>
          <BrandTile tone={failed ? 'attention' : 'signature'}>
            {failed ? (
              <Icon name="alert-circle" size={40} color={colors.attention} />
            ) : (
              <Image source={VERITY_MARK} accessibilityIgnoresInvertColors style={styles.mark} />
            )}
          </BrandTile>
        </View>
        <Text style={styles.headline} accessibilityRole="header">
          {headline}
        </Text>
        <Text style={styles.lead}>{lead}</Text>
        {failed ? null : (
          <>
            <View style={styles.wave}>
              <MeetingWave active />
            </View>
            <View style={styles.steps}>
              {steps.map((step, index) => {
                const done = index < current;
                const reached = index <= current;
                const tone = reached ? colors.signature : colors.textFaint;
                return (
                  <View key={step.key} style={styles.stepWrap}>
                    {index > 0 ? (
                      <View
                        style={[
                          styles.line,
                          { backgroundColor: reached ? colors.signature : colors.border },
                        ]}
                      />
                    ) : null}
                    <View
                      style={styles.step}
                      accessible
                      accessibilityLabel={`${step.label}, ${done ? 'done' : index === current ? 'in progress' : 'next'}`}
                    >
                      <View
                        style={[
                          styles.stepIcon,
                          reached && { borderColor: tint(colors.signature, 'border') },
                          done && { backgroundColor: tint(colors.signature, 'fill') },
                        ]}
                      >
                        <Icon name={done ? 'check' : step.icon} size={18} color={tone} />
                      </View>
                      <Text
                        variant="footnote"
                        tone={index === current ? 'default' : 'muted'}
                        style={styles.stepLabel}
                      >
                        {step.label}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </View>
      <View style={styles.footer}>
        {failed ? (
          <>
            <Button label="Try again" icon="refresh-cw" onPress={onRetry} fullWidth />
            <Button label="Close" variant="secondary" onPress={onClose} fullWidth />
          </>
        ) : (
          <>
            {cancelFailed ? (
              <Text variant="footnote" tone="attention" style={styles.footerNote}>
                Could not cancel. Try again.
              </Text>
            ) : null}
            <Button
              label={cancelling ? 'Cancelling…' : 'Cancel'}
              accessibilityLabel="Cancel joining"
              variant="secondary"
              disabled={cancelling}
              onPress={onCancel}
              fullWidth
            />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.lg,
  },
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  tile: { marginBottom: theme.spacing.md },
  mark: { width: 40, height: 40 / VERITY_MARK_RATIO },
  headline: { ...theme.typography.display, color: theme.colors.text, textAlign: 'center' },
  lead: { ...theme.typography.body, color: theme.colors.textMuted, textAlign: 'center' },
  wave: { alignSelf: 'stretch', marginVertical: theme.spacing.lg },
  steps: { flexDirection: 'row', alignItems: 'flex-start' },
  stepWrap: { flexDirection: 'row', alignItems: 'flex-start' },
  line: { width: 36, height: 2, marginTop: 21, borderRadius: 1 },
  step: { alignItems: 'center', gap: theme.spacing.xs, width: 72 },
  stepIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { textAlign: 'center' },
  footer: { gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
  footerNote: { textAlign: 'center' },
}));
