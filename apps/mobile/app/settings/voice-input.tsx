import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { SettingsScaffold } from '../../components/settings/SettingsChrome';
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
        <Text style={styles.text}>
          Local vocabulary correction is available for iOS voice input.
        </Text>
      </SettingsScaffold>
    );
  }
  return (
    <SettingsScaffold title="Voice input" detail state={{ error: undefined, saving }}>
      <View style={styles.content}>
        <Text style={styles.text}>
          Words and variants stay on this device and are not synced or sent to telemetry.
        </Text>
        <View style={styles.row}>
          <Text style={styles.text}>Correct finalized dictation</Text>
          <Switch
            accessibilityLabel="Correct finalized dictation"
            value={vocabulary.enabled}
            disabled={!loaded || saving}
            onValueChange={(enabled) => setVocabulary({ ...vocabulary, enabled })}
          />
        </View>
        <Text style={styles.text}>
          One term per line, up to 100 terms of one or two words. Add explicit variants after a
          vertical bar: GitHub | git hub
        </Text>
        <TextInput
          accessibilityLabel="Voice vocabulary"
          multiline
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          editable={loaded && !saving}
        />
        <Text style={styles.text}>
          Apple SpeechTranscriber currently ignores vocabulary hints. These terms only guide local
          corrections; recognition improvements are not guaranteed.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={!loaded || saving}
          onPress={() => void save()}
          style={styles.button}
        >
          <Text style={styles.text}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
        {message ? (
          <Text accessibilityRole="alert" style={styles.text}>
            {message}
          </Text>
        ) : null}
      </View>
    </SettingsScaffold>
  );
}
const styles = StyleSheet.create({
  content: { gap: 16 },
  text: { color: '#eee9f7', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    backgroundColor: '#1b1524',
    color: '#eee9f7',
    padding: 12,
    minHeight: 300,
    borderRadius: 8,
    textAlignVertical: 'top',
  },
  button: { padding: 14, backgroundColor: '#563477', borderRadius: 8, alignItems: 'center' },
});
