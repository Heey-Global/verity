import ActivityKit
import AppIntents
import Foundation

/// Linked into the app and widget targets. ActivityKit owns the transport between them;
/// the extension receives no transcript, participant names, credentials, or audio.
struct LiveMeetingAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var state: String
    var updatedAt: Date
    var lastAudioAt: Date?
    var lastTranscriptAt: Date?

    var status: String {
      switch state {
      case "preparing": return "Preparing microphone"
      case "listening": return "Recording"
      case "paused": return "Paused"
      case "interrupted": return "Recording interrupted"
      case "failed": return "Recording needs attention"
      default: return "Meeting ended"
      }
    }

    // Only recent microphone progress allows an advancing timer. A stale activity
    // cannot keep looking healthy after the recording process has disappeared.
    var freshUntil: Date? {
      state == "listening" ? lastAudioAt?.addingTimeInterval(20) : nil
    }
  }

  let meetingId: String
  let startedAt: Date
  let meetingURL: URL
}

enum MeetingActivityError: LocalizedError {
  case unavailable
  case missingActivity

  var errorDescription: String? {
    switch self {
    case .unavailable: return "Open Verity to check this meeting."
    case .missingActivity: return "Open Verity to resume recording."
    }
  }
}

/// Runs in the app process, including for LiveActivityIntent actions while locked.
/// The Swift recorder installs the handler; intents never wait for JavaScript.
@MainActor
enum LiveMeetingActivity {
  static var onAction: ((String, String) async throws -> Void)?
  static var onAvailabilityChanged: ((String, Bool) -> Void)?
  private static var generation = 0
  private static var currentMeetingId: String?
  private static var observation: Task<Void, Never>?

  @discardableResult
  static func start(meetingId: String, startedAt: Date, sessionId: String) -> Bool {
    generation += 1
    currentMeetingId = meetingId
    observation?.cancel()
    observation = nil
    let currentGeneration = generation
    let obsolete = Activity<LiveMeetingAttributes>.activities.filter {
      $0.attributes.meetingId != meetingId
    }
    Task {
      for activity in obsolete { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      onAvailabilityChanged?(meetingId, false)
      return false
    }
    if let existing = Activity<LiveMeetingAttributes>.activities.first(where: {
      $0.attributes.meetingId == meetingId && isUsable($0)
    }) {
      observe(existing, generation: currentGeneration)
      onAvailabilityChanged?(meetingId, true)
      return true
    }
    var url = URLComponents()
    url.scheme = Bundle.main.bundleIdentifier?.contains(".staging") == true ? "verity-staging" : "verity"
    url.host = "meeting"
    url.path = "/\(sessionId)"
    url.queryItems = [URLQueryItem(name: "meetingId", value: meetingId)]
    guard let meetingURL = url.url else { return false }
    let content = LiveMeetingAttributes.ContentState(
      state: "preparing", updatedAt: Date(), lastAudioAt: nil, lastTranscriptAt: nil)
    do {
      let activity = try Activity.request(
        attributes: LiveMeetingAttributes(
          meetingId: meetingId, startedAt: startedAt, meetingURL: meetingURL),
        content: ActivityContent(state: content, staleDate: nil), pushType: nil)
      observe(activity, generation: currentGeneration)
      onAvailabilityChanged?(meetingId, true)
      Task {
        // A launch after process termination cannot inherit a trusted microphone state.
        guard generation == currentGeneration, currentMeetingId == meetingId else {
          await activity.end(nil, dismissalPolicy: .immediate)
          return
        }
      }
      return true
    } catch {
      // Activity denial must not prevent an ordinary in-app microphone session.
      onAvailabilityChanged?(meetingId, false)
      return false
    }
  }

  static func update(
    meetingId: String, state: String, lastAudioAt: Date?, lastTranscriptAt: Date? = nil
  ) {
    guard currentMeetingId == meetingId else { return }
    let content = LiveMeetingAttributes.ContentState(
      state: state, updatedAt: Date(), lastAudioAt: lastAudioAt, lastTranscriptAt: lastTranscriptAt)
    let currentGeneration = generation
    Task {
      guard generation == currentGeneration, currentMeetingId == meetingId else { return }
      for activity in Activity<LiveMeetingAttributes>.activities
        where activity.attributes.meetingId == meetingId && isUsable(activity) {
        await activity.update(ActivityContent(
          state: content,
          staleDate: state == "listening" ? (content.freshUntil ?? Date()) : nil))
      }
    }
  }

  static func end(meetingId: String) {
    if currentMeetingId == meetingId {
      generation += 1
      currentMeetingId = nil
      observation?.cancel()
      observation = nil
    }
    Task {
      for activity in Activity<LiveMeetingAttributes>.activities
        where activity.attributes.meetingId == meetingId {
        var content = activity.content.state
        content.state = "stopped"
        content.updatedAt = Date()
        await activity.end(
          ActivityContent(state: content, staleDate: nil), dismissalPolicy: .immediate)
      }
    }
  }

  /// Called when the app starts without an active native recorder.
  static func discardOrphans() async {
    for activity in Activity<LiveMeetingAttributes>.activities
      where activity.attributes.meetingId != currentMeetingId {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  private static func isUsable(_ activity: Activity<LiveMeetingAttributes>) -> Bool {
    activity.activityState == .active || activity.activityState == .stale
  }

  private static func observe(_ activity: Activity<LiveMeetingAttributes>, generation expected: Int) {
    observation = Task {
      for await state in activity.activityStateUpdates {
        guard !Task.isCancelled, generation == expected,
          currentMeetingId == activity.attributes.meetingId else { return }
        if state == .ended || state == .dismissed {
          // Expiry and user dismissal remove controls, never silently end an ordinary
          // microphone session. The recorder journals this UI capability separately.
          onAvailabilityChanged?(activity.attributes.meetingId, false)
          return
        }
      }
    }
  }

  static func perform(meetingId: String, action: String) async throws {
    guard currentMeetingId == meetingId, let onAction else {
      end(meetingId: meetingId)
      throw MeetingActivityError.unavailable
    }
    // AudioRecordingIntent requires a Live Activity throughout resumed capture.
    if action == "resume", !Activity<LiveMeetingAttributes>.activities.contains(where: {
      $0.attributes.meetingId == meetingId && isUsable($0)
    }) { throw MeetingActivityError.missingActivity }
    try await onAction(meetingId, action)
  }
}

struct PauseMeetingRecordingIntent: LiveActivityIntent, AudioRecordingIntent {
  static let title: LocalizedStringResource = "Pause meeting recording"
  static let isDiscoverable = false
  @Parameter(title: "Meeting") var meetingId: String

  init() {}
  init(meetingId: String) { self.meetingId = meetingId }

  @MainActor
  func perform() async throws -> some IntentResult {
    try await LiveMeetingActivity.perform(meetingId: meetingId, action: "pause")
    return .result()
  }
}

struct ResumeMeetingRecordingIntent: LiveActivityIntent, AudioRecordingIntent {
  static let title: LocalizedStringResource = "Resume meeting recording"
  static let isDiscoverable = false
  @Parameter(title: "Meeting") var meetingId: String

  init() {}
  init(meetingId: String) { self.meetingId = meetingId }

  @MainActor
  func perform() async throws -> some IntentResult {
    try await LiveMeetingActivity.perform(meetingId: meetingId, action: "resume")
    return .result()
  }
}

struct EndMeetingRecordingIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "End meeting recording"
  static let isDiscoverable = false
  @Parameter(title: "Meeting") var meetingId: String

  init() {}
  init(meetingId: String) { self.meetingId = meetingId }

  @MainActor
  func perform() async throws -> some IntentResult {
    try await LiveMeetingActivity.perform(meetingId: meetingId, action: "end")
    return .result()
  }
}
