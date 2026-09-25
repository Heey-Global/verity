import { Redirect, useLocalSearchParams } from 'expo-router';

import { projectIdParam } from '../../../lib/useProjectDetail';

export default function ProjectEntry() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  return (
    <Redirect href={{ pathname: '/project/[id]/settings', params: { id: projectIdParam(id) } }} />
  );
}
