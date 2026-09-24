// Create a project, then manage runtime, Dev Servers, and integrations on its project page.
import {
  VerityApiError,
  type VerityClient,
  type CreateProjectRequest,
  type ProjectRecord,
} from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';

export default function NewProjectScreen() {
  const params = useLocalSearchParams<{ projectId?: string | string[] }>();
  const resumeProjectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const client = createVerityClient();
  useEffect(() => {
    if (resumeProjectId) router.replace(`/project/${resumeProjectId}`);
  }, [resumeProjectId]);
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
  if (resumeProjectId)
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  return <NewProject client={client} />;
}

function NewProject({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [repositories, setRepositories] = useState<ProjectRecord[]>([]);
  const [mode, setMode] = useState<'github' | 'local'>('github');
  const [localName, setLocalName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingRepositories, setLoadingRepositories] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();
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
      .catch((caught) =>
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load repositories'),
      )
      .finally(() => setLoadingRepositories(false));
  }, [client]);
  useEffect(() => {
    loadRepositories();
  }, [loadRepositories]);
  const onCreate = useCallback(() => {
    if (!canCreate) return;
    const body: CreateProjectRequest =
      mode === 'local'
        ? { kind: 'local', name: localName.trim() }
        : { repo: repositoryName(selected!) };
    setCreating(true);
    setError(undefined);
    void client
      .createProject(body)
      .then((project) => {
        // Setup progress is lifecycle state; optional integrations do not gate access.
        router.replace(`/project/${project.id}`);
        void client.setProjectSetupStatus(project.id, 'complete').catch(() => {
          // The project page retries migration of pending setup status.
        });
        void client.repairProject(project.id, { confirmWarnings: false }).catch((caught) => {
          if (
            caught instanceof VerityApiError &&
            caught.requiresConfirmation &&
            caught.warnings.length > 0
          ) {
            Alert.alert('Review project warning', caught.warnings.join('\n\n'), [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Continue',
                onPress: () => {
                  void client
                    .repairProject(project.id, { confirmWarnings: true })
                    .catch((retryError) => {
                      Alert.alert(
                        'Could not prepare project',
                        retryError instanceof VerityApiError
                          ? retryError.message
                          : 'Try again from the project page.',
                      );
                    });
                },
              },
            ]);
            return;
          }
          Alert.alert(
            'Could not prepare project',
            caught instanceof VerityApiError ? caught.message : 'Try again from the project page.',
          );
        });
      })
      .catch((caught) => {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not add project');
        setCreating(false);
      });
  }, [canCreate, client, localName, mode, selected]);
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <Stack.Screen options={{ title: 'New project' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
              <Text style={mode === key ? styles.modeLabelActive : styles.modeLabel}>{label}</Text>
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
              Verity creates an empty Git repository. Connect GitHub later in project settings.
            </Text>
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
                {sortedRepositories.map((repository) => (
                  <Pressable
                    key={repository.id}
                    onPress={() => {
                      setSelectedId(repository.id);
                      setPickerOpen(false);
                    }}
                    style={[
                      styles.option,
                      repository.id === selected?.id ? styles.optionActive : null,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={repositoryName(repository)}
                  >
                    <Text style={styles.optionTitle}>{repositoryName(repository)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Text style={styles.hint}>
              Verity clones this repository. Configure Dev Servers and integrations on the project
              page.
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
          </>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
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
