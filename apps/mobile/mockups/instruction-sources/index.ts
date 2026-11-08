import type { MockupSpec } from '../types';
import InstructionsEditedMockup from './edited';
import InstructionsMockup from './overview';

export const instructionSourcesSpec: MockupSpec = {
  id: 'instruction-sources',
  title: 'Instructions with repository AGENTS.md',
  screens: {
    overview: { title: 'Instructions', Component: InstructionsMockup },
    edited: { title: 'Instructions after an edit', Component: InstructionsEditedMockup },
  },
};
