import { sessionGroupsSpec } from './session-groups';
import { factorySpec } from './factory-spec';
import { homeAnswersSpec } from './home-answers';
import { instructionSourcesSpec } from './instruction-sources';
import { mockupReviewSpec } from './mockup-review';
import { planCardSpec } from './plan-card';
import { repositoriesSpec } from './repositories';
import { sourceActionsSpec } from './source-actions';
import type { MockupScreen, MockupSpec } from './types';
import { wikiSpec } from './wiki';
import { wikiMaintenanceSpec } from './wiki-maintenance';

/** Every spec with mockups. A new spec folder is added here. */
export const MOCKUP_SPECS: readonly MockupSpec[] = [
  sessionGroupsSpec,
  factorySpec,
  homeAnswersSpec,
  mockupReviewSpec,
  instructionSourcesSpec,
  planCardSpec,
  repositoriesSpec,
  sourceActionsSpec,
  wikiSpec,
  wikiMaintenanceSpec,
];

export function findMockup(
  specId: string | undefined,
  screenId: string | undefined,
): { spec: MockupSpec; screen: MockupScreen } | null {
  const spec = MOCKUP_SPECS.find((candidate) => candidate.id === specId);
  if (!spec || screenId === undefined || !Object.hasOwn(spec.screens, screenId)) return null;
  const screen = spec.screens[screenId];
  return screen ? { spec, screen } : null;
}
