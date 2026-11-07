import { Button } from '../../components/ui';
import { InstructionsScreen, PROJECT_INSTRUCTIONS } from './shared';

/** After an edit: Save appears directly below the text. */
export default function InstructionsEditedMockup() {
  return (
    <InstructionsScreen
      initial={`${PROJECT_INSTRUCTIONS}\nReply in German.`}
      footer={() => <Button label="Save" fullWidth onPress={() => undefined} />}
    />
  );
}
