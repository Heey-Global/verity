internal import ExpoModulesCore
import UIKit

// A hardware-keyboard shortcut surface for Designed-for-iPad on Mac (and iPad with
// a keyboard): ⌘+ / ⌘= enlarge, ⌘− shrinks, ⌘0 resets the app-wide font zoom. The
// view reports the direction to JS (see components/KeyCommands.tsx); the scaling
// itself lives in lib/fontZoom.ts.
//
// Placed once as an ancestor of the whole app tree, so ⌘ shortcuts fire both while
// a text field is focused (this view sits above it in the responder chain) and when
// idle (it makes itself first responder on appear / after the keyboard dismisses).
class VerityKeyCommands: Module {
  public func definition() -> ModuleDefinition {
    View(VerityKeyCommandsView.self) {
      Events("onZoom", "onSearch")
    }
  }
}

class VerityKeyCommandsView: ExpoView {
  let onZoom = EventDispatcher()
  let onSearch = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponder),
      name: UIResponder.keyboardDidHideNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override var canBecomeFirstResponder: Bool { true }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    reclaimFirstResponder()
  }

  // Grab first responder only when no editable control is active, so we never steal
  // focus from (or dismiss the keyboard of) a text field the operator is typing in.
  // `didMoveToWindow` can fire again while a field is focused (e.g. a fullScreenModal
  // covers then uncovers the RN root), so `!isFirstResponder` alone isn't enough —
  // we also skip when the live first responder is a text input.
  @objc private func reclaimFirstResponder() {
    guard window != nil, !isFirstResponder, !currentFirstResponderIsTextInput() else { return }
    becomeFirstResponder()
  }

  private func currentFirstResponderIsTextInput() -> Bool {
    verityCapturedFirstResponder = nil
    UIApplication.shared.sendAction(
      #selector(UIResponder.verityCaptureFirstResponder),
      to: nil,
      from: nil,
      for: nil
    )
    return verityCapturedFirstResponder is UITextInput
  }

  override var keyCommands: [UIKeyCommand]? {
    let commands = [
      UIKeyCommand(input: "=", modifierFlags: .command, action: #selector(zoomIn)),
      UIKeyCommand(input: "+", modifierFlags: .command, action: #selector(zoomIn)),
      UIKeyCommand(input: "-", modifierFlags: .command, action: #selector(zoomOut)),
      UIKeyCommand(input: "0", modifierFlags: .command, action: #selector(zoomReset)),
      UIKeyCommand(input: "f", modifierFlags: .command, action: #selector(searchContext)),
      UIKeyCommand(input: "f", modifierFlags: [.command, .shift], action: #selector(searchGlobal)),
      UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(closeSearch)),
    ]
    for command in commands {
      command.wantsPriorityOverSystemBehavior = true
    }
    return commands
  }

  @objc private func zoomIn() { onZoom(["direction": "in"]) }
  @objc private func zoomOut() { onZoom(["direction": "out"]) }
  @objc private func zoomReset() { onZoom(["direction": "reset"]) }
  @objc private func searchContext() { onSearch(["action": "context"]) }
  @objc private func searchGlobal() { onSearch(["action": "global"]) }
  @objc private func closeSearch() { onSearch(["action": "close"]) }
}

// Reading the live first responder without private API: `sendAction(to: nil)` routes
// to whatever is currently first responder, which records itself here.
private var verityCapturedFirstResponder: UIResponder?

extension UIResponder {
  @objc fileprivate func verityCaptureFirstResponder() {
    verityCapturedFirstResponder = self
  }
}
