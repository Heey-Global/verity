import { ProjectPageSample } from './parts';

/** The project sleeps: grey tile and a quiet word, no spinner. */
export default function AsleepMockup() {
  return (
    <ProjectPageSample
      name="Heey Docs"
      description="Product documentation"
      project={{ state: 'active', lifecycleState: 'sleeping', provisionError: null }}
    />
  );
}
