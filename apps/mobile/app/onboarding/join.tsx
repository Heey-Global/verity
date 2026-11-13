// Joining a project someone shared: open or paste their invitation link, see
// who invites you to which project, choose your name and join (ADR 0023 §7).
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, Group, Row, StepIntro, SystemNotice, TextField } from '../../components/ui';
import { createVerityClient } from '../../lib/client';
import { bumpServerRevision } from '../../lib/serverProfile';
import { joinTeam, TeamJoinError } from '../../lib/teamJoin';
import {
  parseTeamJoinLink,
  TeamJoinLinkError,
  type TeamJoinLink,
} from '../../lib/teamInvitationLink';

const POLL_MS = 3_000;

type Phase =
  | { kind: 'enter'; problem?: string }
  | { kind: 'accept'; link: TeamJoinLink; problem?: string }
  | { kind: 'unusable'; link?: TeamJoinLink; reason: 'expired' | 'unavailable' | 'invalid' }
  | { kind: 'waiting'; link: TeamJoinLink };

function phaseFor(raw: string | undefined): Phase {
  if (raw === undefined || raw.trim() === '') return { kind: 'enter' };
  try {
    return { kind: 'accept', link: parseTeamJoinLink(raw) };
  } catch (error) {
    if (error instanceof TeamJoinLinkError && error.reason === 'expired')
      return { kind: 'unusable', reason: 'expired' };
    return { kind: 'unusable', reason: 'invalid' };
  }
}

export default function JoinScreen() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  return (
    <JoinView
      initialLink={typeof link === 'string' ? link : undefined}
      onClose={() => router.replace('/onboarding/welcome')}
      onJoined={() => {
        router.replace('/');
        // Start the whole app over for the server just joined.
        bumpServerRevision();
      }}
    />
  );
}

export function JoinView({
  initialLink,
  onClose,
  onJoined,
  join = joinTeam,
  confirmed = () => createVerityClient()?.listProjects() ?? Promise.reject(new Error('offline')),
}: {
  initialLink?: string | undefined;
  onClose: () => void;
  onJoined: () => void;
  join?: typeof joinTeam;
  /** Resolves once the server serves this person, i.e. their join is confirmed. */
  confirmed?: () => Promise<unknown>;
}) {
  const [phase, setPhase] = useState<Phase>(() => phaseFor(initialLink));
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const joinedRef = useRef(onJoined);
  joinedRef.current = onJoined;

  // The server answers this person only after Uplink confirmed the join.
  const waiting = phase.kind === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    const probe = () => {
      confirmed().then(
        () => {
          if (active) joinedRef.current();
        },
        () => undefined,
      );
    };
    probe();
    const timer = setInterval(probe, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [waiting, confirmed]);

  if (phase.kind === 'enter') {
    return (
      <Frame
        footer={
          <>
            <Button
              label="Continue"
              disabled={pasted.trim() === ''}
              onPress={() => {
                const next = phaseFor(pasted);
                setPhase(
                  next.kind === 'unusable' && next.reason === 'invalid'
                    ? { kind: 'enter', problem: 'This is not a Verity invitation link.' }
                    : next,
                );
              }}
              fullWidth
            />
            <Button label="Back" variant="text" onPress={onClose} fullWidth />
          </>
        }
      >
        <StepIntro
          headline="Join a"
          accent="shared project"
          lead="Open the invitation link you received, or paste it here."
        />
        <TextField label="Invitation link" value={pasted} onChangeText={setPasted} />
        <Button
          label="Paste"
          icon="clipboard"
          variant="secondary"
          onPress={() => {
            void Clipboard.getStringAsync().then((text) => setPasted(text.trim()));
          }}
        />
        {phase.problem ? <SystemNotice intent="needsSetup" title={phase.problem} /> : null}
      </Frame>
    );
  }

  const link = phase.link;
  const projectName = link?.display?.projectName ?? 'a project';
  const inviter = link?.display?.inviterName;

  if (phase.kind === 'unusable') {
    const title =
      phase.reason === 'expired'
        ? 'This invitation has expired'
        : phase.reason === 'unavailable'
          ? 'This invitation can no longer be used'
          : 'This link is not a valid invitation';
    return (
      <Frame footer={<Button label="Close" variant="secondary" onPress={onClose} fullWidth />}>
        <StepIntro
          headline="Invitation to"
          accent={projectName}
          lead={inviter ? `From ${inviter}` : 'Verity'}
        />
        <SystemNotice
          intent="needsSetup"
          title={title}
          detail={`Ask ${inviter ?? 'the person who invited you'} for a new one.`}
        />
      </Frame>
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <Frame>
        <StepIntro headline="Welcome to" accent={projectName} lead="Almost there." />
        <Group>
          <Row
            leading={{ element: <Spinner /> }}
            title="Confirming your membership"
            subtitle={inviter ? `On ${inviter}'s server` : undefined}
          />
        </Group>
      </Frame>
    );
  }

  const acceptedLink = phase.link;
  const accept = () => {
    if (name.trim() === '') return;
    setJoining(true);
    join(acceptedLink, name)
      .then(() => setPhase({ kind: 'waiting', link: acceptedLink }))
      .catch((error: unknown) => {
        if (error instanceof TeamJoinLinkError)
          setPhase({ kind: 'unusable', link: acceptedLink, reason: error.reason });
        else if (error instanceof TeamJoinError && error.reason === 'unavailable')
          setPhase({ kind: 'unusable', link: acceptedLink, reason: 'unavailable' });
        else
          setPhase({
            kind: 'accept',
            link: acceptedLink,
            problem: error instanceof Error ? error.message : 'Could not join the project.',
          });
      })
      .finally(() => setJoining(false));
  };
  return (
    <Frame
      footer={
        <>
          <Button
            label="Join project"
            onPress={accept}
            disabled={name.trim() === ''}
            loading={joining}
            fullWidth
          />
          <Button label="Decline" variant="text" onPress={onClose} fullWidth />
        </>
      }
    >
      <StepIntro
        headline={`${inviter ?? 'Someone'} invites you to`}
        accent={projectName}
        lead="Work on it together, with your own AI."
      />
      <Group>
        <Row leading={{ icon: 'folder', quiet: true }} title={`The project “${projectName}”`} />
      </Group>
      <TextField label="Your name in the team" value={name} onChangeText={setName} />
      {phase.problem ? <SystemNotice intent="needsSetup" title={phase.problem} /> : null}
    </Frame>
  );
}

function Spinner() {
  const { theme } = useUnistyles();
  return <ActivityIndicator color={theme.colors.action} />;
}

function Frame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const contentStyle = useMemo(
    () => [styles.content, { paddingTop: insets.top + 24 }],
    [insets.top],
  );
  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <ScrollView contentContainerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>{footer}</View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.md,
  },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    gap: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
}));
