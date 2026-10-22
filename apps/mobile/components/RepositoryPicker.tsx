// The repositories one code host offers, searchable, as a single-choice list.
// Shared by New project and the project "Repository" screen.
import { VerityApiError, type CodeHost, type VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from './CodeHostIcon';
import { settingsStyles as styles } from './settings/settingsStyles';
import { Button, Group, Row, StatusTag, Text, TextField } from './ui';

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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? repositories
      : repositories.filter((repository) =>
          repositoryName(repository).toLowerCase().includes(needle),
        );
  }, [query, repositories]);

  return (
    <>
      <TextField
        label="Search repositories"
        value={query}
        onChangeText={setQuery}
        placeholder={`owner/repository on ${host.title}`}
        literal
        disabled={disabled || loading || repositories.length === 0}
      />
      {loading ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : visible.length > 0 ? (
        <Group>
          {visible.map((repository) => (
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
          ))}
        </Group>
      ) : (
        <>
          <Text variant="footnote" tone="faint">
            {error ??
              (repositories.length === 0
                ? `No repositories on ${host.title} yet.`
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
