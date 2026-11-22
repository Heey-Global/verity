import { ProjectPageSample } from './parts';

/** The sandbox is starting: grey tile, spinner and word next to the name. */
export default function StartingMockup() {
  return (
    <ProjectPageSample
      name="K8s"
      description="Cluster"
      project={{ state: 'active', lifecycleState: 'container_starting', provisionError: null }}
    />
  );
}
