import { qaRowView, type ProjectQASummary } from '@verity/mobile';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, SectionHeader, StatusDot, StatusTag, Text, TileMark } from '../ui';

/**
 * The project's pinned Roles group with its QA row (docs/ci-supervision.md):
 * state instead of a last message, a marker when QA needs you, and which
 * sources it read and when. Green only after a fresh, complete check.
 */
export function ProjectQARole({
  summary,
  canManage,
  onOpen,
  onTurnOn,
}: {
  summary: ProjectQASummary;
  canManage: boolean;
  onOpen: () => void;
  onTurnOn: () => void;
}) {
  const view = qaRowView(summary);
  const off = view.state === 'off';
  const quiet = off || view.state === 'paused';
  const attention = view.state === 'needsYou' || view.state === 'access';
  const marker =
    view.state === 'needsYou' ? (
      <StatusTag intent="needsSetup" label="Needs you" />
    ) : view.state === 'access' ? (
      <StatusTag intent="needsSetup" label="Check access" />
    ) : view.state === 'working' ? (
      <StatusTag intent="transient" label={summary.repairing ? 'Repairing' : 'Working'} />
    ) : view.state === 'clear' ? (
      <StatusTag intent="ready" label="All clear" />
    ) : view.state === 'paused' ? (
      <StatusTag intent="unknown" label="Paused" />
    ) : undefined;
  return (
    <>
      <SectionHeader title="Roles" variant="eyebrow" />
      <Group>
        {off ? (
          <Row
            title="QA"
            subtitle={view.subtitle}
            leading={{ icon: 'shield', quiet: true }}
            action={
              canManage ? (
                <Button label="Turn on" size="small" variant="secondary" onPress={onTurnOn} />
              ) : undefined
            }
          />
        ) : (
          <Row
            title="QA"
            subtitle={view.subtitle}
            leading={{
              icon: 'shield',
              ...(attention ? { intent: 'needsSetup' as const } : {}),
              ...(quiet ? { quiet: true } : {}),
              ...(summary.repairing > 0
                ? { marks: { bottom: <TileMark tone="action" glyph="loader" /> } }
                : {}),
            }}
            trailing={marker}
            navigates
            onPress={onOpen}
            accessibilityHint="Opens the project's QA"
            answers={
              view.sources.length ? (
                <View style={styles.sources} testID="qa-sources">
                  {view.sources.map((source) => (
                    <StatusDot key={source.label} intent={source.intent} label={source.label} />
                  ))}
                  {view.checked ? (
                    <Text variant="footnote" tone="faint">
                      {view.checked}
                    </Text>
                  ) : null}
                </View>
              ) : undefined
            }
          />
        )}
      </Group>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sources: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.spacing.md,
    rowGap: theme.spacing.xs,
  },
}));
