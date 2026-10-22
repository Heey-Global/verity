// The repository behind a project. A linked project shows where it lives; a local
// one can be connected to an existing repository on GitHub or Forgejo — whichever
// code hosts this server is connected to. The Verity-wide screens own the code-host
// connections and the commit identity; nothing about those is repeated here.
import {
  VerityApiError,
  codeHostForProject,
  projectRepoRef,
  providerName,
  repositoryWebUrl,
  type CodeHost,
  type ForgeConnection,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { CodeHostOption, RepositoryPicker } from '../../../../components/RepositoryPicker';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { loadCodeHosts } from '../../../../lib/codeHosts';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';
import { Button, Group, useConfirm } from '../../../../components/ui';

export default function ProjectRepositoryScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Repository"
      />
    );
  }
  return <ProjectRepositoryView client={client} projectId={projectId} />;
}

function ProjectRepositoryView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load, onProjectUpdated } = useProjectDetail(client, projectId);
  const [connections, setConnections] = useState<ForgeConnection[] | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => client.listConnections())
      .then((list) => {
        if (active) setConnections(list?.connections ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
      </View>
    );
  }
  if (detail === undefined) {
    return (
      <SettingsMessage
        title="Couldn't load project"
        subtitle={error ?? 'Unknown error'}
        screenTitle="Repository"
        onRetry={() => load()}
      />
    );
  }
  const { project } = detail;
  const host = codeHostForProject(project, connections);
  return (
    <SettingsScaffold
      title="Repository"
      detail
      state={{ error, saving: false }}
      onRetry={() => load()}
    >
      {project.kind === 'local' ? (
        <LinkRepositorySection client={client} project={project} onUpdated={onProjectUpdated} />
      ) : (
        <SettingsGroup title="Repository">
          <SettingsPanel>
            <Fact
              label="Code host"
              value={
                project.kind === 'forgejo'
                  ? host
                    ? `Forgejo (${host.host})`
                    : 'Forgejo'
                  : providerName('github')
              }
            />
            <Fact label="Repository" value={projectRepoRef(project) ?? project.repo} />
            {project.kind === 'github' ? (
              <Fact
                label="Latest release"
                value={project.latestReleaseTag ?? 'No published release'}
              />
            ) : null}
            <Fact label="Created" value={formatDate(project.createdAt)} />
            {host ? (
              <View style={styles.selfStart}>
                <Button
                  label="Open in browser"
                  variant="secondary"
                  size="compact"
                  icon="external-link"
                  role="link"
                  onPress={() =>
                    void Linking.openURL(repositoryWebUrl(host, project.owner, project.repo)).catch(
                      () => undefined,
                    )
                  }
                />
              </View>
            ) : null}
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

/** The "connect later" bridge for a local project. Verity does not create
 *  repositories, so the operator picks one the code host already has; the server
 *  pushes this project's history into it and rewrites the project's identity. An
 *  empty repository receives the history on its default branch; one that already
 *  has history gets it on an import branch with a pull request to merge — the
 *  server never force-pushes over what is there. */
function LinkRepositorySection({
  client,
  project,
  onUpdated,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onUpdated: (project: ProjectRecord) => void;
}) {
  const { theme } = useUnistyles();
  const [confirm, confirmSheet] = useConfirm();
  const [hosts, setHosts] = useState<CodeHost[] | null>(null);
  const [githubRepositories, setGithubRepositories] = useState<ProjectRecord[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void loadCodeHosts(client, { forProjects: true }).then((loaded) => {
      if (!active) return;
      setHosts(loaded.hosts);
      setGithubRepositories(loaded.githubRepositories);
      setHostId((current) => current ?? loaded.hosts[0]?.id ?? null);
    });
    return () => {
      active = false;
    };
  }, [client]);

  const host = hosts?.find((candidate) => candidate.id === hostId);

  const link = useCallback(() => {
    if (host === undefined || selected === null || linking) return;
    const repo = selected;
    const hostName = host.title;
    confirm({
      title: `Connect to ${hostName}`,
      message:
        `Verity publishes this project's history to ${repo} on ${hostName} and rebuilds its ` +
        'container. An empty repository receives it directly; one that already has history ' +
        'gets a pull request for you to merge. Any running session in this project restarts.',
      confirmLabel: 'Connect',
      destructive: true,
      onConfirm: () => {
        setLinking(true);
        setError(undefined);
        const request =
          host.provider === 'forgejo'
            ? client.linkProject(project.id, repo, host.id)
            : client.linkProjectToGitHub(project.id, repo);
        void request
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
                  }. Open it on ${hostName} to publish them.`,
              );
            }
          })
          .catch((caught: unknown) =>
            setError(
              caught instanceof VerityApiError
                ? caught.message
                : `Could not connect to ${hostName}`,
            ),
          )
          .finally(() => setLinking(false));
      },
    });
  }, [client, confirm, host, linking, onUpdated, project.id, selected]);

  if (hosts === null) return <ActivityIndicator color={theme.colors.text} />;
  if (hosts.length === 0) {
    return (
      <SettingsGroup
        title="Code host"
        description="This project lives only on this Verity server. Connect GitHub or Forgejo in Connections to link it to a repository there."
      >
        <View style={styles.selfStart}>
          <Button
            label="Open Connections"
            variant="secondary"
            size="compact"
            onPress={() => router.push('/settings/services')}
          />
        </View>
      </SettingsGroup>
    );
  }
  return (
    <>
      <SettingsGroup
        title="Code host"
        description="This project has no repository yet. Connect it to an existing repository to get pull requests, issues and CI status."
      >
        <Group>
          {hosts.map((candidate) => (
            <CodeHostOption
              key={candidate.id}
              host={candidate}
              selected={candidate.id === hostId}
              disabled={linking}
              onPress={() => setHostId(candidate.id)}
            />
          ))}
        </Group>
      </SettingsGroup>
      {host ? (
        <SettingsGroup title="Repository">
          <RepositoryPicker
            client={client}
            host={host}
            initialGithubRepositories={githubRepositories}
            selected={selected}
            onSelect={setSelected}
            disabled={linking}
          />
          <View style={styles.selfStart}>
            <Button
              label="Connect repository"
              accessibilityLabel={`Connect project to ${host.title}`}
              loading={linking}
              disabled={selected === null}
              onPress={link}
            />
          </View>
          {error ? <Text style={styles.fieldError}>{error}</Text> : null}
        </SettingsGroup>
      ) : null}
      {confirmSheet}
    </>
  );
}
