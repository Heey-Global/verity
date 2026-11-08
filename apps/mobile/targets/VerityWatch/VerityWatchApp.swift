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
    }
    .onChange(of: scenePhase) { _, phase in
      // Raising the wrist shows Verity's current state, not the last one delivered.
      if phase == .active { CaptureStore.shared.refreshVerity() }
    }
  }
}

struct CaptureView: View {
  @EnvironmentObject private var store: CaptureStore

  var body: some View {
    if store.recording {
      RecordingView()
    } else if let confirmation = store.confirmation {
      SavedView(confirmation: confirmation)
    } else {
      HomeView()
    }
  }
}

/// Verity on the wrist: where she is, her latest reply, her open question with
/// its answers, and what was said here. The V in the title bar starts talking.
private struct HomeView: View {
  @EnvironmentObject private var store: CaptureStore
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      List {
        if let error = store.error {
          Text(error).font(.footnote).foregroundStyle(.secondary)
        }
        StatusRow()
        if let question = store.openQuestion {
          QuestionSection(question: question)
        }
        if let approvals = store.verity?.approvals, approvals > 0 {
          Label(
            approvals == 1 ? "An approval waits on iPhone" : "\(approvals) approvals wait on iPhone",
            systemImage: "iphone"
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
        if let reply = store.verity?.reply, !reply.isEmpty {
          NavigationLink { ReplyDetail(text: reply) } label: {
            Text(reply).font(.footnote).lineLimit(5)
              .onAppear { if scenePhase == .active { store.recordDisplayedReply() } }
              .onChange(of: store.verity?.replyId) { _, _ in
                if scenePhase == .active { store.recordDisplayedReply() }
              }
              .onChange(of: scenePhase) { _, phase in
                if phase == .active { store.recordDisplayedReply() }
              }
          }
        }
        if store.captures.isEmpty && store.verity?.reply == nil {
          Text("Tap the V and tell Verity what you need: a task, a question, an appointment.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(store.captures) { capture in
          NavigationLink { CaptureDetail(id: capture.id) } label: { CaptureRow(capture: capture) }
            .listRowBackground(rowBackground(inFlight: capture.inFlight))
        }
      }
      .navigationTitle { Text("Verity").foregroundStyle(accent) }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(action: store.start) {
            VerityMarkShape().fill(.white)
              .aspectRatio(VerityMarkShape.aspectRatio, contentMode: .fit)
              .frame(width: 16)
              .frame(width: 34, height: 34)
              .background(highlight, in: Circle())
              .overlay(Circle().stroke(accent.opacity(0.55)))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Talk to Verity")
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

/// One line on where Verity stands. Words still on the watch ("Waiting for
/// iPhone") are kept apart from work Verity already has ("Working").
private struct StatusRow: View {
  @EnvironmentObject private var store: CaptureStore

  var body: some View {
    HStack(spacing: 6) {
      if store.waitingForPhone {
        Image(systemName: "iphone.slash")
        Text("Waiting for iPhone")
      } else if let verity = store.verity {
        switch (verity.availability, verity.state) {
        case ("disabled", _): Text("Verity is switched off")
        case ("denied", _): Text("Verity is for administrators")
        case ("unavailable", _): Text("Verity is not available")
        case (_, "working"):
          ProgressView().controlSize(.mini).tint(sky)
          Text("Verity is working")
        case (_, "needs_you"): Text("Verity needs you").foregroundStyle(accent)
        case (_, "failed"): Text("Stopped with an error").foregroundStyle(recordRed)
        default: Text("Ready")
        }
      } else {
        Text("Open Verity on iPhone once")
      }
    }
    .font(.footnote).foregroundStyle(.secondary)
  }
}

/// Verity's question with one button per answer. Several answers at once, or
/// anything in her own words, is a new recording or the iPhone.
private struct QuestionSection: View {
  @EnvironmentObject private var store: CaptureStore
  let question: VeritySnapshot.Question

  var body: some View {
    Section {
      if question.multiSelect {
        Text("Choose on iPhone, or tap the V and say it.")
          .font(.caption2).foregroundStyle(.secondary)
      } else {
        ForEach(question.options, id: \.self) { option in
          Button(option) { store.answer(question, with: [option]) }
            .font(.footnote)
        }
      }
    } header: {
      Text(question.text ?? "Verity asks").textCase(nil)
    }
  }
}

/// A reply too long for the list, scrollable; the whole conversation is on iPhone.
private struct ReplyDetail: View {
  let text: String

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(text).font(.body)
        Text("The whole conversation is in Verity on iPhone.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
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
          [whenLabel(capture.createdAt), capture.durationLabel]
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

/// Brief confirmation after a recording or an answer, then back to the list.
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
  /// Said, but the transcript has not come back yet.
  var inFlight: Bool { state == .queued || state == .delivered }

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
    switch state {
    case .queued: return "Waiting to send"
    case .delivered: return "Transcribing on iPhone"
    case .transcribed: return "Sent to Verity"
    case .failed: return "Not understood"
    }
  }
}
