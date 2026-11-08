import SwiftUI
import WidgetKit

private struct CaptureEntry: TimelineEntry {
  let date: Date
}

private struct CaptureProvider: TimelineProvider {
  func placeholder(in context: Context) -> CaptureEntry {
    CaptureEntry(date: Date())
  }

  func getSnapshot(in context: Context, completion: @escaping (CaptureEntry) -> Void) {
    completion(entry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CaptureEntry>) -> Void) {
    // The launch shortcut has no changing content.
    completion(Timeline(entries: [entry()], policy: .never))
  }

  private func entry() -> CaptureEntry {
    CaptureEntry(date: Date())
  }
}

private struct CaptureComplicationView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var renderingMode
  @Environment(\.displayScale) private var displayScale
  let entry: CaptureEntry

  private var mark: some View {
    Group {
      if renderingMode == .fullColor {
        // Preserve the original artwork's shading instead of recreating a gradient.
        Image("VerityMarkOriginal")
          .renderingMode(.original)
          .resizable()
          .scaledToFit()
      } else {
        VerityMarkShape().fill(Color.white)
      }
    }
    .aspectRatio(VerityMarkShape.aspectRatio, contentMode: .fit)
    .widgetAccentable()
    .accessibilityHidden(true)
  }

  /// Inline complications accept only an image beside the text, so rasterize the vector mark.
  @MainActor private var inlineMark: Image {
    let renderer = ImageRenderer(content: VerityMarkShape().fill(Color.white).frame(width: 17, height: 12))
    renderer.scale = displayScale
    guard let image = renderer.uiImage else { return Image(systemName: "mic.fill") }
    return Image(uiImage: image).renderingMode(.template)
  }

  var body: some View {
    Group {
      switch family {
      case .accessoryInline:
        // Inline complications accept a single image plus text.
        Label { Text("Verity") } icon: { inlineMark }
      case .accessoryCorner:
        mark.padding(5).widgetLabel { Text("Verity") }
      case .accessoryRectangular:
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            mark.frame(width: 24, height: 17)
            Text("Verity").font(.headline)
          }
          Text("Talk to Verity").font(.caption).lineLimit(1).minimumScaleFactor(0.7)
        }
      default:
        mark.padding(10)
      }
    }
    .containerBackground(for: .widget) { Color.clear }
    .widgetURL(WatchCaptureComplication.recordingURL)
    .accessibilityLabel("Verity. Start recording.")
  }
}

@main
struct VerityWatchComplication: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WatchCaptureComplication.kind, provider: CaptureProvider()) { entry in
      CaptureComplicationView(entry: entry)
    }
    .configurationDisplayName("Verity")
    .description("Tap to talk to Verity.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
  }
}
