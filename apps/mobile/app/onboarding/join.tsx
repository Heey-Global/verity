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
import { OnboardingProgress } from '../../components/OnboardingProgress';
import { loadTeamJoinProgress } from '../../lib/teamJoinState';
import { bumpServerRevision } from '../../lib/serverProfile';
import { joinTeam, resumeTeamJoin, TeamJoinError, teamJoinNameProblem } from '../../lib/teamJoin';
import {
  parseTeamJoinLink,
  TeamJoinLinkError,
  type TeamJoinLink,
} from '../../lib/teamInvitationLink';

type Phase =
  | { kind: 'enter'; problem?: string }
  | { kind: 'accept'; link: TeamJoinLink; problem?: string }
  | { kind: 'unusable'; link?: TeamJoinLink; reason: 'expired' | 'unavailable' | 'invalid' }
  | { kind: 'waiting'; link: TeamJoinLink; saving: boolean }
  | { kind: 'resume'; link: TeamJoinLink }
  | { kind: 'interrupted'; link: TeamJoinLink; problem: string }
  | { kind: 'complete'; link: TeamJoinLink };

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
        router.replace('/settings/ai-accounts');
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
  resume = resumeTeamJoin,
}: {
  initialLink?: string | undefined;
  onClose: () => void;
  onJoined: () => void;
  join?: typeof joinTeam;
  resume?: typeof resumeTeamJoin;
}) {
  const [phase, setPhase] = useState<Phase>(() => phaseFor(initialLink));
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void loadTeamJoinProgress()
      .then((progress) => {
        if (mounted.current && progress !== null) setPhase({ kind: 'resume', link: progress.link });
      })
      .catch((error: unknown) => {
        if (mounted.current)
          setPhase({
            kind: 'enter',
            problem:
              error instanceof Error
                ? error.message
                : 'Could not read saved join progress. Try reopening this screen.',
          });
      });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  const run = (target: TeamJoinLink, continuing: boolean) => {
    if (controller.current !== null) return;
    const active = new AbortController();
    controller.current = active;
    setJoining(true);
    setPhase({ kind: 'waiting', link: target, saving: true });
    const options = {
      signal: active.signal,
      onPhase: (next: 'saving' | 'confirming') => {
        if (mounted.current && !active.signal.aborted)
          setPhase({ kind: 'waiting', link: target, saving: next === 'saving' });
      },
    };
    const work = continuing
      ? loadTeamJoinProgress().then((saved) =>
          saved === null ? join(target, name, options) : resume(options),
        )
      : join(target, name, options);
    void work
      .then(
        () => {
          if (mounted.current && !active.signal.aborted)
            setPhase({ kind: 'complete', link: target });
        },
        (error: unknown) => {
          if (!mounted.current || active.signal.aborted) return;
          if (error instanceof TeamJoinLinkError)
            setPhase({ kind: 'unusable', link: target, reason: error.reason });
          else if (error instanceof TeamJoinError && error.reason === 'name')
            setPhase({ kind: 'accept', link: target, problem: error.message });
          else if (error instanceof TeamJoinError && error.reason === 'unavailable')
            setPhase({ kind: 'unusable', link: target, reason: 'unavailable' });
          else
            setPhase({
              kind: 'interrupted',
              link: target,
              problem: error instanceof Error ? error.message : 'Could not join the project.',
            });
        },
      )
      .finally(() => {
        controller.current = null;
        if (mounted.current) setJoining(false);
      });
  };

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
            <Button label="Back" variant="text" onPress={close} fullWidth />
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
      <Frame footer={<Button label="Close" variant="secondary" onPress={close} fullWidth />}>
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
      <Frame
        footer={<Button label="Leave for now" variant="secondary" onPress={close} fullWidth />}
      >
        <OnboardingProgress current={2} total={3} />
        <StepIntro
          headline="Joining"
          accent={projectName}
          lead={
            phase.saving
              ? 'Saving your access securely on this device.'
              : 'Your access is saved. We’re confirming your membership.'
          }
        />
        <Group>
          <Row
            leading={{ element: <Spinner /> }}
            title={phase.saving ? 'Saving device access' : 'Confirming your membership'}
            subtitle={inviter ? `On ${inviter}’s server` : undefined}
          />
        </Group>
        <SystemNotice
          intent="transient"
          title="You can leave this screen"
          detail="You can continue after your access has been saved. Your existing server stays connected."
        />
      </Frame>
    );
  }
  if (phase.kind === 'resume' || phase.kind === 'interrupted') {
    return (
      <Frame
        footer={
          <>
            <Button
              label={phase.kind === 'resume' ? 'Continue joining' : 'Try again'}
              onPress={() => run(phase.link, true)}
              disabled={joining}
              fullWidth
            />
            <Button label="Leave for now" variant="text" onPress={close} fullWidth />
          </>
        }
      >
        <OnboardingProgress current={2} total={3} />
        <StepIntro
          headline={phase.kind === 'resume' ? 'Continue joining' : 'Join interrupted'}
          accent={projectName}
          lead="We’ll check your saved progress before continuing."
        />
        <Group>
          <Row
            leading={{ icon: 'folder' }}
            title={projectName}
            subtitle={inviter ? `${inviter}’s server` : undefined}
          />
        </Group>
        {phase.kind === 'interrupted' ? (
          <SystemNotice
            intent="needsSetup"
            title={phase.problem}
            detail="Your existing server and its connections haven’t changed."
          />
        ) : null}
      </Frame>
    );
  }
  if (phase.kind === 'complete') {
    return (
      <Frame footer={<Button label="Set up my AI account" onPress={onJoined} fullWidth />}>
        <OnboardingProgress current={3} total={3} />
        <StepIntro
          headline="You’ve joined"
          accent={projectName}
          lead="Set up your own AI account to start working with the team."
        />
        <Group>
          <Row leading={{ icon: 'check' }} title="Membership confirmed" />
        </Group>
        <SystemNotice
          intent="needsSetup"
          title="Connect your own AI account"
          detail="Your teammates’ accounts stay private. GitHub and other connections can be added later."
        />
      </Frame>
    );
  }
  const nameProblem = teamJoinNameProblem(name);
  const accept = () => {
    if (nameProblem === null) run(phase.link, false);
  };
  return (
    <Frame
      footer={
        <>
          <Button
            label="Join project"
            onPress={accept}
            disabled={nameProblem !== null}
            loading={joining}
            fullWidth
          />
          <Button label="Not now" variant="text" onPress={close} fullWidth />
        </>
      }
    >
      <OnboardingProgress current={1} total={3} />
      <StepIntro
        headline={`${inviter ?? 'Someone'} invites you to`}
        accent={projectName}
        lead="Join the team with your own accounts."
      />
      <Group>
        <Row leading={{ icon: 'folder', quiet: true }} title={`The project “${projectName}”`} />
      </Group>
      <TextField
        label="Your name in the team"
        value={name}
        onChangeText={setName}
        error={
          name !== '' && nameProblem !== null
            ? { title: 'Check your name', message: nameProblem }
            : undefined
        }
      />
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
