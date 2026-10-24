import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsScaffold } from '../../components/settings/SettingsChrome';
import { Button, Card, Text, TextField, ToggleRow } from '../../components/ui';
import {
  defaultVoiceVocabulary,
  loadVoiceVocabulary,
  saveVoiceVocabulary,
  type VoiceVocabulary,
} from '../../lib/voiceVocabulary';

export default function VoiceInputSettings() {
  const [vocabulary, setVocabulary] = useState<VoiceVocabulary>(defaultVoiceVocabulary);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let mounted = true;
    void loadVoiceVocabulary()
      .then((value) => {
        if (!mounted) return;
        setVocabulary(value);
        setDraft(value.terms.map(({ term, aliases }) => [term, ...aliases].join(' | ')).join('\n'));
        setLoaded(true);
      })
      .catch(() => {
        if (mounted) setMessage('Local settings could not be loaded. Reopen this screen to retry.');
      });
    return () => {
      mounted = false;
    };
  }, []);
  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const terms = draft
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [term = '', ...aliases] = line.split('|').map((part) => part.trim());
          return { term, aliases };
        });
      await saveVoiceVocabulary({ enabled: vocabulary.enabled, terms });
      setMessage('Saved on this device.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save local settings.');
    } finally {
      setSaving(false);
    }
  };
  if (Platform.OS !== 'ios') {
    return (
      <SettingsScaffold title="Voice input" detail state={{ error: undefined, saving: false }}>
        <Text tone="muted">Local vocabulary correction is available for iOS voice input.</Text>
      </SettingsScaffold>
    );
  }
  return (
    <SettingsScaffold title="Voice input" detail state={{ error: undefined, saving }}>
      <Text tone="muted">
        Words and variants stay on this device and are not synced or sent to telemetry.
      </Text>
      <Card flush>
        <ToggleRow
          title="Correct finalized dictation"
          value={vocabulary.enabled}
          disabled={!loaded || saving}
          onValueChange={(enabled) => setVocabulary({ ...vocabulary, enabled })}
        />
      </Card>
      <View style={styles.section}>
        <TextField
          label="Vocabulary"
          accessibilityLabel="Voice vocabulary"
          value={draft}
          onChangeText={setDraft}
          multiline
          literal
          disabled={!loaded || saving}
        />
        <Text variant="footnote">
          One term per line, up to 100 terms of one or two words. Add explicit variants after a
          vertical bar: GitHub | git hub
        </Text>
        <Text variant="footnote">
          Apple SpeechTranscriber currently ignores vocabulary hints. These terms only guide local
          corrections; recognition improvements are not guaranteed.
        </Text>
      </View>
      <Button
        label="Save"
        loading={saving}
        disabled={!loaded}
        onPress={() => void save()}
        fullWidth
      />
      {message ? (
        <Text variant="subtitle" accessibilityRole="alert">
          {message}
        </Text>
      ) : null}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
}));
