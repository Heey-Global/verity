import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { authenticateBrowser, pairBrowser } from '../lib/browserSession';
import { createVerityClient } from '../lib/client';

export default function WebConnectScreen() {
  const { unlock } = useLocalSearchParams<{ unlock?: string }>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [stage, setStage] = useState<'code' | 'password'>(unlock === '1' ? 'password' : 'code');
  const [initialize, setInitialize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (): Promise<void> => {
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
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.brand}>
        <Image
          source={require('../assets/brand/verity-v-mark.png')}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Verity logo"
        />
        <Text style={styles.wordmark}>Verity</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>
          {stage === 'code'
            ? 'Connect this browser'
            : initialize
              ? 'Create master password'
              : 'Enter master password'}
        </Text>
        <Text style={styles.description}>
          {stage === 'code'
            ? 'Paste the complete pairing link from your installer or an invitation link or code from Devices.'
            : 'Your password stays on this Core. This browser receives a private session cookie.'}
        </Text>
        {stage === 'code' ? (
          <TextInput
            accessibilityLabel="Pairing code"
            placeholder="verity://pair?payload=…"
            placeholderTextColor="#9ca3af"
            value={code}
            onChangeText={setCode}
            multiline
            autoCapitalize="none"
            style={styles.input}
          />
        ) : (
          <>
            <TextInput
              accessibilityLabel="Master password"
              placeholder="Master password"
              placeholderTextColor="#9ca3af"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              style={styles.input}
            />
            {initialize && (
              <TextInput
                accessibilityLabel="Confirm master password"
                placeholder="Confirm master password"
                placeholderTextColor="#9ca3af"
                value={confirmation}
                onChangeText={setConfirmation}
                secureTextEntry
                style={styles.input}
              />
            )}
          </>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy || (stage === 'code' ? !code.trim() : !password)}
          onPress={() => void submit()}
          style={styles.button}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              {stage === 'code'
                ? 'Continue'
                : initialize
                  ? 'Create password and sign in'
                  : 'Sign in'}
            </Text>
          )}
        </Pressable>
        {stage === 'password' && (
          <Pressable onPress={() => setStage('code')}>
            <Text style={styles.description}>Use another pairing code</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: {
    flexGrow: 1,
    backgroundColor: '#090a14',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  brand: { alignItems: 'center', gap: 12, marginBottom: 28 },
  logo: { width: 64, height: 64 },
  wordmark: { color: '#f4f3ff', fontSize: 28, fontWeight: '700' },
  card: {
    width: '100%',
    maxWidth: 440,
    gap: 18,
    padding: 28,
    borderRadius: 20,
    backgroundColor: '#121322',
    borderWidth: 1,
    borderColor: '#29283e',
  },
  title: { color: '#fff', fontSize: 26, fontWeight: '600' },
  description: { color: '#b0b6c3', fontSize: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#465064',
    borderRadius: 8,
    padding: 14,
    color: '#fff',
    fontSize: 16,
  },
  error: { color: '#ff8e9e' },
  button: { backgroundColor: '#7355e8', padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
