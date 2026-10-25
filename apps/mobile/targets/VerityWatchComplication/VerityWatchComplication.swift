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

/// The Verity V silhouette, traced from `assets/brand/verity-v-mark.png`.
/// Drawn as a vector so watch faces can tint it like any other complication content;
/// the bitmap asset rendered as a solid rectangle on device.
private struct VerityMarkShape: Shape {
  static let aspectRatio: CGFloat = 240.0 / 168.0

  // Outline in unit coordinates; smoothed by curving through segment midpoints.
  private static let outline: [(CGFloat, CGFloat)] = [
    (0.8365, 0), (0.8885, 0), (0.8896, 0.0045), (0.9083, 0.0074), (0.9198, 0.0134),
    (0.95, 0.0372), (0.974, 0.0729), (0.9865, 0.1057), (0.9948, 0.1384), (0.9958, 0.1577),
    (0.999, 0.1622), (0.999, 0.2545), (0.9958, 0.2574), (0.9948, 0.2753), (0.9865, 0.311),
    (0.9656, 0.3616), (0.9427, 0.3914), (0.924, 0.4048), (0.9063, 0.4107), (0.8792, 0.4107),
    (0.8677, 0.4092), (0.8438, 0.3988), (0.8083, 0.3958), (0.7937, 0.3988), (0.7719, 0.4107),
    (0.75, 0.436), (0.699, 0.6696), (0.674, 0.7619), (0.6531, 0.8259), (0.6281, 0.8854),
    (0.599, 0.9375), (0.5781, 0.9628), (0.55, 0.9866), (0.525, 0.9985), (0.4656, 0.9985),
    (0.4615, 0.994), (0.4406, 0.9866), (0.4177, 0.9688), (0.3969, 0.9464), (0.3708, 0.9092),
    (0.3344, 0.8363), (0.301, 0.7455), (0.2594, 0.6027), (0.2083, 0.4063), (0.2031, 0.3988),
    (0.1823, 0.3914), (0.1542, 0.3943), (0.1083, 0.4152), (0.0802, 0.4182), (0.0646, 0.4152),
    (0.0542, 0.4092), (0.0396, 0.3973), (0.026, 0.3795), (0.0135, 0.3527), (0.0052, 0.3214),
    (0.0042, 0.3021), (0, 0.2976), (0, 0.2217), (0.0042, 0.2173), (0.0094, 0.1726),
    (0.0177, 0.1414), (0.0417, 0.0863), (0.0729, 0.0432), (0.1021, 0.0193), (0.1271, 0.0074),
    (0.1646, 0.0045), (0.1969, 0.0134), (0.224, 0.0313), (0.2615, 0.0744), (0.2823, 0.1116),
    (0.3115, 0.1786), (0.349, 0.2902), (0.425, 0.5461), (0.4708, 0.6741), (0.4781, 0.689),
    (0.4854, 0.6964), (0.4927, 0.7009), (0.5073, 0.6964), (0.5208, 0.6815), (0.55, 0.6205),
    (0.5917, 0.494), (0.6385, 0.3318), (0.6719, 0.2277), (0.7135, 0.125), (0.7323, 0.0908),
    (0.7542, 0.0595), (0.7802, 0.0313), (0.8063, 0.0134), (0.8344, 0.0045),
  ]

  func path(in rect: CGRect) -> Path {
    let point = { (index: Int) -> CGPoint in
      let (x, y) = Self.outline[index % Self.outline.count]
      return CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
    }
    let midpoint = { (a: CGPoint, b: CGPoint) in CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
    var path = Path()
    path.move(to: midpoint(point(Self.outline.count - 1), point(0)))
    for index in Self.outline.indices {
      path.addQuadCurve(to: midpoint(point(index), point(index + 1)), control: point(index))
    }
    path.closeSubpath()
    return path
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
        VerityMarkShape().fill(LinearGradient(
          colors: [Color(red: 1, green: 0.09, blue: 0.72), Color(red: 0.66, green: 0.31, blue: 0.91), Color(red: 0.09, green: 0.78, blue: 0.96)],
          startPoint: .leading, endPoint: .trailing))
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
          Text("Quick capture").font(.caption).lineLimit(1).minimumScaleFactor(0.7)
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
    .description("Tap to start recording a task immediately.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
  }
}
