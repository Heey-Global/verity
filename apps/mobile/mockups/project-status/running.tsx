import { ProjectPageSample } from './parts';

/** A running project with a long name: blue tile, no tag, the name truncates. */
export default function RunningMockup() {
  return (
    <ProjectPageSample
      name="Kundenportal Relaunch Frontend und Backend"
      description="Customer portal for the 2027 relaunch"
      project={{ state: 'active', lifecycleState: 'active', provisionError: null }}
    />
  );
}
