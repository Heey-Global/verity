import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import {
  SessionMarkerColumn,
  markerIcon,
  sessionMarkers,
  sessionMarkersLabel,
} from '../components/SessionMarkerColumn';

describe('sessionMarkers', () => {
  it('keeps a fixed order so each entry position always means the same thing', () => {
    expect(sessionMarkers({ favorite: true, automation: 'paused', shared: 'online' })).toEqual([
      { kind: 'favorite' },
      { kind: 'automation', paused: true },
      { kind: 'shared', online: true },
    ]);
  });

  it('leaves out what a session does not have', () => {
    expect(sessionMarkers({ favorite: false, automation: undefined, shared: undefined })).toEqual(
      [],
    );
  });

  it('shows the widest reach of a share: globe once online, wifi when only local', () => {
    const [local] = sessionMarkers({ favorite: false, automation: undefined, shared: 'local' });
    const [online] = sessionMarkers({ favorite: false, automation: undefined, shared: 'online' });
    expect(local && markerIcon(local)).toBe('wifi');
    expect(online && markerIcon(online)).toBe('globe');
  });

  it('spells the markers out for screen readers', () => {
    expect(
      sessionMarkersLabel(
        sessionMarkers({ favorite: true, automation: 'enabled', shared: 'local' }),
      ),
    ).toBe('favorite, automation active, shared on the local network');
  });
});

describe('SessionMarkerColumn', () => {
  it('draws one entry per marker and nothing without markers', () => {
    const { rerender } = render(
      <SessionMarkerColumn
        markers={sessionMarkers({ favorite: true, automation: undefined, shared: 'online' })}
        previewUrl="http://preview"
      />,
    );
    // Favorite and automation are hidden from screen readers: the row label says them.
    const hidden = { includeHiddenElements: true };
    expect(screen.getByTestId('session-marker-favorite', hidden)).toBeTruthy();
    expect(screen.getByTestId('session-marker-shared')).toBeTruthy();
    expect(screen.queryByTestId('session-marker-automation', hidden)).toBeNull();

    rerender(<SessionMarkerColumn markers={[]} previewUrl={null} />);
    expect(screen.queryByTestId('session-marker-column')).toBeNull();
  });

  it('opens the preview from the share entry, which replaced the old preview icon', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(
      <SessionMarkerColumn
        markers={sessionMarkers({ favorite: false, automation: undefined, shared: 'local' })}
        previewUrl="http://192.168.1.5:8080"
      />,
    );

    fireEvent.press(screen.getByLabelText('Open preview'));

    expect(open).toHaveBeenCalledWith('http://192.168.1.5:8080');
  });
});

it('marks linked sessions between automation and sharing and opens their settings', () => {
  const markers = sessionMarkers({
    favorite: true,
    automation: 'enabled',
    linked: true,
    shared: 'online',
  });
  expect(markers.map((marker) => marker.kind)).toEqual([
    'favorite',
    'automation',
    'linked',
    'shared',
  ]);
  expect(markerIcon({ kind: 'linked' })).toBe('link');
  expect(sessionMarkersLabel([{ kind: 'linked' }])).toBe('linked sessions');
  const open = jest.fn();
  render(<SessionMarkerColumn markers={markers} previewUrl={null} onOpenLinks={open} />);
  fireEvent.press(screen.getByLabelText('Open linked sessions'));
  expect(open).toHaveBeenCalledTimes(1);
});
