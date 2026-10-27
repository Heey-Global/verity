import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const targetRoot = resolve(__dirname, '../targets');
const read = (path: string) => readFileSync(resolve(targetRoot, path), 'utf8');
const app = read('VerityWatch/VerityWatchApp.swift');
const store = read('VerityWatch/CaptureStore.swift');
const section = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`marker missing: ${start < 0 ? from : to}`);
  return source.slice(start, end);
};

describe('Watch project picker', () => {
  it('offers the two projects used last as shortcuts and no "Later"', () => {
    expect(store).toContain(
      'var shortcutProjects: [WatchProject] { Array(orderedProjects.prefix(2)) }',
    );
    expect(store).toContain(
      'var otherProjects: [WatchProject] { Array(orderedProjects.dropFirst(2)) }',
    );
    const picker = section(app, 'private struct ProjectPicker', 'private struct SavedView');
    expect(picker).toContain('store.shortcutProjects');
    expect(picker).toContain('store.otherProjects');
    expect(picker).not.toContain('Later');
    // A picker reopened from a waiting row can be left; one after a recording cannot.
    expect(picker).toContain('if store.reopened {');
    // The first shortcut is the last project used, marked as such.
    expect(picker).toContain('clock.arrow.circlepath');
    const assign = section(store, '  func assign(', '  func settleChoice()');
    expect(assign).toContain('projectList.watchPreviousProjectId = projectList.watchLastProjectId');
  });

  // Leaving the picker without a tap used to strand the capture as "Choose project".
  it('files a capture under the last project when the picker is left', () => {
    const settle = section(store, '  func settleChoice()', '  private func settleProjectless()');
    expect(settle).toContain('settle(id)');
    expect(settle).toContain('choosing = nil');
    // Reopened from a row, leaving means "Back": nothing is filed.
    expect(settle.indexOf('if reopened {')).toBeGreaterThan(-1);
    expect(settle.indexOf('if reopened {')).toBeLessThan(settle.indexOf('settle(id)'));
    expect(store).toContain('var fallbackProject: WatchProject? { orderedProjects.first }');
    expect(app).toContain('if phase == .background { CaptureStore.shared.settleChoice() }');
    expect(app).not.toContain('phase != .active');
    // A new recording from the complication settles the previous capture first.
    const start = section(store, '  func start()', '  func stop()');
    expect(start.indexOf('settleChoice()')).toBeGreaterThan(-1);
    expect(start.indexOf('settleChoice()')).toBeLessThan(start.indexOf('choosing = nil'));
  });

  // A capture spoken under account A must not land in account B's project by fallback.
  it('never files a capture under another account without a tap', () => {
    const start = section(store, '  func start()', '  func stop()');
    expect(start).toContain('current = (id, Date(), projectList.scope)');
    const stop = section(store, '  func stop()', '  private func tick()');
    expect(stop).toContain('scope: current.scope)');
    const settle = section(store, '  private func settle(', '  private func fileCapture(');
    expect(settle).toContain('capture.scope != nil && capture.scope == projectList.scope');
    const recover = section(
      store,
      '  private func recoverInterruptedRecordings()',
      '  func activate()',
    );
    // A recording cut short by watchOS waits for a tap instead of being filed blind.
    expect(recover).not.toContain('scope: projectList.scope');
  });

  it('keeps both watch picks when the iPhone sends a new list for the same account', () => {
    const receive = section(store, '  private func receive(', '  private func saveProjects()');
    expect(receive).toContain('next.watchLastProjectId = projectList.watchLastProjectId');
    expect(receive).toContain('next.watchPreviousProjectId = projectList.watchPreviousProjectId');
    // Captures of this account that waited for the list are filed once it arrives.
    expect(receive).toContain('settleProjectless()');
  });

  it('puts the record button in the title bar above tappable rows', () => {
    const home = section(app, 'private struct HomeView', 'private struct CaptureRow');
    expect(home).toContain('ToolbarItem(placement: .topBarTrailing)');
    expect(home).toContain('Button(action: store.start)');
    expect(home).toContain('NavigationLink { CaptureDetail(id: capture.id) }');
    expect(home).not.toContain('Label("Record", systemImage: "mic.fill")');
  });
});
