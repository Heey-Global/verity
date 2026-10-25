import { selectedOpenCodeModels, VerityApiError, type VerityClient } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button, StatusTag, TextField } from './ui';

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
  const [error, setError] = useState<string | null>(null);
  const baseUrlChanged = baseUrl.trim() !== savedBaseUrl;
  const ready =
    baseUrl.trim().length > 0 && (apiKey.trim().length > 0 || (keyConfigured && !baseUrlChanged));

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
        const nextKeyConfigured = settings?.opencodeApiKeyConfigured ?? false;
        const nextConfigured =
          nextKeyConfigured &&
          nextBaseUrl.trim().length > 0 &&
          selectedOpenCodeModels(settings).length > 0;
        setBaseUrl(nextBaseUrl);
        setSavedBaseUrl(nextBaseUrl.trim());
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
        ...(apiKey.trim().length > 0 ? { opencodeApiKey: apiKey.trim() } : {}),
      })
      .then((settings) => {
        const nextBaseUrl = settings?.opencodeBaseUrl ?? baseUrl.trim();
        const nextKeyConfigured = settings?.opencodeApiKeyConfigured ?? apiKey.trim().length > 0;
        const nextConfigured =
          nextKeyConfigured &&
          nextBaseUrl.trim().length > 0 &&
          selectedOpenCodeModels(settings).length > 0;
        setApiKey('');
        setBaseUrl(nextBaseUrl);
        setSavedBaseUrl(nextBaseUrl.trim());
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
        <StatusTag
          intent={configured ? 'ready' : 'optional'}
          label={configured ? 'Configured' : 'Not set'}
        />
      </View>

      {loading ? <ActivityIndicator size="small" color={theme.colors.text} /> : null}
      {!loading && !expanded ? (
        <View style={styles.inline}>
          <Button
            label={configured ? 'Edit OpenCode' : 'Configure OpenCode'}
            variant={configured ? 'secondary' : 'primary'}
            size={configured ? 'compact' : 'large'}
            onPress={() => setExpanded(true)}
          />
        </View>
      ) : null}

      {!loading && expanded ? (
        <View style={styles.setupBlock}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeLabel}>1</Text>
          </View>
          <View style={styles.fields}>
            <Text style={styles.stepTitle}>Connect your model provider</Text>
            <Text style={styles.stepDescription}>
              Enter its API endpoint and a private API key. Verity automatically loads all models
              offered by the provider.
            </Text>
            <TextField
              label="API endpoint"
              accessibilityLabel="OpenCode API base URL"
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://api.example.com/v1"
              keyboardType="url"
            />
            <TextField
              label="API key"
              accessibilityLabel="OpenCode API key"
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={keyConfigured ? 'Already saved — leave unchanged' : 'Paste your API key'}
              secret
            />
            <Button
              label="Save OpenCode"
              loading={saving}
              disabled={!ready}
              onPress={save}
              fullWidth
            />
            <View style={styles.inline}>
              <Button
                label="Cancel"
                accessibilityLabel="Cancel OpenCode setup"
                variant="text"
                disabled={saving}
                onPress={cancel}
              />
            </View>
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
  // A button keeps the width of its label instead of spanning the column.
  inline: { flexDirection: 'row' },
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  titleGroup: { flex: 1, gap: 6 },
  title: { ...theme.typography.row, color: theme.colors.text },
  description: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  setupBlock: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  stepBadge: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: theme.colors.action,
  },
  stepBadgeLabel: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.onAction,
  },
  fields: { flex: 1, gap: theme.spacing.sm },
  stepTitle: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.text,
  },
  stepDescription: { ...theme.typography.footnote, color: theme.colors.textMuted },
  error: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.attention,
  },
}));
