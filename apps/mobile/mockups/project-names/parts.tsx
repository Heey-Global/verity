import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../../components/Icon';
import { Group, Row, SectionHeader, StatusTag, Text } from '../../components/ui';
import { tint } from '../../components/ui/tint';

export const ignore = () => undefined;

export const NAME = 'Verity Plattform';
export const DESCRIPTION = 'Self-hosted AI agent workspace with mobile app';

type Editing =
  | { field: 'name'; value: string; error?: { title: string; message: string } }
  | { field: 'description'; value: string; error?: { title: string; message: string } };

/**
 * The project page head with name and description edited in place. At rest
 * both read as text; a tap turns the tapped line into a field in the same
 * typography. Sample composition only: production uses TextField's inline
 * mode, extended by a title and subtitle size.
 */
export function ProjectHeroSample({
  name = NAME,
  description,
  editing,
}: {
  name?: string;
  description?: string;
  editing?: Editing;
}) {
  const { theme } = useUnistyles();
  const shownName = editing?.field === 'name' ? editing.value : name;
  return (
    <View style={styles.hero}>
      <View style={styles.initial}>
        <Text variant="title" tone="action">
          {(Array.from(shownName.trim())[0] ?? '?').toUpperCase()}
        </Text>
      </View>
      <View style={styles.heroBody}>
        {editing?.field === 'name' ? (
          <InlineField variant="title" editing={editing} />
        ) : (
          <Pressable accessibilityRole="button" accessibilityHint="Rename the project">
            <Text variant="title" accessibilityRole="header" numberOfLines={1}>
              {name}
            </Text>
          </Pressable>
        )}
        {editing?.field === 'description' ? (
          <InlineField variant="subtitle" editing={editing} multiline />
        ) : description !== undefined ? (
          <Pressable accessibilityRole="button" accessibilityHint="Edit the description">
            <Text variant="subtitle" numberOfLines={2}>
              {description}
            </Text>
          </Pressable>
        ) : (
          <Pressable style={styles.placeholder} accessibilityRole="button">
            <Icon name="plus" size={14} color={theme.colors.textFaint} />
            <Text variant="subtitle" tone="faint">
              Add description
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function InlineField({
  variant,
  editing,
  multiline = false,
}: {
  variant: 'title' | 'subtitle';
  editing: Editing;
  multiline?: boolean;
}) {
  const { theme } = useUnistyles();
  const error = editing.error;
  return (
    <View style={styles.editWrap}>
      <View style={[styles.field, error ? styles.fieldError : styles.fieldFocused]}>
        <TextInput
          value={editing.value}
          multiline={multiline}
          returnKeyType="done"
          style={[
            styles.input,
            variant === 'title' ? styles.inputTitle : styles.inputSubtitle,
            multiline ? styles.inputMulti : null,
          ]}
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel={editing.field === 'name' ? 'Project name' : 'Description'}
        />
        <Pressable
          style={[styles.check, multiline ? styles.checkTop : null]}
          accessibilityRole="button"
          accessibilityLabel="Save"
        >
          <Icon name="check" size={16} color={theme.colors.action} />
        </Pressable>
      </View>
      {error ? (
        <View style={styles.errorLine}>
          <Icon name="alert-circle" size={14} color={theme.colors.attention} />
          <Text variant="footnote" tone="attention" style={styles.errorText}>
            {error.title} · {error.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** The rest of the project page, unchanged, so the head is seen in context. */
export function ProjectPageBody() {
  return (
    <>
      <SectionHeader title="Needs you" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'message-square' }}
          title="Aufgabenliste Reduzieren"
          subtitle="Claude Opus 5.5 · waiting for your answer"
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Content" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'book-open' }}
          title="Wiki"
          subtitle="Maintained knowledge and decisions"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'check-square' }}
          title="Tasks"
          subtitle="4 open · 2 issues"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'git-pull-request' }}
          title="Repositories"
          subtitle="2 repositories · 5 open PRs"
          trailing={<StatusTag intent="ready" label="Ready" />}
          navigates
          onPress={ignore}
        />
      </Group>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  hero: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  heroBody: { flex: 1, gap: theme.spacing.xxs },
  initial: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  placeholder: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  editWrap: { gap: theme.spacing.xs },
  // No box: the text stays where it read at rest, an underline marks the field.
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.xxs,
    borderBottomWidth: 1,
  },
  fieldFocused: { borderBottomColor: theme.colors.action },
  fieldError: { borderBottomColor: theme.colors.attention },
  input: { flex: 1, minWidth: 0, color: theme.colors.text, paddingVertical: 0 },
  inputTitle: {
    fontFamily: theme.typography.title.fontFamily,
    fontSize: theme.typography.title.fontSize,
    letterSpacing: theme.typography.title.letterSpacing,
  },
  inputSubtitle: {
    fontFamily: theme.typography.subtitle.fontFamily,
    fontSize: theme.typography.subtitle.fontSize,
    lineHeight: theme.typography.subtitle.lineHeight,
  },
  inputMulti: { minHeight: theme.typography.subtitle.lineHeight * 3, textAlignVertical: 'top' },
  check: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  checkTop: { alignSelf: 'flex-start' },
  errorLine: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs },
  errorText: { flex: 1 },
}));
