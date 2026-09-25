// Default model, per project: the model a new session or Agent Loop in this
// project starts with when nothing else picks one. The list is the same one the
// new-session picker offers (`GET /models`), so a model that can be chosen here
// can actually be spawned; "Server default" clears the override.
import {
  modelDisplayName,
  partitionModels,
  type ModelList,
  type VerityClient,
} from '@verity/mobile';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsChoiceRow,
  SettingsDisclosure,
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectModelScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Default model"
      />
    );
  }
  return <ProjectModelView client={client} projectId={projectId} />;
}

function ProjectModelView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { theme } = useUnistyles();
  const { detail, loading, error, setError, load, onSettingsSaved } = useProjectDetail(
    client,
    projectId,
  );
  const [models, setModels] = useState<ModelList | undefined>(undefined);
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .listModels()
      .then((list) => {
        if (active) setModels(list);
      })
      .catch(() => {
        if (active) setModelsError('Could not load the available models.');
      });
    return () => {
      active = false;
    };
  }, [client]);

  const choose = useCallback(
    (model: string | null) => {
      if (saving) return;
      setSaving(true);
      setError(undefined);
      void client
        .updateProjectSettings(projectId, { defaultModel: model })
        .then(onSettingsSaved)
        .catch((caught) =>
          setError(caught instanceof Error ? caught.message : 'Could not save the default model'),
        )
        .finally(() => setSaving(false));
    },
    [client, onSettingsSaved, projectId, saving, setError],
  );

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.setup.text} />
      </View>
    );
  }
  if (detail === undefined) {
    return (
      <SettingsMessage
        title="Couldn't load project"
        subtitle={error ?? 'Unknown error'}
        screenTitle="Default model"
        onRetry={() => load()}
      />
    );
  }

  const current = detail.settings?.defaultModel ?? null;
  const partitioned =
    models === undefined
      ? undefined
      : partitionModels(models.models, models.moreModels ?? [], models.modelOrder);
  // A stored model the server no longer offers still has to be visible, or the
  // screen would show nothing selected while the project keeps using it.
  const orphaned =
    current !== null &&
    partitioned !== undefined &&
    !partitioned.primary.includes(current) &&
    !partitioned.more.includes(current);
  const row = (model: string) => (
    <SettingsChoiceRow
      key={model}
      title={modelDisplayName(model)}
      subtitle={model}
      selected={model === current}
      disabled={saving}
      onPress={() => choose(model)}
      accessibilityLabel={`Use model ${modelDisplayName(model)}, ${model}`}
    />
  );

  return (
    <SettingsScaffold title="Default model" detail state={{ error, saving }} onRetry={() => load()}>
      <SettingsGroup
        title="Model"
        description="New sessions and Agent Loops in this project start with this model. A session can still switch to another one."
      >
        <SettingsListPanel>
          <SettingsChoiceRow
            title="Server default"
            subtitle={
              models?.default !== undefined
                ? `Currently ${modelDisplayName(models.default)}`
                : 'Whatever the server picks'
            }
            selected={current === null}
            disabled={saving}
            onPress={() => choose(null)}
            accessibilityLabel="Use the server default model"
          />
          {orphaned ? row(current) : null}
          {partitioned?.primary.map(row)}
        </SettingsListPanel>
        {partitioned !== undefined && partitioned.more.length > 0 ? (
          <SettingsDisclosure
            title="More models"
            defaultExpanded={current !== null && partitioned.more.includes(current)}
          >
            <SettingsListPanel>{partitioned.more.map(row)}</SettingsListPanel>
          </SettingsDisclosure>
        ) : null}
        {models === undefined && modelsError === undefined ? (
          <ActivityIndicator size="small" color={theme.colors.setup.text} />
        ) : null}
        {modelsError !== undefined ? <Text style={styles.fieldError}>{modelsError}</Text> : null}
      </SettingsGroup>
    </SettingsScaffold>
  );
}
