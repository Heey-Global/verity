import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import plist from '@expo/plist';
import config from '../app.config';

const targetRoot = resolve(__dirname, '../targets/VerityMeetingActivity');
const read = (path: string) => readFileSync(resolve(targetRoot, path), 'utf8');
const shared = read('_shared/LiveMeetingActivity.swift');
const widget = read('VerityMeetingActivity.swift');

describe('meeting Live Activity native contract', () => {
  it('packages shared intent types in the app and iPhone/iPad widget target', () => {
    const target = require(resolve(targetRoot, 'expo-target.config.js'));
    const manifest = plist.parse(read('Info.plist')) as {
      NSExtension: { NSExtensionPointIdentifier: string };
    };
    expect(config.ios?.infoPlist?.NSSupportsLiveActivities).toBe(true);
    expect(config.ios?.supportsTablet).toBe(true);
    expect(config.plugins).toContain('@bacons/apple-targets');
    expect(target.type).toBe('widget');
    expect(target.frameworks).toEqual(expect.arrayContaining(['ActivityKit', 'AppIntents']));
    expect(manifest.NSExtension.NSExtensionPointIdentifier).toBe('com.apple.widgetkit-extension');
    expect(widget).toContain('ActivityConfiguration(for: LiveMeetingAttributes.self)');
    expect(widget).toContain('dynamicIsland:');
  });

  it('keeps participant details and speech out of the system-visible payload', () => {
    const attributes = shared.slice(
      shared.indexOf('struct LiveMeetingAttributes:'),
      shared.indexOf('\nenum MeetingActivityError'),
    );
    const fields = [...attributes.matchAll(/^    (?:var|let) (\w+):|^  let (\w+):/gm)].map(
      (match) => match[1] ?? match[2],
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      // Adding transcript/title/name fields here leaks them into Lock Screen snapshots,
      // even when the current SwiftUI layout does not draw those fields.
      expect([
        'state',
        'updatedAt',
        'lastAudioAt',
        'lastTranscriptAt',
        'status',
        'freshUntil',
        'meetingId',
        'startedAt',
        'meetingURL',
      ]).toContain(field);
    }
    expect(widget).not.toMatch(/transcript|speakerNames|participantNames|meetingTitle/i);
  });

  it('expires apparent recording progress and routes controls to the precise recorder', () => {
    expect(shared).toContain('lastAudioAt?.addingTimeInterval(20)');
    expect(shared).toContain('content.freshUntil ?? Date()');
    expect(widget).toContain('attributes.startedAt...freshUntil');
    expect(widget).toContain('context.isStale');
    expect(widget).toContain('Open Verity to check recording');
    for (const action of ['Pause', 'Resume', 'End']) {
      expect(widget).toContain(
        `${action}MeetingRecordingIntent(meetingId: context.attributes.meetingId)`,
      );
    }
    expect(shared).toContain('guard currentMeetingId == meetingId, let onAction else');
    expect(shared).toContain('try await onAction(meetingId, action)');
    expect(shared).toContain('if action == "resume"');
    expect(shared).toContain('throw MeetingActivityError.missingActivity');
    expect(shared).toContain('var meetingId: String');
    expect(shared).toContain(
      'url.queryItems = [URLQueryItem(name: "meetingId", value: meetingId)]',
    );
    expect(widget).toContain('.widgetURL(context.attributes.meetingURL)');
  });
});
