import { VerityApiError, type VerityClient, type ProjectRecord } from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { OnboardingStepScaffold } from '../../components/OnboardingStepScaffold';
import { createVerityClient } from '../../lib/client';

const DONE_HREF = '/onboarding/done';
const BACK = '/onboarding/ai-backends';
const CURRENT_HREF = '/onboarding/first-project';
const POLL_MS = 2500;
const MAX_POLLS = 96;

export default function OnboardingFirstProject() {
  const client = createVerityClient();
  if (client === null) {
    return (
      <OnboardingStepScaffold stepId="first-project" title="First project" back={BACK}>
        <View style={styles.card}>
          <Text style={styles.intro}>
            No server is configured yet. Go back and set the Verity server address first, then add
            your first project.
          </Text>
        </View>
      </OnboardingStepScaffold>
    );
  }
  return <FirstProjectStep client={client} />;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'selecting' }
  | { kind: 'provisioning'; message: string }
  | { kind: 'error'; message: string };

function unlockRoute(): string {
  return `/unlock-device?returnTo=${encodeURIComponent(CURRENT_HREF)}`;
}

function needsUnlock(caught: unknown): boolean {
  if (!(caught instanceof VerityApiError)) return false;
  if (caught.status === 401) return true;
  return caught.status === 503 && caught.message.toLowerCase().includes('sealed');
}

function repoName(project: ProjectRecord): string {
  return project.owner + '/' + project.repo;
}

function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((a, b) => repoName(a).localeCompare(repoName(b)));
}

function FirstProjectStep({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );
  const busy = phase.kind === 'loading' || phase.kind === 'provisioning';

  const loadProjects = useCallback(() => {
    setPhase({ kind: 'loading' });
    void client
      .listAvailableRepositories()
      .then((next) => {
        const sorted = sortProjects(next);
        setProjects(sorted);
        setSelectedId((current) => current ?? sorted[0]?.id ?? null);
        setPhase({ kind: 'selecting' });
      })
      .catch((caught) => {
        if (needsUnlock(caught)) {
          router.replace(unlockRoute());
          return;
        }
        setPhase({
          kind: 'error',
          message:
            caught instanceof VerityApiError ? caught.message : 'Could not load repositories.',
        });
      });
  }, [client]);

  useEffect(() => loadProjects(), [loadProjects]);

  const waitForActive = async (projectId: string): Promise<void> => {
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      if (!mounted.current) throw new Error('Provisioning view closed.');
      const detail = await client.getProject(projectId);
      const project = detail.project;
      if (project.state === 'active') return;
      if (project.state === 'failed') {
        throw new Error(project.provisionError ?? 'Project provisioning failed.');
      }
      if (mounted.current)
        setPhase({ kind: 'provisioning', message: statusMessage(project.state) });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error(
      'Project provisioning is still running. Open the project from the overview once it becomes active.',
    );
  };

  const provisionSelected = () => {
    if (busy || selected === null) return;
    setPhase({ kind: 'provisioning', message: 'Starting project container...' });
    const run = (projectId: string, confirmWarnings = false): void => {
      void client
        .repairProject(projectId, { confirmWarnings })
        .then((project) => {
          if (project.state === 'active') return undefined;
          return waitForActive(project.id);
        })
        .then(() => {
          if (mounted.current) router.replace(DONE_HREF);
        })
        .catch((caught) => {
          if (!mounted.current) return;
          if (
            caught instanceof VerityApiError &&
            caught.requiresConfirmation &&
            caught.warnings.length > 0
          ) {
            setPhase({ kind: 'selecting' });
            Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Continue', onPress: () => run(projectId, true) },
            ]);
            return;
          }
          if (needsUnlock(caught)) {
            router.replace(unlockRoute());
            return;
          }
          setPhase({
            kind: 'error',
            message: caught instanceof Error ? caught.message : 'Could not create the project.',
          });
        });
    };
    void client
      // Available repositories are discovery records, not projects owned by this
      // installation yet. Create the project first; repairing the discovery id
      // either 404s or can target an unrelated pre-existing project.
      .createProject({ repo: repoName(selected) })
      .then((created) => run(created.id))
      .catch((caught) => {
        if (needsUnlock(caught)) {
          router.replace(unlockRoute());
          return;
        }
        setPhase({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'Could not provision project.',
        });
      });
  };

  return (
    <OnboardingStepScaffold stepId="first-project" title="First project" back={BACK}>
      <FirstProjectGuidance />

      <View style={styles.card}>
        {phase.kind === 'loading' ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={theme.colors.accent} />
            <Text style={styles.footnote}>Loading repositories...</Text>
          </View>
        ) : null}

        {projects.length > 0 ? (
          <View
            style={styles.repoList}
            accessibilityRole="radiogroup"
            accessibilityLabel="Repository"
          >
            {projects.map((project) => {
              const active = project.id === selected?.id;
              return (
                <Pressable
                  key={project.id}
                  onPress={() => setSelectedId(project.id)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, disabled: busy }}
                  accessibilityLabel={repoName(project)}
                  style={({ pressed }) => [
                    styles.repoOption,
                    active ? styles.repoOptionActive : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <View style={[styles.radio, active ? styles.radioActive : null]} />
                  <View style={styles.repoTextGroup}>
                    <Text style={styles.repoName}>{repoName(project)}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : phase.kind !== 'loading' ? (
          <Text style={styles.footnote}>
            No repositories are available through this GitHub connection yet. Choose at least one
            repository during authorization, then retry.
          </Text>
        ) : null}

        {phase.kind === 'provisioning' ? (
          <Text style={styles.connected} accessibilityRole="alert">
            {phase.message}
          </Text>
        ) : null}

        {phase.kind === 'error' ? (
          <Text style={styles.error} accessibilityRole="alert">
            {phase.message}
          </Text>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            selected === null || busy ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={provisionSelected}
          disabled={selected === null || busy}
          accessibilityRole="button"
          accessibilityLabel="Prepare selected project"
        >
          {phase.kind === 'provisioning' ? (
            <ActivityIndicator size="small" color={theme.colors.background} />
          ) : null}
          <Text style={styles.primaryButtonLabel}>
            {phase.kind === 'provisioning' ? 'Preparing project...' : 'Prepare project'}
          </Text>
        </Pressable>

        {phase.kind === 'error' || (phase.kind === 'selecting' && projects.length === 0) ? (
          <Pressable
            onPress={loadProjects}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Reload repositories"
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.secondaryButtonLabel}>Reload repositories</Text>
          </Pressable>
        ) : null}
      </View>
    </OnboardingStepScaffold>
  );
}

function statusMessage(state: ProjectRecord['state']): string {
  switch (state) {
    case 'cloning':
      return 'Cloning repository...';
    case 'container_starting':
      return 'Starting secure workspace...';
    case 'absent':
      return 'Preparing secure workspace...';
    default:
      return 'Waiting for secure workspace...';
  }
}

function FirstProjectGuidance() {
  return (
    <View style={styles.guidance} accessibilityRole="summary">
      <Text style={styles.guidanceTitle} accessibilityRole="header">
        Add your first project
      </Text>
      <Text style={styles.guidanceStep}>
        Choose a repository from your GitHub connection. Verity will clone it, provision the
        container, and make it ready for agent sessions.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  guidance: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  guidanceTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
    marginBottom: theme.spacing.xs,
  },
  guidanceStep: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  intro: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 22 * theme.fontScale },
  repoList: { gap: theme.spacing.sm },
  repoOption: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  repoOptionActive: { borderColor: theme.colors.accent },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  radioActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  repoTextGroup: { flex: 1 },
  repoName: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '800' },
  footnote: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  connected: { color: theme.colors.tone.done, fontSize: theme.text.sm, fontWeight: '700' },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '600' },
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryButtonLabel: { color: theme.colors.accent, fontSize: theme.text.sm, fontWeight: '800' },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: { opacity: 0.62 },
}));
