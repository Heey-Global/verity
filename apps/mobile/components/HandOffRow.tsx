import type { SessionSummary } from '@verity/mobile';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { isActive } from '../lib/sessionActivity';
import type { IconName } from './Icon';
import { VerityMark } from './VerityMark';
import { IconButton, Row, TileMark } from './ui';

/** Where the item stands with the session that works on it. */
export type HandOffSession = 'working' | 'waiting' | 'idle';

/** The state a hand-over row shows for the session working on its item. */
export function handOffSession(session: SessionSummary): HandOffSession {
  if (session.status === 'awaiting_input') return 'waiting';
  return isActive(session) ? 'working' : 'idle';
}

const SESSION: Record<HandOffSession, { subtitle: string; mark?: ReactNode; label?: string }> = {
  working: {
    subtitle: 'Verity is on it',
    mark: <TileMark tone="signature" pulsing />,
    label: 'Verity is working',
  },
  waiting: {
    subtitle: 'Verity is waiting for you',
    mark: <TileMark tone="attention" glyph="?" />,
    label: 'Waiting for you',
  },
  idle: { subtitle: 'In a session' },
};

/**
 * Verity's V in the square icon button (docs/design-system.md § 5.2): the one
 * control that hands an item to her. A tap starts the work right away.
 */
export function VerityHandOffButton({
  accessibilityLabel,
  onPress,
  disabled = false,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <IconButton
      mark={<VerityMark size={26} glow={false} />}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
    />
  );
}

/**
 * A task or an issue as something Verity can take on, drawn like a session row:
 * a quiet tile, the title and one subtitle. Without a session, the row opens the
 * item and her V beside it hands it over; once a session works on it, the tile
 * carries that session's state and the row opens the session.
 */
export function HandOffRow({
  title,
  subtitle,
  icon,
  tag,
  session,
  onOpenSession,
  onPress,
  accessibilityHint,
  onHandOff,
  handOffLabel,
  busy = false,
  answers,
}: {
  title: string;
  /** The item's own line (its age, its number); replaced by the session's state. */
  subtitle: string;
  icon: IconName;
  tag?: ReactNode;
  session?: HandOffSession | undefined;
  onOpenSession: () => void;
  /** Opens the item itself (edit a task, read an issue) while no session has it. */
  onPress?: (() => void) | undefined;
  /** What `onPress` does, for VoiceOver. */
  accessibilityHint?: string | undefined;
  /** Absent when the item cannot be handed over (no project to run in). */
  onHandOff?: (() => void) | undefined;
  /** "Let Verity start: <title>"; the V alone says nothing to VoiceOver. */
  handOffLabel: string;
  busy?: boolean;
  answers?: ReactNode;
}) {
  if (session !== undefined) {
    const state = SESSION[session];
    return (
      <Row
        title={title}
        subtitle={state.subtitle}
        tag={tag}
        leading={{
          icon,
          quiet: true,
          ...(state.mark !== undefined
            ? {
                marks: {
                  top: (
                    <View accessibilityRole="image" accessibilityLabel={state.label}>
                      {state.mark}
                    </View>
                  ),
                },
              }
            : {}),
        }}
        navigates
        disabled={busy}
        onPress={onOpenSession}
        accessibilityHint="Opens Verity's session"
        answers={answers}
      />
    );
  }
  return (
    <Row
      title={title}
      subtitle={subtitle}
      tag={tag}
      leading={{ icon, quiet: true }}
      onPress={onPress}
      {...(accessibilityHint !== undefined ? { accessibilityHint } : {})}
      disabled={busy}
      action={
        onHandOff !== undefined ? (
          <VerityHandOffButton
            accessibilityLabel={handOffLabel}
            onPress={onHandOff}
            disabled={busy}
          />
        ) : undefined
      }
      answers={answers}
    />
  );
}
