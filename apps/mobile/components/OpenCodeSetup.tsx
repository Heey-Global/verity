import { VerityApiError, type VerityClient } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export function OpenCodeSetup({
  client,
  onConfiguredChange,
  onActiveChange,
  onSealed,
}: {
  client: VerityClient;
  onConfiguredChange: (configured: boolean) => void;
  onActiveChange: (active: boolean) => void;
  onSealed: () => void;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [savedBaseUrl, setSavedBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [savedModels, setSavedModels] = useState('');
  const [error, setError] = useState<string | null>(null);
  const baseUrlChanged = baseUrl.trim() !== savedBaseUrl;
  const ready =
    baseUrl.trim().length > 0 &&
    models.trim().length > 0 &&
    (apiKey.trim().length > 0 || (keyConfigured && !baseUrlChanged));

  useEffect(() => {
    onActiveChange(expanded);
    return () => onActiveChange(false);
  }, [expanded, onActiveChange]);

  useEffect(() => {
    let cancelled = false;
    void client
      .getVeritySettings()
      .then((settings) => {
        if (cancelled) return;
        const nextBaseUrl = settings?.opencodeBaseUrl ?? '';
        const nextModels = settings?.opencodeModels ?? '';
        const nextKeyConfigured = settings?.opencodeApiKeyConfigured ?? false;
        const nextConfigured =
          nextKeyConfigured && nextBaseUrl.trim().length > 0 && nextModels.trim().length > 0;
        setBaseUrl(nextBaseUrl);
        setSavedBaseUrl(nextBaseUrl.trim());
        setModels(nextModels);
        setSavedModels(nextModels);
        setKeyConfigured(nextKeyConfigured);
        setConfigured(nextConfigured);
        onConfiguredChange(nextConfigured);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load OpenCode.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, onConfiguredChange]);

  const save = () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    void client
      .updateVeritySettings({
        opencodeBaseUrl: baseUrl.trim(),
        opencodeModels: models
          .split('\n')
          .map((model) => model.trim())
          .filter(Boolean)
          .join('\n'),
        ...(apiKey.trim().length > 0 ? { opencodeApiKey: apiKey.trim() } : {}),
      })
      .then((settings) => {
        const nextBaseUrl = settings?.opencodeBaseUrl ?? baseUrl.trim();
        const nextModels = settings?.opencodeModels ?? models.trim();
        const nextKeyConfigured = settings?.opencodeApiKeyConfigured ?? apiKey.trim().length > 0;
        const nextConfigured =
          nextKeyConfigured && nextBaseUrl.trim().length > 0 && nextModels.trim().length > 0;
        setApiKey('');
        setBaseUrl(nextBaseUrl);
        setSavedBaseUrl(nextBaseUrl.trim());
        setModels(nextModels);
        setSavedModels(nextModels);
        setKeyConfigured(nextKeyConfigured);
        setConfigured(nextConfigured);
        setExpanded(false);
        onConfiguredChange(nextConfigured);
      })
      .catch((caught) => {
        if (
          caught instanceof VerityApiError &&
          caught.status === 503 &&
          caught.message.toLowerCase().includes('sealed')
        ) {
          onSealed();
          return;
        }
        setError(caught instanceof VerityApiError ? caught.message : 'Could not save OpenCode.');
      })
      .finally(() => setSaving(false));
  };

  const cancel = () => {
    setBaseUrl(savedBaseUrl);
    setModels(savedModels);
    setApiKey('');
    setError(null);
    setExpanded(false);
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleGroup}>
          <Text style={styles.title}>OpenCode</Text>
          <Text style={styles.description}>
            Use models from an OpenAI-compatible API instead of a subscription login.
          </Text>
        </View>
        <View style={[styles.pill, configured ? styles.pillReady : null]}>
          <Text style={[styles.pillLabel, configured ? styles.pillLabelReady : null]}>
            {configured ? 'Configured' : 'Not set'}
          </Text>
        </View>
      </View>

      {loading ? <ActivityIndicator size="small" color={theme.colors.setup.text} /> : null}
      {!loading && !expanded ? (
        <Pressable
          style={configured ? styles.secondaryButton : styles.primaryButton}
          onPress={() => setExpanded(true)}
          accessibilityRole="button"
          accessibilityLabel={configured ? 'Edit OpenCode' : 'Configure OpenCode'}
        >
          <Text style={configured ? styles.secondaryButtonLabel : styles.primaryButtonLabel}>
            {configured ? 'Edit OpenCode' : 'Configure OpenCode'}
          </Text>
        </Pressable>
      ) : null}

      {!loading && expanded ? (
        <View style={styles.setupBlock}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeLabel}>1</Text>
          </View>
          <View style={styles.fields}>
            <Text style={styles.stepTitle}>Connect your model provider</Text>
            <Text style={styles.stepDescription}>
              Enter its API endpoint, a private API key, and the exact model IDs you want Verity to
              offer.
            </Text>
            <TextInput
              style={styles.input}
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://api.example.com/v1"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="OpenCode API base URL"
            />
            <TextInput
              style={styles.input}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={keyConfigured ? 'API key already saved — leave unchanged' : 'API key'}
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel="OpenCode API key"
            />
            <TextInput
              style={[styles.input, styles.modelsInput]}
              value={models}
              onChangeText={setModels}
              placeholder={'provider/model-name\nprovider/another-model'}
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              accessibilityLabel="OpenCode models"
            />
            <Pressable
              style={[styles.primaryButton, !ready ? styles.disabled : null]}
              onPress={save}
              disabled={!ready || saving}
              accessibilityRole="button"
              accessibilityLabel="Save OpenCode"
            >
              {saving ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
              <Text style={styles.primaryButtonLabel}>{saving ? 'Saving…' : 'Save OpenCode'}</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={cancel}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Cancel OpenCode setup"
            >
              <Text style={styles.secondaryButtonLabel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  titleGroup: { flex: 1, gap: 6 },
  title: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  description: { color: theme.colors.setup.textMuted, fontSize: theme.text.sm, lineHeight: 20 },
  pill: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  pillReady: { borderColor: theme.colors.tone.done },
  pillLabel: { color: theme.colors.setup.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  pillLabelReady: { color: theme.colors.tone.done },
  setupBlock: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  stepBadge: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: theme.colors.setup.text,
  },
  stepBadgeLabel: { color: theme.colors.background, fontSize: theme.text.sm, fontWeight: '600' },
  fields: { flex: 1, gap: theme.spacing.sm },
  stepTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  stepDescription: { color: theme.colors.setup.textMuted, fontSize: theme.text.xs, lineHeight: 18 },
  input: {
    minHeight: 44,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
    color: theme.colors.text,
    backgroundColor: theme.colors.background,
    fontSize: theme.text.sm,
  },
  modelsInput: { minHeight: 88, textAlignVertical: 'top' },
  primaryButton: {
    minHeight: 44,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.setup.text,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonLabel: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  disabled: { opacity: 0.45 },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '700' },
}));
