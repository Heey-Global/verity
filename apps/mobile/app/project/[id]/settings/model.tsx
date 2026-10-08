// Agents, per project: which connected agents may run here, and the model a new
// session starts with. The default list is the project's own `GET /models`, so a
// model that can be chosen here can actually be spawned; "Automatic" clears the
// override and lets the server pick the first allowed model.
import {
  agentLabel,
  modelAgent,
  modelDisplayName,
  partitionModels,
  PROJECT_AGENTS,
  type ModelList,
  type ProjectAgent,
  type VerityClient,
} from '@verity/mobile';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AgentProviderIcon } from '../../../../components/AgentProviderIcon';
import { Icon } from '../../../../components/Icon';
import {
  SettingsChoiceRow,
  SettingsDisclosure,
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectAgentsScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Agents"
      />
    );
  }
  return <ProjectAgentsView client={client} projectId={projectId} />;
}

type ProjectSettingsChange = {
  defaultModel?: string | null;
  allowedAgents?: ProjectAgent[] | null;
};

function AgentIcon({ agent }: { agent: ProjectAgent }) {
  const { theme } = useUnistyles();
  return agent === 'opencode' ? (
    <Icon name="terminal" size={18} color={theme.colors.primary} />
  ) : (
    <AgentProviderIcon provider={agent} size={18} color={theme.colors.primary} />
  );
}

function ProjectAgentsView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { theme } = useUnistyles();
  const { detail, loading, error, setError, load, onSettingsSaved } = useProjectDetail(
    client,
    projectId,
  );
  // Every connected model decides which agents can be toggled; the project's own
  // list is what its sessions may start with, including the resolved default.
  const [connected, setConnected] = useState<ModelList | undefined>(undefined);
  const [models, setModels] = useState<ModelList | undefined>(undefined);
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);
  // The change being saved, shown at once so a toggle or check mark flips on tap
  // instead of after the round trip; a failed save drops it again.
  const [pending, setPending] = useState<ProjectSettingsChange | undefined>(undefined);

  const modelRequest = useRef(0);
  const loadModels = useCallback(() => {
    const request = ++modelRequest.current;
    const fresh = () => request === modelRequest.current;
    void Promise.all([client.listModels(), client.listModels(projectId)])
      .then(([all, project]) => {
        if (!fresh()) return;
        setConnected(all);
        setModels(project);
        setModelsError(undefined);
      })
      .catch(() => {
        if (fresh()) setModelsError('Could not load the available models.');
      });
  }, [client, projectId]);
  useEffect(() => {
    loadModels();
    return () => {
      modelRequest.current++;
    };
  }, [loadModels]);

  // Taps during a save are merged and sent once it lands, so a second toggle
  // is never dropped while the first is still on its way.
  const inFlight = useRef(false);
  const queued = useRef<ProjectSettingsChange | undefined>(undefined);
  const save = useCallback(
    (patch: ProjectSettingsChange) => {
      setPending((shown) => ({ ...shown, ...patch }));
      if (inFlight.current) {
        queued.current = { ...queued.current, ...patch };
        return;
      }
      inFlight.current = true;
      setError(undefined);
      void (async () => {
        let next: ProjectSettingsChange | undefined = patch;
        while (next !== undefined) {
          const change: ProjectSettingsChange = next;
          try {
            onSettingsSaved(await client.updateProjectSettings(projectId, change));
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not save the agents');
            queued.current = undefined;
            break;
          }
          next = queued.current;
          queued.current = undefined;
        }
        inFlight.current = false;
        setPending(undefined);
        // The server may have dropped a default the new rule excludes.
        loadModels();
      })();
    },
    [client, loadModels, onSettingsSaved, projectId, setError],
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
        screenTitle="Agents"
        onRetry={() => load()}
      />
    );
  }

  const stored = detail.settings?.allowedAgents ?? null;
  const allowed: readonly ProjectAgent[] =
    (pending?.allowedAgents !== undefined ? pending.allowedAgents : stored) ?? PROJECT_AGENTS;
  const connectedAgents = new Set((connected?.models ?? []).map(modelAgent));
  // An agent that is allowed but no longer connected stays visible, so the rule
  // that still names it can be read and changed.
  const listedAgents = PROJECT_AGENTS.filter(
    (agent) => connectedAgents.has(agent) || (stored !== null && stored.includes(agent)),
  );
  const allowedConnected = allowed.filter((agent) => connectedAgents.has(agent));
  const toggle = (agent: ProjectAgent, on: boolean) => {
    const next = PROJECT_AGENTS.filter((candidate) =>
      candidate === agent ? on : allowed.includes(candidate),
    );
    save({ allowedAgents: next.length === PROJECT_AGENTS.length ? null : next });
  };

  const current =
    pending?.defaultModel !== undefined
      ? pending.defaultModel
      : (detail.settings?.defaultModel ?? null);
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
      onPress={() => save({ defaultModel: model })}
      accessibilityLabel={`Use model ${modelDisplayName(model)}, ${model}`}
    />
  );

  return (
    <SettingsScaffold title="Agents" detail state={{ error, saving: false }} onRetry={() => load()}>
      {listedAgents.length > 0 ? (
        <SettingsGroup
          title="Allowed"
          description="Only these agents can run in this project, including handoffs, automations and background work."
        >
          <SettingsPanel>
            {listedAgents.map((agent) => {
              const on = allowed.includes(agent);
              // An empty rule is invalid even when its final agent is disconnected.
              const locked =
                on &&
                (allowed.length === 1 ||
                  (connectedAgents.has(agent) && allowedConnected.length === 1));
              return (
                <SettingsToggleRow
                  key={agent}
                  icon={<AgentIcon agent={agent} />}
                  label={agentLabel(agent)}
                  value={on}
                  disabled={locked}
                  onValueChange={(value) => toggle(agent, value)}
                />
              );
            })}
          </SettingsPanel>
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        title="Default model"
        description="New sessions in this project start with this model. A session can still switch to another allowed one."
      >
        <SettingsListPanel>
          <SettingsChoiceRow
            title="Automatic"
            subtitle={
              current === null && models?.default !== undefined
                ? `First allowed model · currently ${modelDisplayName(models.default)}`
                : 'First allowed model'
            }
            selected={current === null}
            onPress={() => save({ defaultModel: null })}
            accessibilityLabel="Use the first allowed model"
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
