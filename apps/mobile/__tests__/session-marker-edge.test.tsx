import { render, screen } from '@testing-library/react-native';

import {
  SessionMarkerEdge,
  sessionMarkers,
  sessionMarkersLabel,
} from '../components/SessionMarkerEdge';

describe('sessionMarkers', () => {
  it('keeps a fixed order so each stripe position always means the same thing', () => {
    expect(sessionMarkers({ favorite: true, automation: 'paused', preview: 'public' })).toEqual([
      { kind: 'favorite' },
      { kind: 'automation', paused: true },
      { kind: 'shared', public: true },
    ]);
  });

  it('leaves out what a session does not have', () => {
    expect(sessionMarkers({ favorite: false, automation: undefined, preview: undefined })).toEqual(
      [],
    );
    expect(sessionMarkers({ favorite: false, automation: 'enabled', preview: 'local' })).toEqual([
      { kind: 'automation', paused: false },
      { kind: 'shared', public: false },
    ]);
  });

  it('spells the markers out for screen readers, since color alone carries them', () => {
    expect(
      sessionMarkersLabel(
        sessionMarkers({ favorite: true, automation: 'enabled', preview: 'local' }),
      ),
    ).toBe('favorite, automation active, shared locally');
  });
});

describe('SessionMarkerEdge', () => {
  it('draws one stripe per marker', () => {
    render(
      <SessionMarkerEdge
        markers={sessionMarkers({ favorite: true, automation: undefined, preview: 'public' })}
      />,
    );
    expect(screen.getByTestId('session-marker-favorite')).toBeTruthy();
    expect(screen.getByTestId('session-marker-shared')).toBeTruthy();
    expect(screen.queryByTestId('session-marker-automation')).toBeNull();
  });

  it('draws nothing for a session without markers', () => {
    render(<SessionMarkerEdge markers={[]} />);
    expect(screen.queryByTestId('session-marker-edge')).toBeNull();
  });
});
