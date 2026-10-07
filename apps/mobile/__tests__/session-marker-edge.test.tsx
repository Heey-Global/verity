import { render, screen } from '@testing-library/react-native';

import {
  SessionMarkerEdge,
  sessionMarkers,
  sessionMarkersLabel,
} from '../components/SessionMarkerEdge';

describe('sessionMarkers', () => {
  it('keeps a fixed order so each segment position always means the same thing', () => {
    expect(sessionMarkers({ favorite: true, automation: 'paused', shared: true })).toEqual([
      { kind: 'favorite' },
      { kind: 'automation', paused: true },
      { kind: 'shared' },
    ]);
  });

  it('leaves out what a session does not have', () => {
    expect(sessionMarkers({ favorite: false, automation: undefined, shared: false })).toEqual([]);
    expect(sessionMarkers({ favorite: false, automation: 'enabled', shared: true })).toEqual([
      { kind: 'automation', paused: false },
      { kind: 'shared' },
    ]);
  });

  it('spells the markers out for screen readers, since color alone carries them', () => {
    expect(
      sessionMarkersLabel(sessionMarkers({ favorite: true, automation: 'enabled', shared: true })),
    ).toBe('favorite, automation active, shared');
  });
});

describe('SessionMarkerEdge', () => {
  it('draws one segment per marker', () => {
    render(
      <SessionMarkerEdge
        markers={sessionMarkers({ favorite: true, automation: undefined, shared: true })}
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
