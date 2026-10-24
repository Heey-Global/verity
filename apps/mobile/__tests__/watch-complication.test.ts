import { readFileSync } from 'node:fs';
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

  it('packages all mockup families with the vector Verity mark', () => {
    const families = widget.match(/\.supportedFamilies\(\[([^\]]+)\]/)![1];
    for (const family of [
      'accessoryCircular',
      'accessoryCorner',
      'accessoryRectangular',
      'accessoryInline',
    ]) {
      expect(families).toContain(`.${family}`);
    }
    // The bitmap asset rendered as a solid rectangle on device; every family draws the vector V.
    expect(widget).not.toMatch(/Image\("[^"]+"\)|image: "/);
    const config = require(resolve(targetRoot, 'VerityWatchComplication/expo-target.config.js'));
    expect(config.images).toBeUndefined();
    const marker = 'outline: [(CGFloat, CGFloat)] = [';
    const outline = widget.slice(widget.indexOf(marker) + marker.length);
    const points = [
      ...outline.slice(0, outline.indexOf(']')).matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g),
    ];
    expect(points.length).toBeGreaterThan(40);
    for (const coordinate of points.flatMap(([, x, y]) => [Number(x), Number(y)])) {
      expect(coordinate).toBeGreaterThanOrEqual(0);
      expect(coordinate).toBeLessThanOrEqual(1);
    }
    expect(widget.match(/VerityMarkShape\(\)/g)!.length).toBeGreaterThanOrEqual(3);
    expect(widget).toContain('icon: { inlineMark }');
  });

  it('adds only the complication target without changing Watch signing entitlements', () => {
    const watch = require(resolve(targetRoot, 'VerityWatch/expo-target.config.js'));
    const complication = require(
      resolve(targetRoot, 'VerityWatchComplication/expo-target.config.js'),
    );
    expect(complication.type).toBe('watch-widget');
    expect(complication.bundleIdentifier.startsWith(`${watch.bundleIdentifier}.`)).toBe(true);
    expect(complication.entitlements?.['com.apple.security.application-groups']).toBeUndefined();
    expect(watch.entitlements?.['com.apple.security.application-groups']).toBeUndefined();
    expect(shared).not.toContain('UserDefaults');
    expect(widget).toContain('Text("Quick capture")');
  });
});
