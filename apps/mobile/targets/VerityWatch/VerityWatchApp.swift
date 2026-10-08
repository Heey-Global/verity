import SwiftUI

/// Recording colour shared with the iPhone quick capture (`tone.danger`, dark theme).
private let recordRed = Color(red: 1, green: 0x5c / 255, blue: 0x8a / 255)

@main
struct VerityWatchApp: App {
  init() {
    CaptureStore.shared.activate()
  }

  var body: some Scene {
    WindowGroup {
      CaptureView().environmentObject(CaptureStore.shared)
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
    } else {
      List {
        Section {
          Button(action: store.start) {
            Label("Record", systemImage: "mic.fill")
              .font(.headline)
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .listItemTint(recordRed)
          if let confirmation = store.confirmation {
            Label(confirmation, systemImage: "checkmark.circle.fill")
              .font(.footnote)
          }
          if let error = store.error {
            Text(error).font(.footnote).foregroundStyle(.secondary)
          }
        }
        if !store.captures.isEmpty {
          Section("Recent") {
            ForEach(store.captures) { capture in
              if capture.projectId == nil {
                Button { store.choosing = capture.id } label: { CaptureRow(capture: capture) }
              } else {
                CaptureRow(capture: capture)
              }
            }
          }
        }
      }
      .navigationTitle("Verity")
    }
  }
}

private struct RecordingView: View {
  @EnvironmentObject private var store: CaptureStore

  var body: some View {
    VStack(spacing: 10) {
      Text(Duration.seconds(store.elapsed).formatted(.time(pattern: .minuteSecond)))
        .font(.system(size: 34, weight: .light).monospacedDigit())
      LevelBars(level: store.level)
      Button(action: store.stop) {
        RoundedRectangle(cornerRadius: 6).fill(recordRed).frame(width: 22, height: 22)
          .frame(width: 60, height: 60)
          .overlay(Circle().stroke(recordRed, lineWidth: 3))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop recording")
    }
  }
}

/// Shown after a recording stops: one tap files it under a project. "Later"
/// keeps the recording on the watch as "Choose project".
private struct ProjectPicker: View {
  @EnvironmentObject private var store: CaptureStore
  let captureId: String

  var body: some View {
    List {
      if store.orderedProjects.isEmpty {
        Text("Open Verity on iPhone to load projects")
          .font(.footnote).foregroundStyle(.secondary)
      } else {
        Section("Save to") {
          ForEach(store.orderedProjects) { project in
            Button(project.name) { store.assign(captureId, to: project) }
          }
        }
      }
      Button("Later", role: .cancel) { store.choosing = nil }
        .foregroundStyle(.secondary)
    }
    .navigationTitle("Project")
  }
}

/// A short scrolling history of the input level, newest on the right.
private struct LevelBars: View {
  let level: Float
  @State private var history = Array(repeating: Float(0), count: 14)

  var body: some View {
    HStack(spacing: 3) {
      ForEach(history.indices, id: \.self) { index in
        Capsule().fill(recordRed)
          .frame(width: 4, height: 4 + CGFloat(history[index]) * 36)
      }
    }
    .frame(height: 40)
    .animation(.linear(duration: 0.1), value: history)
    .onChange(of: level) { _, value in
      history = Array(history.dropFirst()) + [value]
    }
  }
}

private struct CaptureRow: View {
  let capture: Capture

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      switch capture.state {
      case .queued where capture.projectId == nil:
        Label("Choose project", systemImage: "folder").foregroundStyle(recordRed)
      case .queued:
        Label("Waiting for iPhone", systemImage: "iphone.slash").foregroundStyle(.secondary)
      case .delivered:
        Label("Transcribing on iPhone…", systemImage: "waveform").foregroundStyle(.secondary)
      case .transcribed:
        Text(capture.text ?? "").lineLimit(3)
      case .failed:
        Label(capture.text ?? "Transcription failed", systemImage: "exclamationmark.triangle")
          .foregroundStyle(recordRed)
      }
      HStack(spacing: 4) {
        Text(capture.createdAt, style: .time)
        if let name = capture.projectName { Text("· \(name)").lineLimit(1) }
      }
      .font(.footnote).foregroundStyle(.secondary)
    }
    .font(.footnote)
  }
}
