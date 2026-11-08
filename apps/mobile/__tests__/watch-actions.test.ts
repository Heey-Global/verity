import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('native Watch Home action contract', () => {
  it('validates the phone-owned current action and exact account before routing', () => {
    const phone = source('native/VerityWatchInbox.swift');
    const action = phone.slice(
      phone.indexOf('  private func receiveInboxAction('),
      phone.indexOf(
        '  func session(_ session: WCSession, didReceiveMessage message: [String: Any])',
      ),
    );
    expect(action).toContain('scope == inbox?["scope"] as? String');
    expect(action).toContain('items.first(where: { $0["key"] as? String == key })');
    expect(action).toContain('actions.first(where: { $0["kind"] as? String == kind })');
    expect(action).toContain('UUID(uuidString: id) != nil');
    expect(action).toContain('!inboxActions.contains(actionKey)');
    expect(action).toContain('Date().timeIntervalSince1970 * 1000 - at < 10 * 60_000');
    expect(action).toContain('queue.asyncAfter(deadline: .now() + 10)');
    expect(action).toContain('jsInboxCallbacks.removeValue(forKey: id)?');
    expect(action).not.toContain('transferUserInfo');
  });

  it('retains a stable request id for retry and requires an explicit Merge confirmation', () => {
    const store = source('targets/VerityWatch/CaptureStore.swift');
    const ui = source('targets/VerityWatch/VerityWatchApp.swift');
    expect(store).toContain('inboxActionIds[item.id] ?? UUID().uuidString');
    expect(store).toContain('!pendingInboxActions.contains(item.id)');
    const detail = ui.slice(
      ui.indexOf('private struct InboxItemDetail:'),
      ui.indexOf('private struct ReplyDetail:'),
    );
    expect(detail).toContain('if action.kind == "merge" { confirmingMerge = true }');
    expect(detail).toContain('.confirmationDialog(');
    expect(detail).toContain('Button("Merge")');
  });

  it('checks fresh session state before native resume and uses existing server routes', () => {
    const link = source('native/VerityAssistantLink.swift');
    const action = link.slice(
      link.indexOf('  func sendInboxAction('),
      link.indexOf('  /// The conversation;'),
    );
    expect(action).toContain('config?.scope == scope');
    expect(action).toContain('session["status"] as? String == "crashed"');
    expect(action).toContain('session["resumable"] as? Bool != false');
    expect(action).toContain('"clientReplyId": requestId');
    expect(action).toContain('/pull-request/merge');
  });
});
