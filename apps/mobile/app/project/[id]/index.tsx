import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

import { ProjectPage } from '../../../components/project/ProjectPage';
import { createVerityClient } from '../../../lib/client';
import { useNewDesignChoice } from '../../../lib/homePreferences';
import { sessionLayout } from '../../../lib/sessionLayout';
import { projectIdParam } from '../../../lib/useProjectDetail';

/**
 * A project's entry. With the new design (Settings › This app) it is the
 * project page; otherwise, as before, the project settings. On a wide screen the
 * page lives in the split layout's left column, so this route hands over to it.
 */
export default function ProjectEntry() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const newDesign = useNewDesignChoice();
  const { width } = useWindowDimensions();
  const { wide } = sessionLayout(width);
  const client = useMemo(() => createVerityClient(), []);
  // Wait for the stored choice: guessing "off" would send a device that has the
  // preview on to the settings it no longer starts from.
  if (newDesign === undefined) return null;
  if (!newDesign || client === null || projectId.length === 0) {
    return <Redirect href={{ pathname: '/project/[id]/settings', params: { id: projectId } }} />;
  }
  if (wide) return <SplitProjectRedirect id={projectId} />;
  return (
    <ProjectPage
      client={client}
      projectId={projectId}
      onOpenSession={(sessionId) =>
        router.push({ pathname: '/session/[id]', params: { id: sessionId } })
      }
    />
  );
}

/** Opens the project in the split home's left column, like a session's redirect. */
function SplitProjectRedirect({ id }: { id: string }) {
  useFocusEffect(
    useCallback(() => {
      router.dismissTo({ pathname: '/', params: { project: id } });
    }, [id]),
  );
  return null;
}
