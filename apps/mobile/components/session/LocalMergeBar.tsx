import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { UseBranches } from '../../hooks/useBranches';
import { SessionBar } from '../ui/SessionBar';

/** Save a local session's work through the agent and then into the project base.
 *  The server checks the commit and merge preconditions. */
export function LocalMergeBar({
  confirmHint,
  branch,
  base,
  busy,
  onSave,
}: {
  confirmHint: () => Promise<boolean>;
  branch: string;
  base: string;
  busy: boolean;
  onSave: UseBranches['saveToProject'];
}) {
  const { theme } = useUnistyles();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);
  // A new branch (or base) is a new attempt: drop the previous rejection so a stale
  // reason can't sit under a button that would now succeed.
  useEffect(() => {
    setError(undefined);
  }, [branch, base]);

  const save = (): void => {
    if (saving || busy) return;
    void (async () => {
      setSaving(true);
      setError(undefined);
      const result = await onSave();
      if (!mounted.current) return;
      setSaving(false);
      if (!result.ok) setError(result.message);
      // The server runs the agent turn and local merge after accepting the request.
    })();
  };

  return (
    <SessionBar>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          Changes from this session
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          Save them as a version in your project.
        </Text>
        {error !== undefined ? (
          <Text style={styles.error} numberOfLines={2}>
            {error}
          </Text>
        ) : null}
      </View>
      <Pressable
        style={({ pressed }) => [
          styles.button,
          styles.wideButton,
          { backgroundColor: theme.colors.success },
          saving || busy ? styles.buttonDisabled : null,
          pressed && !saving && !busy ? styles.buttonPressed : null,
        ]}
        onPress={() =>
          void confirmHint().then((proceed) => {
            if (proceed && mounted.current) save();
          })
        }
        disabled={saving || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: saving || busy, busy: saving }}
        accessibilityLabel="Save this session's changes as a version in your project"
      >
        {saving ? (
          <ActivityIndicator color={theme.colors.onAction} />
        ) : (
          <Text style={styles.buttonText}>Save to project</Text>
        )}
      </Pressable>
    </SessionBar>
  );
}

/** The layout shared by the session's change bars: title, one line of state, one action. */
export const changeBarStyles = StyleSheet.create((theme) => ({
  /** The bar has no status dot and nothing to open, so it carries the padding the
   *  shared session target gives the PR row — without it the text sits flush
   *  against the bar's border on one side and the button on the other. */
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    gap: 1,
    justifyContent: 'center',
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.sm,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.bold,
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  error: {
    color: theme.colors.attention,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  button: {
    minWidth: 78,
    height: 36,
    paddingHorizontal: theme.spacing.sm,
    marginRight: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.action,
  },
  wideButton: {
    width: 124,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  action: {
    marginRight: theme.spacing.sm,
  },
  buttonText: {
    color: theme.colors.onAction,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.bold,
  },
}));

const styles = changeBarStyles;
