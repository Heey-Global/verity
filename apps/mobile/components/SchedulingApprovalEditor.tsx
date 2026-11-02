import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  SCHEDULING_LANGUAGES,
  schedulingCardEmail,
  spellOutBidiControls,
  type SchedulingCardEdit,
  type SchedulingEditable,
} from '@verity/mobile';
import { FilterChips, HintBox, Text, TextField } from './ui';

/**
 * The editable part of a scheduling send card: the meeting title, the guest language and the
 * email. The times stay read-only; changing them changes holds and conflicts, which is a new
 * request for the agent to prepare.
 */
export function SchedulingApprovalEditor({
  editable,
  edit,
  onChange,
  error,
  disabled,
}: {
  editable: SchedulingEditable;
  edit: SchedulingCardEdit;
  onChange: (edit: SchedulingCardEdit) => void;
  error: string | undefined;
  disabled: boolean;
}) {
  const email = schedulingCardEmail(editable, edit);
  // The first keystroke in the email fixes the text shown, so a default email the operator
  // starts editing no longer follows the title or language.
  const editEmail = (change: Partial<Pick<SchedulingCardEdit, 'emailSubject' | 'emailBody'>>) =>
    onChange({
      ...edit,
      emailSubject: email.subject,
      emailBody: email.body,
      ...change,
      emailEdited: true,
    });
  // A text field renders direction controls invisibly, so text that would be sent with them is
  // spelled out here, as the read-only card does for everything it shows.
  const hidden = [edit.title, email.subject, email.body].filter(
    (text) => spellOutBidiControls(text) !== text,
  );
  return (
    <View style={styles.editor}>
      {hidden.length > 0 ? (
        <HintBox
          title="Contains hidden text-direction characters"
          message={hidden.map(spellOutBidiControls).join('\n\n')}
        />
      ) : null}
      <TextField
        label="Title"
        value={edit.title}
        onChangeText={(title) => onChange({ ...edit, title })}
        disabled={disabled}
        maxLength={200}
      />
      <View style={styles.language}>
        <Text variant="label">Guest language</Text>
        <FilterChips
          options={SCHEDULING_LANGUAGES}
          value={edit.language}
          onChange={(language) => {
            if (!disabled) onChange({ ...edit, language });
          }}
          accessibilityLabel="Guest language"
          compact
          wrap
        />
        {edit.emailEdited || !editable.defaultEmail ? (
          <Text variant="footnote">
            The booking page follows the language; your own email text stays as written.
          </Text>
        ) : null}
      </View>
      <TextField
        label="Email subject"
        value={email.subject}
        onChangeText={(emailSubject) => editEmail({ emailSubject })}
        disabled={disabled}
        maxLength={300}
      />
      <TextField
        label="Email"
        value={email.body}
        onChangeText={(emailBody) => editEmail({ emailBody })}
        disabled={disabled}
        multiline
        maxLength={10_000}
        error={error === undefined ? undefined : { title: 'Cannot send yet', message: error }}
      />
      <Text variant="footnote">{'{link}'} is replaced by the booking link.</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  editor: { gap: theme.spacing.md },
  language: { gap: theme.spacing.xs },
}));
