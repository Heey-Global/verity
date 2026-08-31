internal import ExpoModulesCore
import UIKit

// The space iPadOS 26's window controls (close / minimize / resize) take out of
// the window's top-left corner. They are drawn over app content and contribute
// nothing to `safeAreaInsets`, so the only way to keep the header's buttons out
// from under them is iOS 26's corner-adapted layout margins — and those can only
// be asked of a live view's window. Hence a view rather than a module: it needs a
// window to ask, and being laid out is how it learns to ask again. What it
// reports is the window's, though, not its own frame's.
//
// Absent on Android, on older binaries, and below iOS 26 — components/
// WindowControls.tsx renders nothing then, and the header keeps its plain
// padding. See lib/windowControls.ts for how the numbers become a padding.
class VerityWindowControls: Module {
  public func definition() -> ModuleDefinition {
    View(VerityWindowControlsView.self) {
      Events("onMarginsChange")
    }
  }
}

class VerityWindowControlsView: ExpoView {
  let onMarginsChange = EventDispatcher()

  /// The last payload sent to JS. The margins are re-read on every layout pass,
  /// which is far more often than they change; forwarding only differences keeps
  /// a resize from restyling the header on every frame — and keeps the restyle
  /// this view triggers from laying it out again in a loop.
  private var reported: [String: Double]?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
  }

  // UIKit posts no notification for the controls appearing, moving or vanishing,
  // so the margins are re-read from every hook a window change plausibly reaches.
  // Resizing or dragging the window is the one that certainly does, since this
  // view is sized to the header. The margin and safe-area hooks are a cheap bet on
  // a window whose corners change while its size does not — they fire for this
  // view, so they may not catch it; nothing public promises anything that would.
  override func layoutSubviews() {
    super.layoutSubviews()
    reportMargins()
  }

  override func layoutMarginsDidChange() {
    super.layoutMarginsDidChange()
    reportMargins()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    reportMargins()
  }

  // A different window can have entirely different corners, and JS starts every
  // mount at zero — so forget what the last one reported, or a view that returns
  // to identical margins would dedupe away the only report it ever makes.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    reported = nil
    reportMargins()
  }

  private func reportMargins() {
    guard #available(iOS 26.0, *) else { return }
    guard let window else { return }

    // `.horizontal` asks the margins to grow sideways where a corner intrudes,
    // which is the direction the controls sit in. `layoutMargins` is the same
    // measurement with nothing intruding, so JS can subtract it and be left with
    // the controls' own claim.
    let adapted = window.edgeInsets(for: .margins(cornerAdaptation: .horizontal))
    let base = window.layoutMargins
    let margins: [String: Double] = [
      "left": Double(adapted.left),
      "right": Double(adapted.right),
      "baseLeft": Double(base.left),
      "baseRight": Double(base.right),
    ]
    guard margins != reported else { return }
    reported = margins

    // Out of the layout pass: the event restyles the header, and React must not
    // be asked to do that in the middle of UIKit laying the header out.
    DispatchQueue.main.async { [weak self] in
      self?.onMarginsChange(margins)
    }
  }
}
