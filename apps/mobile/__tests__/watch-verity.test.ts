import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const targetRoot = resolve(__dirname, '../targets');
const read = (path: string) => readFileSync(resolve(targetRoot, path), 'utf8');
const app = read('VerityWatch/VerityWatchApp.swift');
const store = read('VerityWatch/CaptureStore.swift');
const inbox = readFileSync(resolve(__dirname, '../native/VerityWatchInbox.swift'), 'utf8');
const section = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`marker missing: ${start < 0 ? from : to}`);
  return source.slice(start, end);
};

describe('Watch conversation with Verity', () => {
  // Every recording goes to Verity; there is no project to pick first.
  it('sends recordings to Verity without a project picker', () => {
    expect(app).not.toContain('ProjectPicker');
    expect(store).not.toContain('settleChoice');
    const send = section(store, '  private func send(', '  private func resend()');
    expect(send).toContain('"target": "verity"');
  });

  // Words spoken under account A must never reach account B's Verity.
  it('keeps every recording, answer and reply with the account it belongs to', () => {
    const start = section(store, '  func start()', '  func stop()');
    expect(start).toContain('current = (id, Date(), projectList.scope)');
    const stop = section(store, '  func stop()', '  private func tick()');
    expect(stop).toContain('scope: current.scope)');
    const answer = section(store, '  func answer(', '  func refreshVerity()');
    expect(answer).toContain('payload["scope"] = scope');
    const receive = section(
      store,
      '  private func receive(_ snapshot',
      '  private func receive(_ list',
    );
    expect(receive).toContain('scope != current { return }');
    expect(inbox).toContain('link.accepts(scope: entry.scope)');
  });

  // An answer must arrive at once while the iPhone is near and still arrive when it is not.
  it('answers Verity both immediately and through the queued transfer', () => {
    const answer = section(store, '  func answer(', '  func refreshVerity()');
    expect(answer).toContain('WCSession.default.transferUserInfo(payload)');
    expect(answer).toContain('WCSession.default.sendMessage(payload');
    // The iPhone takes the second copy of the same answer as one.
    expect(inbox).toContain(
      'guard !FileManager.default.fileExists(atPath: self.answerURL(id).path)',
    );
    const question = section(app, 'private struct QuestionSection', 'private struct ReplyDetail');
    expect(question).toContain('store.answer(question, with: [option])');
  });

  it('asks the iPhone for the current state when the watch app comes to the front', () => {
    expect(app).toContain('if phase == .active { CaptureStore.shared.refreshVerity() }');
    expect(store).toContain('"kind": "refresh"');
  });

  it('puts the record button in the title bar above tappable rows', () => {
    const home = section(app, 'private struct HomeView', 'private struct StatusRow');
    expect(home).toContain('ToolbarItem(placement: .topBarTrailing)');
    expect(home).toContain('Button(action: store.start)');
    expect(home).toContain('NavigationLink { CaptureDetail(id: capture.id) }');
    expect(home).not.toContain('Label("Record", systemImage: "mic.fill")');
  });
});
