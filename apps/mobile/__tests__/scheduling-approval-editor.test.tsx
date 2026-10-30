import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  schedulingCardDecision,
  schedulingCardEdit,
  type SchedulingCardEdit,
  type SchedulingEditable,
} from '@verity/mobile';
import { SchedulingApprovalEditor } from '../components/SchedulingApprovalEditor';

const editable: SchedulingEditable = {
  original: {
    title: 'Intro call',
    language: 'en',
    emailSubject: 'Pick a time: Intro call',
    emailBody: 'Hi Anna, Intro call\n{link}',
  },
  meeting: '30 min · Google Meet',
  defaultEmail: {
    en: { subject: 'Pick a time: {title}', body: 'Hi Anna, {title}\n{link}' },
    de: { subject: 'Terminauswahl: {title}', body: 'Hallo Anna, {title}\n{link}' },
  },
};

function renderEditor(edit: SchedulingCardEdit = schedulingCardEdit(editable)) {
  const onChange = jest.fn();
  render(
    <SchedulingApprovalEditor
      editable={editable}
      edit={edit}
      onChange={onChange}
      error={undefined}
      disabled={false}
    />,
  );
  return onChange;
}

it('shows the default email in the chosen language and title, as the server will send it', () => {
  renderEditor({ ...schedulingCardEdit(editable), title: 'Kickoff', language: 'de' });
  expect(screen.getByDisplayValue('Terminauswahl: Kickoff')).toBeTruthy();
  expect(screen.getByDisplayValue('Hallo Anna, Kickoff\n{link}')).toBeTruthy();
});

it('turns the first email keystroke into the operator’s own text, which is then sent', () => {
  const onChange = renderEditor({ ...schedulingCardEdit(editable), language: 'de' });
  fireEvent.changeText(screen.getByDisplayValue('Terminauswahl: Intro call'), 'Termin');
  const edit = onChange.mock.calls[0]![0] as SchedulingCardEdit;
  // The body the operator saw is kept, not the English original it was generated from.
  expect(edit).toMatchObject({
    emailEdited: true,
    emailSubject: 'Termin',
    emailBody: 'Hallo Anna, Intro call\n{link}',
  });
  expect(schedulingCardDecision(editable, edit)).toEqual({
    updatedInput: {
      language: 'de',
      emailSubject: 'Termin',
      emailBody: 'Hallo Anna, Intro call\n{link}',
    },
  });
});

it('passes a changed title and language on', () => {
  const onChange = renderEditor();
  fireEvent.changeText(screen.getByDisplayValue('Intro call'), 'Kickoff');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Kickoff' }));
  fireEvent.press(screen.getByText('Deutsch'));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'de' }));
});
