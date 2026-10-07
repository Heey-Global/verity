internal import ExpoModulesCore
import UIKit

// React Native's onKeyPress reports inserted text without keyboard modifiers.
// Intercept only unmodified hardware Return before UITextView inserts anything;
// Shift+Return remains native text editing, including selection and undo support.
class VerityComposerKeys: Module {
  public func definition() -> ModuleDefinition {
    View(VerityComposerKeysView.self) {
      Events("onSubmit")
      Prop("enabled") { (view: VerityComposerKeysView, enabled: Bool) in
        view.enabled = enabled
      }
    }
  }
}

class VerityComposerKeysView: ExpoView {
  let onSubmit = EventDispatcher()
  var enabled = false

  private func focusedInput() -> UITextView? {
    func find(in view: UIView) -> UITextView? {
      if let input = view as? UITextView, input.isFirstResponder { return input }
      for child in view.subviews {
        if let input = find(in: child) { return input }
      }
      return nil
    }
    return find(in: self)
  }

  override var keyCommands: [UIKeyCommand]? {
    guard enabled, let input = focusedInput(), input.markedTextRange == nil else { return nil }
    let command = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(submit))
    command.wantsPriorityOverSystemBehavior = true
    return [command]
  }

  @objc private func submit(_ command: UIKeyCommand) {
    guard enabled, command.modifierFlags.isEmpty,
          let input = focusedInput(), input.markedTextRange == nil else { return }
    onSubmit([:])
  }
}
