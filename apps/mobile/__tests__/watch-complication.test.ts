import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import plist from '@expo/plist';

const targetRoot = resolve(__dirname, '../targets');
const read = (path: string) => readFileSync(resolve(targetRoot, path), 'utf8');
const shared = read('_shared/WatchCaptureComplication.swift');
const app = read('VerityWatch/VerityWatchApp.swift');
const store = read('VerityWatch/CaptureStore.swift');
const widget = read('VerityWatchComplication/VerityWatchComplication.swift');
const mark = read('_shared/VerityMarkShape.swift');

describe('Watch complication Home entry', () => {
  it('registers the Home URL and never starts recording on launch', () => {
    const url = new URL(shared.match(/homeURL = URL\(string: "([^"]+)"\)/)![1]);
    const manifest = plist.parse(read('VerityWatch/Info.plist')) as {
      CFBundleURLTypes: { CFBundleURLSchemes: string[] }[];
    };
    // A rendered complication can look correct while its tap never reaches the app.
    expect(manifest.CFBundleURLTypes.flatMap((type) => type.CFBundleURLSchemes)).toContain(
      url.protocol.slice(0, -1),
    );
    expect(widget).toContain('.widgetURL(WatchCaptureComplication.homeURL)');
    const handler = app.match(/\.onOpenURL \{ url in([\s\S]*?)\n        \}/)![1];
    expect(handler).toContain('guard WatchCaptureComplication.isHomeURL(url) else { return }');
    expect(handler).toContain('CaptureStore.shared.showHome()');
    expect(handler).not.toContain('.start()');
    expect(shared).toContain('url.host == "capture"');
    const home = store.slice(
      store.indexOf('  func showHome()'),
      store.indexOf('  func discardCapture('),
    );
    expect(home).toContain('homeGeneration = UUID()');
    expect(home).toContain('confirmation = nil');
    expect(home).not.toContain('start()');
    expect(handler).not.toContain('toggle');
    // Duplicate URL delivery during the permission prompt must not create two recorders.
    const start = store.slice(store.indexOf('  func start()'), store.indexOf('  func stop()'));
    expect(start.indexOf('guard !recording, !starting')).toBeLessThan(
      start.indexOf('requestRecordPermission'),
    );
    expect(start).toContain('guard !recording, !starting else { return }');
    expect(start).toContain('starting = true');
    // Feedback from the previous recording clears only once the new one runs.
    expect(start.indexOf('confirmation = nil')).toBeGreaterThan(
      start.indexOf('guard recorder.record()'),
    );
  });

  it('packages original full-color artwork and vector monochrome families', () => {
    const families = widget.match(/\.supportedFamilies\(\[([^\]]+)\]/)![1];
    for (const family of [
      'accessoryCircular',
      'accessoryCorner',
      'accessoryRectangular',
      'accessoryInline',
    ]) {
      expect(families).toContain(`.${family}`);
    }
    // Template rendering of the full-color PNG used to produce an opaque rectangle.
    const assetName = 'VerityMarkOriginal';
    const config = require(resolve(targetRoot, 'VerityWatchComplication/expo-target.config.js'));
    const asset = resolve(targetRoot, 'VerityWatchComplication', config.images[assetName]);
    expect(readFileSync(asset)).toEqual(
      readFileSync(resolve(__dirname, '../assets/brand/verity-v-mark.png')),
    );
    expect(widget).toContain('if renderingMode == .fullColor');
    expect(widget).toContain('VerityMarkShape().fill(Color.white)');
    expect(widget).not.toContain('AccessoryWidgetBackground()');
    // The Watch app draws the same mark, so it lives with the sources both targets link.
    expect(mark).toContain('#if os(watchOS)');
    expect(mark).toContain('struct VerityMarkShape: Shape');
    expect(mark).not.toContain('private struct VerityMarkShape');
    expect(widget).not.toContain('struct VerityMarkShape');
    expect(app).toContain('VerityOriginalMark()');
    expect(widget).toContain('VerityOriginalMark()');
    expect(mark).toContain('Image("VerityLauncherArtwork")');
    expect(mark).toContain('.mask(Image("VerityMarkOriginal").resizable())');
    expect(mark).toContain('.renderingMode(.original)');
    const watchConfig = require(resolve(targetRoot, 'VerityWatch/expo-target.config.js'));
    expect(watchConfig.images[assetName]).toBe(config.images[assetName]);
    expect(watchConfig.images.VerityLauncherArtwork).toBe(watchConfig.icon);
    expect(config.images.VerityLauncherArtwork).toBe(watchConfig.icon);
    expect(widget).toContain('.containerBackgroundRemovable(true)');
    expect(widget).not.toContain('.widgetAccentable()');
    const marker = 'outline: [(CGFloat, CGFloat)] = [';
    const outline = mark.slice(mark.indexOf(marker) + marker.length);
    const points = [
      ...outline.slice(0, outline.indexOf(']')).matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g),
    ];
    expect(points.length).toBeGreaterThan(40);
    for (const coordinate of points.flatMap(([, x, y]) => [Number(x), Number(y)])) {
      expect(coordinate).toBeGreaterThanOrEqual(0);
      expect(coordinate).toBeLessThanOrEqual(1);
    }
    expect(widget.match(/VerityMarkShape\(\)/g)!.length).toBeGreaterThanOrEqual(2);
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
    expect(widget).toContain('Text("Open Verity")');
  });
});
