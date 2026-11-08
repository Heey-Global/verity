import { InstructionsScreen, PROJECT_INSTRUCTIONS } from './shared';

/** Unchanged instructions: the text is directly editable, nothing to save yet. */
export default function InstructionsMockup() {
  return <InstructionsScreen initial={PROJECT_INSTRUCTIONS} />;
}
