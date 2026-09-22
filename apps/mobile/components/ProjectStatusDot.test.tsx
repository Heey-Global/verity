import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { darkTheme, lightTheme } from '../theme/tokens';

import { ProjectStatusDot } from './ProjectStatusDot';
import { WorkingDot } from './WorkingDot';

// The overview's one "something is happening here" signal. A project whose
// sandbox Verity was rebuilding used to draw a settled green dot AND a grey
// ActivityIndicator further along the same row — two progress vocabularies for
// one container, only one of which was magenta. These assert the signal itself,
// not that a particular state maps to it (`projectBadge` owns that): a dot that
// stops being magenta, or stops moving, goes back to being invisible on a phone
// while the tests that only check the label stay green.
const dotStyle = (label: string) =>
  StyleSheet.flatten(screen.getByLabelText(label).props.style) as Record<string, unknown>;

// Which theme the renderer picks is not this test's business, so the colours are
// only ever compared against the same theme's other tokens — never asserted as a
// hex literal, which would pin one theme by accident.
const themes = [lightTheme, darkTheme] as (typeof darkTheme)[];
const toneColors = (pick: (theme: typeof darkTheme) => string) => themes.map(pick);

describe('ProjectStatusDot', () => {
  it('draws the shared pulsing magenta dot whenever Verity is working on the container', () => {
    render(
      <ProjectStatusDot
        badge={{
          label: 'Updating secure workspace…',
          tone: 'working',
          pulsing: true,
          needsRepair: false,
        }}
      />,
    );

    // The load-bearing assertion, and the reason it is by component type rather
    // than by style: the pulse comes from `WorkingDot`'s subscription to the
    // shared clock, and by the time the animated opacity reaches the host view it
    // is an ordinary number no assertion can tell from a static one. An inlined
    // magenta circle would satisfy every style check below and never move.
    expect(screen.UNSAFE_queryByType(WorkingDot)).not.toBeNull();

    const style = dotStyle('Updating secure workspace…');
    expect(toneColors((theme) => theme.colors.accent)).toContain(style.backgroundColor);
    expect(toneColors((theme) => theme.colors.tone.done)).not.toContain(style.backgroundColor);
  });

  it('leaves a settled container still, in its own colour', () => {
    render(
      <ProjectStatusDot
        badge={{ label: 'Running', tone: 'done', pulsing: false, needsRepair: false }}
      />,
    );

    expect(screen.UNSAFE_queryByType(WorkingDot)).toBeNull();
    const style = dotStyle('Running');
    expect(toneColors((theme) => theme.colors.tone.done)).toContain(style.backgroundColor);
    expect(toneColors((theme) => theme.colors.accent)).not.toContain(style.backgroundColor);
    expect(style.opacity).toBeUndefined();
  });
});
