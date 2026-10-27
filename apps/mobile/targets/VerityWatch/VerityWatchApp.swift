import SwiftUI

/// Recording colour shared with the iPhone quick capture (`tone.danger`, dark theme).
private let recordRed = Color(red: 1, green: 0x5c / 255, blue: 0x8a / 255)
/// Verity brand accents (`#ff35da`, `#2ab0ff`); the gradient marks the active element.
private let accent = Color(red: 1, green: 0x35 / 255, blue: 0xda / 255)
private let sky = Color(red: 0x2a / 255, green: 0xb0 / 255, blue: 1)
private let highlight = LinearGradient(
  colors: [accent.opacity(0.32), sky.opacity(0.22)], startPoint: .topLeading,
  endPoint: .bottomTrailing)

@main
struct VerityWatchApp: App {
  @Environment(\.scenePhase) private var scenePhase

  init() {
    CaptureStore.shared.activate()
  }

  var body: some Scene {
    WindowGroup {
      CaptureView().environmentObject(CaptureStore.shared)
        .onOpenURL { url in
          guard WatchCaptureComplication.isRecordingURL(url) else { return }
          CaptureStore.shared.start()
        }
        .onChange(of: scenePhase) { _, phase in
          // Leaving the picker files the capture under the last project. Only on
          // `.background`: a notification banner also makes the scene inactive.
          if phase == .background { CaptureStore.shared.settleChoice() }
        }
    }
  }
}

struct CaptureView: View {
  @EnvironmentObject private var store: CaptureStore

  var body: some View {
    if store.recording {
      RecordingView()
    } else if let id = store.choosing {
      ProjectPicker(captureId: id)
    } else if let confirmation = store.confirmation {
      SavedView(confirmation: confirmation)
    } else {
      HomeView()
    }
  }
}

/// Record button in the title bar, the recent captures below as tappable rows.
private struct HomeView: View {
  @EnvironmentObject private var store: CaptureStore

  var body: some View {
    NavigationStack {
      List {
        if let error = store.error {
          Text(error).font(.footnote).foregroundStyle(.secondary)
        }
        if store.captures.isEmpty {
          Text("Tap the microphone and speak a task. It lands in your project on iPhone.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(store.captures) { capture in
          if capture.projectId == nil {
            Button { store.reopen(capture.id) } label: { CaptureRow(capture: capture) }
          } else {
            NavigationLink { CaptureDetail(id: capture.id) } label: { CaptureRow(capture: capture) }
              .listRowBackground(rowBackground(inFlight: capture.inFlight))
          }
        }
      }
      .navigationTitle { Text("Verity").foregroundStyle(accent) }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(action: store.start) {
            Image(systemName: "mic.fill")
              .font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
              .frame(width: 34, height: 34)
              .background(recordRed, in: Circle())
              .shadow(color: recordRed.opacity(0.45), radius: 6, y: 2)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Record")
        }
      }
    }
  }

  /// The usual dark row; a capture still on its way carries a magenta stripe.
  private func rowBackground(inFlight: Bool) -> some View {
    RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.09))
      .overlay(alignment: .leading) {
        if inFlight {
          Capsule().fill(accent).frame(width: 3).padding(.vertical, 6).padding(.leading, 3)
        }
      }
  }
}

private struct CaptureRow: View {
  let capture: Capture

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(capture.title).lineLimit(1)
        .font(.footnote)
        .foregroundStyle(titleStyle)
      HStack(spacing: 4) {
        if capture.inFlight { ProgressView().controlSize(.mini).tint(sky) }
        Text(capture.subtitle).lineLimit(1)
        Spacer(minLength: 4)
        Text(relativeDay(capture.createdAt))
      }
      .font(.caption2).foregroundStyle(.secondary)
    }
  }

  private var titleStyle: AnyShapeStyle {
    if capture.state == .failed { return AnyShapeStyle(recordRed) }
    return AnyShapeStyle(capture.inFlight ? .secondary : .primary)
  }
}

/// The whole transcript with when, where and how long. Read from the store so
/// a transcript that arrives while the detail is open shows up.
private struct CaptureDetail: View {
  @EnvironmentObject private var store: CaptureStore
  let id: String

  var body: some View {
    if let capture = store.captures.first(where: { $0.id == id }) {
      detail(capture)
    }
  }

  private func detail(_ capture: Capture) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(capture.title).font(.body)
        Text(
          [whenLabel(capture.createdAt), capture.projectName, capture.durationLabel]
            .compactMap { $0 }.joined(separator: " · ")
        )
        .font(.footnote).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct RecordingView: View {
  @EnvironmentObject private var store: CaptureStore

  var body: some View {
    VStack(spacing: 8) {
      Spacer()
      Text(Duration.seconds(store.elapsed).formatted(.time(pattern: .minuteSecond)))
        .font(.system(size: 44, weight: .light).monospacedDigit())
      LevelBars(level: store.level)
      Button(action: store.stop) {
        RoundedRectangle(cornerRadius: 6).fill(recordRed).frame(width: 24, height: 24)
          .frame(width: 68, height: 68)
          .overlay(Circle().stroke(recordRed, lineWidth: 3))
          .shadow(color: recordRed.opacity(0.35), radius: 9)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop recording")
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// Shown after a recording stops: one tap files it under a project. The two
/// projects used last are shortcuts on top; leaving without a tap files the
/// capture under the last one (`CaptureStore.settleChoice`). Opened from a
/// waiting row instead, it offers "Back".
private struct ProjectPicker: View {
  @EnvironmentObject private var store: CaptureStore
  let captureId: String

  var body: some View {
    NavigationStack {
      List {
        if store.orderedProjects.isEmpty {
          Text("Open Verity on iPhone to load projects")
            .font(.footnote).foregroundStyle(.secondary)
          Button("Back") { store.closePicker() }
        } else {
          Section {
            HStack(spacing: 6) {
              ForEach(Array(store.shortcutProjects.enumerated()), id: \.element.id) { index, project in
                shortcut(project, last: index == 0)
              }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
          }
          Section {
            ForEach(store.otherProjects) { project in
              Button(project.name) { store.assign(captureId, to: project) }
                .font(.footnote)
            }
            .listRowInsets(EdgeInsets(top: 2, leading: 10, bottom: 2, trailing: 10))
          }
          if store.reopened {
            Button("Back") { store.closePicker() }.font(.footnote)
          }
        }
      }
      .environment(\.defaultMinListRowHeight, 32)
      .navigationTitle { Text("Save to").foregroundStyle(accent) }
    }
  }

  private func shortcut(_ project: WatchProject, last: Bool) -> some View {
    Button { store.assign(captureId, to: project) } label: {
      HStack(spacing: 4) {
        if last { Image(systemName: "clock.arrow.circlepath").font(.caption2) }
        Text(project.name).lineLimit(1).minimumScaleFactor(0.8)
      }
      .font(.footnote.weight(.semibold))
      .frame(maxWidth: .infinity, minHeight: 38)
      .background(
        last ? AnyShapeStyle(highlight) : AnyShapeStyle(Color(white: 0.13)),
        in: RoundedRectangle(cornerRadius: 12)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12)
          .stroke(last ? accent.opacity(0.55) : Color.white.opacity(0.12)))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(last ? "\(project.name), last used" : project.name)
  }
}

/// Brief confirmation after a pick, then back to the list.
private struct SavedView: View {
  let confirmation: CaptureStore.Confirmation

  var body: some View {
    VStack(spacing: 10) {
      ZStack {
        Circle().fill(highlight).overlay(Circle().stroke(accent.opacity(0.55)))
          .frame(width: 58, height: 58)
        Image(systemName: "checkmark").font(.system(size: 26, weight: .bold))
      }
      Text(confirmation.title).font(.headline).multilineTextAlignment(.center)
      Text(confirmation.detail).font(.footnote).foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 8)
  }
}

/// A short scrolling history of the input level, newest on the right.
private struct LevelBars: View {
  let level: Float
  @State private var history = Array(repeating: Float(0), count: 14)

  var body: some View {
    HStack(spacing: 4) {
      ForEach(history.indices, id: \.self) { index in
        Capsule().fill(recordRed)
          .frame(width: 5, height: 4 + CGFloat(history[index]) * 52)
      }
    }
    .frame(height: 56)
    .animation(.linear(duration: 0.1), value: history)
    .onChange(of: level) { _, value in
      history = Array(history.dropFirst()) + [value]
    }
  }
}

/// "08:29" today, else the day and the time.
private func whenLabel(_ date: Date) -> String {
  let time = date.formatted(date: .omitted, time: .shortened)
  return Calendar.current.isDateInToday(date) ? time : "\(relativeDay(date)) \(time)"
}

/// "08:29" today, "Yesterday", the weekday within a week, else the date.
private func relativeDay(_ date: Date) -> String {
  let calendar = Calendar.current
  if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
  if calendar.isDateInYesterday(date) { return "Yesterday" }
  if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
    return date.formatted(.dateTime.weekday(.abbreviated))
  }
  return date.formatted(.dateTime.day().month(.abbreviated))
}

extension Capture {
  /// Sent, but the transcript has not come back yet.
  var inFlight: Bool { projectId != nil && (state == .queued || state == .delivered) }

  var durationLabel: String? {
    guard durationMs > 0 else { return nil }
    return Duration.milliseconds(durationMs).formatted(.time(pattern: .minuteSecond))
  }

  var title: String {
    switch state {
    case .transcribed: return text ?? ""
    case .failed: return text ?? "Transcription failed"
    case .queued, .delivered: return "Recording" + (durationLabel.map { " · \($0)" } ?? "")
    }
  }

  var subtitle: String {
    let name = projectName ?? ""
    switch state {
    case .queued where projectId == nil: return "Choose project"
    case .queued: return "Sending · \(name)"
    case .delivered: return "Transcribing · \(name)"
    case .transcribed, .failed: return name
    }
  }
}
