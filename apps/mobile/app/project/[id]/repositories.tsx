import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { RepositoriesPage } from '../../../components/project/RepositoriesPage';
import { SettingsMessage } from '../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../lib/client';
import { projectIdParam } from '../../../lib/useProjectDetail';

/** A project's repositories and their open pull requests, from its page's Content. */
export default function ProjectRepositoriesScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Repositories"
      />
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: 'Repositories' }} />
      <RepositoriesPage client={client} projectId={projectId} />
    </>
  );
}
