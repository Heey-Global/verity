import { APP_HELP_TOPICS, DOCS_BASE_URL } from '@verity/events';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Modal, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { hasSeenFeatureHint, markFeatureHintSeen, type FeatureHintKey } from '../lib/featureHints';

/** An explanation gates an action; only Continue resumes it. */
export function useFeatureHint(onAsk?: (question: string) => void, scope?: string) {
  const [key, setKey] = useState<FeatureHintKey | null>(null);
  const pending = useRef<((proceed: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const checking = useRef(false);
  const finishing = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    setKey(null);
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current?.(false);
      pending.current = null;
    };
  }, [scope]);
  const confirm = useCallback(async (next: FeatureHintKey): Promise<boolean> => {
    if (checking.current || pending.current || !mounted.current) return false;
    const currentGeneration = generation.current;
    checking.current = true;
    const seen = await hasSeenFeatureHint(next);
    checking.current = false;
    if (!mounted.current || currentGeneration !== generation.current) return false;
    if (seen) return true;
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setKey(next);
    });
  }, []);
  const finish = (proceed: boolean, ask = false) => {
    if (!key || !pending.current || finishing.current) return;
    finishing.current = true;
    const topic = APP_HELP_TOPICS.find((topic) => topic.id === key);
    const resolve = pending.current;
    setKey(null);
    if (ask && topic?.hint) onAsk?.(topic.hint.question);
    void markFeatureHintSeen(key)
      .catch(() => undefined)
      .then(() => {
        finishing.current = false;
        if (pending.current === resolve) pending.current = null;
        resolve?.(mounted.current && proceed);
      });
  };
  const topic = key === null ? undefined : APP_HELP_TOPICS.find((topic) => topic.id === key);
  const sheet = topic?.hint ? (
    <Modal transparent animationType="fade" onRequestClose={() => finish(false)}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close hint"
          style={StyleSheet.absoluteFill}
          onPress={() => finish(false)}
        />
        <View
          style={styles.card}
          accessibilityViewIsModal
          onAccessibilityEscape={() => finish(false)}
        >
          <Text style={styles.title} accessibilityRole="header">
            {topic.title}
          </Text>
          <Text style={styles.text}>{topic.hint.text}</Text>
          {topic.docsPath ? (
            <Pressable
              accessibilityRole="link"
              onPress={() =>
                void Linking.openURL(`${DOCS_BASE_URL}${topic.docsPath}`).catch(() => undefined)
              }
            >
              <Text style={styles.link}>Learn more</Text>
            </Pressable>
          ) : null}
          {onAsk ? (
            <Pressable accessibilityRole="button" onPress={() => finish(false, true)}>
              <Text style={styles.link}>Ask in chat</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => finish(true)}>
            <Text style={styles.link}>Continue</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => finish(false)}>
            <Text style={styles.link}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  ) : null;
  return { confirm, sheet };
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  card: {
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    gap: theme.spacing.md,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '600' },
  text: { color: theme.colors.text, fontSize: theme.text.md },
  link: {
    color: theme.colors.primary,
    fontSize: theme.text.md,
    minHeight: 44,
    paddingVertical: theme.spacing.sm,
  },
}));
