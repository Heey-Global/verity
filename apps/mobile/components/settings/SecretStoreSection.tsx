// The at-rest secret store's master-password lifecycle: set it once, unlock it
// after a restart, or a compact "Unlocked" pill when the key is already loaded.
// A deployment that manages no cipher (`unmanaged`) renders nothing at all.
//
// Passwords live only in this component's state. They are never logged, never
// hoisted into the settings draft, and never sent anywhere but the two calls
// below — which return a fresh auth token, since unlocking re-scopes the session.
import {
  VerityApiError,
  secretUiMode,
  validateMasterPassword,
  type VerityClient,
} from '@verity/mobile';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { StatusPill } from '../StatusPill';
import { setAuthToken } from '../../lib/authToken';
import { getVerityBaseUrl } from '../../lib/client';
import {
  refreshSecretStatus,
  setVeritySettingsError,
  useVeritySettings,
} from '../../lib/settingsStore';
import { settingsStyles as styles } from './settingsStyles';

export function SecretStoreSection({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const { secretStatus } = useVeritySettings();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Lets the master-password field's return key jump to Confirm during onboarding.
  const confirmRef = useRef<TextInput>(null);

  if (secretStatus === undefined || secretStatus === 'unmanaged') return null;

  const mode = secretUiMode(secretStatus);
  if (mode === 'hidden') return null;

  const reset = () => {
    setPassword('');
    setConfirm('');
    setFieldError(undefined);
  };

  const submitInit = () => {
    if (busy) return;
    const validation = validateMasterPassword(password, confirm);
    if (validation) {
      setFieldError(validation);
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    void client
      .initSecretPassword(password)
      .then(async (res) => {
        if (res?.token) await setAuthToken(getVerityBaseUrl(), res.token, res.tokenId);
        reset();
        await refreshSecretStatus(client);
      })
      .catch(async (caught: unknown) => {
        // 409 = the store already has a password (set from another client, or a
        // concurrent restart). The `set` form is stale — refetch so the section
        // advances to `unlock`/`ready` instead of staying stuck.
        if (caught instanceof VerityApiError && caught.status === 409) {
          reset();
          await refreshSecretStatus(client);
          return;
        }
        setVeritySettingsError(
          caught instanceof VerityApiError ? caught.message : 'Could not set the password',
        );
      })
      .finally(() => setBusy(false));
  };

  const submitUnlock = () => {
    if (busy) return;
    setFieldError(undefined);
    setBusy(true);
    void client
      .unlockSecret(password)
      .then(async (res) => {
        if (res?.token) await setAuthToken(getVerityBaseUrl(), res.token, res.tokenId);
        reset();
        await refreshSecretStatus(client);
      })
      .catch((caught: unknown) => {
        if (caught instanceof VerityApiError && caught.status === 401) {
          setFieldError('Incorrect password.');
          return;
        }
        setVeritySettingsError(
          caught instanceof VerityApiError ? caught.message : 'Could not unlock',
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.panel}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.disclosureTitle}>Secret store</Text>
        {mode === 'ready' ? <StatusPill quiet intent="ready" label="Unlocked" /> : null}
      </View>
      <Text style={styles.sectionSubtitle}>
        {mode === 'set'
          ? 'Set a master password to protect secrets at rest.'
          : mode === 'unlock'
            ? 'Enter the master password to unlock stored secrets after a restart.'
            : 'Secrets are unlocked and available to project containers.'}
      </Text>

      {mode === 'set' || mode === 'unlock' ? (
        <View style={styles.secretStoreForm}>
          <View style={styles.pathContent}>
            <Text style={styles.pathLabel}>Master password</Text>
            <TextInput
              style={styles.pathInput}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={theme.colors.textFaint}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType={mode === 'set' ? 'next' : 'done'}
              // Hardware/software Return submits (unlock) or advances to Confirm
              // (set), so the flow doesn't require reaching for the button.
              onSubmitEditing={() => {
                if (mode === 'set') {
                  confirmRef.current?.focus();
                } else if (password.length > 0) {
                  submitUnlock();
                }
              }}
            />
          </View>
          {mode === 'set' ? (
            <View style={styles.pathContent}>
              <Text style={styles.pathLabel}>Confirm password</Text>
              <TextInput
                ref={confirmRef}
                style={styles.pathInput}
                value={confirm}
                onChangeText={setConfirm}
                placeholder="••••••••"
                placeholderTextColor={theme.colors.textFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                onSubmitEditing={submitInit}
              />
            </View>
          ) : null}
          {fieldError !== undefined ? <Text style={styles.fieldError}>{fieldError}</Text> : null}
          <View style={styles.actionRow}>
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                busy || password.length === 0 ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={mode === 'set' ? submitInit : submitUnlock}
              disabled={busy || password.length === 0}
              accessibilityRole="button"
              accessibilityLabel={mode === 'set' ? 'Set master password' : 'Unlock secret store'}
            >
              {busy ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
              <Text style={styles.primaryButtonLabel}>
                {mode === 'set' ? 'Set master password' : 'Unlock'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
