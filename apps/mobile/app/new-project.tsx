// New-project screen: create a Verity project either from an existing GitHub
// repository (POST /projects { repo } — Verity clones it) or with no GitHub
// repository at all (POST /projects { kind: 'local', name } — Verity runs
// `git init`), which project settings can connect to GitHub later. Either way we
// provision its container and then navigate to the new project's detail screen
// where its lifecycle/settings live. This is the top-level
// "+" action (header) — creating a *project*, as opposed to the per-project "+" in
// the overview which spawns a *session*. All StyleSheet.create lives here so the
// Unistyles Babel plugin (root: 'app') processes it.
import {
  VerityApiError,
  type VerityClient,
  type CreateProjectRequest,
  type DevServerDetection,
  type DopplerConfigSummary,
  type DopplerProjectSummary,
  type ProjectRecord,
  type ProjectSettings,
} from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { hasUnreviewedDevServers, projectSetupStatus } from '../lib/projectSetup';

export default function NewProjectScreen() {
  const params = useLocalSearchParams<{ projectId?: string | string[] }>();
  const resumeProjectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const client = createVerityClient();
  if (!client || !getVerityBaseUrl()) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Not connected</Text>
        <Text style={styles.subtitle}>
          Configure your Verity server address in setup to add a project.
        </Text>
      </View>
    );
  }
  return <NewProject client={client} resumeProjectId={resumeProjectId} />;
}

function NewProject({
  client,
  resumeProjectId,
}: {
  client: VerityClient;
  resumeProjectId?: string;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [repositories, setRepositories] = useState<ProjectRecord[]>([]);
  /** Which kind of project is being created. `local` starts without any GitHub
   *  repository; project settings can connect one later. */
  const [mode, setMode] = useState<'github' | 'local'>('github');
  const [localName, setLocalName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingRepositories, setLoadingRepositories] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [setupProject, setSetupProject] = useState<ProjectRecord | null>(null);
  const [detection, setDetection] = useState<DevServerDetection | null>(null);
  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [secretsStep, setSecretsStep] = useState<
    'pending' | 'projects' | 'configs' | 'saving' | 'skipped'
  >('pending');
  const [dopplerProjects, setDopplerProjects] = useState<DopplerProjectSummary[]>([]);
  const [dopplerConfigs, setDopplerConfigs] = useState<DopplerConfigSummary[]>([]);
  const [dopplerProject, setDopplerProject] = useState<string | null>(null);
  const [secretsMountAttempted, setSecretsMountAttempted] = useState(false);
  const [secretsMountFailed, setSecretsMountFailed] = useState(false);
  const [secretsVerified, setSecretsVerified] = useState(false);
  const [completionSaveFailed, setCompletionSaveFailed] = useState(false);
  const detectionAttempted = useRef<string | null>(null);
  const settingsGeneration = useRef(0);
  const resumeProvisionAttempted = useRef(false);

  const sortedRepositories = useMemo(
    () => [...repositories].sort((a, b) => repositoryName(a).localeCompare(repositoryName(b))),
    [repositories],
  );
  const selected =
    sortedRepositories.find((repository) => repository.id === selectedId) ??
    sortedRepositories[0] ??
    null;
  const canCreate =
    !creating &&
    (mode === 'local' ? localName.trim().length > 0 : selected !== null && !loadingRepositories);

  const loadRepositories = useCallback(() => {
    setLoadingRepositories(true);
    setError(undefined);
    void client
      .listAvailableRepositories()
      .then((next) => {
        setRepositories(next);
        setSelectedId((current) => current ?? next[0]?.id ?? null);
      })
      .catch((caught) => {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load repositories');
      })
      .finally(() => setLoadingRepositories(false));
  }, [client]);

  useEffect(() => {
    if (!resumeProjectId) {
      loadRepositories();
      return;
    }
    setLoadingRepositories(false);
    void client
      .getProject(resumeProjectId)
      .then((detail) => {
        setSetupProject(detail.project);
        setProjectSettings(detail.settings);
        if (detail.project.setupStatus === 'secrets_skipped') setSecretsStep('skipped');
      })
      .catch((caught) =>
        setError(caught instanceof VerityApiError ? caught.message : 'Could not resume setup'),
      );
  }, [client, loadRepositories, resumeProjectId]);

  useEffect(() => {
    if (
      !setupProject ||
      (setupProject.state !== 'cloning' && setupProject.state !== 'container_starting')
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const detail = await client.getProject(setupProject.id);
        if (!cancelled) {
          setSetupProject(detail.project);
          setProjectSettings(detail.settings);
        }
      } catch {
        // The overview remains the durable fallback; retry transient read failures.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 2_000);
      }
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, setupProject]);

  const analyzeProject = useCallback(
    (project: ProjectRecord) => {
      if (detectionAttempted.current === project.id) return;
      detectionAttempted.current = project.id;
      setError(undefined);
      void client
        .getDevServerDetection(project.id)
        .then(setDetection)
        .catch((caught) => {
          detectionAttempted.current = null;
          setError(caught instanceof VerityApiError ? caught.message : 'Could not analyze project');
        });
    },
    [client],
  );

  const activeSetupProjectId = setupProject?.state === 'active' ? setupProject.id : null;

  useEffect(() => {
    if (setupProject?.state === 'active') analyzeProject(setupProject);
  }, [analyzeProject, setupProject]);

  useEffect(() => {
    if (activeSetupProjectId === null) return;
    const generation = ++settingsGeneration.current;
    void client
      .getProject(activeSetupProjectId)
      .then(async (detail) => {
        if (generation !== settingsGeneration.current) return;
        setProjectSettings((current) => detail.settings ?? current);
        const dopplerProject = detail.settings?.dopplerProject;
        const dopplerConfig = detail.settings?.dopplerConfig;
        const verification =
          dopplerProject && dopplerConfig
            ? await client.listDopplerConfigs(dopplerProject)
            : { error: 'Doppler mapping is missing' };
        if (generation !== settingsGeneration.current) return;
        const verified =
          !('error' in verification) &&
          verification.configs.some((candidate) => candidate.name === dopplerConfig);
        setSecretsVerified(verified);
        if (secretsMountAttempted) {
          setSecretsMountAttempted(false);
          setSecretsMountFailed(!verified);
        }
      })
      .catch(() => {
        if (generation !== settingsGeneration.current) return;
        setSecretsVerified(false);
        if (!secretsMountAttempted) return;
        setSecretsMountAttempted(false);
        setSecretsMountFailed(true);
      });
  }, [activeSetupProjectId, client, secretsMountAttempted]);

  const startProvisioning = useCallback(
    (project: ProjectRecord) => {
      const run = (confirmWarnings = false): void => {
        setCreating(true);
        setError(undefined);
        setSetupMessage('Starting project setup…');
        void client
          .repairProject(project.id, { confirmWarnings })
          .then((queued) => {
            setSetupProject(queued);
            setSetupMessage(null);
          })
          .catch((caught) => {
            setSetupMessage(null);
            setSecretsMountFailed(true);
            if (
              caught instanceof VerityApiError &&
              caught.requiresConfirmation &&
              caught.warnings.length > 0
            ) {
              setError('Project setup needs your confirmation.');
              Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Continue', onPress: () => run(true) },
              ]);
              return;
            }
            setError(
              caught instanceof VerityApiError ? caught.message : 'Could not prepare project',
            );
          })
          .finally(() => setCreating(false));
      };
      run();
    },
    [client],
  );

  useEffect(() => {
    if (
      !resumeProjectId ||
      !setupProject ||
      setupProject.state !== 'absent' ||
      setupProject.setupStatus !== 'pending' ||
      resumeProvisionAttempted.current
    )
      return;
    resumeProvisionAttempted.current = true;
    startProvisioning(setupProject);
  }, [resumeProjectId, setupProject, startProvisioning]);

  const onCreate = useCallback(() => {
    if (creating) return;
    const name = localName.trim();
    const body: CreateProjectRequest | undefined =
      mode === 'local'
        ? name === ''
          ? undefined
          : { kind: 'local', name }
        : selected === null
          ? undefined
          : { repo: repositoryName(selected) };
    if (body === undefined) return;
    setCreating(true);
    setError(undefined);
    void (async () => {
      try {
        const created = await client.createProject(body);
        setSetupProject(created);
        startProvisioning(created);
      } catch (caught) {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not add project');
        setCreating(false);
      }
    })();
  }, [mode, localName, selected, creating, client, startProvisioning]);

  const retrySetup = useCallback(() => {
    if (!setupProject || creating) return;
    startProvisioning(setupProject);
  }, [creating, setupProject, startProvisioning]);

  const configureDetectedServers = useCallback(() => {
    if (!setupProject || !detection?.fingerprint || creating) return;
    const fingerprint = detection.fingerprint;
    const suggestions = detection.suggestions.filter(
      ({ status }) => status === 'new' || status === 'changed',
    );
    if (suggestions.length === 0) return;
    const run = (confirmWarnings = false): void => {
      setCreating(true);
      setError(undefined);
      setSetupMessage('Configuring Dev Server…');
      void client
        .setupDetectedDevServers(setupProject.id, {
          fingerprint,
          confirmWarnings,
          devServers: suggestions.map((suggestion) => ({
            sourceKey: suggestion.key,
            name: suggestion.name,
            command: suggestion.command,
            workdir: suggestion.workdir,
            containerPort: suggestion.containerPort,
          })),
        })
        .then((queued) => {
          setSetupProject(queued);
          setDetection((current) =>
            current ? { ...current, reviewedFingerprint: current.fingerprint } : current,
          );
          setSetupMessage(null);
        })
        .catch((caught) => {
          setSetupMessage(null);
          if (
            caught instanceof VerityApiError &&
            caught.requiresConfirmation &&
            caught.warnings.length > 0
          ) {
            Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Continue', onPress: () => run(true) },
            ]);
            return;
          }
          setError(caught instanceof VerityApiError ? caught.message : 'Could not add Dev Server');
        })
        .finally(() => setCreating(false));
    };
    run();
  }, [client, creating, detection, setupProject]);

  const chooseSecrets = useCallback(() => {
    if (creating) return;
    setCreating(true);
    setError(undefined);
    void client
      .listDopplerProjects()
      .then((result) => {
        if ('error' in result) {
          setError(
            result.error === 'not configured'
              ? 'Doppler is not connected yet. You can skip this step and connect it later in project settings.'
              : result.error,
          );
          return;
        }
        setDopplerProjects(result.projects);
        setSecretsStep('projects');
      })
      .catch(() => setError('Could not load Doppler projects'))
      .finally(() => setCreating(false));
  }, [client, creating]);

  const chooseDopplerProject = useCallback(
    (slug: string) => {
      if (creating) return;
      setCreating(true);
      setError(undefined);
      setDopplerProject(slug);
      void client
        .listDopplerConfigs(slug)
        .then((result) => {
          if ('error' in result) {
            setError(result.error);
            return;
          }
          setDopplerConfigs(result.configs);
          setSecretsStep('configs');
        })
        .catch(() => setError('Could not load Doppler configs'))
        .finally(() => setCreating(false));
    },
    [client, creating],
  );

  const bindDopplerConfig = useCallback(
    (config: string) => {
      if (!setupProject || !dopplerProject || creating) return;
      const restart = (confirmWarnings = false): void => {
        setCreating(true);
        setError(undefined);
        setSecretsStep('saving');
        setSetupMessage('Connecting secrets…');
        void client
          .updateProjectSettings(setupProject.id, {
            dopplerProject,
            dopplerConfig: config,
          })
          .then((saved) => {
            setSecretsVerified(false);
            setProjectSettings(saved);
            return client.recreateProjectContainer(setupProject.id, { confirmWarnings });
          })
          .then((project) => {
            setSetupProject(project);
            setSecretsMountAttempted(true);
            setSecretsMountFailed(false);
            setSecretsStep('pending');
            setSetupMessage(null);
          })
          .catch((caught) => {
            setSetupMessage(null);
            if (
              caught instanceof VerityApiError &&
              caught.requiresConfirmation &&
              caught.warnings.length > 0
            ) {
              Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
                {
                  text: 'Cancel',
                  style: 'cancel',
                  onPress: () => setSecretsStep('configs'),
                },
                { text: 'Continue', onPress: () => restart(true) },
              ]);
              return;
            }
            setSecretsStep('configs');
            setError(caught instanceof VerityApiError ? caught.message : 'Could not add secrets');
          })
          .finally(() => setCreating(false));
      };
      restart();
    },
    [client, creating, dopplerProject, setupProject],
  );

  const retrySecretsMount = useCallback(() => {
    if (!setupProject || creating) return;
    const run = (confirmWarnings = false): void => {
      setCreating(true);
      setError(undefined);
      setSecretsMountFailed(false);
      setSetupMessage('Connecting secrets…');
      void client
        .recreateProjectContainer(setupProject.id, { confirmWarnings })
        .then((project) => {
          setSetupProject(project);
          setSecretsMountAttempted(true);
          setSetupMessage(null);
        })
        .catch((caught) => {
          setSetupMessage(null);
          setSecretsMountFailed(true);
          if (
            caught instanceof VerityApiError &&
            caught.requiresConfirmation &&
            caught.warnings.length > 0
          ) {
            Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Continue', onPress: () => run(true) },
            ]);
            return;
          }
          setError(caught instanceof VerityApiError ? caught.message : 'Could not add secrets');
        })
        .finally(() => setCreating(false));
    };
    run();
  }, [client, creating, setupProject]);

  const baseSetupStatus = setupProject ? projectSetupStatus(setupProject, detection) : null;
  const devServersReady = detection !== null && !hasUnreviewedDevServers(detection);
  const secretsBound = Boolean(projectSettings?.dopplerProject && projectSettings.dopplerConfig);
  const secretsReady =
    secretsBound && secretsVerified && !secretsMountAttempted && !secretsMountFailed;
  const setupComplete =
    setupProject?.state === 'active' &&
    devServersReady &&
    (secretsReady || secretsStep === 'skipped');
  const terminalStatus = secretsStep === 'skipped' ? 'secrets_skipped' : 'complete';
  const terminalPersisted = setupProject?.setupStatus === terminalStatus;
  const setupStatus =
    terminalPersisted && baseSetupStatus
      ? { ...baseSetupStatus, label: 'Project ready', step: 5, intent: 'ready' as const }
      : baseSetupStatus;
  const setupStatusLabel = setupMessage ?? setupStatus?.label;

  const saveTerminalStatus = useCallback(
    (status: 'secrets_skipped' | 'complete') => {
      if (!setupProject || creating) return;
      if (status === 'secrets_skipped') setSecretsStep('skipped');
      setCreating(true);
      setError(undefined);
      setCompletionSaveFailed(false);
      void client
        .setProjectSetupStatus(setupProject.id, status)
        .then((project) => {
          setSetupProject(project);
          if (status === 'secrets_skipped') setSecretsStep('skipped');
        })
        .catch((caught) => {
          setCompletionSaveFailed(true);
          setError(
            caught instanceof VerityApiError ? caught.message : 'Could not save setup progress',
          );
        })
        .finally(() => setCreating(false));
    },
    [client, creating, setupProject],
  );

  useEffect(() => {
    if (!setupComplete || terminalPersisted || completionSaveFailed || creating) return;
    saveTerminalStatus(terminalStatus);
  }, [
    completionSaveFailed,
    creating,
    saveTerminalStatus,
    setupComplete,
    terminalPersisted,
    terminalStatus,
  ]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <Stack.Screen options={{ title: 'New project' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {setupProject && setupStatus ? (
          <View
            style={styles.setupCard}
            accessibilityRole="progressbar"
            accessibilityLabel="Project setup progress"
            accessibilityLiveRegion="polite"
            accessibilityValue={{
              min: 0,
              max: setupStatus.total,
              now: setupStatus.step,
              text: setupStatusLabel,
            }}
          >
            <Text style={styles.setupTitle}>{repositoryName(setupProject)}</Text>
            <View style={styles.progressRow}>
              {Array.from({ length: setupStatus.total }, (_, index) => (
                <View
                  key={index}
                  style={[
                    styles.progressSegment,
                    index < setupStatus.step ? styles.progressSegmentComplete : null,
                    setupStatus.intent === 'error' ? styles.progressSegmentError : null,
                  ]}
                />
              ))}
            </View>
            <Text style={setupStatus.intent === 'error' ? styles.error : styles.setupStatus}>
              {setupStatusLabel}
            </Text>
            {setupProject.provisionError ? (
              <Text style={styles.error}>{setupProject.provisionError}</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.hint}>
              Setup continues in the background. You can return to the overview at any time.
            </Text>
            {hasUnreviewedDevServers(detection) ? (
              <>
                <Text style={styles.setupStatus}>
                  {detection?.suggestions
                    .filter(({ status }) => status === 'new' || status === 'changed')
                    .map(({ name }) => name)
                    .join(', ')}
                </Text>
                <Pressable
                  style={[styles.create, creating ? styles.createDisabled : null]}
                  disabled={creating}
                  accessibilityRole="button"
                  accessibilityLabel="Set up detected Dev Servers"
                  onPress={configureDetectedServers}
                >
                  {creating ? (
                    <ActivityIndicator color={theme.colors.onPrimary} />
                  ) : (
                    <Text style={styles.createLabel}>Set up Dev Server</Text>
                  )}
                </Pressable>
              </>
            ) : null}
            {setupProject.state === 'active' &&
            devServersReady &&
            !secretsBound &&
            secretsStep === 'pending' ? (
              <View style={styles.setupStep} accessibilityLabel="Project secrets setup">
                <Text style={styles.setupStatus}>Add project secrets?</Text>
                <Text style={styles.hint}>
                  Connect a Doppler config and Verity will mount its secrets into this project only.
                </Text>
                <Pressable
                  style={[styles.create, creating ? styles.createDisabled : null]}
                  disabled={creating}
                  accessibilityRole="button"
                  accessibilityLabel="Choose Doppler secrets"
                  onPress={chooseSecrets}
                >
                  <Text style={styles.createLabel}>Choose Doppler secrets</Text>
                </Pressable>
                <Pressable
                  style={styles.reload}
                  accessibilityRole="button"
                  accessibilityLabel="Skip project secrets"
                  onPress={() => saveTerminalStatus('secrets_skipped')}
                >
                  <Text style={styles.reloadLabel}>Not now</Text>
                </Pressable>
              </View>
            ) : null}
            {secretsStep === 'projects' ? (
              <View style={styles.setupStep} accessibilityLabel="Doppler projects">
                <Text style={styles.setupStatus}>Choose a Doppler project</Text>
                {dopplerProjects.length === 0 ? (
                  <Text style={styles.hint}>No Doppler projects found.</Text>
                ) : (
                  dopplerProjects.map((project) => (
                    <Pressable
                      key={project.slug}
                      style={styles.option}
                      accessibilityRole="button"
                      accessibilityLabel={`Doppler project ${project.name}`}
                      onPress={() => chooseDopplerProject(project.slug)}
                    >
                      <Text style={styles.optionTitle}>{project.name}</Text>
                    </Pressable>
                  ))
                )}
                <Pressable
                  style={styles.reload}
                  accessibilityRole="button"
                  accessibilityLabel="Skip project secrets"
                  onPress={() => saveTerminalStatus('secrets_skipped')}
                >
                  <Text style={styles.reloadLabel}>Not now</Text>
                </Pressable>
              </View>
            ) : null}
            {secretsStep === 'configs' ? (
              <View style={styles.setupStep} accessibilityLabel="Doppler configs">
                <Text style={styles.setupStatus}>Choose an environment</Text>
                {dopplerConfigs.map((config) => (
                  <Pressable
                    key={config.name}
                    style={styles.option}
                    accessibilityRole="button"
                    accessibilityLabel={`Doppler config ${config.name}`}
                    onPress={() => bindDopplerConfig(config.name)}
                  >
                    <Text style={styles.optionTitle}>{config.name}</Text>
                    <Text style={styles.hint}>{config.environment}</Text>
                  </Pressable>
                ))}
                <Pressable
                  style={styles.reload}
                  accessibilityRole="button"
                  accessibilityLabel="Back to Doppler projects"
                  onPress={() => setSecretsStep('projects')}
                >
                  <Text style={styles.reloadLabel}>Back</Text>
                </Pressable>
              </View>
            ) : null}
            {setupProject.state === 'active' &&
            devServersReady &&
            secretsBound &&
            !secretsReady &&
            secretsMountFailed ? (
              <View style={styles.setupStep} accessibilityLabel="Project secrets need attention">
                <Text style={styles.setupStatus}>Secrets could not be mounted</Text>
                <Text style={styles.hint}>
                  Check the Doppler connection and that the Verity secret store is unlocked, then
                  try again.
                </Text>
                <Pressable
                  style={[styles.create, creating ? styles.createDisabled : null]}
                  disabled={creating}
                  accessibilityRole="button"
                  accessibilityLabel="Retry project secrets"
                  onPress={retrySecretsMount}
                >
                  <Text style={styles.createLabel}>Try secrets again</Text>
                </Pressable>
              </View>
            ) : null}
            {setupComplete && terminalPersisted ? (
              <View style={styles.setupStep} accessibilityLabel="Project setup complete">
                <Text style={styles.setupStatus}>Your project is ready</Text>
                <Text style={styles.hint}>
                  {secretsBound
                    ? `Secrets: ${projectSettings?.dopplerProject} / ${projectSettings?.dopplerConfig}`
                    : 'Secrets: not connected'}
                </Text>
                <Pressable
                  style={styles.create}
                  accessibilityRole="button"
                  accessibilityLabel="Open project"
                  onPress={() => router.replace(`/project/${setupProject.id}`)}
                >
                  <Text style={styles.createLabel}>Open project</Text>
                </Pressable>
              </View>
            ) : null}
            {setupComplete && !terminalPersisted && completionSaveFailed ? (
              <Pressable
                style={styles.create}
                accessibilityRole="button"
                accessibilityLabel="Retry saving setup progress"
                onPress={() => saveTerminalStatus(terminalStatus)}
              >
                <Text style={styles.createLabel}>Finish setup</Text>
              </Pressable>
            ) : null}
            {setupProject.state === 'active' && error && !detection ? (
              <Pressable
                style={styles.create}
                accessibilityRole="button"
                accessibilityLabel="Retry project analysis"
                onPress={() => analyzeProject(setupProject)}
              >
                <Text style={styles.createLabel}>Retry analysis</Text>
              </Pressable>
            ) : null}
            {(setupProject.state === 'failed' || error) && setupProject.state !== 'active' ? (
              <Pressable
                style={[styles.create, creating ? styles.createDisabled : null]}
                disabled={creating}
                accessibilityRole="button"
                accessibilityLabel="Retry project setup"
                onPress={retrySetup}
              >
                {creating ? (
                  <ActivityIndicator color={theme.colors.onPrimary} />
                ) : (
                  <Text style={styles.createLabel}>Try again</Text>
                )}
              </Pressable>
            ) : null}
            <Pressable
              style={styles.reload}
              accessibilityRole="button"
              accessibilityLabel="Return to overview"
              // `dismissTo`, not `replace`: the wizard sits on top of the home
              // it was opened from, so replacing it with `/` stacks a second
              // home whose header offers a back button to the first one.
              onPress={() => router.dismissTo('/')}
            >
              <Text style={styles.reloadLabel}>Back to overview</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.label}>Start from</Text>
            <View style={styles.modeRow}>
              {(
                [
                  { key: 'github', label: 'GitHub repository' },
                  { key: 'local', label: 'Empty project' },
                ] as const
              ).map(({ key, label }) => (
                <Pressable
                  key={key}
                  style={[styles.mode, mode === key ? styles.modeActive : null]}
                  disabled={creating}
                  onPress={() => {
                    setMode(key);
                    setPickerOpen(false);
                    setError(undefined);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: mode === key }}
                  accessibilityLabel={label}
                >
                  <Text style={mode === key ? styles.modeLabelActive : styles.modeLabel}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {mode === 'local' ? (
              <>
                <Text style={styles.label}>Project name</Text>
                <TextInput
                  style={styles.input}
                  value={localName}
                  onChangeText={setLocalName}
                  editable={!creating}
                  placeholder="my-project"
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={100}
                  accessibilityLabel="Project name"
                />
                <Text style={styles.hint}>
                  Verity creates an empty Git repository and provisions a container for it. No
                  GitHub repository is involved — you can connect one later in project settings.
                </Text>
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </>
            ) : (
              <>
                <Text style={styles.label}>Repository</Text>
                <Pressable
                  style={styles.select}
                  onPress={() => setPickerOpen((open) => !open)}
                  disabled={loadingRepositories || creating || sortedRepositories.length === 0}
                  accessibilityRole="button"
                  accessibilityLabel="Repository to add"
                >
                  <Text style={selected ? styles.selectText : styles.selectPlaceholder}>
                    {loadingRepositories
                      ? 'Loading repositories...'
                      : selected
                        ? repositoryName(selected)
                        : 'No repositories available'}
                  </Text>
                </Pressable>
                {pickerOpen && sortedRepositories.length > 0 ? (
                  <View style={styles.optionList}>
                    {sortedRepositories.map((repository) => {
                      const active = repository.id === selected?.id;
                      return (
                        <Pressable
                          key={repository.id}
                          onPress={() => {
                            setSelectedId(repository.id);
                            setPickerOpen(false);
                          }}
                          style={[styles.option, active ? styles.optionActive : null]}
                          accessibilityRole="button"
                          accessibilityLabel={repositoryName(repository)}
                        >
                          <Text style={styles.optionTitle}>{repositoryName(repository)}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                <Text style={styles.hint}>
                  Verity clones the selected repository and provisions a container for it. You can
                  start sessions in the new project from the overview.
                </Text>
                {sortedRepositories.length === 0 && !loadingRepositories ? (
                  <Pressable
                    onPress={loadRepositories}
                    accessibilityRole="button"
                    accessibilityLabel="Reload repositories"
                    style={styles.reload}
                  >
                    <Text style={styles.reloadLabel}>Reload repositories</Text>
                  </Pressable>
                ) : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </>
            )}
          </>
        )}
      </ScrollView>

      {!setupProject ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            style={[styles.create, canCreate ? null : styles.createDisabled]}
            onPress={onCreate}
            disabled={!canCreate}
            accessibilityRole="button"
            accessibilityLabel="Create project"
          >
            {creating ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.createLabel}>Create project</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1, backgroundColor: theme.colors.background },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '600' },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 20 * theme.fontScale,
  },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: theme.spacing.md,
  },
  select: {
    minHeight: 52,
    justifyContent: 'center',
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  selectText: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  modeRow: { flexDirection: 'row', gap: theme.spacing.xs },
  mode: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modeActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surfaceAlt },
  modeLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  modeLabelActive: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
    textAlign: 'center',
  },
  input: {
    minHeight: 52,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  selectPlaceholder: { color: theme.colors.textFaint, fontSize: theme.text.md },
  optionList: {
    gap: theme.spacing.xs,
    padding: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  option: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surfaceAlt },
  optionTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  reload: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  reloadLabel: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '700' },
  hint: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
    marginTop: theme.spacing.xs,
  },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm, marginTop: theme.spacing.sm },
  setupCard: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  setupTitle: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  setupStatus: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  setupStep: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  progressRow: { flexDirection: 'row', gap: theme.spacing.xs },
  progressSegment: {
    flex: 1,
    height: 5,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
  },
  progressSegmentComplete: { backgroundColor: theme.colors.primary },
  progressSegmentError: { backgroundColor: theme.colors.tone.danger },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  create: {
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  createDisabled: { backgroundColor: theme.colors.border },
  createLabel: { color: theme.colors.onPrimary, fontSize: theme.text.md, fontWeight: '700' },
}));

function repositoryName(project: ProjectRecord): string {
  return project.owner + '/' + project.repo;
}
