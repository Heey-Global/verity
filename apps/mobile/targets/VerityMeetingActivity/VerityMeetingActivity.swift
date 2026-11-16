import ActivityKit
import SwiftUI
import WidgetKit

private struct MeetingDuration: View {
  let attributes: LiveMeetingAttributes
  let state: LiveMeetingAttributes.ContentState
  let stale: Bool

  var body: some View {
    Group {
      if !stale, let freshUntil = state.freshUntil, freshUntil > attributes.startedAt {
        Text(timerInterval: attributes.startedAt...freshUntil, countsDown: false)
      } else {
        let confirmedAt = state.lastAudioAt ?? attributes.startedAt
        Text(Duration.seconds(max(0, Int(confirmedAt.timeIntervalSince(attributes.startedAt)))),
          format: .time(pattern: .hourMinuteSecond))
      }
    }
    .monospacedDigit()
    .contentTransition(.identity)
    .accessibilityLabel("Meeting duration")
  }
}

private struct MeetingIndicator: View {
  let state: LiveMeetingAttributes.ContentState
  let stale: Bool

  var body: some View {
    Image(systemName: stale ? "exclamationmark.circle" : symbol)
      .foregroundStyle(stale || state.state == "interrupted" || state.state == "failed" ? Color.orange : Color.primary)
      .accessibilityLabel(stale ? "Recording status unavailable" : state.status)
  }

  private var symbol: String {
    switch state.state {
    case "preparing": return "hourglass"
    case "listening": return "record.circle"
    case "paused": return "pause.circle"
    case "interrupted", "failed": return "exclamationmark.circle"
    default: return "checkmark.circle"
    }
  }
}

private struct MeetingControls: View {
  let context: ActivityViewContext<LiveMeetingAttributes>

  var body: some View {
    HStack(spacing: 16) {
      if !context.isStale {
        if context.state.state == "listening" {
          Button(intent: PauseMeetingRecordingIntent(meetingId: context.attributes.meetingId)) {
            Label("Pause", systemImage: "pause.fill")
          }
        } else if context.state.state == "paused" {
          Button(intent: ResumeMeetingRecordingIntent(meetingId: context.attributes.meetingId)) {
            Label("Resume", systemImage: "play.fill")
          }
        }
        if context.state.state != "stopped" {
          Button(intent: EndMeetingRecordingIntent(meetingId: context.attributes.meetingId)) {
            Label("End", systemImage: "stop.fill")
          }
        }
      }
      // Text input belongs in the authenticated meeting, never on the Lock Screen.
      Link(destination: context.attributes.meetingURL) {
        Label("Note", systemImage: "square.and.pencil")
      }
    }
    .buttonStyle(.bordered)
    .font(.caption)
    .tint(.primary)
  }
}

@main
struct VerityMeetingActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveMeetingAttributes.self) { context in
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 8) {
          MeetingIndicator(state: context.state, stale: context.isStale)
          Text("Verity Meeting").font(.headline)
          Spacer()
          MeetingDuration(attributes: context.attributes, state: context.state, stale: context.isStale)
        }
        Text(context.isStale ? "Open Verity to check recording" : context.state.status)
          .font(.subheadline)
        MeetingControls(context: context)
      }
      .padding()
      .activityBackgroundTint(.black)
      .activitySystemActionForegroundColor(.white)
      .widgetURL(context.attributes.meetingURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          MeetingIndicator(state: context.state, stale: context.isStale)
        }
        DynamicIslandExpandedRegion(.trailing) {
          MeetingDuration(attributes: context.attributes, state: context.state, stale: context.isStale)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.isStale ? "Check recording" : context.state.status)
            .font(.caption)
        }
        DynamicIslandExpandedRegion(.bottom) {
          MeetingControls(context: context)
        }
      } compactLeading: {
        MeetingIndicator(state: context.state, stale: context.isStale)
      } compactTrailing: {
        MeetingDuration(attributes: context.attributes, state: context.state, stale: context.isStale)
          .font(.caption2)
          .frame(maxWidth: 64)
      } minimal: {
        MeetingIndicator(state: context.state, stale: context.isStale)
      }
      .widgetURL(context.attributes.meetingURL)
    }
  }
}
