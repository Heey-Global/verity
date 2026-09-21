// Knowledge: the one model every Wiki maintenance job runs on, in every project.
//
// The choice is server-wide because Wiki maintenance is a Verity capability, not
// a property of a repository — so it belongs here, next to the other server-wide
// settings, and not in one project's Knowledge tab where it looked like a
// per-project switch while silently changing every other project too.
import { modelDisplayName, partitionModels, type VerityClient } from '@verity/mobile';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsDisclosure,
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsSaveState,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { useModels } from '../../hooks/useModels';
import { createVerityClient } from '../../lib/client';
import {
  retryFailedVeritySettings,
  saveVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';

export default function KnowledgeSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to choose the Knowledge model."
        screenTitle="Knowledge"
      />
    );
  }
  return <KnowledgeSettingsView client={client} />;
}

function KnowledgeSettingsView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const reload = useLoadVeritySettings(client);
  const { settings } = useVeritySettings();
  const { models, modelOrder, moreModels, loading, error, refresh } = useModels(client);
  const selected = settings?.knowledgeModel ?? null;
  const partitioned = useMemo(
    () => partitionModels(models, moreModels, modelOrder),
    [models, modelOrder, moreModels],
  );
  // Whatever maintenance is running on has to be on the open list. A pinned
  // model hidden behind the collapsed disclosure leaves a radiogroup with
  // nothing checked, which reads as "unset" — the one answer that is wrong.
  const primary =
    selected !== null && partitioned.more.includes(selected)
      ? [selected, ...partitioned.primary]
      : partitioned.primary;
  const more = partitioned.more.filter((model) => model !== selected);
  // Same reason for a model the catalog does not list — including while the
  // catalog is missing entirely. "No longer offered" is a claim about the
  // catalog, though, so it needs one: a failed or unfinished load must not
  // accuse a perfectly good model of being retired.
  const pinnedMissing = selected !== null && !models.includes(selected) ? selected : undefined;
  const retired = error === undefined && models.length > 0;

  const choice = (model: string, title: string, hint: string) => (
    <Pressable
      key={model}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected === model }}
      accessibilityLabel={`Use ${model}`}
      onPress={() => void saveVeritySettings(client, { knowledgeModel: model })}
      style={({ pressed }) => [
        styles.backendChoice,
        selected === model ? styles.backendChoiceSelected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={styles.backendChoiceTitle}>{title}</Text>
      <Text style={styles.reproHint}>{hint}</Text>
    </Pressable>
  );
  const modelChoice = (model: string) => choice(model, modelDisplayName(model), model);

  return (
    <SettingsScaffold
      title="Knowledge"
      detail
      onRetry={() => {
        refresh();
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        });
      }}
    >
      <SettingsGroup
        title="Knowledge model"
        description="Choose the model that keeps project Wikis up to date. It handles one project at a time and never mixes content between projects."
      >
        <SettingsPanel>
          {error !== undefined ? <Text style={styles.fieldError}>{error}</Text> : null}
          {/* There is deliberately no automatic option. An inherited default
              silently decided which model rewrote every project's Wiki — and
              the first anyone heard of it was the model name on a finished job.
              Until this is chosen, maintenance holds instead of guessing. */}
          {selected === null ? (
            <Text style={styles.reproSubtitle}>
              No model chosen yet. Wiki maintenance stays queued — it starts once you pick one here.
            </Text>
          ) : null}
          {loading && models.length === 0 ? (
            <ActivityIndicator color={theme.colors.setup.text} />
          ) : (
            <View style={styles.backendChoices} accessibilityRole="radiogroup">
              {pinnedMissing !== undefined
                ? choice(
                    pinnedMissing,
                    modelDisplayName(pinnedMissing),
                    retired ? `${pinnedMissing} — no longer offered` : pinnedMissing,
                  )
                : null}
              {primary.map(modelChoice)}
            </View>
          )}
        </SettingsPanel>
        {more.length > 0 ? (
          <SettingsDisclosure title="More models" icon="cpu">
            <View style={styles.backendChoices} accessibilityRole="radiogroup">
              {more.map(modelChoice)}
            </View>
          </SettingsDisclosure>
        ) : null}
      </SettingsGroup>
      <SettingsSaveState />
    </SettingsScaffold>
  );
}
