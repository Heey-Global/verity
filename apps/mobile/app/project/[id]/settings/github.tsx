// GitHub, per project: the repository this project is bound to. A connected
// project shows what it is bound to; a local one gets the "connect later"
// bridge. The Verity-wide GitHub screen owns the App installation and the
// commit identity — nothing about those is repeated here.
import {
  VerityApiError,
  projectRepoRef,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectGitHubScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="GitHub"
      />
    );
  }
  return <ProjectGitHubView client={client} projectId={projectId} />;
}

function ProjectGitHubView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load, onProjectUpdated } = useProjectDetail(client, projectId);

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.setup.text} />
      </View>
    );
  }
  if (detail === undefined) {
    return (
      <SettingsMessage
        title="Couldn't load project"
        subtitle={error ?? 'Unknown error'}
        screenTitle="GitHub"
        onRetry={() => load()}
      />
    );
  }
  const { project } = detail;
  return (
    <SettingsScaffold title="GitHub" detail state={{ error, saving: false }} onRetry={() => load()}>
      {project.kind === 'local' ? (
        <LinkGitHubSection client={client} project={project} onUpdated={onProjectUpdated} />
      ) : (
        <SettingsGroup title="Repository">
          <SettingsPanel>
            <Fact label="Repository" value={projectRepoRef(project) ?? project.repo} />
            <Fact
              label="Latest release"
              value={project.latestReleaseTag ?? 'No published release'}
            />
            <Fact label="Created" value={formatDate(project.createdAt)} />
          </SettingsPanel>
        </SettingsGroup>
      )}
    </SettingsScaffold>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.serviceStatusRow}>
      <Text style={styles.pathLabel}>{label}</Text>
      <Text style={styles.reproStatus} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

/** The "connect later" bridge for a project created without GitHub. Verity does
 *  not create repositories, so the operator picks one the GitHub App installation
 *  already sees; the server pushes this project's history into it and rewrites the
 *  project's identity. An empty repository receives the history on its default
 *  branch; one that already has history gets it on an import branch with a pull
 *  request to merge — the server never force-pushes over what is there. */
function LinkGitHubSection({
  client,
  project,
  onUpdated,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onUpdated: (project: ProjectRecord) => void;
}) {
  const [repositories, setRepositories] = useState<ProjectRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void client
      .listAvailableRepositories()
      .then((next) => {
        if (cancelled) return;
        setRepositories(next);
        setSelectedId((current) => current ?? next[0]?.id ?? null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load repositories');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const sorted = useMemo(
    () =>
      [...repositories].sort((a, b) =>
        `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
      ),
    [repositories],
  );
  const selected = sorted.find((candidate) => candidate.id === selectedId) ?? sorted[0] ?? null;

  const link = useCallback(() => {
    if (selected === null || linking) return;
    const repo = `${selected.owner}/${selected.repo}`;
    Alert.alert(
      'Connect to GitHub',
      `Verity publishes this project's history to ${repo} and rebuilds its container. ` +
        'An empty repository receives it directly; one that already has history gets a ' +
        'pull request for you to merge. Any running session in this project restarts.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Connect',
          style: 'destructive',
          onPress: () => {
            setLinking(true);
            setError(undefined);
            void client
              .linkProjectToGitHub(project.id, repo)
              .then((linked) => {
                onUpdated(linked.project);
                // The history landed on a branch, not on the default branch — say so,
                // or the operator reads "connected" and never merges the pull request.
                if (linked.pullRequest !== undefined) {
                  Alert.alert(
                    'Pull request opened',
                    `${repo} already had history, so this project's files arrived on ` +
                      `${linked.importBranch ?? 'an import branch'}. Merge pull request #` +
                      `${String(linked.pullRequest.number)} to publish them.`,
                  );
                } else if (linked.importBranch !== undefined) {
                  Alert.alert(
                    'History pushed to a branch',
                    `This project's files are on ${linked.importBranch}, but the pull request ` +
                      `could not be opened${
                        linked.pullRequestError === undefined ? '' : `: ${linked.pullRequestError}`
                      }. Open it on GitHub to publish them.`,
                  );
                }
              })
              .catch((caught) =>
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not connect to GitHub',
                ),
              )
              .finally(() => setLinking(false));
          },
        },
      ],
    );
  }, [client, linking, onUpdated, project.id, selected]);

  return (
    <SettingsGroup
      title="Repository"
      description="This project has no GitHub repository. Connect it to an existing repository to combine its history with this project and get pull requests, issues and CI status."
    >
      <SettingsPanel>
        <Pressable
          style={({ pressed }) => [
            styles.reproButton,
            loading || linking || sorted.length === 0 ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => setPickerOpen((open) => !open)}
          disabled={loading || linking || sorted.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Repository to connect"
        >
          <Text style={styles.reproButtonLabel}>
            {loading
              ? 'Loading repositories…'
              : selected
                ? `${selected.owner}/${selected.repo}`
                : 'No repositories available'}
          </Text>
        </Pressable>
        {pickerOpen ? (
          <SettingsListPanel>
            {sorted.map((repository) => (
              <Pressable
                key={repository.id}
                style={({ pressed }) => [styles.navRow, pressed ? styles.pressed : null]}
                onPress={() => {
                  setSelectedId(repository.id);
                  setPickerOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${repository.owner}/${repository.repo}`}
              >
                <Text style={styles.navRowTitle}>
                  {repository.owner}/{repository.repo}
                </Text>
              </Pressable>
            ))}
          </SettingsListPanel>
        ) : null}
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            styles.selfStart,
            selected === null || linking ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={link}
          disabled={selected === null || linking}
          accessibilityRole="button"
          accessibilityLabel="Connect project to GitHub"
        >
          <Text style={styles.primaryButtonLabel}>
            {linking ? 'Connecting…' : 'Connect to GitHub'}
          </Text>
        </Pressable>
        {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      </SettingsPanel>
    </SettingsGroup>
  );
}
