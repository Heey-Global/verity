import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Linking, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button, HintBox, Text, TextField } from '../components/ui';
import { authenticateBrowser, pairBrowser } from '../lib/browserSession';
import { createVerityClient } from '../lib/client';

const VERITY_WEBSITE = 'https://verity.build';

export default function WebConnectScreen() {
  const { unlock } = useLocalSearchParams<{ unlock?: string }>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [stage, setStage] = useState<'code' | 'password'>(unlock === '1' ? 'password' : 'code');
  const [initialize, setInitialize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Return in any field and the button share this guard, so a pairing code is never
  // redeemed twice or sent empty.
  const canSubmit = !busy && (stage === 'code' ? code.trim() !== '' : password !== '');
  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      if (stage === 'code') {
        const next = await pairBrowser(code);
        if (next === 'authenticated') {
          router.replace('/');
        } else {
          const status = await createVerityClient()!.getSecretStatus();
          setInitialize(status === 'uninitialized');
          setStage('password');
        }
      } else {
        if (initialize && password !== confirmation) throw new Error('Passwords do not match.');
        await authenticateBrowser(password, initialize);
        setPassword('');
        setConfirmation('');
        router.replace('/');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.page}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
        <View style={styles.main}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Visit Verity website"
            onPress={() => void Linking.openURL(VERITY_WEBSITE)}
            style={styles.brand}
          >
            <Image
              source={require('../assets/brand/verity-v-mark.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text variant="eyebrow">Verity</Text>
          </Pressable>
          <View style={styles.card}>
            <Text variant="label">{stage === 'code' ? 'Browser access' : 'Master password'}</Text>
            <Text variant="display" accessibilityRole="header">
              {stage === 'code'
                ? 'Connect this browser'
                : initialize
                  ? 'Create your password'
                  : 'Enter your password'}
            </Text>
            <Text tone="muted">
              {stage === 'code'
                ? 'Paste a Verity pairing link to sign in this browser.'
                : 'Your password stays on this Core. This browser receives a private session cookie.'}
            </Text>
            {stage === 'code' ? (
              <View style={styles.steps}>
                <Text variant="row">Where to get the link</Text>
                <Text variant="bodySmall" tone="muted">
                  1. In the Verity app, open Settings → Devices & Web Browsers → Web Browser, then
                  tap Create pairing link and Copy.
                </Text>
                <Text variant="bodySmall" tone="muted">
                  2. Setting up a new Core? Use the verity:// link the installer printed.
                </Text>
              </View>
            ) : null}
            <View style={styles.form}>
              {error ? <HintBox title="Could not connect" message={error} /> : null}
              {stage === 'code' ? (
                <TextField
                  label="Pairing link"
                  placeholder="verity://pair?payload=…"
                  value={code}
                  onChangeText={setCode}
                  onSubmitEditing={() => void submit()}
                  autoFocus
                  literal
                />
              ) : (
                <>
                  <TextField
                    label="Master password"
                    value={password}
                    onChangeText={setPassword}
                    onSubmitEditing={() => {
                      if (!initialize) void submit();
                    }}
                    autoFocus
                    secret
                  />
                  {initialize ? (
                    <TextField
                      label="Confirm master password"
                      value={confirmation}
                      onChangeText={setConfirmation}
                      onSubmitEditing={() => void submit()}
                      secret
                    />
                  ) : null}
                </>
              )}
              <Button
                label={
                  stage === 'code'
                    ? 'Connect browser'
                    : initialize
                      ? 'Create password and sign in'
                      : 'Sign in'
                }
                loading={busy}
                disabled={!canSubmit && !busy}
                onPress={() => void submit()}
                fullWidth
              />
              {stage === 'password' ? (
                <Button
                  label="Use another pairing link"
                  variant="text"
                  onPress={() => setStage('code')}
                />
              ) : null}
            </View>
          </View>
          <Text variant="footnote" style={styles.foot}>
            Verity is your self-hosted workspace for coding agents.{' '}
            <Text
              variant="footnote"
              tone="action"
              accessibilityRole="link"
              onPress={() => void Linking.openURL(VERITY_WEBSITE)}
            >
              Learn more at verity.build
            </Text>
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.background },
  root: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xxl,
  },
  main: { width: '100%', maxWidth: 480, gap: theme.spacing.lg },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  logo: { width: 36, height: 26 },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    ...theme.elevation.floating,
  },
  steps: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  form: { gap: theme.spacing.md, marginTop: theme.spacing.sm },
  foot: { textAlign: 'center' },
}));
