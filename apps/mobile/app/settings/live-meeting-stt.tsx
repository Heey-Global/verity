import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SettingsScaffold } from '../../components/settings/SettingsChrome';
import { liveMeetingSTT, type STTEngine, type STTEngineId } from '../../lib/liveMeetingSTT';
import {
  applySTTEvent,
  emptySTTTranscript,
  transcriptText,
  type STTTranscriptState,
} from '../../lib/liveMeetingSTTTranscript';

const TEXT = '#eee9f7';
const MUTED = '#aaa2ba';
const ACCENT = '#bd8bff';

export default function LiveMeetingSTTScreen() {
  const [engines, setEngines] = useState<STTEngine[]>([]);
  const [loadingEngines, setLoadingEngines] = useState(true);
  const [selected, setSelected] = useState<STTEngineId>('fluid-nemotron');
  const [locale, setLocale] = useState('de-DE');
  const [terms, setTerms] = useState('Verity');
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<STTTranscriptState>(emptySTTTranscript);
  const text = useMemo(() => transcriptText(transcript), [transcript]);
  const canStart = engines.some((engine) => engine.id === selected && engine.available);

  useEffect(() => {
    const native = liveMeetingSTT;
    if (!native) return;
    let mounted = true;
    void native.engines().then(
      (available) => {
        if (mounted) {
          setEngines(available);
          setLoadingEngines(false);
        }
      },
      (reason) => {
        if (mounted) {
          setError(String(reason));
          setLoadingEngines(false);
        }
      },
    );
    const subscription = native.addListener('onSTTEvent', (event) => {
      if (!mounted) return;
      if (event.kind === 'status') {
        setStatus(event.state);
        setListening(event.state === 'listening');
        if (event.message) setError(event.message);
      } else setTranscript((current) => applySTTEvent(current, event));
    });
    return () => {
      mounted = false;
      subscription.remove();
      void native.stop();
    };
  }, []);

  const start = async () => {
    if (!liveMeetingSTT || !canStart || busy || listening) return;
    setError(null);
    setTranscript(emptySTTTranscript);
    setBusy(true);
    try {
      const vocabulary = terms
        .split(',')
        .map((word) => word.trim())
        .filter(Boolean);
      await liveMeetingSTT.start(selected, locale.trim(), vocabulary, 0);
    } catch (reason) {
      setError(String(reason));
      setStatus('Failed to start');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!liveMeetingSTT || busy) return;
    setBusy(true);
    try {
      await liveMeetingSTT.stop();
      setListening(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!liveMeetingSTT) {
    return (
      <SettingsScaffold title="Live STT test" detail>
        <Text style={styles.message}>
          This test needs a new iOS build with the live STT module.
        </Text>
      </SettingsScaffold>
    );
  }

  return (
    <SettingsScaffold title="Live STT test" detail>
      <View style={styles.content}>
        <Text style={styles.title}>Live STT test</Text>
        <Text style={styles.caption}>
          Choose one engine and speak. This test does not save audio or transcript.
        </Text>
        <Text style={styles.label}>Engine</Text>
        {loadingEngines ? <ActivityIndicator color={ACCENT} /> : null}
        {!loadingEngines && engines.length === 0 ? (
          <Text style={styles.caption}>This prototype requires iOS 27 or later.</Text>
        ) : null}
        {engines.map((engine) => (
          <Pressable
            key={engine.id}
            accessibilityRole="radio"
            accessibilityState={{
              selected: selected === engine.id,
              disabled: !engine.available || busy || listening,
            }}
            disabled={!engine.available || busy || listening}
            onPress={() => setSelected(engine.id)}
            style={[styles.engine, selected === engine.id && styles.selected]}
          >
            <Text style={styles.engineName}>{engine.name}</Text>
            <Text style={styles.caption}>
              {engine.available ? 'Select to test' : 'Unavailable on this device'}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.label}>Language</Text>
        <TextInput
          style={styles.input}
          value={locale}
          onChangeText={setLocale}
          autoCapitalize="none"
          editable={!busy && !listening}
          accessibilityLabel="Recognition locale"
        />
        <Text style={styles.label}>Names and terms (comma separated)</Text>
        <TextInput
          style={styles.input}
          value={terms}
          onChangeText={setTerms}
          editable={!busy && !listening}
          accessibilityLabel="Names and project terms"
        />
        <Text style={styles.caption}>
          Term hints apply to Apple Dictation and Nemotron. Other engines receive no vocabulary
          hints.
        </Text>
        <Pressable
          style={[styles.button, (busy || (!listening && !canStart)) && styles.disabled]}
          disabled={busy || (!listening && !canStart)}
          onPress={() => void (listening ? stop() : start())}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color="#160d25" />
          ) : (
            <Text style={styles.buttonText}>{listening ? 'Stop test' : 'Start test'}</Text>
          )}
        </Pressable>
        <Text style={styles.status}>Status: {status}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.label}>Transcript</Text>
        <View style={styles.transcript}>
          <Text style={styles.transcriptText}>{text || 'Recognized speech appears here.'}</Text>
        </View>
      </View>
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create({
  content: { gap: 10 },
  title: { color: TEXT, fontSize: 24, fontWeight: '700' },
  label: { color: TEXT, fontSize: 15, fontWeight: '600', marginTop: 10 },
  caption: { color: MUTED, fontSize: 13 },
  message: { color: TEXT },
  engine: { padding: 12, borderWidth: 1, borderColor: '#393046', borderRadius: 10 },
  selected: { borderColor: ACCENT, backgroundColor: '#24152f' },
  engineName: { color: TEXT, fontSize: 15, fontWeight: '600' },
  input: { backgroundColor: '#1b1524', color: TEXT, borderRadius: 8, padding: 12 },
  button: {
    marginTop: 10,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: ACCENT,
  },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#160d25', fontWeight: '700' },
  status: { color: MUTED, marginTop: 4 },
  error: { color: '#ff8f9e' },
  transcript: { minHeight: 180, padding: 14, borderRadius: 10, backgroundColor: '#1b1524' },
  transcriptText: { color: TEXT, fontSize: 17, lineHeight: 25 },
});
