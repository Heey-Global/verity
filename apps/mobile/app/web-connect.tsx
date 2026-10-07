import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  type PressableStateCallbackType,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
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
  const [focused, setFocused] = useState<string | null>(null);
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
  const fieldStyle = (name: string) => [
    styles.input,
    focused === name ? styles.inputFocused : null,
    Platform.OS === 'web' ? { outlineWidth: 0 } : null,
  ];
  return (
    <View style={styles.page}>
      <Stack.Screen options={{ headerShown: false }} />
      <PageBackdrop />
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
            <Text style={styles.wordmark}>VERITY</Text>
          </Pressable>
          <View style={styles.card}>
            <CardAccent />
            <Text style={styles.eyebrow}>
              {stage === 'code' ? 'Browser access' : 'Master password'}
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              {stage === 'code'
                ? 'Connect this browser'
                : initialize
                  ? 'Create your password'
                  : 'Enter your password'}
            </Text>
            <Text style={styles.copy}>
              {stage === 'code'
                ? 'Paste a Verity pairing link to sign in this browser.'
                : 'Your password stays on this Core. This browser receives a private session cookie.'}
            </Text>
            {stage === 'code' && (
              <View style={styles.steps}>
                <Text style={styles.stepsTitle}>Where to get the link</Text>
                <Text style={styles.step}>
                  <Text style={styles.stepNumber}>1 </Text>
                  In the Verity app, open Settings → Devices → Pair another device, then tap Copy
                  pairing link.
                </Text>
                <Text style={styles.step}>
                  <Text style={styles.stepNumber}>2 </Text>
                  Setting up a new Core? Use the verity:// link the installer printed.
                </Text>
              </View>
            )}
            <View style={styles.form}>
              {error ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              ) : null}
              {stage === 'code' ? (
                <>
                  <Text style={styles.label}>Pairing link</Text>
                  <TextInput
                    accessibilityLabel="Pairing link"
                    placeholder="verity://pair?payload=…"
                    placeholderTextColor="#77799e"
                    value={code}
                    onChangeText={setCode}
                    onFocus={() => setFocused('code')}
                    onBlur={() => setFocused(null)}
                    onSubmitEditing={() => void submit()}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={fieldStyle('code')}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.label}>Master password</Text>
                  <TextInput
                    accessibilityLabel="Master password"
                    placeholder="Master password"
                    placeholderTextColor="#77799e"
                    value={password}
                    onChangeText={setPassword}
                    onFocus={() => setFocused('password')}
                    onBlur={() => setFocused(null)}
                    onSubmitEditing={() => {
                      if (!initialize) void submit();
                    }}
                    autoFocus
                    secureTextEntry
                    autoCapitalize="none"
                    style={fieldStyle('password')}
                  />
                  {initialize && (
                    <TextInput
                      accessibilityLabel="Confirm master password"
                      placeholder="Confirm master password"
                      placeholderTextColor="#77799e"
                      value={confirmation}
                      onChangeText={setConfirmation}
                      onFocus={() => setFocused('confirmation')}
                      onBlur={() => setFocused(null)}
                      onSubmitEditing={() => void submit()}
                      secureTextEntry
                      style={[fieldStyle('confirmation'), styles.secondInput]}
                    />
                  )}
                </>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={busy || (stage === 'code' ? !code.trim() : !password)}
                onPress={() => void submit()}
                style={({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
                  styles.button,
                  hovered ? styles.buttonHovered : null,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color="#00111f" />
                ) : (
                  <Text style={styles.buttonText}>
                    {stage === 'code'
                      ? 'Connect browser'
                      : initialize
                        ? 'Create password and sign in'
                        : 'Sign in'}
                  </Text>
                )}
              </Pressable>
              {stage === 'password' && (
                <Pressable accessibilityRole="button" onPress={() => setStage('code')}>
                  <Text style={styles.switchLink}>Use another pairing link</Text>
                </Pressable>
              )}
            </View>
          </View>
          <Text style={styles.foot}>
            Verity is your self-hosted workspace for coding agents.{' '}
            <Text
              accessibilityRole="link"
              style={styles.footLink}
              onPress={() => void Linking.openURL(VERITY_WEBSITE)}
            >
              Learn more at verity.build ↗
            </Text>
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

/** Same glows as the preview code page; drawn as SVG so web and native match. */
function PageBackdrop() {
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="glowTop" cx="12%" cy="4%" r="34%" fx="12%" fy="4%">
          <Stop offset="0" stopColor="#152855" stopOpacity="1" />
          <Stop offset="1" stopColor="#152855" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="glowBottom" cx="92%" cy="90%" r="30%" fx="92%" fy="90%">
          <Stop offset="0" stopColor="#28133d" stopOpacity="1" />
          <Stop offset="1" stopColor="#28133d" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#glowTop)" />
      <Rect width="100%" height="100%" fill="url(#glowBottom)" />
    </Svg>
  );
}

function CardAccent() {
  return (
    <Svg width="100%" height={2} style={styles.accent} pointerEvents="none">
      <Defs>
        <LinearGradient id="cardAccent" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0.68" stopColor="#2ab0ff" />
          <Stop offset="1" stopColor="#ff35da" />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#cardAccent)" />
    </Svg>
  );
}

// Mirrors the preview code page (packages/preview-tunnel/src/preview-page.ts).
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#050611' },
  root: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 40,
  },
  main: { width: '100%', maxWidth: 480 },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 12,
    marginBottom: 32,
  },
  logo: { width: 36, height: 26 },
  wordmark: { color: '#b6bad5', fontSize: 13, fontWeight: '800', letterSpacing: 2.3 },
  card: {
    position: 'relative',
    overflow: 'hidden',
    padding: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2a2552',
    backgroundColor: '#101021',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.53)',
  },
  accent: { position: 'absolute', top: 0, left: 0, right: 0, height: 2, width: '100%' },
  eyebrow: {
    marginBottom: 20,
    color: '#2ab0ff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  title: {
    marginBottom: 14,
    color: '#eef0ff',
    fontSize: 38,
    lineHeight: 43,
    fontWeight: '700',
    letterSpacing: -1.3,
  },
  copy: { color: '#a8add0', fontSize: 15, lineHeight: 25 },
  steps: {
    marginTop: 24,
    gap: 8,
    padding: 16,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#2a2552',
    backgroundColor: '#15142b',
  },
  stepsTitle: { color: '#d5d8ef', fontSize: 13, fontWeight: '700' },
  step: { color: '#a8add0', fontSize: 14, lineHeight: 21 },
  stepNumber: { color: '#2ab0ff', fontWeight: '800' },
  form: { marginTop: 24 },
  label: { marginBottom: 10, color: '#d5d8ef', fontSize: 13, fontWeight: '700' },
  input: {
    minHeight: 54,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#49446e',
    borderRadius: 11,
    backgroundColor: '#1b1933',
    color: '#eef0ff',
    fontSize: 18,
  },
  inputFocused: { borderColor: '#2ab0ff', boxShadow: '0 0 0 3px rgba(42, 176, 255, 0.2)' },
  secondInput: { marginTop: 12 },
  button: {
    minHeight: 54,
    marginTop: 16,
    borderRadius: 11,
    backgroundColor: '#2ab0ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonHovered: { backgroundColor: '#70ccff' },
  buttonText: { color: '#00111f', fontSize: 15, fontWeight: '800' },
  switchLink: { marginTop: 18, color: '#9bdfff', fontSize: 13, textAlign: 'center' },
  error: {
    marginBottom: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#a84471',
    borderRadius: 9,
    backgroundColor: '#371a34',
    color: '#ffd8e9',
    fontSize: 14,
    lineHeight: 20,
  },
  foot: { marginTop: 20, color: '#8589af', fontSize: 12, lineHeight: 18 },
  footLink: { color: '#9bdfff', textDecorationLine: 'underline' },
});
