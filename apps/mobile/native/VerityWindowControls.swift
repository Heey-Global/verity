internal import ExpoModulesCore
import UIKit

// Measure the header's corner-adapted margins where its buttons are laid out.
// UIKit adapts margins to the receiver's position in the window: measuring the
// entire UIWindow can miss an intrusion at the header's height. The probe fills
// the header row, so it also remeasures when that row or its window resizes.
// See lib/windowControls.ts for how the raw margins become horizontal padding.
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
    guard window != nil, !bounds.isEmpty else { return }

    // Query the row-sized view, not its window. Controls only obstruct the
    // portion of content next to them, and UIKit accounts for that geometry.
    let adapted = edgeInsets(for: .margins(cornerAdaptation: .horizontal))
    let base = layoutMargins
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
