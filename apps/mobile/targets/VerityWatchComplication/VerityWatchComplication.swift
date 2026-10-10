import SwiftUI
import WidgetKit

private struct CaptureEntry: TimelineEntry {
  let date: Date
  let pending: Int
}

private struct CaptureProvider: TimelineProvider {
  func placeholder(in context: Context) -> CaptureEntry {
    CaptureEntry(date: Date(), pending: 1)
  }

  func getSnapshot(in context: Context, completion: @escaping (CaptureEntry) -> Void) {
    completion(entry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CaptureEntry>) -> Void) {
    // The Watch app requests a reload when its durable capture queue changes.
    completion(Timeline(entries: [entry()], policy: .never))
  }

  private func entry() -> CaptureEntry {
    CaptureEntry(
      date: Date(),
      pending: WatchCaptureComplication.defaults?.integer(forKey: WatchCaptureComplication.pendingKey) ?? 0)
  }
}

private struct CaptureComplicationView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var renderingMode
  let entry: CaptureEntry

  private var pendingLabel: String {
    entry.pending == 0 ? "Quick capture" : "\(entry.pending) recording\(entry.pending == 1 ? "" : "s") pending"
  }

  private var mark: some View {
    Image("VerityMark")
      .renderingMode(.template)
      .resizable()
      .scaledToFit()
      .foregroundStyle(renderingMode == .fullColor
        ? LinearGradient(colors: [Color(red: 0.16, green: 0.69, blue: 1), Color(red: 1, green: 0.21, blue: 0.85)], startPoint: .topLeading, endPoint: .bottomTrailing)
        : LinearGradient(colors: [.white, .white], startPoint: .topLeading, endPoint: .bottomTrailing))
      .widgetAccentable()
      .accessibilityHidden(true)
  }

  var body: some View {
    Group {
      switch family {
      case .accessoryInline:
        // Inline complications accept a single image plus text.
        Label("Verity", image: "VerityMark")
      case .accessoryCorner:
        mark.padding(5).widgetLabel { Text("Verity") }
      case .accessoryRectangular:
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            mark.frame(width: 24, height: 17)
            Text("Verity").font(.headline)
          }
          Text(pendingLabel).font(.caption).lineLimit(1).minimumScaleFactor(0.7)
        }
      default:
        ZStack {
          AccessoryWidgetBackground()
          mark.padding(10)
        }
      }
    }
    .containerBackground(for: .widget) { Color.clear }
    .widgetURL(WatchCaptureComplication.recordingURL)
    .accessibilityLabel("Verity. Start recording. \(pendingLabel)")
  }
}

@main
struct VerityWatchComplication: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WatchCaptureComplication.kind, provider: CaptureProvider()) { entry in
      CaptureComplicationView(entry: entry)
    }
    .configurationDisplayName("Verity")
    .description("Tap to start recording a task immediately.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
  }
}
