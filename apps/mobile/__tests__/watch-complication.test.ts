import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import plist from '@expo/plist';

const targetRoot = resolve(__dirname, '../targets');
const read = (path: string) => readFileSync(resolve(targetRoot, path), 'utf8');
const shared = read('_shared/WatchCaptureComplication.swift');
const app = read('VerityWatch/VerityWatchApp.swift');
const store = read('VerityWatch/CaptureStore.swift');
const widget = read('VerityWatchComplication/VerityWatchComplication.swift');

describe('Watch complication capture entry', () => {
  it('registers the actual complication URL and starts rather than toggles recording', () => {
    const url = new URL(shared.match(/recordingURL = URL\(string: "([^"]+)"\)/)![1]);
    const manifest = plist.parse(read('VerityWatch/Info.plist')) as {
      CFBundleURLTypes: { CFBundleURLSchemes: string[] }[];
    };
    // A rendered complication can look correct while its tap never reaches the app.
    expect(manifest.CFBundleURLTypes.flatMap((type) => type.CFBundleURLSchemes)).toContain(
      url.protocol.slice(0, -1),
    );
    expect(widget).toContain('.widgetURL(WatchCaptureComplication.recordingURL)');
    const handler = app.match(/\.onOpenURL \{ url in([\s\S]*?)\n        \}/)![1];
    expect(handler).toContain('guard WatchCaptureComplication.isRecordingURL(url) else { return }');
    expect(handler).toContain('CaptureStore.shared.start()');
    expect(handler).not.toContain('toggle');
    // Duplicate URL delivery during the permission prompt must not create two recorders.
    const start = store.slice(store.indexOf('  func start()'), store.indexOf('  func stop()'));
    expect(start.indexOf('guard !recording, !starting')).toBeLessThan(
      start.indexOf('requestRecordPermission'),
    );
    expect(start).toContain('guard !recording, !starting else { return }');
    expect(start).toContain('starting = true');
    expect(start.indexOf('choosing = nil')).toBeGreaterThan(
      start.indexOf('guard recorder.record()'),
    );
  });

  it('packages all mockup families and their artwork', () => {
    const families = widget.match(/\.supportedFamilies\(\[([^\]]+)\]/)![1];
    for (const family of [
      'accessoryCircular',
      'accessoryCorner',
      'accessoryRectangular',
      'accessoryInline',
    ]) {
      expect(families).toContain(`.${family}`);
    }
    const image = widget.match(/Image\("([^"]+)"\)/)![1];
    const config = require(resolve(targetRoot, 'VerityWatchComplication/expo-target.config.js'))({
      ios: { bundleIdentifier: 'build.verity.app' },
    });
    const source = config.images[image] as string;
    expect(source).toBeDefined();
    expect(existsSync(resolve(targetRoot, 'VerityWatchComplication', source))).toBe(true);
  });

  it.each(['build.verity.app', 'build.verity.app.staging'])(
    'shares the pending count within %s only',
    (bundleIdentifier) => {
      const input = { ios: { bundleIdentifier } };
      const watch = require(resolve(targetRoot, 'VerityWatch/expo-target.config.js'))(input);
      const complication = require(
        resolve(targetRoot, 'VerityWatchComplication/expo-target.config.js'),
      )(input);
      expect(complication.type).toBe('watch-widget');
      expect(complication.bundleIdentifier.startsWith(`${watch.bundleIdentifier}.`)).toBe(true);
      expect(complication.entitlements['com.apple.security.application-groups']).toEqual(
        watch.entitlements['com.apple.security.application-groups'],
      );
      const group = watch.entitlements['com.apple.security.application-groups'][0] as string;
      expect(group).toContain(bundleIdentifier);
      expect(shared).toContain('bundle.range(of: ".watchkitapp")');
      expect(shared).toContain(
        'UserDefaults(suiteName: "group.\\(bundle[..<range.lowerBound]).watch-capture")',
      );
      expect(store).toContain('defaults.set(pending, forKey: WatchCaptureComplication.pendingKey)');
      expect(widget).toContain('integer(forKey: WatchCaptureComplication.pendingKey)');
      expect(store).toContain(
        'WidgetCenter.shared.reloadTimelines(ofKind: WatchCaptureComplication.kind)',
      );
      expect(widget).toContain('StaticConfiguration(kind: WatchCaptureComplication.kind');
      expect(store).toContain('$0.state == .queued || $0.state == .delivered');
    },
  );
});
