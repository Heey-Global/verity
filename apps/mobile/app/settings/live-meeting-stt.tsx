import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsScaffold } from '../../components/settings/SettingsChrome';
import {
  Button,
  Group,
  HintBox,
  Row,
  SectionHeader,
  StatusDot,
  Text,
  TextField,
} from '../../components/ui';
import { liveMeetingSTT, type STTEngine, type STTEngineId } from '../../lib/liveMeetingSTT';
import {
  applySTTEvent,
  emptySTTTranscript,
  transcriptText,
  type STTTranscriptState,
} from '../../lib/liveMeetingSTTTranscript';

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
        <Text tone="muted">This test needs a new iOS build with the live STT module.</Text>
      </SettingsScaffold>
    );
  }

  const locked = busy || listening;
  return (
    <SettingsScaffold title="Live STT test" detail>
      <Text tone="muted">
        Choose one engine and speak. This test does not save audio or transcript.
      </Text>
      <View style={styles.section}>
        <SectionHeader title="Engine" />
        {loadingEngines ? <StatusDot intent="transient" label="Loading engines" /> : null}
        {!loadingEngines && engines.length === 0 ? (
          <Text variant="subtitle">This prototype requires iOS 27 or later.</Text>
        ) : null}
        {engines.length > 0 ? (
          <Group>
            {engines.map((engine) => (
              <Row
                key={engine.id}
                title={engine.name}
                subtitle={engine.available ? undefined : 'Unavailable on this device'}
                selected={selected === engine.id}
                disabled={!engine.available || locked}
                onPress={() => setSelected(engine.id)}
              />
            ))}
          </Group>
        ) : null}
      </View>
      <TextField
        label="Language"
        accessibilityLabel="Recognition locale"
        value={locale}
        onChangeText={setLocale}
        literal
        disabled={locked}
      />
      <View style={styles.section}>
        <TextField
          label="Names and terms (comma separated)"
          accessibilityLabel="Names and project terms"
          value={terms}
          onChangeText={setTerms}
          disabled={locked}
        />
        <Text variant="footnote">
          Term hints apply to Apple Dictation and Nemotron. Other engines receive no vocabulary
          hints.
        </Text>
      </View>
      <Button
        label={listening ? 'Stop test' : 'Start test'}
        variant={listening ? 'secondary' : 'primary'}
        loading={busy}
        disabled={!listening && !canStart}
        onPress={() => void (listening ? stop() : start())}
        fullWidth
      />
      <Text variant="subtitle">Status: {status}</Text>
      {error ? <HintBox title="Speech recognition failed" message={error} /> : null}
      <View style={styles.section}>
        <SectionHeader title="Transcript" />
        <View style={styles.transcript}>
          <Text tone={text ? 'default' : 'faint'}>{text || 'Recognized speech appears here.'}</Text>
        </View>
      </View>
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
  transcript: {
    minHeight: 180,
    padding: theme.spacing.md + theme.spacing.xxs,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
