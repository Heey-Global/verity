// The repositories one code host offers, searchable, as a single-choice list.
// Shared by New project and the project "Repository" screen.
import { VerityApiError, type CodeHost, type VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from './CodeHostIcon';
import { settingsStyles as styles } from './settings/settingsStyles';
import { Button, Group, Row, SearchField, Sheet, StatusTag, Text, TextField } from './ui';

export type Repository = { owner: string; repo: string; archived?: boolean | undefined };
const repositoryName = (repository: Repository) => `${repository.owner}/${repository.repo}`;

export function RepositoryPicker({
  client,
  host,
  initialGithubRepositories,
  selected,
  onSelect,
  disabled = false,
  autoSelect = true,
  exclude,
  onAdd,
}: {
  client: VerityClient;
  host: CodeHost;
  /** GitHub repositories already loaded with the code hosts, to skip a refetch. */
  initialGithubRepositories?: readonly Repository[] | undefined;
  /** `owner/repo`, or null when nothing is selectable. */
  selected: string | null;
  onSelect: (repository: string | null) => void;
  disabled?: boolean;
  /** Preselect the first active repository. Off where a choice has consequences
   *  a single tap should not trigger (linking pushes history). */
  autoSelect?: boolean;
  /** `owner/repo` names left out of the list, such as those already connected. */
  exclude?: readonly string[] | undefined;
  /** Turns the list into one-tap actions: a row adds its repository instead of
   *  selecting it, so no separate confirm button is needed. */
  onAdd?: ((repository: string) => void) | undefined;
}) {
  const { theme } = useUnistyles();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);
  const [query, setQuery] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loadedHost = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    // A repository chosen on another host must never travel with the new host's
    // connection, not even while the new list is still loading.
    const sameHost = loadedHost.current === host.id;
    loadedHost.current = host.id;
    if (!sameHost) onSelect(null);
    setQuery('');
    setError(undefined);
    setLoading(true);
    const load: Promise<readonly Repository[]> =
      host.provider === 'github'
        ? generation === 0 && initialGithubRepositories !== undefined
          ? Promise.resolve(initialGithubRepositories)
          : client.listAvailableRepositories()
        : client.listConnectionRepositories(host.id);
    void load
      .then((next) => {
        if (!active) return;
        const sorted = [...next].sort((a, b) => repositoryName(a).localeCompare(repositoryName(b)));
        setRepositories(sorted);
        const kept =
          sameHost &&
          sorted.some((repository) => repositoryName(repository) === selectedRef.current);
        if (kept) return;
        const first = autoSelect ? sorted.find((repository) => !repository.archived) : undefined;
        onSelect(first ? repositoryName(first) : null);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setRepositories([]);
        onSelect(null);
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load repositories');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // `onSelect` is a setter from the parent; reloading on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelect, client, generation, host, initialGithubRepositories]);

  const offered = useMemo(() => {
    const excluded = new Set(exclude?.map((name) => name.toLowerCase()));
    return repositories.filter(
      (repository) => !excluded.has(repositoryName(repository).toLowerCase()),
    );
  }, [exclude, repositories]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? offered
      : offered.filter((repository) => repositoryName(repository).toLowerCase().includes(needle));
  }, [query, offered]);

  return (
    <>
      {onAdd ? (
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${host.title} repositories`}
        />
      ) : (
        <TextField
          label="Search repositories"
          value={query}
          onChangeText={setQuery}
          placeholder={`owner/repository on ${host.title}`}
          literal
          disabled={disabled || loading || repositories.length === 0}
        />
      )}
      {loading ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : visible.length > 0 ? (
        <Group>
          {visible.map((repository) =>
            onAdd ? (
              <Row
                key={repositoryName(repository)}
                leading={{
                  element: <CodeHostIcon provider={host.provider} color={theme.colors.textMuted} />,
                }}
                title={repository.repo}
                subtitle={repositoryName(repository)}
                trailing={
                  repository.archived ? (
                    <StatusTag intent="optional" label="Archived" />
                  ) : (
                    <Text tone="faint">Add</Text>
                  )
                }
                disabled={disabled}
                accessibilityLabel={`Add ${repositoryName(repository)}`}
                onPress={() => onAdd(repositoryName(repository))}
              />
            ) : (
              <Row
                key={repositoryName(repository)}
                title={repositoryName(repository)}
                {...(repository.archived
                  ? { trailing: <StatusTag intent="optional" label="Archived" /> }
                  : {})}
                selected={selected === repositoryName(repository)}
                disabled={disabled}
                onPress={() => onSelect(repositoryName(repository))}
              />
            ),
          )}
        </Group>
      ) : (
        <>
          <Text variant="footnote" tone="faint">
            {error ??
              (repositories.length === 0
                ? `No repositories on ${host.title} yet.`
                : offered.length === 0
                  ? 'Every repository is already connected.'
                  : 'No repository matches the search.')}
          </Text>
          <View style={styles.selfStart}>
            <Button
              label="Reload repositories"
              variant="text"
              size="compact"
              icon="refresh-cw"
              onPress={() => setGeneration((value) => value + 1)}
            />
          </View>
        </>
      )}
    </>
  );
}

/** One code host as an option of a single-choice list, with its own mark. */
export function CodeHostOption({
  host,
  selected,
  disabled = false,
  onPress,
}: {
  host: CodeHost;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Row
      leading={{ element: <CodeHostIcon provider={host.provider} color={theme.colors.action} /> }}
      title={host.title}
      subtitle={host.host}
      selected={selected}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

/**
 * The "Add repository" sheet: the code hosts to choose from when there are
 * several, and one tap on a repository adds it. Shared by the project's
 * repositories and New project, so both offer repositories the same way.
 */
export function AddRepositorySheet({
  client,
  visible,
  hosts,
  githubRepositories,
  exclude,
  disabled = false,
  onAdd,
  onClose,
}: {
  client: VerityClient;
  visible: boolean;
  hosts: readonly CodeHost[];
  githubRepositories?: readonly Repository[] | undefined;
  /** `owner/repo` names of the host left out, such as those already chosen. */
  exclude: (host: CodeHost) => readonly string[];
  disabled?: boolean;
  onAdd: (host: CodeHost, repository: string) => void;
  onClose: () => void;
}) {
  const [hostId, setHostId] = useState<string | undefined>(hosts[0]?.id);
  const host = hosts.find((candidate) => candidate.id === hostId) ?? hosts[0];
  return (
    <Sheet visible={visible} title="Add repository" onClose={onClose}>
      {hosts.length > 1 ? (
        <Group>
          {hosts.map((candidate) => (
            <CodeHostOption
              key={candidate.id}
              host={candidate}
              selected={candidate.id === host?.id}
              disabled={disabled}
              onPress={() => setHostId(candidate.id)}
            />
          ))}
        </Group>
      ) : null}
      {host ? (
        <RepositoryPicker
          // A fresh list per host: its search and selection belong to that host.
          key={host.id}
          client={client}
          host={host}
          initialGithubRepositories={githubRepositories}
          selected={null}
          onSelect={ignoreSelection}
          disabled={disabled}
          autoSelect={false}
          exclude={exclude(host)}
          onAdd={(repository) => onAdd(host, repository)}
        />
      ) : null}
    </Sheet>
  );
}

const ignoreSelection = () => undefined;
